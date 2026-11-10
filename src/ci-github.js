import { spawnSync } from 'node:child_process';
import { git } from './git.js';

// Branch protection from versioned config: which CI checks must pass before merging,
// whether changes must arrive through pull requests, and whether admins are held to it.
// GitHub is one adapter; the same `ci` settings are printed for any other host.
//
// Applying never loosens a branch: existing protections POCP doesn't manage are kept as
// they are, existing required checks stay required, and settings POCP does manage are only
// ever turned on.

function ghBin() {
  return process.env.POCP_GH || 'gh';
}

function gh(args, { input } = {}) {
  const r = spawnSync(ghBin(), args, { encoding: 'utf8', input });
  if (r.error) return { ok: false, error: `could not run ${ghBin()}: ${r.error.message}`, stdout: '', stderr: '' };
  return { ok: r.status === 0, stdout: r.stdout || '', stderr: (r.stderr || '').trim(), status: r.status };
}

function ghMessage(r) {
  try {
    return JSON.parse(r.stdout).message || r.stderr || r.error;
  } catch {
    return r.stderr || r.error || 'unknown error';
  }
}

export function defaultBranch(root) {
  const ref = git(root, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], { allowFail: true });
  if (ref) return ref.replace(/^origin\//, '');
  return git(root, ['symbolic-ref', '--quiet', '--short', 'HEAD'], { allowFail: true }) || 'main';
}

/** What the repo's `ci` config asks for. */
export function requiredChecksPlan(root, config) {
  const ci = config.ci || {};
  return {
    branch: ci.branch || defaultBranch(root),
    required_checks: [...new Set(ci.required_checks || [])],
    require_pull_request: ci.require_pull_request !== false,
    enforce_admins: ci.enforce_admins !== false,
    // Branches must be up to date with the base before merging (GitHub's "strict"): otherwise
    // what merges is the pull request combined with base commits nobody verified with it. On
    // unless a repository turns it off explicitly (doctor and --check then report the gap).
    require_up_to_date: ci.require_up_to_date !== false,
  };
}

const logins = (list = []) => list.map((u) => u.login).filter(Boolean);
const slugs = (list = []) => list.map((t) => t.slug).filter(Boolean);
const actors = (o) => (o ? { users: logins(o.users), teams: slugs(o.teams), apps: slugs(o.apps) } : undefined);
const enabled = (o) => Boolean(o && o.enabled);

/**
 * The PUT payload: GitHub's existing protection (as returned by GET, or null) merged with
 * the plan. Returns { payload, added_checks, kept_checks }.
 */
export function protectionPayload(existing, plan, { remove = [] } = {}) {
  const ex = existing || {};
  // `remove` is only ever the verify job, replaced by the pocp status when going live (goLive).
  const exChecks = (ex.required_status_checks?.checks?.length
    ? ex.required_status_checks.checks.map((c) => ({ context: c.context, ...(c.app_id != null ? { app_id: c.app_id } : {}) }))
    : (ex.required_status_checks?.contexts || []).map((context) => ({ context }))).filter((c) => !remove.includes(c.context));
  const have = new Set(exChecks.map((c) => c.context));
  const added = plan.required_checks.filter((c) => !have.has(c));
  const checks = [...exChecks, ...added.map((context) => ({ context }))];

  let reviews = null;
  const exReviews = ex.required_pull_request_reviews;
  if (exReviews) {
    reviews = {
      dismiss_stale_reviews: Boolean(exReviews.dismiss_stale_reviews),
      require_code_owner_reviews: Boolean(exReviews.require_code_owner_reviews),
      required_approving_review_count: exReviews.required_approving_review_count ?? 0,
      require_last_push_approval: Boolean(exReviews.require_last_push_approval),
    };
    const dismissal = actors(exReviews.dismissal_restrictions);
    if (dismissal) reviews.dismissal_restrictions = dismissal;
    const bypass = actors(exReviews.bypass_pull_request_allowances);
    if (bypass) reviews.bypass_pull_request_allowances = bypass;
  } else if (plan.require_pull_request) {
    reviews = { required_approving_review_count: 0 };
  }

  const payload = {
    // GitHub's schema requires `strict` and `contexts` (deprecated, but still required);
    // `checks` adds the app ids. Both name the same checks.
    required_status_checks: { strict: Boolean(ex.required_status_checks?.strict) || Boolean(plan.require_up_to_date), contexts: checks.map((c) => c.context), checks },
    enforce_admins: enabled(ex.enforce_admins) || plan.enforce_admins,
    required_pull_request_reviews: reviews,
    restrictions: ex.restrictions ? actors(ex.restrictions) : null,
    required_linear_history: enabled(ex.required_linear_history),
    allow_force_pushes: enabled(ex.allow_force_pushes),
    allow_deletions: enabled(ex.allow_deletions),
    block_creations: enabled(ex.block_creations),
    required_conversation_resolution: enabled(ex.required_conversation_resolution),
    lock_branch: enabled(ex.lock_branch),
    allow_fork_syncing: enabled(ex.allow_fork_syncing),
  };
  return { payload, added_checks: added, kept_checks: [...have].filter((c) => !plan.required_checks.includes(c)), removed_checks: remove.filter((c) => (ex.required_status_checks?.contexts || []).includes(c) || (ex.required_status_checks?.checks || []).some((x) => x.context === c)) };
}

