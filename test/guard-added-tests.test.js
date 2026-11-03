// Leaving added tests out of the old-tests run must not open a way around the guard: a test
// that is removed or renamed comes back as it was at the base, so the old tests still run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { git, pocp, sh, tmpRepo, write, writeRules } from './helpers.js';

const noHooks = ['-c', 'core.hooksPath=/dev/null'];
const MATH = 'export const add = (a, b) => a + b;\n';
const BUGGY = 'export const add = (a, b) => a - b;\n';
const CHECK = "import { add } from '../src/math.js';\nif (add(2, 3) !== 5) { console.error('add broken'); process.exit(1); }\n";
const WEAK = "import { add } from '../src/math.js';\nadd(2, 3);\n";
// One check per file, each in its own process.
const EACH = 'for f in test/*.check.mjs; do node "$f" || exit 1; done';
// All test files in one process, the way mocha or a hand-written runner loads them.
const ALL = "import fs from 'node:fs';\nfor (const f of fs.readdirSync('test').filter((n) => n.endsWith('.check.mjs')).sort()) await import(`./${f}`);\nconsole.log('all ok');\n";

function repo(run, extra = {}) {
  const dir = tmpRepo();
  write(dir, 'package.json', '{ "type": "module" }\n');
  write(dir, 'src/math.js', MATH);
  write(dir, 'test/math.check.mjs', CHECK);
  write(dir, 'test/other.check.mjs', "console.log('other');\n");
  for (const [p, t] of Object.entries(extra)) write(dir, p, t);
  assert.equal(pocp(dir, ['init', '--hooks']).code, 0);
  writeRules(dir, { requirements: [{ id: 'unit', globs: ['src/**', 'test/**'], obligation: { kind: 'test', run }, source: 'author' }] });
  git(dir, 'add', '-A');
  git(dir, ...noHooks, 'commit', '-q', '-m', 'base');
  return { dir, base: git(dir, 'rev-parse', 'HEAD') };
}

/** Make the change the way an agent would (hooks, then --no-verify if blocked), then CI's verify. */
function cheat(dir, base, steps) {
  steps();
  git(dir, 'add', '-A');
  pocp(dir, ['fix', '--intent', 'cheat']);
  const c = sh(dir, 'git', ['commit', '-q', '-m', 'cheat'], { allowFail: true });
  if (c.status !== 0) git(dir, ...noHooks, 'commit', '-q', '--no-verify', '-m', 'cheat');
  const v = pocp(dir, ['verify', `${base}..HEAD`, '--require-coverage', '--rerun', '--json']);
  const guards = [...(v.json?.commits || []), v.json?.net].filter(Boolean).flatMap((r) => r.test_guard?.mechanical || []);
  return { v, guards, verdicts: guards.map((r) => r.verdict) };
}

test('renaming a test and weakening the copy: the old file comes back, the copy is left out, the bug is caught', () => {
  const { dir, base } = repo(EACH);
  const r = cheat(dir, base, () => {
    write(dir, 'src/math.js', BUGGY);
    git(dir, 'mv', 'test/math.check.mjs', 'test/renamed.check.mjs');
    write(dir, 'test/renamed.check.mjs', WEAK);
  });
  assert.equal(r.v.code, 1, 'verify blocks');
  assert.ok(r.verdicts.includes('behavior-changed'), `got ${r.verdicts}`);
});

test('deleting a test and adding a weaker one elsewhere: the deleted test comes back and catches the bug', () => {
  const { dir, base } = repo(EACH);
  const r = cheat(dir, base, () => {
    write(dir, 'src/math.js', BUGGY);
    git(dir, 'rm', '-q', 'test/math.check.mjs');
    write(dir, 'test/sum.check.mjs', WEAK);
  });
  assert.equal(r.v.code, 1);
  assert.ok(r.verdicts.includes('behavior-changed'), `got ${r.verdicts}`);
});

test('an added test that ends a single-process run early no longer hides the old tests', () => {
  // test/aa.check.mjs sorts first and exits 0 before the real check loads. The existing
  // test gets a harmless edit, so the guard runs. Before added tests were left out, the
  // saboteur ran in the old-tests run too, and the old tests "passed" on the buggy code.
  const { dir, base } = repo('node test/all.mjs', { 'test/all.mjs': ALL });
  const r = cheat(dir, base, () => {
    write(dir, 'src/math.js', BUGGY);
    write(dir, 'test/aa.check.mjs', "console.log('ok'); process.exit(0);\n");
    write(dir, 'test/math.check.mjs', `// reviewed\n${CHECK}`);
  });
  assert.equal(r.v.code, 1);
  assert.ok(r.verdicts.includes('behavior-changed'), `got ${r.verdicts}`);
  assert.ok(JSON.stringify(r.v.json).includes('test/aa.check.mjs'), 'the added file is named as left out');
});

test('an added test a check names by path stays in the old-tests run (left out, the command would just break)', () => {
  const run = `${EACH} && { [ ! -f test/extra.check.mjs ] || node test/extra.check.mjs; }`;
  const { dir, base } = repo(run);
  const r = cheat(dir, base, () => {
    write(dir, 'test/extra.check.mjs', "console.log('extra');\n");
    write(dir, 'test/math.check.mjs', `// reviewed\n${CHECK}`);
  });
  assert.ok(r.guards.length, 'the guard ran');
  assert.ok(!r.guards.some((g) => (g.old_tests?.left_out || []).includes('test/extra.check.mjs')), 'named by the command: kept');
});
