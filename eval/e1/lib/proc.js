// Processes and environments for the E1/E2 harness.
// Every child (git, python, pocp, the agent CLIs) gets an environment built here, so what
// leaks from the machine into a run is decided in one place and recorded.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const E1_DIR = path.resolve(here, '..');
export const EVAL_DIR = path.resolve(E1_DIR, '..');
export const POCP_ROOT = path.resolve(EVAL_DIR, '..');
// The POCP that judges every run: this checkout's, never a copy the agent could reach.
export const TRUSTED_BIN = path.join(POCP_ROOT, 'bin', 'pocp.js');

/**
 * The one Python every run uses: plain CI, POCP's checks, the agent's shell and the reference
 * checker. $E1_PYTHON, else `python3` as found on the harness's PATH, as an absolute path. Its
 * folder goes first on every child's PATH, so `python3 tests/test_task.py` means this one (on
 * macOS a clean PATH would give /usr/bin/python3, 3.9).
 */
export function resolvePython(env = process.env) {
  const cand = env.E1_PYTHON || spawnSync('sh', ['-c', 'command -v python3'], { encoding: 'utf8', env }).stdout.trim();
  if (!cand || !path.isAbsolute(cand)) throw new Error('no python3 found; set E1_PYTHON to an absolute path');
  const r = spawnSync(cand, ['-c', 'import sys, platform; print(sys.executable); print(platform.python_version())'], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`${cand} doesn't run: ${r.stderr}`);
  const [executable, version] = r.stdout.trim().split('\n');
  return { path: cand, executable, version, dir: path.dirname(cand) };
}
export const PYTHON = resolvePython();

export const AGENT_NAME = 'Eval Agent';
export const AGENT_EMAIL = 'agent@eval.invalid';

// Variables that would change what POCP, git or Python does on this machine.
const SCRUB = [
  'POCP_HOST', 'POCP_SIGN_KEY', 'POCP_SIGN_PRINCIPAL', 'POCP_BIN', 'GITHUB_ACTIONS', 'GITHUB_STEP_SUMMARY', 'CI',
  'GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT', 'GITHUB_SHA', 'CI_PIPELINE_ID', 'BUILDKITE_BUILD_ID',
  'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_CEILING_DIRECTORIES',
  'NODE_TEST_CONTEXT', 'VITEST', 'NODE_OPTIONS', 'PYTHONPATH', 'PYTHONSTARTUP', 'PYTHONHOME', 'VIRTUAL_ENV',
];

/**
 * Nesting markers that make a child `claude -p` refuse to start (or attach to the parent's
 * session) when the harness itself runs inside Claude Code. Everything starting CLAUDE is
 * dropped except the OAuth token: without it a child started from the desktop app reports
 * "Not logged in" and does nothing.
 */
export function isClaudeNestingVar(k) {
  if (k === 'CLAUDE_CODE_OAUTH_TOKEN') return false;
  return k === 'CLAUDECODE' || /^CLAUDE_/.test(k);
}

/** The harness's own environment: no machine git config, fixed identity, no CI markers. */
export function harnessEnv(extra = {}, base = process.env) {
  const env = {};
  for (const [k, v] of Object.entries(base)) {
    if (SCRUB.includes(k) || isClaudeNestingVar(k)) continue;
    env[k] = v;
  }
  return {
    ...env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: AGENT_NAME,
    GIT_AUTHOR_EMAIL: AGENT_EMAIL,
    GIT_COMMITTER_NAME: AGENT_NAME,
    GIT_COMMITTER_EMAIL: AGENT_EMAIL,
    GIT_TERMINAL_PROMPT: '0',
    PYTHONDONTWRITEBYTECODE: '1',
    FORCE_COLOR: '0',
    NO_COLOR: '1',
    // POCP's git hooks run even under --no-verify (prepare-commit-msg, post-commit). Point them
    // at the pinned POCP, never whatever `pocp` is on PATH. An agent's env overrides this with
    // its own pinned copy (pocpAgentEnv).
    POCP_BIN: `${process.execPath} ${TRUSTED_BIN}`,
    ...extra,
    // Last, so it wraps any PATH in extra (the agent's pocp shim stays ahead of everything else).
    PATH: withPython(extra.PATH ?? env.PATH ?? ''),
  };
}

