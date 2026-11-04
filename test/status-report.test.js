// The trusted reporter's decisions, from recorded API facts: it never trusts a run whose
// workflow the pull request could have changed, checks run identity and the current head,
// takes the newest run, re-checks approvals, and shows only generic text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideStatus, readRun, reportStatus, TEXT, workflowFiles } from '../src/status-report.js';

const SHA = 'a'.repeat(40);
const WF = { id: 11, path: '.github/workflows/pocp.yml' };

const steps = (pattern) => [
  { name: 'Set up job', conclusion: 'success' },
  { name: 'verify', conclusion: 'success' },
  ...['waiting', 'inconclusive', 'failed'].map((n) => ({ name: n, conclusion: pattern[n] || 'skipped' })),
  ...['approval-tests', 'approval-policy', 'approval-inconclusive', 'approval-coverage'].map((n) => ({ name: n, conclusion: (pattern.approvals || []).includes(n) ? 'success' : 'skipped' })),
];
const job = (pattern = {}) => ({ conclusion: pattern.failed || pattern.jobFailed ? 'failure' : 'success', steps: steps(pattern) });
let nextId = 100;
const run = (pattern = {}, over = {}) => ({
  id: nextId++, workflow_id: WF.id, path: WF.path, event: 'pull_request', head_sha: SHA, repository: 'o/r',
  status: 'completed', conclusion: 'success', created_at: `2026-11-04T10:00:${String(nextId % 60).padStart(2, '0')}Z`, run_attempt: 1,
  html_url: 'https://github.com/o/r/actions/runs/1', job: job(pattern), ...over,
});
const facts = (over = {}) => ({
  event_sha: SHA, repository: 'o/r', workflow: WF, ci_globs: workflowFiles(null),
  pr: { number: 7, state: 'open', head_sha: SHA, labels: [] },
  files: [{ filename: 'src/a.js' }], runs: [run()], label_events: [], ...over,
});

test('a verified run on an unchanged workflow is green', () => {
  const d = decideStatus(facts());
  assert.equal(d.write, true);
  assert.equal(d.state, 'success');
  assert.equal(d.sha, SHA);
  assert.equal(d.description, TEXT.verified);
});

test('waiting and inconclusive are pending (yellow), failure is red, no run yet is pending', () => {
  assert.equal(decideStatus(facts({ runs: [run({ waiting: 'success' })] })).state, 'pending');
  assert.equal(decideStatus(facts({ runs: [run({ waiting: 'success' })] })).description, TEXT.waiting);
  assert.equal(decideStatus(facts({ runs: [run({ inconclusive: 'success' })] })).description, TEXT.inconclusive);
  assert.equal(decideStatus(facts({ runs: [run({ failed: 'failure' })] })).state, 'failure');
  const none = decideStatus(facts({ runs: [] }));
  assert.equal(none.state, 'pending');
  assert.equal(none.description, TEXT.pending);
});

test('report-only mode: a waiting step that fails the job still reads as waiting, not failed', () => {
  // Until the live gate passes, waiting/inconclusive steps exit 1 so the required verify stays red.
  const d = decideStatus(facts({ runs: [run({ waiting: 'failure', jobFailed: true })] }));
  assert.equal(d.state, 'pending');
  assert.equal(d.description, TEXT.waiting);
});

test('spoof: a PR that edits the workflow gets no green from its own run, whatever its steps say', () => {
  for (const filename of ['.github/workflows/pocp.yml', '.github/workflows/other.yml', 'action.yml', '.github/actions/x/action.yml']) {
    const d = decideStatus(facts({ files: [{ filename }], runs: [run()] }));
    assert.equal(d.state, 'pending', filename);
    assert.equal(d.description, TEXT.workflow, filename);
  }
  // A rename away from a workflow path counts too.
  assert.equal(decideStatus(facts({ files: [{ filename: 'x.yml', previous_filename: '.github/workflows/pocp.yml' }] })).description, TEXT.workflow);
});

