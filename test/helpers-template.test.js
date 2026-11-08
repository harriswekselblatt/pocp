// The test helpers build sample repositories once and copy them for each test. On macOS CI,
// git's background maintenance (started by the template's last commit) created and removed
// .git/objects/maintenance.lock while it was being copied, and tests failed with ENOENT. The
// templates now tell git not to start background work, and the copy skips lock files and any
// entry that disappears while it is copied.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { copyTree, git, sampleRepo, tmpRepo } from './helpers.js';

test('template repositories start no background git maintenance or gc', () => {
  for (const dir of [sampleRepo(), tmpRepo()]) {
    assert.equal(git(dir, 'config', '--get', 'maintenance.auto'), 'false');
    assert.equal(git(dir, 'config', '--get', 'gc.auto'), '0');
  }
});

test('copyTree skips lock files and an entry that vanishes while it is copied', () => {
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'tree-src-'));
  fs.mkdirSync(path.join(src, 'objects'));
  fs.writeFileSync(path.join(src, 'objects', 'maintenance.lock'), '');
  fs.writeFileSync(path.join(src, 'index.lock'), '');
  fs.writeFileSync(path.join(src, 'objects', 'gone'), 'x');
  fs.writeFileSync(path.join(src, 'kept'), 'k');
  // "gone" is removed between the listing and its copy, as git's own temporary files are.
  const copy = fs.copyFileSync;
  fs.copyFileSync = (from, to, ...rest) => {
    if (path.basename(from) === 'gone') fs.rmSync(from);
    return copy(from, to, ...rest);
  };
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'tree-dest-'));
  try {
    copyTree(src, dest);
  } finally {
    fs.copyFileSync = copy;
  }
  assert.deepEqual(fs.readdirSync(dest).sort(), ['kept', 'objects']);
  assert.deepEqual(fs.readdirSync(path.join(dest, 'objects')), []);
  // Any other failure still fails the copy.
  assert.throws(() => copyTree(src, path.join(dest, 'missing', 'deeper')), /ENOENT/);
});
