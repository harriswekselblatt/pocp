// `pocp approvals`: every pending maintainer approval in one list, and a deliberate way to give one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { git, pocp, sampleRepo, write } from './helpers.js';
import { approvalAnnotation, approvalSummary, approvePr, readAnnotations } from '../src/approvals.js';
import { withFacts } from '../src/finding.js';

// Findings as verify makes them: the decision reads their typed facts, never their text.
const testChange = (detail, files) => withFacts({ code: 'test_change', detail, blocking: true }, { approval: 'tests', files });

/**
 * A fake gh that answers from a table of "args joined by spaces" → { status, body } (or
 * { seq: [...] } for answers that change between calls), and logs every call.
 */
function fakeGh(table) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pocp-gh-')));
  const file = path.join(dir, 'gh.mjs');
  const log = path.join(dir, 'calls.log');
  fs.writeFileSync(path.join(dir, 'table.json'), JSON.stringify(table));
  fs.writeFileSync(file, `#!/usr/bin/env node
import fs from 'node:fs';
const dir = ${JSON.stringify(dir)};
const table = JSON.parse(fs.readFileSync(dir + '/table.json', 'utf8'));
const key = process.argv.slice(2).join(' ');
fs.appendFileSync(dir + '/calls.log', key + '\\n');
let hit = table[key];
if (hit && hit.seq) {
  const n = Number(fs.existsSync(dir + '/n-' + hit.id) ? fs.readFileSync(dir + '/n-' + hit.id, 'utf8') : 0);
  fs.writeFileSync(dir + '/n-' + hit.id, String(n + 1));
  hit = hit.seq[Math.min(n, hit.seq.length - 1)];
}
if (!hit) { process.stderr.write('fake gh: no answer for: ' + key); process.exit(1); }
process.stdout.write(typeof hit.body === 'string' ? hit.body : JSON.stringify(hit.body));
process.exit(hit.status || 0);
`);
  fs.chmodSync(file, 0o755);
  return { bin: file, calls: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean) : []) };
}

const PR_FIELDS = 'number,title,url,author,headRefOid,labels,files,isDraft';
const SHA = (c) => c.repeat(40);

const TEST_CHANGE = 'existing tests or test setup changed (test/math.test.js); the mechanical check did not pass: 2 of 10 planted bugs no longer caught. Re-run with --accept-test-change once a person approves';
const CI_CHANGE = 'CI configuration changed (.github/workflows/ci.yml); re-run with --accept-policy-change once a maintainer approves';
const marker = (needs) => ({ annotation_level: 'notice', title: 'POCP approval needed', message: JSON.stringify({ needs }) });

const DIFF = `diff --git a/src/math.js b/src/math.js
index 1..2 100644
--- a/src/math.js
+++ b/src/math.js
@@ -1 +1 @@
-old
+new
diff --git a/test/math.test.js b/test/math.test.js
index 3..4 100644
--- a/test/math.test.js
+++ b/test/math.test.js
@@ -1,2 +1 @@
-assert.equal(add(2, 3), 5);
+// removed
`;