test('spoof: a workflow change turns green only with pocp-approve-workflow from a writer, given after the first run', () => {
  const first = run({}, { created_at: '2026-11-04T10:00:00Z' });
  const base = { files: [{ filename: '.github/workflows/pocp.yml' }], runs: [first] };
  const labelled = (e) => facts({ ...base, pr: { number: 7, state: 'open', head_sha: SHA, labels: ['pocp-approve-workflow'] }, label_events: [e] });
  assert.equal(decideStatus(labelled({ label: 'pocp-approve-workflow', permission: 'write', created_at: '2026-11-04T11:00:00Z' })).state, 'success');
  assert.equal(decideStatus(labelled({ label: 'pocp-approve-workflow', permission: 'triage', created_at: '2026-11-04T11:00:00Z' })).state, 'pending', 'triage can label but not approve');
  assert.equal(decideStatus(labelled({ label: 'pocp-approve-workflow', permission: null, created_at: '2026-11-04T11:00:00Z' })).state, 'pending', 'unknown permission never approves');
  assert.equal(decideStatus(labelled({ label: 'pocp-approve-workflow', permission: 'admin', created_at: '2026-11-04T09:00:00Z' })).state, 'pending', 'given before this head ran');
  // The label event exists but the label is gone now.
  assert.equal(decideStatus(facts({ ...base, label_events: [{ label: 'pocp-approve-workflow', permission: 'admin', created_at: '2026-11-04T11:00:00Z' }] })).state, 'pending');
  // Approved, but the run itself failed: still red.
  const failedRun = run({ failed: 'failure' }, { created_at: '2026-11-04T10:00:00Z' });
  const d = decideStatus(facts({ files: base.files, runs: [failedRun], pr: { number: 7, state: 'open', head_sha: SHA, labels: ['pocp-approve-workflow'] }, label_events: [{ label: 'pocp-approve-workflow', permission: 'maintain', created_at: '2026-11-04T11:00:00Z' }] }));
  assert.equal(d.state, 'failure');
});

test('identity: runs of another workflow, event, repository or head are ignored', () => {
  for (const over of [{ workflow_id: 99 }, { path: '.github/workflows/fake.yml' }, { event: 'pull_request_target' }, { repository: 'fork/r' }, { head_sha: 'b'.repeat(40) }]) {
    const d = decideStatus(facts({ runs: [run({}, over)] }));
    assert.equal(d.state, 'pending', JSON.stringify(over));
    assert.equal(d.description, TEXT.pending, JSON.stringify(over));
  }
});

test('head moved or PR closed: nothing is written for the old head', () => {
  const moved = decideStatus(facts({ pr: { number: 7, state: 'open', head_sha: 'c'.repeat(40), labels: [] } }));
  assert.equal(moved.write, false);
  assert.match(moved.reason, /no longer its head/);
  assert.equal(decideStatus(facts({ pr: { number: 7, state: 'closed', head_sha: SHA, labels: [] } })).write, false);
  assert.equal(decideStatus(facts({ pr: null })).write, false);
});

test('approval gone: a verified run that relied on a label now removed is pending', () => {
  const approved = run({ approvals: ['approval-tests'] });
  assert.equal(decideStatus(facts({ runs: [approved], pr: { number: 7, state: 'open', head_sha: SHA, labels: ['pocp-approve-tests'] } })).state, 'success');
  const d = decideStatus(facts({ runs: [approved], pr: { number: 7, state: 'open', head_sha: SHA, labels: [] } }));
  assert.equal(d.state, 'pending');
  assert.equal(d.description, TEXT.approvalGone);
});

test('out of order: the newest run decides, whatever order they finished or arrived in', () => {
  const older = run({ waiting: 'success' }, { created_at: '2026-11-04T10:00:00Z' });
  const newer = run({}, { created_at: '2026-11-04T10:05:00Z' });
  assert.equal(decideStatus(facts({ runs: [newer, older] })).state, 'success');
  assert.equal(decideStatus(facts({ runs: [older, newer] })).state, 'success');
  // A re-run attempt of the same run counts as newer.
  const a1 = run({ inconclusive: 'success' }, { id: 5, created_at: '2026-11-04T10:00:00Z', run_attempt: 1 });
  const a2 = run({}, { id: 5, created_at: '2026-11-04T10:00:00Z', run_attempt: 2 });
  assert.equal(decideStatus(facts({ runs: [a2, a1] })).state, 'success');
});