/**
 * The branch's current protection: { repo, endpoint, existing } (existing is null when the
 * branch isn't protected), or { error }.
 */
function readGithubProtection(plan) {
  const repo = gh(['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner']);
  if (!repo.ok) return { error: repo.error || `gh repo view failed: ${repo.stderr}` };
  const nameWithOwner = repo.stdout.trim();
  const endpoint = `repos/${nameWithOwner}/branches/${plan.branch}/protection`;
  const current = gh(['api', endpoint]);
  if (current.ok) {
    try {
      return { repo: nameWithOwner, endpoint, existing: JSON.parse(current.stdout) };
    } catch {
      return { repo: nameWithOwner, error: 'could not read the current branch protection' };
    }
  }
  const message = ghMessage(current);
  if (!/not protected/i.test(message) && !/HTTP 404/.test(current.stderr)) return { repo: nameWithOwner, error: message };
  return { repo: nameWithOwner, endpoint, existing: null };
}

/**
 * What the plan asks for that the branch doesn't enforce. Each entry is a sentence.
 * A pull request can drop POCP from its own workflow, so a check that isn't required
 * simply never reports and the merge goes through: this is how to know it can't.
 */
export function protectionGaps(existing, plan) {
  if (!existing) return ['the branch is not protected', ...plan.required_checks.map((c) => `check "${c}" is not required`)];
  const ex = existing.required_status_checks;
  const have = new Set([...(ex?.contexts || []), ...((ex?.checks || []).map((c) => c.context))]);
  const gaps = plan.required_checks.filter((c) => !have.has(c)).map((c) => `check "${c}" is not required`);
  if (plan.require_pull_request && !existing.required_pull_request_reviews) gaps.push('changes can be pushed without a pull request');
  if (plan.enforce_admins && !existing.enforce_admins?.enabled) gaps.push('admins can merge past the required checks');
  if (plan.require_up_to_date && !ex?.strict) gaps.push('pull requests can merge without being up to date with the base, so the merged code is not the code that was verified');
  return gaps;
}

/** Read-only: does GitHub enforce the plan on the branch? Never changes anything. */
export function checkGithubProtection(root, plan) {
  if (!plan.required_checks.length) {
    return { ok: false, gaps: ['no required checks are configured (ci.required_checks is empty), so nothing has to pass before a merge'], branch: plan.branch };
  }
  const read = readGithubProtection(plan);
  if (read.error) return { ok: false, error: read.error, repo: read.repo, branch: plan.branch };
  const gaps = protectionGaps(read.existing, plan);
  return { ok: gaps.length === 0, repo: read.repo, branch: plan.branch, protected: Boolean(read.existing), gaps };
}

