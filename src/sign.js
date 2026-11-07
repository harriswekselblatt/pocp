import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { canonicalJson } from './hash.js';

// Proof signing with ssh-keygen (OpenSSH ≥ 8.1), the same mechanism git uses for SSH
// commit signing. No dependencies. Trusted keys live in `.proof/allowed_signers`, in
// the standard allowed_signers format:
//   alice@example.com namespaces="pocp-proof" ssh-ed25519 AAAA...
export const NAMESPACE = 'pocp-proof';

/** The bytes that get signed: the proof record without its signature, as canonical JSON. */
export function signedPayload(proof) {
  const { signature, ...rest } = proof;
  return canonicalJson(rest);
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pocp-sign-'));
}

/**
 * Resolve a signing key setting:
 *   - a private key path            → sign with that file
 *   - a ".pub" path or "key::<pub>" → sign through ssh-agent (-U)
 */
function keyArgs(key, dir) {
  if (key.startsWith('key::')) {
    const pub = path.join(dir, 'key.pub');
    fs.writeFileSync(pub, `${key.slice(5).trim()}\n`);
    return ['-U', '-f', pub];
  }
  const resolved = key.startsWith('~/') ? path.join(os.homedir(), key.slice(2)) : key;
  if (!fs.existsSync(resolved)) throw new Error(`signing key not found: ${key}`);
  return resolved.endsWith('.pub') ? ['-U', '-f', resolved] : ['-f', resolved];
}

export function signProof(proof, { key, principal }) {
  if (!key) throw new Error('no signing key configured');
  if (!principal) throw new Error('no signing principal (set sign.principal or git user.email)');
  const dir = tmpDir();
  try {
    const data = path.join(dir, 'proof.json');
    fs.writeFileSync(data, signedPayload(proof));
    execFileSync('ssh-keygen', ['-Y', 'sign', '-n', NAMESPACE, '-q', ...keyArgs(key, dir), data], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 15_000,
    });
    return { principal, namespace: NAMESPACE, sig: fs.readFileSync(`${data}.sig`, 'utf8') };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Check a proof's signature against allowed_signers text.
 * Returns "valid", "invalid", or "unsigned" (also "untrusted" when no allowed signers exist).
 * "unavailable" when ssh-keygen couldn't give an answer (missing, killed, timed out, or an
 * error that isn't a verdict): nothing is known, so it is never valid, and it isn't evidence
 * that the record was edited either.
 * `spawn` is for tests.
 */
export function verifyProofSignature(proof, allowedSigners, { spawn = spawnSync } = {}) {
  const s = proof.signature;
  if (!s?.sig || !s?.principal) return 'unsigned';
  if (!allowedSigners || !allowedSigners.trim()) return 'untrusted';
  const dir = tmpDir();
  try {
    const allowed = path.join(dir, 'allowed_signers');
    const sig = path.join(dir, 'proof.sig');
    fs.writeFileSync(allowed, allowedSigners);
    fs.writeFileSync(sig, s.sig);
    const r = spawn('ssh-keygen', ['-Y', 'verify', '-f', allowed, '-I', s.principal, '-n', NAMESPACE, '-s', sig], {
      input: signedPayload(proof),
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 15_000,
    });
    return signatureState(r);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Read an `ssh-keygen -Y verify` result. Exit 0 is valid; any other exit status is its verdict
 * that the signature doesn't verify or its signer isn't allowed (OpenSSH exits 255 for all of
 * these): invalid. No exit status (it didn't start, was killed or timed out) is no verdict at
 * all: unavailable.
 */
export function signatureState(r) {
  if (!r || r.error || r.signal || !Number.isInteger(r.status)) return 'unavailable';
  return r.status === 0 ? 'valid' : 'invalid';
}

export function sshKeygenAvailable() {
  const r = spawnSync('ssh-keygen', ['-Y', 'sign', '-?'], { stdio: 'pipe' });
  return !r.error;
}
