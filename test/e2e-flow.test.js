import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { git, packetId, pocp, read, sampleRepo, sh, write, writeConfig, writeRules } from './helpers.js';
import { BREAK_ADD, TWEAK_ADD, commit, makeKey } from './fixtures.js';

test('full flow: blocked without a packet, proven, committed with trailer, landed, verified', () => {
  const dir = sampleRepo({ hooks: true });
  write(dir, 'src/math.js', TWEAK_ADD);
  git(dir, 'add', 'src/math.js');

  const blocked = commit(dir, 'tweak add', { allowFail: true });
  assert.notEqual(blocked.status, 0, 'commit must be blocked');
  assert.match(blocked.stderr, /not covered by any packet: src\/math\.js/);
  assert.match(blocked.stderr, /pocp open --intent/);
  assert.doesNotMatch(blocked.stderr, /Run targeted verification/, 'no boilerplate suggestions');

  const opened = pocp(dir, ['open', '--intent', 'Swap operand order in add', '--touch', 'src/math.js']);
  assert.equal(opened.code, 0, opened.stderr);
  const id = packetId(opened.stdout);
  assert.match(opened.stdout, /o1 \[rule:math-tests\] test: node test\/math\.check\.mjs/);

  const notYet = commit(dir, 'tweak add', { allowFail: true });
  assert.notEqual(notYet.status, 0);
  assert.match(notYet.stderr, /needs proof: o1/);

  const proved = pocp(dir, ['prove', id]);
  assert.equal(proved.code, 0, proved.stdout + proved.stderr);
  assert.match(proved.stdout, /o1: pass/);

  const ok = commit(dir, 'tweak add');
  assert.equal(ok.status, 0, ok.stderr);
  const msg = git(dir, 'log', '-1', '--format=%B');
  assert.match(msg, new RegExp(`Proof-Of-Change: ${id} subject=sha256:[0-9a-f]{12} policy=sha256:[0-9a-f]{12} proven=1/1 attested=0/0`));

  const shown = JSON.parse(pocp(dir, ['show', id]).stdout);
  assert.equal(shown.state, 'landed', 'landed, derived from the commit trailer');
  assert.equal(shown.landed.commit, git(dir, 'rev-parse', 'HEAD'));
  assert.equal(JSON.parse(read(dir, `.proof/packets/${id}.json`)).state, 'proven', 'the file keeps the state it was committed with');
  assert.equal(git(dir, 'status', '--porcelain'), '', 'and the working copy is clean after the commit');
  const committed = JSON.parse(git(dir, 'show', `HEAD:.proof/packets/${id}.json`));
  assert.equal(committed.state, 'proven', 'the committed packet carries its proof');

  const v = pocp(dir, ['verify', 'HEAD', '--rerun', '--require-coverage', '--json']);
  assert.equal(v.code, 0, v.stdout);
  assert.equal(v.json.ok, true);
  assert.equal(v.json.reruns[0].status, 'passed');
});

test('a failing check blocks the commit and is recorded', () => {
  const dir = sampleRepo({ hooks: true });
  write(dir, 'src/math.js', BREAK_ADD);
  git(dir, 'add', 'src/math.js');
  const id = packetId(pocp(dir, ['open', '--intent', 'Break add', '--touch', 'src/math.js']).stdout);
  const proved = pocp(dir, ['prove', id]);
  assert.equal(proved.code, 1);
  assert.match(proved.stdout, /FAIL exit=1/);
  const blocked = commit(dir, 'broken', { allowFail: true });
  assert.notEqual(blocked.status, 0);
  assert.match(blocked.stderr, /failed: o1/);
  const packet = JSON.parse(read(dir, `.proof/packets/${id}.json`));
  assert.equal(packet.state, 'failed');
  assert.ok(packet.history.some((h) => h.event === 'proof_failed'));
});

test('changing the code after proving voids the proof', () => {
  const dir = sampleRepo();
  write(dir, 'src/math.js', TWEAK_ADD);
  git(dir, 'add', 'src/math.js');
  const id = packetId(pocp(dir, ['open', '--intent', 'tweak', '--touch', 'src/math.js']).stdout);
  assert.equal(pocp(dir, ['prove', id]).code, 0);
  assert.equal(pocp(dir, ['gate']).code, 0);
  write(dir, 'src/math.js', `${TWEAK_ADD}// later edit\n`);
  git(dir, 'add', 'src/math.js');
  const g = pocp(dir, ['gate', '--json']);
  assert.equal(g.code, 1);
  assert.deepEqual(g.json.packets[0].evaluation.unproven, ['o1']);
});

test('changing the rules after proving blocks until the packet is synced and proven', () => {
  const dir = sampleRepo();
  write(dir, 'src/math.js', TWEAK_ADD);
  git(dir, 'add', 'src/math.js');
  const id = packetId(pocp(dir, ['open', '--intent', 'tweak', '--touch', 'src/math.js']).stdout);
  assert.equal(pocp(dir, ['prove', id]).code, 0);
  writeRules(dir, {
    requirements: [
      { id: 'math-tests', glob: 'src/**', obligation: { kind: 'test', run: 'node test/math.check.mjs' } },
      { id: 'syntax', glob: 'src/**/*.js', obligation: { kind: 'command', run: 'node --check src/math.js' } },
    ],
  });
  const g = pocp(dir, ['gate', '--json']);
  assert.equal(g.code, 1);
  assert.equal(g.json.packets[0].evaluation.missing_required[0].id, 'syntax');
  assert.equal(pocp(dir, ['prove', id]).code, 0, 'prove syncs requirements first');
  assert.equal(pocp(dir, ['gate']).code, 0);
});