/** Four open PRs on me/site: waiting for tests, blocked by a failing check, already approved, passing. */
function siteTable() {
  const pr = (number, title, sha, labels = [], files = []) => ({ number, title, url: `https://github.com/me/site/pull/${number}`, author: { login: 'bot' }, headRefOid: sha, labels: labels.map((name) => ({ name })), files, isDraft: false });
  const prs = [
    pr(1, 'Loosen a test', SHA('a'), [], [{ path: 'src/math.js', additions: 1, deletions: 1 }, { path: 'test/math.test.js', additions: 1, deletions: 2 }]),
    pr(2, 'Broken change', SHA('b')),
    pr(3, 'New CI step', SHA('c'), ['pocp-approve-policy'], [{ path: '.github/workflows/ci.yml', additions: 3, deletions: 0 }]),
    pr(4, 'All good', SHA('d')),
  ];
  const runs = (id, conclusion, status = 'completed') => ({ body: { check_runs: [{ id, name: 'verify', status, conclusion, html_url: `https://github.com/me/site/runs/${id}` }, { id: id + 1, name: 'test', status: 'completed', conclusion: 'success' }] } });
  return {
    'api user': { body: { login: 'me' } },
    'search prs --owner me --state open --limit 200 --json repository': { body: [{ repository: { nameWithOwner: 'me/site' } }, { repository: { nameWithOwner: 'me/site' } }] },
    [`pr list --repo me/site --state open --limit 200 --json ${PR_FIELDS}`]: { body: prs },
    [`pr view 1 --repo me/site --json ${PR_FIELDS},state`]: { body: { ...prs[0], state: 'OPEN' } },
    [`pr view 2 --repo me/site --json ${PR_FIELDS},state`]: { body: { ...prs[1], state: 'OPEN' } },
    [`pr view 3 --repo me/site --json ${PR_FIELDS},state`]: { body: { ...prs[2], state: 'OPEN' } },
    [`api repos/me/site/commits/${SHA('a')}/check-runs?per_page=100`]: runs(10, 'failure'),
    [`api repos/me/site/commits/${SHA('b')}/check-runs?per_page=100`]: runs(20, 'failure'),
    [`api repos/me/site/commits/${SHA('c')}/check-runs?per_page=100`]: runs(30, 'failure'),
    [`api repos/me/site/commits/${SHA('d')}/check-runs?per_page=100`]: runs(40, 'success'),
    'api repos/me/site/check-runs/10/annotations?per_page=100': { body: [
      { annotation_level: 'failure', title: 'POCP', message: `aaaaaaaaaaaa ${TEST_CHANGE}` },
      marker([{ label: 'pocp-approve-tests', kind: 'tests', reasons: [TEST_CHANGE], files: ['test/math.test.js'] }]),
    ] },
    'api repos/me/site/check-runs/20/annotations?per_page=100': { body: [{ annotation_level: 'failure', title: 'POCP rerun', message: 'p-1: node test/math.check.mjs failed' }] },
    'api repos/me/site/check-runs/30/annotations?per_page=100': { body: [marker([{ label: 'pocp-approve-policy', kind: 'policy', reasons: [CI_CHANGE], files: ['.github/workflows/ci.yml'] }])] },
    // A passing run with no approval marker: verified, nothing to approve.
    'api repos/me/site/check-runs/40/annotations?per_page=100': { body: [] },
    'pr diff 1 --repo me/site': { body: DIFF },
    'pr edit 1 --repo me/site --add-label pocp-approve-tests': { body: 'https://github.com/me/site/pull/1' },
  };
}

test('approvalSummary: only a maintainer\'s label is an approval; anything else is not', () => {
  const tests = approvalSummary([testChange(TEST_CHANGE, ['test/math.test.js'])]);
  assert.equal(tests.only, true);
  assert.deepEqual(tests.needs.map((n) => [n.label, n.files]), [['pocp-approve-tests', ['test/math.test.js']]]);

  const policy = approvalSummary([
    withFacts({ code: 'policy_loosened', detail: 'policy loosened without approval: rule x removed', blocking: true }, { files: ['.proof/rules.json', '.proof/config.json', '.proof/allowed_signers', '.proof/exceptions.json'] }),
    withFacts({ code: 'ci_config_changed', detail: CI_CHANGE, blocking: true }, { files: ['.github/workflows/ci.yml'] }),
    { code: 'uncovered', detail: 'warning only', blocking: false },
  ]);
  assert.equal(policy.only, true);
  assert.equal(policy.needs.length, 1);
  assert.ok(policy.needs[0].files.includes('.proof/rules.json') && policy.needs[0].files.includes('.github/workflows/ci.yml'));

  // A local-only pass needs a re-run, not a label; a failed proof needs a fix.
  assert.equal(approvalSummary([withFacts({ code: 'test_change', detail: 'existing tests or test setup changed (t.js); the mechanical check passed only locally (re-run verify with --rerun to check it here). Re-run with --accept-test-change once a person approves', blocking: true }, { files: ['t.js'], variant: 'local_only' })]).only, false);
  assert.equal(approvalSummary([testChange(TEST_CHANGE, ['test/math.test.js']), { code: 'failed_proof', detail: 'p-1: o1 failed', blocking: true }]).only, false);
  assert.equal(approvalSummary([testChange(TEST_CHANGE, ['test/math.test.js'])], [{ packet: 'p-1', problem: 'failed' }]).only, false);
  assert.equal(approvalSummary([]).only, false);
});

