// When ssh-keygen is missing, fails to start, is killed or times out, a signature is
// "unavailable": never valid, and never reported as "the record was edited".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { signatureState, verifyProofSignature } from '../src/sign.js';
import { verifyRemedy } from '../src/remedies.js';
import { git, packetId, pocp, read, sampleRepo, write } from './helpers.js';
import { NO_SSH_KEYGEN, TWEAK_ADD, commit, makeKey } from './fixtures.js';

const signed = { obligation: 'o1', passed: true, signature: { principal: 'dev@example.com', namespace: 'pocp-proof', sig: '-----BEGIN SSH SIGNATURE-----\nAAAA\n-----END SSH SIGNATURE-----\n' } };
const ALLOWED = 'dev@example.com namespaces="pocp-proof" ssh-ed25519 AAAA\n';

test('signatureState: only a finished ssh-keygen gives a verdict', () => {
  assert.equal(signatureState({ status: 0 }), 'valid');
  assert.equal(signatureState({ status: 255 }), 'invalid');
  assert.equal(signatureState({ status: 1 }), 'invalid');
  assert.equal(signatureState({ status: null, error: Object.assign(new Error('spawnSync ssh-keygen ENOENT'), { code: 'ENOENT' }) }), 'unavailable');
  assert.equal(signatureState({ status: null, signal: 'SIGTERM', error: Object.assign(new Error('spawnSync ssh-keygen ETIMEDOUT'), { code: 'ETIMEDOUT' }) }), 'unavailable');
  assert.equal(signatureState({ status: null, signal: 'SIGKILL' }), 'unavailable');
  assert.equal(signatureState(null), 'unavailable');
});

test('a missing, killed or timed-out ssh-keygen is unavailable, not invalid', () => {
  const enoent = () => ({ status: null, signal: null, error: Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) });
  const timedOut = () => ({ status: null, signal: 'SIGTERM', error: Object.assign(new Error('ETIMEDOUT'), { code: 'ETIMEDOUT' }) });
  const killed = () => ({ status: null, signal: 'SIGKILL' });
  for (const spawn of [enoent, timedOut, killed]) assert.equal(verifyProofSignature(signed, ALLOWED, { spawn }), 'unavailable');
  assert.equal(verifyProofSignature(signed, ALLOWED, { spawn: () => ({ status: 255 }) }), 'invalid');
});

test('with no ssh-keygen on PATH, a real check is unavailable', () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'pocp-nopath-'));
  const saved = process.env.PATH;
  process.env.PATH = empty;
  try {
    assert.equal(verifyProofSignature(signed, ALLOWED), 'unavailable');
  } finally {
    process.env.PATH = saved;
    fs.rmSync(empty, { recursive: true, force: true });
  }
});

test('the remedy for an unavailable signature does not say the record was edited', () => {
  const r = verifyRemedy('signature_unavailable');
  assert.doesNotMatch(r.why, /edited/);
  assert.match(r.next, /ssh-keygen/);
});

test('verify without ssh-keygen reports signature_unavailable, never invalid_signature or a valid signature', { skip: NO_SSH_KEYGEN }, () => {
  const dir = sampleRepo({ hooks: true });
  const { key, pub } = makeKey(dir);
  write(dir, '.proof/allowed_signers', `dev@example.com namespaces="pocp-proof" ${pub}\n`);
  git(dir, 'add', '-A');
  git(dir, '-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', 'trust a signer');
  const env = { POCP_SIGN_KEY: key, POCP_SIGN_PRINCIPAL: 'dev@example.com' };
  write(dir, 'src/math.js', TWEAK_ADD);
  git(dir, 'add', 'src/math.js');
  const id = packetId(pocp(dir, ['open', '--intent', 'x', '--touch', 'src/math.js']).stdout);
  assert.equal(pocp(dir, ['prove', id], { env }).code, 0);
  assert.match(JSON.parse(read(dir, `.proof/packets/${id}.json`)).proofs[0].signature.sig, /BEGIN SSH SIGNATURE/);
  commit(dir, 'signed change');

  // A PATH with git and node but no ssh-keygen.
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'pocp-bin-'));
  try {
    const gitPath = execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim();
    fs.symlinkSync(path.join(gitPath, 'git'), path.join(bin, 'git'));
    fs.symlinkSync(process.execPath, path.join(bin, 'node'));
    const v = pocp(dir, ['verify', 'HEAD', '--json'], { env: { PATH: bin } });
    assert.ok(v.json, v.stdout + v.stderr);
    const codes = v.json.findings.map((f) => f.code);
    assert.ok(codes.includes('signature_unavailable'), JSON.stringify(v.json.findings));
    assert.ok(!codes.includes('invalid_signature'), JSON.stringify(v.json.findings));
    assert.equal(v.json.packets[0].signatures.valid, 0);
    assert.equal(v.json.packets[0].signatures.unavailable, 1);
  } finally {
    fs.rmSync(bin, { recursive: true, force: true });
  }
});
