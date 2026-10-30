import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const BENCH_ROOT = path.resolve(here, '..');
export const POCP_ROOT = path.resolve(here, '..', '..', '..');
const TIMED = path.join(here, 'timed-pocp.mjs');

/** Run a command; resolve with { code, out, err, ms }. Never rejects. */
export function run(cmd, args, { cwd, env, input } = {}) {
  return new Promise((resolve) => {
    const started = process.hrtime.bigint();
    const child = spawn(cmd, args, { cwd, env: env || process.env, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { err += String(e); });
    child.on('close', (code) => resolve({ code, out, err, ms: Number((process.hrtime.bigint() - started) / 1000000n) }));
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

export async function git(cwd, args, opts = {}) {
  const r = await run('git', args, { cwd, ...opts });
  if (r.code !== 0 && !opts.allowFail) throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${r.err.trim()}`);
  return opts.raw ? r : r.out.replace(/\s+$/, '');
}

/** Environment for every command in a scratch repo: fixed identity, no host, hooks timed. */
export function benchEnv(pocpCli, log) {
  return {
    ...process.env,
    GIT_AUTHOR_NAME: 'bench-agent',
    GIT_AUTHOR_EMAIL: 'agent@bench.invalid',
    GIT_COMMITTER_NAME: 'bench-agent',
    GIT_COMMITTER_EMAIL: 'agent@bench.invalid',
    POCP_ACTOR: 'bench-agent',
    POCP_HOST: '',
    POCP_BIN: `${process.execPath} ${TIMED} ${pocpCli}`,
    FRICTION_LOG: log,
    CI: '',
    GITHUB_ACTIONS: '',
    GITHUB_STEP_SUMMARY: '',
  };
}

const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));

function isObj(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}
function deepMerge(a, b) {
  const out = { ...a };
  for (const [k, v] of Object.entries(b || {})) out[k] = isObj(v) && isObj(a?.[k]) ? deepMerge(a[k], v) : v;
  return out;
}

/** The policy every replayed commit is judged by: the target's .proof/ at policyRev, plus overlays. */
export async function policyFiles(target) {
  const show = async (rel) => {
    const r = await git(target.sourceDir, ['show', `${target.policyRev}:${rel}`], { allowFail: true, raw: true });
    return r.code === 0 ? r.out : null;
  };
  const rules = JSON.parse(await show('.proof/rules.json'));
  for (const req of rules.requirements || []) {
    const runCmd = req.obligation?.run;
    if (runCmd && target.replaceRun?.[runCmd]) req.obligation.run = target.replaceRun[runCmd];
  }
  const config = deepMerge(JSON.parse((await show('.proof/config.json')) || '{"pocp":1}'), target.config || {});
  return {
    '.proof/rules.json': `${JSON.stringify(rules, null, 2)}\n`,
    '.proof/config.json': `${JSON.stringify(config, null, 2)}\n`,
    '.proof/.gitignore': (await show('.proof/.gitignore')) || 'runs/\n',
  };
}

export function linkShared(dir, target) {
  const names = target.link || [];
  if (!names.length) return;
  fs.appendFileSync(path.join(dir, '.git', 'info', 'exclude'), `${names.map((n) => `/${n}`).join('\n')}\n`);
  for (const name of names) {
    const src = path.join(target.sourceDir, name);
    const dst = path.join(dir, name);
    if (fs.existsSync(src) && !fs.existsSync(dst)) fs.symlinkSync(src, dst);
  }
}

export function loadTarget(name, repoOverride) {
  const target = readJson(path.join(BENCH_ROOT, 'targets', `${name}.json`));
  const src = repoOverride || (target.source === '.' ? POCP_ROOT : target.source);
  if (!src) throw new Error(`${name}: pass --repo <path to its checkout> (it is only read, never written)`);
  target.sourceDir = path.resolve(src);
  return target;
}

/** The honest commits to replay, oldest first: the last N non-merge commits up to `head`. */
export async function commitsToReplay(target, n) {
  const out = await git(target.sourceDir, ['rev-list', '--no-merges', `--max-count=${n}`, target.head]);
  return out.split('\n').filter(Boolean).reverse();
}

export function readLog(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}
