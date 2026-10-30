import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as pocpMutants from '../../../src/mutants.js';
import { applyLocation, classifyPocp, classifyStryker, keyOf, lineDiff, mutatePattern, pairCategory, pocpEditSet, sampleMutants, sliceLocation, summarize, toCorpusEntry } from '../lib.js';
import { shouldIgnoreLoc } from '../stryker-sample-ignorer.js';
import { blindSpots, buildPairs, nodeCheck, renderResults, strykerByKey } from '../report.js';
import { buildCorpus } from '../run-pocp.js';

const SRC = 'export function add(a, b) {\n  return a + b;\n}\n\nexport function isPositive(n) {\n  return n > 0;\n}\n';
const loc = (sl, sc, el, ec) => ({ start: { line: sl, column: sc }, end: { line: el, column: ec } });
const PLUS = { file: 'src/math.js', mutatorName: 'ArithmeticOperator', replacement: 'a - b', location: loc(2, 10, 2, 15) };
const GT = { file: 'src/math.js', mutatorName: 'EqualityOperator', replacement: 'n >= 0', location: loc(6, 10, 6, 15) };
const BLOCK = { file: 'src/math.js', mutatorName: 'BlockStatement', replacement: '{}', location: loc(5, 31, 7, 2) };

test('locations are 1-based with an exclusive end, like the Stryker report', () => {
  assert.equal(sliceLocation(SRC, PLUS.location), 'a + b');
  assert.equal(sliceLocation(SRC, BLOCK.location), '{\n  return n > 0;\n}');
  assert.equal(applyLocation(SRC, BLOCK.location, '{}').split('\n')[4], 'export function isPositive(n) {}');
  // Stryker's mutate ranges take 1-based lines and 0-based (Babel) columns.
  assert.equal(mutatePattern('src/math.js', PLUS.location), 'src/math.js:2:9-2:14');
  assert.deepEqual(toCorpusEntry('src/math.js', { id: '7', ...PLUS }, SRC), {
    id: '7', file: 'src/math.js', mutator: 'ArithmeticOperator', start: { line: 2, column: 10 }, end: { line: 2, column: 15 }, replacement: 'a - b', original: 'a + b',
  });
});

test('the corpus applies through POCP exactly as the shared helper applies it', () => {
  for (const m of [PLUS, GT, BLOCK]) {
    const entry = toCorpusEntry(m.file, m, SRC);
    assert.equal(pocpMutants.applyCorpusEdit(SRC, entry).mutatedText, applyLocation(SRC, m.location, m.replacement));
  }
  const corpus = buildCorpus({ mutants: [{ ...PLUS, key: keyOf(PLUS) }] }, () => SRC);
  assert.equal(corpus[0].id, keyOf(PLUS));
  assert.equal(corpus[0].original, 'a + b');
});

test('the sample is seeded, without replacement and independent of input order', () => {
  const pop = Array.from({ length: 50 }, (_, i) => ({ file: `src/f${i % 5}.js`, mutatorName: 'X', replacement: String(i), location: loc(i + 1, 1, i + 1, 2) }));
  const a = sampleMutants(pop, 10, 7).map(keyOf);
  const b = sampleMutants([...pop].reverse(), 10, 7).map(keyOf);
  assert.deepEqual(a, b);
  assert.equal(new Set(a).size, 10);
  assert.notDeepEqual(sampleMutants(pop, 10, 8).map(keyOf), a);
  assert.equal(sampleMutants(pop, 500, 1).length, 50);
});

