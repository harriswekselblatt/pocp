import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
// The POCP that judges every scenario: this checkout's, never the copy inside a scratch
// clone (when the target is POCP itself, that copy carries the planted bug).
export const TRUSTED_BIN = path.resolve(here, '..', '..', '..', 'bin', 'pocp.js');

// Variables that would change what POCP or git does on this machine.
const SCRUB = [
  'POCP_HOST', 'POCP_SIGN_KEY', 'POCP_SIGN_PRINCIPAL', 'GITHUB_ACTIONS', 'GITHUB_STEP_SUMMARY', 'CI',
  'GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT', 'GITHUB_SHA', 'CI_PIPELINE_ID', 'BUILDKITE_BUILD_ID',
  'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'NODE_TEST_CONTEXT', 'VITEST', 'NODE_OPTIONS',
];

/** A clean, reproducible environment: no machine git config, fixed identity, trusted pocp. */
export function benchEnv(extra = {}) {
  const env = { ...process.env };
  for (const k of SCRUB) delete env[k];
  return {
    ...env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Bench Agent',
    GIT_AUTHOR_EMAIL: 'agent@bench.invalid',
    GIT_COMMITTER_NAME: 'Bench Agent',
    GIT_COMMITTER_EMAIL: 'agent@bench.invalid',
    POCP_BIN: `${process.execPath} ${TRUSTED_BIN}`,
    FORCE_COLOR: '0',
    NO_COLOR: '1',
    ...extra,
  };
}

/** Run a command; resolves { code, out, err } (never rejects on a non-zero exit). */
export function run(cmd, args, { cwd, env = benchEnv(), timeoutMs = 10 * 60_000, input } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const cap = (s, d) => (s.length > 4_000_000 ? s : s + d);
    child.stdout.on('data', (d) => { out = cap(out, d); });
    child.stderr.on('data', (d) => { err = cap(err, d); });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: 127, out, err: err + String(e) }); });
    child.on('close', (code, signal) => { clearTimeout(timer); resolve({ code: code ?? (signal ? 137 : 1), out, err }); });
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

/** Run a shell command line. */
export function sh(line, opts) {
  return run('sh', ['-c', line], opts);
}

/** git, failing loudly unless allowFail. */
export async function git(cwd, args, { allowFail = false, env } = {}) {
  const r = await run('git', args, { cwd, ...(env ? { env } : {}) });
  if (r.code !== 0 && !allowFail) throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${r.err || r.out}`);
  return r.out.trim();
}

/** The trusted pocp CLI. */
export function pocp(cwd, args, { env } = {}) {
  return run(process.execPath, [TRUSTED_BIN, ...args], { cwd, ...(env ? { env } : {}) });
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
