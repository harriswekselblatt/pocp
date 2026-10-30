import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { digest } from './hash.js';

export const PROOF_DIR = '.proof';

export class GitError extends Error {
  constructor(message, { args, stderr, status } = {}) {
    super(message);
    this.name = 'GitError';
    this.args = args;
    this.stderr = stderr;
    this.status = status;
  }
}

/** The repository's git state changed while it was isolated (see isolateGit). */
export class GitTamperError extends GitError {
  constructor(message) {
    super(message);
    this.name = 'GitTamperError';
  }
}

// ---------------------------------------------------------------------- hardening
//
// Git config can make git run commands: core.fsmonitor on index reads (checkout-index,
// status), hooks on checkout, external diff and textconv drivers on diff. POCP's own git calls
// never need any of them, so every call turns them off on the command line, which overrides
// every config file. `config` and `rev-parse` keep core.hooksPath: doctor and init read it,
// and neither command runs hooks.
const KEEPS_HOOKS_PATH = new Set(['config', 'rev-parse']);
const DIFFS = new Set(['diff', 'log', 'show']);

// Environment variables that point git at another repository, index or config. In isolation
// they are not inherited. (Outside it they are: git sets GIT_INDEX_FILE for the commit hooks,
// and `git commit <paths>` stages into a temporary index the gate must read.)
const REPO_ENV = new Set([
  'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_COMMON_DIR', 'GIT_NAMESPACE', 'GIT_PREFIX', 'GIT_CONFIG', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT',
  'GIT_REPLACE_REF_BASE', 'GIT_SHALLOW_FILE', 'GIT_GRAFT_FILE', 'GIT_CEILING_DIRECTORIES',
]);

let isolation = null; // { root, commonDir, gitDir, safeDirs, watched, fast, refs, objectDirs, objects, marks, checked, tampered }
let noRepoEnv = false;

/**
 * Stop inheriting repository-locating environment variables (GIT_DIR, GIT_INDEX_FILE, …) for
 * the rest of this process. `pocp verify` calls it first: it judges the repository it runs
 * in, never one the environment points to.
 */
export function ignoreRepoEnv() {
  noRepoEnv = true;
}

/** The arguments POCP actually passes to git for `args`. */
export function hardenedArgs(args) {
  const sub = args[0];
  const pre = ['-c', 'core.fsmonitor=false'];
  if (!KEEPS_HOOKS_PATH.has(sub)) pre.push('-c', `core.hooksPath=${os.devNull}`);
  if (isolation) for (const d of isolation.safeDirs) pre.push('-c', `safe.directory=${d}`);
  const rest = DIFFS.has(sub) ? [sub, '--no-ext-diff', '--no-textconv', ...args.slice(1)] : args;
  return [...pre, ...rest];
}

/** The environment POCP runs git with. */
export function gitEnv(extra) {
  const env = { ...process.env };
  delete env.GIT_EXTERNAL_DIFF;
  if (isolation || noRepoEnv) for (const k of Object.keys(env)) if (REPO_ENV.has(k) || /^GIT_CONFIG_(KEY|VALUE)_\d+$/.test(k)) delete env[k];
  if (isolation) {
    env.GIT_CONFIG_GLOBAL = os.devNull;
    env.GIT_CONFIG_NOSYSTEM = '1';
    env.GIT_NO_REPLACE_OBJECTS = '1';
  }
  env.GIT_TERMINAL_PROMPT = '0';
  return extra ? { ...env, ...extra } : env;
}

function exec(cwd, args, { input, env, encoding, stdio = ['pipe', 'pipe', 'pipe'] } = {}) {
  if (isolation) assertIntact();
  return execFileSync('git', hardenedArgs(args), {
    cwd,
    input,
    env: gitEnv(env),
    ...(encoding ? { encoding } : {}),
    maxBuffer: 256 * 1024 * 1024,
    stdio,
  });
}

