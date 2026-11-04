// A mutant run whose check didn't finish normally (a timeout, a signal, a spawn error, exit
// 126 or 127) says nothing about whether the tests catch that mutant (SPEC §6.2). Under load,
// full suites hit the check timeout; counting that as a catch raised the bar the new tests had
// to meet (a false detection-dropped) or let a hung new-side run count as a catch (a false
// pass). These fixtures use real hangs and the real process runner with a short timeout.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runGuardCheck, unfinishedReason } from '../src/guard-check.js';
import { createProcessRunner } from '../src/runner.js';
import { git, packetId, pocp, read, sampleRepo, write } from './helpers.js';

// Long enough that a normal run finishes even on a badly loaded machine.
const TIMEOUT_MS = 4000;

// Mutation sites: line 2 `a + b` (plus), line 6 `n > 0` (gt → `n <= 0`, zero-one → `n > 1`).
const MATH = 'export function add(a, b) {\n  return a + b;\n}\n\nexport function isPositive(n) {\n  return n > 0;\n}\n';

// A check that never finishes when the code holds `needle`: it stands in for a suite that
// hits the timeout on a loaded machine. It asserts nothing by itself.
const hangOn = (needle) => [
  "import fs from 'node:fs';",
  `if (fs.readFileSync(new URL('../src/math.js', import.meta.url), 'utf8').includes(${JSON.stringify(needle)})) { setInterval(() => {}, 1000); await new Promise(() => {}); }`,
  '',
].join('\n');
const ADD = "import { add } from '../src/math.js';\nif (add(2, 3) !== 5) process.exit(1);\n";
const POSITIVE = "import { isPositive } from '../src/math.js';\nif (isPositive(1) !== true) process.exit(1);\n";
const SLEEP = 'await new Promise((r) => setTimeout(r, 500));\n';

const runner = createProcessRunner();
async function runObligation(ob, dir, opts) {
  const r = await runner.run(ob.run, { cwd: dir, env: process.env, timeoutMs: ob.timeout_ms ?? 60_000, killGraceMs: 200 });
  const res = { passed: r.exit === 0 && !r.timed_out, exit: r.exit, timed_out: r.timed_out, signal: r.signal, error: r.error, duration_ms: r.duration_ms };
  runObligation.seen?.push({ id: ob.id, log: opts?.logName || '', ...res });
  return res;
}

function repo(base, change) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pocp-guard-timeout-')));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 't@example.invalid');
  git(dir, 'config', 'user.name', 't');
  for (const [rel, text] of Object.entries({ 'src/math.js': MATH, ...base })) write(dir, rel, text);
  git(dir, 'add', '-A');
  git(dir, '-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', 'base');
  const baseRev = git(dir, 'rev-parse', 'HEAD');
  for (const [rel, text] of Object.entries(change)) write(dir, rel, text);
  git(dir, 'add', '-A');
  git(dir, '-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', 'change');
  const changes = Object.keys(change).map((p) => ({ status: 'M', path: p, kind: 'test' }));
  return { dir, base: baseRev, rev: git(dir, 'rev-parse', 'HEAD'), changes };
}

function guard(fx, checks, extra = {}) {
  return runGuardCheck({ root: fx.dir, base: fx.base, rev: fx.rev, changes: fx.changes, checks, sourceGlobs: ['src/**'], links: [], guardGlobs: { test: ['test/**'], runner: [] }, runObligation, seed: 1, mutants: 10, jobs: 3, ...extra });
}

const at = (res, line, after) => res.detection.mutants.find((m) => m.line === line && m.after === after);

