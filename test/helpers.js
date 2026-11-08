import { spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const BIN = path.join(here, '..', 'bin', 'pocp.js');

// Isolate every git call (ours and the engine's) from the machine's git config.
export const GIT_ENV = {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Test Author',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test Author',
  GIT_COMMITTER_EMAIL: 'test@example.com',
  POCP_BIN: `${process.execPath} ${BIN}`,
};
Object.assign(process.env, GIT_ENV);
// Tests behave the same locally and inside CI: no host, no GitHub job summary or annotations.
for (const k of ['POCP_HOST', 'POCP_SIGN_KEY', 'POCP_SIGN_PRINCIPAL', 'GITHUB_ACTIONS', 'GITHUB_STEP_SUMMARY', 'CI', 'GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT', 'CI_PIPELINE_ID', 'BUILDKITE_BUILD_ID']) delete process.env[k];

// Temporary folders. Every test process gets one root folder and points TMPDIR at it, so
// everything it (and every pocp it starts) puts in os.tmpdir() lands inside. A folder made
// elsewhere with fs.mkdtempSync (e.g. under /tmp) is remembered too. All of it is removed when
// the test file's process exits, so no test needs its own cleanup.
const SUITE_PREFIX = 'pocp-suite-';
export const TEST_TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), SUITE_PREFIX)));
process.env.TMPDIR = TEST_TMP;
const elsewhere = new Set();
const realMkdtempSync = fs.mkdtempSync;
fs.mkdtempSync = function mkdtempSync(...args) {
  const dir = realMkdtempSync.apply(fs, args);
  const full = path.resolve(typeof dir === 'string' ? dir : String(dir));
  let real = full;
  try { real = fs.realpathSync(full); } catch { /* keep as given */ }
  if (real !== TEST_TMP && !real.startsWith(`${TEST_TMP}${path.sep}`)) elsewhere.add(full);
  return dir;
};

function forceRemove(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    return;
  } catch { /* read-only folders inside: make them writable and retry */ }
  const walk = (d) => {
    try { fs.chmodSync(d, 0o755); } catch { /* ignore */ }
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) if (e.isDirectory() && !e.isSymbolicLink()) walk(path.join(d, e.name));
  };
  walk(dir);
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

process.on('exit', () => {
  for (const d of elsewhere) forceRemove(d);
  forceRemove(TEST_TMP);
});

// Repositories a test starts from, built once per test process and copied for each test that
// asks for one: building a sample repo (git init, a spawned pocp init, a commit) took about
// 0.8s, and the suite asked for about 200. A copy is a separate repository (its own .git, no
// path to the template in it), so no test can change what another one starts from.
const templates = new Map();
function fromTemplate(key, build) {
  if (!templates.has(key)) {
    const tpl = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pocp-template-')));
    build(tpl);
    templates.set(key, tpl);
  }
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pocp-test-')));
  copyTree(templates.get(key), dir);
  return dir;
}

// A plain recursive copy: folders, files (with their modes, so hooks stay executable) and
// symlinks as they are. Not fs.cpSync: on macOS, Node 22.23's cpSync now and then failed
// with ENOENT creating .git/objects in the copy.
function copyTree(src, dest) {
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, ent.name);
    const to = path.join(dest, ent.name);
    if (ent.isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(from), to);
    else if (ent.isDirectory()) {
      fs.mkdirSync(to);
      copyTree(from, to);
    } else fs.copyFileSync(from, to);
  }
}

export function tmpRepo() {
  return fromTemplate('empty', (dir) => {
    sh(dir, 'git', ['init', '-q', '-b', 'main']);
    sh(dir, 'git', ['config', 'commit.gpgsign', 'false']);
  });
}

export function sh(cwd, cmd, args, { env = {}, allowFail = false, input } = {}) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', env: { ...process.env, ...env }, input });
  if (r.status !== 0 && !allowFail) {
    throw new Error(`${cmd} ${args.join(' ')} failed (${r.status}):\n${r.stdout}\n${r.stderr}`);
  }
  return r;
}

export function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: process.env }).trim();
}

/** Run the CLI. Returns { code, stdout, stderr, json }. */
export function pocp(cwd, args, { env = {} } = {}) {
  const r = spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: 'utf8', env: { ...process.env, ...env } });
  let json = null;
  if (args.includes('--json')) {
    try {
      json = JSON.parse(r.stdout);
    } catch { /* not JSON */ }
  }
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, json };
}

export function write(dir, rel, content) {
  const full = path.join(dir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

export function read(dir, rel) {
  return fs.readFileSync(path.join(dir, rel), 'utf8');
}

export function writeRules(dir, rules) {
  write(dir, '.proof/rules.json', `${JSON.stringify({ pocp: 1, ...rules }, null, 2)}\n`);
}

export function writeConfig(dir, config) {
  write(dir, '.proof/config.json', `${JSON.stringify({ pocp: 1, ...config }, null, 2)}\n`);
}

/** A repo with a tiny module, a test for it, pocp initialised, and one baseline commit. */
export function sampleRepo({ hooks = false, rules, deep = true } = {}) {
  return fromTemplate(JSON.stringify(['sample', hooks, deep, rules ?? null]), (dir) => buildSampleRepo(dir, { hooks, rules, deep }));
}

function buildSampleRepo(dir, { hooks, rules, deep }) {
  sh(dir, 'git', ['init', '-q', '-b', 'main']);
  sh(dir, 'git', ['config', 'commit.gpgsign', 'false']);
  write(dir, 'src/math.js', 'export function add(a, b) {\n  return a + b;\n}\n\nexport function isPositive(n) {\n  return n > 0;\n}\n');
  write(dir, 'test/math.check.mjs', [
    "import { add, isPositive } from '../src/math.js';",
    "if (add(2, 3) !== 5) { console.error('add broken'); process.exit(1); }",
    "if (isPositive(1) !== true || isPositive(-1) !== false) { console.error('isPositive broken'); process.exit(1); }",
    "console.log('math ok');",
    '',
  ].join('\n'));
  write(dir, 'README.md', '# sample\n');
  // Most tests exercise the planted-bug check, so the fixture is deep unless asked otherwise.
  const init = pocp(dir, ['init', ...(hooks ? ['--hooks'] : []), ...(deep ? ['--deep'] : [])]);
  if (init.code !== 0) throw new Error(`init failed: ${init.stderr}`);
  writeRules(dir, rules || {
    triggers: { broad_files: 6, cross_area: { areas: 3, min_files: 4 }, globs: [] },
    requirements: [
      { id: 'math-tests', glob: 'src/**', obligation: { kind: 'test', run: 'node test/math.check.mjs' }, source: 'author' },
    ],
  });
  git(dir, 'add', '-A');
  // Baseline commit without hooks so the fixture starts clean.
  git(dir, '-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', 'baseline');
}

export function packetId(stdout) {
  const m = /opened (p-[0-9a-f]+)/.exec(stdout);
  if (!m) throw new Error(`no packet id in: ${stdout}`);
  return m[1];
}
