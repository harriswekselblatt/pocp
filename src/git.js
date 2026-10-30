import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
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

export function git(cwd, args, { input, allowFail = false, trim = true, env } = {}) {
  try {
    const out = execFileSync('git', args, {
      cwd,
      input,
      ...(env ? { env: { ...process.env, ...env } } : {}),
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return trim ? out.replace(/\s+$/, '') : out;
  } catch (err) {
    if (allowFail) return null;
    const stderr = err.stderr ? String(err.stderr).trim() : '';
    throw new GitError(`git ${args.join(' ')} failed${stderr ? `: ${stderr}` : ''}`, {
      args,
      stderr,
      status: err.status,
    });
  }
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
  return execFileSync('git', ['cat-file', 'blob', sha], { cwd, maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
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
    return execFileSync('git', ['show', `${rev}:${path}`], { cwd, maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
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

export function worktreeAdd(cwd, dir, rev) {
  git(cwd, ['worktree', 'add', '--detach', '--force', dir, rev]);
}

export function worktreeRemove(cwd, dir) {
  git(cwd, ['worktree', 'remove', '--force', dir], { allowFail: true });
  git(cwd, ['worktree', 'prune'], { allowFail: true });
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
