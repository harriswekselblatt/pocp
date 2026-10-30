// pocp eval (SPEC §11.2): a mutant whose checks didn't finish normally (a timeout or an error)
// is not measured. It counts neither as caught nor as missed, and the catch rate is
// caught ÷ (caught + missed). Checks after one that timed out still run, so a later check
// that fails normally still catches the mutant.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pocp, sampleRepo } from './helpers.js';

// Long enough that a normal run finishes even on a badly loaded machine.
const TIMEOUT_MS = 4000;
// Hangs when src/math.js holds the marker SLOW (a suite that hits the timeout under load).
const HANG = 'node -e "if (require(\'fs\').readFileSync(\'src/math.js\',\'utf8\').includes(\'SLOW\')) setInterval(() => {}, 1000)"';

test('eval: timeouts are reported apart and left out of the catch rate', () => {
  const dir = sampleRepo({
    rules: {
      triggers: { broad_files: 6, cross_area: { areas: 3, min_files: 4 }, globs: [] },
      requirements: [
        { id: 'hang', glob: 'src/**', obligation: { kind: 'test', run: HANG, timeout_ms: TIMEOUT_MS } },
        { id: 'tests', glob: 'src/**', obligation: { kind: 'test', run: 'sleep 0.5; node test/math.check.mjs', timeout_ms: TIMEOUT_MS } },
      ],
    },
  });
  const corpus = [
    // Caught by `tests`.
    { id: 'k1', file: 'src/math.js', start: { line: 2, column: 10 }, end: { line: 2, column: 15 }, replacement: 'a - b', original: 'a + b' },
    // isPositive(0) is never tested: missed.
    { id: 's1', file: 'src/math.js', start: { line: 6, column: 10 }, end: { line: 6, column: 15 }, replacement: 'n >= 0', original: 'n > 0' },
    // `hang` times out and `tests` passes: nothing measured.
    { id: 't1', file: 'src/math.js', start: { line: 3, column: 2 }, end: { line: 3, column: 2 }, replacement: ' // SLOW' },
    // `hang` (fastest, so first) times out; `tests` still runs and fails normally: caught.
    { id: 't2', file: 'src/math.js', start: { line: 2, column: 10 }, end: { line: 2, column: 15 }, replacement: 'a - b /* SLOW */', original: 'a + b' },
  ];
  const file = path.join(dir, '..', `${path.basename(dir)}-corpus.json`);
  fs.writeFileSync(file, JSON.stringify(corpus));
  const save = path.join(dir, '..', `${path.basename(dir)}-out.json`);
  const r = pocp(dir, ['eval', '--corpus', file, '--jobs', '4', '--save', save, '--json']);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const by = Object.fromEntries(r.json.mutants.map((m) => [m.id, m]));
  assert.equal(by.k1.outcome, 'caught');
  assert.equal(by.s1.outcome, 'missed');
  assert.equal(by.t1.outcome, 'timeout');
  assert.equal(by.t1.caught, null, 'a timeout is neither caught nor missed');
  assert.equal(by.t1.caught_by, null);
  assert.deepEqual(by.t1.not_measured, [{ check: 'hang', reason: 'timed out' }]);
  assert.equal(by.t2.outcome, 'caught', 'a later check that fails normally catches it');
  assert.equal(by.t2.caught, true);
  assert.equal(by.t2.caught_by, 'tests');

  // Before the fix: caught 3 of 4 (timeouts counted). Now 2 of the 3 measured.
  assert.equal(r.json.caught, 2);
  assert.equal(r.json.missed, 1);
  assert.equal(r.json.total, 3, 'total is the measured mutants: caught + missed');
  assert.equal(r.json.not_measured, 1);
  assert.equal(r.json.timeouts, 1);
  assert.equal(r.json.errors, 0);
  assert.equal(r.json.catch_rate, 0.667);
  assert.deepEqual(r.json.by_file['src/math.js'], { total: 3, caught: 2, not_measured: 1 });

  const saved = JSON.parse(fs.readFileSync(save, 'utf8'));
  assert.equal(saved.not_measured, 1);
  assert.equal(saved.mutants.find((m) => m.id === 't1').outcome, 'timeout');

  const human = pocp(dir, ['eval', '--corpus', file, '--jobs', '4']);
  assert.match(human.stdout, /mutation eval \(corpus\): caught 2\/3 \(67%\) · 1 not measured \(1 timed out\), not scored/);
  assert.match(human.stdout, /NOT MEASURED src\/math\.js:3 corpus: hang timed out/);
});

test('eval --replay --missed re-runs the survivors and the mutants that were not measured', () => {
  const dir = sampleRepo();
  const saved = path.join(dir, '..', `${path.basename(dir)}-saved.json`);
  const line = (n) => ['export function add(a, b) {', '  return a + b;', '}', '', 'export function isPositive(n) {', '  return n > 0;', '}'][n - 1];
  fs.writeFileSync(saved, JSON.stringify({
    mutants: [
      { file: 'src/math.js', line: 2, operator: 'plus', line_text: line(2), mutated_line: '  return a - b;', caught: true, outcome: 'caught' },
      { file: 'src/math.js', line: 6, operator: 'gte', line_text: line(6), mutated_line: '  return n >= 0;', caught: false, outcome: 'missed' },
      // An older POCP saved timeouts with caught: true.
      { file: 'src/math.js', line: 6, operator: 'gt', line_text: line(6), mutated_line: '  return n <= 0;', caught: true, outcome: 'timeout' },
      { file: 'src/math.js', line: 6, operator: 'zero-one', line_text: line(6), mutated_line: '  return n > 1;', caught: null, outcome: 'error' },
    ],
  }));
  const r = pocp(dir, ['eval', '--replay', saved, '--missed', '--json']);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.deepEqual(r.json.mutants.map((m) => m.operator), ['gte', 'gt', 'zero-one']);
  assert.deepEqual(r.json.mutants.map((m) => m.outcome), ['missed', 'caught', 'caught']);
});
