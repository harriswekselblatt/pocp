// The E5 guard speedups must not change any result: the frozen guard (test/guard-v0) and the
// current one run on the same fixtures, and their full result objects, timings removed, must
// be identical: verdict, summary, every check run, the mutants sampled, and caught/missed on
// each side. Fixtures cover every verdict, several seeds and job counts, and mutants whose
// catching check differs from the fastest one (so check order matters to the schedule).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { exec } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runGuardCheck as runNow } from '../src/guard-check.js';
import { runGuardCheck as runV0 } from './guard-v0/guard-check.v0.js';
import { git, write } from './helpers.js';

const MATH = [
  'export function add(a, b) {',
  '  return a + b;',
  '}',
  '',
  'export function isPositive(n) {',
  '  return n > 0;',
  '}',
  '',
  'export function clamp(x, lo, hi) {',
  '  if (x < lo) return lo;',
  '  if (x > hi) return hi;',
  '  return x;',
  '}',
  '',
  'export function both(a, b) {',
  '  return a && b;',
  '}',
  '',
].join('\n');

// Three checks with different speeds and different reach, like unit / engine / full suite:
// fast.check.mjs tests add; slow.check.mjs tests isPositive and clamp; the suite runs every
// *.check.mjs plus its own test of both(). A mutant in clamp or both() is caught only by a
// slower check, so the fastest-first order and the catching check differ.
const FAST = "import { add } from '../src/math.js';\nif (add(2, 3) !== 5) process.exit(1);\n";
const SLOW = [
  "import { isPositive, clamp } from '../src/math.js';",
  'await new Promise((r) => setTimeout(r, 150));',
  'if (isPositive(1) !== true || isPositive(-1) !== false || isPositive(0) !== false) process.exit(1);',
  'if (clamp(5, 0, 3) !== 3 || clamp(-1, 0, 3) !== 0 || clamp(2, 0, 3) !== 2) process.exit(1);',
  '',
].join('\n');
const SUITE_EXTRA = "import { both } from '../src/math.js';\nif (both(true, false) !== false || both(true, true) !== true) process.exit(1);\n";

const CHECKS = [
  { id: 'fast', run: 'node test/fast.check.mjs' },
  { id: 'slow', run: 'node test/slow.check.mjs' },
  { id: 'suite', run: 'sleep 0.3; for f in test/*.check.mjs test/extra.suite.mjs; do node "$f" || exit 1; done' },
];

function repo(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pocp-equiv-'));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 't@example.invalid');
  git(dir, 'config', 'user.name', 't');
  for (const [rel, text] of Object.entries({ 'src/math.js': MATH, 'test/fast.check.mjs': FAST, 'test/slow.check.mjs': SLOW, 'test/extra.suite.mjs': SUITE_EXTRA, ...files.base })) write(dir, rel, text);
  git(dir, 'add', '-A');
  git(dir, '-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', 'base');
  const base = git(dir, 'rev-parse', 'HEAD');
  for (const [rel, text] of Object.entries(files.change)) write(dir, rel, text);
  git(dir, 'add', '-A');
  git(dir, '-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', 'change');
  const rev = git(dir, 'rev-parse', 'HEAD');
  const changes = Object.keys(files.change).filter((f) => f.startsWith('test/')).map((p) => ({ status: 'M', path: p, kind: 'test' }));
  return { dir, base, rev, changes };
}

function runObligation(ob, dir) {
  const t = Date.now();
  return new Promise((resolve) => {
    exec(ob.run, { cwd: dir, shell: '/bin/sh', timeout: 60_000 }, (err) => {
      const exit = err ? (typeof err.code === 'number' ? err.code : null) : 0;
      resolve({ passed: exit === 0, exit, timed_out: Boolean(err?.killed), signal: err?.signal || null, duration_ms: Date.now() - t });
    });
  });
}

/** The result with every timing removed (timings are the only thing allowed to differ). */
function normalize(x) {
  if (Array.isArray(x)) return x.map(normalize);
  if (x && typeof x === 'object') {
    const out = {};
    for (const k of Object.keys(x).sort()) if (k !== 'duration_ms') out[k] = normalize(x[k]);
    return out;
  }
  return x;
}

