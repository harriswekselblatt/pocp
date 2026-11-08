// The store lock is never taken from a live holder. A lock file appears with its owner's pid
// already in it; one whose owner can't be read (empty: a holder between creating the file and
// writing its pid, as older versions did) counts as held unless it is old. Two writers never
// hold it at once, including while an abandoned lock is being broken.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { breakStaleLock, withLock, withLockAsync } from '../src/store.js';

const STORE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'store.js');
const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pocp-lock2-')));

test('an empty lock (a holder that has not written its pid yet) is not stolen', () => {
  const dir = tmp();
  const lock = path.join(dir, 'pocp.lock');
  fs.writeFileSync(lock, '');
  assert.throws(() => withLock(lock, () => 'stolen', { waitMs: 200 }), /holds/);
  assert.equal(fs.readFileSync(lock, 'utf8'), '', 'the holder\'s lock is untouched');
  assert.deepEqual(fs.readdirSync(dir), ['pocp.lock'], 'no temporary files left behind');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a lock whose owner cannot be read is not stolen while it is fresh', () => {
  const dir = tmp();
  const lock = path.join(dir, 'pocp.lock');
  fs.writeFileSync(lock, 'not a pid');
  assert.throws(() => withLock(lock, () => 'stolen', { waitMs: 200 }), /holds/);
  assert.equal(breakStaleLock(lock, 'not a pid'), false, 'breaking it directly leaves it');
  assert.equal(fs.readFileSync(lock, 'utf8'), 'not a pid');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('an old lock with no readable owner is broken', () => {
  const dir = tmp();
  const lock = path.join(dir, 'pocp.lock');
  fs.writeFileSync(lock, '');
  const old = new Date(Date.now() - 10 * 60_000);
  fs.utimesSync(lock, old, old);
  assert.equal(withLock(lock, () => 'ran', { waitMs: 2_000 }), 'ran');
  assert.ok(!fs.existsSync(lock), 'released');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a held lock names its holder', () => {
  const dir = tmp();
  const lock = path.join(dir, 'pocp.lock');
  withLock(lock, () => {
    assert.match(fs.readFileSync(lock, 'utf8'), new RegExp(`^${process.pid} [0-9a-f]{16}$`), 'its pid and a token for this acquisition');
  });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('two writers in separate processes never hold the lock at once', async () => {
  const dir = tmp();
  const lock = path.join(dir, 'pocp.lock');
  const counter = path.join(dir, 'counter');
  const inside = path.join(dir, 'inside');
  fs.writeFileSync(counter, '0');
  const worker = path.join(dir, 'worker.mjs');
  fs.writeFileSync(worker, [
    `import fs from 'node:fs';`,
    `import { withLock } from ${JSON.stringify(STORE)};`,
    `const [lock, counter, inside, n] = process.argv.slice(2);`,
    'const nap = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);',
    'for (let i = 0; i < Number(n); i++) {',
    '  withLock(lock, () => {',
    // A second holder would find the marker already there.
    "    fs.writeFileSync(inside, String(process.pid), { flag: 'wx' });",
    "    if (!fs.readFileSync(lock, 'utf8').startsWith(`${process.pid} `)) throw new Error('lock does not name its holder');",
    "    const v = Number(fs.readFileSync(counter, 'utf8'));",
    '    nap(1);',
    '    fs.writeFileSync(counter, String(v + 1));',
    '    fs.rmSync(inside);',
    '  }, { waitMs: 60_000 });',
    '}',
    '',
  ].join('\n'));
  const N = 40;
  const runWorker = () => new Promise((resolve) => {
    const c = spawn(process.execPath, [worker, lock, counter, inside, String(N)], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    c.stderr.on('data', (d) => { err += d; });
    c.on('close', (code) => resolve({ code, err }));
  });
  const results = await Promise.all([runWorker(), runWorker(), runWorker()]);
  for (const r of results) assert.equal(r.code, 0, r.err);
  assert.equal(Number(fs.readFileSync(counter, 'utf8')), 3 * N, 'no lost updates');
  assert.ok(!fs.existsSync(lock), 'released');
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.includes('.lock.')), [], 'no temporary or stale files left');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('async holders in one process take turns', async () => {
  const dir = tmp();
  const lock = path.join(dir, 'pocp.lock');
  const order = [];
  await Promise.all([
    withLockAsync(lock, async () => { order.push('a1'); await new Promise((r) => setTimeout(r, 100)); order.push('a2'); }),
    new Promise((r) => setTimeout(r, 20)).then(() => withLockAsync(lock, async () => { order.push('b'); })),
  ]);
  assert.deepEqual(order, ['a1', 'a2', 'b']);
  fs.rmSync(dir, { recursive: true, force: true });
});

/** A pid that no live process has: a child that has already exited. */
function deadPid() {
  const r = spawnSync(process.execPath, ['-e', 'console.log(process.pid)'], { encoding: 'utf8' });
  return Number(r.stdout.trim());
}

test('breaking an abandoned lock never frees a slot a live holder took meanwhile', () => {
  const dir = tmp();
  const lock = path.join(dir, 'pocp.lock');
  const stale = `${deadPid()} 0123456789abcdef`;
  fs.writeFileSync(lock, stale);
  // A reads the abandoned lock; before A breaks it, B breaks it and takes the lock (live).
  assert.equal(breakStaleLock(lock, stale), true, 'B breaks the abandoned lock');
  withLock(lock, () => {
    const held = fs.readFileSync(lock, 'utf8');
    // A now acts on what it read earlier: B's lock is not touched.
    assert.equal(breakStaleLock(lock, stale), false);
    assert.equal(fs.readFileSync(lock, 'utf8'), held, "B's lock is intact");
    // A third contender can't get in while B holds it.
    assert.throws(() => withLock(lock, () => 'C ran', { waitMs: 100 }), /holds/);
  });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('while one breaker is removing an abandoned lock, other breakers and contenders wait', () => {
  const dir = tmp();
  const lock = path.join(dir, 'pocp.lock');
  const stale = `${deadPid()} 0123456789abcdef`;
  fs.writeFileSync(lock, stale);
  let insideRan = false;
  const removed = breakStaleLock(lock, stale, {
    hooks: {
      inside: () => {
        insideRan = true;
        // Barrier: the abandoned lock is still in place, so nobody can take the slot, and a
        // second breaker finds the break lock held.
        assert.equal(fs.readFileSync(lock, 'utf8'), stale);
        assert.equal(breakStaleLock(lock, stale), false, 'a second breaker backs off');
        assert.throws(() => withLock(lock, () => 'C ran', { waitMs: 100 }), /holds/);
      },
    },
  });
  assert.ok(insideRan);
  assert.equal(removed, true);
  assert.ok(!fs.existsSync(lock) && !fs.existsSync(`${lock}.break`), 'removed, and the break lock released');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a break lock left by a crash is not reclaimed automatically, and the error names it', () => {
  const dir = tmp();
  const lock = path.join(dir, 'pocp.lock');
  fs.writeFileSync(lock, `${deadPid()} 0123456789abcdef`);
  fs.writeFileSync(`${lock}.break`, `${deadPid()} fedcba9876543210`);
  const old = new Date(Date.now() - 10 * 60_000);
  fs.utimesSync(`${lock}.break`, old, old);
  assert.throws(() => withLock(lock, () => 'ran', { waitMs: 200 }), /\.break was left by a crash/);
  assert.ok(fs.existsSync(lock), 'nothing removed without the break lock');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('release removes only this acquisition\'s lock, never a lock someone else now holds', () => {
  const dir = tmp();
  const lock = path.join(dir, 'pocp.lock');
  withLock(lock, () => {
    // Simulate the lock having been replaced by another holder with the same pid (pid reuse).
    fs.writeFileSync(lock, `${process.pid} ffffffffffffffff`);
  });
  assert.equal(fs.readFileSync(lock, 'utf8'), `${process.pid} ffffffffffffffff`, 'left for its holder');
  fs.rmSync(dir, { recursive: true, force: true });
});