test('the approval annotation round-trips, and older verify messages are read too', () => {
  const s = approvalSummary([withFacts({ code: 'ci_config_changed', detail: `${CI_CHANGE} 100%`, blocking: true }, { files: ['.github/workflows/ci.yml'] })]);
  const line = approvalAnnotation(s);
  assert.match(line, /^::notice title=POCP approval needed::/);
  // GitHub un-escapes the workflow command before storing the message.
  const message = line.split('::').slice(2).join('::').replace(/%0A/g, '\n').replace(/%0D/g, '\r').replace(/%25/g, '%');
  assert.deepEqual(readAnnotations([{ annotation_level: 'notice', title: 'POCP approval needed', message }]).needs, s.needs);
  assert.equal(approvalAnnotation(approvalSummary([{ code: 'failed_proof', detail: 'x', blocking: true }])), null);

  const old = readAnnotations([{ annotation_level: 'failure', title: 'POCP', message: `0123456789ab ${TEST_CHANGE} | ${CI_CHANGE}` }]);
  assert.equal(old.only, true);
  assert.equal(old.inferred, true);
  assert.deepEqual(old.needs.map((n) => n.label).sort(), ['pocp-approve-policy', 'pocp-approve-tests']);
  assert.equal(readAnnotations([{ annotation_level: 'failure', title: 'POCP', message: `0123456789ab ${TEST_CHANGE} | p-1: no proof for this code` }]).only, false);
  assert.equal(readAnnotations([{ annotation_level: 'failure', title: 'Lint', message: 'x' }]), null);
});

test('verify on GitHub Actions marks a run that waits only for an approval', () => {
  const dir = sampleRepo({ hooks: true });
  write(dir, '.github/workflows/ci.yml', 'on: push\n');
  git(dir, 'add', '-A');
  assert.equal(pocp(dir, ['fix', '--intent', 'add a CI workflow']).code, 0);
  git(dir, 'commit', '-q', '-m', 'ci');
  const r = pocp(dir, ['verify', 'HEAD~1..HEAD', '--rerun', '--require-coverage'], { env: { GITHUB_ACTIONS: 'true' } });
  assert.equal(r.code, 1);
  const line = r.stdout.split('\n').find((l) => l.startsWith('::notice title=POCP approval needed::'));
  assert.ok(line, r.stdout);
  const { needs } = JSON.parse(line.split('::').slice(2).join('::'));
  assert.deepEqual(needs.map((n) => [n.label, n.files]), [['pocp-approve-policy', ['.github/workflows/ci.yml']]]);
  const j = pocp(dir, ['verify', 'HEAD~1..HEAD', '--rerun', '--json']);
  assert.equal(j.json.approval.only, true);
  // Approved: passes, and nothing is waiting.
  const ok = pocp(dir, ['verify', 'HEAD~1..HEAD', '--rerun', '--accept-policy-change'], { env: { GITHUB_ACTIONS: 'true' } });
  assert.equal(ok.code, 0, ok.stdout);
  assert.doesNotMatch(ok.stdout, /approval needed/);
});

