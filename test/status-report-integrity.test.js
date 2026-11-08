// The trusted reporter never says "success" on data it can't vouch for: a pull request file list
// that may be cut short, a run that evaluated another pull request or base, a newer run or
// attempt that hasn't finished, a head commit shared by several open pull requests, or a head
// or base that moved while it decided. Each case runs the real client, gather and decide over a
// fake GitHub API; an honest pull request still gets its green.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decideStatus, FILES_CAP, gather, githubClient, readRun, reportStatus, runIdentity, runMarker, TEXT, workflowFiles } from '../src/status-report.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHA = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const OTHER_BASE = 'c'.repeat(40);
const WF = { id: 11, path: '.github/workflows/pocp.yml' };

const verifySteps = ({ pr = 7, base = BASE, failed = false, marker = true } = {}) => [
  { name: 'Set up job', conclusion: 'success' },
  ...(marker ? [{ name: runMarker(pr, base), conclusion: 'success' }] : []),
  { name: 'verify', conclusion: 'success' },
  { name: 'verified', conclusion: failed ? 'skipped' : 'success' },
  { name: 'waiting', conclusion: 'skipped' },
  { name: 'inconclusive', conclusion: 'skipped' },
  { name: 'failed', conclusion: failed ? 'failure' : 'skipped' },
];
const verifyJob = (opts = {}) => ({ name: 'verify', status: 'completed', conclusion: opts.failed ? 'failure' : 'success', steps: verifySteps(opts) });
const apiRun = (over = {}) => ({
  id: 100, workflow_id: WF.id, path: WF.path, event: 'pull_request', head_sha: SHA, repository: { full_name: 'o/r' },
  status: 'completed', conclusion: 'success', created_at: '2026-11-07T10:00:00Z', run_started_at: '2026-11-07T10:00:00Z', run_attempt: 1,
  html_url: 'https://github.com/o/r/actions/runs/100', ...over,
});

/**
 * A fake GitHub REST API behind fetch, paging like GitHub (Link rel="next", per_page 100) and
 * capping the pull request file list at 3000. `pr` may be a function of how many times the
 * pull request was read, to move its head or base between deciding and writing.
 */
function fakeGitHub({ fileCount = 1, files, changedFiles = 'same', pr = {}, openPrs, runs = [apiRun()], jobs = { 100: [verifyJob()] }, fail = {}, runsTotal } = {}) {
  const allFiles = files || Array.from({ length: fileCount }, (_, i) => ({ filename: `src/f${String(i).padStart(5, '0')}.js` }));
  let prReads = 0;
  const prNow = () => {
    prReads++;
    const p = typeof pr === 'function' ? pr(prReads) : pr;
    const out = { number: 7, state: 'open', head: { sha: SHA }, base: { sha: BASE }, labels: [], user: { login: 'author' }, changed_files: changedFiles === 'same' ? allFiles.length : changedFiles, ...p };
    if (out.changed_files === 'omit') delete out.changed_files;
    return out;
  };
  const open = openPrs || [{ number: 7, state: 'open', head: { sha: SHA } }];
  const posted = [];
  const page = (items, url, cap = Infinity) => {
    const u = new URL(url);
    const per = Number(u.searchParams.get('per_page') || 30);
    const n = Number(u.searchParams.get('page') || 1);
    const capped = items.slice(0, cap);
    const slice = capped.slice((n - 1) * per, n * per);
    let link = '';
    if (n * per < capped.length) {
      u.searchParams.set('page', String(n + 1));
      link = `<${u.toString()}>; rel="next"`;
    }
    return { slice, link };
  };
  const reply = (status, body, link = '') => ({ ok: status >= 200 && status < 300, status, text: async () => (body === undefined ? '' : JSON.stringify(body)), headers: { get: (h) => (h.toLowerCase() === 'link' ? link : null) } });
  async function fetchImpl(url, { method, body }) {
    const u = new URL(url);
    const p = u.pathname;
    for (const [frag, status] of Object.entries(fail)) if (url.includes(frag)) return reply(status, { message: status === 403 ? 'API rate limit exceeded' : 'Server Error' });
    if (method === 'POST' && /\/statuses\//.test(p)) {
      posted.push({ sha: p.split('/').pop(), ...JSON.parse(body) });
      return reply(201, {});
    }
    if (p === '/repos/o/r/pulls' && u.searchParams.get('state') === 'open') {
      const { slice, link } = page(open, url);
      return reply(200, slice, link);
    }
    if (p === '/repos/o/r/pulls/7') return reply(200, prNow());
    if (/^\/repos\/o\/r\/pulls\/\d+$/.test(p)) {
      const n = Number(p.split('/').pop());
      const o = open.find((x) => x.number === n);
      return reply(200, { number: n, state: 'open', head: o.head, base: { sha: OTHER_BASE }, labels: [], changed_files: 1 });
    }
    if (p === '/repos/o/r/pulls/7/files') {
      const { slice, link } = page(allFiles, url, FILES_CAP);
      return reply(200, slice, link);
    }
    if (p === '/repos/o/r/actions/workflows/pocp.yml') return reply(200, WF);
    if (p === `/repos/o/r/actions/workflows/${WF.id}/runs`) {
      const { slice, link } = page(runs, url);
      return reply(200, { total_count: runsTotal ?? runs.length, workflow_runs: slice }, link);
    }
    const jm = /^\/repos\/o\/r\/actions\/runs\/(\d+)\/jobs$/.exec(p);
    if (jm) {
      const list = jobs[jm[1]] || [];
      return reply(200, { total_count: list.length, jobs: list });
    }
    if (p === '/repos/o/r/issues/7/events') return reply(200, []);
    return reply(404, { message: `unexpected ${method} ${url}` });
  }
  const gh = githubClient({ token: 't', api: 'https://api.test', fetchImpl });
  return { gh, posted, prReads: () => prReads };
}

