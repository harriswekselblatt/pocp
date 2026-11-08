// The trusted reporter's decisions, from recorded API facts: it never trusts a run whose
// workflow the pull request could have changed, checks run identity and the current head,
// takes the newest run, re-checks approvals, and shows only generic text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideStatus, readRun, reportStatus, runMarker, TEXT, workflowFiles } from '../src/status-report.js';

const SHA = 'a'.repeat(40);
const BASE = 'e'.repeat(40);
const WF = { id: 11, path: '.github/workflows/pocp.yml' };

const steps = (pattern) => [
  { name: 'Set up job', conclusion: 'success' },
  { name: runMarker(7, BASE), conclusion: 'success' },
  { name: 'verify', conclusion: 'success' },
  // `verified` runs only when verify exited 0: when no result step ran (unless a test says).
  { name: 'verified', conclusion: pattern.verified || (['waiting', 'inconclusive', 'failed'].some((n) => pattern[n]) ? 'skipped' : 'success') },
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
const facts = (over = {}) => {
  const f = {
    event_sha: SHA, repository: 'o/r', workflow: WF, ci_globs: workflowFiles(null),
    pr: { number: 7, state: 'open', head_sha: SHA, labels: [], author: 'author' },
    files: [{ filename: 'src/a.js' }], runs: [run()], label_events: [], ...over,
  };
  // Complete data by default (test/status-report-integrity.test.js covers when it isn't).
  return { base_sha: BASE, changed_files: f.files.length, head_prs: [7], incomplete: [], label_events_complete: true, ...f };
};
// What the API returns for the pull request and the open pull requests list.
const apiPr = (sha = SHA) => ({ number: 7, state: 'open', head: { sha }, base: { sha: BASE }, changed_files: 1, labels: [] });
const openPrs = [{ number: 7, state: 'open', head: { sha: SHA } }];

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
  const labelled = (e) => facts({ ...base, pr: { number: 7, state: 'open', head_sha: SHA, labels: ['pocp-approve-workflow'], author: 'author' }, label_events: [{ actor: 'maintainer', ...e }] });
  assert.equal(decideStatus(labelled({ label: 'pocp-approve-workflow', permission: 'write', created_at: '2026-11-04T11:00:00Z' })).state, 'success');
  assert.equal(decideStatus(labelled({ label: 'pocp-approve-workflow', permission: 'triage', created_at: '2026-11-04T11:00:00Z' })).state, 'pending', 'triage can label but not approve');
  assert.equal(decideStatus(labelled({ label: 'pocp-approve-workflow', permission: null, created_at: '2026-11-04T11:00:00Z' })).state, 'pending', 'unknown permission never approves');
  assert.equal(decideStatus(labelled({ label: 'pocp-approve-workflow', permission: 'admin', created_at: '2026-11-04T09:00:00Z' })).state, 'pending', 'given before this head ran');
  // The label event exists but the label is gone now.
  assert.equal(decideStatus(facts({ ...base, label_events: [{ label: 'pocp-approve-workflow', permission: 'admin', created_at: '2026-11-04T11:00:00Z' }] })).state, 'pending');
  // Approved, but the run itself failed: still red.
  const failedRun = run({ failed: 'failure' }, { created_at: '2026-11-04T10:00:00Z' });
  const d = decideStatus(facts({ files: base.files, runs: [failedRun], pr: { number: 7, state: 'open', head_sha: SHA, labels: ['pocp-approve-workflow'], author: 'author' }, label_events: [{ label: 'pocp-approve-workflow', actor: 'maintainer', permission: 'maintain', created_at: '2026-11-04T11:00:00Z' }] }));
  assert.equal(d.state, 'failure');
});

// A CI-changing pull request whose workflow a maintainer approved: the run is then judged by
// every normal rule. Approving the workflow approves nothing else.
const ciChanged = (pattern, { labels = ['pocp-approve-workflow'], actor = 'maintainer', approver } = {}) => facts({
  files: [{ filename: '.github/workflows/pocp.yml' }],
  runs: [run(pattern, { created_at: '2026-11-04T10:00:00Z' })],
  pr: { number: 7, state: 'open', head_sha: SHA, labels, author: 'author' },
  label_events: [
    { label: 'pocp-approve-workflow', actor, permission: 'write', created_at: '2026-11-04T11:00:00Z' },
    { label: 'pocp-approve-tests', actor: 'maintainer', permission: 'write', created_at: '2026-11-04T11:00:00Z' },
  ],
  ...(approver ? { workflow_approver: approver } : {}),
});