test('pocp approvals lists every PR waiting for a label across your repos, and changes nothing', () => {
  const gh = fakeGh(siteTable());
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pocp-anywhere-')));
  const r = pocp(dir, ['approvals', '--json'], { env: { POCP_GH: gh.bin } });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.json.repos, ['me/site']);
  assert.equal(r.json.pending, 1);
  assert.deepEqual(r.json.items.map((i) => [i.number, i.state]), [[1, 'pending'], [3, 'approved'], [2, 'blocked']]);
  const [first] = r.json.items;
  assert.equal(first.needs[0].label, 'pocp-approve-tests');
  assert.deepEqual(first.needs[0].files, [{ path: 'test/math.test.js', additions: 1, deletions: 2 }]);

  const human = pocp(dir, ['approvals'], { env: { POCP_GH: gh.bin } });
  assert.match(human.stdout, /1 pull request\(s\) waiting for an approval in 1 repository/);
  assert.match(human.stdout, /me\/site#1 {2}Loosen a test\n.*\n {4}needs pocp-approve-tests: existing tests or test setup changed\n.*2 of 10 planted bugs.*\n {6}test\/math\.test\.js {2}\+1 -2\n {4}to approve: pocp approvals --approve me\/site#1/);
  assert.match(human.stdout, /approved, waiting for verify to run again:\n {4}me\/site#3/);
  assert.match(human.stdout, /a label will not fix these\):\n {4}me\/site#2 {2}Broken change/);
  assert.doesNotMatch(human.stdout, /All good/);
  // Listing only reads.
  assert.ok(!gh.calls().some((c) => c.startsWith('pr edit') || c.includes('-X')), gh.calls().join('\n'));
});

test('--approve refuses without a person at a terminal, before touching GitHub', () => {
  const gh = fakeGh(siteTable());
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pocp-anywhere-')));
  const r = pocp(dir, ['approvals', '--approve', 'me/site#1'], { env: { POCP_GH: gh.bin } });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /must be run by a person at a terminal/);
  assert.match(r.stderr, /An agent must never approve a change/);
  assert.deepEqual(gh.calls(), []);
});