test('one rule set classifies both paths', () => {
  assert.equal(classifyStryker('Killed'), 'detected');
  assert.equal(classifyStryker('Survived'), 'undetected');
  assert.equal(classifyStryker('NoCoverage'), 'undetected');
  assert.equal(classifyStryker('Timeout'), 'timeout');
  assert.equal(classifyStryker('CompileError'), 'invalid');
  assert.equal(classifyStryker('RuntimeError'), 'error');
  assert.equal(classifyStryker('Ignored'), 'not-run');
  assert.equal(classifyPocp('caught'), 'detected');
  assert.equal(classifyPocp('missed'), 'undetected');
  assert.equal(classifyPocp('timeout'), 'timeout');
  assert.equal(classifyPocp('gone'), 'not-run');
  assert.equal(classifyPocp('error'), 'error');

  assert.equal(pairCategory({ valid: true, stryker: 'Killed', pocp: 'caught' }).category, 'agree');
  assert.equal(pairCategory({ valid: true, stryker: 'Survived', pocp: 'missed' }).category, 'agree');
  assert.equal(pairCategory({ valid: true, stryker: 'Killed', pocp: 'missed' }).category, 'disagree');
  // Priority: invalid beats everything, then equivalent, not-run, error, timeout.
  assert.equal(pairCategory({ valid: false, stryker: 'Killed', pocp: 'caught' }).category, 'invalid');
  assert.equal(pairCategory({ valid: true, stryker: 'CompileError', pocp: 'caught' }).category, 'invalid');
  assert.equal(pairCategory({ valid: true, equivalent: true, stryker: 'Survived', pocp: 'missed' }).category, 'equivalent');
  assert.equal(pairCategory({ valid: true, stryker: 'Killed', pocp: 'gone' }).category, 'not-run');
  assert.equal(pairCategory({ valid: true, stryker: 'Timeout', pocp: 'caught' }).category, 'timeout');
  assert.equal(pairCategory({ valid: true, stryker: 'Killed', pocp: 'timeout' }).category, 'timeout');
  assert.equal(pairCategory({ valid: true, stryker: 'RuntimeError', pocp: 'timeout' }).category, 'error');

  const s = summarize([
    { file: 'a', category: 'agree', s: 'detected', p: 'detected' },
    { file: 'a', category: 'disagree', s: 'detected', p: 'undetected' },
    { file: 'b', category: 'agree', s: 'undetected', p: 'undetected' },
    { file: 'b', category: 'timeout', s: 'timeout', p: 'detected' },
  ]);
  assert.deepEqual(s.by_category, { agree: 2, disagree: 1, timeout: 1 });
  assert.deepEqual(s.per_file.agreement, { a: { k: 1, n: 2 }, b: { k: 1, n: 1 } });
  assert.deepEqual(s.per_file.stryker, { a: { k: 2, n: 2 }, b: { k: 0, n: 1 } });
  assert.deepEqual(s.per_file.pocp, { a: { k: 1, n: 2 }, b: { k: 0, n: 1 } });
});

test('the sample ignorer drops only nodes nested inside a sampled range', () => {
  // Babel coordinates (0-based columns).
  const block = loc(5, 30, 7, 1);
  const inner = loc(6, 9, 6, 14);
  assert.equal(shouldIgnoreLoc(block, [block]), undefined, 'the sampled node itself');
  assert.match(shouldIgnoreLoc(inner, [block]), /nested/);
  assert.equal(shouldIgnoreLoc(inner, [block, inner]), undefined, 'a nested node that is sampled too');
  assert.equal(shouldIgnoreLoc(loc(6, 2, 6, 15), [block, inner]), undefined, 'a node around a sampled one');
  assert.equal(shouldIgnoreLoc(loc(1, 0, 3, 1), [block]), undefined, 'outside every range');
});

test('POCP edit set and blind spots compare whole files, ignoring whitespace', () => {
  const set = pocpEditSet(SRC, pocpMutants);
  assert.ok(set.has(applyLocation(SRC, PLUS.location, 'a - b').replace(/\s+/g, '')));
  assert.ok(!set.has(applyLocation(SRC, GT.location, 'n >= 0').replace(/\s+/g, '')), 'POCP flips > to <=, never to >=');
  const pop = [PLUS, GT, BLOCK, { ...GT, replacement: 'n <= 0' }];
  const b = blindSpots(pop, () => SRC, pocpMutants);
  assert.deepEqual(b.stryker_kinds.ArithmeticOperator, { total: 1, pocp_can: 1 });
  assert.deepEqual(b.stryker_kinds.EqualityOperator, { total: 2, pocp_can: 1 });
  assert.deepEqual(b.stryker_kinds.BlockStatement, { total: 1, pocp_can: 0 });
  assert.deepEqual(b.pocp_operators.plus, { total: 1, stryker_can: 1 });
  assert.deepEqual(b.pocp_operators.gt, { total: 1, stryker_can: 1 });
  assert.deepEqual(b.pocp_operators['zero-one'], { total: 1, stryker_can: 0 });
});

