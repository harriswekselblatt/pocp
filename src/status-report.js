// `pocp status-report`: the trusted reporter (docs/STATUS.md). It runs in a privileged workflow
// (workflow_run / pull_request_target) from the default branch's code, never the pull request's,
// and sets one commit status, `pocp`, on a pull request's current head.
//
// It never takes a run's word for anything it could have been made to say. A pull_request
// workflow runs the pull request's own copy of the workflow file, so a run's step results are
// trusted only when the pull request's diff changes no CI file. Everything is fetched fresh from
// GitHub's API on each call, so the order events arrive in doesn't matter.

import { matchGlob } from './glob.js';
import { DEFAULT_CI_FILES } from './store.js';

export const STATUS_CONTEXT = 'pocp';
export const WORKFLOW_PATH = '.github/workflows/pocp.yml';
export const VERIFY_JOB = 'verify';
export const APPROVE_WORKFLOW_LABEL = 'pocp-approve-workflow';
// Marker steps the trusted workflow runs only when it passed that approval to verify.
export const APPROVAL_MARKERS = Object.freeze({
  'approval-tests': 'pocp-approve-tests',
  'approval-policy': 'pocp-approve-policy',
  'approval-inconclusive': 'pocp-approve-inconclusive',
  'approval-coverage': 'pocp-approve-coverage',
});
const WRITE_PERMISSIONS = new Set(['admin', 'maintain', 'write']);
// GitHub's "list pull request files" returns at most this many files. A list that reaches it may
// be missing the rest, so it never shows that no CI file changed.
export const FILES_CAP = 3000;

/**
 * The name of the step the trusted workflow runs first, saying which pull request and base the
 * run evaluated. A head commit can belong to several pull requests, each judged by its own base's
 * rules, so a run counts only for the pull request and base it names.
 */
export const runMarker = (number, baseSha) => `pocp-run pr-${number} base-${baseSha}`;
const MARKER_PREFIX = 'pocp-run ';

export const TEXT = Object.freeze({
  verified: 'Verified: required checks passed on this code.',
  waiting: "Waiting for a maintainer's approval. See the verify run for what's needed.",
  inconclusive: "Inconclusive: a check didn't finish. Re-run it, or a maintainer approves.",
  failed: 'Not verified: see the verify run.',
  pending: 'Waiting for verify.',
  workflow: 'CI workflow changed: a maintainer reviews it and adds pocp-approve-workflow.',
  approvalGone: 'An approval this result relied on was removed: approve again.',
  incomplete: "Not verified: GitHub's data for this pull request was incomplete. Re-run, or split a very large pull request.",
  sharedHead: 'Another open pull request has this same head commit, and a status is per commit: close all but one.',
  unidentified: "The newest verify run doesn't say which pull request it checked: re-run it.",
  outdated: 'pocp.yml is older than this reporter: update it (pocp init --github --force) and re-run.',
  stale: 'The pull request changed while its status was decided: deciding again.',
  approvalUnverified: 'An approval label was not applied by a maintainer with write access for this commit: a maintainer applies it again.',
});

// Approvals of content (not of one run's outcome, and not of a workflow, which can run any file)
// that may carry over to a clean merge of the base branch into the approved head.
export const CARRYABLE = Object.freeze(['pocp-approve-tests', 'pocp-approve-policy', 'pocp-approve-coverage']);
// GitHub's compare API lists at most this many files: a list that reaches it may be missing some.
export const COMPARE_FILES_CAP = 300;
const POLICY_PREFIX = '.proof/';

/** The CI files a pull request may not change without a maintainer (the base's ci.files, defaults always included). */
export function workflowFiles(baseConfig) {
  return [...new Set([...DEFAULT_CI_FILES, ...(baseConfig?.ci?.files || [])])];
}

/** Changed paths (including the old path of a rename) that are CI files. */
export function changedWorkflowFiles(files, globs) {
  const hit = new Set();
  for (const f of files || []) for (const p of [f.filename, f.previous_filename]) if (p && globs.some((g) => matchGlob(p, g))) hit.add(p);
  return [...hit].sort();
}

const stepOf = (job, name) => (job?.steps || []).find((s) => s.name === name);
const ran = (step) => Boolean(step && step.conclusion && step.conclusion !== 'skipped');

/** The verify job's key steps as "name=conclusion", for the log. */
export function stepSummary(job) {
  if (!job) return 'no verify job';
  const names = ['verify', 'verified', 'waiting', 'inconclusive', 'failed'];
  return `job ${job.status || '?'}/${job.conclusion || '?'}: ${names.map((n) => `${n}=${stepOf(job, n)?.conclusion ?? 'missing'}`).join(' ')}`;
}

