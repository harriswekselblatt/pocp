import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { git, sh, tmpRepo, write } from './helpers.js';
import { catFileBatch, commitChanges, parentOf, readFilesAt, showFile, showFileBuffer, treeEntries } from '../src/git.js';

/** Git commands run by `fn`, from GIT_TRACE (every git call inherits process.env). */
function gitCalls(fn) {
  const trace = path.join(fs.mkdtempSync(path.join(process.env.TMPDIR, 'trace-')), 'trace');
  process.env.GIT_TRACE = trace;
  try {
    fn();
  } finally {
    delete process.env.GIT_TRACE;
  }
  const text = fs.existsSync(trace) ? fs.readFileSync(trace, 'utf8') : '';
  return [...text.matchAll(/trace: built-in: git (\S+)/g)].map((m) => m[1]);
}

function repoWithTwoCommits() {
  const dir = tmpRepo();
  write(dir, 'a.txt', 'one\n');
  write(dir, 'dir/b.txt', 'two\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'first');
  write(dir, 'a.txt', 'changed\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'second');
  return { dir, head: git(dir, 'rev-parse', 'HEAD'), first: git(dir, 'rev-parse', 'HEAD^') };
}

test('catFileBatch: one call answers many names, null for what git lacks', () => {
  const { dir, head } = repoWithTwoCommits();
  let answers;
  const calls = gitCalls(() => { answers = catFileBatch(dir, [`${head}:a.txt`, `${head}:nope.txt`, head]); });
  assert.deepEqual(calls, ['cat-file']);
  assert.equal(answers[0].type, 'blob');
  assert.equal(answers[0].data.toString(), 'changed\n');
  assert.equal(answers[1], null);
  assert.equal(answers[2].type, 'commit');
});

test('readFilesAt gives the same answers as git show, path by path', () => {
  const { dir, head } = repoWithTwoCommits();
  const paths = ['a.txt', 'dir/b.txt', 'missing.txt', 'dir'];
  const expected = paths.map((p) => {
    try {
      return git(dir, 'show', `${head}:${p}`);
    } catch {
      return null;
    }
  });
  const got = readFilesAt(dir, head, paths);
  paths.forEach((p, i) => {
    const b = got.get(p);
    assert.equal(b === null ? null : b.toString().replace(/\s+$/, ''), expected[i], p);
  });
});

test('reads by full commit id are remembered; repeated reads make no git call', () => {
  const { dir, head } = repoWithTwoCommits();
  readFilesAt(dir, head, ['a.txt', 'missing.txt']);
  treeEntries(dir, head);
  commitChanges(dir, head);
  parentOf(dir, head);
  const again = gitCalls(() => {
    assert.equal(showFile(dir, head, 'a.txt'), 'changed\n');
    assert.equal(showFile(dir, head, 'missing.txt'), null);
    assert.equal(treeEntries(dir, head).length, 2);
    assert.deepEqual(commitChanges(dir, head), [{ status: 'M', path: 'a.txt' }]);
    assert.ok(parentOf(dir, head));
  });
  assert.deepEqual(again, []);
});

test('a ref is never remembered: HEAD read again after a new commit gives the new content', () => {
  const { dir } = repoWithTwoCommits();
  assert.equal(showFile(dir, 'HEAD', 'a.txt'), 'changed\n');
  assert.equal(treeEntries(dir, 'HEAD').length, 2);
  write(dir, 'a.txt', 'third\n');
  write(dir, 'c.txt', 'new\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'third');
  assert.equal(showFile(dir, 'HEAD', 'a.txt'), 'third\n');
  assert.equal(treeEntries(dir, 'HEAD').length, 3);
  assert.deepEqual(commitChanges(dir, 'HEAD').map((c) => c.path).sort(), ['a.txt', 'c.txt']);
});

test('a failed read is not remembered: a commit written later is then read', () => {
  const { dir, head } = repoWithTwoCommits();
  const tree = git(dir, 'rev-parse', `${head}^{tree}`);
  const body = `tree ${tree}\nparent ${head}\nauthor A <a@e.x> 1700000000 +0000\ncommitter A <a@e.x> 1700000000 +0000\n\nlater\n`;
  const id = sh(dir, 'git', ['hash-object', '-t', 'commit', '--stdin'], { input: body }).stdout.trim();
  // Not in the store yet: every answer is "unknown".
  assert.equal(parentOf(dir, id), null);
  assert.equal(showFile(dir, id, 'a.txt'), null);
  sh(dir, 'git', ['hash-object', '-t', 'commit', '-w', '--stdin'], { input: body });
  assert.equal(parentOf(dir, id), head);
  assert.equal(showFile(dir, id, 'a.txt'), 'changed\n');
});

test('a buffer handed out is a copy: writing into it changes no later read', () => {
  const { dir, head } = repoWithTwoCommits();
  const b = showFileBuffer(dir, head, 'a.txt');
  b.fill(0x78);
  assert.equal(showFileBuffer(dir, head, 'a.txt').toString(), 'changed\n');
});