test('regression: a CI-changing PR whose run still waits for another approval stays pending, never green', () => {
  // Live mode: the waiting step passes, so the job concludes success.
  const live = decideStatus(ciChanged({ waiting: 'success' }));
  assert.equal(live.state, 'pending');
  assert.equal(live.description, TEXT.waiting);
  // Report-only mode: the waiting step fails the job.
  const reportOnly = decideStatus(ciChanged({ waiting: 'failure', jobFailed: true }));
  assert.equal(reportOnly.state, 'pending');
  assert.equal(decideStatus(ciChanged({ inconclusive: 'success' })).description, TEXT.inconclusive);
  // The run relied on a test approval that has since been removed: pending, not green.
  const gone = decideStatus(ciChanged({ approvals: ['approval-tests'] }));
  assert.equal(gone.state, 'pending');
  assert.equal(gone.description, TEXT.approvalGone);
  // With that approval still on, and the workflow approved, it's green.
  assert.equal(decideStatus(ciChanged({ approvals: ['approval-tests'] }, { labels: ['pocp-approve-workflow', 'pocp-approve-tests'] })).state, 'success');
});

test('pocp-approve-workflow must come from someone other than the author, unless the base allows any writer', () => {
  const byAuthor = decideStatus(ciChanged({}, { actor: 'author' }));
  assert.equal(byAuthor.state, 'pending');
  assert.equal(byAuthor.description, TEXT.workflow);
  assert.match(byAuthor.reason, /a writer other than the author/);
  assert.equal(decideStatus(ciChanged({}, { actor: null })).state, 'pending', 'an unknown actor never approves');
  assert.equal(decideStatus(ciChanged({}, { actor: 'maintainer' })).state, 'success');
  // A solo maintainer can choose "any-writer" in the base's config (a policy loosening).
  assert.equal(decideStatus(ciChanged({}, { actor: 'author', approver: 'any-writer' })).state, 'success');
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
  const approved = run({ approvals: ['approval-tests'] }, { created_at: '2026-11-04T10:00:00Z' });
  const byWriter = [{ label: 'pocp-approve-tests', actor: 'maintainer', permission: 'write', created_at: '2026-11-04T11:00:00Z' }];
  assert.equal(decideStatus(facts({ runs: [approved], label_events: byWriter, pr: { number: 7, state: 'open', head_sha: SHA, labels: ['pocp-approve-tests'] } })).state, 'success');
  const d = decideStatus(facts({ runs: [approved], label_events: byWriter, pr: { number: 7, state: 'open', head_sha: SHA, labels: [] } }));
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

test('skipped runs never decide; a later cancelled or in-progress run holds an older success at pending', () => {
  const good = run({}, { created_at: '2026-11-04T10:00:00Z' });
  for (const over of [{ conclusion: 'skipped' }, { job: { conclusion: 'skipped', steps: [] } }]) {
    const later = run({ failed: 'failure' }, { created_at: '2026-11-04T11:00:00Z', ...over });
    assert.equal(decideStatus(facts({ runs: [good, later] })).state, 'success', JSON.stringify(over));
  }
  // The newest evaluation isn't finished (or never will be): the older success isn't the latest word.
  for (const over of [{ conclusion: 'cancelled' }, { status: 'in_progress', conclusion: null }]) {
    const later = run({ failed: 'failure' }, { created_at: '2026-11-04T11:00:00Z', ...over });
    assert.equal(decideStatus(facts({ runs: [good, later] })).state, 'pending', JSON.stringify(over));
  }
});

test('regression (PR #41): runs cancelled before verify (several approval labels at once) say nothing; the passing sibling decides', () => {
  // Three pocp-approve-* labels in one command started three runs on the same head. The
  // concurrency group cancelled two while their verify job was still queued: job completed and
  // cancelled, no steps. The newest by run_started_at was one of those, and the reporter said
  // "Waiting for verify." although run 42467967802 had passed.
  const approvals = ['approval-tests', 'approval-policy', 'approval-coverage'];
  const labels = ['pocp-approve-tests', 'pocp-approve-policy', 'pocp-approve-coverage'];
  const label_events = labels.map((label) => ({ label, actor: 'maintainer', permission: 'admin', created_at: '2026-11-07T09:59:00Z' }));
  const queuedCancel = (id, at) => run({}, { id, conclusion: 'cancelled', created_at: at, run_started_at: at, job: { status: 'completed', conclusion: 'cancelled', steps: [] } });
  const passed = run({ approvals }, { id: 42467967802, created_at: '2026-11-07T10:00:01Z', run_started_at: '2026-11-07T10:00:01Z' });
  passed.job.status = 'completed';
  const earlier = run({}, { id: 42467967000, created_at: '2026-11-07T09:00:00Z', run_started_at: '2026-11-07T09:00:00Z' });
  const f = (runs) => facts({ pr: { number: 7, state: 'open', head_sha: SHA, labels, author: 'author' }, label_events, runs });
  const exact = decideStatus(f([earlier, passed, queuedCancel(42467967872, '2026-11-07T10:00:02Z')]));
  assert.equal(exact.state, 'success', exact.reason);
  assert.match(exact.reason, /run 42467967802 verified/);
  // Also silent: cancelled after "Set up job" but before any pocp step, or with every pocp step skipped.
  const setupOnly = run({}, { id: 42467967900, conclusion: 'cancelled', created_at: '2026-11-07T10:00:03Z', run_started_at: '2026-11-07T10:00:03Z', job: { status: 'completed', conclusion: 'cancelled', steps: [{ name: 'Set up job', conclusion: 'cancelled' }] } });
  const allSkipped = run({}, { id: 42467967901, conclusion: 'cancelled', created_at: '2026-11-07T10:00:04Z', run_started_at: '2026-11-07T10:00:04Z' });
  allSkipped.job = { status: 'completed', conclusion: 'cancelled', steps: allSkipped.job.steps.map((st) => ({ ...st, conclusion: st.name === 'Set up job' ? 'success' : 'skipped' })) };
  const both = decideStatus(f([earlier, passed, queuedCancel(42467967872, '2026-11-07T10:00:02Z'), setupOnly, allSkipped]));
  assert.equal(both.state, 'success', both.reason);
  // Only silent cancelled runs on the head: nothing has spoken yet.
  const none = decideStatus(f([queuedCancel(42467967872, '2026-11-07T10:00:02Z')]));
  assert.equal(none.state, 'pending', none.reason);
  assert.equal(none.description, TEXT.pending);
});

test('fail-closed: a run cancelled after it started evaluating still holds an older success at pending', () => {
  const passed = run({}, { created_at: '2026-11-07T10:00:00Z', run_started_at: '2026-11-07T10:00:00Z' });
  passed.job.status = 'completed';
  const cancelledJob = (steps, over = {}) => ({ status: 'completed', conclusion: 'cancelled', steps, ...over });
  const marker = (conclusion) => ({ name: runMarker(7, BASE), conclusion });
  for (const [label, job, over] of [
    ['marker passed, verify cancelled', cancelledJob([marker('success'), { name: 'verify', conclusion: 'cancelled' }])],
    ['marker passed, nothing after it', cancelledJob([marker('success')])],
    ['marker cancelled', cancelledJob([marker('cancelled')])],
    ['marker without a result', cancelledJob([marker(null)])],
    ['verify cancelled, no marker', cancelledJob([{ name: 'verify', conclusion: 'cancelled' }])],
    ['an approval marker ran', cancelledJob([{ name: 'approval-tests', conclusion: 'success' }])],
    ['no verify job (list unreadable or not created)', null],
    ['job not completed', cancelledJob([], { status: 'in_progress' })],
    ['run cancelled, job not cancelled', cancelledJob([], { conclusion: 'failure' })],
    ['job cancelled, run not cancelled', cancelledJob([]), { conclusion: 'failure' }],
  ]) {
    const later = run({}, { conclusion: 'cancelled', created_at: '2026-11-07T10:05:00Z', run_started_at: '2026-11-07T10:05:00Z', ...over, job });
    const d = decideStatus(facts({ runs: [passed, later] }));
    assert.equal(d.state, 'pending', `${label}: ${d.reason}`);
  }
});

test('readRun: incomplete data is unreadable (a wait); complete but unexpected data is a failure; neither is a success', () => {
  // Incomplete: seen live, a run reported completed while its job's steps weren't readable yet.
  assert.equal(readRun(null).outcome, 'unreadable');
  assert.equal(readRun({ conclusion: 'success', steps: [] }).outcome, 'unreadable');
  assert.equal(readRun({ ...job(), status: 'in_progress' }).outcome, 'unreadable');
  assert.equal(readRun({ ...job(), conclusion: null }).outcome, 'unreadable');
  assert.equal(readRun({ ...job(), steps: job().steps.map((st) => (st.name === 'failed' ? { ...st, conclusion: null } : st)) }).outcome, 'unreadable');
  // A workflow without the `verified` step (older than this reporter): outdated, never green,
  // whatever its other steps say.
  const old = [{ name: 'verify', conclusion: 'success' }, { name: 'waiting', conclusion: 'skipped' }, { name: 'inconclusive', conclusion: 'skipped' }, { name: 'failed', conclusion: 'skipped' }];
  assert.equal(readRun({ status: 'completed', conclusion: 'success', steps: old }).outcome, 'outdated');
  // Each required step missing on its own: outdated.
  for (const name of ['verify', 'verified', 'waiting', 'inconclusive', 'failed']) {
    assert.equal(readRun({ status: 'completed', ...job(), steps: job().steps.filter((st) => st.name !== name) }).outcome, 'outdated', name);
  }
  // Complete but unexpected: failure.
  assert.equal(readRun(job({ verified: 'skipped' })).outcome, 'failed', 'verify failed and no result step ran');
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
        return apiPr(calls === 1 ? SHA : 'd'.repeat(40));
      }
      throw new Error(`unexpected GET ${url}`);
    },
    all: async (url) => (url.includes('/pulls?state=open') ? openPrs : url.includes('/files') ? [{ filename: 'src/a.js' }] : url.includes('/runs?') ? [{ ...run(), repository: { full_name: 'o/r' } }] : url.includes('/jobs') ? [{ name: 'verify', ...job() }] : []),
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
    get: async (url) => (url.includes('/actions/workflows/') ? WF : apiPr()),
    all: async (url) => (url.includes('/pulls?state=open') ? openPrs : url.includes('/files') ? [{ filename: 'src/a.js' }] : url.includes('/runs?') ? [{ ...run(), repository: { full_name: 'o/r' } }] : url.includes('/jobs') ? [{ name: 'verify', ...job() }] : []),
    post: async (url, body) => posted.push({ url, body }),
  };
  const r = await reportStatus(gh, { repository: 'o/r', sha: SHA, prNumber: 7, baseConfig: null });
  assert.equal(r.written, true);
  assert.equal(posted.length, 1);
  assert.equal(posted[0].url, `/repos/o/r/statuses/${SHA}`);
  assert.equal(posted[0].body.context, 'pocp');
  assert.equal(posted[0].body.state, 'success');
});

