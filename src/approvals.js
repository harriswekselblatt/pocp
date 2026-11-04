import { spawnSync } from 'node:child_process';
import { APPROVE_INCONCLUSIVE_LABEL, APPROVE_POLICY_LABEL, APPROVE_TESTS_LABEL, verifyRemedy } from './remedies.js';

// `pocp approvals`: every open pull request whose POCP verify fails only because it waits for
// a maintainer's label, in one list, and a deliberate way for that maintainer to give each one.
//
// The approval stays a person's: listing only reads; `--approve` refuses to run without a
// person at a terminal, shows what is being approved, and adds the label only after the person
// types the pull request's number. There is no flag that skips the question.

const POLICY_FILES = ['.proof/rules.json', '.proof/config.json', '.proof/allowed_signers', '.proof/exceptions.json'];

/** The annotation verify leaves on GitHub when approvals are all it is waiting for. */
export const APPROVAL_TITLE = 'POCP approval needed';

const LABEL_FOR = { tests: APPROVE_TESTS_LABEL, policy: APPROVE_POLICY_LABEL, inconclusive: APPROVE_INCONCLUSIVE_LABEL };
const KIND_FOR = Object.fromEntries(Object.entries(LABEL_FOR).map(([k, v]) => [v, k]));

/** Files named in a finding's "(a, b, c)". */
const filesIn = (detail) => (/\(([^)]*)\)/.exec(detail || '')?.[1] || '').split(',').map((s) => s.trim()).filter(Boolean);

/**
 * What a failed verify waits for. Each blocking finding is either an approval (its remedy is a
 * maintainer's label) or something else; `only` is true when every one is an approval.
 * Returns { only, needs: [{ label, kind, reasons, files }] }.
 */
export function approvalSummary(findings = [], rerunFailures = []) {
  const needs = new Map();
  // A re-run that didn't finish (timed out, killed, didn't start) says nothing about the code:
  // it waits for a re-run, not a label. One that ran and failed is a real failure.
  let unfinishedReruns = rerunFailures.filter((f) => f.unfinished === true).length;
  let other = rerunFailures.length > unfinishedReruns;
  for (const f of findings.filter((x) => x.blocking)) {
    // A required CI check whose re-run didn't finish: like an unfinished re-run, it waits for a
    // re-run, never a label.
    if (f.code === 'ci_unfinished') {
      unfinishedReruns++;
      continue;
    }
    const r = verifyRemedy(f.code, f.detail);
    const label = r.by === 'person' && Object.values(LABEL_FOR).find((l) => r.next.includes(`\`${l}\``));
    if (!label) {
      other = true;
      continue;
    }
    const kind = KIND_FOR[label];
    const n = needs.get(label) || { label, kind, reasons: [], files: [] };
    if (!n.reasons.includes(f.detail)) n.reasons.push(f.detail);
    const files = f.code === 'policy_loosened' ? POLICY_FILES : filesIn(f.detail);
    for (const file of files) if (!n.files.includes(file)) n.files.push(file);
    needs.set(label, n);
  }
  const list = [...needs.values()];
  const only = !other && needs.size > 0 && unfinishedReruns === 0;
  // What CI shows: "failed" (red), or a yellow wait: "inconclusive" when anything didn't
  // finish, else "waiting" for a maintainer's label.
  const outcome = other || (!needs.size && !unfinishedReruns)
    ? 'failed'
    : unfinishedReruns || needs.has(APPROVE_INCONCLUSIVE_LABEL) ? 'inconclusive' : 'waiting';
  return { only, needs: list, outcome, unfinished_reruns: unfinishedReruns };
}

/** verify's exit code for a result that isn't verified (0 is verified; see docs/REFERENCE.md). */
export const VERIFY_EXIT = Object.freeze({ waiting: 4, inconclusive: 5 });

/** The GitHub Actions annotation for a summary (workflow-command escaped), or null. */
export function approvalAnnotation(summary) {
  if (!summary?.only) return null;
  const data = JSON.stringify({ needs: summary.needs });
  return `::notice title=${APPROVAL_TITLE}::${data.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')}`;
}

