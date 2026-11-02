// A check must never outlive the pocp process that started it, however pocp goes away,
// and the runner must never hand back a result while part of the check's group still runs.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RUNNER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'runner.js');
const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pocp-orphans-')));
const leftovers = new Set();
after(() => {
  for (const g of leftovers) try { process.kill(-g, 'SIGKILL'); } catch { /* gone */ }
  fs.rmSync(work, { recursive: true, force: true });
});

// A test file that records its pid and then just stays alive, like a hung test.
fs.writeFileSync(path.join(work, 'hang.test.js'), [
  "import test from 'node:test';",
  "import fs from 'node:fs';",
  "test('hang', () => new Promise(() => { fs.writeFileSync(process.env.PID_FILE + '.tmp', String(process.pid)); fs.renameSync(process.env.PID_FILE + '.tmp', process.env.PID_FILE); setInterval(() => {}, 1000); }));",
  '',
].join('\n'));
// A process that ignores SIGTERM, records its pid, and lets go of stdout/stderr.
fs.writeFileSync(path.join(work, 'stubborn.sh'), [
  '( trap "" TERM; echo $(sh -c \'echo $PPID\') > "$PID_FILE.tmp"; mv "$PID_FILE.tmp" "$PID_FILE"; while :; do sleep 1; done ) >/dev/null 2>&1 &',
  '',
].join('\n'));
fs.writeFileSync(path.join(work, 'parent.mjs'), [
  `import { createProcessRunner } from ${JSON.stringify(RUNNER)};`,
  'const [command, timeoutMs] = process.argv.slice(2);',
  "const res = await createProcessRunner().run(command, { cwd: process.cwd(), env: process.env, timeoutMs: Number(timeoutMs), killGraceMs: 500 });",
  "process.stdout.write(`DONE ${JSON.stringify({ exit: res.exit, timed_out: res.timed_out })}\\n`);",
  '',
].join('\n'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pgidOf = (pid) => Number(execFileSync('ps', ['-o', 'pgid=', '-p', String(pid)], { encoding: 'utf8' }).trim());
const ppidOf = (pid) => Number(execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8' }).trim());
// A zombie (finished, not yet reaped by PID 1) is not running, so it doesn't count.
function groupAlive(pgid) {
  try {
    process.kill(-pgid, 0);
  } catch (err) {
    return err.code === 'EPERM';
  }
  const rows = execFileSync('ps', ['-A', '-o', 'pgid=,stat='], { encoding: 'utf8' }).trim().split('\n');
  return rows.some((row) => { const [g, stat] = row.trim().split(/\s+/); return Number(g) === pgid && !stat.startsWith('Z'); });
}
async function waitFor(fn, ms, what) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = fn();
    if (v) return v;
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** Start parent.mjs running `command`; resolve once the check's pid file appears. */
async function start(name, command, timeoutMs = 600_000) {
  const pidFile = path.join(work, `${name}.pid`);
  // Without NODE_TEST_CONTEXT, the inner "node --test" runs its file as it would under pocp.
  const { NODE_TEST_CONTEXT, ...env } = process.env;
  const parent = spawn(process.execPath, [path.join(work, 'parent.mjs'), command, String(timeoutMs)], {
    cwd: work, env: { ...env, PID_FILE: pidFile }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  parent.stdout.on('data', (d) => { out += d; });
  parent.stderr.on('data', (d) => { out += d; });
  const exited = new Promise((r) => parent.on('exit', (code, signal) => r({ code, signal })));
  const pid = await waitFor(() => fs.existsSync(pidFile) && Number(fs.readFileSync(pidFile, 'utf8')), 30_000, `${name} to start`);
  const pgid = pgidOf(pid);
  leftovers.add(pgid);
  return { parent, pid, pgid, exited, output: () => out };
}

// Shell snippet: the leader waits until the stubborn process has written its pid.
const waitPid = 'while [ ! -f "$PID_FILE" ]; do sleep 0.05; done';

async function assertGroupGone(pgid, ms = 5_000) {
  const end = Date.now() + ms;
  while (Date.now() < end && groupAlive(pgid)) await sleep(50);
  assert.equal(groupAlive(pgid), false, `process group ${pgid} is still running ${ms}ms after pocp went away`);
  leftovers.delete(pgid);
}

for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP', 'SIGKILL']) {
  test(`${signal} to pocp kills a running "node --test" check's whole group`, async () => {
    const run = await start(`sig-${signal}`, 'node --test hang.test.js');
    // node --test's own children stay in the check's group, apart from pocp's.
    assert.equal(pgidOf(ppidOf(run.pid)), run.pgid, 'the test file process shares its node --test parent\'s group');
    assert.notEqual(run.pgid, pgidOf(run.parent.pid), 'the check runs in its own group');
    run.parent.kill(signal);
    const ex = await run.exited;
    assert.ok(ex.signal === signal || ex.code !== 0, `pocp stopped (${JSON.stringify(ex)})`);
    await assertGroupGone(run.pgid);
  });
}

test('a SIGTERM-ignoring process the check leaves behind is killed before the result is returned', async () => {
  const run = await start('left-behind', `sh stubborn.sh; ${waitPid}; echo leader done`);
  const ex = await run.exited;
  assert.equal(ex.code, 0, run.output());
  assert.match(run.output(), /DONE \{"exit":0,"timed_out":false\}/);
  // The result came back, so the group must already be empty (no waiting for a later timer).
  assert.equal(groupAlive(run.pgid), false, 'the runner returned while a check process was still running');
  leftovers.delete(run.pgid);
});

test('after a timeout, a SIGTERM-ignoring process that closed its output still gets SIGKILL', async () => {
  // The leader dies on SIGTERM; the stubborn process outlives it with stdout already closed.
  const run = await start('timeout', `sh stubborn.sh; ${waitPid}; exec sleep 600`, 1_500);
  const ex = await run.exited;
  assert.equal(ex.code, 0, run.output());
  assert.match(run.output(), /"timed_out":true/);
  assert.equal(groupAlive(run.pgid), false, 'the runner returned while a check process was still running');
  leftovers.delete(run.pgid);
});
