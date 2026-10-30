import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { applyCorpusEdit } from '../src/mutants.js';
import { pocp, read, sampleRepo } from './helpers.js';

// sampleRepo's src/math.js:
// 1 export function add(a, b) {
// 2   return a + b;
// 3 }
// 4
// 5 export function isPositive(n) {
// 6   return n > 0;
// 7 }
const MATH = 'export function add(a, b) {\n  return a + b;\n}\n\nexport function isPositive(n) {\n  return n > 0;\n}\n';

test('applyCorpusEdit: 1-based columns, exclusive end, original text checked', () => {
  const r = applyCorpusEdit(MATH, { start: { line: 2, column: 10 }, end: { line: 2, column: 15 }, replacement: 'a - b', original: 'a + b' });
  assert.equal(r.gone, undefined);
  assert.equal(r.line, 2);
  assert.equal(r.line_text, '  return a + b;');
  assert.equal(r.mutated_line, '  return a - b;');
  // A multi-line range: the whole function body becomes empty.
  const block = applyCorpusEdit(MATH, { start: { line: 5, column: 31 }, end: { line: 7, column: 2 }, replacement: '{}' });
  assert.equal(block.mutatedText, 'export function add(a, b) {\n  return a + b;\n}\n\nexport function isPositive(n) {}\n');
  // An end column one past the last character of a line is allowed.
  assert.equal(applyCorpusEdit(MATH, { start: { line: 2, column: 3 }, end: { line: 2, column: 16 }, replacement: '' }).mutated_line, '  ');
  assert.match(applyCorpusEdit(MATH, { start: { line: 2, column: 10 }, end: { line: 2, column: 15 }, replacement: 'x', original: 'a * b' }).gone, /no longer at that range/);
  assert.match(applyCorpusEdit(MATH, { start: { line: 40, column: 1 }, end: { line: 40, column: 2 }, replacement: 'x' }).gone, /outside the file/);
  assert.match(applyCorpusEdit(MATH, { start: { line: 2, column: 40 }, end: { line: 2, column: 41 }, replacement: 'x' }).gone, /outside the file/);
  assert.match(applyCorpusEdit(MATH, { start: { line: 2, column: 1 } }).gone, /needs start, end and replacement/);
});

test('eval --corpus runs an outside tool\'s mutants through the required checks', () => {
  const dir = sampleRepo();
  const corpus = {
    mutants: [
      { id: 'k1', file: 'src/math.js', mutator: 'ArithmeticOperator', start: { line: 2, column: 10 }, end: { line: 2, column: 15 }, replacement: 'a - b', original: 'a + b' },
      // isPositive(0) is never tested, so >= survives.
      { id: 's1', file: 'src/math.js', mutator: 'EqualityOperator', start: { line: 6, column: 10 }, end: { line: 6, column: 15 }, replacement: 'n >= 0', original: 'n > 0' },
      { id: 'b1', file: 'src/math.js', mutator: 'BlockStatement', start: { line: 5, column: 31 }, end: { line: 7, column: 2 }, replacement: '{}' },
      { id: 'g1', file: 'src/math.js', mutator: 'EqualityOperator', start: { line: 6, column: 10 }, end: { line: 6, column: 15 }, replacement: 'n < 0', original: 'n == 0' },
      { id: 'g2', file: 'src/nope.js', start: { line: 1, column: 1 }, end: { line: 1, column: 2 }, replacement: 'x' },
    ],
  };
  const file = path.join(dir, '..', `${path.basename(dir)}-corpus.json`);
  fs.writeFileSync(file, JSON.stringify(corpus));
  const save = path.join(dir, '..', `${path.basename(dir)}-out.json`);
  const r = pocp(dir, ['eval', '--corpus', file, '--jobs', '2', '--save', save, '--json']);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(r.json.corpus, true);
  assert.equal(r.json.seed, null);
  assert.equal(r.json.total, 3);
  assert.equal(r.json.gone, 2);
  assert.equal(r.json.caught, 2);
  const by = Object.fromEntries(r.json.mutants.map((m) => [m.id, m]));
  assert.equal(by.k1.outcome, 'caught');
  assert.equal(by.k1.caught_by, 'math-tests');
  assert.equal(by.k1.operator, 'ArithmeticOperator');
  assert.equal(by.s1.outcome, 'missed');
  assert.equal(by.s1.after, 'return n >= 0;');
  assert.equal(by.b1.outcome, 'caught');
  assert.equal(by.g1.outcome, 'gone');
  assert.match(by.g1.gone, /no longer at that range/);
  assert.match(by.g2.gone, /not guarded/);
  assert.equal(read(dir, 'src/math.js'), MATH, 'working folder untouched');
  assert.equal(JSON.parse(fs.readFileSync(save, 'utf8')).mutants.length, 5);

  const human = pocp(dir, ['eval', '--corpus', file, '--jobs', '2']);
  assert.match(human.stdout, /mutation eval \(corpus\): caught 2\/3 \(67%\) · 2 no longer apply/);
  assert.equal(pocp(dir, ['eval', '--corpus', `${file}.missing`]).code, 2);
});

test('eval --corpus marks a check that times out as timeout, not a catch', () => {
  const dir = sampleRepo({
    rules: {
      triggers: { broad_files: 6, cross_area: { areas: 3, min_files: 4 }, globs: [] },
      requirements: [{ id: 'slow', glob: 'src/**', obligation: { kind: 'test', run: 'node test/math.check.mjs && node -e "if (require(\'fs\').readFileSync(\'src/math.js\',\'utf8\').includes(\'SLOW\')) setTimeout(() => {}, 60000)"', timeout_ms: 1500 } }],
    },
  });
  const file = path.join(dir, '..', `${path.basename(dir)}-corpus.json`);
  fs.writeFileSync(file, JSON.stringify([{ id: 't1', file: 'src/math.js', start: { line: 3, column: 2 }, end: { line: 3, column: 2 }, replacement: ' // SLOW' }]));
  const r = pocp(dir, ['eval', '--corpus', file, '--json']);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(r.json.mutants[0].outcome, 'timeout');
  assert.equal(r.json.mutants[0].caught, null, 'not measured: neither caught nor missed');
  assert.equal(r.json.total, 0, 'and not scored');
  assert.equal(r.json.not_measured, 1);
});