const report = (api, over = {}) => reportStatus(api.gh, { repository: 'o/r', sha: SHA, prNumber: 7, baseConfig: null, sleep: async () => {}, waitMs: 0, ...over });
const notGreen = (r, label) => {
  assert.notEqual(r.decision.state, 'success', `${label}: ${r.decision.reason}`);
};

test('honest pull request: complete data, the run for this pull request and base, one PR on the head → green', async () => {
  const api = fakeGitHub();
  const r = await report(api);
  assert.equal(r.decision.state, 'success', r.decision.reason);
  assert.equal(r.written, true);
  assert.deepEqual(api.posted.map((p) => p.state), ['success']);
});

test('file list: 2999 files is complete; 3000 (GitHub\'s cap) and 3001 are not, and never green', async () => {
  const ok = await report(fakeGitHub({ fileCount: 2999 }));
  assert.equal(ok.decision.state, 'success', ok.decision.reason);
  for (const fileCount of [3000, 3001]) {
    const api = fakeGitHub({ fileCount });
    const r = await report(api);
    notGreen(r, `${fileCount} files`);
    assert.equal(r.decision.description, TEXT.incomplete);
    assert.deepEqual(api.posted.map((p) => p.state), ['pending']);
  }
});

test('file list: a workflow edit sorted past file 3000 is not hidden, even with pocp-approve-workflow on', async () => {
  // 3000 files that sort before .github, then the edited workflow: GitHub returns only the 3000.
  const files = [...Array.from({ length: 3000 }, (_, i) => ({ filename: `-pad/${i}` })), { filename: '.github/workflows/pocp.yml' }];
  for (const labels of [[], [{ name: 'pocp-approve-workflow' }]]) {
    const r = await report(fakeGitHub({ files, pr: { labels } }));
    notGreen(r, `labels ${JSON.stringify(labels)}`);
    assert.equal(r.decision.description, TEXT.incomplete);
  }
});

test('file list: a missing, wrong or non-numeric changed_files count is never green', async () => {
  for (const changedFiles of ['omit', null, 2, 0, '1', -1]) {
    const r = await report(fakeGitHub({ changedFiles }));
    notGreen(r, `changed_files ${JSON.stringify(changedFiles)}`);
    assert.equal(r.decision.description, TEXT.incomplete);
  }
  // A list that repeats a file isn't a list of the changed files.
  const dup = decideStatus(facts({ files: [{ filename: 'src/a.js' }, { filename: 'src/a.js' }], changed_files: 2 }));
  assert.equal(dup.state, 'pending');
});

