// The runner's execution deadline covers the command only. A command that exits before its
// limit is never recorded as timed out, whatever its leftovers do; a leftover that holds
// stdout/stderr can't keep the run open until the limit; output is decoded per stream, so a
// multi-byte character split across chunks (or at the cap) never turns into U+FFFD.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createProcessRunner } from '../src/runner.js';

const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pocp-lifecycle-')));
const strays = [];
after(() => {
  for (const pid of strays) try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
  fs.rmSync(work, { recursive: true, force: true });
});
const run = (command, opts) => createProcessRunner().run(command, { cwd: work, env: { ...process.env, NODE_TEST_CONTEXT: undefined }, ...opts });
const script = (name, lines) => {
  fs.writeFileSync(path.join(work, name), lines.join('\n'));
  return `"${process.execPath}" ${name}`;
};

test('exit 0 while a SIGTERM-ignoring descendant in the group holds stdout: passes, not timed out, settles promptly', async () => {
  const cmd = script('bg-same-group.cjs', [
    "const { spawn } = require('node:child_process');",
    "spawn(process.execPath, ['-e', 'process.on(\"SIGTERM\", () => {}); setInterval(() => {}, 100)'], { stdio: ['ignore', 1, 2] });",
    'setTimeout(() => process.exit(0), 200);',
  ]);
  const t0 = Date.now();
  const r = await run(cmd, { timeoutMs: 20_000, killGraceMs: 300 });
  assert.equal(r.exit, 0);
  assert.equal(r.timed_out, false);
  assert.ok(Date.now() - t0 < 8_000, `took ${Date.now() - t0}ms`);
});

test('exit 0 while a descendant that left the group holds stdout: pipes are destroyed and the run settles', async () => {
  const pidFile = path.join(work, 'escaped.pid');
  const cmd = script('bg-escaped.cjs', [
    "const { spawn } = require('node:child_process');",
    "const c = spawn(process.execPath, ['-e', 'process.on(\"SIGTERM\", () => {}); setInterval(() => {}, 100)'], { stdio: ['ignore', 1, 2], detached: true });",
    `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(c.pid));`,
    "process.stdout.write('done\\n');",
    'setTimeout(() => process.exit(0), 100);',
  ]);
  const t0 = Date.now();
  const r = await run(cmd, { timeoutMs: 30_000, killGraceMs: 300, pipeGraceMs: 200 });
  strays.push(Number(fs.readFileSync(pidFile, 'utf8')));
  assert.equal(r.exit, 0);
  assert.equal(r.timed_out, false);
  assert.match(r.output, /done/);
  assert.ok(Date.now() - t0 < 10_000, `took ${Date.now() - t0}ms (the limit was 30s)`);
});

test('a command that exits before the limit is not timed out even when cleanup runs past the limit', async () => {
  // The leftover ignores SIGTERM and keeps stdout, so cleanup lasts the whole kill grace
  // (3s), well past the 1s execution limit. The command itself exited after about 0.2s.
  const cmd = script('late.cjs', [
    "const { spawn } = require('node:child_process');",
    "spawn(process.execPath, ['-e', 'process.on(\"SIGTERM\", () => {}); setInterval(() => {}, 100)'], { stdio: ['ignore', 1, 2] });",
    'setTimeout(() => process.exit(0), 200);',
  ]);
  const r = await run(cmd, { timeoutMs: 1_000, killGraceMs: 3_000 });
  assert.equal(r.exit, 0);
  assert.equal(r.timed_out, false);
});

test('a command still running at the limit is timed out', async () => {
  const r = await run('sleep 30', { timeoutMs: 300, killGraceMs: 200 });
  assert.equal(r.timed_out, true);
  assert.notEqual(r.exit, 0);
});

test('a character split across chunks is decoded whole; hashes cover the raw bytes', async () => {
  const cmd = script('split.cjs', [
    "const bytes = Buffer.from('é€😀'.repeat(50));",
    'let i = 0;',
    // Odd-sized writes with a pause between them, so characters straddle chunk boundaries.
    'const step = () => { if (i >= bytes.length) return; process.stdout.write(bytes.subarray(i, i + 7)); i += 7; setTimeout(step, 2); };',
    'step();',
  ]);
  const r = await run(cmd, { timeoutMs: 20_000 });
  assert.equal(r.exit, 0);
  assert.equal(r.output, 'é€😀'.repeat(50));
  assert.ok(!r.output.includes('�'));
  assert.equal(r.stdout_sha256, crypto.createHash('sha256').update(Buffer.from('é€😀'.repeat(50))).digest('hex'));
});

test('stdout and stderr are decoded separately', async () => {
  const cmd = script('both.cjs', [
    "const e = Buffer.from('é');",
    'process.stdout.write(e.subarray(0, 1));',
    "process.stderr.write(Buffer.from('ü'));",
    'setTimeout(() => process.stdout.write(e.subarray(1)), 50);',
  ]);
  const r = await run(cmd, { timeoutMs: 20_000 });
  assert.ok(!r.output.includes('�'), JSON.stringify(r.output));
  assert.ok(r.output.includes('é') && r.output.includes('ü'));
});

test('a character cut by the cap is left out, not replaced with U+FFFD', async () => {
  const r = await run("printf 'aéé'", { timeoutMs: 20_000, logCapBytes: 4 });
  assert.equal(r.truncated, true);
  assert.equal(r.output, 'aé');
});

test('a working folder that does not exist settles once with an error', async () => {
  const r = await createProcessRunner().run('true', { cwd: path.join(work, 'missing'), env: process.env, timeoutMs: 20_000 });
  assert.equal(r.exit, null);
  assert.equal(r.timed_out, false);
  assert.ok(r.error);
});
