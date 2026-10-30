import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyze, classifyRun, concurrency, timingRunner } from '../profile-guard.js';
import { renderProfile } from '../profile-report.js';

const ids = { byCommand: new Map([['npm test --silent', 'test-suite']]) };

test('classifyRun reads what a run was from the log name POCP gave it', () => {
  assert.deepEqual(classifyRun({ log: 'guard-p-7d957880-o4-m3-old-engine-tests.log' }, ids), { phase: 'mutant', mutant: 3, side: 'old', check: 'engine-tests' });
  assert.deepEqual(classifyRun({ log: 'guard-p-7d957880-o4-m12-new-test-suite.log' }, ids), { phase: 'mutant', mutant: 12, side: 'new', check: 'test-suite' });
  assert.deepEqual(classifyRun({ log: 'guard-p-7d957880-o4-old-unit-tests.log' }, ids), { phase: 'guard-old', check: 'unit-tests' });
  assert.deepEqual(classifyRun({ log: 'guard-p-7d957880-o4-base-unit-tests.log' }, ids), { phase: 'guard-base', check: 'unit-tests' });
  assert.deepEqual(classifyRun({ log: 'r-1234.log', command: 'npm test --silent' }, ids), { phase: 'plain', check: 'test-suite' });
});

test('concurrency: average and peak runs in flight', () => {
  const c = concurrency([{ start_ms: 0, end_ms: 10 }, { start_ms: 0, end_ms: 5 }, { start_ms: 5, end_ms: 10 }], 0, 10);
  assert.equal(c.peak, 2);
  assert.equal(c.avg, 2);
  assert.equal(concurrency([{ start_ms: 0, end_ms: 5 }], 0, 10).avg, 0.5);
});

test('timingRunner records without changing the result', async () => {
  const inner = { kind: 'x', run: async () => ({ exit: 3, duration_ms: 7, timed_out: false, output: 'o' }) };
  const t = timingRunner(inner, Date.now());
  const r = await t.runner.run('cmd', { logFile: '/tmp/guard-p-1-o1-old-a.log' });
  assert.deepEqual(r, { exit: 3, duration_ms: 7, timed_out: false, output: 'o' });
  assert.equal(t.runs[0].log, 'guard-p-1-o1-old-a.log');
  assert.equal(t.runs[0].exit, 3);
});

function fakeRaw() {
  const run = (log, s, e, exit = 0) => ({ log, start_ms: s, end_ms: e, exit, timed_out: false, ...classifyRun({ log }, ids) });
  return {
    label: 'before', commit: 'ca3e9f6aaaa', started_at: '2026-10-28T00:00:00.000Z', cpus: 8, cpu_model: 'M', pins: { os: 'darwin', node: 'v22' },
    total_ms: 1000, load: [{ t_ms: 0, load1: 4 }],
    runs: [
      run('guard-p-1-o4-old-fast.log', 100, 110), run('guard-p-1-o4-old-test-suite.log', 110, 200),
      run('guard-p-1-o4-m0-old-fast.log', 210, 220), run('guard-p-1-o4-m0-old-test-suite.log', 220, 300, 1),
      run('guard-p-1-o4-m0-new-fast.log', 300, 310), run('guard-p-1-o4-m0-new-test-suite.log', 310, 390, 1),
      run('guard-p-1-o4-m1-old-fast.log', 210, 215, 1), run('guard-p-1-o4-m1-new-fast.log', 215, 220, 1),
    ],
    proofs: [{ kind: 'guard', started_at: '2026-10-28T00:00:00.090Z', duration_ms: 400, guard: { verdict: 'passed', checks: [{ id: 'fast' }, { id: 'test-suite' }], new_tests: { runs: [{ reused: true }, { reused: true }] }, detection: { mutants: [{ file: 'a.js', line: 1, operator: 'and', old: 'caught', new: 'caught' }, { file: 'b.js', line: 2, operator: 'or', old: 'caught', new: 'caught' }] } } }],
    microbench: { tree_snapshot_ms: [5], copy_snapshot_ms: [2] },
  };
}

test('analyze: phases, killers, full-suite runs and the killer-first saving', () => {
  const a = analyze(fakeRaw());
  assert.equal(a.old_baseline_span_ms, 100);
  assert.equal(a.plan_gap_ms, 10);
  assert.equal(a.mutant_phase_ms, 180);
  assert.equal(a.old_caught, 2);
  assert.equal(a.mutants[0].old.killer, 'test-suite');
  assert.equal(a.reached_last_check_old, 1);
  assert.equal(a.full_suite_runs, 2);
  // Mutant 0: caught by the suite on the old side; on the new side "fast" ran first (10 ms) for nothing.
  assert.equal(a.killer_first_saving_check_ms, 10);
  const md = renderProfile([{ file: 'x.json', raw: fakeRaw() }]);
  assert.match(md, /Where the guard's time goes/);
});
