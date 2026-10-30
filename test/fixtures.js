// Shared fixtures for the end-to-end tests.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { read, sh } from './helpers.js';

export const BREAK_ADD = 'export function add(a, b) {\n  return a - b;\n}\n\nexport function isPositive(n) {\n  return n > 0;\n}\n';
export const TWEAK_ADD = 'export function add(a, b) {\n  return b + a;\n}\n\nexport function isPositive(n) {\n  return n > 0;\n}\n';

export function commit(dir, message, { env = {}, allowFail = false } = {}) {
  return sh(dir, 'git', ['commit', '-m', message], { env, allowFail });
}

export function makeKey(dir, name = 'signer') {
  const key = path.join(dir, '..', `${path.basename(dir)}-${name}`);
  sh(dir, 'ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', name, '-f', key]);
  return { key, pub: read(path.dirname(key), `${path.basename(key)}.pub`).trim() };
}

// Some tests need tools or privileges the machine may not have; they skip with a reason.
export const NO_SSH_KEYGEN = spawnSync('ssh-keygen', ['-?']).error ? 'no ssh-keygen' : false;
// Root ignores file permissions, so a read-only file can still be written.
export const IS_ROOT = typeof process.getuid === 'function' && process.getuid() === 0;
