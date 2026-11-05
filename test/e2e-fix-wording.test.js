// `pocp fix` says what is true: a check that failed is never reported as proved, and a failed
// test-change check handed to CI is the maintainer's to decide, not a "fix the code" for the
// author, while the commit can still go ahead.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { git, pocp, tmpRepo, write, writeConfig, writeRules } from './helpers.js';

function repo() {
  const dir = tmpRepo();
  write(dir, 'package.json', '{ "type": "module" }\n');
  write(dir, 'src/math.js', 'export const add = (a, b) => a + b;\n');
  write(dir, 'test/math.test.js', "import { add } from '../src/math.js';\nif (add(2, 3) !== 5) process.exit(1);\nif (add(-1, 1) !== 0) process.exit(1);\n");
  assert.equal(pocp(dir, ['init', '--hooks']).code, 0);
  writeRules(dir, { requirements: [{ id: 'math', globs: ['src/**', 'test/**'], obligation: { kind: 'test', run: 'node test/math.test.js' }, source: 'author' }] });
  writeConfig(dir, { guard: { tests: 'block' } });
  git(dir, 'add', '-A');
  git(dir, '-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', 'base');
  return dir;
}

test('block mode: a failed test-change check handed to CI is reported as handed over, not proved and not "fix the code"', () => {
  const dir = repo();
  write(dir, 'test/math.test.js', "import { add } from '../src/math.js';\nif (add(2, 3) !== 5) process.exit(1);\n");
  write(dir, 'src/math.js', 'export const add = (a, b) => (a < 0 ? 0 : a + b);\n');
  git(dir, 'add', '-A');
  const f = pocp(dir, ['fix', '--intent', 'drop a case']);
  assert.equal(f.code, 0, f.stdout + f.stderr);
  const lines = f.stdout.split('\n');
  assert.equal(lines[0], 'pocp fix: committable now; CI requires human approval of the test change');
  assert.match(f.stdout, /did: proved 1 of 2 check\(s\) for p-[0-9a-f]+ \([^)]*\); o2 handed to CI/);
  assert.doesNotMatch(f.stdout, /ready to commit/);
  assert.doesNotMatch(f.stdout, /needs you: o2/, 'the author is not told to fix what a maintainer decides');
  assert.match(f.stdout, /needs a person: .*test-change check did not pass/);

  // Run again on the same code: still handed over, still not the author's to fix.
  const again = pocp(dir, ['fix', '--json']);
  assert.equal(again.code, 0);
  assert.ok(!again.json.needs_agent.some((x) => x.code === 'failed_proof'), JSON.stringify(again.json.needs_agent));
});

test('a plain failing check is counted as failed and left to the author', () => {
  const dir = repo();
  write(dir, 'src/math.js', 'export const add = (a, b) => a - b;\n');
  git(dir, 'add', '-A');
  const f = pocp(dir, ['fix', '--intent', 'break add']);
  assert.notEqual(f.code, 0);
  const out = f.stdout + f.stderr;
  assert.match(out, /^pocp fix: needs you/);
  assert.match(out, /did: proved 0 of 1 check\(s\) for p-[0-9a-f]+ \([^)]*\); o1 failed/);
  assert.match(out, /needs you: o1 fails on this exact code/);
});
