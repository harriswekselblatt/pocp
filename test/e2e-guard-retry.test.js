// The test guard retries a mutant run that didn't finish normally once, with 3× the time limit
// it hit (SPEC §6.2). A run that finishes on the retry is measured as usual. A mutant that
// still doesn't finish can never let the guard pass: the old tests may hang on it for real (an
// infinite loop the mutant causes), so whether the new tests still catch it is unknown.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RETRY_FACTOR, runGuardCheck } from '../src/guard-check.js';
import { createProcessRunner } from '../src/runner.js';
import { git, write } from './helpers.js';

// Long enough that a normal run finishes even on a badly loaded machine.
const TIMEOUT_MS = 4000;
// Mutation sites: line 2 `a + b` (plus), line 6 `n > 0` (gt → `n <= 0`, zero-one → `n > 1`).
const MATH = 'export function add(a, b) {\n  return a + b;\n}\n\nexport function isPositive(n) {\n  return n > 0;\n}\n';
const holds = (needle) => `import fs from 'node:fs';\nconst SRC = fs.readFileSync(new URL('../src/math.js', import.meta.url), 'utf8');\nconst HOLDS = SRC.includes(${JSON.stringify(needle)});\n`;
// Never finishes on the mutant: a test the mutant sends into an infinite loop.
const hangOn = (needle) => `${holds(needle)}if (HOLDS) { setInterval(() => {}, 1000); await new Promise(() => {}); }\n`;
// Slower than the 4 s limit on the mutant, well within 3× it: a slow suite on a loaded machine.
const slowOn = (needle) => `${holds(needle)}if (HOLDS) await new Promise((r) => setTimeout(r, 6000));\n`;
const ADD = "import { add } from '../src/math.js';\nif (add(2, 3) !== 5) process.exit(1);\n";
const POSITIVE = "import { isPositive } from '../src/math.js';\nif (isPositive(1) !== true) process.exit(1);\n";

const runner = createProcessRunner();
async function runObligation(ob, dir, opts) {
  const r = await runner.run(ob.run, { cwd: dir, env: process.env, timeoutMs: ob.timeout_ms ?? 60_000, killGraceMs: 200 });
  const res = { passed: r.exit === 0 && !r.timed_out, exit: r.exit, timed_out: r.timed_out, signal: r.signal, error: r.error, duration_ms: r.duration_ms };
  runObligation.seen?.push({ id: ob.id, log: opts?.logName || '', timeout_ms: ob.timeout_ms, ...res });
  return res;
}

function repo(base, change) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pocp-guard-retry-')));
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

async function guard(fx, checks) {
  const seen = [];
  runObligation.seen = seen;
  try {
    const res = await runGuardCheck({ root: fx.dir, base: fx.base, rev: fx.rev, changes: fx.changes, checks, sourceGlobs: ['src/**'], links: [], guardGlobs: { test: ['test/**'], runner: [] }, runObligation, seed: 1, mutants: 10, jobs: 3 });
    return { res, seen };
  } finally {
    delete runObligation.seen;
  }
}

const at = (res, after) => res.detection.mutants.find((m) => m.after === after);
const CHECK = [{ id: 'a', run: 'node test/a.check.mjs', timeout_ms: TIMEOUT_MS }];

test('a run that times out under a short limit but finishes on the retry is measured normally', async () => {
  // Both sides assert isPositive(1), and both are slow on the `n <= 0` mutant.
  const fx = repo({ 'test/a.check.mjs': slowOn('n <= 0') + ADD + POSITIVE }, { 'test/a.check.mjs': `${slowOn('n <= 0') + ADD + POSITIVE}// tidied\n` });
  const { res, seen } = await guard(fx, CHECK);
  const slow = at(res, 'return n <= 0;');
  assert.equal(slow.old, 'caught', 'the retry ran to the end and failed: a catch');
  assert.equal(slow.new, 'caught');
  assert.equal(slow.not_measured, undefined);
  assert.deepEqual(slow.retried, [
    { side: 'old', check: 'a', first: 'timed out', timeout_ms: TIMEOUT_MS * RETRY_FACTOR, retry: 'failed' },
    { side: 'new', check: 'a', first: 'timed out', timeout_ms: TIMEOUT_MS * RETRY_FACTOR, retry: 'failed' },
  ]);
  const retries = seen.filter((s) => s.log.endsWith('-retry'));
  assert.equal(retries.length, 2, 'one retry per side, for that mutant only');
  assert.equal(res.timings.mutants.old.retries, 1, 'the per-phase timings count the retries, per side');
  assert.equal(res.timings.mutants.new.retries, 1);
  assert.ok(retries.every((s) => s.timeout_ms === TIMEOUT_MS * RETRY_FACTOR && !s.timed_out));
  assert.equal(res.verdict, 'passed', res.summary);
  assert.equal(res.detection.result, 'kept');
  assert.equal(res.detection.old_caught, 3);
  assert.equal(res.detection.not_measured, undefined);
});

test('deleting the only test that hangs on a mutant is never a pass: inconclusive', async () => {
  // The old suite has a test that loops forever on the `n <= 0` mutant (that is how it
  // "catches" it); the change empties it. Without the hang, every other mutant is kept.
  const fx = repo(
    { 'test/a.check.mjs': ADD, 'test/loop.check.mjs': hangOn('n <= 0') },
    { 'test/loop.check.mjs': '// removed\n' },
  );
  const checks = [
    { id: 'a', run: 'node test/a.check.mjs', timeout_ms: TIMEOUT_MS },
    { id: 'loop', run: 'node test/loop.check.mjs', timeout_ms: TIMEOUT_MS },
  ];
  const { res, seen } = await guard(fx, checks);
  const hung = at(res, 'return n <= 0;');
  assert.equal(hung.old, 'not-measured');
  assert.equal(hung.new, 'not-run');
  assert.deepEqual(hung.not_measured, { side: 'old', checks: [{ check: 'loop', reason: 'timed out' }] });
  const i = res.detection.mutants.indexOf(hung);
  assert.deepEqual(seen.filter((s) => s.log.includes(`-m${i}-old-loop`)).map((s) => s.timeout_ms), [TIMEOUT_MS, TIMEOUT_MS * RETRY_FACTOR], 'retried once with 3× the limit');
  assert.equal(at(res, 'return a - b;').new, 'caught');
  assert.equal(res.detection.lost.length, 0, 'no measured loss');
  assert.equal(res.verdict, 'inconclusive', res.summary);
  assert.equal(res.passed, false);
  assert.match(res.summary, /the old tests didn't finish on 1 of the 3 sampled mutants, even on a retry with 3× the time limit \(e\.g\. src\/math\.js:6 `return n > 0;` → `return n <= 0;`: "node test\/loop\.check\.mjs" timed out\): they may hang on it \(a real infinite loop\) or the machine may be overloaded/);
  assert.match(res.summary, /a person must decide/);
});

test('when nothing times out, nothing is retried and no new fields appear', async () => {
  const fx = repo({ 'test/a.check.mjs': ADD + POSITIVE }, { 'test/a.check.mjs': `${ADD + POSITIVE}// tidied\n` });
  const { res, seen } = await guard(fx, [{ id: 'a', run: 'node test/a.check.mjs', timeout_ms: 60_000 }]);
  assert.equal(res.verdict, 'passed', res.summary);
  assert.ok(!seen.some((s) => s.log.endsWith('-retry')));
  assert.ok(res.detection.mutants.every((m) => !('retried' in m) && !('not_measured' in m)));
  assert.ok(!('not_measured' in res.detection) && !('old_not_measured' in res.detection));
});
