// pocp fix doesn't re-run a check that ran and failed on the same code (the code has to change),
// but a check that timed out says nothing about the code: it must run again. Found when several
// proofs ran at once, timed out, and stuck as "failed here before, so it was not run again".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { git, pocp, read, sampleRepo, write } from './helpers.js';

const RULES = { requirements: [{ id: 'math-tests', globs: ['src/**', 'test/**'], obligation: { kind: 'test', run: 'node test/math.check.mjs', timeout_ms: 2000 }, source: 'author' }] };

function staged(dir) {
  // The check hangs only while POCP_TEST_HANG is set: a timeout from load, not from the code.
  write(dir, 'src/math.js', `if (process.env.POCP_TEST_HANG === '1') { setInterval(() => {}, 1000); await new Promise(() => {}); }\n${read(dir, 'src/math.js')}`);
  git(dir, 'add', '-A');
}

test('a check that timed out runs again on the next pocp fix', () => {
  const dir = sampleRepo({ rules: RULES, deep: false, hooks: true });
  staged(dir);
  const first = pocp(dir, ['fix', '--intent', 'x'], { env: { POCP_TEST_HANG: '1' } });
  assert.notEqual(first.code, 0, first.stdout);
  const second = pocp(dir, ['fix', '--intent', 'x']);
  assert.equal(second.code, 0, second.stdout + second.stderr);
  assert.doesNotMatch(second.stdout + second.stderr, /failed here before/);
  assert.match(second.stdout, /ready to commit/);
});

test('a check that ran and failed is still not run again on the same code', () => {
  const dir = sampleRepo({ rules: RULES, deep: false, hooks: true });
  write(dir, 'src/math.js', read(dir, 'src/math.js').replace('return a + b;', 'return a - b;'));
  git(dir, 'add', '-A');
  assert.notEqual(pocp(dir, ['fix', '--intent', 'x']).code, 0);
  const again = pocp(dir, ['fix', '--intent', 'x']);
  assert.notEqual(again.code, 0);
  assert.match(again.stdout + again.stderr, /failed here before, so it was not run again/);
});
