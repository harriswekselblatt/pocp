// Index flags (assume-unchanged, skip-worktree) make git ignore working-copy edits, so a
// clean-looking folder can run different code from what is staged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { git, packetId, pocp, read, sampleRepo, write } from './helpers.js';
import { BREAK_ADD, TWEAK_ADD } from './fixtures.js';

test('clean mode refuses flagged files; snapshot mode proves the staged blob', () => {
  for (const flag of ['--skip-worktree', '--assume-unchanged']) {
    const dir = sampleRepo();
    // Stage broken code, then hide a working copy that passes.
    write(dir, 'src/math.js', BREAK_ADD);
    git(dir, 'add', 'src/math.js');
    git(dir, 'update-index', flag, 'src/math.js');
    write(dir, 'src/math.js', TWEAK_ADD);
    const id = packetId(pocp(dir, ['open', '--intent', 'x', '--touch', 'src/math.js']).stdout);
    const clean = pocp(dir, ['prove', id, '--json']);
    assert.notEqual(clean.code, 0, flag);
    assert.match(JSON.stringify(clean.json), /index_flags/, flag);
    const snap = pocp(dir, ['prove', id, '--mode', 'snapshot', '--json']);
    assert.equal(snap.json.packets[0].evaluation.failed.length, 1, `${flag}: the staged (broken) code is what ran`);
    assert.equal(read(dir, 'src/math.js'), TWEAK_ADD, 'the working copy is untouched');
  }
});

test('snapshot mode exports skip-worktree files (sparse checkouts can prove)', () => {
  const dir = sampleRepo();
  // Staged code passes; the hidden working copy is broken. Only a snapshot that contains the
  // staged file can pass.
  write(dir, 'src/math.js', TWEAK_ADD);
  git(dir, 'add', 'src/math.js');
  git(dir, 'update-index', '--skip-worktree', 'src/math.js');
  write(dir, 'src/math.js', BREAK_ADD);
  const id = packetId(pocp(dir, ['open', '--intent', 'x', '--touch', 'src/math.js']).stdout);
  const snap = pocp(dir, ['prove', id, '--mode', 'snapshot', '--json']);
  assert.equal(snap.code, 0, JSON.stringify(snap.json));
  assert.equal(snap.json.packets[0].evaluation.ok, true);
});

test('ci-run refuses a checkout with flagged files', () => {
  const dir = sampleRepo();
  git(dir, 'update-index', '--assume-unchanged', 'src/math.js');
  const r = pocp(dir, ['ci-run', '--results', 'r.jsonl', '--', 'true']);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /flagged/);
});
