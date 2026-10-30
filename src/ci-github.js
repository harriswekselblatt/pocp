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
export function protectionPayload(existing, plan) {
  const ex = existing || {};
  const exChecks = ex.required_status_checks?.checks?.length
    ? ex.required_status_checks.checks.map((c) => ({ context: c.context, ...(c.app_id != null ? { app_id: c.app_id } : {}) }))
    : (ex.required_status_checks?.contexts || []).map((context) => ({ context }));
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
    required_status_checks: { strict: Boolean(ex.required_status_checks?.strict), contexts: checks.map((c) => c.context), checks },
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
  return { payload, added_checks: added, kept_checks: [...have].filter((c) => !plan.required_checks.includes(c)) };
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
export function applyGithubProtection(root, plan) {
  if (!plan.required_checks.length) {
    return { ok: false, refused: true, error: 'no required checks configured (ci.required_checks is empty); refusing to set protection that requires nothing' };
  }
  const read = readGithubProtection(plan);
  if (read.error) return { ok: false, ...(read.repo ? { repo: read.repo } : {}), error: read.error };
  const { repo: nameWithOwner, endpoint, existing } = read;
  const { payload, added_checks, kept_checks } = protectionPayload(existing, plan);
  const r = gh(['api', '-X', 'PUT', endpoint, '--input', '-'], { input: JSON.stringify(payload) });
  if (!r.ok) return { ok: false, repo: nameWithOwner, error: ghMessage(r) };
  return { ok: true, repo: nameWithOwner, branch: plan.branch, was_protected: Boolean(existing), added_checks, kept_checks, payload };
}
