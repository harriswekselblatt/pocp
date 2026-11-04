// When pocp can't be found, only pre-commit (the gate) blocks. prepare-commit-msg and
// post-commit also run under --no-verify, so they warn and let the commit through, and CI's
// verify still catches a commit that needed proof.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installHooks } from '../src/init.js';
import { sampleRepo, sh, git, pocp, write } from './helpers.js';

// No pocp on PATH, no POCP_BIN, no node_modules/.bin/pocp in the repo, and hooks installed
// without a remembered pocp (as if the pocp that installed them was since removed).
const NO_POCP = { PATH: '/usr/bin:/bin', POCP_BIN: '' };

function riskyChange() {
  const dir = sampleRepo({ hooks: true });
  installHooks(dir, { bin: null });
  write(dir, 'src/math.js', 'export function add(a, b) {\n  return b + a;\n}\n\nexport function isPositive(n) {\n  return n > 0;\n}\n');
  git(dir, 'add', '-A');
  assert.notEqual(sh(dir, 'sh', ['-c', 'command -v pocp'], { env: NO_POCP, allowFail: true }).status, 0, 'pocp must not be on the test PATH');
  return dir;
}

test('without pocp, a plain git commit is still blocked by pre-commit', () => {
  const dir = riskyChange();
  const before = git(dir, 'rev-parse', 'HEAD');
  const r = sh(dir, 'git', ['commit', '-m', 'change add'], { env: NO_POCP, allowFail: true });
  assert.notEqual(r.status, 0, 'the gate fails closed');
  assert.match(r.stderr, /pocp: not found/);
  assert.match(r.stderr, /blocked/);
  assert.equal(git(dir, 'rev-parse', 'HEAD'), before);
});

test('without pocp, git commit --no-verify succeeds with warnings, and verify flags the commit', () => {
  const dir = riskyChange();
  const r = sh(dir, 'git', ['commit', '--no-verify', '-m', 'change add'], { env: NO_POCP, allowFail: true });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /warning: committing without proof trailers/);
  assert.match(r.stderr, /warning: this commit's landing was not recorded/);
  assert.doesNotMatch(r.stderr, /To commit without the check once/, 'the --no-verify hint belongs to pre-commit only');
  assert.equal(git(dir, 'log', '-1', '--format=%s'), 'change add');

  const v = pocp(dir, ['verify', 'HEAD', '--require-coverage', '--json']);
  assert.equal(v.code, 1, v.stdout + v.stderr);
  assert.deepEqual(v.json.coverage.uncovered, ['src/math.js']);
});
