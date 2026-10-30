// A finished process that hasn't been reaped (a zombie) is not a running check. The runner's
// watchdog is an orphan once the check exits, so only PID 1 can reap it: about 2 s late in
// some Linux sandboxes, and never in a container without an init.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createProcessRunner, groupAlive, liveInGroup } from '../src/runner.js';

const linux = process.platform === 'linux';
const hasSetsid = linux && spawnSync('setsid', ['true']).status === 0;

test('liveInGroup reads /proc and skips zombies and other groups', () => {
  const proc = fs.mkdtempSync(path.join(os.tmpdir(), 'pocp-proc-'));
  const stat = (pid, comm, state, pgrp) => {
    fs.mkdirSync(path.join(proc, String(pid)));
    fs.writeFileSync(path.join(proc, String(pid), 'stat'), `${pid} (${comm}) ${state} 1 ${pgrp} ${pgrp} 0 -1\n`);
  };
  stat(10, 'sh', 'Z', 42);
  stat(11, 'odd) name (x', 'Z', 42); // comm can hold parentheses and spaces
  stat(12, 'node', 'S', 7);
  fs.mkdirSync(path.join(proc, 'self'));
  assert.equal(liveInGroup(42, proc), 0, 'only zombies left: nothing is running');
  stat(13, 'sleep', 'S', 42);
  assert.equal(liveInGroup(42, proc), 1);
  assert.equal(liveInGroup(42, path.join(proc, 'missing')), null, 'no /proc: unknown');
  fs.rmSync(proc, { recursive: true, force: true });
});

test('a group holding only an unreaped zombie is not alive', { skip: !hasSetsid && 'needs Linux and setsid' }, async () => {
  // The inner shell becomes its own group and exits; its parent execs sleep, which never reaps it.
  const holder = spawn('sh', ['-c', 'setsid sh -c \'echo $$\' & exec sleep 30'], { stdio: ['ignore', 'pipe', 'ignore'] });
  try {
    const pgid = await new Promise((resolve) => holder.stdout.once('data', (d) => resolve(Number(String(d).trim()))));
    const end = Date.now() + 5_000;
    while (liveInGroup(pgid) !== 0 && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
    assert.doesNotThrow(() => process.kill(-pgid, 0), 'kill(0) still sees the zombie');
    assert.equal(groupAlive(pgid), false);
  } finally {
    holder.kill('SIGKILL');
  }
});

test('a check that exits at once returns at once, whoever reaps its watchdog', async () => {
  const runner = createProcessRunner();
  const res = await runner.run('true', { cwd: os.tmpdir(), timeoutMs: 10_000 });
  assert.equal(res.exit, 0);
  assert.ok(res.duration_ms < 1_000, `took ${res.duration_ms} ms`);
});
