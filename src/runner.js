import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { onCleanup } from './exit.js';

const MINIMAL_ENV = ['PATH', 'HOME', 'LANG', 'TMPDIR', 'CI'];

// GitHub Actions' step files and runner tokens. A check is the pull request's code: with these
// it could set the verify step's outputs or environment, or write to the job summary, and so
// fake what the job reports. Checks never get them; "pocp ci-run", which wraps the
// repository's own test step, keeps them (keepCiFiles).
export const CI_STEP_VARS = Object.freeze(['GITHUB_OUTPUT', 'GITHUB_ENV', 'GITHUB_PATH', 'GITHUB_STATE', 'GITHUB_STEP_SUMMARY']);

export function buildEnv({ mode = 'inherit', allow = [], extra = {}, keepCiFiles = false } = {}) {
  let env;
  if (mode === 'minimal') {
    env = {};
    for (const k of [...MINIMAL_ENV, ...allow]) if (process.env[k] !== undefined) env[k] = process.env[k];
  } else {
    env = { ...process.env };
  }
  // Node's test runner marks its child processes with NODE_TEST_CONTEXT. A check that inherits
  // it (pocp run from inside a test) makes its own `node --test` report to a parent that isn't
  // listening, and failures no longer set the exit code. A check runs as from a terminal.
  delete env.NODE_TEST_CONTEXT;
  if (!keepCiFiles) {
    for (const k of CI_STEP_VARS) delete env[k];
    for (const k of Object.keys(env)) if (k.startsWith('ACTIONS_')) delete env[k];
  }
  return { ...env, ...extra };
}

function killGroup(child, signal) {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch { /* already gone */ }
  }
}

/**
 * Linux: how many processes in group `pgid` haven't finished (zombies don't count).
 * null where /proc can't be read, so the caller falls back to kill(0).
 */
export function liveInGroup(pgid, procDir = '/proc') {
  let names;
  try {
    names = fs.readdirSync(procDir);
  } catch {
    return null;
  }
  let live = 0;
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    let stat;
    try {
      stat = fs.readFileSync(`${procDir}/${name}/stat`, 'utf8');
    } catch {
      continue; // exited while we looked
    }
    // "pid (comm) state ppid pgrp ...": comm may hold spaces and parentheses.
    const f = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    if (Number(f[2]) === pgid && f[0] !== 'Z' && f[0] !== 'X') live++;
  }
  return live;
}

/**
 * Is any process in group `pgid` still running? kill(0) also succeeds for a zombie, and a
 * check's leftover watchdog is an orphan whose zombie only PID 1 can reap: late in some
 * sandboxes (about 2 s), never in a container without an init. On Linux, zombies don't count.
 */
export function groupAlive(pgid) {
  if (!pgid) return false;
  try {
    process.kill(-pgid, 0);
  } catch (err) {
    return err.code === 'EPERM';
  }
  if (process.platform !== 'linux') return true;
  const live = liveInGroup(pgid);
  return live === null ? true : live > 0;
}

// The command runs under a small watchdog that shares its process group. The watchdog reads
// fd 3, a pipe whose other end only this pocp process holds. If pocp dies in a way no handler
// can catch (SIGKILL, a crash, the OOM killer), the kernel closes that pipe, the read ends,
// and the watchdog kills the whole group. fd 3 is closed before the command itself runs.
// Each pocp exit path that can run code also kills the group (see onCleanup below).
const WATCHDOG = '(while read -r _; do :; done; kill -9 0) <&3 >/dev/null 2>&1 &\nexec 3<&-\nexec /bin/sh -c "$0"';

/**
 * Default Runner. Runs `command` with /bin/sh in its own process group.
 * Output is hashed in full, logged up to `logCapBytes`, and kept in memory up to the
 * same cap so `expect` can be matched.
 */