/** Apply the plan to GitHub through the gh CLI, preserving existing protection. */
export function applyGithubProtection(root, plan, { remove = [] } = {}) {
  if (!plan.required_checks.length) {
    return { ok: false, refused: true, error: 'no required checks configured (ci.required_checks is empty); refusing to set protection that requires nothing' };
  }
  const read = readGithubProtection(plan);
  if (read.error) return { ok: false, ...(read.repo ? { repo: read.repo } : {}), error: read.error };
  const { repo: nameWithOwner, endpoint, existing } = read;
  const { payload, added_checks, kept_checks, removed_checks } = protectionPayload(existing, plan, { remove });
  // GitHub has changed which forms of required_status_checks it accepts: once `contexts` was
  // required (with `checks` alongside); now the two are mutually exclusive. Send `checks` (it
  // keeps app ids), and if GitHub rejects it, `contexts` alone, then both, as older APIs wanted.
  const { contexts, checks, strict } = payload.required_status_checks;
  const forms = [{ strict, checks }, { strict, contexts }, { strict, contexts, checks }];
  let r;
  let sent;
  for (const form of forms) {
    sent = { ...payload, required_status_checks: form };
    r = gh(['api', '-X', 'PUT', endpoint, '--input', '-'], { input: JSON.stringify(sent) });
    if (r.ok || !/subschema|contexts|checks|Invalid request/i.test(ghMessage(r))) break;
  }
  if (!r.ok) return { ok: false, repo: nameWithOwner, error: ghMessage(r) };
  return { ok: true, repo: nameWithOwner, branch: plan.branch, was_protected: Boolean(existing), added_checks, kept_checks, removed_checks, payload: sent };
}

export const LIVE_VARIABLE = 'POCP_STATUS_LIVE';
export const STATUS_CHECK = 'pocp';
export const VERIFY_CHECK = 'verify';
const REPORTER_WORKFLOW = '.github/workflows/pocp-status.yml';
const planLimited = (e) => /upgrade to github pro|make this repository public/i.test(e || '');

/**
 * Turn the pocp status on: waits for an approval show yellow instead of a red verify job.
 * Two settings must change together, because each alone is unsafe or useless:
 * - the repository variable POCP_STATUS_LIVE, which makes a wait pass the verify job;
 * - branch protection requiring the pocp status instead of the verify job.
 * With the variable on and verify still required, a waiting pull request would pass its
 * required check, so the variable is set only when verify isn't required, or after protection
 * has swapped verify for pocp. Protection changes first: in between, waits are red, never open.
 *
 * `protect`: also set branch protection (ci required --apply). The pocp status is required only
 * once its workflow is on the protected branch: before that nothing would ever post it, and every
 * pull request, including the one that adds it, would be blocked.
 *
 * Returns { ok, repo, live, reporter, protection, required_status, removed_verify, merges_blocked, notes, error }.
 */
