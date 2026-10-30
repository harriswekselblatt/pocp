// Merges: files taken unchanged from the merged branch carry that branch's proofs, so the
// gate judges only what changed while merging (conflict resolutions).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { git, pocp, read, sampleRepo, sh, write } from './helpers.js';

const noHooks = ['-c', 'core.hooksPath=/dev/null'];

function divergedRepo() {
  const dir = sampleRepo({ hooks: true });
  git(dir, 'checkout', '-q', '-b', 'feature');
  write(dir, 'src/math.js', read(dir, 'src/math.js').replace('a + b', 'b + a'));
  write(dir, 'src/extra.js', 'export const two = 2;\n');
  git(dir, 'add', '-A');
  git(dir, ...noHooks, 'commit', '-q', '-m', 'feature work');
  git(dir, 'checkout', '-q', 'main');
  write(dir, 'src/math.js', read(dir, 'src/math.js').replace('return n > 0;', 'return n >= 1;'));
  git(dir, 'add', '-A');
  git(dir, ...noHooks, 'commit', '-q', '-m', 'main work');
  return dir;
}

test('during a merge only the conflict resolution needs a packet', () => {
  const dir = divergedRepo();
  sh(dir, 'git', ['merge', '--no-commit', '--no-ff', 'feature']);
  // Taken unchanged from feature: src/extra.js. Merged from both sides: src/math.js.
  const g = pocp(dir, ['gate', '--json']);
  assert.ok(g.json.merge, JSON.stringify(g.json));
  assert.ok(!g.json.required_files.includes('src/extra.js'), 'taken from the merged branch');
  assert.ok(g.json.required_files.includes('src/math.js'), 'differs from both sides, so it is judged');
  assert.ok(g.json.warnings.some((w) => w.code === 'merge'));
});

test('a merge that only takes the other branch\'s files needs no packet', () => {
  const dir = sampleRepo({ hooks: true });
  git(dir, 'checkout', '-q', '-b', 'feature');
  write(dir, 'src/extra.js', 'export const two = 2;\n');
  git(dir, 'add', '-A');
  git(dir, ...noHooks, 'commit', '-q', '-m', 'feature work');
  git(dir, 'checkout', '-q', 'main');
  write(dir, 'README.md', '# sample\n\nmore\n');
  git(dir, 'add', '-A');
  git(dir, ...noHooks, 'commit', '-q', '-m', 'docs');
  sh(dir, 'git', ['merge', '--no-commit', '--no-ff', 'feature']);
  const g = pocp(dir, ['gate', '--json']);
  assert.equal(g.code, 0, JSON.stringify(g.json.reasons));
  assert.equal(g.json.decision, 'pass');
  // Without a merge in progress, the same staged change would need a packet.
  sh(dir, 'git', ['merge', '--abort']);
  sh(dir, 'git', ['checkout', 'feature', '--', 'src/extra.js']);
  assert.equal(pocp(dir, ['gate']).code, 1);
});

test('a conflict resolved by hand is judged like any change', () => {
  const dir = sampleRepo({ hooks: true });
  git(dir, 'checkout', '-q', '-b', 'feature');
  write(dir, 'src/math.js', read(dir, 'src/math.js').replace('a + b', 'b + a'));
  git(dir, 'add', '-A');
  git(dir, ...noHooks, 'commit', '-q', '-m', 'feature');
  git(dir, 'checkout', '-q', 'main');
  write(dir, 'src/math.js', read(dir, 'src/math.js').replace('a + b', 'a + b + 0'));
  git(dir, 'add', '-A');
  git(dir, ...noHooks, 'commit', '-q', '-m', 'main');
  const m = sh(dir, 'git', ['merge', 'feature'], { allowFail: true });
  assert.notEqual(m.status, 0, 'conflict expected');
  write(dir, 'src/math.js', read(dir, 'src/math.js').replace(/<<<<<<<[\s\S]*>>>>>>> feature\n/, '  return b + a + 0;\n'));
  git(dir, 'add', 'src/math.js');
  const g = pocp(dir, ['gate', '--json']);
  assert.equal(g.code, 1);
  assert.deepEqual(g.json.unpacketed, ['src/math.js']);
  assert.ok(g.json.remedies.some((r) => r.next.startsWith('pocp fix')));
});