/**
 * Run a command; resolves { code, signal, timedOut, out, err, ms } and never rejects on a
 * non-zero exit. The child gets its own process group so a timeout kills everything it
 * started (agents spawn shells, test runs and pocp). With stdoutFile/stderrFile the streams
 * go to disk as they arrive instead of memory.
 */
function withPython(p) {
  const parts = p.split(path.delimiter).filter((x) => x && x !== PYTHON.dir);
  // A leading agent pocp shim folder stays first; the pinned python's folder comes right after.
  const shim = parts.length && /agent-pocp/.test(parts[0]) ? [parts.shift()] : [];
  return [...shim, PYTHON.dir, ...parts].join(path.delimiter);
}

export function run(cmd, args, { cwd, env = harnessEnv(), timeoutMs = 10 * 60_000, input, stdoutFile, stderrFile, cap = 8_000_000 } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    let child;
    try {
      child = spawn(cmd, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    } catch (e) {
      resolve({ code: 127, signal: null, timedOut: false, out: '', err: String(e), ms: 0 });
      return;
    }
    let out = '';
    let err = '';
    const outStream = stdoutFile ? fs.createWriteStream(stdoutFile) : null;
    const errStream = stderrFile ? fs.createWriteStream(stderrFile) : null;
    child.stdout.on('data', (d) => {
      if (outStream) outStream.write(d);
      if (out.length < cap) out += d;
    });
    child.stderr.on('data', (d) => {
      if (errStream) errStream.write(d);
      if (err.length < cap) err += d;
    });
    let timedOut = false;
    const killGroup = (sig) => {
      try {
        process.kill(-child.pid, sig);
      } catch {
        try { child.kill(sig); } catch { /* gone */ }
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup('SIGTERM');
      setTimeout(() => killGroup('SIGKILL'), 5_000).unref();
    }, timeoutMs);
    const finish = (res) => {
      clearTimeout(timer);
      const done = () => resolve({ ...res, timedOut, out, err, ms: Date.now() - started });
      let pending = [outStream, errStream].filter(Boolean).length;
      if (!pending) return done();
      for (const s of [outStream, errStream].filter(Boolean)) s.end(() => { if (--pending === 0) done(); });
      return undefined;
    };
    child.on('error', (e) => { err += String(e); finish({ code: 127, signal: null }); });
    child.on('close', (code, signal) => finish({ code: code ?? (signal ? 128 + 9 : 1), signal }));
    child.stdin.on('error', () => {});
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

/** git, failing loudly unless allowFail. */
export async function git(cwd, args, { allowFail = false, env = harnessEnv() } = {}) {
  const r = await run('git', args, { cwd, env, timeoutMs: 120_000 });
  if (r.code !== 0 && !allowFail) {
    const why = r.timedOut ? `timed out after ${Math.round(r.ms / 1000)}s (machine load?)` : (r.err || r.out).trim() || `exit ${r.code}${r.signal ? `, signal ${r.signal}` : ''}`;
    throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${why}`);
  }
  return allowFail ? r : r.out.trim();
}

/** The trusted pocp CLI (this checkout). */
export function pocp(cwd, args, { env = harnessEnv(), timeoutMs = 30 * 60_000 } = {}) {
  return run(process.execPath, [TRUSTED_BIN, ...args], { cwd, env, timeoutMs });
}

/** Run async jobs with a concurrency limit, keeping input order in the results. */
export async function pool(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return results;
}

export const parseJson = (s) => {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
};

/** rm -rf that also removes the read-only POCP copy (and anything an agent chmodded). */
export function removeTree(dir) {
  if (!fs.existsSync(dir)) return;
  // Unlock first: rmSync can stop part-way on a read-only folder without throwing.
  const unlock = (p) => {
    let st;
    try { st = fs.lstatSync(p); } catch { return; }
    if (st.isSymbolicLink()) return;
    if (st.isDirectory()) {
      try { fs.chmodSync(p, 0o755); } catch { /* not ours */ }
      for (const n of fs.readdirSync(p)) unlock(path.join(p, n));
    }
  };
  unlock(dir);
  fs.rmSync(dir, { recursive: true, force: true });
  if (fs.existsSync(dir)) throw new Error(`could not remove ${dir}`);
}

export function writeJson(file, v) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(v, null, 2)}\n`);
}