test('pairs, validity check and the generated report', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'e3-test-'));
  assert.equal(nodeCheck(SRC, tmp), true);
  assert.equal(nodeCheck('export function (', tmp), false);
  const BROKEN = { file: 'src/math.js', mutatorName: 'StringLiteral', replacement: '(', location: loc(2, 10, 2, 15) };
  const sampled = [PLUS, GT, BLOCK, BROKEN].map((m) => ({ ...m, key: keyOf(m) }));
  const stryker = { files: { 'src/math.js': { source: SRC, mutants: [
    { id: '1', ...PLUS, status: 'Killed', killedBy: [] },
    { id: '2', ...GT, status: 'Survived' },
    { id: '3', ...BLOCK, status: 'Killed' },
    { id: '4', ...BROKEN, status: 'Killed' },
    { id: '5', ...GT, replacement: 'n <= 0', status: 'Killed' },
    { id: '6', ...PLUS, location: loc(2, 10, 2, 11), mutatorName: 'X', replacement: 'b', status: 'Ignored' },
  ].map(({ file, ...m }) => m) } } };
  assert.equal(strykerByKey(stryker).size, 6);
  const pocp = { mutants: [
    { id: sampled[0].key, outcome: 'caught', caught_by: 'unit-tests', ms: 900 },
    { id: sampled[1].key, outcome: 'missed', ms: 2000 },
    { id: sampled[2].key, outcome: 'missed', ms: 2000 },
    { id: sampled[3].key, outcome: 'caught', ms: 100 },
  ] };
  const pairs = buildPairs({ sample: { mutants: sampled }, sources: () => SRC, stryker, pocp, strykerRerun: { files: { 'src/math.js': { mutants: [{ id: '9', ...BLOCK, status: 'Killed' }].map(({ file, ...m }) => m) } } }, pocpRerun: { mutants: [{ id: sampled[2].key, outcome: 'missed' }] }, equivalent: null, tmp });
  assert.deepEqual(pairs.map((p) => p.category), ['agree', 'agree', 'disagree', 'invalid']);
  assert.equal(pairs[3].valid, false);
  assert.deepEqual(pairs[2].rerun, { stryker: 'Killed', pocp: 'missed' });
  assert.match(pairs[2].diff, /^@@ line 5\n- export function isPositive\(n\) \{/);

  const md = renderResults({
    batch: 'b1',
    meta: { pocp_commit: 'abc1234', pocp_verifier_sha256: 'f'.repeat(64), stryker_version: '9.6.1', stryker_timeout_s: 600, stryker_concurrency: 4, pocp_jobs: 4, os: 'darwin', cpus: 8, node: 'v22', stryker_duration_s: 1, pocp_duration_s: 1, own_duration_s: 1, seed: 1 },
    sample: { population: 10, n: 4, seed: 1, sampling: 'srs', mutants: sampled },
    pairs,
    notes: { [sampled[2].key]: 'the block is only reached through a test POCP does not run' },
    own: { total: 2, gone: 0, caught: 1, sites: 3, jobs: 2, seed: 1, mutants: [{ file: 'src/math.js', operator: 'plus', caught: true, outcome: 'caught' }, { file: 'src/math.js', operator: 'gt', caught: false, outcome: 'missed' }] },
    blind: blindSpots([PLUS, GT, BLOCK], () => SRC, pocpMutants),
    extras: { tested: 1, ignored: 1 },
    records: 4,
  });
  assert.match(md, /\*\*Agreement\*\*[^\n]*2\/3 \(67%/);
  assert.match(md, /Stryker: \*\*Killed\*\*/);
  assert.match(md, /POCP: \*\*missed\*\*/);
  assert.match(md, /stable/);
  assert.match(md, /only reached through a test/);
  assert.match(md, /not\*\* agreement with Stryker/);
  assert.match(md, /Kinds POCP can't make at all: EqualityOperator, BlockStatement\./);
  assert.match(md, /\| invalid \| 1 \|/);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('lineDiff shows only the changed lines', () => {
  assert.equal(lineDiff('a\nb\nc', 'a\nB\nc'), '@@ line 2\n- b\n+ B');
});