test('--approve shows the change being approved and adds the label only when the person types the number', async () => {
  const gh = fakeGh(siteTable());
  const saved = process.env.POCP_GH;
  process.env.POCP_GH = gh.bin;
  try {
    const said = [];
    const say = (l) => said.push(l);
    const no = await approvePr({ ref: 'https://github.com/me/site/pull/1', interactive: true, ask: async () => 'yes', say });
    assert.deepEqual(no, { approved: [], skipped: ['pocp-approve-tests'] });
    assert.ok(!gh.calls().some((c) => c.startsWith('pr edit')));
    const text = said.join('\n');
    assert.match(text, /pocp-approve-tests approves a change to existing tests or test setup/);
    assert.match(text, /2 of 10 planted bugs/);
    // Only the test file's diff: that is what the label approves.
    assert.match(text, /-assert\.equal\(add\(2, 3\), 5\);/);
    assert.doesNotMatch(text, /src\/math\.js/);

    const prompts = [];
    const yes = await approvePr({ ref: 'me/site#1', interactive: true, ask: async (q) => { prompts.push(q); return ' 1 '; }, say });
    assert.deepEqual(yes.approved, ['pocp-approve-tests']);
    assert.match(prompts[0], /Add pocp-approve-tests to me\/site#1\? Type 1 to approve/);
    assert.deepEqual(gh.calls().filter((c) => c.startsWith('pr edit')), ['pr edit 1 --repo me/site --add-label pocp-approve-tests']);

    // Already approved: nothing to ask. Blocked for another reason: a label would not help.
    assert.deepEqual(await approvePr({ ref: '3', repo: 'me/site', interactive: true, ask: async () => '3', say }), { approved: [], skipped: [] });
    await assert.rejects(approvePr({ ref: 'me/site#2', interactive: true, ask: async () => '2', say }), /fails for more than an approval/);
    assert.equal(gh.calls().filter((c) => c.startsWith('pr edit')).length, 1);
    await assert.rejects(approvePr({ ref: 'me/site#1', interactive: false, ask: async () => '1', say }), /person at a terminal/);
  } finally {
    if (saved === undefined) delete process.env.POCP_GH;
    else process.env.POCP_GH = saved;
  }
});

test('--approve adds nothing if the PR got new commits while it was being read', async () => {
  const table = siteTable();
  const view = table[`pr view 1 --repo me/site --json ${PR_FIELDS},state`].body;
  table[`pr view 1 --repo me/site --json ${PR_FIELDS},state`] = { id: 'view1', seq: [{ body: view }, { body: { ...view, headRefOid: SHA('e') } }] };
  const gh = fakeGh(table);
  const saved = process.env.POCP_GH;
  process.env.POCP_GH = gh.bin;
  try {
    await assert.rejects(approvePr({ ref: 'me/site#1', interactive: true, ask: async () => '1', say: () => {} }), /got new commits while you were reviewing/);
    assert.ok(!gh.calls().some((c) => c.startsWith('pr edit')));
  } finally {
    if (saved === undefined) delete process.env.POCP_GH;
    else process.env.POCP_GH = saved;
  }
});

test('live mode: a passing verify run that waits for approvals is listed, and one answer adds every listed label', async () => {
  const table = siteTable();
  const pr = { number: 5, title: 'Tests and CI', url: 'https://github.com/me/site/pull/5', author: { login: 'bot' }, headRefOid: SHA('f'), labels: [], files: [{ path: 'test/math.test.js', additions: 1, deletions: 2 }, { path: '.github/workflows/ci.yml', additions: 3, deletions: 0 }], isDraft: false };
  table[`pr view 5 --repo me/site --json ${PR_FIELDS},state`] = { body: { ...pr, state: 'OPEN' } };
  // With POCP_STATUS_LIVE the verify job passes on a wait; its marker says what it waits for.
  table[`api repos/me/site/commits/${SHA('f')}/check-runs?per_page=100`] = { body: { check_runs: [{ id: 50, name: 'verify', status: 'completed', conclusion: 'success' }] } };
  table['api repos/me/site/check-runs/50/annotations?per_page=100'] = { body: [marker([
    { label: 'pocp-approve-tests', kind: 'tests', reasons: [TEST_CHANGE], files: ['test/math.test.js'] },
    { label: 'pocp-approve-policy', kind: 'policy', reasons: [CI_CHANGE], files: ['.github/workflows/ci.yml'] },
  ])] };
  table['pr diff 5 --repo me/site'] = { body: DIFF };
  table['pr edit 5 --repo me/site --add-label pocp-approve-tests --add-label pocp-approve-policy'] = { body: 'ok' };
  const gh = fakeGh(table);
  const saved = process.env.POCP_GH;
  process.env.POCP_GH = gh.bin;
  try {
    const said = [];
    const prompts = [];
    const r = await approvePr({ ref: 'me/site#5', interactive: true, ask: async (q) => { prompts.push(q); return '5'; }, say: (l) => said.push(l) });
    assert.deepEqual(r.approved, ['pocp-approve-tests', 'pocp-approve-policy']);
    assert.equal(prompts.length, 1, 'one answer for every listed approval');
    assert.match(prompts[0], /Add all 2 approvals above \(pocp-approve-tests, pocp-approve-policy\) to me\/site#5\? Type 5/);
    // Both were shown before the question.
    assert.match(said.join('\n'), /pocp-approve-tests approves[\s\S]*pocp-approve-policy approves/);
    assert.deepEqual(gh.calls().filter((c) => c.startsWith('pr edit')), ['pr edit 5 --repo me/site --add-label pocp-approve-tests --add-label pocp-approve-policy']);
    // Any other answer adds nothing at all.
    const none = await approvePr({ ref: 'me/site#5', interactive: true, ask: async () => 'y', say: () => {} });
    assert.deepEqual(none, { approved: [], skipped: ['pocp-approve-tests', 'pocp-approve-policy'] });
    assert.equal(gh.calls().filter((c) => c.startsWith('pr edit')).length, 1);
  } finally {
    if (saved === undefined) delete process.env.POCP_GH;
    else process.env.POCP_GH = saved;
  }
});
