// A pull request's test changes are judged once, on its net change. Running the same check on
// each commit as well only multiplied the cost of verify (each run executes the required checks
// about twenty times); only the net change's result decides.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { git, pocp, tmpRepo, write, writeRules } from './helpers.js';

const noHooks = ['-c', 'core.hooksPath=/dev/null'];
const commit = (dir, msg) => { git(dir, 'add', '-A'); git(dir, ...noHooks, 'commit', '-q', '-m', msg); };
const MATH = 'export const add = (a, b) => a + b;\nexport const lt = (a, b) => a < b;\n';
const CHECK = [
  "import { add, lt } from '../src/math.js';",
  'if (add(2, 3) !== 5) process.exit(1);',
  'if (lt(1, 2) !== true || lt(2, 1) !== false) process.exit(1);',
  '',
].join('\n');

function repo() {
  const dir = tmpRepo();
  write(dir, 'package.json', '{ "type": "module" }\n');
  write(dir, 'src/math.js', MATH);
  write(dir, 'test/math.check.mjs', CHECK);
  pocp(dir, ['init']);
  writeRules(dir, { requirements: [{ id: 'unit', globs: ['src/**', 'test/**'], obligation: { kind: 'test', run: 'node test/math.check.mjs' }, source: 'author' }] });
  commit(dir, 'base');
  return { dir, base: git(dir, 'rev-parse', 'HEAD') };
}
const guardRuns = (v) => [...(v.json?.reruns || []), ...(v.json?.net?.reruns || []), ...(v.json?.commits || []).flatMap((c) => c.reruns || [])].filter((r) => r.kind === 'guard');
const blocking = (v, code) => [...(v.json?.commits || []), v.json?.net].filter(Boolean).flatMap((r) => r.findings || []).filter((f) => f.blocking && f.code === code);

test('two commits that each edit an existing test: one check, on the net change', () => {
  const { dir, base } = repo();
  write(dir, 'test/math.check.mjs', `${CHECK}if (add(0, 0) !== 0) process.exit(1);\n`);
  commit(dir, 'a stronger test');
  write(dir, 'test/math.check.mjs', `${CHECK}if (add(0, 0) !== 0) process.exit(1);\nif (add(-1, 1) !== 0) process.exit(1);\n`);
  commit(dir, 'stronger still');
  const v = pocp(dir, ['verify', `${base}..HEAD`, '--rerun', '--json']);
  const runs = guardRuns(v);
  assert.equal(runs.length, 1, JSON.stringify(runs.map((r) => r.run)));
  assert.match(runs[0].run, /net change/);
  assert.equal(runs[0].status, 'passed', runs[0].summary);
  for (const c of v.json.commits) assert.ok(c.notes.some((n) => /judged once, on the pull request's net change/.test(n)), 'each commit says where its test change is judged');
  assert.equal(v.code, 0, v.stdout);
});

test('a weakening split across commits is still blocked, by the net change', () => {
  const { dir, base } = repo();
  write(dir, 'test/math.check.mjs', CHECK.replace(/^if \(lt.*\n/m, ''));
  commit(dir, 'drop the lt assertions');
  write(dir, 'src/math.js', MATH.replace('a < b', 'a <= b'));
  commit(dir, 'the bug they would have caught');
  const v = pocp(dir, ['verify', `${base}..HEAD`, '--rerun', '--json']);
  assert.equal(v.code, 1);
  assert.equal(guardRuns(v).length, 1);
  const net = blocking(v, 'test_change');
  assert.ok(net.length && /net change/.test(net[0].detail), JSON.stringify(net));
});

test('a single commit is its own net change: its check runs once, on the commit', () => {
  const { dir, base } = repo();
  write(dir, 'test/math.check.mjs', `${CHECK}if (add(0, 0) !== 0) process.exit(1);\n`);
  // Through a packet, as a user commits: the commit's own guard obligation is what verify re-runs.
  git(dir, 'add', '-A');
  assert.equal(pocp(dir, ['fix', '--intent', 'a stronger test']).code, 0);
  git(dir, 'add', '-A');
  git(dir, ...noHooks, 'commit', '-q', '-m', `a stronger test\n\n${pocp(dir, ['trailer']).stdout.trim()}`);
  const v = pocp(dir, ['verify', `${base}..HEAD`, '--rerun', '--json']);
  const runs = guardRuns(v);
  assert.equal(runs.length, 1, JSON.stringify(runs.map((r) => r.run)));
  assert.doesNotMatch(runs[0].run, /net change/);
  assert.equal(v.code, 0, v.stdout);
});