test('pagination: cut short (pages past the limit, an API error, a rate limit, a total that doesn\'t match) is incomplete', async () => {
  const api = fakeGitHub();
  // 4 runs, 1 per page, but only 2 pages allowed.
  const many = fakeGitHub({ runs: [1, 2, 3, 4].map((i) => apiRun({ id: i })) });
  const cut = await many.gh.list('/repos/o/r/actions/workflows/11/runs?head_sha=x&per_page=1', 'workflow_runs', 2);
  assert.equal(cut.complete, false);
  assert.equal(cut.items.length, 2);
  assert.match(cut.reason, /more than 2 pages/);
  const whole = await api.gh.list('/repos/o/r/pulls/7/files?per_page=100');
  assert.equal(whole.complete, true);
  const err = await fakeGitHub({ fail: { '/files': 500 } }).gh.list('/repos/o/r/pulls/7/files?per_page=100');
  assert.equal(err.complete, false);
  assert.match(err.reason, /500/);
  const limited = await fakeGitHub({ fail: { '/files': 403 } }).gh.list('/repos/o/r/pulls/7/files?per_page=100');
  assert.equal(limited.complete, false);
  assert.match(limited.reason, /rate limit/);
  const total = await fakeGitHub({ runsTotal: 5 }).gh.list('/repos/o/r/actions/workflows/11/runs?per_page=100', 'workflow_runs', 5);
  assert.equal(total.complete, false);
});

test('pagination: a truncated run list, file list, open pull request list or job list never turns green', async () => {
  for (const [label, api] of [
    ['runs total mismatch', fakeGitHub({ runsTotal: 2 })],
    ['files API error', fakeGitHub({ fail: { '/pulls/7/files': 500 } })],
    ['files rate limited', fakeGitHub({ fail: { '/pulls/7/files': 403 } })],
    ['open PRs API error', fakeGitHub({ fail: { 'state=open': 502 } })],
    ['jobs API error', fakeGitHub({ fail: { '/jobs': 500 } })],
  ]) {
    const r = await report(api);
    notGreen(r, label);
    assert.ok(!api.posted.some((p) => p.state === 'success'), label);
  }
});

test('API error outside a list: nothing green, the commit is held at pending, and the error is reported', async () => {
  const api = fakeGitHub({ fail: { '/actions/workflows/pocp.yml': 500 } });
  await assert.rejects(report(api), /500/);
  assert.deepEqual(api.posted.map((p) => p.state), ['pending']);
  assert.equal(api.posted[0].description, TEXT.incomplete);
  // A rate limit on the pull request itself, too.
  const limited = fakeGitHub({ fail: { '/repos/o/r/pulls/7?': 403, 'pulls/7': 403 } });
  await assert.rejects(report(limited), /rate limit/);
  assert.ok(!limited.posted.some((p) => p.state === 'success'));
});

test('run identity: a run that evaluated another pull request or another base is not evidence', async () => {
  // The audit's cross-PR case: this PR's own run failed, another PR's run on the same head passed.
  const runs = [apiRun({ id: 100, created_at: '2026-11-07T10:00:00Z', run_started_at: '2026-11-07T10:00:00Z' }), apiRun({ id: 101, created_at: '2026-11-07T10:05:00Z', run_started_at: '2026-11-07T10:05:00Z' })];
  for (const [label, other] of [['another PR', verifyJob({ pr: 8 })], ['another base', verifyJob({ base: OTHER_BASE })]]) {
    const r = await report(fakeGitHub({ runs, jobs: { 100: [verifyJob({ failed: true })], 101: [other] } }));
    assert.equal(r.decision.state, 'failure', `${label}: ${r.decision.reason}`);
    // And with no run of its own at all, the other run still doesn't count.
    const alone = await report(fakeGitHub({ runs: [runs[1]], jobs: { 101: [other] } }));
    notGreen(alone, label);
    assert.equal(alone.decision.description, TEXT.pending, label);
  }
  // A newer run that doesn't say which pull request it evaluated (an older workflow, or a run
  // that stopped before its marker) is not skipped for an older result: it holds the status.
  const r = await report(fakeGitHub({ runs, jobs: { 100: [verifyJob({ failed: true })], 101: [verifyJob({ marker: false })] } }));
  assert.equal(r.decision.state, 'pending', r.decision.reason);
  assert.equal(r.decision.description, TEXT.unidentified);
  // The pull request's base moved since its run: that run was for the old base.
  const moved = await report(fakeGitHub({ pr: { base: { sha: OTHER_BASE } } }));
  notGreen(moved, 'base moved since the run');
});

