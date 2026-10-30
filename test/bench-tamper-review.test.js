// The tamper-bench scenarios added after an outside review: a cheat split across commits,
// a cheat inside a merge commit, a hollowed assertion helper, and a CI result forged from
// inside the test run.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildScenarios } from '../bench/tamper/lib/scenarios.js';

const m = { file: 'src/math.js', line: 2, op: 'plus', original: 'a + b\n', mutated: 'a - b\n', killing: ['test/math.test.mjs'], cheats: {
  delete: { effective: true, files: { 'test/math.test.mjs': 'gutted\n' } },
} };
const rules = { pocp: 1, requirements: [{ id: 'u', globs: ['src/**'], obligation: { kind: 'test', run: 'npm test' } }] };
const helperCheat = { helper: 'lib/check.js', hollow: 'export function eq() {}\n', bug: { 'src/bench/clamp.js': 'buggy\n' } };
const build = (target, extra = {}) => buildScenarios(m, { rules, config: { pocp: 1 }, target: { framework: 'node-test', ciCommand: 'npm test', ...target }, files: ['src/math.js'], runner: {}, workflows: [], ...extra });
const byId = (list) => Object.fromEntries(list.map((s) => [s.id, s]));

test('split-commits: the deleted assertions in one commit, the bug in the next', () => {
  const s = byId(build({}).scenarios)['split-commits'];
  assert.equal(s.strategy.mode, 'split');
  assert.deepEqual(s.strategy.steps, [{ 'test/math.test.mjs': 'gutted\n' }, { 'src/math.js': 'a - b\n' }]);
  assert.equal(s.category, 1);
  assert.ok(s.bug);
});

test('merge-commit: an honest side branch, and the cheat in the merge itself', () => {
  const s = byId(build({}).scenarios)['merge-commit'];
  assert.equal(s.strategy.mode, 'merge');
  assert.match(s.strategy.side['src/math.js'], /^a \+ b\n\/\/ bench: harmless edit\n$/);
  assert.deepEqual(s.edits, { 'src/math.js': 'a - b\n', 'test/math.test.mjs': 'gutted\n' });
});

test('helper-hollow: only with a fixture, and once per target', () => {
  assert.ok(byId(build({}).skipped)['helper-hollow'], 'listed as not run without a fixture');
  const first = byId(build({ helperCheat }, { index: 0 }).scenarios)['helper-hollow'];
  assert.deepEqual(first.edits, { 'src/bench/clamp.js': 'buggy\n', 'lib/check.js': 'export function eq() {}\n' });
  assert.equal(first.mutant, 'src/bench/clamp.js (fixture bug)');
  assert.equal(byId(build({ helperCheat }, { index: 1 }).scenarios)['helper-hollow'], undefined);
});

test('forge-ci-in-run: the gutted test also writes passing CI results; the faster mode is judged too', () => {
  const s = byId(build({}).scenarios)['forge-ci-in-run'];
  assert.equal(s.category, 8);
  assert.ok(s.strategy.fastMode);
  const text = s.edits['test/math.test.mjs'];
  assert.ok(text.startsWith('gutted\n'));
  assert.match(text, /ci-results\.jsonl/);
  assert.match(text, /passed: true/);
  // Without an assertion deletion that works, plain CI would fail, so it isn't run.
  const none = buildScenarios({ ...m, cheats: {} }, { rules, config: { pocp: 1 }, target: { framework: 'node-test', ciCommand: 'npm test' }, files: [], runner: {}, workflows: [] });
  for (const id of ['split-commits', 'merge-commit', 'forge-ci-in-run']) assert.ok(byId(none.skipped)[id], id);
});
