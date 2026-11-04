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

export const TEXT = Object.freeze({
  verified: 'Verified: required checks passed on this code.',
  waiting: "Waiting for a maintainer's approval. See the verify run for what's needed.",
  inconclusive: "Inconclusive: a check didn't finish. Re-run it, or a maintainer approves.",
  failed: 'Not verified: see the verify run.',
  pending: 'Waiting for verify.',
  workflow: 'CI workflow changed: a maintainer reviews it and adds pocp-approve-workflow.',
  approvalGone: 'An approval this result relied on was removed: approve again.',
});

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
  return `job ${job.status || '?'}/${job.conclusion || '?'}: ${['verify', 'waiting', 'inconclusive', 'failed'].map((n) => `${n}=${stepOf(job, n)?.conclusion ?? 'missing'}`).join(' ')}`;
}

/**
 * What one completed run of the trusted workflow says, from its verify job's steps alone.
 * Returns { outcome: verified|waiting|inconclusive|failed|unreadable, approvals: [labels] }.
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
  const keySteps = [verify, failed, waiting, inconclusive];
  if (!job || (job.status && job.status !== 'completed') || !job.conclusion || keySteps.some((st) => !st || !st.conclusion)) return { outcome: 'unreadable', approvals };
  if (verify.conclusion !== 'success') return { outcome: 'failed', approvals };
  if (ran(failed)) return { outcome: 'failed', approvals };
  if (ran(waiting) && !ran(inconclusive)) return { outcome: 'waiting', approvals };
  if (ran(inconclusive) && !ran(waiting)) return { outcome: 'inconclusive', approvals };
  if (!ran(waiting) && !ran(inconclusive) && job.conclusion === 'success') return { outcome: 'verified', approvals };
  return { outcome: 'failed', approvals };
}

/**
 * The status for a pull request's current head. Pure: everything comes from `facts`, which
 * gather() fetches. Returns { write: false, reason } when nothing should be written, else
 * { write: true, sha, state, description, target_url, reason }.
 *
 * facts: {
 *   event_sha,                     the head the triggering event was about
 *   pr: { number, state, head_sha, labels: [names], author } | null,
 *   workflow_approver,             "independent" (default: not the author) or "any-writer"
 *   workflow: { id, path },        the trusted workflow, by path on the default branch
 *   repository,                    "owner/name"
 *   files: [{ filename, previous_filename }],  the pull request's diff from its merge base
 *   ci_globs,                      workflowFiles(base config)
 *   runs: [{ id, workflow_id, path, event, head_sha, repository, status, conclusion, created_at, run_attempt, html_url, job }],
 *   label_events: [{ label, actor, permission, created_at }],  "labeled" events, newest last
 * }
 */
export function decideStatus(facts) {
  const { pr } = facts;
  if (!pr) return { write: false, reason: `no open pull request has head ${short(facts.event_sha)}` };
  if (pr.state !== 'open') return { write: false, reason: `pull request #${pr.number} is ${pr.state}` };
  if (facts.event_sha && pr.head_sha !== facts.event_sha) {
    return { write: false, reason: `pull request #${pr.number} moved to ${short(pr.head_sha)}; ${short(facts.event_sha)} is no longer its head` };
  }
  const sha = pr.head_sha;
  const status = (state, description, reason, run) => ({ write: true, sha, state, description, target_url: run?.html_url || null, reason });

  // Only runs of the trusted workflow, for this repository's pull_request event, on this head.
  const runs = (facts.runs || [])
    .filter((r) => r.workflow_id === facts.workflow.id && r.path === facts.workflow.path)
    .filter((r) => r.event === 'pull_request' && r.repository === facts.repository && r.head_sha === sha)
    .filter((r) => r.status === 'completed' && r.conclusion !== 'cancelled' && r.conclusion !== 'skipped')
    // A run whose verify job was skipped (a label event the workflow ignores) says nothing.
    .filter((r) => r.job && r.job.conclusion !== 'skipped' && r.job.conclusion !== 'cancelled')
    .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)) || (a.run_attempt || 1) - (b.run_attempt || 1) || a.id - b.id);
  const newest = runs.at(-1) || null;

  const changed = changedWorkflowFiles(facts.files, facts.ci_globs || workflowFiles(null));
  let via = '';
  if (changed.length) {
    // The run's steps come from the pull request's own workflow: not evidence until a
    // maintainer has reviewed that workflow. pocp-approve-workflow approves only the workflow
    // change: after it, the run is judged by every rule below, exactly like any other run, so
    // anything else it still waits for (tests, policy, a check that didn't finish) stays pending.
    const firstRunAt = (facts.runs || []).filter((r) => r.head_sha === sha).map((r) => String(r.created_at)).sort()[0] || null;
    const independent = (facts.workflow_approver || 'independent') === 'independent';
    const approved = pr.labels.includes(APPROVE_WORKFLOW_LABEL) && (facts.label_events || []).some((e) => e.label === APPROVE_WORKFLOW_LABEL
      && WRITE_PERMISSIONS.has(e.permission) && firstRunAt && String(e.created_at) > firstRunAt
      && (!independent || (e.actor && pr.author && e.actor !== pr.author)));
    if (!approved) {
      return status('pending', TEXT.workflow, `CI files changed (${changed.join(', ')}), so the run's results aren't trusted until ${independent ? 'a writer other than the author' : 'a writer'} adds ${APPROVE_WORKFLOW_LABEL} after this head's first run`, newest);
    }
    via = `; CI files changed (${changed.join(', ')}), workflow approved with ${APPROVE_WORKFLOW_LABEL}`;
  }

  if (!newest) return status('pending', TEXT.pending, `no completed run of ${facts.workflow.path} for ${short(sha)} yet`, null);
  const { outcome, approvals } = readRun(newest.job);
  if (outcome === 'unreadable') return { ...status('pending', TEXT.pending, `run ${newest.id}'s steps aren't readable yet (${stepSummary(newest.job)})${via}`, newest), unreadable: true };
  if (outcome === 'verified') {
    const gone = approvals.filter((l) => !pr.labels.includes(l));
    if (gone.length) return status('pending', TEXT.approvalGone, `run ${newest.id} relied on ${gone.join(', ')}, which is no longer on the pull request${via}`, newest);
    return status('success', TEXT.verified, `run ${newest.id} verified${approvals.length ? ` with ${approvals.join(', ')}` : ''}${via}`, newest);
  }
  if (outcome === 'failed') return status('failure', TEXT.failed, `run ${newest.id} failed (${stepSummary(newest.job)})${via}`, newest);
  return status('pending', TEXT[outcome], `run ${newest.id} is ${outcome}${via}`, newest);
}