const SCENARIOS = {
  // A stronger test: kept.
  kept: { change: { 'test/slow.check.mjs': `${SLOW}if (clamp(3, 0, 3) !== 3) process.exit(1);\n` } },
  // clamp's assertions dropped: mutants in clamp that only the slow check caught are lost.
  dropped: { change: { 'test/slow.check.mjs': SLOW.replace(/\nif \(clamp[^\n]*/, '') } },
  // Code changed and the test gutted: the old tests fail on the new code, pass at the base.
  changed: { change: { 'src/math.js': MATH.replace('a + b', 'a - b'), 'test/fast.check.mjs': 'process.exit(0);\n' } },
  // The old tests already fail at the base.
  red: { base: { 'test/fast.check.mjs': `${FAST}process.exit(3);\n` }, change: { 'test/fast.check.mjs': 'process.exit(0);\n' } },
  // The new tests fail on the new code: nothing to compare (mutants must not run or count).
  newfail: { change: { 'test/slow.check.mjs': `${SLOW}process.exit(4);\n` } },
};

async function both(fx, opts) {
  const args = { root: fx.dir, base: fx.base, rev: fx.rev, changes: fx.changes, checks: CHECKS, sourceGlobs: ['src/**'], links: [], guardGlobs: { test: ['test/**'], runner: [] }, runObligation, ...opts };
  const a = await runV0(args);
  const b = await runNow(args);
  return { a, b };
}

for (const [name, files] of Object.entries(SCENARIOS)) {
  test(`guard results identical before and after the speedups: ${name}`, async () => {
    const fx = repo({ base: {}, ...files });
    const verdicts = new Set();
    for (const [seed, mutants, jobs] of [[1, 10, 4], [2, 12, 1], [3, 8, 3], [7, 1, 2]]) {
      const { a, b } = await both(fx, { seed, mutants, jobs });
      assert.deepEqual(normalize(b), normalize(a), `${name} seed ${seed} mutants ${mutants} jobs ${jobs}`);
      verdicts.add(a.verdict);
    }
    const expected = { kept: 'passed', dropped: 'detection-dropped', changed: 'behavior-changed', red: 'baseline-red', newfail: 'inconclusive' }[name];
    assert.ok(verdicts.has(expected), `${name} reaches ${expected} (got ${[...verdicts].join(', ')})`);
  });
}

test('the fixtures exercise mutants caught only by a slower check, on both sides', async () => {
  const fx = repo({ base: {}, ...SCENARIOS.kept });
  const seen = [];
  const spy = async (ob, dir, o) => {
    const r = await runObligation(ob, dir, o);
    seen.push({ id: ob.id, log: o?.logName || '', passed: r.passed });
    return r;
  };
  const res = await runNow({ root: fx.dir, base: fx.base, rev: fx.rev, changes: fx.changes, checks: CHECKS, sourceGlobs: ['src/**'], links: [], guardGlobs: { test: ['test/**'], runner: [] }, runObligation: spy, seed: 1, mutants: 12, jobs: 2 });
  assert.equal(res.verdict, 'passed');
  const caughtBySlow = seen.filter((s) => /-m\d+-old-/.test(s.log) && !s.passed && s.id !== 'fast');
  assert.ok(caughtBySlow.length > 0, 'some old-side mutant is caught by a check other than the fastest');
});

test('a timed-out guard run and inconclusive verdicts match too', async () => {
  const fx = repo({ base: {}, change: { 'test/fast.check.mjs': `${FAST}// note\n` } });
  // No source to mutate: inconclusive.
  const { a, b } = await both(fx, { seed: 1, mutants: 5, jobs: 2, sourceGlobs: ['nothing/**'] });
  assert.equal(a.verdict, 'inconclusive');
  assert.deepEqual(normalize(b), normalize(a));
  // No checks at all.
  const r2 = await both(fx, { seed: 1, mutants: 5, checks: [] });
  assert.deepEqual(normalize(r2.b), normalize(r2.a));
});

test('on the new side, the check that caught the mutant on the old side runs first', async () => {
  const fx = repo({ base: {}, ...SCENARIOS.kept });
  const seen = [];
  const spy = async (ob, dir, o) => {
    const r = await runObligation(ob, dir, o);
    seen.push({ id: ob.id, log: o?.logName || '', passed: r.passed });
    return r;
  };
  await runNow({ root: fx.dir, base: fx.base, rev: fx.rev, changes: fx.changes, checks: CHECKS, sourceGlobs: ['src/**'], links: [], guardGlobs: { test: ['test/**'], runner: [] }, runObligation: spy, seed: 1, mutants: 12, jobs: 1 });
  let reordered = 0;
  for (const i of new Set(seen.map((s) => /-m(\d+)-/.exec(s.log)?.[1]).filter(Boolean))) {
    const killer = seen.find((s) => s.log.includes(`-m${i}-old-`) && !s.passed)?.id;
    const firstNew = seen.find((s) => s.log.includes(`-m${i}-new-`))?.id;
    if (!killer || !firstNew) continue;
    assert.equal(firstNew, killer, `mutant ${i}`);
    if (killer !== 'fast') reordered++;
  }
  assert.ok(reordered > 0, 'some mutant caught by a slower check skipped the faster ones on the new side');
});

test('mutants start while the old-tests baseline runs, within the job limit, and stop if it fails', async () => {
  for (const [name, expectMutantsAfterFail] of [['kept', null], ['changed', false]]) {
    const fx = repo({ base: {}, ...SCENARIOS[name] });
    const runs = [];
    let inFlight = 0;
    let peak = 0;
    const spy = async (ob, dir, o) => {
      const rec = { log: o?.logName || '', start: Date.now() };
      runs.push(rec);
      peak = Math.max(peak, ++inFlight);
      const r = await runObligation(ob, dir, o);
      inFlight--;
      rec.end = Date.now();
      return r;
    };
    const res = await runNow({ root: fx.dir, base: fx.base, rev: fx.rev, changes: fx.changes, checks: CHECKS, sourceGlobs: ['src/**'], links: [], guardGlobs: { test: ['test/**'], runner: [] }, runObligation: spy, seed: 1, mutants: 8, jobs: 2 });
    assert.ok(peak <= 2, `${name}: at most 2 checks at once (saw ${peak})`);
    const oldEnd = Math.max(...runs.filter((r) => /-old-(fast|slow|suite)$/.test(r.log) && !/-m\d+-/.test(r.log)).map((r) => r.end));
    const mutantRuns = runs.filter((r) => /-m\d+-/.test(r.log));
    assert.ok(mutantRuns.some((r) => r.start < oldEnd), `${name}: a mutant ran during the baseline`);
    if (expectMutantsAfterFail === false) {
      assert.equal(res.verdict, 'behavior-changed');
      assert.equal(res.detection.result, 'not-run');
      const firstFail = runs.find((r) => /-old-fast$/.test(r.log) && !/-m\d+-/.test(r.log)).end;
      assert.ok(!mutantRuns.some((r) => r.start > firstFail), 'no mutant check starts after the baseline\'s first failure');
    }
  }
});