export function goLive(root, plan, { protect = false } = {}) {
  const repoR = gh(['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner']);
  if (!repoR.ok) return { ok: false, error: repoR.error || `gh repo view failed: ${repoR.stderr}` };
  const repo = repoR.stdout.trim();
  const notes = [];
  const reporter = gh(['api', `repos/${repo}/contents/${REPORTER_WORKFLOW}?ref=${encodeURIComponent(plan.branch)}`, '--jq', '.path']).ok;
  const read = readGithubProtection(plan);
  const noProtection = Boolean(read.error && planLimited(read.error));
  if (read.error && !noProtection) return { ok: false, repo, error: `could not read branch protection: ${read.error}` };
  const required = (ex) => new Set([...(ex?.required_status_checks?.contexts || []), ...((ex?.required_status_checks?.checks || []).map((c) => c.context))]);
  let have = required(read.existing);
  let protection = null;
  let removedVerify = false;
  if (protect && !noProtection) {
    const wantsStatus = plan.required_checks.includes(STATUS_CHECK);
    const sub = { ...plan, required_checks: plan.required_checks.filter((c) => c !== STATUS_CHECK || reporter) };
    if (wantsStatus && !reporter) notes.push(`the "${STATUS_CHECK}" status is not required yet: ${REPORTER_WORKFLOW} is not on ${plan.branch}. Merge it, then run this again.`);
    const swap = wantsStatus && reporter && have.has(VERIFY_CHECK) ? [VERIFY_CHECK] : [];
    if (sub.required_checks.length) {
      protection = applyGithubProtection(root, sub, { remove: swap });
      if (!protection.ok) return { ok: false, repo, protection, error: protection.error };
      removedVerify = protection.removed_checks.includes(VERIFY_CHECK);
      have = new Set(protection.payload.required_status_checks.checks?.map((c) => c.context) || protection.payload.required_status_checks.contexts || []);
    }
  }
  if (have.has(VERIFY_CHECK)) {
    return { ok: false, repo, reporter, protection, live: false, notes, error: `"${VERIFY_CHECK}" is a required check, so turning on ${LIVE_VARIABLE} would let a pull request that is waiting for approval merge. Require "${STATUS_CHECK}" instead of "${VERIFY_CHECK}" first (pocp ci required --apply, with "${STATUS_CHECK}" in ci.required_checks).` };
  }
  let set = gh(['api', '-X', 'PATCH', `repos/${repo}/actions/variables/${LIVE_VARIABLE}`, '-f', `name=${LIVE_VARIABLE}`, '-f', 'value=true']);
  if (!set.ok) set = gh(['api', '-X', 'POST', `repos/${repo}/actions/variables`, '-f', `name=${LIVE_VARIABLE}`, '-f', 'value=true']);
  if (!set.ok) return { ok: false, repo, reporter, protection, live: false, notes, error: `could not set the repository variable ${LIVE_VARIABLE}: ${ghMessage(set)}` };
  const statusRequired = have.has(STATUS_CHECK);
  if (noProtection) notes.push('GitHub has no branch protection for this private repository on its current plan, so nothing blocks a merge: the pocp status is a signal only. A public repository or a paid plan can require it.');
  else if (!statusRequired) notes.push(`merges are not blocked yet: require the "${STATUS_CHECK}" status${reporter ? '' : ` once ${REPORTER_WORKFLOW} is on ${plan.branch}`} with: pocp ci required --apply`);
  return { ok: true, repo, live: true, reporter, protection, required_status: statusRequired, removed_verify: removedVerify, merges_blocked: statusRequired, notes };
}

/**
 * Create the approval labels a maintainer approves changes with, on the repository `gh` is
 * pointed at. Labels that exist are left alone. `labels` maps each name to what it approves.
 * Returns { ok, repo, created: [], existing: [], error }.
 */
export function createApprovalLabels(labels) {
  const repoR = gh(['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner']);
  if (!repoR.ok) return { ok: false, created: [], existing: [], error: repoR.error || `gh repo view failed: ${repoR.stderr}` };
  const repo = repoR.stdout.trim();
  const listed = gh(['label', 'list', '--repo', repo, '--limit', '500', '--json', 'name', '--jq', '.[].name']);
  if (!listed.ok) return { ok: false, repo, created: [], existing: [], error: `could not list labels: ${ghMessage(listed)}` };
  const have = new Set(listed.stdout.split('\n').map((l) => l.trim()).filter(Boolean));
  const created = [];
  const existing = [];
  for (const [name, what] of Object.entries(labels)) {
    if (have.has(name)) { existing.push(name); continue; }
    const r = gh(['label', 'create', name, '--repo', repo, '--color', 'FBCA04', '--description', `POCP: a maintainer approves ${what}`]);
    if (!r.ok) return { ok: false, repo, created, existing, error: `could not create ${name}: ${ghMessage(r)}` };
    created.push(name);
  }
  return { ok: true, repo, created, existing };
}
