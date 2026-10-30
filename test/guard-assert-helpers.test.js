// Assertion helpers inside the rules' globs: a helper that pulls in an assertion library, or a
// hand-written one the tests import next to the code, is test support even though a rule
// guards it. Hollowing it while breaking the code is a test change; honest code changes,
// including to a module both the code and the tests import, are not.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { looksLikeTestSupport } from '../src/test-setup.js';
import { git, pocp, sh, tmpRepo, write, writeRules } from './helpers.js';

const noHooks = ['-c', 'core.hooksPath=/dev/null'];
const MATH = 'export const add = (a, b) => a + b;\nexport const lt = (a, b) => a < b;\n';
const BUGGY = 'export const add = (a, b) => a - b;\nexport const lt = (a, b) => a < b;\n';

function repo(helperPath, helperText, extra = {}) {
  const dir = tmpRepo();
  write(dir, 'package.json', '{ "type": "module" }\n');
  write(dir, 'src/math.js', MATH);
  write(dir, helperPath, helperText);
  write(dir, 'test/math.test.js', [
    "import { add, lt } from '../src/math.js';",
    `import { eq } from '../${helperPath}';`,
    'eq(add(2, 3), 5);',
    'eq(add(-1, 1), 0);',
    'eq(lt(1, 2), true);',
    'eq(lt(2, 1), false);',
    "console.log('ok');",
    '',
  ].join('\n'));
  for (const [p, t] of Object.entries(extra)) write(dir, p, t);
  const init = pocp(dir, ['init', '--hooks']);
  assert.equal(init.code, 0, init.stderr);
  writeRules(dir, { requirements: [{ id: 'math', globs: ['src/**', 'test/**', 'lib/**'], obligation: { kind: 'test', run: 'node test/math.test.js' }, source: 'author' }] });
  git(dir, 'add', '-A');
  git(dir, ...noHooks, 'commit', '-q', '-m', 'base');
  assert.equal(sh(dir, 'node', ['test/math.test.js']).status, 0);
  return { dir, base: git(dir, 'rev-parse', 'HEAD') };
}

/** Commit the staged change the way an agent would, then run CI's verify on the range. */
function commitAndVerify(dir, base, intent) {
  git(dir, 'add', '-A');
  const f = pocp(dir, ['fix', '--intent', intent]);
  const c = sh(dir, 'git', ['commit', '-q', '-m', intent], { allowFail: true });
  assert.equal(c.status, 0, `the local gate let it through: ${f.stdout}${f.stderr}${c.stderr}`);
  return pocp(dir, ['verify', `${base}..HEAD`, '--require-coverage', '--rerun', '--json']);
}

const testChange = (v) => [...(v.json?.commits || []), v.json?.net].filter(Boolean).flatMap((r) => r.findings || []).some((f) => f.code === 'test_change' && f.blocking);

test('assertion libraries count as test-framework imports', () => {
  for (const lib of ['node:assert', 'assert', 'assert/strict', 'node:assert/strict', 'power-assert', 'should', 'expect', 'uvu/assert', 'chai']) {
    assert.ok(looksLikeTestSupport('lib/check.js', `import assert from '${lib}';\n`), lib);
    assert.ok(looksLikeTestSupport('lib/check.js', `const a = require("${lib}");\n`), lib);
  }
  assert.ok(looksLikeTestSupport('lib/check.py', 'import unittest\n'));
  assert.ok(looksLikeTestSupport('lib/check.py', 'import pytest\n'));
  assert.ok(looksLikeTestSupport('src/testkit.js', 'export const eq = () => {};\n'), 'a testkit by name');
  assert.ok(!looksLikeTestSupport('src/asserted.js', "import x from './assertions.js';\n"));
  assert.ok(!looksLikeTestSupport('src/math.js', MATH));
});

test('bypass: hollowing lib/check.js (node:assert, inside the globs, imported only by tests) while breaking the code fails verify', () => {
  const { dir, base } = repo('lib/check.js', "import assert from 'node:assert';\nexport function eq(a, b) { assert.strictEqual(a, b); }\n");
  write(dir, 'lib/check.js', "import assert from 'node:assert';\nexport function eq(a, b) { }\n");
  write(dir, 'src/math.js', BUGGY);
  const v = commitAndVerify(dir, base, 'cheat');
  assert.equal(v.code, 1, v.stdout);
  assert.ok(testChange(v), v.stdout);
  assert.ok(v.json.commits[0].test_guard?.files.includes('lib/check.js'), JSON.stringify(v.json.commits[0].test_guard));
});

