import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { git, tmpRepo, write } from './helpers.js';
import { changedPaths, stagedChanges, subjectHashIndex, subjectHashRev, commitChanges } from '../src/git.js';

test('subject hash: index before commit equals the commit after', () => {
  const dir = tmpRepo();
  write(dir, 'a.txt', 'one\n');
  write(dir, 'bin/run.sh', '#!/bin/sh\n');
  fs.chmodSync(path.join(dir, 'bin/run.sh'), 0o755);
  git(dir, 'add', '-A');
  const before = subjectHashIndex(dir);
  git(dir, 'commit', '-q', '-m', 'x');
  assert.equal(subjectHashRev(dir, 'HEAD'), before);
});

test('subject hash ignores .proof/ but sees content, mode and deletions', () => {
  const dir = tmpRepo();
  write(dir, 'a.txt', 'one\n');
  write(dir, 'b.txt', 'two\n');
  git(dir, 'add', '-A');
  const base = subjectHashIndex(dir);

  write(dir, '.proof/packets/p-1.json', '{}');
  git(dir, 'add', '-A');
  assert.equal(subjectHashIndex(dir), base, '.proof/ is excluded');

  write(dir, 'a.txt', 'changed\n');
  git(dir, 'add', '-A');
  const changed = subjectHashIndex(dir);
  assert.notEqual(changed, base);

  fs.chmodSync(path.join(dir, 'a.txt'), 0o755);
  git(dir, 'add', '-A');
  assert.notEqual(subjectHashIndex(dir), changed, 'mode change counts');

  git(dir, 'rm', '-qf', 'b.txt');
  assert.notEqual(subjectHashIndex(dir), changed, 'deletion counts');
});

test('staged changes: works before the first commit, renames count by both paths', () => {
  const dir = tmpRepo();
  write(dir, 'src/auth/token.js', 'export const t = 1;\n'.repeat(20));
  write(dir, 'old.txt', 'bye\n');
  git(dir, 'add', '-A');
  assert.deepEqual(changedPaths(stagedChanges(dir)), ['old.txt', 'src/auth/token.js'], 'no HEAD yet');
  git(dir, 'commit', '-q', '-m', 'init');

  fs.mkdirSync(path.join(dir, 'lib'));
  git(dir, 'mv', 'src/auth/token.js', 'lib/token.js');
  git(dir, 'rm', '-q', 'old.txt');
  const changes = stagedChanges(dir);
  assert.ok(changes.some((c) => c.status === 'R' && c.oldPath === 'src/auth/token.js' && c.path === 'lib/token.js'));
  assert.deepEqual(changedPaths(changes), ['lib/token.js', 'old.txt', 'src/auth/token.js']);
  git(dir, 'commit', '-q', '-m', 'move');
  assert.deepEqual(changedPaths(commitChanges(dir, 'HEAD')), ['lib/token.js', 'old.txt', 'src/auth/token.js']);
});

test('paths with spaces and unicode survive', () => {
  const dir = tmpRepo();
  write(dir, 'dir with space/ünï.js', 'x\n');
  git(dir, 'add', '-A');
  assert.deepEqual(changedPaths(stagedChanges(dir)), ['dir with space/ünï.js']);
});