test('ci.workflow_approver: "independent" by default, validated, and loosening it is a policy change', async () => {
  const { configWeakening, validateConfig, withDefaults } = await import('../src/store.js');
  assert.equal(withDefaults({}).ci.workflow_approver, 'independent');
  assert.deepEqual(validateConfig(withDefaults({})), []);
  assert.deepEqual(validateConfig(withDefaults({ ci: { workflow_approver: 'any-writer' } })), []);
  assert.match(validateConfig(withDefaults({ ci: { workflow_approver: 'anyone' } })).join(), /ci\.workflow_approver must be/);
  assert.deepEqual(configWeakening(withDefaults({}), withDefaults({ ci: { workflow_approver: 'any-writer' } })), ['ci.workflow_approver no longer requires an approver other than the author']);
  assert.deepEqual(configWeakening(withDefaults({ ci: { workflow_approver: 'any-writer' } }), withDefaults({})), [], 'tightening is not a loosening');
});

test('an unreadable run is pending ("Waiting for verify"), never success or failure', () => {
  const d = decideStatus(facts({ runs: [run({}, { job: { conclusion: 'success', steps: [] } })] }));
  assert.equal(d.state, 'pending');
  assert.equal(d.description, TEXT.pending);
  assert.equal(d.unreadable, true);
  assert.match(d.reason, /aren't readable yet/);
});

test('reportStatus fetches again while the steps are unreadable, then writes the real result', async () => {
  const posted = [];
  let jobFetches = 0;
  const slept = [];
  const gh = {
    get: async (url) => (url.includes('/actions/workflows/') ? WF : apiPr()),
    all: async (url) => {
      if (url.includes('/pulls?state=open')) return openPrs;
      if (url.includes('/files')) return [{ filename: 'src/a.js' }];
      if (url.includes('/runs?')) return [{ ...run(), repository: { full_name: 'o/r' } }];
      if (url.includes('/jobs')) return [{ name: 'verify', ...(++jobFetches < 3 ? { conclusion: 'success', steps: [] } : job()) }];
      return [];
    },
    post: async (url, body) => posted.push({ url, body }),
  };
  const r = await reportStatus(gh, { repository: 'o/r', sha: SHA, prNumber: 7, baseConfig: null, sleep: async (ms) => slept.push(ms), waitMs: 5 });
  assert.equal(jobFetches, 3, 'retried until readable');
  assert.deepEqual(slept, [5, 5]);
  assert.equal(r.written, true);
  assert.equal(posted[0].body.state, 'success');
});

test('reportStatus settles on pending when the steps stay unreadable', async () => {
  const posted = [];
  const gh = {
    get: async (url) => (url.includes('/actions/workflows/') ? WF : apiPr()),
    all: async (url) => (url.includes('/pulls?state=open') ? openPrs : url.includes('/files') ? [{ filename: 'src/a.js' }] : url.includes('/runs?') ? [{ ...run(), repository: { full_name: 'o/r' } }] : url.includes('/jobs') ? [{ name: 'verify', conclusion: 'success', steps: [] }] : []),
    post: async (url, body) => posted.push({ url, body }),
  };
  await reportStatus(gh, { repository: 'o/r', sha: SHA, prNumber: 7, baseConfig: null, sleep: async () => {}, waitMs: 1 });
  assert.equal(posted.length, 1);
  assert.equal(posted[0].body.state, 'pending');
});
