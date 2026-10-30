// A temporary folder pocp starts to build is removed even when building it fails.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sampleRepo } from './helpers.js';
import { copySnapshot, createIndexSnapshot, createRevCheckout, liveTempDirs } from '../src/workspace.js';

const listing = () => fs.readdirSync(os.tmpdir()).sort();

test('a failed snapshot, copy or checkout leaves no folder behind', () => {
  const repo = sampleRepo();
  const notRepo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'not-a-repo-')));
  const before = listing();

  assert.throws(() => copySnapshot(path.join(notRepo, 'missing')));
  assert.throws(() => copySnapshot(path.join(repo, 'README.md')));
  assert.throws(() => createIndexSnapshot(notRepo));
  assert.throws(() => createRevCheckout(repo, 'no-such-rev'));

  assert.deepEqual(listing(), before);
  assert.deepEqual(liveTempDirs(), [], 'nothing is left registered for exit cleanup either');
});
