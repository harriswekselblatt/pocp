// Regressions for the 2026-11-07 audit: test-edit and input bypasses that let a pull request
// weaken its tests and still verify. Each attack must now be held (a person decides, or deep
// mode measures it), and an honest change next to it must still be handled the honest way.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { git, pocp, tmpRepo, write, writeRules } from './helpers.js';
import * as g from '../src/git.js';
import { matchGlob } from '../src/glob.js';

const CHECK = "import { add } from '../src/math.js';\nif (add(2, 3) !== 5) { throw new Error('add broken'); }\nconsole.log('math ok');\n";
const RUN_ALL = "import fs from 'node:fs';\nfor (const f of fs.readdirSync('test').filter((n) => n.endsWith('.check.mjs')).sort()) await import(`./${f}`);\n";

/** A project whose one rule runs every test/*.check.mjs; fast mode unless `deep`. */
function project({ deep = false } = {}) {
  const dir = tmpRepo();
  write(dir, 'package.json', '{"type":"module"}\n');
  write(dir, 'src/math.js', 'export const add = (a, b) => a + b;\n');
  write(dir, 'test/math.check.mjs', CHECK);
  write(dir, 'test/all.mjs', RUN_ALL);
  const init = pocp(dir, ['init', '--hooks', ...(deep ? ['--deep'] : [])]);
  assert.equal(init.code, 0, init.stderr);
  writeRules(dir, { requirements: [{ id: 'unit', globs: ['src/**', 'test/**'], obligation: { kind: 'test', run: 'node test/all.mjs' }, source: 'author' }] });
  git(dir, 'add', '-A');
  git(dir, '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'baseline');
  return dir;
}

/** Stage `change`, let `pocp fix` write the packet, commit, and verify the range like CI does. */
function pullRequest(dir, change) {
  const base = git(dir, 'rev-parse', 'HEAD');
  change(dir);
  git(dir, 'add', '-A');
  pocp(dir, ['fix', '--intent', 'test change']);
  const c = spawnSync('git', ['commit', '-qm', 'test change'], { cwd: dir, encoding: 'utf8' });
  if (c.status !== 0) git(dir, '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'test change');
  return pocp(dir, ['verify', `${base}..HEAD`, '--rerun', '--require-coverage', '--json']);
}

const findings = (v) => (v.json?.commits || []).flatMap((c) => c.findings || []).map((f) => f.code);
const withoutAssert = CHECK.split('\n').filter((l) => !l.startsWith('if ')).join('\n');

const ATTACKS = [
  ['.gitattributes marks the tests binary', (d) => { write(d, '.gitattributes', '*.mjs -diff\n'); write(d, 'test/math.check.mjs', withoutAssert); }],
  ['a NUL byte makes git treat the test as binary', (d) => write(d, 'test/math.check.mjs', `// \0\n${withoutAssert}`)],
  ['added lines comment the assertion out', (d) => write(d, 'test/math.check.mjs', CHECK.replace('if (add', '/*\nif (add').replace('console.log', '*/\nconsole.log'))],
  ['added lines wrap the assertion in if (false)', (d) => write(d, 'test/math.check.mjs', CHECK.replace('if (add', 'if (false) {\nif (add').replace('console.log', '}\nconsole.log'))],
  ['a new test file ends the run before the others', (d) => write(d, 'test/aaa.check.mjs', 'process.exit(0);\n')],
  ['an honest added test line (still reviewed in fast mode)', (d) => write(d, 'test/math.check.mjs', `${CHECK}if (add(0, 0) !== 0) { throw new Error('zero'); }\n`)],
];

for (const [name, change] of ATTACKS) {
  test(`fast mode: ${name} → held for a person, not verified`, () => {
    const dir = project();
    const v = pullRequest(dir, change);
    assert.notEqual(v.code, 0, v.stdout + v.stderr);
    assert.ok(findings(v).includes('test_change'), JSON.stringify(findings(v)));
  });
}

test('deep mode: a new test file that ends the run early loses planted bugs and is blocked', () => {
  const dir = project({ deep: true });
  const v = pullRequest(dir, (d) => write(d, 'test/aaa.check.mjs', 'process.exit(0);\n'));
  assert.notEqual(v.code, 0, v.stdout + v.stderr);
  assert.ok(findings(v).includes('test_change'), JSON.stringify(findings(v)));
});

test('deep mode: an honest new test file passes on its own', () => {
  const dir = project({ deep: true });
  const v = pullRequest(dir, (d) => write(d, 'test/zero.check.mjs', "import { add } from '../src/math.js';\nif (add(0, 0) !== 0) { throw new Error('zero'); }\n"));
  assert.equal(v.code, 0, v.stdout + v.stderr);
});

test('every diff POCP runs is text, shows submodules and ignores prefix settings', () => {
  const args = g.hardenedArgs(['diff', '-U0', 'a', 'b']);
  for (const a of ['--text', '--ignore-submodules=none', 'diff.noprefix=false', 'diff.ignoreSubmodules=none']) assert.ok(args.includes(a), a);
});

test('a submodule bump stays visible when .gitmodules says ignore = all', () => {
  const sub = tmpRepo();
  write(sub, 'x.txt', '1\n');
  git(sub, 'add', '-A');
  git(sub, 'commit', '-qm', 'one');
  const dir = tmpRepo();
  write(dir, 'README.md', 'x\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'start');
  git(dir, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', sub, 'lib');
  git(dir, 'config', '-f', '.gitmodules', 'submodule.lib.ignore', 'all');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'add submodule');
  write(sub, 'x.txt', '2\n');
  git(sub, 'commit', '-qam', 'two');
  git(`${dir}/lib`, 'pull', '-q');
  git(dir, 'add', 'lib');
  assert.ok(g.stagedChanges(dir).some((c) => c.path === 'lib'), 'the staged gitlink is a change');
});

test('** matches a path with a newline in it', () => {
  assert.equal(matchGlob('src/a\nb.js', 'src/**'), true);
  assert.equal(matchGlob('src/a\nb.js', 'src/*.js'), true);
});

test('changedLines reads paths with spaces and non-ASCII names', () => {
  const dir = tmpRepo();
  write(dir, 'src/a b.js', 'x\n');
  write(dir, 'src/ñ.js', 'x\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'one');
  write(dir, 'src/a b.js', 'x\ny\n');
  write(dir, 'src/ñ.js', 'x\ny\n');
  git(dir, 'add', '-A');
  const lines = g.changedLines(dir, 'HEAD', null, ['src/a b.js', 'src/ñ.js']);
  assert.deepEqual([...lines.get('src/a b.js')], [2]);
  assert.deepEqual([...lines.get('src/ñ.js')], [2]);
});

test('verify refuses a shallow clone instead of reading a boundary commit as a root', () => {
  const dir = project();
  write(dir, 'src/math.js', 'export const add = (a, b) => a + b; // two\n');
  git(dir, 'add', '-A');
  git(dir, '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'two');
  const clone = tmpRepo();
  git(clone, 'fetch', '-q', '--depth=1', `file://${dir}`, 'main');
  git(clone, 'checkout', '-q', 'FETCH_HEAD');
  const v = pocp(clone, ['verify', 'HEAD', '--json']);
  assert.notEqual(v.code, 0);
  assert.match(v.stdout + v.stderr, /shallow clone/);
});

test('a range whose sides share no history fails instead of picking a base', () => {
  const dir = project();
  git(dir, 'checkout', '-q', '--orphan', 'other');
  write(dir, 'src/math.js', 'export const add = (a, b) => a - b;\n');
  git(dir, 'add', '-A');
  git(dir, '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'unrelated');
  const v = pocp(dir, ['verify', 'main..other', '--json']);
  assert.notEqual(v.code, 0);
  assert.match(v.stdout + v.stderr, /share no history/);
});

test('adopting POCP: the first commit of .proof passes the gate, and verify sees no loosening', () => {
  const dir = tmpRepo();
  write(dir, 'README.md', '# before\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'before');
  const base = git(dir, 'rev-parse', 'HEAD');
  assert.equal(pocp(dir, ['init', '--hooks']).code, 0);
  git(dir, 'add', '-A');
  const commit = spawnSync('git', ['commit', '-qm', 'adopt pocp'], { cwd: dir, encoding: 'utf8' });
  assert.equal(commit.status, 0, commit.stdout + commit.stderr);
  const v = pocp(dir, ['verify', `${base}..HEAD`, '--json']);
  assert.equal(v.code, 0, v.stdout + v.stderr);
  assert.deepEqual(v.json.commits.flatMap((c) => c.policy?.weakened || []), []);
});

test('deleting an enrolled policy is still a loosening, not an adoption', () => {
  const dir = project();
  const base = git(dir, 'rev-parse', 'HEAD');
  git(dir, 'rm', '-q', '-r', '.proof/rules.json', '.proof/config.json');
  git(dir, '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'drop policy');
  const v = pocp(dir, ['verify', `${base}..HEAD`, '--json']);
  assert.notEqual(v.code, 0, v.stdout);
});