export function git(cwd, args, { input, allowFail = false, trim = true, env } = {}) {
  let out;
  try {
    out = exec(cwd, args, { input, env, encoding: 'utf8' });
  } catch (err) {
    if (err instanceof GitTamperError) throw err; // never swallowed by allowFail
    if (allowFail) return null;
    const stderr = err.stderr ? String(err.stderr).trim() : '';
    throw new GitError(`git ${args.join(' ')} failed${stderr ? `: ${stderr}` : ''}`, {
      args,
      stderr,
      status: err.status,
    });
  }
  return trim ? out.replace(/\s+$/, '') : out;
}

// ---------------------------------------------------------------------- isolation
//
// While verify runs the pull request's code, that code runs as the same user and can write the
// repository's git config, hooks and refs. In isolation: global and system config are not read
// (the code can write ~/.gitconfig too), repository-locating environment variables are not
// inherited, replace refs are ignored, and before every git call the repository's config, its
// included files, info/attributes, grafts, shallow, alternates and hooks are compared with what
// they were when isolation began. Any difference stops the run (GitTamperError) and stays
// recorded, so the final check fails even if the code put things back. Refs are compared at the
// end.
//
// The object store is watched too: git does not check an object's content against its id when
// it reads it, so code that rewrites a loose object or a pack would otherwise change what verify
// reads as the base or the head. Every file under objects/ (and under alternate object
// directories) is recorded when isolation begins by inode, size, mtime and ctime. A process
// can't set a file's ctime, so a file written, replaced, renamed or put back afterwards no
// longer matches by inode or size, or has new times and then has its content checked (see
// contentMark). A new file is accepted only as a loose object whose content hashes to its name
// (writing a new object is harmless: ids are content hashes), or as a name git never reads as
// an object. Anything else (a new pack, a commit-graph, a removed file) is tampering.

function readOrMissing(file) {
  try {
    const st = fs.lstatSync(file);
    if (st.isSymbolicLink()) return `link:${fs.readlinkSync(file)}`;
    if (st.isDirectory()) return `dir:${fs.readdirSync(file).sort().map((n) => `${n}\0${readOrMissing(path.join(file, n))}`).join('\0')}`;
    return `file:${st.mode}:${fs.readFileSync(file).toString('base64')}`;
  } catch {
    return 'missing';
  }
}

function fastState(watched) {
  return watched.map((f) => [f, crypto.createHash('sha256').update(readOrMissing(f)).digest('hex')]);
}

function refsState(root) {
  const env = gitEnv();
  const run = (args) => {
    try {
      return execFileSync('git', hardenedArgs(args), { cwd: root, env, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      return '';
    }
  };
  return `${run(['for-each-ref', '--format=%(refname) %(objectname)'])}\nHEAD ${run(['symbolic-ref', '-q', 'HEAD']).trim() || run(['rev-parse', '-q', '--verify', 'HEAD']).trim()}`;
}

const HEX_NAME = /^[0-9a-f]+$/;

function objectDirs(commonDir) {
  const dirs = [path.join(commonDir, 'objects')];
  const seen = new Set();
  // Alternates may chain; each listed directory is an object store git reads from.
  for (let i = 0; i < dirs.length && i < 16; i++) {
    const real = (() => { try { return fs.realpathSync(dirs[i]); } catch { return dirs[i]; } })();
    if (seen.has(real)) continue;
    seen.add(real);
    let text = '';
    try { text = fs.readFileSync(path.join(dirs[i], 'info', 'alternates'), 'utf8'); } catch { continue; }
    for (const line of text.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))) dirs.push(path.resolve(dirs[i], line));
  }
  return [...new Set(dirs)];
}

function statOf(st) {
  return { id: `${st.mode}:${st.ino}:${st.size}`, times: `${st.mtimeNs}:${st.ctimeNs}` };
}

/** Every file under the object directories: Map<absolute path, { id, times }>. */
function objectsState(dirs) {
  const files = new Map();
  const walk = (d, depth) => {
    let names;
    try { names = fs.readdirSync(d); } catch { return; }
    for (const n of names) {
      const full = path.join(d, n);
      let st;
      try { st = fs.lstatSync(full, { bigint: true }); } catch { continue; }
      if (st.isDirectory() && depth < 4) walk(full, depth + 1);
      else files.set(full, statOf(st));
    }
  };
  for (const d of dirs) walk(d, 0);
  return files;
}

