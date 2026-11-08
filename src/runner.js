import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
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
  // Last, after `allow` and `extra`: a check never sees variables that point git at another
  // repository, index or config. Git sets GIT_INDEX_FILE (and sometimes GIT_DIR) for the commit
  // hooks, so a check run from a hook that runs git in a temporary repository would otherwise
  // write into the committer's index.
  const out = { ...env, ...extra };
  for (const k of Object.keys(out)) if (isGitRedirectVar(k)) delete out[k];
  return out;
}

// Environment variables that point git at another repository, index, object store or config
// (the same set src/git.js keeps out of its own calls in isolation), plus every GIT_CONFIG*.
export const GIT_REDIRECT_VARS = Object.freeze([
  'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_COMMON_DIR', 'GIT_NAMESPACE', 'GIT_PREFIX', 'GIT_REPLACE_REF_BASE', 'GIT_SHALLOW_FILE', 'GIT_GRAFT_FILE',
  'GIT_CEILING_DIRECTORIES',
]);
const GIT_REDIRECT = new Set(GIT_REDIRECT_VARS);

/** Is `name` a variable that redirects git (GIT_DIR, GIT_INDEX_FILE, GIT_CONFIG*, …)? */
export function isGitRedirectVar(name) {
  return GIT_REDIRECT.has(name) || name.startsWith('GIT_CONFIG');
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
 *
 * Lifecycle: the execution deadline (`timeoutMs`) covers the command only and is cleared as
 * soon as its exit is observed, so a command that exits before the limit is never recorded as
 * timed out. Cleanup has its own deadline: on exit the rest of the group gets SIGTERM, then
 * SIGKILL after `killGraceMs`. Once the group is empty, a descendant that left the group but
 * still holds stdout/stderr gets `pipeGraceMs` to let go before the pipes are destroyed, so the
 * run settles promptly. It settles exactly once.
 */
export function createProcessRunner() {
  return {
    kind: 'process',
    run(command, { cwd, env, timeoutMs = 600_000, killGraceMs = 5_000, pipeGraceMs = 250, logFile = null, logCapBytes = 10 * 1024 * 1024 } = {}) {
      return new Promise((resolve) => {
        const startedAt = Date.now();
        const hashes = { stdout: crypto.createHash('sha256'), stderr: crypto.createHash('sha256') };
        // One decoder per stream: a multi-byte character split across chunks is decoded whole.
        // Hashes and the log stay over the raw bytes.
        const decoders = { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') };
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
            captured += decoders[stream].write(part);
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

        let exitInfo = null;
        let timedOut = false;
        let settled = false;
        let closed = false;
        let reaped = false;
        let reaping = false;
        let graceTimer = null;
        let pipeTimer = null;
        let timer = null;

        const settle = () => {
          if (settled) return;
          settled = true;
          unregister();
          clearTimeout(timer);
          clearTimeout(graceTimer);
          clearTimeout(pipeTimer);
          // Output cut off at the cap keeps a partial character out; output read to the end
          // flushes whatever the decoders still hold.
          if (!truncated) captured += decoders.stdout.end() + decoders.stderr.end();
          const info = exitInfo || { code: null, signal: null };
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
        };
        const maybeSettle = () => {
          if (closed && reaped) settle();
        };
        const destroyPipes = () => {
          for (const s of [child.stdout, child.stderr, child.stdio[3]]) {
            try {
              s?.destroy();
            } catch { /* already closed */ }
          }
        };

        // The execution deadline. When it fires, the command's exit may already be waiting in
        // the event loop (timers run before I/O), so look again after I/O before calling it a
        // timeout: a command that exited in time is never recorded as timed out.
        timer = setTimeout(() => setImmediate(() => {
          if (exitInfo || settled) return;
          timedOut = true;
          killGroup(child, 'SIGTERM');
          graceTimer = setTimeout(() => killGroup(child, 'SIGKILL'), killGraceMs);
        }), timeoutMs);

        // Started when the command exits. The group is only released once it is empty: a
        // process that ignores SIGTERM gets SIGKILL after the grace period, and until then the
        // onCleanup handler above still covers pocp exiting. Then stdout/stderr get a short
        // grace to close; a descendant that left the group but still holds them can't keep the
        // run open (they are destroyed).
        const reap = () => {
          if (reaping) return;
          reaping = true;
          const deadline = Date.now() + killGraceMs;
          let killed = false;
          const started = Date.now();
          const tick = () => {
            if (settled) return;
            if (!groupAlive(child.pid)) {
              reaped = true;
              if (!closed) {
                pipeTimer = setTimeout(() => {
                  destroyPipes();
                  closed = true;
                  maybeSettle();
                }, pipeGraceMs);
              }
              maybeSettle();
              return;
            }
            if (!killed && Date.now() >= deadline) {
              killed = true;
              killGroup(child, 'SIGKILL');
            }
            setTimeout(tick, Date.now() - started < 200 ? 2 : 25);
          };
          tick();
        };

        child.on('exit', (code, signal) => {
          exitInfo = exitInfo?.error ? { ...exitInfo, code, signal } : { code, signal };
          // The command is done: its execution deadline no longer applies.
          clearTimeout(timer);
          // Clean up anything the command left running in its group (and the watchdog).
          killGroup(child, 'SIGTERM');
          reap();
        });
        child.on('error', (err) => {
          exitInfo = exitInfo || { code: null, signal: null, error: err.message };
          // It never started (no pid): there is no group to reap and no exit to wait for.
          if (!child.pid) {
            clearTimeout(timer);
            reaped = true;
            destroyPipes();
            closed = true;
            setImmediate(maybeSettle);
          }
        });
        child.on('close', () => {
          closed = true;
          maybeSettle();
        });
      });
    },
  };
}
