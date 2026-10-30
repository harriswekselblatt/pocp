// When the test guard can't decide on its own, it says why, and tests a change adds are never
// judged as old tests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { failingTests } from '../src/guard-check.js';
import { git, pocp, sh, tmpRepo, write, writeRules } from './helpers.js';

const noHooks = ['-c', 'core.hooksPath=/dev/null'];
// The checks here run "node --test" themselves; without this, it would report to this test
// run instead of exiting with its own status.
delete process.env.NODE_TEST_CONTEXT;

function repo(files, run = 'node --test --test-reporter=tap test/*.test.js') {
  const dir = tmpRepo();
  write(dir, 'package.json', '{ "type": "module" }\n');
  for (const [p, t] of Object.entries(files)) write(dir, p, t);
  const init = pocp(dir, ['init', '--hooks']);
  assert.equal(init.code, 0, init.stderr);
  writeRules(dir, { requirements: [{ id: 'unit', globs: ['src/**', 'test/**'], obligation: { kind: 'test', run }, source: 'author' }] });
  git(dir, 'add', '-A');
  git(dir, ...noHooks, 'commit', '-q', '-m', 'base');
  return { dir, base: git(dir, 'rev-parse', 'HEAD') };
}

function change(dir, files, intent) {
  for (const [p, t] of Object.entries(files)) write(dir, p, t);
  git(dir, 'add', '-A');
  pocp(dir, ['fix', '--intent', intent]);
  const c = sh(dir, 'git', ['commit', '-q', '-m', intent], { allowFail: true });
  assert.equal(c.status, 0, c.stderr);
}

const guardOf = (v) => [...(v.json?.commits || []), v.json?.net].filter(Boolean).flatMap((r) => r.test_guard?.mechanical || []);

test('failing test names come from TAP, the spec reporter, pytest and Jest/Vitest output', () => {
  assert.deepEqual(failingTests('ok 1 - fine\nnot ok 2 - adds\n  not ok 1 - nested # time=1ms\nnot ok 3 - later # TODO\n'), ['adds', 'nested']);
  assert.deepEqual(failingTests('✔ fine (1ms)\n✖ adds (2.1ms)\n✖ failing tests:\n✖ adds (2.1ms)\n'), ['adds']);
  assert.deepEqual(failingTests('FAILED tests/test_a.py::test_one - AssertionError\n FAIL  src/b.test.ts\n'), ['tests/test_a.py::test_one', 'src/b.test.ts']);
  assert.deepEqual(failingTests(''), []);
});

test('a new test of changed test support is left out of the old-tests run, so it is not a behavior change', () => {
  const { dir, base } = repo({
    'src/math.js': 'export const add = (a, b) => a + b;\n',
    'lib/check.js': "export function eq(a, b) { if (a !== b) throw new Error(`${a} !== ${b}`); }\n",
    'test/math.test.js': "import test from 'node:test';\nimport { add } from '../src/math.js';\nimport { eq } from '../lib/check.js';\ntest('adds', () => { eq(add(2, 3), 5); });\n",
  });
  // The helper gains a function and a new test checks it; nothing old is weakened.
  change(dir, {
    'lib/check.js': "export function eq(a, b) { if (a !== b) throw new Error(`${a} !== ${b}`); }\nexport function near(a, b) { if (Math.abs(a - b) > 1e-9) throw new Error(`${a} !~ ${b}`); }\n",
    'test/near.test.js': "import test from 'node:test';\nimport { near } from '../lib/check.js';\ntest('near', () => { near(0.1 + 0.2, 0.3); });\n",
  }, 'Add a near() helper and its test');
  const v = pocp(dir, ['verify', `${base}..HEAD`, '--require-coverage', '--rerun', '--json']);
  const runs = guardOf(v);
  assert.ok(runs.length, `the helper change is judged by the guard: ${v.stdout}`);
  for (const r of runs) assert.notEqual(r.verdict, 'behavior-changed', r.summary);
  const raw = [...(v.json?.commits || []), v.json?.net].filter(Boolean).map((r) => r.test_guard).filter(Boolean);
  assert.ok(JSON.stringify(v.json).includes('test/near.test.js'), 'the added test is named as left out');
  assert.ok(raw.length);
});

test('baseline-red names the tests failing on each side and says a person must decide', () => {
  // At the base, "parses" fails (a bug in parse). The change fixes parse, but also changes
  // what fmt returns and edits the fmt test to match: the old fmt test now fails.
  const { dir, base } = repo({
    'src/m.js': 'export const parse = (s) => Number(s) + 1;\nexport const fmt = (n) => `${n}`;\n',
    'test/parse.test.js': "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { parse } from '../src/m.js';\ntest('parses', () => { assert.equal(parse('2'), 2); });\n",
    'test/fmt.test.js': "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { fmt } from '../src/m.js';\ntest('formats', () => { assert.equal(fmt(2), '2'); });\n",
  });
  change(dir, {
    'src/m.js': 'export const parse = (s) => Number(s);\nexport const fmt = (n) => `#${n}`;\n',
    'test/fmt.test.js': "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { fmt } from '../src/m.js';\ntest('formats', () => { assert.equal(fmt(2), '#2'); });\n",
  }, 'Fix parse; fmt adds a hash');
  const v = pocp(dir, ['verify', `${base}..HEAD`, '--require-coverage', '--rerun', '--json']);
  const red = guardOf(v).find((r) => r.verdict === 'baseline-red');
  assert.ok(red, `baseline-red expected: ${v.stdout}`);
  assert.match(red.summary, /Different tests fail: at the base parses, but on the new code with the old tests formats/);
  assert.match(red.summary, /can't decide this automatically: a person must review the tests that fail only on the new code$/);
});