/**
 * What one completed run of the trusted workflow says, from its verify job's steps alone.
 * Returns { outcome: verified|waiting|inconclusive|failed|unreadable|outdated, approvals: [labels] }.
 * "unreadable": GitHub hasn't returned complete step data (no job, the job not completed, a key
 * step missing or without a result). Seen live: the run was reported completed while its job's
 * steps weren't readable yet. That's a wait (pending), never a success and never a failure.
 * Complete data that matches no known pattern is "failed": unknown never reads as success.
 */
export function readRun(job) {
  const verify = stepOf(job, 'verify');
  const failed = stepOf(job, 'failed');
  const waiting = stepOf(job, 'waiting');
  const inconclusive = stepOf(job, 'inconclusive');
  const approvals = Object.entries(APPROVAL_MARKERS).filter(([step]) => stepOf(job, step)?.conclusion === 'success').map(([, label]) => label);
  // verify keeps going on failure (continue-on-error), and `verified` runs only when its exit
  // status was 0. That exit status is the only part of the run the pull request's checks can't
  // write, so green comes from `verified` alone; the other three steps only choose between
  // waiting, inconclusive and failed. A run without every one of these steps is from a workflow
  // older than this reporter (or GitHub left a step out): never green, never guessed.
  const verified = stepOf(job, 'verified');
  if (job && job.status === 'completed' && Array.isArray(job.steps) && job.steps.length && [verify, verified, failed, waiting, inconclusive].some((st) => !st)) return { outcome: 'outdated', approvals };
  const keySteps = [verify, verified, failed, waiting, inconclusive];
  if (!job || (job.status && job.status !== 'completed') || !job.conclusion || keySteps.some((st) => !st || !st.conclusion)) return { outcome: 'unreadable', approvals };
  const others = [failed, waiting, inconclusive].filter(ran).length;
  if (ran(verified)) return { outcome: others === 0 && verified.conclusion === 'success' && job.conclusion === 'success' ? 'verified' : 'failed', approvals };
  if (ran(failed) || others !== 1) return { outcome: 'failed', approvals };
  return { outcome: ran(waiting) ? 'waiting' : 'inconclusive', approvals };
}

/**
 * Which pull request and base a run says it evaluated:
 * - "other": its one marker names another pull request or base. Only this lets an older run
 *   speak instead: the newer run was about something else.
 * - "match": its one marker names this pull request and base, and succeeded.
 * - "unknown": anything else. No steps yet, no marker (a workflow older than the marker, or a
 *   run that failed or was cancelled before reaching it), a marker without a result, a failed
 *   marker, more than one marker. A newer run that might be this pull request's evaluation is
 *   never skipped in favour of an older success: unknown is a wait, never a match.
 */
export function runIdentity(job, number, baseSha) {
  if (!job || !Array.isArray(job.steps) || !job.steps.length) return 'unknown';
  const markers = job.steps.filter((s) => String(s.name || '').startsWith(MARKER_PREFIX));
  if (markers.length !== 1) return 'unknown';
  if (markers[0].name !== runMarker(number, baseSha)) return 'other';
  return markers[0].conclusion === 'success' ? 'match' : 'unknown';
}

// Every step the trusted workflow runs to evaluate a pull request.
const POCP_STEPS = new Set(['verify', 'verified', 'waiting', 'inconclusive', 'failed', ...Object.keys(APPROVAL_MARKERS)]);
const isPocpStep = (s) => POCP_STEPS.has(s.name) || String(s.name || '').startsWith(MARKER_PREFIX);

/**
 * Whether a run was cancelled before its verify job evaluated anything: the run and its verify
 * job both finished cancelled, and none of the workflow's own steps has a result other than
 * skipped (a job cancelled while queued has no steps at all). Seen live: adding several approval
 * labels at once starts a run per label, and the concurrency group cancels all but one. Such a
 * run says nothing, like a skipped one. A run whose marker or verify step has any result (even
 * cancelled, or none yet) may have been this pull request's evaluation, so it still counts, and
 * a run with no verify job (not created, or the job list unreadable) is never called silent.
 */
export function cancelledBeforeVerify(run) {
  const job = run?.job;
  if (!run || run.status !== 'completed' || run.conclusion !== 'cancelled') return false;
  if (!job || job.status !== 'completed' || job.conclusion !== 'cancelled' || !Array.isArray(job.steps)) return false;
  return job.steps.filter(isPocpStep).every((s) => s.conclusion === 'skipped');
}