// Verify's error annotations, for runs by a pinned Action older than the approval annotation.
const INFER = [
  { re: /^existing tests or test setup changed \(/, code: 'test_change' },
  { re: /^policy loosened without approval: /, code: 'policy_loosened' },
  { re: /^CI configuration changed \(/, code: 'ci_config_changed' },
  { re: /^protected files changed \(/, code: 'ci_config_changed' },
];

/**
 * What a check run's annotations say. Returns null when they are not POCP's, otherwise
 * { only, needs, inferred } (inferred: read from an older verify's error text).
 */
export function readAnnotations(annotations = []) {
  const marker = annotations.find((a) => a.title === APPROVAL_TITLE);
  if (marker) {
    try {
      const { needs } = JSON.parse(marker.message);
      if (Array.isArray(needs) && needs.length && needs.every((n) => Object.values(LABEL_FOR).includes(n.label))) return { only: true, needs, inferred: false };
    } catch { /* fall through to the error text */ }
  }
  const errors = annotations.filter((a) => a.annotation_level === 'failure' && /^POCP( |$)/.test(a.title || ''));
  if (!errors.length) return null;
  const findings = [];
  let other = false;
  for (const a of errors) {
    if (a.title !== 'POCP') {
      other = true; // a re-run failed
      continue;
    }
    // "<sha12> problem | problem | …"
    for (const part of String(a.message || '').replace(/^[0-9a-f]{7,40}\s+/, '').split(' | ')) {
      const hit = INFER.find((x) => x.re.test(part));
      if (hit) findings.push({ code: hit.code, detail: part, blocking: true });
      else other = true;
    }
  }
  const s = approvalSummary(findings);
  return { only: s.only && !other, needs: s.needs, inferred: true };
}

// ---- GitHub, through gh ------------------------------------------------------------------

function ghBin() {
  return process.env.POCP_GH || 'gh';
}

function gh(args) {
  const r = spawnSync(ghBin(), args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.error) return { ok: false, missing: true, message: `could not run ${ghBin()}: ${r.error.message}`, stdout: '' };
  let json = null;
  try {
    json = JSON.parse(r.stdout);
  } catch { /* not JSON */ }
  return { ok: r.status === 0, stdout: r.stdout || '', json, message: json?.message || (r.stderr || '').trim() || `gh exited ${r.status}` };
}

export class ApprovalsError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ApprovalsError';
  }
}

function ghJson(args) {
  const r = gh(args);
  if (!r.ok || r.json === null) throw new ApprovalsError(`gh ${args.slice(0, 3).join(' ')} failed: ${r.message}${r.missing ? '' : ' (is "gh auth login" done?)'}`);
  return r.json;
}

const PR_FIELDS = 'number,title,url,author,headRefOid,labels,files,isDraft';

/** The repositories to look in: the ones named, plus those with open PRs under each owner. */
function reposToScan({ repos = [], owners = [] }) {
  const out = new Set(repos);
  let who = owners;
  if (!repos.length && !owners.length) who = [ghJson(['api', 'user']).login];
  for (const owner of who) {
    const hits = ghJson(['search', 'prs', '--owner', owner, '--state', 'open', '--limit', '200', '--json', 'repository']);
    for (const h of hits) if (h.repository?.nameWithOwner) out.add(h.repository.nameWithOwner);
  }
  return [...out].sort();
}

/** The latest completed run per check name on a commit, and the names still running. */
function latestRuns(repo, sha) {
  const r = ghJson(['api', `repos/${repo}/commits/${sha}/check-runs?per_page=100`]);
  const done = new Map();
  const running = new Set();
  for (const run of r.check_runs || []) {
    if (run.status !== 'completed') {
      running.add(run.name);
      continue;
    }
    const prev = done.get(run.name);
    if (!prev || run.id > prev.id) done.set(run.name, run);
  }
  return { done: [...done.values()], running };
}

/**
 * Where one pull request stands. state is one of
 *   "pending"   verify fails only for approvals, and at least one label is not on the PR yet
 *   "approved"  every label it needs is on; verify has not passed since (it re-runs on "labeled")
 *   "blocked"   verify fails for something an approval does not fix
 *   null        nothing POCP is waiting for
 */
export function prStatus(repo, pr) {
  const { done, running } = latestRuns(repo, pr.headRefOid);
  for (const run of done.filter((x) => x.conclusion === 'failure')) {
    const anns = ghJson(['api', `repos/${repo}/check-runs/${run.id}/annotations?per_page=100`]);
    const s = readAnnotations(Array.isArray(anns) ? anns : []);
    if (!s) continue;
    const base = { repo, number: pr.number, title: pr.title, url: pr.url, author: pr.author?.login || null, head: pr.headRefOid, draft: Boolean(pr.isDraft), check: run.name, check_url: run.html_url || null, inferred: s.inferred };
    if (!s.only) return { ...base, state: 'blocked', needs: [] };
    const have = new Set((pr.labels || []).map((l) => l.name));
    const files = pr.files || [];
    const needs = s.needs.map((n) => ({
      ...n,
      given: have.has(n.label),
      named: n.files,
      // What the label approves: the PR's own changes to the files the finding named.
      files: files.filter((f) => n.files.includes(f.path)).map((f) => ({ path: f.path, additions: f.additions, deletions: f.deletions })),
    }));
    return { ...base, state: needs.every((n) => n.given) ? 'approved' : 'pending', running: running.has(run.name), needs };
  }
  return null;
}

/** Every open pull request POCP is waiting on, in the repositories asked for. */
export function listApprovals({ repos = [], owners = [] } = {}) {
  const scanned = reposToScan({ repos, owners });
  const items = [];
  for (const repo of scanned) {
    const prs = ghJson(['pr', 'list', '--repo', repo, '--state', 'open', '--limit', '200', '--json', PR_FIELDS]);
    for (const pr of prs) {
      const s = prStatus(repo, pr);
      if (s) items.push(s);
    }
  }
  const order = { pending: 0, approved: 1, blocked: 2 };
  items.sort((a, b) => order[a.state] - order[b.state] || a.repo.localeCompare(b.repo) || a.number - b.number);
  return { repos: scanned, pending: items.filter((i) => i.state === 'pending').length, items };
}

/** "owner/repo#12", a pull request URL, or "12" with a repository. */
export function parsePrRef(ref, repo) {
  const s = String(ref || '').trim();
  let m = /^https?:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/.exec(s);
  if (m) return { repo: m[1], number: Number(m[2]) };
  m = /^([\w.-]+\/[\w.-]+)#(\d+)$/.exec(s);
  if (m) return { repo: m[1], number: Number(m[2]) };
  if (/^\d+$/.test(s)) {
    if (!repo) throw new ApprovalsError(`which repository is #${s} in? Use owner/repo#${s} or --repo owner/repo`);
    return { repo, number: Number(s) };
  }
  throw new ApprovalsError(`not a pull request: "${s}" (use owner/repo#12 or a pull request URL)`);
}

function fetchPr(repo, number) {
  return ghJson(['pr', 'view', String(number), '--repo', repo, '--json', `${PR_FIELDS},state`]);
}

/** The PR's diff, cut down to `files` (all of it when none match), at most `max` lines. */
export function diffFor(repo, number, files, max = 400) {
  const r = gh(['pr', 'diff', String(number), '--repo', repo]);
  if (!r.ok) return { text: `(could not read the diff: ${r.message})`, cut: false };
  const parts = r.stdout.split(/(?=^diff --git )/m).filter((p) => p.startsWith('diff --git '));
  const wanted = parts.filter((p) => files.some((f) => p.startsWith(`diff --git a/${f} `) || p.includes(` b/${f}\n`)));
  const lines = (wanted.length ? wanted : parts).join('').split('\n');
  return { text: lines.slice(0, max).join('\n').replace(/\n$/, ''), cut: lines.length > max, whole: !wanted.length };
}

/**
 * Give one approval, deliberately. Needs a person at a terminal (`interactive`) who confirms
 * by typing the pull request's number when `ask` prompts. `say` prints. `label` narrows to
 * "tests" or "policy" when a PR waits for both. Returns { approved: [labels], skipped: [] }.
 */
export async function approvePr({ ref, repo, label, interactive, ask, say }) {
  if (!interactive) {
    throw new ApprovalsError('--approve must be run by a person at a terminal: it shows the change and asks you to confirm. An agent must never approve a change, its own or anyone else\'s; it can run "pocp approvals" to list what is waiting and ask a maintainer.');
  }
  if (label && !LABEL_FOR[label] && !Object.values(LABEL_FOR).includes(label)) throw new ApprovalsError(`--label must be tests or policy, not "${label}"`);
  const want = label ? LABEL_FOR[label] || label : null;
  const { repo: r, number } = parsePrRef(ref, repo);
  const pr = fetchPr(r, number);
  if (pr.state && pr.state !== 'OPEN') throw new ApprovalsError(`${r}#${number} is ${pr.state.toLowerCase()}; nothing to approve`);
  const st = prStatus(r, pr);
  if (!st) throw new ApprovalsError(`${r}#${number}: POCP verify is not failing on this pull request's head, so there is nothing to approve`);
  if (st.state === 'blocked') throw new ApprovalsError(`${r}#${number}: verify fails for more than an approval (${st.check}); a label would not fix it. Open ${st.check_url || st.url}`);
  const todo = st.needs.filter((n) => !n.given && (!want || n.label === want));
  if (!todo.length) {
    say(want && !st.needs.some((n) => n.label === want) ? `${r}#${number} does not need ${want}.` : `${r}#${number} already has every label it needs; verify re-runs when a label is added.`);
    return { approved: [], skipped: [] };
  }
  const approved = [];
  const skipped = [];
  for (const n of todo) {
    say('');
    say(`${r}#${number}  ${pr.title}`);
    say(`  by ${pr.author?.login || 'unknown'} · head ${pr.headRefOid.slice(0, 12)} · ${pr.url}`);
    say(`  ${n.label} approves ${n.kind === 'tests' ? 'a change to existing tests or test setup' : 'a change to the POCP policy or CI that judges every later change'}:`);
    for (const reason of n.reasons) say(`    ${reason}`);
    const d = diffFor(r, number, n.named);
    say(d.whole ? '  the whole diff (the files involved could not be told apart):' : '  the diff being approved:');
    say(d.text.split('\n').map((l) => `    ${l}`).join('\n'));
    if (d.cut) say(`    … cut; the full diff: gh pr diff ${number} --repo ${r}`);
    const answer = String((await ask(`Add ${n.label} to ${r}#${number}? Type ${number} to approve, anything else to skip: `)) ?? '').trim();
    if (answer !== String(number)) {
      say(`  not approved: ${n.label} not added.`);
      skipped.push(n.label);
      continue;
    }
    // The approval is for the code just shown: refuse if the PR moved while it was read.
    const now = fetchPr(r, number);
    if (now.headRefOid !== pr.headRefOid) throw new ApprovalsError(`${r}#${number} got new commits while you were reviewing (${pr.headRefOid.slice(0, 12)} → ${now.headRefOid.slice(0, 12)}); nothing added. Run it again to see the new diff.`);
    const add = gh(['pr', 'edit', String(number), '--repo', r, '--add-label', n.label]);
    if (!add.ok) throw new ApprovalsError(`could not add ${n.label}: ${add.message}`);
    say(`  approved: ${n.label} added to ${r}#${number}. verify runs again on the label.`);
    approved.push(n.label);
  }
  if (approved.length) say('If new commits arrive before this merges, remove the label and approve again: the label stays on through later pushes.');
  return { approved, skipped };
}

export function formatApprovals(r) {
  const pending = r.items.filter((i) => i.state === 'pending');
  const approved = r.items.filter((i) => i.state === 'approved');
  const blocked = r.items.filter((i) => i.state === 'blocked');
  const lines = [`pocp approvals: ${pending.length} pull request(s) waiting for an approval in ${r.repos.length} repositor${r.repos.length === 1 ? 'y' : 'ies'}`];
  for (const i of pending) {
    lines.push('', `  ${i.repo}#${i.number}  ${i.title}${i.draft ? '  (draft)' : ''}`);
    lines.push(`    by ${i.author || 'unknown'} · ${i.url}`);
    for (const n of i.needs.filter((x) => !x.given)) {
      lines.push(`    needs ${n.label}: ${n.kind === 'tests' ? 'existing tests or test setup changed' : 'POCP policy or CI changed'}`);
      for (const reason of n.reasons) lines.push(`      ${reason}`);
      for (const f of n.files) lines.push(`      ${f.path}  +${f.additions ?? '?'} -${f.deletions ?? '?'}`);
    }
    if (i.inferred) lines.push('    (read from an older verify\'s messages; open the check if this looks wrong)');
    lines.push(`    to approve: pocp approvals --approve ${i.repo}#${i.number}`);
  }
  if (approved.length) {
    lines.push('', '  approved, waiting for verify to run again:');
    for (const i of approved) lines.push(`    ${i.repo}#${i.number}  ${i.title}${i.running ? '  (running)' : ''}`);
  }
  if (blocked.length) {
    lines.push('', '  failing for more than an approval (a label will not fix these):');
    for (const i of blocked) lines.push(`    ${i.repo}#${i.number}  ${i.title}  ${i.check_url || i.url}`);
  }
  if (pending.length) lines.push('', 'Each approval is yours to give: --approve shows the change and asks you to confirm. An agent must not run it.');
  return lines.join('\n');
}