test('editing an obligation voids its proof', () => {
  const dir = sampleRepo({ rules: { requirements: [] , triggers: { globs: [{ glob: 'src/**', require_packet: true }] } } });
  write(dir, 'src/math.js', TWEAK_ADD);
  git(dir, 'add', 'src/math.js');
  const id = packetId(pocp(dir, ['open', '--intent', 'tweak', '--touch', 'src/math.js', '--test', 'node test/math.check.mjs']).stdout);
  assert.equal(pocp(dir, ['prove', id]).code, 0);
  const file = path.join(dir, `.proof/packets/${id}.json`);
  const p = JSON.parse(fs.readFileSync(file, 'utf8'));
  p.obligations[0].run = 'true';
  fs.writeFileSync(file, JSON.stringify(p));
  git(dir, 'add', file);
  const g = pocp(dir, ['gate', '--json']);
  assert.equal(g.code, 1);
  assert.deepEqual(g.json.packets[0].evaluation.unproven, ['o1'], 'a swapped command needs a fresh proof');
});

test('manual obligations need an attestation for the current code', () => {
  const dir = sampleRepo({ rules: { requirements: [], triggers: { globs: [{ glob: 'src/**', require_packet: true }] } } });
  write(dir, 'src/math.js', TWEAK_ADD);
  git(dir, 'add', 'src/math.js');
  const id = packetId(pocp(dir, ['open', '--intent', 'x', '--touch', 'src/math.js', '--manual', 'Checked output by eye']).stdout);
  assert.equal(pocp(dir, ['gate']).code, 1);
  assert.equal(pocp(dir, ['attest', id, 'o1']).code, 2, '--by is required');
  assert.equal(pocp(dir, ['attest', id, 'o1', '--by', 'reviewer']).code, 0);
  assert.equal(pocp(dir, ['gate']).code, 0);
  const t = pocp(dir, ['trailer']);
  assert.match(t.stdout, /proven=0\/0 attested=1\/1/);
});

test('the packet file must be staged so its proofs ship with the commit', () => {
  const dir = sampleRepo();
  write(dir, 'src/math.js', TWEAK_ADD);
  git(dir, 'add', 'src/math.js');
  const id = packetId(pocp(dir, ['open', '--intent', 'x', '--touch', 'src/math.js']).stdout);
  assert.equal(pocp(dir, ['prove', id, '--no-stage']).code, 0);
  const g = pocp(dir, ['gate', '--json']);
  assert.equal(g.code, 1);
  assert.equal(g.json.problems[0].code, 'packet_not_staged');
});

test('gate --prove runs missing checks then decides', () => {
  const dir = sampleRepo();
  write(dir, 'src/math.js', TWEAK_ADD);
  git(dir, 'add', 'src/math.js');
  pocp(dir, ['open', '--intent', 'x', '--touch', 'src/math.js']);
  assert.equal(pocp(dir, ['gate']).code, 1);
  assert.equal(pocp(dir, ['gate', '--prove']).code, 0);
});

test('stale packets expire and are not counted as completed', () => {
  const dir = sampleRepo();
  writeConfig(dir, { packet_ttl_days: 1 });
  const id = packetId(pocp(dir, ['open', '--intent', 'old', '--touch', 'src/math.js']).stdout);
  const file = path.join(dir, `.proof/packets/${id}.json`);
  const p = JSON.parse(fs.readFileSync(file, 'utf8'));
  // Expiry counts from the last activity, so age the whole record.
  p.opened_at = '2020-01-01T00:00:00.000Z';
  for (const h of p.history) h.at = p.opened_at;
  fs.writeFileSync(file, JSON.stringify(p));
  pocp(dir, ['status']);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).state, 'open', 'expiry is derived on read; the file is not rewritten');
  assert.equal(pocp(dir, ['packets', '--all', '--json']).json.packets.find((x) => x.id === id).state, 'expired');
  assert.equal(pocp(dir, ['packets', '--json']).json.packets.length, 0, 'an expired packet is not active');
  const m = pocp(dir, ['metrics', '--json']);
  assert.equal(m.json.packets.by_state.expired, 1);
  assert.equal(m.json.packets.by_state.landed, undefined);
});

test('nothing triggers: unrelated small changes pass without a packet', () => {
  const dir = sampleRepo({ hooks: true });
  write(dir, 'README.md', '# sample\n\nmore\n');
  git(dir, 'add', 'README.md');
  const r = commit(dir, 'docs');
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(git(dir, 'log', '-1', '--format=%B'), /Proof-Of-Change/);
});

test('abandoned packets stop covering files', () => {
  const dir = sampleRepo();
  write(dir, 'src/math.js', TWEAK_ADD);
  git(dir, 'add', 'src/math.js');
  const id = packetId(pocp(dir, ['open', '--intent', 'x', '--touch', 'src/math.js']).stdout);
  assert.equal(pocp(dir, ['prove', id]).code, 0);
  assert.equal(pocp(dir, ['abandon', id]).code, 2, 'reason required');
  assert.equal(pocp(dir, ['abandon', id, '--reason', 'wrong approach']).code, 0);
  const g = pocp(dir, ['gate', '--json']);
  assert.deepEqual(g.json.uncovered, ['src/math.js']);
});
