// Pins (eval/README.md rule 4): exactly what ran, recorded in every run record.
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const POCP_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');

function tryRun(cmd, args, opts = {}) {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 20_000, ...opts }).trim();
  } catch {
    return null;
  }
}

export function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

export function sha256Text(text) {
  return crypto.createHash('sha256').update(String(text)).digest('hex');
}

/** One hash over the verifier's code (bin/ and src/), sorted by path, so any change shows. */
export function verifierHash(root = POCP_ROOT) {
  const h = crypto.createHash('sha256');
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir).sort()) {
      const full = path.join(dir, name);
      const st = fs.statSync(full);
      if (st.isDirectory()) walk(full);
      else if (st.isFile()) {
        h.update(path.relative(root, full));
        h.update('\0');
        h.update(fs.readFileSync(full));
        h.update('\0');
      }
    }
  };
  for (const d of ['bin', 'src']) walk(path.join(root, d));
  return h.digest('hex');
}

export function pocpCommit(root = POCP_ROOT) {
  const sha = tryRun('git', ['-C', root, 'rev-parse', 'HEAD']);
  // In an export with no .git (verify re-runs checks that way) there's no commit to name; the
  // verifier's own hash still identifies exactly what ran.
  if (!sha) return `no-git:${verifierHash(root).slice(0, 16)}`;
  const dirty = tryRun('git', ['-C', root, 'status', '--porcelain', '--', 'bin', 'src']);
  return dirty ? `${sha}+dirty` : sha;
}

/** The pins every record carries. Callers add agent, model, prompt, dataset and budget. */
export function basePins(extra = {}) {
  return {
    pocp_commit: pocpCommit(),
    pocp_verifier_sha256: verifierHash(),
    os: `${os.platform()} ${os.release()}`,
    arch: os.arch(),
    node: process.version,
    python: tryRun('python3', ['--version'])?.replace(/^Python /, '') || null,
    git: tryRun('git', ['--version'])?.replace(/^git version /, '') || null,
    ...extra,
  };
}