test('bypass: hollowing src/testkit.js (imported only by tests) while breaking the code fails verify', () => {
  const { dir, base } = repo('src/testkit.js', "export function eq(a, b) { if (a !== b) { console.error('fail', a, b); process.exit(1); } }\n");
  write(dir, 'src/testkit.js', 'export function eq(a, b) { }\n');
  write(dir, 'src/math.js', BUGGY);
  const v = commitAndVerify(dir, base, 'cheat');
  assert.equal(v.code, 1, v.stdout);
  assert.ok(testChange(v), v.stdout);
});

test('bypass: a hand-written helper with no telling name or import (lib/check.js) is found by how the tests use it', () => {
  const { dir, base } = repo('lib/check.js', "export function eq(a, b) { if (a !== b) { console.error('fail', a, b); process.exit(1); } }\n");
  write(dir, 'lib/check.js', 'export function eq(a, b) { if (a !== b && typeof a !== typeof a) process.exit(1); }\n');
  write(dir, 'src/math.js', BUGGY);
  const v = commitAndVerify(dir, base, 'cheat');
  assert.equal(v.code, 1, v.stdout);
  assert.ok(testChange(v), v.stdout);
});

test('honest: refactoring a module the code and the tests both import (it uses node:assert) is not a test change', () => {
  const shared = "import assert from 'node:assert';\nexport function num(x) { assert.equal(typeof x, 'number'); return x; }\n";
  const { dir, base } = repo('lib/check.js', "import assert from 'node:assert';\nexport function eq(a, b) { assert.strictEqual(a, b); }\n", {
    'lib/num.js': shared,
    'src/math.js': "import { num } from '../lib/num.js';\nexport const add = (a, b) => num(a) + num(b);\nexport const lt = (a, b) => a < b;\n",
    'test/num.test.js': "import { num } from '../lib/num.js';\nimport { eq } from '../lib/check.js';\neq(num(1), 1);\n",
  });
  write(dir, 'lib/num.js', "import { strict as assert } from 'node:assert';\nexport function num(value) {\n  assert.equal(typeof value, 'number', 'not a number');\n  return value;\n}\n");
  const v = commitAndVerify(dir, base, 'tidy num');
  assert.ok(!testChange(v), v.stdout);
  assert.equal(v.code, 0, v.stdout);
  assert.equal(v.json.commits[0].test_guard ?? null, null, JSON.stringify(v.json.commits[0].test_guard));
});

test('honest: changing the module a test is named after, next to a testkit, is not a test change', () => {
  const { dir, base } = repo('src/testkit.js', "export function eq(a, b) { if (a !== b) { console.error('fail', a, b); process.exit(1); } }\n");
  write(dir, 'src/math.js', 'export const add = (a, b) => b + a;\nexport const lt = (a, b) => b > a;\n');
  const v = commitAndVerify(dir, base, 'reorder');
  assert.ok(!testChange(v), v.stdout);
  assert.equal(v.code, 0, v.stdout);
  assert.equal(v.json.commits[0].test_guard ?? null, null, JSON.stringify(v.json.commits[0].test_guard));
});

test('honest: a module that is the only code its test imports is the code under test, whatever its name', () => {
  const dir = tmpRepo();
  write(dir, 'package.json', '{ "type": "module" }\n');
  write(dir, 'src/add.js', 'export const add = (a, b) => a + b;\n');
  write(dir, 'test/basic.test.js', "import { add } from '../src/add.js';\nif (add(2, 3) !== 5) process.exit(1);\nif (add(-1, 1) !== 0) process.exit(1);\n");
  assert.equal(pocp(dir, ['init', '--hooks']).code, 0);
  writeRules(dir, { requirements: [{ id: 'a', globs: ['src/**', 'test/**'], obligation: { kind: 'test', run: 'node test/basic.test.js' }, source: 'author' }] });
  git(dir, 'add', '-A');
  git(dir, ...noHooks, 'commit', '-q', '-m', 'base');
  const base = git(dir, 'rev-parse', 'HEAD');
  write(dir, 'src/add.js', 'export const add = (a, b) => b + a;\n');
  const v = commitAndVerify(dir, base, 'reorder');
  assert.equal(v.code, 0, v.stdout);
  assert.equal(v.json.commits[0].test_guard ?? null, null);
});