test('run identity: two markers, a marker without a result, or a failed marker step never match', () => {
  const m = runMarker(7, BASE);
  assert.equal(runIdentity({ steps: [{ name: m, conclusion: 'success' }] }, 7, BASE), 'match');
  // Only one marker naming something else is "other" (skippable); every other doubt is unknown.
  assert.equal(runIdentity({ steps: [{ name: runMarker(8, BASE), conclusion: 'success' }] }, 7, BASE), 'other');
  assert.equal(runIdentity({ steps: [{ name: m, conclusion: 'success' }, { name: runMarker(8, BASE), conclusion: 'success' }] }, 7, BASE), 'unknown');
  assert.equal(runIdentity({ steps: [{ name: m, conclusion: 'success' }, { name: m, conclusion: 'success' }] }, 7, BASE), 'unknown');
  assert.equal(runIdentity({ steps: [{ name: m, conclusion: null }] }, 7, BASE), 'unknown');
  assert.equal(runIdentity({ steps: [{ name: m, conclusion: 'failure' }] }, 7, BASE), 'unknown');
  assert.equal(runIdentity({ steps: [{ name: 'Set up job', conclusion: 'failure' }] }, 7, BASE), 'unknown', 'failed before the marker');
  assert.equal(runIdentity({ steps: [] }, 7, BASE), 'unknown');
  assert.equal(runIdentity(null, 7, BASE), 'unknown');
  assert.equal(runIdentity({ steps: [{ name: m, conclusion: 'success' }] }, 7, null), 'other', 'no base is never a match');
});

test('latest attempt: a newer queued, running, failed or cancelled run or attempt keeps an older success from winning', async () => {
  const old = apiRun({ id: 100, created_at: '2026-11-07T10:00:00Z', run_started_at: '2026-11-07T10:00:00Z' });
  const cases = [
    ['newer run in progress', [old, apiRun({ id: 101, status: 'in_progress', conclusion: null, created_at: '2026-11-07T10:05:00Z', run_started_at: '2026-11-07T10:05:00Z' })], { 101: [{ name: 'verify', status: 'in_progress', conclusion: null, steps: [] }] }],
    ['newer run queued, no job yet', [old, apiRun({ id: 101, status: 'queued', conclusion: null, created_at: '2026-11-07T10:05:00Z', run_started_at: null })], {}],
    ['re-run attempt of the same run in progress', [apiRun({ id: 100, run_attempt: 2, status: 'in_progress', conclusion: null, run_started_at: '2026-11-07T11:00:00Z' })], { 100: [{ name: 'verify', status: 'in_progress', conclusion: null, steps: [] }] }],
    ['newer run cancelled', [old, apiRun({ id: 101, conclusion: 'cancelled', created_at: '2026-11-07T10:05:00Z', run_started_at: '2026-11-07T10:05:00Z' })], { 101: [{ name: 'verify', status: 'completed', conclusion: 'cancelled', steps: [{ name: runMarker(7, BASE), conclusion: 'success' }] }] }],
    ['newer run cancelled before its steps', [old, apiRun({ id: 101, conclusion: 'cancelled', created_at: '2026-11-07T10:05:00Z', run_started_at: '2026-11-07T10:05:00Z' })], { 101: [] }],
    ['newer run failed', [old, apiRun({ id: 101, conclusion: 'failure', created_at: '2026-11-07T10:05:00Z', run_started_at: '2026-11-07T10:05:00Z' })], { 101: [verifyJob({ failed: true })] }],
    // A re-run keeps its run's created_at: the attempt that started later decides.
    ['older run re-run later and failed', [apiRun({ id: 99, run_attempt: 2, conclusion: 'failure', created_at: '2026-11-07T09:00:00Z', run_started_at: '2026-11-07T11:00:00Z' }), old], { 99: [verifyJob({ failed: true })] }],
  ];
  for (const [label, runs, jobs] of cases) {
    const r = await report(fakeGitHub({ runs, jobs: { 100: [verifyJob()], ...jobs } }));
    notGreen(r, label);
  }
  // An ignored label event's run (verify job skipped) says nothing, finished or not.
  const ignored = apiRun({ id: 101, status: 'in_progress', conclusion: null, created_at: '2026-11-07T10:05:00Z', run_started_at: '2026-11-07T10:05:00Z' });
  const r = await report(fakeGitHub({ runs: [old, ignored], jobs: { 100: [verifyJob()], 101: [{ name: 'verify', status: 'completed', conclusion: 'skipped', steps: [] }] } }));
  assert.equal(r.decision.state, 'success', r.decision.reason);
});

