// verify --exit-detail tells a wait apart from a failure: 4 when only a maintainer's approval
// is missing, 5 when something didn't finish, 1 for anything else. A test approval doesn't
// cover a test change whose check didn't finish (a timeout): that needs --accept-inconclusive,
// or a re-run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { approvalSummary, VERIFY_EXIT } from '../src/approvals.js';
import { withFacts } from '../src/finding.js';
import { spawnSync } from 'node:child_process';
import { git, pocp, read, sampleRepo, write } from './helpers.js';

const RULES = {
  requirements: [{ id: 'math-tests', globs: ['src/**', 'test/**'], obligation: { kind: 'test', run: 'node test/math.check.mjs', timeout_ms: 3000 }, source: 'author' }],
};

// As in real use: pocp fix records the proof (the test check may hand off to CI), then the
// commit goes through the hooks.
function commit(dir, message) {
  git(dir, 'add', '-A');
  const fix = pocp(dir, ['fix', '--intent', message]);
  assert.equal(fix.code, 0, fix.stdout + fix.stderr);
  const c = spawnSync('git', ['commit', '-q', '-m', message], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  assert.equal(c.status, 0, c.stderr);
  return git(dir, 'rev-parse', 'HEAD');
}

// A plain commit, without the hooks (setup only).
function setup(dir, message) {
  git(dir, 'add', '-A');
  git(dir, '-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', message);
  return git(dir, 'rev-parse', 'HEAD');
}

function verify(dir, range, ...extra) {
  return pocp(dir, ['verify', range, '--rerun', '--json', ...extra]);
}

const codes = (r) => [...new Set([...(r.json?.commits || []), ...(r.json?.net ? [r.json.net] : [])].flatMap((c) => c.findings || []).filter((f) => f.blocking).map((f) => f.code))];
const findingOf = (r, code) => [...(r.json?.commits || []), ...(r.json?.net ? [r.json.net] : [])].flatMap((c) => c.findings || []).find((f) => f.code === code);

test('only an approval missing: --exit-detail exits 4, plain exit stays 1, the approval clears it', () => {
  const dir = sampleRepo({ rules: RULES, deep: false, hooks: true });
  const base = git(dir, 'rev-parse', 'HEAD');
  // Fast mode: an existing test line changed goes to a person.
  write(dir, 'test/math.check.mjs', read(dir, 'test/math.check.mjs').replace("console.log('math ok');", "console.log('math still ok');"));
  const head = commit(dir, 'reword a test line');
  const range = `${base}..${head}`;
  assert.equal(verify(dir, range).code, 1);
  const r = verify(dir, range, '--exit-detail');
  assert.equal(r.code, VERIFY_EXIT.waiting, r.stdout);
  assert.deepEqual(codes(r), ['test_change']);
  assert.equal(verify(dir, range, '--exit-detail', '--accept-test-change').code, 0);
});

test('a test change whose check timed out is inconclusive: a test approval does not clear it', () => {
  const dir = sampleRepo({ rules: RULES, deep: false, hooks: true });
  const base = git(dir, 'rev-parse', 'HEAD');
  // The new code hangs on isPositive(-1). The changed test no longer calls it, so the new tests
  // and the plain re-run pass, but the old tests hang on the new code: the guard can't finish.
  write(dir, 'src/math.js', read(dir, 'src/math.js').replace('  return n > 0;', '  if (n === -1) for (;;) {}\n  return n > 0;'));
  write(dir, 'test/math.check.mjs', read(dir, 'test/math.check.mjs').replace(' || isPositive(-1) !== false', ''));
  const head = commit(dir, 'hang on -1, drop that check');
  const range = `${base}..${head}`;

  const r = verify(dir, range, '--exit-detail');
  assert.equal(r.code, VERIFY_EXIT.inconclusive, r.stdout);
  assert.deepEqual(codes(r), ['test_inconclusive']);
  assert.match(findingOf(r, 'test_inconclusive').detail, /didn't finish/);
  assert.equal(r.json.approval.outcome, 'inconclusive');
  assert.deepEqual(r.json.approval.needs.map((n) => n.label), ['pocp-approve-inconclusive']);

  // The regression: before, --accept-test-change accepted any guard verdict, timeouts included.
  const testsOnly = verify(dir, range, '--exit-detail', '--accept-test-change');
  assert.equal(testsOnly.code, VERIFY_EXIT.inconclusive, testsOnly.stdout);
  assert.deepEqual(codes(testsOnly), ['test_inconclusive']);

  assert.equal(verify(dir, range, '--exit-detail', '--accept-inconclusive').code, 0);
  // Without --exit-detail, still the old plain exit.
  assert.equal(verify(dir, range).code, 1);
});

test('test_inconclusive blocks whenever test_change does, even with an explicit fail_on list', () => {
  const dir = sampleRepo({ rules: RULES, deep: false, hooks: true });
  const cfgFile = '.proof/config.json';
  const cfg = JSON.parse(read(dir, cfgFile));
  write(dir, cfgFile, `${JSON.stringify({ ...cfg, verify: { ...(cfg.verify || {}), fail_on: ['test_change'] } }, null, 2)}\n`);
  const base = setup(dir, 'explicit fail_on');
  write(dir, 'src/math.js', read(dir, 'src/math.js').replace('  return n > 0;', '  if (n === -1) for (;;) {}\n  return n > 0;'));
  write(dir, 'test/math.check.mjs', read(dir, 'test/math.check.mjs').replace(' || isPositive(-1) !== false', ''));
  const head = commit(dir, 'hang on -1, drop that check');
  const r = verify(dir, `${base}..${head}`, '--exit-detail');
  assert.equal(r.code, VERIFY_EXIT.inconclusive, r.stdout);
  assert.deepEqual(codes(r), ['test_inconclusive']);
});

test('approvalSummary: what is red and what is a yellow wait', () => {
  const tests = withFacts({ code: 'test_change', detail: 'existing tests or test setup changed (t.js); x', blocking: true }, { approval: 'tests', files: ['t.js'] });
  const unfinished = withFacts({ code: 'test_inconclusive', detail: "existing tests or test setup changed (t.js) and the check didn't finish: x", blocking: true }, { files: ['t.js'] });
  const failed = { code: 'missing_packet', detail: 'no packet', blocking: true };
  const timedOut = { code: 'rerun_failed', detail: 'rerun of "x" failed (exit null, timed out)', unfinished: true };
  const ranFailed = { code: 'rerun_failed', detail: 'rerun of "x" failed (exit 1)', unfinished: false };

  assert.equal(approvalSummary([tests]).outcome, 'waiting');
  assert.equal(approvalSummary([tests]).only, true);
  assert.equal(approvalSummary([unfinished]).outcome, 'inconclusive');
  assert.equal(approvalSummary([tests, unfinished]).outcome, 'inconclusive');
  // A re-run that didn't finish waits for a re-run, not a label: not "only approvals".
  const s = approvalSummary([tests], [timedOut]);
  assert.equal(s.outcome, 'inconclusive');
  assert.equal(s.only, false);
  // Anything that ran and failed is red, whatever else is waiting.
  assert.equal(approvalSummary([tests], [ranFailed]).outcome, 'failed');
  assert.equal(approvalSummary([tests, failed]).outcome, 'failed');
  assert.equal(approvalSummary([unfinished], [timedOut, ranFailed]).outcome, 'failed');
  // A re-run failure without the flag (an older record) counts as a real failure.
  assert.equal(approvalSummary([], [{ code: 'rerun_failed', detail: 'x' }]).outcome, 'failed');
});