test('an old-side timeout is not a catch, and a mutant the old tests hang on can\'t pass: inconclusive', async () => {
  // The old test asserts only add(); it hangs (as under load) on the `n <= 0` mutant, which
  // it would otherwise miss. The new test asserts the same thing without the hang.
  const fx = repo({ 'test/a.check.mjs': hangOn('n <= 0') + ADD }, { 'test/a.check.mjs': `${ADD}// tidied\n` });
  const checks = [{ id: 'a', run: 'node test/a.check.mjs', timeout_ms: TIMEOUT_MS }];
  const res = await guard(fx, checks);
  const hung = at(res, 6, 'return n <= 0;');
  assert.ok(hung, 'the hanging mutant was sampled');
  assert.equal(hung.old, 'not-measured', 'a timeout is not a catch');
  assert.equal(hung.new, 'not-run', 'only mutants the old tests really caught run on the new side');
  assert.deepEqual(hung.not_measured, { side: 'old', checks: [{ check: 'a', reason: 'timed out' }] });
  assert.equal(at(res, 2, 'return a - b;').old, 'caught');
  assert.equal(at(res, 6, 'return n > 1;').old, 'missed');
  assert.deepEqual(hung.retried, [{ side: 'old', check: 'a', first: 'timed out', timeout_ms: TIMEOUT_MS * 3, retry: 'timed out' }]);
  // Before the fix this was detection-dropped: the timed-out "catch" became a mutant the new
  // tests had to catch. It isn't a catch, but the old tests may hang on this mutant for real,
  // so the guard can't say the new tests still catch it: a person decides, never a pass.
  assert.equal(res.verdict, 'inconclusive', res.summary);
  assert.equal(res.passed, false);
  assert.equal(res.detection.result, 'inconclusive');
  assert.equal(res.detection.old_caught, 1);
  assert.equal(res.detection.old_not_measured, 1);
  assert.equal(res.detection.not_measured.length, 1);
  assert.match(res.summary, /the old tests didn't finish on 1 of the 3 sampled mutants, even on a retry with 3× the time limit \(e\.g\. src\/math\.js:6 `return n > 0;` → `return n <= 0;`: "node test\/a\.check\.mjs" timed out\): they may hang on it/);
});

test('if every old-side "catch" was a timeout, nothing was measured: inconclusive', async () => {
  // The old test catches nothing normally (it asserts nothing) and hangs on every mutant.
  const fx = repo({ 'test/a.check.mjs': hangOn('') }, { 'test/a.check.mjs': `${hangOn('')}// tidied\n` });
  // hangOn('') hangs on the unmutated code too, so give the baselines a pass: only mutant runs hang.
  const checks = [{ id: 'a', run: 'test -f .mutant && node test/a.check.mjs || true', timeout_ms: TIMEOUT_MS }];
  const marked = async (ob, dir, o) => {
    if (/-m\d+-/.test(o?.logName || '')) fs.writeFileSync(path.join(dir, '.mutant'), '');
    return runObligation(ob, dir, o);
  };
  const res = await guard(fx, checks, { runObligation: marked, mutants: 2 });
  assert.equal(res.verdict, 'inconclusive', res.summary);
  assert.equal(res.detection.result, 'inconclusive');
  assert.equal(res.detection.old_caught, 0);
  assert.equal(res.detection.old_not_measured, 2);
  assert.match(res.summary, /none of the 2 sampled mutants could be measured on the old tests \(e\.g\. src\/math\.js:\d+ .*: "test -f \.mutant.*" timed out, also on a retry with 3× the time limit\)/);
});

test('a new-side timeout on a mutant the old tests caught is inconclusive, not a pass', async () => {
  // Old and new both assert isPositive(1); the new test also hangs on the `n <= 0` mutant.
  const fx = repo({ 'test/a.check.mjs': ADD + POSITIVE }, { 'test/a.check.mjs': hangOn('n <= 0') + ADD + POSITIVE });
  const checks = [{ id: 'a', run: 'node test/a.check.mjs', timeout_ms: TIMEOUT_MS }];
  const res = await guard(fx, checks);
  const hung = at(res, 6, 'return n <= 0;');
  assert.equal(hung.old, 'caught');
  assert.equal(hung.new, 'not-measured');
  assert.deepEqual(hung.not_measured, { side: 'new', checks: [{ check: 'a', reason: 'timed out' }] });
  assert.deepEqual(hung.retried, [{ side: 'new', check: 'a', first: 'timed out', timeout_ms: TIMEOUT_MS * 3, retry: 'timed out' }]);
  // Before the fix the hung run counted as a catch, and the verdict was passed.
  assert.equal(res.verdict, 'inconclusive', res.summary);
  assert.equal(res.passed, false);
  assert.equal(res.detection.result, 'inconclusive');
  assert.equal(res.detection.new_not_measured, 1);
  assert.equal(res.detection.new_caught, 2);
  assert.match(res.summary, /src\/math\.js:6 `return n > 0;` → `return n <= 0;`/);
  assert.match(res.summary, /"node test\/a\.check\.mjs" timed out/);
});

test('after a check times out the rest still run: a later normal failure catches the mutant', async () => {
  // fast (runs first) hangs on `n <= 0`; slow fails normally on it. The new slow check drops
  // its isPositive assertion, so on the new side the mutant is never caught normally.
  const fx = repo(
    { 'test/a.check.mjs': hangOn('n <= 0') + ADD, 'test/b.check.mjs': SLEEP + POSITIVE },
    { 'test/b.check.mjs': `${SLEEP}// isPositive no longer checked\n` },
  );
  const checks = [
    { id: 'fast', run: 'node test/a.check.mjs', timeout_ms: TIMEOUT_MS },
    { id: 'slow', run: 'node test/b.check.mjs', timeout_ms: TIMEOUT_MS },
  ];
  const seen = [];
  runObligation.seen = seen;
  // The guard runs checks fastest first, by their measured times. Under heavy load fast's
  // startup can take longer than slow's 500ms sleep, so slow ran first, caught the mutant,
  // and the timeout path never ran. Reporting slow as a minute slower fixes the order;
  // timeouts and results stay real.
  const slowerSlow = async (ob, dir, opts) => {
    const r = await runObligation(ob, dir, opts);
    return ob.id === 'slow' ? { ...r, duration_ms: r.duration_ms + 60_000 } : r;
  };
  const res = await guard(fx, checks, { runObligation: slowerSlow }).finally(() => delete runObligation.seen);
  const hung = at(res, 6, 'return n <= 0;');
  const i = res.detection.mutants.indexOf(hung);
  const oldRuns = seen.filter((s) => s.log.includes(`-m${i}-old-`)).map((s) => `${s.id}:${s.timed_out ? 'timeout' : s.passed ? 'pass' : 'fail'}`);
  assert.deepEqual(oldRuns, ['fast:timeout', 'fast:timeout', 'slow:fail'], 'retried once, then the slower check still ran');
  assert.equal(hung.old, 'caught', 'caught: a check failed normally');
  // New side: slow (the old catcher) first, passes; then fast hangs. Nothing failed normally.
  const newRuns = seen.filter((s) => s.log.includes(`-m${i}-new-`)).map((s) => `${s.id}:${s.timed_out ? 'timeout' : s.passed ? 'pass' : 'fail'}`);
  assert.deepEqual(newRuns, ['slow:pass', 'fast:timeout', 'fast:timeout']);
  assert.equal(hung.new, 'not-measured');
  // `n > 1` is lost outright (slow passes, fast passes): a measured drop outranks a
  // mutant that couldn't be measured.
  assert.equal(at(res, 6, 'return n > 1;').new, 'missed');
  assert.equal(res.verdict, 'detection-dropped', res.summary);
  assert.deepEqual(res.detection.lost.map((m) => m.after), ['return n > 1;']);
  assert.match(res.summary, /; also, the new tests didn't finish on 1 of the 3 mutants the old tests caught/);
});

test('through pocp prove: a new-side timeout leaves the guard inconclusive and the gate wants a person', () => {
  const RUN_ALL = 'for f in test/*.check.mjs; do node "$f" || exit 1; done';
  const dir = sampleRepo({
    hooks: true,
    rules: { requirements: [{ id: 'math-tests', globs: ['src/**', 'test/**'], obligation: { kind: 'test', run: RUN_ALL, timeout_ms: TIMEOUT_MS }, source: 'author' }] },
  });
  write(dir, 'test/math.check.mjs', hangOn('n <= 0') + read(dir, 'test/math.check.mjs'));
  git(dir, 'add', '-A');
  const opened = pocp(dir, ['open', '--intent', 'test change', '--touch', 'test/math.check.mjs']);
  assert.equal(opened.code, 0, opened.stderr);
  const id = packetId(opened.stdout);
  assert.equal(pocp(dir, ['prove', id]).code, 0);
  const p = JSON.parse(read(dir, `.proof/packets/${id}.json`));
  const ob = p.obligations.find((o) => o.source === 'guard:tests');
  const proof = p.proofs.filter((x) => x.obligation === ob.id).at(-1);
  assert.equal(proof.passed, false);
  assert.equal(proof.guard.verdict, 'inconclusive', proof.guard.summary);
  assert.ok(proof.guard.detection.new_not_measured >= 1);
  const gate = pocp(dir, ['gate']);
  assert.equal(gate.code, 1);
  assert.match(gate.stderr, /the new tests didn't finish on 1 of the \d+ mutants the old tests caught/);
});

test('unfinishedReason names why a run did not finish normally', () => {
  assert.equal(unfinishedReason({ passed: false, exit: null, timed_out: true, signal: 'SIGTERM' }), 'timed out');
  assert.equal(unfinishedReason({ passed: false, exit: null, error: 'spawn /bin/sh ENOENT' }), 'could not start (spawn /bin/sh ENOENT)');
  assert.equal(unfinishedReason({ passed: false, exit: null, signal: 'SIGKILL' }), 'killed by SIGKILL');
  assert.equal(unfinishedReason({ passed: false, exit: 127 }), 'exit 127 (command not found)');
  assert.equal(unfinishedReason({ passed: false, exit: 126 }), 'exit 126 (command not executable)');
  assert.equal(unfinishedReason({ passed: false, exit: null }), 'ended without an exit code');
});

test('old tests that time out on the new code (but pass on the base) are inconclusive, not a behavior change', async () => {
  // The old test hangs only on the new code: it stands in for a suite that hits the timeout
  // there under load, as deep mode's planted-bug runs caused in a timing trial.
  const fx = repo({ 'test/a.check.mjs': hangOn('// v2') + ADD }, { 'src/math.js': `${MATH}// v2\n`, 'test/a.check.mjs': `${ADD}// tidied\n` });
  fx.changes = fx.changes.filter((c) => c.path.startsWith('test/'));
  for (const mutants of [0, 4]) {
    const res = await guard(fx, [{ id: 'a', run: 'node test/a.check.mjs', timeout_ms: TIMEOUT_MS }], { mutants });
    assert.equal(res.old_tests.result, 'fail');
    assert.equal(res.verdict, 'inconclusive', `mutants ${mutants}: ${res.summary}`);
    assert.match(res.summary, /didn't finish on the new code.*says nothing about behavior/);
    assert.notEqual(res.verdict, 'behavior-changed');
  }
});
