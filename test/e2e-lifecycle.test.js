// Derived packet states: landed, merged and expired come from git and the clock on read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { git, packetId, pocp, sampleRepo, write, writeConfig } from './helpers.js';
import { TWEAK_ADD, commit } from './fixtures.js';
import { createPocp } from '../src/engine.js';
import * as P from '../src/packets.js';

function featureBranch(dir) {
  git(dir, 'checkout', '-q', '-b', 'feat');
  write(dir, 'src/math.js', TWEAK_ADD);
  git(dir, 'add', '-A');
  const id = packetId(pocp(dir, ['open', '--intent', 'f', '--touch', 'src/math.js']).stdout);
  assert.equal(pocp(dir, ['prove', id]).code, 0);
  assert.equal(commit(dir, 'feat').status, 0);
  git(dir, 'checkout', '-q', 'main');
  write(dir, 'README.md', '# moved on\n');
  git(dir, 'commit', '-q', '-am', 'main moves');
  return id;
}

test('a squash merge onto a moved branch reads as merged, not landed and not lingering', () => {
  const dir = sampleRepo({ hooks: true });
  const id = featureBranch(dir);
  const msg = git(dir, 'log', '-1', '--format=%B', 'feat');
  git(dir, 'merge', '-q', '--squash', 'feat');
  // GitHub-style squash message: the branch's commit messages as a list, trailers included.
  git(dir, 'commit', '-q', '--no-verify', '-m', `Feature (#1)\n\n* ${msg.trim()}\n\nCo-authored-by: x <x@example.com>`);
  const e = createPocp({ cwd: dir });
  const p = e.loadPacket(id);
  assert.equal(p.state, 'merged');
  assert.equal(p.merged.commit, git(dir, 'rev-parse', 'HEAD'));
  assert.equal(e.activePackets().some((x) => x.id === id), false, 'no longer active, so it will not drift into "expired"');
  assert.equal(git(dir, 'status', '--porcelain'), '', 'nothing written');
});

test('a true merge still lands the packet', () => {
  const dir = sampleRepo({ hooks: true });
  const id = featureBranch(dir);
  git(dir, 'merge', '-q', '--no-ff', '--no-verify', '-m', 'merge feat', 'feat');
  assert.equal(createPocp({ cwd: dir }).loadPacket(id).state, 'landed');
  assert.equal(pocp(dir, ['metrics', '--json']).json.packets.by_state.landed, 1);
});

test('expiry is derived from the last activity and writes nothing', async () => {
  const dir = sampleRepo();
  writeConfig(dir, { packet_ttl_days: 1 });
  git(dir, 'add', '-A');
  git(dir, '-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', 'ttl');
  let now = '2026-01-01T00:00:00.000Z';
  const e = createPocp({ cwd: dir, now: () => now });
  const { packet } = await e.open({ intent: 'x', touches: ['src/math.js'], obligations: [{ kind: 'test', run: 'true' }] });
  now = '2026-01-01T20:00:00.000Z';
  await e.addObligation(packet.id, { kind: 'test', run: 'echo two' });
  now = '2026-01-02T12:00:00.000Z';
  assert.equal(e.loadPacket(packet.id).state, 'open', 'active within a day of the last change, though opened 36h ago');
  now = '2026-01-03T00:00:00.000Z';
  assert.equal(e.loadPacket(packet.id).state, 'expired');
  assert.equal(e.store.readPacket(packet.id).state, 'open', 'the file keeps its state');
  assert.equal(P.lastActivity(e.store.readPacket(packet.id)), Date.parse('2026-01-01T20:00:00.000Z'));
});
