// A module outside the rules' globs that a test imports is treated as test support, unless it is
// the subject of a test named after it. Seen in practice: a bug fix in a component plus a new
// assertion in the component's own test was read as a test-setup change. The component was put
// back to its old version for the "old tests on the new code" run, so that run tested the new
// test against the old component and reported a behavior change that wasn't there.
//
// The fix is narrow on purpose: a real assertion helper misread as code would let a weakened
// assertion pass as an ordinary code change.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectTestChanges } from '../src/guard.js';
import { requirementCommands } from '../src/test-setup.js';
import { git, tmpRepo, write } from './helpers.js';

const LIGHT = "export const lamp = (dial) => (dial ? 'on' : 'on');\n";
const LIGHT_FIXED = "export const lamp = (dial) => (dial ? 'off' : 'on');\n";
const RULES = { requirements: [{ id: 'unit', globs: ['src/lib/**'], obligation: { kind: 'test', run: 'node --test' }, source: 'author' }] };
const CONFIG = { guard: { tests: 'block', test_globs: ['src/lib/**/*.test.*'] } };

/** A component outside the rules' globs, imported by a guarded test (and, in some cases below, by its own test). */
function repo(files) {
  const dir = tmpRepo();
  write(dir, 'package.json', '{ "type": "module" }\n');
  write(dir, 'src/lib/feel.mjs', 'export const feel = () => 1;\n');
  write(dir, 'src/lib/feel.test.mjs', "import { feel } from './feel.mjs';\nimport { lamp } from '../components/light.mjs';\nif (feel() !== 1 || lamp(false) !== 'on') throw new Error('x');\n");
  write(dir, 'src/components/light.mjs', LIGHT);
  for (const [p, t] of Object.entries(files)) write(dir, p, t);
  git(dir, 'add', '-A');
  git(dir, '-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', 'base');
  return dir;
}

const changed = (dir) => detectTestChanges(dir, { config: CONFIG, commands: requirementCommands(RULES) });

test('a module with a test named after it that imports it is the code under test, not test support', () => {
  const dir = repo({ 'src/components/light.test.mjs': "import { lamp } from './light.mjs';\nif (lamp(false) !== 'on') throw new Error('x');\n" });
  write(dir, 'src/components/light.mjs', LIGHT_FIXED);
  write(dir, 'src/components/light.test.mjs', "import { lamp } from './light.mjs';\nif (lamp(false) !== 'on') throw new Error('x');\nif (lamp(true) !== 'off') throw new Error('y');\n");
  git(dir, 'add', '-A');
  const r = changed(dir);
  assert.ok(!r.files.includes('src/components/light.mjs'), `the component is not test setup: ${JSON.stringify(r.signals)}`);
  assert.ok(!r.changes.some((c) => c.path === 'src/components/light.mjs'), 'and is never restored to its old version for the old-tests run');
});

test('control: a helper the tests import, with no test named after it, is still test support', () => {
  const dir = repo({});
  write(dir, 'src/components/light.mjs', "export const lamp = () => 'on';\n");
  git(dir, 'add', '-A');
  const r = changed(dir);
  assert.ok(r.files.includes('src/components/light.mjs'), 'a module only the tests reach stays guarded as test support');
});

test('control: a test named after a module that does not import it does not make the module code', () => {
  const dir = repo({ 'src/components/light.test.mjs': "if (1 + 1 !== 2) throw new Error('x');\n" });
  write(dir, 'src/components/light.mjs', "export const lamp = () => 'on';\n");
  git(dir, 'add', '-A');
  assert.ok(changed(dir).files.includes('src/components/light.mjs'));
});

test('control: a change cannot add the test that would make a helper count as code', () => {
  const dir = repo({});
  write(dir, 'src/components/light.mjs', "export const lamp = () => 'on';\n");
  write(dir, 'src/components/light.test.mjs', "import { lamp } from './light.mjs';\nlamp();\n");
  git(dir, 'add', '-A');
  assert.ok(changed(dir).files.includes('src/components/light.mjs'), 'only tests at the base count');
});

// A test named after a module doesn't make it code when the module is explicitly test support:
// an assertion helper with its own unit test is still an assertion helper. Otherwise a change
// could weaken a shared assertion, which the base's own helper test already imports, and pass
// as an ordinary code change.
const ASSERTING = "import assert from 'node:assert/strict';\nexport const lamp = (a, b) => assert.equal(a, b);\n";
const HELPER_TEST = "import { lamp } from './light.mjs';\nlamp(1, 1);\n";

test('an assertion helper with its own named test stays test support when weakened', () => {
  const dir = repo({ 'src/components/light.mjs': ASSERTING, 'src/components/light.test.mjs': HELPER_TEST });
  write(dir, 'src/components/light.mjs', 'export const lamp = () => {};\n');
  git(dir, 'add', '-A');
  assert.ok(changed(dir).files.includes('src/components/light.mjs'), 'test-framework imports at the base keep it test support');
});

test('a helper on a test-support path with its own named test stays test support', () => {
  const dir = repo({});
  write(dir, 'src/lib/feel.test.mjs', "import { feel } from './feel.mjs';\nimport { lamp } from '../test-utils/light.mjs';\nif (feel() !== 1 || lamp(false) !== 'on') throw new Error('x');\n");
  write(dir, 'src/test-utils/light.mjs', LIGHT);
  write(dir, 'src/test-utils/light.test.mjs', "import { lamp } from './light.mjs';\nif (lamp(false) !== 'on') throw new Error('x');\n");
  git(dir, 'add', '-A');
  git(dir, '-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', 'helper on a support path');
  write(dir, 'src/test-utils/light.mjs', "export const lamp = () => 'on';\n");
  git(dir, 'add', '-A');
  assert.ok(changed(dir).files.includes('src/test-utils/light.mjs'), 'a support path keeps it test support');
});