const short = (sha) => (sha ? String(sha).slice(0, 12) : '(none)');

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

/** Fetch every fact decideStatus needs, fresh. */
export async function gather(gh, { repository, sha, prNumber, baseConfig, workflowPath = WORKFLOW_PATH }) {
  const repo = `/repos/${repository}`;
  let pr = null;
  if (prNumber) pr = await gh.get(`${repo}/pulls/${prNumber}`);
  else {
    // workflow_run's pull_requests is empty for forks, so find the PR by its head.
    const open = await gh.all(`${repo}/pulls?state=open&per_page=100`);
    pr = open.find((p) => p.head?.sha === sha) || null;
  }
  const facts = { event_sha: sha, repository, ci_globs: workflowFiles(baseConfig), workflow_approver: baseConfig?.ci?.workflow_approver || 'independent', pr: null, files: [], runs: [], label_events: [] };
  if (!pr) return facts;
  facts.pr = { number: pr.number, state: pr.state, head_sha: pr.head.sha, labels: (pr.labels || []).map((l) => l.name), author: pr.user?.login || null };
  facts.workflow_approver = baseConfig?.ci?.workflow_approver || 'independent';
  const head = pr.head.sha;
  const wf = await gh.get(`${repo}/actions/workflows/${encodeURIComponent(workflowPath.split('/').pop())}`);
  if (wf.path !== workflowPath) throw new Error(`the workflow ${workflowPath} was not found (GitHub has ${wf.path})`);
  facts.workflow = { id: wf.id, path: wf.path };
  facts.files = (await gh.all(`${repo}/pulls/${pr.number}/files?per_page=100`)).map((f) => ({ filename: f.filename, previous_filename: f.previous_filename }));
  const runs = await gh.all(`${repo}/actions/workflows/${wf.id}/runs?head_sha=${head}&per_page=100`, 'workflow_runs', 5);
  for (const r of runs) {
    const run = { id: r.id, workflow_id: r.workflow_id, path: r.path, event: r.event, head_sha: r.head_sha, repository: r.repository?.full_name, status: r.status, conclusion: r.conclusion, created_at: r.created_at, run_attempt: r.run_attempt, html_url: r.html_url, job: null };
    if (r.status === 'completed') {
      const jobs = await gh.all(`${repo}/actions/runs/${r.id}/jobs?per_page=100`, 'jobs', 3);
      const job = jobs.find((j) => j.name === VERIFY_JOB);
      run.job = job ? { status: job.status, conclusion: job.conclusion, steps: (job.steps || []).map((s) => ({ name: s.name, conclusion: s.conclusion })) } : null;
    }
    facts.runs.push(run);
  }
  if (facts.files.length && changedWorkflowFiles(facts.files, facts.ci_globs).length && facts.pr.labels.includes(APPROVE_WORKFLOW_LABEL)) {
    const events = await gh.all(`${repo}/issues/${pr.number}/events?per_page=100`);
    for (const e of events.filter((x) => x.event === 'labeled' && x.label?.name === APPROVE_WORKFLOW_LABEL)) {
      let permission = null;
      try {
        permission = (await gh.get(`${repo}/collaborators/${encodeURIComponent(e.actor.login)}/permission`)).permission;
      } catch { /* unknown permission never approves */ }
      facts.label_events.push({ label: e.label.name, actor: e.actor?.login, permission, created_at: e.created_at });
    }
  }
  return facts;
}

/**
 * Decide, re-check the head right before writing, then write the status (unless dryRun). When
 * the newest run's steps aren't readable yet, fetch again a few times before settling on pending.
 */
export async function reportStatus(gh, { repository, sha, prNumber, baseConfig, workflowPath = WORKFLOW_PATH, dryRun = false, retries = 3, waitMs = 10_000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  let facts = await gather(gh, { repository, sha, prNumber, baseConfig, workflowPath });
  let decision = decideStatus(facts);
  for (let i = 0; i < retries && decision.unreadable; i++) {
    await sleep(waitMs);
    facts = await gather(gh, { repository, sha, prNumber, baseConfig, workflowPath });
    decision = decideStatus(facts);
  }
  if (!decision.write || dryRun) return { decision, written: false };
  // The head can move while this runs: never write a status for a head that is no longer current.
  const now = await gh.get(`/repos/${repository}/pulls/${facts.pr.number}`);
  if (now.head.sha !== decision.sha || now.state !== 'open') return { decision: { write: false, reason: `pull request #${facts.pr.number} changed while deciding` }, written: false };
  await gh.post(`/repos/${repository}/statuses/${decision.sha}`, {
    state: decision.state, context: STATUS_CONTEXT, description: decision.description.slice(0, 140), ...(decision.target_url ? { target_url: decision.target_url } : {}),
  });
  return { decision, written: true };
}
