import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { onCleanup } from './exit.js';
import { blobBuffer, checkoutIndexTo, checkoutRevTo, indexEntries, isProofPath } from './git.js';

function linkDeps(root, dir, links = []) {
  for (const rel of links) {
    if (!rel || rel.includes('..') || path.isAbsolute(rel)) continue;
    const src = path.join(root, rel);
    const dest = path.join(dir, rel);
    if (fs.existsSync(src) && !fs.existsSync(dest)) {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.symlinkSync(src, dest);
    }
  }
}

function isLink(p) {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

function makeWritable(dir) {
  if (!fs.existsSync(dir)) return;
  const walk = (d) => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, ent.name);
      if (ent.isSymbolicLink()) continue;
      if (ent.isDirectory()) {
        try { fs.chmodSync(full, 0o755); } catch { /* ignore */ }
        walk(full);
      } else {
        try { fs.chmodSync(full, 0o644); } catch { /* ignore */ }
      }
    }
  };
  walk(dir);
}

export function removeDir(dir) {
  makeWritable(dir);
  fs.rmSync(dir, { recursive: true, force: true });
  live.get(dir)?.();
  live.delete(dir);
}

// Temporary folders still in use; removed on exit or interrupt if not cleaned up first.
const live = new Map(); // dir -> unregister function
function track(dir, cleanup) {
  live.set(dir, onCleanup(() => {
    try {
      cleanup();
    } catch {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }));
}

export function liveTempDirs() {
  return [...live.keys()];
}

/**
 * Export the index to a temporary folder for snapshot-mode proofs.
 * Exported files are read-only (`readOnly`) and hashed so changes during a run can be detected.
 */
export function createIndexSnapshot(root, { links = [], readOnly = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pocp-snap-'));
  const cleanup = () => removeDir(dir);
  track(dir, cleanup);
  try {
    return fillIndexSnapshot(root, dir, { links, readOnly, cleanup });
  } catch (err) {
    cleanup();
    throw err;
  }
}

function fillIndexSnapshot(root, dir, { links, readOnly, cleanup }) {
  checkoutIndexTo(root, `${dir}/`);
  const entries = indexEntries(root).filter((e) => e.stage === 0 && e.mode !== '160000' && !isProofPath(e.path));
  // checkout-index skips skip-worktree entries (sparse checkouts); write those from their blobs
  // so the snapshot holds exactly what is staged.
  for (const e of entries) {
    const full = path.join(dir, e.path);
    if (fs.existsSync(full) || isLink(full)) continue;
    fs.mkdirSync(path.dirname(full), { recursive: true });
    const data = blobBuffer(root, e.sha);
    if (e.mode === '120000') fs.symlinkSync(data.toString('utf8'), full);
    else fs.writeFileSync(full, data, { mode: e.mode === '100755' ? 0o755 : 0o644 });
  }
  const files = entries.map((e) => ({ path: e.path, mode: e.mode }));
  if (readOnly) {
    for (const f of files) {
      const full = path.join(dir, f.path);
      if (fs.existsSync(full) && !fs.lstatSync(full).isSymbolicLink()) {
        fs.chmodSync(full, f.mode === '100755' ? 0o555 : 0o444);
      }
    }
  }
  linkDeps(root, dir, links);

  const hash = () => {
    const h = crypto.createHash('sha256');
    for (const f of files) {
      const full = path.join(dir, f.path);
      h.update(`${f.path}\0`);
      try {
        const st = fs.lstatSync(full);
        h.update(st.isSymbolicLink() ? `link:${fs.readlinkSync(full)}` : fs.readFileSync(full));
      } catch {
        h.update('<missing>');
      }
      h.update('\0');
    }
    return h.digest('hex');
  };

  return { dir, files, hash, cleanup };
}

/**
 * A commit's files in a temporary folder, for running its checks (verify --rerun, replay,
 * eval). The folder has no `.git` and no link back to the repository: the commit's code runs
 * there, and must not be able to reach the verifier's git config, hooks or refs through it.
 * Every call makes a fresh folder, so one check can't change another check's files.
 */
export function createRevCheckout(root, rev, { links = [] } = {}) {
  return createTreeSnapshot(root, rev, { links });
}

/**
 * A writable temporary copy of a commit's files (or of the staged index when `rev` is null),
 * shaped like an index snapshot: no .git, dependency folders linked. Used by the test guard,
 * which must build the same folder at the gate (staged code) and in CI (a commit).
 */
export function createTreeSnapshot(root, rev, { links = [] } = {}) {
  if (!rev) {
    const snap = createIndexSnapshot(root, { links, readOnly: false });
    return { dir: snap.dir, cleanup: snap.cleanup };
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pocp-tree-'));
  const cleanup = () => removeDir(dir);
  track(dir, cleanup);
  const indexFile = path.join(os.tmpdir(), `pocp-index-${crypto.randomBytes(6).toString('hex')}`);
  try {
    checkoutRevTo(root, rev, `${dir}/`, indexFile);
  } catch (err) {
    cleanup();
    throw err;
  } finally {
    fs.rmSync(indexFile, { force: true });
  }
  linkDeps(root, dir, links);
  return { dir, cleanup };
}

/** A fresh writable copy of a folder; linked dependency folders stay links. */
export function copySnapshot(src) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pocp-copy-'));
  const cleanup = () => removeDir(dir);
  track(dir, cleanup);
  try {
    if (!fs.statSync(src).isDirectory()) throw new Error(`not a folder: ${src}`);
    fs.cpSync(src, dir, { recursive: true, verbatimSymlinks: true });
  } catch (err) {
    cleanup();
    throw err;
  }
  return { dir, cleanup };
}
