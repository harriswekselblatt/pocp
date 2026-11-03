import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hookBodies, recordedBin, SELF_BIN } from '../src/init.js';
import { pocp, sampleRepo, sh, write } from './helpers.js';

// PATH with node and git but (normally) no pocp, and no POCP_BIN: the case that used to fail.
// node gets a folder of its own, since a global pocp often sits next to it.
const NODE_ONLY = fs.mkdtempSync(path.join(os.tmpdir(), 'pocp-node-'));
fs.symlinkSync(process.execPath, path.join(NODE_ONLY, 'node'));
const BARE_PATH = [NODE_ONLY, '/usr/bin', '/bin'].join(':');
const POCP_ON_BARE_PATH = spawnSync('sh', ['-c', 'command -v pocp'], { env: { PATH: BARE_PATH }, encoding: 'utf8' }).stdout.trim();

test('hooks find the pocp that installed them when it is not local or on PATH', { skip: POCP_ON_BARE_PATH ? `pocp is on ${POCP_ON_BARE_PATH}` : false }, () => {
  const dir = sampleRepo({ hooks: true });
  write(dir, 'README.md', '# sample, edited\n');
  sh(dir, 'git', ['add', 'README.md']);
  const r = sh(dir, 'git', ['commit', '-q', '-m', 'docs'], { env: { PATH: BARE_PATH, POCP_BIN: '' }, allowFail: true });
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stderr, /pocp: not found/);
  assert.match(r.stderr + r.stdout, /gate passed/);
  const doc = pocp(dir, ['doctor', '--json'], { env: { PATH: BARE_PATH, POCP_BIN: '' } });
  const hooks = doc.json.checks.find((c) => c.id === 'hooks');
  assert.equal(hooks.status, 'ok', hooks.what);
  assert.match(hooks.what, /the pocp that installed them/);
});

test('the recorded path survives shell quoting', () => {
  const odd = "/tmp/it's here/bin/pocp.js";
  assert.equal(recordedBin(hookBodies(odd)['pre-commit']), odd);
  assert.equal(recordedBin(hookBodies()['pre-commit']), SELF_BIN);
  assert.equal(recordedBin(hookBodies(null)['pre-commit']), null);
});