/** The object id a file holds when it is a loose object (objects/ab/cdef…), else null. */
function looseId(file) {
  const dir = path.dirname(file);
  const fan = path.basename(dir);
  const name = path.basename(file);
  if (!/^[0-9a-f]{2}$/.test(fan) || !isolation.objectDirs.includes(path.dirname(dir))) return null;
  return HEX_NAME.test(name) && (name.length === 38 || name.length === 62) ? fan + name : null;
}

/** Does this loose object file hold content whose hash is its name? */
function looseObjectValid(file, id) {
  try {
    const raw = zlib.inflateSync(fs.readFileSync(file));
    const algo = id.length === 64 ? 'sha256' : 'sha1';
    return crypto.createHash(algo).update(raw).digest('hex') === id;
  } catch {
    return false;
  }
}

// How a file's content is checked when its times change but it is the same file (same inode
// and size). That happens without anyone writing it: git refreshes an object's mtime when it
// writes one that is already there, and a hard link made or removed elsewhere (local clones
// share object files) changes its ctime. A loose object is checked against its id. Other
// files are recorded when isolation begins: a small one by its content's SHA-256, a larger
// one (packs, their indexes, commit-graph, multi-pack-index all end with a checksum of what
// precedes it) by its last bytes, which must then still be the hash of the rest.
const SMALL_FILE = 64 * 1024;

