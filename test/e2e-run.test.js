import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { git, packetId, pocp, read, sampleRepo, sh, write, writeConfig, writeRules } from './helpers.js';
import { BREAK_ADD, TWEAK_ADD, IS_ROOT, commit, makeKey } from './fixtures.js';

test('clean mode refuses unstaged edits; snapshot mode proves exactly what is staged', () => {
  const dir = sampleRepo();
  write(dir, 'src/math.js', TWEAK_ADD);
  git(dir, 'add', 'src/math.js');
  write(dir, 'src/math.js', BREAK_ADD); // broken, but not staged
  const id = packetId(pocp(dir, ['open', '--intent', 'tweak', '--touch', 'src/math.js']).stdout);
  const clean = pocp(dir, ['prove', id]);
  assert.equal(clean.code, 1);
  assert.match(clean.stderr, /clean mode refused/);
  const snap = pocp(dir, ['prove', id, '--mode', 'snapshot', '--json']);
  assert.equal(snap.code, 0, snap.stdout + snap.stderr);
  assert.equal(snap.json.packets[0].evaluation.ok, true, 'the staged (good) code passed');
  assert.equal(read(dir, 'src/math.js'), BREAK_ADD, 'working folder untouched');
});

test('a command that rewrites tracked files has its proof thrown away', () => {
  const dir = sampleRepo({ rules: { requirements: [], triggers: { globs: [{ glob: 'src/**', require_packet: true }] } } });
  write(dir, 'src/math.js', TWEAK_ADD);
  git(dir, 'add', 'src/math.js');
  const id = packetId(pocp(dir, ['open', '--intent', 'tweak', '--touch', 'src/math.js', '--command', 'echo "// formatted" >> src/math.js']).stdout);
  const r = pocp(dir, ['prove', id, '--json']);
  assert.match(JSON.stringify(r.json.packets[0].runs[0].discarded), /changed files in the working folder/);
  assert.equal(r.json.packets[0].evaluation.ok, false);
});

test('snapshot mode: exported files are read-only and tampering voids the proof', () => {
  const dir = sampleRepo({ rules: { requirements: [], triggers: { globs: [{ glob: 'src/**', require_packet: true }] } } });
  write(dir, 'src/math.js', TWEAK_ADD);
  git(dir, 'add', 'src/math.js');
  const id = packetId(pocp(dir, ['open', '--intent', 'tweak', '--touch', 'src/math.js', '--command', 'chmod u+w src/math.js && echo x >> src/math.js']).stdout);
  const r = pocp(dir, ['prove', id, '--mode', 'snapshot', '--json']);
  assert.match(JSON.stringify(r.json.packets[0].runs[0].discarded), /changed files in the snapshot/);
  const ro = pocp(dir, ['add', id, '--command', 'echo x >> src/math.js']);
  assert.equal(ro.code, 0);
  const r2 = pocp(dir, ['prove', id, '--mode', 'snapshot', '--only', 'o2', '--json']);
  const o2 = r2.json.packets[0].runs.find((x) => x.obligation === 'o2');
  if (IS_ROOT) {
    // Root ignores the read-only bit, so the write succeeds; the snapshot hash still voids the proof.
    assert.match(JSON.stringify(o2.discarded), /changed files in the snapshot/);
  } else {
    assert.equal(o2.passed, false, 'write to a read-only file fails');
  }
});

test('timeouts kill the whole process group', () => {
  const dir = sampleRepo({ rules: { requirements: [], triggers: { globs: [{ glob: 'src/**', require_packet: true }] } } });
  write(dir, 'src/math.js', TWEAK_ADD);
  git(dir, 'add', 'src/math.js');
  const id = packetId(pocp(dir, ['open', '--intent', 'slow', '--touch', 'src/math.js', '--test', 'sleep 30 & sleep 30', '--timeout', '300']).stdout);
  writeConfig(dir, { run: { kill_grace_ms: 200 } });
  const started = Date.now();
  const r = pocp(dir, ['prove', id, '--json']);
  assert.ok(Date.now() - started < 10_000, 'returned promptly');
  const run = r.json.packets[0].runs[0];
  assert.equal(run.timed_out, true);
  assert.equal(run.passed, false);
});

test('raw output never lands in the packet file', () => {
  const dir = sampleRepo({ rules: { requirements: [], triggers: { globs: [{ glob: 'src/**', require_packet: true }] } } });
  write(dir, 'src/math.js', TWEAK_ADD);
  git(dir, 'add', 'src/math.js');
  const id = packetId(pocp(dir, ['open', '--intent', 'x', '--touch', 'src/math.js', '--command', 'echo "$MY_SECRET"', '--expect', 'SECRET']).stdout);
  const r = pocp(dir, ['prove', id, '--json'], { env: { MY_SECRET: 'SECRET_TOKEN_abc123' } });
  assert.equal(r.json.packets[0].evaluation.ok, true, 'expect matched the output');
  assert.doesNotMatch(read(dir, `.proof/packets/${id}.json`), /SECRET_TOKEN/);
  const runId = r.json.packets[0].runs[0].run_id;
  assert.match(read(dir, `.proof/runs/${runId}.log`), /SECRET_TOKEN/, 'kept in the local, git-ignored log');
  assert.match(git(dir, 'check-ignore', `.proof/runs/${runId}.log`), /runs/);
});

test('concurrent provers do not lose each other\'s proofs', async () => {
  const dir = sampleRepo({ rules: { requirements: [], triggers: { globs: [{ glob: 'src/**', require_packet: true }] } } });
  write(dir, 'src/math.js', TWEAK_ADD);
  git(dir, 'add', 'src/math.js');
  const a = packetId(pocp(dir, ['open', '--intent', 'a', '--touch', 'src/math.js', '--test', 'sleep 0.3 && node test/math.check.mjs']).stdout);
  const b = packetId(pocp(dir, ['open', '--intent', 'b', '--touch', 'src/math.js', '--test', 'sleep 0.3 && true']).stdout);
  const { spawn } = await import('node:child_process');
  const run = (id) => new Promise((resolve) => {
    const c = spawn(process.execPath, [fileURLToPath(new URL('../bin/pocp.js', import.meta.url)), 'prove', id], { cwd: dir, env: process.env });
    c.on('close', resolve);
  });
  const codes = await Promise.all([run(a), run(b)]);
  assert.deepEqual(codes, [0, 0]);
  for (const id of [a, b]) {
    const p = JSON.parse(read(dir, `.proof/packets/${id}.json`));
    assert.equal(p.state, 'proven', `${id} kept its proof`);
  }
});

test('a check proven for the same code is reused, not re-run', () => {
  const dir = sampleRepo();
  write(dir, 'src/math.js', TWEAK_ADD);
  git(dir, 'add', 'src/math.js');
  const a = packetId(pocp(dir, ['open', '--intent', 'a', '--touch', 'src/math.js']).stdout);
  assert.equal(pocp(dir, ['prove', a]).code, 0);
  const b = packetId(pocp(dir, ['open', '--intent', 'b', '--touch', 'src/**']).stdout);
  const r = pocp(dir, ['prove', b, '--json']);
  assert.equal(r.json.ran, 0);
  assert.equal(r.json.packets[0].runs[0].reused_from, a);
  assert.equal(r.json.packets[0].evaluation.ok, true);
});