/** Why the pull request's file list can't show which files changed, or null when it's complete. */
export function filesIncomplete(files, changedFiles) {
  const n = (files || []).length;
  if (!Number.isInteger(changedFiles) || changedFiles < 0) return "GitHub didn't say how many files the pull request changes";
  if (n >= FILES_CAP) return `the file list reached GitHub's limit of ${FILES_CAP} files`;
  if (n !== changedFiles) return `the file list has ${n} files, but the pull request changes ${changedFiles}`;
  if (new Set(files.map((f) => f.filename)).size !== n) return 'the file list repeats a file';
  return null;
}

/**
 * The status for a pull request's current head. Pure: everything comes from `facts`, which
 * gather() fetches. Returns { write: false, reason } when nothing should be written, else
 * { write: true, sha, state, description, target_url, reason }.
 *
 * facts: {
 *   event_sha,                     the head the triggering event was about
 *   pr: { number, state, head_sha, labels: [names], author } | null,
 *   base_sha,                      the pull request's current base commit
 *   changed_files,                 how many files GitHub says the pull request changes
 *   head_prs: [numbers],           every open pull request whose head is this commit
 *   incomplete: [reasons],         API lists that may be missing items (cut short, errored)
 *   workflow_approver,             "independent" (default: not the author) or "any-writer"
 *   workflow: { id, path },        the trusted workflow, by path on the default branch
 *   repository,                    "owner/name"
 *   files: [{ filename, previous_filename }],  the pull request's diff from its merge base
 *   ci_globs,                      workflowFiles(base config)
 *   runs: [{ id, workflow_id, path, event, head_sha, repository, status, conclusion, created_at, run_started_at, run_attempt, html_url, job }],
 *   label_events: [{ label, actor, permission, created_at }],  "labeled" events of approval labels
 *   label_events_complete,         whether every event was read (approvals need it)
 * }
 */