test('shared head: two open pull requests with the same head never get green, by pull request number or by head', async () => {
  const openPrs = [{ number: 7, state: 'open', head: { sha: SHA } }, { number: 8, state: 'open', head: { sha: SHA } }];
  for (const prNumber of [7, null]) {
    const api = fakeGitHub({ openPrs });
    const r = await report(api, { prNumber });
    notGreen(r, `prNumber ${prNumber}`);
    assert.equal(r.decision.state, 'pending');
    assert.equal(r.decision.description, TEXT.sharedHead);
    assert.deepEqual(api.posted.map((p) => p.state), ['pending']);
  }
  // A different head on the other pull request is fine.
  const fine = await report(fakeGitHub({ openPrs: [openPrs[0], { number: 8, state: 'open', head: { sha: 'f'.repeat(40) } }] }));
  assert.equal(fine.decision.state, 'success', fine.decision.reason);
  // The open list doesn't show this pull request at all (lagging or cut short): not green.
  const missing = await report(fakeGitHub({ openPrs: [] }));
  notGreen(missing, 'PR missing from the open list');
  // The open list is longer than the pages read: the other PR with this head may be past them.
  const many = Array.from({ length: 3050 }, (_, i) => ({ number: 1000 + i, state: 'open', head: { sha: 'f'.repeat(40) } }));
  const long = await report(fakeGitHub({ openPrs: [openPrs[0], ...many] }));
  notGreen(long, 'open list past the page limit');
});

test('head or base moved right before writing: no green is written, and a moved base replaces an older green', async () => {
  const headMoved = fakeGitHub({ pr: (n) => (n === 1 ? {} : { head: { sha: 'd'.repeat(40) } }) });
  const r1 = await report(headMoved);
  assert.equal(r1.written, false);
  assert.match(r1.decision.reason, /changed while deciding/);
  assert.deepEqual(headMoved.posted, []);
  // Base moved: an older green on this head must not stand, so pending is written over it.
  const baseMoved = fakeGitHub({ pr: (n) => (n === 1 ? {} : { base: { sha: OTHER_BASE } }) });
  const r2 = await report(baseMoved);
  assert.equal(r2.written, true);
  assert.match(r2.decision.reason, /base moved/);
  assert.deepEqual(baseMoved.posted.map((x) => [x.sha, x.state, x.description]), [[SHA, 'pending', TEXT.stale]]);
  // The same re-read, unchanged, writes.
  const still = fakeGitHub();
  assert.equal((await report(still)).written, true);
  assert.ok(still.prReads() >= 2, 'the pull request is read again before writing');
});

test('the audit\'s simulated cases no longer yield success', async () => {
  // Same shapes as the assessment's reproduce harness.
  const job = { status: 'completed', conclusion: 'success', steps: ['verify', 'waiting', 'inconclusive', 'failed'].map((name) => ({ name, conclusion: name === 'verify' ? 'success' : 'skipped' })) };
  const run = { id: 10, workflow_id: 11, path: WF.path, event: 'pull_request', head_sha: SHA, repository: 'o/r', status: 'completed', conclusion: 'success', created_at: '2026-11-07T00:00:00Z', job };
  const base = { repository: 'o/r', event_sha: SHA, workflow: WF, ci_globs: workflowFiles(null), pr: { number: 1, head_sha: SHA, base_sha: BASE, state: 'open', labels: [] }, files: [], runs: [run] };
  notGreen({ decision: decideStatus({ ...base, runs: [{ ...run, pull_requests: [{ number: 2, base: { sha: OTHER_BASE } }] }] }) }, 'cross-pr-base');
  notGreen({ decision: decideStatus({ ...base, runs: [run, { ...run, id: 11, created_at: '2026-11-07T00:01:00Z', status: 'in_progress', job: null }] }) }, 'newer-running-run');
  const gh = {
    get: async (url) => (url.includes('/pulls/1') ? { number: 1, state: 'open', changed_files: 3001, head: { sha: SHA }, base: { sha: BASE }, labels: [] } : WF),
    all: async (url) => (url.includes('/files?') ? Array.from({ length: 3000 }, (_, i) => ({ filename: `-pad/${i}` })) : url.includes('/jobs?') ? [{ name: 'verify', ...job }] : url.includes('/runs?') ? [{ ...run, repository: { full_name: 'o/r' } }] : url.includes('state=open') ? [{ number: 1, state: 'open', head: { sha: SHA } }] : []),
  };
  notGreen({ decision: decideStatus(await gather(gh, { repository: 'o/r', sha: SHA, prNumber: 1 })) }, 'truncated-file-list');
});

