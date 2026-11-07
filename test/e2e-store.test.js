// Store robustness: stale locks are broken without stealing a live one, and records written
// for a newer format are refused instead of misread.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { git, pocp, sampleRepo, write, writeConfig, writeRules } from './helpers.js';
import { breakStaleLock, formatProblem, validateConfig, withDefaults, withLock } from '../src/store.js';
import { validateRules } from '../src/rules.js';
import { createPocp } from '../src/engine.js';

const DEAD = 2 ** 22 + 12345; // above the usual pid_max

test('breaking a stale lock never removes a live one that replaced it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pocp-lock-'));
  const lock = path.join(dir, 'pocp.lock');
  fs.writeFileSync(lock, String(DEAD));
  // breakStaleLock takes the lock content it read, not just a pid.
  assert.equal(breakStaleLock(lock, String(DEAD)), true);
  assert.equal(fs.existsSync(lock), false, 'the dead holder\'s lock is gone');
  // Race: we read the dead pid, but meanwhile a live process (us, here) took the lock.
  fs.writeFileSync(lock, String(process.pid));
  assert.equal(breakStaleLock(lock, String(DEAD)), false);
  assert.equal(fs.readFileSync(lock, 'utf8'), String(process.pid), 'the live lock is untouched');
  assert.deepEqual(fs.readdirSync(dir), ['pocp.lock'], 'no break lock or temporary files left behind');
  fs.rmSync(lock);
  fs.writeFileSync(lock, String(DEAD));
  assert.equal(withLock(lock, () => 'ran'), 'ran', 'a stale lock does not block');
});

test('newer record formats are refused, not misread', async () => {
  assert.equal(formatProblem({ pocp: 1 }), null);
  assert.equal(formatProblem({}), null);
  assert.match(formatProblem({ pocp: 2 }), /format 2; this version reads format 1/);
  assert.match(formatProblem({ pocp: 'x' }), /unknown POCP format/);
  assert.match(validateRules({ pocp: 2 }).join(' '), /format 2/);
  assert.match(validateConfig(withDefaults({ pocp: 3 })).join(' '), /format 3/);
  const dir = sampleRepo();
  const e = createPocp({ cwd: dir });
  const { packet } = await e.open({ intent: 'x', touches: ['src/math.js'] });
  const file = path.join(dir, '.proof', 'packets', `${packet.id}.json`);
  fs.writeFileSync(file, JSON.stringify({ ...packet, pocp: 2 }));
  const st = pocp(dir, ['status']);
  assert.equal(st.code, 2);
  assert.match(st.stderr, /written for POCP format 2/);
  // In CI, a newer packet in a commit is reported, not trusted.
  write(dir, 'src/math.js', 'x\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '--no-verify', '-m', `x\n\nProof-Of-Change: ${packet.id} subject=sha256:000000000000 policy=sha256:000000000000`);
  const v = pocp(dir, ['verify', 'HEAD', '--json']);
  assert.match(JSON.stringify(v.json.packets[0].problems), /format 2/);
});

test('rules and config for a newer format stop the gate', () => {
  const dir = sampleRepo();
  writeRules(dir, { pocp: 2 });
  assert.equal(pocp(dir, ['rules', 'check']).code, 2);
  writeRules(dir, {});
  writeConfig(dir, { pocp: 2 });
  assert.match(pocp(dir, ['rules', 'check']).stdout, /format 2/);
});