export function decideStatus(facts) {
  const { pr } = facts;
  const incomplete = [...(facts.incomplete || [])];
  if (!pr) {
    // The open pull requests couldn't all be read, so one with this head may be missing: hold
    // the commit at pending rather than leave an older status standing.
    if (incomplete.length && facts.event_sha) return { write: true, sha: facts.event_sha, state: 'pending', description: TEXT.incomplete, target_url: null, reason: `couldn't find the pull request: ${incomplete.join('; ')}` };
    return { write: false, reason: `no open pull request has head ${short(facts.event_sha)}` };
  }
  if (pr.state !== 'open') return { write: false, reason: `pull request #${pr.number} is ${pr.state}` };
  if (facts.event_sha && pr.head_sha !== facts.event_sha) {
    return { write: false, reason: `pull request #${pr.number} moved to ${short(pr.head_sha)}; ${short(facts.event_sha)} is no longer its head` };
  }
  const sha = pr.head_sha;
  const status = (state, description, reason, run) => ({ write: true, sha, state, description, target_url: run?.html_url || null, reason });

  // Everything below needs complete data. Anything missing, cut short or inconsistent is
  // pending, whatever labels are on: an approval can't stand in for data nobody has seen.
  if (!facts.base_sha) incomplete.push("GitHub didn't say what the pull request's base is");
  const filesGap = filesIncomplete(facts.files, facts.changed_files);
  if (filesGap) incomplete.push(filesGap);
  if (!(facts.head_prs || []).includes(pr.number)) incomplete.push(`the list of open pull requests doesn't show #${pr.number} with head ${short(sha)}`);
  if (incomplete.length) return status('pending', TEXT.incomplete, `incomplete data: ${incomplete.join('; ')}`, null);
  // A commit status belongs to the commit, so every pull request with this head shows it. Green
  // for one would be green for all, each judged by a different base: never green while shared.
  const others = facts.head_prs.filter((n) => n !== pr.number);
  if (others.length) return status('pending', TEXT.sharedHead, `open pull requests ${[pr.number, ...others].map((n) => `#${n}`).join(', ')} share head ${short(sha)}`, null);

  // Only runs of the trusted workflow, for this repository's pull_request event, on this head.
  const ofHead = (facts.runs || [])
    .filter((r) => r.workflow_id === facts.workflow.id && r.path === facts.workflow.path)
    .filter((r) => r.event === 'pull_request' && r.repository === facts.repository && r.head_sha === sha)
    // A run whose verify job was skipped (a label event the workflow ignores) says nothing.
    .filter((r) => r.conclusion !== 'skipped' && !(r.job && r.job.conclusion === 'skipped'))
    // Nor does a run cancelled before its verify job evaluated anything (cancelledBeforeVerify).
    .filter((r) => !cancelledBeforeVerify(r));
  // A run still queued or running (a new run, or a re-run attempt of an older one) may replace
  // what finished before it: wait for it. Which pull request it is for isn't readable yet.
  const underway = ofHead.filter((r) => r.status !== 'completed');
  // The newest attempt decides: a re-run's attempt starts after its run was created.
  const at = (r) => String(r.run_started_at || r.created_at);
  const runs = ofHead.filter((r) => r.status === 'completed')
    .sort((a, b) => at(a).localeCompare(at(b)) || String(a.created_at).localeCompare(String(b.created_at)) || (a.run_attempt || 1) - (b.run_attempt || 1) || a.id - b.id);
  // From the newest back: skip runs that say they evaluated another pull request or base; stop
  // at the first that evaluated this one, or at one that doesn't say (runIdentity).
  let newest = null;
  let unknown = null;
  for (const r of [...runs].reverse()) {
    const id = runIdentity(r.job, pr.number, facts.base_sha);
    if (id === 'other') continue;
    if (id === 'unknown') unknown = r;
    else newest = r;
    break;
  }

  const changed = changedWorkflowFiles(facts.files, facts.ci_globs || workflowFiles(null));
  let via = '';
  if (changed.length) {
    // The run's steps come from the pull request's own workflow: not evidence until a
    // maintainer has reviewed that workflow. pocp-approve-workflow approves only the workflow
    // change: after it, the run is judged by every rule below, exactly like any other run, so
    // anything else it still waits for (tests, policy, a check that didn't finish) stays pending.
    const independent = (facts.workflow_approver || 'independent') === 'independent';
    const lastWorkflowLabel = (facts.label_events || []).filter((e) => e.label === APPROVE_WORKFLOW_LABEL).sort((x, y) => String(x.created_at).localeCompare(String(y.created_at))).at(-1);
    const approved = pr.labels.includes(APPROVE_WORKFLOW_LABEL) && approvedByWriter(facts, APPROVE_WORKFLOW_LABEL, sha)
      && (!independent || (lastWorkflowLabel?.actor && pr.author && lastWorkflowLabel.actor !== pr.author));
    if (!approved) {
      return status('pending', TEXT.workflow, `CI files changed (${changed.join(', ')}), so the run's results aren't trusted until ${independent ? 'a writer other than the author' : 'a writer'} adds ${APPROVE_WORKFLOW_LABEL} after this head's first run`, newest);
    }
    via = `; CI files changed (${changed.join(', ')}), workflow approved with ${APPROVE_WORKFLOW_LABEL}`;
  }

  if (underway.length) return status('pending', TEXT.pending, `run ${underway.map((r) => r.id).join(', ')} of ${facts.workflow.path} for ${short(sha)} is still ${underway[0].status || 'running'}${via}`, underway[0]);
  if (unknown) {
    // Steps not returned yet may still come: fetch again. Complete steps without a usable marker
    // (an older workflow, or a run that stopped before the marker) won't change: re-run or update.
    const settled = unknown.job?.status === 'completed' && Array.isArray(unknown.job.steps) && unknown.job.steps.length > 0;
    if (settled) return status('pending', TEXT.unidentified, `run ${unknown.id} doesn't say which pull request and base it evaluated (${stepSummary(unknown.job)})${via}`, unknown);
    return { ...status('pending', TEXT.pending, `run ${unknown.id}'s steps aren't readable yet (${stepSummary(unknown.job)})${via}`, unknown), unreadable: true };
  }
  if (!newest) return status('pending', TEXT.pending, `no completed run of ${facts.workflow.path} for #${pr.number} on base ${short(facts.base_sha)} at ${short(sha)} yet`, null);
  // The newest evaluation was cancelled: what finished before it is no longer the latest word.
  if (newest.conclusion === 'cancelled' || newest.job?.conclusion === 'cancelled') return status('pending', TEXT.pending, `run ${newest.id} was cancelled${via}`, newest);
  const { outcome, approvals } = readRun(newest.job);
  if (outcome === 'outdated') return status('pending', TEXT.outdated, `run ${newest.id} lacks a step this reporter needs (${stepSummary(newest.job)})${via}`, newest);
  if (outcome === 'unreadable') return { ...status('pending', TEXT.pending, `run ${newest.id}'s steps aren't readable yet (${stepSummary(newest.job)})${via}`, newest), unreadable: true };
  if (outcome === 'verified') {
    const gone = approvals.filter((l) => !pr.labels.includes(l));
    if (gone.length) return status('pending', TEXT.approvalGone, `run ${newest.id} relied on ${gone.join(', ')}, which is no longer on the pull request${via}`, newest);
    // A label is only as good as who put it there: GitHub lets roles without write access
    // (triage) manage labels. Each approval the run used must have been applied last by a
    // writer, after this head's first run (so it was given for this code).
    const unauthorized = approvals.filter((l) => !approvedByWriter(facts, l, sha) && !carriedOver(facts, l).ok);
    if (unauthorized.length) return status('pending', TEXT.approvalUnverified, `run ${newest.id} relied on ${unauthorized.join(', ')}, last applied by someone without write access, before this head's first run, or not readable${via}`, newest);
    const carried = approvals.filter((l) => !approvedByWriter(facts, l, sha));
    const how = carried.length ? `; ${carried.join(', ')} carried over from ${short(facts.carry.from_sha)} (a clean merge of the base into it)` : '';
    return status('success', TEXT.verified, `run ${newest.id} verified${approvals.length ? ` with ${approvals.join(', ')}` : ''}${how}${via}`, newest);
  }
  if (outcome === 'failed') return status('failure', TEXT.failed, `run ${newest.id} failed (${stepSummary(newest.job)})${via}`, newest);
  return status('pending', TEXT[outcome], `run ${newest.id} is ${outcome}${via}`, newest);
}

const short = (sha) => (sha ? String(sha).slice(0, 12) : '(none)');

/**
 * Whether the label's current application is a writer's, given for this head: its most recent
 * "labeled" event is by someone with write access, after the head's first run of the workflow.
 * Needs the whole event list (facts.label_events_complete): a list cut short could hide a later
 * application by someone else.
 */
function approvedByWriter(facts, label, sha) {
  if (!facts.label_events_complete) return false;
  const firstRunAt = (facts.runs || []).filter((r) => r.head_sha === sha).map((r) => String(r.created_at)).sort()[0] || null;
  const last = (facts.label_events || []).filter((e) => e.label === label).sort((a, b) => String(a.created_at).localeCompare(String(b.created_at))).at(-1);
  return Boolean(last && WRITE_PERMISSIONS.has(last.permission) && firstRunAt && String(last.created_at) > firstRunAt);
}

/**
 * Whether an approval given for the previous head still applies to this one. Only in one narrow
 * case: the new head is a merge of the approved head with the current base, and that merge
 * changed nothing the pull request changes, and no policy file. Then what the person approved
 * (the pull request's own changes) is byte-for-byte what is there now. The approval is kept, not
 * any result: the new head is verified again on the new base, and goes green only from that run.
 * Never for an inconclusive or workflow approval. facts.carry comes from gather(), from GitHub's
 * API only.
 */
export function carriedOver(facts, label) {
  const c = facts.carry;
  const no = (why) => ({ ok: false, why });
  if (!CARRYABLE.includes(label)) return no(`${label} never carries over`);
  if (!c) return no('the head is not a merge of the base into an approved head');
  if (!c.complete) return no(`GitHub's data for the merge was incomplete${c.reason ? ` (${c.reason})` : ''}`);
  if (!c.from_sha || !c.merged_sha || c.merged_sha !== facts.base_sha) return no('the head is not a merge of the current base into the previous head');
  if (!facts.label_events_complete) return no('the label events were incomplete');
  // The approval was given by a writer while the previous head was the pull request's head:
  // after that head's first run for this pull request.
  const mine = (r) => r.head_sha === c.from_sha && (r.job?.steps || []).some((st) => String(st.name || '').startsWith(`${MARKER_PREFIX}pr-${facts.pr.number} base-`) && st.conclusion === 'success');
  const firstRunAt = (c.runs || []).filter(mine).map((r) => String(r.created_at)).sort()[0] || null;
  const last = (facts.label_events || []).filter((e) => e.label === label).sort((a, b) => String(a.created_at).localeCompare(String(b.created_at))).at(-1);
  if (!last || !WRITE_PERMISSIONS.has(last.permission)) return no(`${label} was last applied by someone without write access`);
  if (!firstRunAt || String(last.created_at) <= firstRunAt) return no(`${label} was not given for ${short(c.from_sha)}`);
  const merged = new Set(c.merge_files || []);
  const touched = (c.pr_files || []).filter((f) => merged.has(f));
  if (touched.length) return no(`the merge changed files the pull request changes: ${touched.slice(0, 3).join(', ')}`);
  // Every file the pull request now changes must be one the approved head already changed. A
  // merge that keeps an old version of a file the base changed (undoing a fix, a new test, a
  // tighter rule) leaves it out of the merge's own list, but adds it to the pull request's.
  const approved = new Set(c.approved_files || []);
  const added = (c.pr_files || []).filter((f) => !approved.has(f));
  if (added.length) return no(`the merge adds changes the approval didn't cover: ${added.slice(0, 3).join(', ')}`);
  const policy = [...merged].filter((f) => f.startsWith(POLICY_PREFIX));
  if (policy.length) return no(`the merge changed policy files: ${policy.slice(0, 3).join(', ')}`);
  return { ok: true };
}

/** A minimal GitHub REST client over fetch. */
export function githubClient({ token, api = 'https://api.github.com', fetchImpl = globalThis.fetch } = {}) {
  if (!token) throw new Error('status-report needs a GitHub token (GH_TOKEN or GITHUB_TOKEN)');
  async function call(method, url, body) {
    const res = await fetchImpl(url.startsWith('http') ? url : `${api}${url}`, {
      method,
      headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`GitHub API ${method} ${url}: ${res.status} ${text.slice(0, 200)}`);
    return { data: text ? JSON.parse(text) : null, link: res.headers.get('link') || '' };
  }
  const nextLink = (link) => /<([^>]+)>;\s*rel="next"/.exec(link)?.[1] || null;
  return {
    get: async (url) => (await call('GET', url)).data,
    post: async (url, body) => (await call('POST', url, body)).data,
    /**
     * Every page of a list endpoint (an array, or the array under `key`), and whether that is
     * all of it: { items, complete, reason }. Never throws; an error, a page that isn't a list,
     * a next page past `max`, or a total_count that doesn't match is incomplete.
     */
    async list(url, key, max = 30) {
      const items = [];
      let next = url;
      let total = null;
      try {
        for (let i = 0; next && i < max; i++) {
          const { data, link } = await call('GET', next);
          const page = key ? data?.[key] : data;
          if (!Array.isArray(page)) return { items, complete: false, reason: `${url}: a page wasn't a list` };
          if (key && Number.isInteger(data.total_count)) total = data.total_count;
          items.push(...page);
          next = nextLink(link);
        }
      } catch (e) {
        return { items, complete: false, reason: e.message };
      }
      if (next) return { items, complete: false, reason: `${url}: more than ${max} pages` };
      if (total !== null && total !== items.length) return { items, complete: false, reason: `${url}: ${items.length} of ${total} items` };
      return { items, complete: true, reason: null };
    },
    /** Every page of a list endpoint (an array, or the array under `key`). */
    async all(url, key, max = 30) {
      const out = [];
      let next = url;
      for (let i = 0; next && i < max; i++) {
        const { data, link } = await call('GET', next);
        out.push(...(key ? data[key] : data));
        next = nextLink(link);
      }
      return out;
    },
  };
}

/**
 * A whole list from `gh`: { items, complete, reason }. githubClient's list() says whether it got
 * every page; a client with only all() (a test double) is taken at its word.
 */
async function listAll(gh, url, key, max) {
  if (gh.list) return gh.list(url, key, max);
  return { items: await gh.all(url, key, max), complete: true, reason: null };
}

/** Fetch every fact decideStatus needs, fresh. */
export async function gather(gh, { repository, sha, prNumber, baseConfig, workflowPath = WORKFLOW_PATH }) {
  const repo = `/repos/${repository}`;
  const facts = { event_sha: sha, repository, ci_globs: workflowFiles(baseConfig), workflow_approver: baseConfig?.ci?.workflow_approver || 'independent', pr: null, base_sha: null, changed_files: null, head_prs: [], incomplete: [], files: [], runs: [], label_events: [] };
  const need = (r) => {
    if (!r.complete) facts.incomplete.push(r.reason || 'a list was cut short');
    return r.items;
  };
  // Every open pull request, to find the one with this head (workflow_run's pull_requests is
  // empty for forks) and to see whether more than one has it.
  const open = need(await listAll(gh, `${repo}/pulls?state=open&per_page=100`));
  let number = prNumber;
  if (!number) number = open.filter((p) => p.head?.sha === sha).map((p) => p.number).sort((a, b) => a - b)[0] || null;
  if (!number) return facts;
  const pr = await gh.get(`${repo}/pulls/${number}`);
  facts.pr = { number: pr.number, state: pr.state, head_sha: pr.head.sha, labels: (pr.labels || []).map((l) => l.name), author: pr.user?.login || null };
  facts.base_sha = pr.base?.sha || null;
  facts.changed_files = pr.changed_files ?? null;
  const head = pr.head.sha;
  facts.head_prs = open.filter((p) => p.state !== 'closed' && p.head?.sha === head).map((p) => p.number);
  const wf = await gh.get(`${repo}/actions/workflows/${encodeURIComponent(workflowPath.split('/').pop())}`);
  if (wf.path !== workflowPath) throw new Error(`the workflow ${workflowPath} was not found (GitHub has ${wf.path})`);
  facts.workflow = { id: wf.id, path: wf.path };
  facts.files = need(await listAll(gh, `${repo}/pulls/${pr.number}/files?per_page=100`)).map((f) => ({ filename: f.filename, previous_filename: f.previous_filename }));
  const runs = need(await listAll(gh, `${repo}/actions/workflows/${wf.id}/runs?head_sha=${head}&per_page=100`, 'workflow_runs', 5));
  for (const r of runs) {
    const run = { id: r.id, workflow_id: r.workflow_id, path: r.path, event: r.event, head_sha: r.head_sha, repository: r.repository?.full_name, status: r.status, conclusion: r.conclusion, created_at: r.created_at, run_started_at: r.run_started_at, run_attempt: r.run_attempt, html_url: r.html_url, job: null };
    // Jobs of runs still underway too: a verify job already skipped (an ignored label event)
    // shows the run says nothing. A job list cut short leaves the job unknown, never guessed.
    const jobs = await listAll(gh, `${repo}/actions/runs/${r.id}/jobs?per_page=100`, 'jobs', 3);
    const job = jobs.complete ? jobs.items.find((j) => j.name === VERIFY_JOB) : null;
    run.job = job ? { status: job.status, conclusion: job.conclusion, steps: (job.steps || []).map((s) => ({ name: s.name, conclusion: s.conclusion })) } : null;
    facts.runs.push(run);
  }
  // Who applied each approval label now on the pull request (approvals are checked by who gave
  // them, decideStatus). Only fetched when one is on.
  const approvalLabels = new Set([APPROVE_WORKFLOW_LABEL, ...Object.values(APPROVAL_MARKERS)]);
  facts.label_events_complete = true;
  if (facts.pr.labels.some((l) => approvalLabels.has(l))) {
    const listed = await listAll(gh, `${repo}/issues/${pr.number}/events?per_page=100`);
    facts.label_events_complete = listed.complete;
    const permissions = new Map();
    for (const e of listed.items.filter((x) => x.event === 'labeled' && approvalLabels.has(x.label?.name))) {
      const login = e.actor?.login;
      if (login && !permissions.has(login)) {
        let permission = null;
        try {
          permission = (await gh.get(`${repo}/collaborators/${encodeURIComponent(login)}/permission`)).permission;
        } catch { /* unknown permission never approves */ }
        permissions.set(login, permission);
      }
      facts.label_events.push({ label: e.label.name, actor: login, permission: permissions.get(login) ?? null, created_at: e.created_at });
    }
  }
  if (facts.pr.labels.some((l) => CARRYABLE.includes(l))) facts.carry = await gatherCarry(gh, repo, head, facts.workflow);
  return facts;
}

/**
 * What carriedOver() needs, when the head is a merge commit: its parents, the files the merge
 * changed (first parent to head), the files the pull request changes against the merged-in
 * parent, the files the approved head changed, and the previous head's runs. Every list must be whole, or nothing carries.
 */
async function gatherCarry(gh, repo, head, workflow) {
  const commit = await gh.get(`${repo}/commits/${head}`);
  const parents = (commit.parents || []).map((p) => p.sha);
  if (parents.length !== 2) return null;
  const [from, merged] = parents;
  const carry = { from_sha: from, merged_sha: merged, complete: true, reason: null, merge_files: [], pr_files: [], approved_files: [], runs: [] };
  const filesOf = async (a, b) => {
    const cmp = await gh.get(`${repo}/compare/${a}...${b}`);
    const files = (cmp.files || []).flatMap((f) => [f.filename, f.previous_filename].filter(Boolean));
    if ((cmp.files || []).length >= COMPARE_FILES_CAP) { carry.complete = false; carry.reason = 'a file list was cut short'; }
    return files;
  };
  carry.merge_files = await filesOf(from, head);
  carry.pr_files = await filesOf(merged, head);
  // What the approved head changed against its merge base with the base branch (three dots).
  carry.approved_files = await filesOf(merged, from);
  const runs = await listAll(gh, `${repo}/actions/workflows/${workflow.id}/runs?head_sha=${from}&per_page=100`, 'workflow_runs', 5);
  if (!runs.complete) { carry.complete = false; carry.reason = runs.reason || 'a list was cut short'; }
  for (const r of runs.items.filter((x) => x.event === 'pull_request' && x.path === workflow.path)) {
    const jobs = await listAll(gh, `${repo}/actions/runs/${r.id}/jobs?per_page=100`, 'jobs', 3);
    const job = jobs.complete ? jobs.items.find((j) => j.name === VERIFY_JOB) : null;
    carry.runs.push({ head_sha: r.head_sha, created_at: r.created_at, job: job ? { steps: (job.steps || []).map((st) => ({ name: st.name, conclusion: st.conclusion })) } : null });
  }
  return carry;
}

/**
 * Decide, re-check the head right before writing, then write the status (unless dryRun). When
 * the newest run's steps aren't readable yet, fetch again a few times before settling on pending.
 */
export async function reportStatus(gh, { repository, sha, prNumber, baseConfig, workflowPath = WORKFLOW_PATH, dryRun = false, retries = 3, waitMs = 10_000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  let facts;
  let decision;
  try {
    facts = await gather(gh, { repository, sha, prNumber, baseConfig, workflowPath });
    decision = decideStatus(facts);
    for (let i = 0; i < retries && decision.unreadable; i++) {
      await sleep(waitMs);
      facts = await gather(gh, { repository, sha, prNumber, baseConfig, workflowPath });
      decision = decideStatus(facts);
    }
  } catch (e) {
    // GitHub failed us (an error, a rate limit): an older status may now be wrong, so try to
    // hold the commit at pending, then fail the job so the error is seen.
    if (!dryRun && sha) {
      try {
        await gh.post(`/repos/${repository}/statuses/${sha}`, { state: 'pending', context: STATUS_CONTEXT, description: TEXT.incomplete.slice(0, 140) });
      } catch { /* the original error is the one to report */ }
    }
    throw e;
  }
  if (!decision.write || dryRun) return { decision, written: false };
  // The pull request can change while this runs. A moved head: the old head's status no longer
  // matters, write nothing. Anything else this decision rested on (base, labels, another open
  // pull request on the same head): never write green, and replace whatever is there with
  // pending, so an older green can't stand on stale evidence. The event that changed it runs
  // the reporter again, after this one (same concurrency group).
  if (facts.pr) {
    const now = await gh.get(`/repos/${repository}/pulls/${facts.pr.number}`);
    if (now.head?.sha !== decision.sha || now.state !== 'open') return { decision: { write: false, reason: `pull request #${facts.pr.number} changed while deciding` }, written: false };
    // Only approval labels decide anything; another label changing doesn't make this stale (and
    // the workflow skips the reporter for such label events, so nothing would correct it).
    const approvalLabels = new Set([APPROVE_WORKFLOW_LABEL, ...Object.values(APPROVAL_MARKERS)]);
    const labelsNow = (now.labels || []).map((l) => l.name).filter((l) => approvalLabels.has(l)).sort().join('\n');
    const changed = [];
    if ((now.base?.sha || null) !== facts.base_sha) changed.push('its base moved');
    if (labelsNow !== facts.pr.labels.filter((l) => approvalLabels.has(l)).sort().join('\n')) changed.push('its approval labels changed');
    if (decision.state === 'success' && !changed.length) {
      const open = await listAll(gh, `/repos/${repository}/pulls?state=open&per_page=100`);
      const sharing = open.items.filter((p) => p.head?.sha === decision.sha).map((p) => p.number);
      if (!open.complete || sharing.length !== 1 || sharing[0] !== facts.pr.number) changed.push('another open pull request may share its head');
    }
    if (changed.length) {
      decision = { write: true, sha: decision.sha, state: 'pending', description: TEXT.stale, target_url: null, reason: `pull request #${facts.pr.number} changed while deciding: ${changed.join('; ')}` };
    }
  }
  await gh.post(`/repos/${repository}/statuses/${decision.sha}`, {
    state: decision.state, context: STATUS_CONTEXT, description: decision.description.slice(0, 140), ...(decision.target_url ? { target_url: decision.target_url } : {}),
  });
  return { decision, written: true };
}