test('cancelled, skipped and in-progress runs never decide', () => {
  const good = run({}, { created_at: '2026-11-04T10:00:00Z' });
  for (const over of [{ conclusion: 'cancelled' }, { conclusion: 'skipped' }, { status: 'in_progress', conclusion: null }, { job: { conclusion: 'skipped', steps: [] } }]) {
    const later = run({ failed: 'failure' }, { created_at: '2026-11-04T11:00:00Z', ...over });
    assert.equal(decideStatus(facts({ runs: [good, later] })).state, 'success', JSON.stringify(over));
  }
});

test('readRun: anything unexpected is a failure, never a success', () => {
  assert.equal(readRun(null).outcome, 'failed');
  assert.equal(readRun({ conclusion: 'success', steps: [] }).outcome, 'failed');
  assert.equal(readRun({ conclusion: 'success', steps: [{ name: 'verify', conclusion: 'failure' }, { name: 'waiting', conclusion: 'skipped' }, { name: 'inconclusive', conclusion: 'skipped' }, { name: 'failed', conclusion: 'skipped' }] }).outcome, 'failed');
  assert.equal(readRun(job({ waiting: 'success', inconclusive: 'success' })).outcome, 'failed', 'both waits at once');
  assert.equal(readRun({ ...job(), conclusion: 'failure' }).outcome, 'failed', 'job failed with no wait step');
});

test('the status text is generic: nothing from the run reaches it', () => {
  for (const pattern of [{}, { waiting: 'success' }, { inconclusive: 'success' }, { failed: 'failure' }]) {
    const d = decideStatus(facts({ runs: [run(pattern)] }));
    assert.ok(Object.values(TEXT).includes(d.description), d.description);
  }
});

test('reportStatus re-checks the head right before writing', async () => {
  const posted = [];
  let calls = 0;
  const gh = {
    get: async (url) => {
      if (url.includes('/actions/workflows/pocp.yml')) return WF;
      if (url.endsWith('/pulls/7')) {
        calls++;
        // The head moves between deciding and writing.
        return { number: 7, state: 'open', head: { sha: calls === 1 ? SHA : 'd'.repeat(40) }, labels: [] };
      }
      throw new Error(`unexpected GET ${url}`);
    },
    all: async (url) => (url.includes('/files') ? [{ filename: 'src/a.js' }] : url.includes('/runs?') ? [{ ...run(), repository: { full_name: 'o/r' } }] : url.includes('/jobs') ? [{ name: 'verify', ...job() }] : []),
    post: async (url, body) => posted.push({ url, body }),
  };
  const r = await reportStatus(gh, { repository: 'o/r', sha: SHA, prNumber: 7, baseConfig: null });
  assert.equal(r.written, false);
  assert.match(r.decision.reason, /changed while deciding/);
  assert.deepEqual(posted, []);
});

test('reportStatus writes one pocp status on the head', async () => {
  const posted = [];
  const gh = {
    get: async (url) => (url.includes('/actions/workflows/') ? WF : { number: 7, state: 'open', head: { sha: SHA }, labels: [] }),
    all: async (url) => (url.includes('/files') ? [{ filename: 'src/a.js' }] : url.includes('/runs?') ? [{ ...run(), repository: { full_name: 'o/r' } }] : url.includes('/jobs') ? [{ name: 'verify', ...job() }] : []),
    post: async (url, body) => posted.push({ url, body }),
  };
  const r = await reportStatus(gh, { repository: 'o/r', sha: SHA, prNumber: 7, baseConfig: null });
  assert.equal(r.written, true);
  assert.equal(posted.length, 1);
  assert.equal(posted[0].url, `/repos/o/r/statuses/${SHA}`);
  assert.equal(posted[0].body.context, 'pocp');
  assert.equal(posted[0].body.state, 'success');
});