test('pocp.yml and the example run the identity marker first, named as the reporter expects', () => {
  for (const rel of ['.github/workflows/pocp.yml', 'examples/github/pocp.yml']) {
    const wf = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    const lines = wf.split('\n');
    const stepsAt = lines.findIndex((l) => l.trim() === 'steps:');
    const firstStep = lines.slice(stepsAt + 1).find((l) => /^\s*- /.test(l));
    assert.equal(firstStep.trim(), '- name: pocp-run pr-${{ github.event.pull_request.number }} base-${{ github.event.pull_request.base.sha }}', rel);
    // Rendered by GitHub, that name is exactly runMarker(number, base sha).
    const rendered = firstStep.trim().slice('- name: '.length).replace('${{ github.event.pull_request.number }}', '7').replace('${{ github.event.pull_request.base.sha }}', BASE);
    assert.equal(rendered, runMarker(7, BASE), rel);
  }
});

// decideStatus facts for the pure cases above.
function facts(over = {}) {
  const job = { status: 'completed', conclusion: 'success', steps: verifySteps() };
  return {
    event_sha: SHA, repository: 'o/r', workflow: WF, ci_globs: workflowFiles(null), base_sha: BASE, head_prs: [7], incomplete: [],
    pr: { number: 7, state: 'open', head_sha: SHA, labels: [], author: 'author' },
    files: [{ filename: 'src/a.js' }], changed_files: 1, label_events: [],
    runs: [{ ...apiRun(), repository: 'o/r', job }], ...over,
  };
}

// The `verified` step (workflows from 2026-11 on): green only when it ran, whatever the
// verify step's own conclusion or the forgeable `code` output picked.
const stepJob = (map, conclusion = 'success') => ({ status: 'completed', conclusion, steps: Object.entries(map).map(([name, c]) => ({ name, conclusion: c })) });
test('readRun with a verified step: green only when verified ran', () => {
  const base = { verify: 'success', verified: 'skipped', waiting: 'skipped', inconclusive: 'skipped', failed: 'skipped' };
  assert.equal(readRun(stepJob({ ...base, verified: 'success' })).outcome, 'verified');
  // verify failed (continue-on-error) and a forged code chose no result step: never green.
  assert.equal(readRun(stepJob({ ...base, verify: 'failure' })).outcome, 'failed');
  assert.equal(readRun(stepJob(base)).outcome, 'failed');
  assert.equal(readRun(stepJob({ ...base, verify: 'failure', waiting: 'success' })).outcome, 'waiting');
  assert.equal(readRun(stepJob({ ...base, verify: 'success', inconclusive: 'success' })).outcome, 'inconclusive');
  assert.equal(readRun(stepJob({ ...base, verified: 'success', waiting: 'success' })).outcome, 'failed');
  assert.equal(readRun(stepJob({ ...base, verified: 'success' }, 'failure')).outcome, 'failed');
});

test('newer runs that stopped before their marker never revive an older success', async () => {
  const old = apiRun({ id: 100, created_at: '2026-11-07T10:00:00Z', run_started_at: '2026-11-07T10:00:00Z' });
  const newer = (over) => apiRun({ id: 101, created_at: '2026-11-07T10:05:00Z', run_started_at: '2026-11-07T10:05:00Z', ...over });
  const setupOnly = (conclusion) => [{ name: 'verify', status: 'completed', conclusion, steps: [{ name: 'Set up job', conclusion }] }];
  for (const [label, run, job] of [
    ['setup failed', newer({ conclusion: 'failure' }), setupOnly('failure')],
    ['cancelled with its marker cancelled', newer({ conclusion: 'cancelled' }), [{ name: 'verify', status: 'completed', conclusion: 'cancelled', steps: [{ name: 'Set up job', conclusion: 'success' }, { name: runMarker(7, BASE), conclusion: 'cancelled' }] }]],
    ['marker failed', newer({ conclusion: 'failure' }), [{ name: 'verify', status: 'completed', conclusion: 'failure', steps: [{ name: runMarker(7, BASE), conclusion: 'failure' }] }]],
  ]) {
    const r = await report(fakeGitHub({ runs: [old, run], jobs: { 100: [verifyJob()], 101: job } }));
    notGreen(r, label);
  }
  // Cancelled before any pocp step ran (a queued run the concurrency group cancelled): says nothing.
  const r = await report(fakeGitHub({ runs: [old, newer({ conclusion: 'cancelled' })], jobs: { 100: [verifyJob()], 101: setupOnly('cancelled') } }));
  assert.equal(r.decision.state, 'success', r.decision.reason);
});