function contentMark(file, size) {
  try {
    if (size <= SMALL_FILE) return { sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') };
    const fd = fs.openSync(file, 'r');
    try {
      const tail = Buffer.alloc(isolation.hashBytes);
      fs.readSync(fd, tail, 0, tail.length, size - tail.length);
      return { tail: tail.toString('hex') };
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

function sameContent(file, mark) {
  if (!mark) return false;
  try {
    const data = fs.readFileSync(file);
    if (mark.sha256) return crypto.createHash('sha256').update(data).digest('hex') === mark.sha256;
    const n = isolation.hashBytes;
    if (data.length <= n || data.subarray(data.length - n).toString('hex') !== mark.tail) return false;
    return crypto.createHash(n === 32 ? 'sha256' : 'sha1').update(data.subarray(0, data.length - n)).digest('hex') === mark.tail;
  } catch {
    return false;
  }
}

/** Record the object store as it is now: the trusted state. */
function recordObjects() {
  isolation.objects = objectsState(isolation.objectDirs);
  isolation.marks = new Map();
  for (const [f, st] of isolation.objects) {
    if (looseId(f)) continue;
    isolation.marks.set(f, contentMark(f, Number(st.id.split(':')[2])));
  }
  isolation.objectDirsKey = objectDirsState(isolation.objectDirs);
  isolation.checked = new Map();
}

/** The object directories and the directories directly in them (fan-out, pack, info). */
function objectDirsState(dirs) {
  const out = [];
  for (const d of dirs) {
    const stat = (p) => { try { const st = fs.lstatSync(p, { bigint: true }); return `${st.ino}:${st.mtimeNs}:${st.ctimeNs}`; } catch { return 'missing'; } };
    out.push(`${d}\0${stat(d)}`);
    let names = [];
    try { names = fs.readdirSync(d).sort(); } catch { /* missing */ }
    for (const n of names) out.push(`${n}\0${stat(path.join(d, n))}`);
  }
  return out.join('\n');
}

/**
 * Before each git call: a full look at the object store only when a directory in it changed
 * (a file added, removed or renamed). A file rewritten in place changes no directory; the full
 * look at the end of isolation (gitStateProblem) catches it, and verify fails then.
 */
function objectsProblemQuick() {
  const dirs = objectDirsState(isolation.objectDirs);
  if (dirs === isolation.objectDirsKey) return null;
  const problem = objectsProblem();
  if (!problem) isolation.objectDirsKey = dirs;
  return problem;
}

function objectsProblem() {
  const now = objectsState(isolation.objectDirs);
  const rel = (f) => path.relative(isolation.root, f) || f;
  for (const [f, was] of isolation.objects) {
    const is = now.get(f);
    if (!is) return `${rel(f)} removed`;
    if (is.id !== was.id) return `${rel(f)} changed`;
    if (is.times === was.times || isolation.checked.get(f) === is.times) continue;
    // Same file, new times: its content decides.
    const id = looseId(f);
    if (!(id ? looseObjectValid(f, id) : sameContent(f, isolation.marks.get(f)))) return `${rel(f)} changed`;
    isolation.checked.set(f, is.times);
  }
  for (const [f, is] of now) {
    if (isolation.objects.has(f)) continue;
    const id = looseId(f);
    if (!id) {
      // Git reads only hex-named files in a fan-out directory as loose objects.
      if (/^[0-9a-f]{2}$/.test(path.basename(path.dirname(f))) && isolation.objectDirs.includes(path.dirname(path.dirname(f)))) continue;
      return `${rel(f)} appeared`;
    }
    const key = `${is.id}:${is.times}`;
    if (isolation.checked.get(f) === key) continue;
    if (!looseObjectValid(f, id)) return `${rel(f)} appeared with content that doesn't match its id`;
    isolation.checked.set(f, key);
  }
  return null;
}

/**
 * Record an object POCP itself just wrote as part of the trusted state (call it only while no
 * code under review runs). Its content is checked against its id first.
 */
export function trustObjects() {
  if (!isolation) return;
  const problem = objectsProblem();
  if (problem) {
    isolation.tampered = isolation.tampered || problem;
    throw new GitTamperError(tamperMessage(isolation.tampered));
  }
  recordObjects();
}

function describeChange(before, after) {
  const changed = after.filter(([f, h], i) => before[i][1] !== h).map(([f]) => path.relative(isolation.root, f) || f);
  return changed.length ? `${changed.join(', ')} changed` : null;
}

function assertIntact() {
  if (!isolation.tampered) {
    const problem = describeChange(isolation.fast, fastState(isolation.watched)) || objectsProblemQuick();
    if (problem) isolation.tampered = problem;
  }
  if (isolation.tampered) throw new GitTamperError(tamperMessage(isolation.tampered));
}

function tamperMessage(problem) {
  return `the repository's git state changed while verify ran the pull request's code (${problem}): its config, hooks, refs or objects are not what verify started with, so nothing this verify ran is trusted. Run verify again on a fresh checkout`;
}

/**
 * Isolate POCP's git calls in `root` from config the code under review may write. Call it
 * before running that code. Returns `release`, which ends isolation.
 */
export function isolateGit(root) {
  if (isolation) throw new Error('git is already isolated');
  // Trusted safe.directory entries come from global/system config, read once before any
  // code under review runs; later calls pass them on the command line.
  const safeDirs = ['--global', '--system'].flatMap((scope) => (git(root, ['config', scope, '--get-all', 'safe.directory'], { allowFail: true }) || '').split('\n').filter(Boolean));
  const abs = (p) => path.resolve(root, p);
  const commonDir = abs(git(root, ['rev-parse', '--git-common-dir']));
  const gitDir = abs(git(root, ['rev-parse', '--git-dir']));
  const hashBytes = git(root, ['hash-object', '--stdin'], { input: '' }).length / 2;
  isolation = { root, commonDir, gitDir, safeDirs, watched: [], fast: [], refs: '', objectDirs: [], objectDirsKey: '', hashBytes, objects: new Map(), marks: new Map(), checked: new Map(), tampered: null };
  try {
    // The repository's config files and the files they include, as git resolves them now
    // (global and system config are not read in isolation, so they are not watched either).
    const origins = (git(root, ['config', '--list', '--show-origin', '-z', '--includes'], { allowFail: true, trim: false }) || '')
      .split('\0').filter((s) => s.startsWith('file:')).map((s) => abs(s.slice(5)));
    isolation.watched = [...new Set([
      path.join(commonDir, 'config'),
      path.join(commonDir, 'config.worktree'),
      path.join(gitDir, 'config.worktree'),
      path.join(commonDir, 'info', 'attributes'),
      path.join(commonDir, 'info', 'grafts'),
      path.join(commonDir, 'shallow'),
      path.join(commonDir, 'objects', 'info', 'alternates'),
      path.join(commonDir, 'hooks'),
      ...origins,
    ])];
    isolation.fast = fastState(isolation.watched);
    isolation.objectDirs = objectDirs(commonDir);
    recordObjects();
    isolation.refs = refsState(root);
  } catch (err) {
    isolation = null;
    throw err;
  }
  return () => {
    isolation = null;
  };
}

/** True while git calls are isolated. */
export function gitIsolated() {
  return Boolean(isolation);
}

/** null when the isolated repository's git state is unchanged; otherwise what changed. Sticky. */
export function gitStateProblem() {
  if (!isolation) return null;
  if (!isolation.tampered) isolation.tampered = describeChange(isolation.fast, fastState(isolation.watched)) || objectsProblem();
  if (!isolation.tampered && refsState(isolation.root) !== isolation.refs) isolation.tampered = 'refs changed';
  return isolation.tampered;
}

/**
 * Run `fn` with git isolated in `root`. Overlapping calls share one isolation, which ends when
 * the last of them finishes. Throws GitTamperError if the repository's git config, hooks or
 * refs changed meanwhile, even when `fn` itself failed or the change was undone.
 */
export async function withGitIsolation(root, fn) {
  if (!isolation) isolateGit(root);
  const own = isolation;
  own.users = (own.users || 0) + 1;
  let value;
  let error = null;
  try {
    value = await fn();
  } catch (err) {
    error = err;
  }
  let problem;
  try {
    problem = gitStateProblem();
  } finally {
    own.users -= 1;
    if (own.users === 0 && isolation === own) isolation = null;
  }
  if (problem) throw new GitTamperError(tamperMessage(problem));
  if (error) throw error;
  return value;
}

export function repoRoot(cwd) {
  const root = git(cwd, ['rev-parse', '--show-toplevel'], { allowFail: true });
  if (!root) throw new GitError(`not inside a git repository: ${cwd}`);
  return root;
}

export function hasHead(cwd) {
  return git(cwd, ['rev-parse', '--verify', '--quiet', 'HEAD'], { allowFail: true }) !== null;
}

export function resolveRev(cwd, rev) {
  const sha = git(cwd, ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`], { allowFail: true });
  if (!sha) throw new GitError(`unknown revision: ${rev}`);
  return sha;
}

export function emptyTree(cwd) {
  return git(cwd, ['hash-object', '-t', 'tree', '--stdin'], { input: '' });
}

function splitZ(out) {
  return out ? out.split('\0').filter((s) => s.length > 0) : [];
}

export function isProofPath(p) {
  return p === PROOF_DIR || p.startsWith(`${PROOF_DIR}/`);
}

/** Index entries: [{ mode, sha, stage, path }]. */
export function indexEntries(cwd) {
  const out = git(cwd, ['ls-files', '-s', '-z'], { trim: false });
  return splitZ(out).map((rec) => {
    const tab = rec.indexOf('\t');
    const [mode, sha, stage] = rec.slice(0, tab).split(' ');
    return { mode, sha, stage: Number(stage), path: rec.slice(tab + 1) };
  });
}

/** Tree entries of a commit: [{ mode, sha, path }]. */
export function treeEntries(cwd, rev) {
  const out = git(cwd, ['ls-tree', '-r', '-z', '--full-tree', rev], { trim: false });
  return splitZ(out).map((rec) => {
    const tab = rec.indexOf('\t');
    const [mode, , sha] = rec.slice(0, tab).split(' ');
    return { mode, sha, path: rec.slice(tab + 1) };
  });
}

/**
 * The subject hash: SHA-256 over sorted "mode sha\tpath" lines, `.proof/` excluded.
 * The same lines come out of the index and out of a commit tree, so a proof recorded
 * before a commit can be checked against that commit later.
 */
export function subjectFromEntries(entries) {
  const lines = entries
    .filter((e) => !isProofPath(e.path))
    .map((e) => `${e.mode} ${e.sha}\t${e.path}`)
    .sort((a, b) => {
      const pa = a.slice(a.indexOf('\t') + 1);
      const pb = b.slice(b.indexOf('\t') + 1);
      return pa < pb ? -1 : pa > pb ? 1 : 0;
    });
  return digest(lines.join('\n'));
}

export function subjectHashIndex(cwd) {
  const entries = indexEntries(cwd);
  const conflicted = entries.filter((e) => e.stage !== 0);
  if (conflicted.length > 0) {
    throw new GitError(`index has unresolved merge conflicts: ${[...new Set(conflicted.map((e) => e.path))].slice(0, 5).join(', ')}`);
  }
  return subjectFromEntries(entries);
}

export function subjectHashRev(cwd, rev) {
  return subjectFromEntries(treeEntries(cwd, rev));
}

function parseNameStatus(out) {
  const tokens = splitZ(out);
  const changes = [];
  for (let i = 0; i < tokens.length; ) {
    const status = tokens[i++];
    const code = status[0];
    if (code === 'R' || code === 'C') {
      const oldPath = tokens[i++];
      const path = tokens[i++];
      changes.push({ status: code, path, oldPath, similarity: Number(status.slice(1)) || null });
    } else {
      changes.push({ status: code, path: tokens[i++] });
    }
  }
  return changes;
}

/** Staged changes against HEAD (or the empty tree before the first commit). */
export function stagedChanges(cwd, againstRev = null) {
  const base = againstRev || (hasHead(cwd) ? 'HEAD' : emptyTree(cwd));
  const out = git(cwd, ['diff', '--cached', '--name-status', '-M', '-z', base], { trim: false });
  return parseNameStatus(out);
}

/** Changes a commit introduced relative to its first parent (or the empty tree for a root commit). */
export function commitChanges(cwd, rev) {
  const parent = git(cwd, ['rev-parse', '--verify', '--quiet', `${rev}^1`], { allowFail: true });
  const base = parent || emptyTree(cwd);
  const out = git(cwd, ['diff', '--name-status', '-M', '-z', base, rev], { trim: false });
  return parseNameStatus(out);
}

/**
 * Paths that need coverage for a set of changes: added/modified by path, deleted by
 * old path, renamed/copied by both paths. `.proof/` paths are left out.
 */
export function changedPaths(changes) {
  const set = new Set();
  for (const c of changes) {
    if (c.oldPath && c.status === 'R') set.add(c.oldPath);
    set.add(c.path);
  }
  return [...set].filter((p) => !isProofPath(p)).sort();
}

/** Tracked files whose working copy differs from the index (`.proof/` excluded). */
export function worktreeDiffs(cwd) {
  const out = git(cwd, ['diff', '--name-only', '-z'], { trim: false });
  return splitZ(out).filter((p) => !isProofPath(p));
}

/**
 * Tracked files with an index flag that makes git ignore working-copy edits:
 * assume-unchanged (lowercase tag in `ls-files -v`) or skip-worktree ("S").
 * `git diff` stays silent about such files, so a clean-looking folder can differ from the index.
 */
export function flaggedEntries(cwd) {
  const out = git(cwd, ['ls-files', '-v', '-z'], { trim: false });
  return splitZ(out)
    .filter((rec) => /^[a-zS] /.test(rec))
    .map((rec) => ({ path: rec.slice(2), flag: rec[0] === 'S' || rec[0] === 's' ? 'skip-worktree' : 'assume-unchanged' }))
    .filter((e) => !isProofPath(e.path));
}

/** A blob's bytes. */
export function blobBuffer(cwd, sha) {
  return exec(cwd, ['cat-file', 'blob', sha], { stdio: ['ignore', 'pipe', 'pipe'] });
}

export function untrackedFiles(cwd) {
  const out = git(cwd, ['ls-files', '--others', '--exclude-standard', '-z'], { trim: false });
  return splitZ(out).filter((p) => !isProofPath(p));
}

export function showFile(cwd, rev, path) {
  return git(cwd, ['show', `${rev}:${path}`], { allowFail: true, trim: false });
}

/** File bytes at a revision, or null if the path does not exist there. */
export function showFileBuffer(cwd, rev, path) {
  try {
    return exec(cwd, ['show', `${rev}:${path}`], { stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (err) {
    if (err instanceof GitTamperError) throw err;
    return null;
  }
}

export function listTree(cwd, rev, dir) {
  const out = git(cwd, ['ls-tree', '-r', '-z', '--name-only', '--full-tree', rev, '--', dir], {
    allowFail: true,
    trim: false,
  });
  return out ? splitZ(out) : [];
}

export function addPaths(cwd, paths) {
  if (paths.length === 0) return;
  git(cwd, ['add', '--', ...paths]);
}

export function isStagedClean(cwd, path) {
  // True when the path is in the index and the working copy matches it.
  const inIndex = git(cwd, ['ls-files', '--error-unmatch', '--', path], { allowFail: true }) !== null;
  if (!inIndex) return false;
  const diff = git(cwd, ['diff', '--name-only', '--', path]);
  return diff === '';
}

export function commitMessage(cwd, rev) {
  return git(cwd, ['log', '-1', '--format=%B', rev], { trim: false });
}

/** Recent commits that touched `path`, with their messages: [{ commit, message }]. */
export function commitsTouching(cwd, path, limit = 50) {
  if (!hasHead(cwd)) return [];
  const out = git(cwd, ['log', `-n${limit}`, '--format=%H%x1f%B%x1e', '--', path], {
    allowFail: true,
    trim: false,
  });
  if (!out) return [];
  return out
    .split('\x1e')
    .map((s) => s.replace(/^\n/, ''))
    .filter((s) => s.includes('\x1f'))
    .map((s) => {
      const [commit, message] = s.split('\x1f');
      return { commit: commit.trim(), message };
    });
}

export function hooksDir(cwd) {
  // `--git-path` answers relative to cwd unless the path is absolute (works on Git < 2.31,
  // which has no --path-format).
  return path.resolve(cwd, git(cwd, ['rev-parse', '--git-path', 'hooks']));
}

export function configuredHooksPath(cwd) {
  return git(cwd, ['config', '--get', 'core.hooksPath'], { allowFail: true });
}

/** Export the index into `prefixDir` (must end with "/"). */
export function checkoutIndexTo(cwd, prefixDir) {
  git(cwd, ['checkout-index', '-a', '-f', `--prefix=${prefixDir}`]);
}


/** Export a commit's files into `prefixDir` (must end with "/") through a throwaway index. */
export function checkoutRevTo(cwd, rev, prefixDir, indexFile) {
  const env = { GIT_INDEX_FILE: indexFile };
  git(cwd, ['read-tree', rev], { env });
  git(cwd, ['checkout-index', '-a', '-f', `--prefix=${prefixDir}`], { env });
}

/**
 * Line numbers (1-based, in the new version) that a change added or modified, per file.
 * `to` is a commit, or null for the staged index.
 */
export function changedLines(cwd, from, to, paths) {
  if (!paths.length) return new Map();
  const args = to ? ['diff', '-U0', '--no-color', '--no-ext-diff', from, to, '--', ...paths] : ['diff', '--cached', '-U0', '--no-color', '--no-ext-diff', from, '--', ...paths];
  const out = git(cwd, args, { allowFail: true, trim: false }) || '';
  const map = new Map();
  let file = null;
  for (const line of out.split('\n')) {
    if (line.startsWith('+++ ')) {
      file = line === '+++ /dev/null' ? null : line.slice(6);
      if (file && !map.has(file)) map.set(file, new Set());
      continue;
    }
    const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (m && file) {
      const start = Number(m[1]);
      const count = m[2] === undefined ? 1 : Number(m[2]);
      for (let i = 0; i < count; i++) map.get(file).add(start + i);
    }
  }
  return map;
}

/** Commits being merged in (MERGE_HEAD) while a merge is in progress; empty otherwise. */
export function mergeHeads(cwd) {
  const file = path.resolve(cwd, git(cwd, ['rev-parse', '--git-path', 'MERGE_HEAD']));
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  return text.split('\n').map((s) => s.trim()).filter((s) => /^[0-9a-f]{40,64}$/.test(s));
}