export function createProcessRunner() {
  return {
    kind: 'process',
    run(command, { cwd, env, timeoutMs = 600_000, killGraceMs = 5_000, logFile = null, logCapBytes = 10 * 1024 * 1024 } = {}) {
      return new Promise((resolve) => {
        const startedAt = Date.now();
        const hashes = { stdout: crypto.createHash('sha256'), stderr: crypto.createHash('sha256') };
        let captured = '';
        let capturedBytes = 0;
        let truncated = false;
        let log = null;
        if (logFile) {
          log = fs.openSync(logFile, 'w');
          fs.writeSync(log, `$ ${command}\n# cwd: ${cwd}\n\n`);
        }
        const take = (stream) => (chunk) => {
          hashes[stream].update(chunk);
          if (capturedBytes < logCapBytes) {
            const room = logCapBytes - capturedBytes;
            const part = chunk.length > room ? chunk.subarray(0, room) : chunk;
            if (part.length < chunk.length) truncated = true;
            capturedBytes += part.length;
            captured += part.toString('utf8');
            if (log) fs.writeSync(log, part);
          } else {
            truncated = true;
          }
        };

        let child;
        try {
          child = spawn('/bin/sh', ['-c', WATCHDOG, command], { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe', 'pipe'] });
        } catch (err) {
          if (log) fs.closeSync(log);
          resolve({ exit: null, signal: null, timed_out: false, error: err.message, duration_ms: 0, output: '', truncated: false,
            stdout_sha256: hashes.stdout.digest('hex'), stderr_sha256: hashes.stderr.digest('hex') });
          return;
        }
        // If pocp itself is interrupted, stop the check's whole process group too.
        const unregister = onCleanup(() => killGroup(child, 'SIGKILL'));
        child.stdio[3].resume(); // read the watchdog pipe so its end (when the group empties) is seen
        child.stdout.on('data', take('stdout'));
        child.stderr.on('data', take('stderr'));

        let timedOut = false;
        let graceTimer = null;
        const timer = setTimeout(() => {
          timedOut = true;
          killGroup(child, 'SIGTERM');
          graceTimer = setTimeout(() => killGroup(child, 'SIGKILL'), killGraceMs);
        }, timeoutMs);

        let exitInfo = null;
        let termSentAt = null;
        child.on('exit', (code, signal) => {
          exitInfo = { code, signal };
          // Clean up anything the command left running in its group (and the watchdog).
          termSentAt = Date.now();
          killGroup(child, 'SIGTERM');
        });
        child.on('error', (err) => {
          exitInfo = exitInfo || { code: null, signal: null, error: err.message };
        });
        // The group is only released once it is empty: a process that ignores SIGTERM, or
        // that let go of stdout/stderr (so "close" came early), gets SIGKILL after the grace
        // period. Until then the onCleanup handler above still covers pocp exiting.
        const reap = (done) => {
          const deadline = (termSentAt ?? Date.now()) + killGraceMs;
          let killed = false;
          const started = Date.now();
          const tick = () => {
            if (!groupAlive(child.pid)) return done();
            if (!killed && Date.now() >= deadline) {
              killed = true;
              killGroup(child, 'SIGKILL');
            }
            setTimeout(tick, Date.now() - started < 200 ? 2 : 25);
          };
          tick();
        };
        child.on('close', (code, signal) => reap(() => {
          unregister();
          clearTimeout(timer);
          if (graceTimer) clearTimeout(graceTimer);
          const info = exitInfo || { code, signal };
          if (log) {
            if (truncated) fs.writeSync(log, `\n\n# output truncated at ${logCapBytes} bytes\n`);
            fs.writeSync(log, `\n# exit=${info.code} signal=${info.signal} timed_out=${timedOut}\n`);
            fs.closeSync(log);
          }
          resolve({
            exit: info.code,
            signal: info.signal,
            timed_out: timedOut,
            error: info.error,
            duration_ms: Date.now() - startedAt,
            output: captured,
            truncated,
            stdout_sha256: hashes.stdout.digest('hex'),
            stderr_sha256: hashes.stderr.digest('hex'),
          });
        }));
      });
    },
  };
}