test('a run with the marker but without the verified step is never green (outdated workflow)', async () => {
  const steps = verifySteps().filter((st) => st.name !== 'verified');
  const r = await report(fakeGitHub({ jobs: { 100: [{ name: 'verify', status: 'completed', conclusion: 'success', steps }] } }));
  assert.equal(r.decision.state, 'pending', r.decision.reason);
  assert.equal(r.decision.description, TEXT.outdated);
});

test('labels changing, or another pull request taking the head, right before writing: pending replaces green', async () => {
  const labelled = fakeGitHub({ pr: (n) => (n === 1 ? {} : { labels: [{ name: 'pocp-approve-tests' }] }) });
  const r1 = await report(labelled);
  assert.equal(r1.decision.state, 'pending', r1.decision.reason);
  assert.deepEqual(labelled.posted.map((x) => x.state), ['pending']);
  // A second open pull request with the same head shows up only at the final read.
  let openReads = 0;
  const api = fakeGitHub();
  const fetchOpen = api.gh.list;
  api.gh.list = async (url, ...rest) => {
    const out = await fetchOpen(url, ...rest);
    if (url.includes('state=open') && ++openReads > 1) return { ...out, items: [...out.items, { number: 8, state: 'open', head: { sha: SHA } }] };
    return out;
  };
  const r2 = await report(api);
  assert.equal(r2.decision.state, 'pending', r2.decision.reason);
  assert.match(r2.decision.reason, /share its head/);
});

// Approvals: label presence is not authority. GitHub lets triage manage labels without write.
const approvedRun = () => apiRun({ id: 100, created_at: '2026-11-07T10:00:00Z' });
const approvedJob = () => ({ ...verifyJob(), steps: [...verifySteps(), { name: 'approval-tests', conclusion: 'success' }] });
function withEvents(events, { complete = true } = {}) {
  const api = fakeGitHub({ runs: [approvedRun()], jobs: { 100: [approvedJob()] }, pr: { labels: [{ name: 'pocp-approve-tests' }] } });
  const list = api.gh.list;
  const perms = { maintainer: 'write', helper: 'triage' };
  api.gh.list = async (url, ...rest) => (url.includes('/issues/7/events')
    ? { items: events.map((e) => ({ event: 'labeled', label: { name: 'pocp-approve-tests' }, actor: { login: e.actor }, created_at: e.at })), complete, reason: complete ? null : 'cut short' }
    : list(url, ...rest));
  const get = api.gh.get;
  api.gh.get = async (url) => {
    const m = /\/collaborators\/([^/]+)\/permission$/.exec(url);
    return m ? { permission: perms[decodeURIComponent(m[1])] || 'read' } : get(url);
  };
  return api;
}

test('an approval counts only when a writer applied it last, after the head\'s first run', async () => {
  const ok = await report(withEvents([{ actor: 'maintainer', at: '2026-11-07T11:00:00Z' }]));
  assert.equal(ok.decision.state, 'success', ok.decision.reason);
  for (const [label, events, opts] of [
    ['applied by triage', [{ actor: 'helper', at: '2026-11-07T11:00:00Z' }]],
    ['writer, then re-applied by triage', [{ actor: 'maintainer', at: '2026-11-07T11:00:00Z' }, { actor: 'helper', at: '2026-11-07T12:00:00Z' }]],
    ['applied before this head\'s first run', [{ actor: 'maintainer', at: '2026-11-07T09:00:00Z' }]],
    ['event list cut short', [{ actor: 'maintainer', at: '2026-11-07T11:00:00Z' }], { complete: false }],
    ['no event at all', []],
  ]) {
    const r = await report(withEvents(events, opts));
    assert.equal(r.decision.state, 'pending', `${label}: ${r.decision.reason}`);
    assert.equal(r.decision.description, TEXT.approvalUnverified, label);
  }
});
