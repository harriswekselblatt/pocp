// Engine paths exercised through the library API (no CLI process per call, so it's fast).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { git, read, sampleRepo, write, writeConfig, writeRules } from './helpers.js';
import { BREAK_ADD, NO_SSH_KEYGEN, TWEAK_ADD } from './fixtures.js';
import { createPocp } from '../src/engine.js';

const commitNoHooks = (dir, msg) => git(dir, '-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', msg);

function landed(dir, pocp, msgFn = (lines) => `x\n\n${lines.map((l) => `Proof-Of-Change: ${l}`).join('\n')}`) {
  return pocp.trailers().then((lines) => {
    commitNoHooks(dir, msgFn(lines));
    return lines;
  });
}

test('land: skips unknown, inactive and mismatched packets', async () => {
  const dir = sampleRepo();
  const pocp = createPocp({ cwd: dir, by: 'tester' });
  write(dir, 'src/math.js', TWEAK_ADD);
  git(dir, 'add', 'src/math.js');
  const { packet } = await pocp.open({ intent: 'x', touches: ['src/math.js'] });
  await pocp.prove({ ids: [packet.id] });
  const lines = await pocp.trailers();
  commitNoHooks(dir, `x\n\nProof-Of-Change: ${lines[0]}\nProof-Of-Change: p-00000000 subject=sha256:000000000000`);
  const r = pocp.land();
  assert.deepEqual(r.landed, [packet.id]);
  assert.deepEqual(r.skipped, [{ id: 'p-00000000', reason: 'no such packet here' }]);
  const again = pocp.land();
  assert.deepEqual(again, r, 'land only reports, so it is idempotent');
  assert.equal(pocp.loadPacket(packet.id).state, 'landed');
  assert.equal(git(dir, 'status', '--porcelain'), '', 'nothing written');
  // landed packets are no longer active:
  assert.equal(pocp.activePackets().some((p) => p.id === packet.id), false);

  write(dir, 'src/math.js', `${TWEAK_ADD}// 2\n`);
  git(dir, 'add', 'src/math.js');
  const { packet: p2 } = await pocp.open({ intent: 'y', touches: ['src/math.js'] });
  await pocp.prove({ ids: [p2.id] });
  const l2 = await pocp.trailers();
  write(dir, 'src/math.js', `${TWEAK_ADD}// 3\n`);
  git(dir, 'add', 'src/math.js');
  commitNoHooks(dir, `y\n\nProof-Of-Change: ${l2[0]}`);
  assert.deepEqual(pocp.land().skipped, [{ id: p2.id, reason: 'trailer subject does not match the commit' }]);
  assert.equal(pocp.loadPacket(p2.id).state, 'merged', 'not landed: the commit names it, but its code is not what was proven');
});

test('verify: invalid packet JSON, policy mismatch, count mismatch, failed proof', async () => {
  const dir = sampleRepo();
  const pocp = createPocp({ cwd: dir });
  write(dir, 'src/math.js', TWEAK_ADD);
  git(dir, 'add', 'src/math.js');
  const { packet } = await pocp.open({ intent: 'x', touches: ['src/math.js'] });
  await pocp.prove({ ids: [packet.id] });
  const [line] = await pocp.trailers();
  const forged = line.replace(/policy=sha256:[0-9a-f]{12}/, 'policy=sha256:000000000000').replace('proven=1/1', 'proven=0/1');
  commitNoHooks(dir, `x\n\nProof-Of-Change: ${forged}`);
  const v = await pocp.verify('HEAD');
  const problems = v.packets[0].problems.join(' | ');
  assert.match(problems, /trailer policy does not match the packet/);
  assert.match(problems, /trailer says 0 proven, packet shows 1/);

  const rel = `.proof/packets/${packet.id}.json`;
  fs.writeFileSync(path.join(dir, rel), '{oops');
  git(dir, 'add', rel);
  commitNoHooks(dir, `y\n\nProof-Of-Change: ${line}`);
  const v2 = await pocp.verify('HEAD');
  assert.match(v2.packets[0].problems[0], /is not valid JSON/);
  assert.equal(v2.ok, false);

  // A committed packet whose proof failed.
  const p = JSON.parse(git(dir, 'show', `HEAD~1:${rel}`));
  p.proofs[0].passed = false;
  fs.writeFileSync(path.join(dir, rel), JSON.stringify(p));
  git(dir, 'add', rel);
  commitNoHooks(dir, `z\n\nProof-Of-Change: ${line}`);
  const v3 = await pocp.verify('HEAD', { policyFrom: null });
  assert.match(v3.packets[0].problems.join(' '), /proof for o1 failed/);
  assert.equal(v3.policy.from, null, 'policyFrom null uses the commit itself');
});

test('verify: repo rules changed under a packet, and host policy changes', async () => {
  const dir = sampleRepo();
  const host = { name: 'acme', requirementsFor: () => [{ id: 'lint', glob: 'src/**', obligation: { kind: 'command', run: 'node --check src/math.js' } }] };
  const pocp = createPocp({ cwd: dir, policy: host });
  write(dir, 'src/math.js', TWEAK_ADD);
  git(dir, 'add', 'src/math.js');
  const { packet } = await pocp.open({ intent: 'x', touches: ['src/math.js'] });
  assert.deepEqual(packet.obligations.map((o) => o.source), ['rule:math-tests', 'host:acme']);
  await pocp.prove({ ids: [packet.id] });
  await landed(dir, pocp);
  assert.equal((await pocp.verify('HEAD')).ok, true);
  const noLint = createPocp({ cwd: dir, policy: { name: 'acme', requirementsFor: () => [] } });
  const v = await noLint.verify('HEAD');
  assert.match(v.packets[0].problems.join(' '), /rules plus host policy do not match/);
  const plain = createPocp({ cwd: dir });
  assert.equal((await plain.verify('HEAD')).ok, true, 'without the host, repo rules alone still match');
});

test('prove: only, force, inactive ids, nothing staged', async () => {
  const dir = sampleRepo({ rules: { requirements: [], triggers: { globs: [{ glob: 'src/**', require_packet: true }] } } });
  const pocp = createPocp({ cwd: dir });
  write(dir, 'src/math.js', TWEAK_ADD);
  git(dir, 'add', 'src/math.js');
  const { packet } = await pocp.open({ intent: 'x', touches: ['src/math.js'], obligations: [{ kind: 'test', run: 'true' }, { kind: 'test', run: 'node test/math.check.mjs' }] });
  const only = await pocp.prove({ ids: [packet.id], only: ['o2'] });
  assert.deepEqual(only.packets[0].runs.map((r) => r.obligation), ['o2']);
  assert.equal(only.ran, 1);
  const rest = await pocp.prove({ ids: [packet.id] });
  assert.equal(rest.ran, 1, 'o2 already proven');
  const forced = await pocp.prove({ ids: [packet.id], force: true });
  assert.equal(forced.ran, 2);
  const p = pocp.loadPacket(packet.id);
  assert.equal(p.proofs.filter((x) => x.obligation === 'o2').length, 2);
  assert.ok(p.proofs.every((x) => x.runner.pocp && x.runner.node && x.runner.platform && x.mode === 'clean'));
  pocp.abandon(packet.id, 'done');
  const none = await pocp.prove({ ids: [packet.id] });
  assert.deepEqual(none.packets, []);
  git(dir, 'reset', '-q');
  git(dir, 'checkout', '--', 'src/math.js');
  const { packet: q } = await pocp.open({ intent: 'all active', touches: ['README.md'], obligations: [{ kind: 'test', run: 'true' }] });
  const all = await pocp.prove({ mode: 'clean', stage: false });
  assert.deepEqual(all.packets.map((x) => x.id), [q.id], 'nothing staged: all active packets');
  await assert.rejects(pocp.prove({ mode: 'weird' }), /unknown run mode/);
});

test('prove: untracked files inside touches block clean mode', async () => {
  const dir = sampleRepo();
  const pocp = createPocp({ cwd: dir });
  write(dir, 'src/math.js', TWEAK_ADD);
  git(dir, 'add', 'src/math.js');
  write(dir, 'src/scratch.js', 'x');
  const { packet } = await pocp.open({ intent: 'x', touches: ['src/**'] });
  await assert.rejects(pocp.prove({ ids: [packet.id] }), (err) => {
    assert.equal(err.details.problems[0].code, 'untracked_inputs');
    assert.deepEqual(err.details.problems[0].files, ['src/scratch.js']);
    return true;
  });
  fs.rmSync(path.join(dir, 'src/scratch.js'));
  write(dir, 'data/input.json', '{}');
  const { packet: q } = await pocp.open({ intent: 'y', touches: ['src/math.js'], obligations: [{ kind: 'test', run: 'true', inputs: ['data/**'] }] });
  await assert.rejects(pocp.prove({ ids: [q.id] }), /clean mode refused/, 'declared inputs count too');
});

test('gate: a prove failure inside gate --prove is reported, not thrown', async () => {
  const dir = sampleRepo();
  const pocp = createPocp({ cwd: dir });
  write(dir, 'src/math.js', TWEAK_ADD);
  git(dir, 'add', 'src/math.js');
  write(dir, 'src/math.js', BREAK_ADD); // unstaged
  await pocp.open({ intent: 'x', touches: ['src/math.js'] });
  const g = await pocp.gate({ prove: true });
  assert.equal(g.decision, 'blocked');
  assert.equal(g.problems[0].code, 'prove_failed');
  const log = pocp.store.readLog('gate');
  assert.equal(log.at(-1).decision, 'blocked');
});

test('gate: suggestion lists required checks with their rule', async () => {
  const dir = sampleRepo();
  const pocp = createPocp({ cwd: dir });
  write(dir, 'src/math.js', TWEAK_ADD);
  git(dir, 'add', 'src/math.js');
  const g = await pocp.gate();
  assert.equal(g.suggestion.obligations[0].from, 'math-tests');
  assert.match(g.suggestion.command, /--touch 'src\/math\.js'/);
  assert.doesNotMatch(g.suggestion.command, /--test/, 'no placeholder check when a rule supplies one');
  assert.match(g.suggestion.note, /added automatically/);
});

test('events: lifecycle notifications reach the host and errors in them are ignored', async () => {
  const dir = sampleRepo();
  const seen = [];
  const pocp = createPocp({ cwd: dir, events: { emit: (t, p) => { seen.push(t); if (t === 'packet.opened') throw new Error('host bug'); } } });
  write(dir, 'src/math.js', TWEAK_ADD);
  git(dir, 'add', 'src/math.js');
  const { packet } = await pocp.open({ intent: 'x', touches: ['src/math.js'] });
  await pocp.prove({ ids: [packet.id] });
  await pocp.gate();
  pocp.abandon(packet.id, 'no');
  for (const t of ['packet.opened', 'proof.started', 'proof.recorded', 'gate.passed', 'packet.abandoned']) assert.ok(seen.includes(t), t);
});

test('expiry happens on read and emits an event', async () => {
  const dir = sampleRepo();
  writeConfig(dir, { packet_ttl_days: 1 });
  let now = '2026-01-01T00:00:00.000Z';
  const seen = [];
  const pocp = createPocp({ cwd: dir, now: () => now, events: { emit: (t) => seen.push(t) } });
  const { packet } = await pocp.open({ intent: 'x', touches: ['a'] });
  assert.equal(pocp.activePackets().length, 1);
  now = '2026-01-03T00:00:00.000Z';
  assert.equal(pocp.activePackets().length, 0);
  assert.equal(pocp.loadPacket(packet.id).state, 'expired');
  assert.ok(seen.includes('packet.expired'));
});

test('sync, widen and status report what changed', async () => {
  const dir = sampleRepo({ rules: { requirements: [{ id: 'lib', glob: 'lib/**', obligation: { kind: 'test', run: 'true' } }] } });
  const pocp = createPocp({ cwd: dir, newId: (p) => `${p}-fixed000` });
  const { packet } = await pocp.open({ intent: 'x', touches: ['src/math.js'], obligations: [{ kind: 'test', run: 'true' }] });
  assert.equal(packet.id, 'p-fixed000', 'custom id generator');
  const w = await pocp.widen(packet.id, ['lib/a.js']);
  assert.deepEqual(w.added, ['lib/a.js']);
  assert.equal(w.required_added.length, 0, 'same check already present');
  writeRules(dir, { requirements: [{ id: 'lib2', glob: 'lib/**', obligation: { kind: 'command', run: 'echo lib' } }] });
  const s = await pocp.sync();
  assert.deepEqual(s, [{ id: packet.id, added: ['o2'] }]);
  const st = await pocp.status();
  assert.equal(st.packets[0].obligations[1].what, 'command: echo lib');
  assert.deepEqual(st.rules_problems, []);
  await assert.rejects(pocp.addObligation('p-nope', { kind: 'test', run: 'x' }), /no packet/);
  pocp.abandon(packet.id, 'x');
  await assert.rejects(pocp.addObligation(packet.id, { kind: 'test', run: 'y' }), /abandoned/);
  await assert.rejects(pocp.widen(packet.id, ['z']), /abandoned/);
  assert.throws(() => pocp.attest(packet.id, 'o1', { by: 'x' }), /abandoned/);
  assert.throws(() => pocp.ready(packet.id), /not draft/);
});

test('ambiguous ids are refused', async () => {
  const dir = sampleRepo();
  let n = 0;
  const pocp = createPocp({ cwd: dir, newId: (p) => `${p}-abc0000${n++}` });
  await pocp.open({ intent: 'a', touches: ['a'] });
  await pocp.open({ intent: 'b', touches: ['b'] });
  assert.throws(() => pocp.loadPacket('p-abc'), /ambiguous/);
  assert.equal(pocp.loadPacket('p-abc00001').intent, 'b');
});

test('lockfile hash and env mode reach the proof', async () => {
  const dir = sampleRepo({ rules: { requirements: [], triggers: { globs: [{ glob: 'src/**', require_packet: true }] } } });
  write(dir, 'package-lock.json', '{"lockfileVersion":3}');
  writeConfig(dir, { run: { env: 'minimal' } });
  git(dir, 'add', '-A');
  commitNoHooks(dir, 'lock');
  process.env.POCP_SECRET_FOR_TEST = 'x';
  const pocp = createPocp({ cwd: dir });
  write(dir, 'src/math.js', TWEAK_ADD);
  git(dir, 'add', 'src/math.js');
  const { packet } = await pocp.open({ intent: 'x', touches: ['src/math.js'], obligations: [{ kind: 'test', run: 'test -z "$POCP_SECRET_FOR_TEST" && test "$POCP" = 1 && test "$POCP_OBLIGATION" = o1' }] });
  const r = await pocp.prove({ ids: [packet.id] });
  delete process.env.POCP_SECRET_FOR_TEST;
  assert.equal(r.packets[0].evaluation.ok, true, 'minimal env hides other variables and sets POCP vars');
  const proof = pocp.loadPacket(packet.id).proofs[0];
  assert.match(proof.runner.lockfile_sha256, /^[0-9a-f]{64}$/);
  assert.equal(proof.policy, pocp.loadPacket(packet.id).policy);
  assert.ok(read(dir, `.proof/runs/${proof.run_id}.log`).startsWith('$ test -z'));
});

test('a catch-all packet ("**") still gets every required check for the files it covers', async () => {
  const dir = sampleRepo();
  const pocp = createPocp({ cwd: dir });
  write(dir, 'src/math.js', BREAK_ADD);
  git(dir, 'add', 'src/math.js');
  const { packet } = await pocp.open({ intent: 'everything', touches: ['**'], obligations: [{ kind: 'test', run: 'true' }] });
  assert.ok(packet.obligations.some((o) => o.source === 'rule:math-tests'), 'required check attached via the covered file');
  const r = await pocp.prove({ ids: [packet.id] });
  assert.equal(r.packets[0].evaluation.failed.length, 1, 'and it catches the broken code');
  const g = await pocp.gate();
  assert.equal(g.decision, 'blocked');

  // Same trick committed with --no-verify: verify still demands the check.
  const p = pocp.loadPacket(packet.id);
  p.obligations = p.obligations.filter((o) => o.source === 'author');
  p.proofs = p.proofs.filter((x) => x.obligation === 'o1');
  fs.writeFileSync(path.join(dir, `.proof/packets/${packet.id}.json`), JSON.stringify(p));
  git(dir, 'add', '-A');
  const subject = (await import('../src/git.js')).subjectHashIndex(dir);
  commitNoHooks(dir, `sneak\n\nProof-Of-Change: ${packet.id} subject=${subject.slice(0, 19)} policy=${p.policy.slice(0, 19)} proven=1/1 attested=0/0`);
  const v = await pocp.verify('HEAD');
  assert.equal(v.ok, false);
  assert.match(v.packets[0].problems.join(' '), /required obligation missing: math-tests/);
});

test('gate: one proven packet is enough; a stray unproven one only warns; a failing one blocks', async () => {
  const dir = sampleRepo();
  const pocp = createPocp({ cwd: dir });
  write(dir, 'src/math.js', TWEAK_ADD);
  git(dir, 'add', 'src/math.js');
  const { packet: a } = await pocp.open({ intent: 'real', touches: ['src/math.js'] });
  const { packet: b } = await pocp.open({ intent: 'later work', touches: ['src/**'], obligations: [{ kind: 'test', run: 'true' }] });
  await pocp.prove({ ids: [a.id] });
  const g = await pocp.gate();
  assert.equal(g.decision, 'pass', 'b is not needed for coverage');
  assert.equal(g.warnings[0].code, 'open_packet');
  assert.equal(g.warnings[0].packet, b.id);
  await pocp.addObligation(b.id, { kind: 'test', run: 'false' });
  await pocp.prove({ ids: [b.id] });
  const g2 = await pocp.gate();
  assert.equal(g2.decision, 'blocked', 'a failing check anywhere on these files blocks');
  assert.equal(g2.problems[0].code, 'failed_proof');
  assert.deepEqual(g2.unpacketed, []);
});

test('with signing on, an unsigned proof in another packet is not reused (and so not laundered)', { skip: NO_SSH_KEYGEN }, async () => {
  const dir = sampleRepo();
  const { makeKey } = await import('./fixtures.js');
  const { key, pub } = makeKey(dir, 'dev');
  write(dir, '.proof/allowed_signers', `dev@example.com namespaces="pocp-proof" ${pub}\n`);
  writeConfig(dir, { sign: { key, principal: 'dev@example.com' } });
  git(dir, 'add', '-A');
  commitNoHooks(dir, 'signing');
  write(dir, 'src/math.js', BREAK_ADD);
  git(dir, 'add', 'src/math.js');
  const pocp = createPocp({ cwd: dir });
  // A forged "passed" proof planted in a stray packet.
  const { packet: fake } = await pocp.open({ intent: 'fake', touches: ['src/math.js'] });
  const subject = (await import('../src/git.js')).subjectHashIndex(dir);
  const f = pocp.loadPacket(fake.id);
  const { obligationDigest } = await import('../src/obligations.js');
  f.proofs.push({ obligation: 'o1', obligation_digest: obligationDigest(f.obligations[0]), subject, passed: true, duration_ms: 1 });
  fs.writeFileSync(path.join(dir, `.proof/packets/${fake.id}.json`), JSON.stringify(f));
  const { packet: real } = await pocp.open({ intent: 'real', touches: ['src/math.js'] });
  const r = await pocp.prove({ ids: [real.id] });
  assert.equal(r.ran, 1, 'ran the check instead of reusing the forged proof');
  assert.equal(r.packets[0].evaluation.failed.length, 1, 'and the broken code fails');
});

// ---------------------------------------------------------------- tests written from surviving mutants

test('survivors: status lists policy files only when they changed', async () => {
  const dir = sampleRepo();
  const pocp = createPocp({ cwd: dir });
  write(dir, 'src/math.js', TWEAK_ADD);
  git(dir, 'add', 'src/math.js');
  assert.deepEqual((await pocp.status()).staged, ['src/math.js']);
  writeRules(dir, { requirements: [] });
  git(dir, 'add', '-A');
  assert.deepEqual((await pocp.status()).staged, ['src/math.js', '.proof/rules.json']);
});

test('survivors: verify counts signatures exactly and hides internal fields from JSON', async () => {
  const dir = sampleRepo();
  const pocp = createPocp({ cwd: dir });
  write(dir, 'src/math.js', TWEAK_ADD);
  git(dir, 'add', 'src/math.js');
  const { packet } = await pocp.open({ intent: 'x', touches: ['src/math.js'] });
  await pocp.prove({ ids: [packet.id] });
  await landed(dir, pocp);
  const v = await pocp.verify('HEAD');
  assert.deepEqual(v.packets[0].signatures, { valid: 0, invalid: 0, unsigned: 1, untrusted: 0 }, 'one unsigned proof');
  const json = JSON.parse(JSON.stringify(v));
  assert.equal(json.signedDigests, undefined);
  assert.equal(json.packetData, undefined);
});

test('survivors: verify --require-coverage demands a packet over changed existing tests', async () => {
  const dir = sampleRepo();
  const pocp = createPocp({ cwd: dir });
  write(dir, 'test/math.check.mjs', "console.log('ok');\n");
  git(dir, 'add', '-A');
  commitNoHooks(dir, 'gut');
  const v = await pocp.verify('HEAD', { requireCoverage: true });
  assert.deepEqual(v.coverage.uncovered, ['test/math.check.mjs']);
  writeConfig(dir, { guard: { tests: 'warn' } });
  git(dir, 'add', '-A');
  commitNoHooks(dir, 'warn mode');
  write(dir, 'test/math.check.mjs', "console.log('ok 2');\n");
  git(dir, 'add', '-A');
  commitNoHooks(dir, 'gut again');
  const w = await pocp.verify('HEAD', { requireCoverage: true });
  assert.deepEqual(w.coverage.uncovered, [], 'warn mode only reports');
});

test('survivors: amend trailers compare with the parent, not the empty tree', async () => {
  const dir = sampleRepo();
  const pocp = createPocp({ cwd: dir });
  // A proven packet over README.md that the amended commit does not touch.
  const { packet: other } = await pocp.open({ intent: 'docs', touches: ['README.md'], obligations: [{ kind: 'test', run: 'true' }] });
  await pocp.prove({ ids: [other.id], stage: false });
  write(dir, 'src/math.js', TWEAK_ADD);
  git(dir, 'add', 'src/math.js');
  commitNoHooks(dir, 'first');
  write(dir, 'src/math.js', `${TWEAK_ADD}// amended\n`);
  git(dir, 'add', 'src/math.js');
  const { packet } = await pocp.open({ intent: 'x', touches: ['src/math.js'] });
  await pocp.prove({ ids: [packet.id] });
  const msg = path.join(dir, '.git', 'AMEND_MSG');
  fs.writeFileSync(msg, 'first\n');
  const lines = await pocp.addTrailersToFile(msg, { source: 'commit' });
  assert.equal(lines.length, 1);
  assert.match(lines[0], new RegExp(`^${packet.id} `));
});

test('survivors: replay refuses when the miss files did not change', async () => {
  const dir = sampleRepo();
  const pocp = createPocp({ cwd: dir });
  const base = git(dir, 'rev-parse', 'HEAD');
  const miss = pocp.recordMiss({ description: 'x', stage: 'ci', files: ['src/math.js'] });
  writeRules(dir, { requirements: [{ id: 'r', glob: 'src/**', obligation: { kind: 'test', run: 'node test/math.check.mjs' }, source: `miss:${miss.id}` }] });
  git(dir, 'add', '-A');
  await assert.rejects(pocp.closeMiss(miss.id, { replay: base }), /nothing to replay/);
});

test('survivors: replay rolls back a file the fix added by deleting it', async () => {
  const dir = sampleRepo();
  const pocp = createPocp({ cwd: dir });
  const escaped = git(dir, 'rev-parse', 'HEAD');
  // The fix adds a new module and a test that needs it.
  write(dir, 'src/guard.js', 'export const ok = true;\n');
  write(dir, 'test/guard.check.mjs', "import { ok } from '../src/guard.js';\nif (!ok) process.exit(1);\n");
  const miss = pocp.recordMiss({ description: 'missing guard', stage: 'production', files: ['src/guard.js'] });
  writeRules(dir, { requirements: [{ id: 'g', glob: 'src/guard.js', obligation: { kind: 'test', run: 'node test/guard.check.mjs' }, source: `miss:${miss.id}` }] });
  git(dir, 'add', '-A');
  const closed = await pocp.closeMiss(miss.id, { replay: escaped });
  assert.equal(closed.closed, 'replay-confirmed');
  assert.deepEqual(closed.replay.rolled_back, ['src/guard.js']);
});

test('survivors: a failing re-run fails a single-commit verify; no re-run without the flag', async () => {
  const dir = sampleRepo();
  const pocp = createPocp({ cwd: dir });
  write(dir, 'src/math.js', BREAK_ADD);
  git(dir, 'add', 'src/math.js');
  const { packet } = await pocp.open({ intent: 'x', touches: ['src/math.js'] });
  await pocp.prove({ ids: [packet.id] });
  // Forge the failed proof into a pass.
  const p = pocp.loadPacket(packet.id);
  p.proofs.at(-1).passed = true;
  p.state = 'proven';
  fs.writeFileSync(path.join(dir, `.proof/packets/${packet.id}.json`), JSON.stringify(p));
  git(dir, 'add', '-A');
  await landed(dir, pocp);
  const quick = await pocp.verify('HEAD');
  assert.deepEqual(quick.reruns, [], 'no re-run unless asked');
  const v = await pocp.verify('HEAD', { rerun: true });
  assert.equal(v.ok, false);
  assert.match(v.packets[0].problems.join(' '), /rerun of "node test\/math\.check\.mjs" failed/);
});

test('survivors: policy weakening names a protected path even when another stays protected', async () => {
  const { policyWeakening } = await import('../src/rules.js');
  const { rulesWithDefaults: rw } = await import('../src/store.js');
  const base = rw({ triggers: { globs: [{ glob: 'a/**', require_packet: true }] } });
  const head = rw({ triggers: { globs: [{ glob: 'b/**', require_packet: true }] } });
  assert.ok(policyWeakening(base, head).includes('protected path "a/**" removed'));
});

test('survivors: hooks health reports a missing hook only once pocp is installed', async () => {
  const { hooksHealth, installHooks } = await import('../src/init.js');
  const dir = sampleRepo();
  assert.deepEqual(hooksHealth(dir).problems, [], 'nothing installed, nothing to report');
  assert.equal(hooksHealth(dir).installed, false);
  installHooks(dir);
  fs.rmSync(path.join(dir, '.git/hooks/post-commit'));
  const h = hooksHealth(dir);
  assert.equal(h.installed, true);
  assert.deepEqual(h.problems, ['post-commit: missing']);
});

test('survivors: catch rate with a single miss is 0, not unknown', async () => {
  const { computeMetrics } = await import('../src/metrics.js');
  assert.equal(computeMetrics({ misses: [{ stage: 'ci', state: 'open' }] }).catch_rate, 0);
  assert.equal(computeMetrics({ packets: [{ state: 'landed', obligations: [{ id: 'o1', kind: 'test', run: 't' }], proofs: [], history: [] }] }).proven_share, 1);
});

test('survivors 3: verify demands the guard sign-off; root commits; no signer change without a base', async () => {
  const dir = sampleRepo();
  const pocp = createPocp({ cwd: dir });
  write(dir, 'test/math.check.mjs', "console.log('weaker');\n");
  git(dir, 'add', '-A');
  const { packet } = await pocp.open({ intent: 'x', touches: ['test/**'], obligations: [{ kind: 'test', run: 'true' }] });
  await pocp.prove({ ids: [packet.id] });
  // Strip the guard obligation the gate added, then commit anyway.
  const p = pocp.loadPacket(packet.id);
  p.obligations = p.obligations.filter((o) => o.source !== 'guard:tests');
  fs.writeFileSync(path.join(dir, `.proof/packets/${packet.id}.json`), JSON.stringify(p));
  git(dir, 'add', '-A');
  const lines = [`${packet.id} subject=${(await import('../src/git.js')).subjectHashIndex(dir).slice(0, 19)} policy=${p.policy.slice(0, 19)} proven=1/1 attested=0/0`];
  commitNoHooks(dir, `x\n\nProof-Of-Change: ${lines[0]}`);
  const v = await pocp.verify('HEAD');
  assert.match(v.packets[0].problems.join(' '), /required obligation missing: guard:tests/);

  const root = git(dir, 'rev-list', '--max-parents=0', 'HEAD');
  const r = await pocp.verify(root, { requireCoverage: true });
  assert.ok(r.coverage, 'coverage check runs on a root commit');
  write(dir, '.proof/allowed_signers', 'a@b namespaces="pocp-proof" ssh-ed25519 AAAA\n');
  git(dir, 'add', '-A');
  commitNoHooks(dir, 'signers');
  assert.deepEqual((await pocp.verify('HEAD', { policyFrom: null })).policy.weakened, [], 'no base, nothing to compare');
});

test('survivors 3: syncing records a policy change even when nothing is added', async () => {
  const P = await import('../src/packets.js');
  const p = P.createPacket({ intent: 'x', touches: ['a'], obligations: [{ kind: 'test', run: 't' }], now: '2026-01-01T00:00:00.000Z' });
  P.syncRequirements(p, { merged: [], repoOnly: [] }, { now: '2026-01-01T00:00:00.000Z' });
  const n = p.history.length;
  p.policy = 'sha256:stale';
  P.syncRequirements(p, { merged: [], repoOnly: [] }, { now: '2026-01-01T00:00:00.000Z' });
  assert.equal(p.history.length, n + 1);
  p.policy_repo = 'sha256:stale';
  P.syncRequirements(p, { merged: [], repoOnly: [] }, { now: '2026-01-01T00:00:00.000Z' });
  assert.equal(p.history.length, n + 2);
});

test('survivors 3: thresholds of 1, mutation line numbers, eval and history numbers', async () => {
  const { strictUnion } = await import('../src/rules.js');
  const { rulesWithDefaults: rw } = await import('../src/store.js');
  assert.equal(strictUnion(rw({ triggers: { broad_files: 1 } }), rw({ triggers: { broad_files: 5 } })).triggers.broad_files, 1);
  const { mutationSites } = await import('../src/mutants.js');
  const sites = mutationSites('a\nbb\nccc === d\n\ne && f');
  assert.deepEqual(sites.map((s) => [s.op, s.line]).sort(), [['and', 5], ['strict-eq', 3]]);
  const dir = sampleRepo();
  const pocp = createPocp({ cwd: dir });
  const { runMutantEval } = await import('../src/mutants.js');
  const r = await runMutantEval(pocp, { count: 'all', jobs: 2 });
  const f = r.by_file['src/math.js'];
  assert.equal(f.total, r.total);
  assert.equal(f.caught, r.caught);
  const { simulateGate } = await import('../src/history.js');
  write(dir, 'src/math.js', TWEAK_ADD);
  git(dir, 'add', '-A');
  commitNoHooks(dir, 'two');
  const h = simulateGate(pocp, { limit: 10 });
  assert.equal(h.commits, 2);
  assert.equal(h.share, h.would_need_packet / 2);
});

test('survivors 4: "accepted" is only reported when something was loosened; eval times are durations', async () => {
  const dir = sampleRepo();
  const pocp = createPocp({ cwd: dir });
  write(dir, 'README.md', 'y\n');
  git(dir, 'add', '-A');
  commitNoHooks(dir, 'plain');
  assert.equal((await pocp.verify('HEAD', { acceptPolicyChange: true })).policy.accepted, false);
  const { runMutantEval } = await import('../src/mutants.js');
  const r = await runMutantEval(pocp, { count: 2, jobs: 1 });
  assert.ok(r.mutants.every((m) => m.ms >= 0 && m.ms < 600_000));
});

test('survivors 5: a rule-added miss upgrades to replay-confirmed; a confirmed one cannot be re-closed', async () => {
  const dir = sampleRepo();
  const pocp = createPocp({ cwd: dir });
  write(dir, 'src/math.js', TWEAK_ADD.replace('return n > 0;', 'return n >= 0;'));
  git(dir, 'add', '-A');
  commitNoHooks(dir, 'bug');
  const escaped = git(dir, 'rev-parse', 'HEAD');
  const miss = pocp.recordMiss({ description: 'zero', stage: 'production', files: ['src/math.js'] });
  write(dir, 'test/zero.check.mjs', "import { isPositive } from '../src/math.js';\nif (isPositive(0)) process.exit(1);\n");
  writeRules(dir, { requirements: [{ id: 'z', glob: 'src/math.js', obligation: { kind: 'test', run: 'node test/zero.check.mjs' }, source: `miss:${miss.id}` }] });
  write(dir, 'src/math.js', TWEAK_ADD);
  git(dir, 'add', '-A');
  assert.equal((await pocp.closeMiss(miss.id)).closed, 'rule-added');
  await assert.rejects(pocp.closeMiss(miss.id), /already closed \(rule-added\)/, 'no replay, no upgrade');
  assert.equal((await pocp.closeMiss(miss.id, { replay: escaped })).closed, 'replay-confirmed');
  await assert.rejects(pocp.closeMiss(miss.id, { replay: escaped }), /already closed \(replay-confirmed\)/);
});

test('survivors 5: opening a packet does not stage it; reuse costs nothing; ranges take policy from their base', async () => {
  const dir = sampleRepo();
  const pocp = createPocp({ cwd: dir });
  const { packet } = await pocp.open({ intent: 'x', touches: ['src/math.js'] });
  assert.doesNotMatch(git(dir, 'diff', '--cached', '--name-only'), new RegExp(packet.id));
  write(dir, 'src/math.js', TWEAK_ADD);
  git(dir, 'add', 'src/math.js');
  await pocp.prove({ ids: [packet.id] });
  const { packet: b } = await pocp.open({ intent: 'b', touches: ['src/**'] });
  const r = await pocp.prove({ ids: [b.id] });
  assert.equal(r.packets[0].runs[0].duration_ms, 0);
  const base = git(dir, 'rev-parse', 'HEAD');
  commitNoHooks(dir, 'one');
  write(dir, 'README.md', 'z\n');
  git(dir, 'add', '-A');
  commitNoHooks(dir, 'two');
  const v = await pocp.verifyRange(`${base}..HEAD`);
  assert.deepEqual(v.commits.map((c) => c.policy.from), [base, base], 'every commit judged by the range base');
});

test('survivors 5: friction ignores blocks with an uncovered file; eval keeps the original line', async () => {
  const { computeMetrics } = await import('../src/metrics.js');
  const m = computeMetrics({ gateLog: [{ decision: 'blocked', subject: 'A', uncovered: 1, packets: [] }, { decision: 'pass', subject: 'A', packets: [] }] });
  assert.equal(m.gate.friction_blocks, 0);
  const dir = sampleRepo();
  const { runMutantEval } = await import('../src/mutants.js');
  const r = await runMutantEval(createPocp({ cwd: dir }), { count: 'all', jobs: 1 });
  const src = fs.readFileSync(path.join(dir, 'src/math.js'), 'utf8').split('\n').map((l) => l.trim());
  assert.ok(r.mutants.every((x) => src.includes(x.before)), 'before is the exact original line');
});

test('survivors 6: replay notes, gate prove-failure details, range verify runs nothing without --rerun', async () => {
  const dir = sampleRepo();
  const pocp = createPocp({ cwd: dir });
  const base = git(dir, 'rev-parse', 'HEAD');
  const miss = pocp.recordMiss({ description: 'x', stage: 'ci', files: ['src/math.js'] });
  writeRules(dir, { requirements: [{ id: 'r', glob: 'src/**', obligation: { kind: 'test', run: 'node test/math.check.mjs' }, source: `miss:${miss.id}` }] });
  git(dir, 'add', '-A');
  const err = await pocp.closeMiss(miss.id, { replay: base }).catch((e) => e);
  assert.deepEqual(err.details.replay.notes.length, 1, 'only the "nothing to replay" note');

  write(dir, 'src/math.js', TWEAK_ADD);
  git(dir, 'add', 'src/math.js');
  write(dir, 'src/math.js', BREAK_ADD);
  await pocp.open({ intent: 'x', touches: ['src/math.js'] });
  const g = await pocp.gate({ prove: true });
  assert.equal(g.problems[0].problems[0].code, 'worktree_differs', 'the refusal details are kept');

  git(dir, 'checkout', '--', 'src/math.js');
  git(dir, 'reset', '-q', '--', '.proof/rules.json');
  commitNoHooks(dir, 'one');
  const v = await pocp.verifyRange(`${base}..HEAD`);
  assert.ok(v.commits.every((c) => c.reruns.length === 0));
  assert.deepEqual(v.reruns, []);
  const { runMutantEval } = await import('../src/mutants.js');
  const r = await runMutantEval(pocp, { count: 1, jobs: 1 });
  assert.ok(r.duration_ms >= 0 && r.duration_ms < 600_000);
});

test('verify fails closed when rules or config at the commit or its base are invalid', async () => {
  const dir = sampleRepo();
  const pocp = createPocp({ cwd: dir });
  write(dir, '.proof/rules.json', '{not json');
  git(dir, 'add', '-A');
  commitNoHooks(dir, 'broken rules');
  const v = await pocp.verify('HEAD');
  assert.equal(v.ok, false);
  assert.match(v.notes.join(' '), /invalid policy: \.proof\/rules\.json at [0-9a-f]{12} is not valid JSON/);
  write(dir, 'README.md', 'next\n');
  git(dir, 'add', '-A');
  commitNoHooks(dir, 'on top of broken rules');
  assert.equal((await pocp.verify('HEAD')).ok, false, 'a broken base also fails closed');
  writeRules(dir, { requirements: [] });
  writeConfig(dir, { run: { mode: 'yolo' }, guard: { tests: 'sometimes' } });
  git(dir, 'add', '-A');
  commitNoHooks(dir, 'bad config');
  const c = await pocp.verify('HEAD', { policyFrom: null });
  assert.match(c.notes.join(' '), /run\.mode must be/);
  assert.match(c.notes.join(' '), /guard\.tests must be/);
  write(dir, 'src/math.js', TWEAK_ADD);
  git(dir, 'add', 'src/math.js');
  const g2 = await pocp.gate();
  assert.equal(g2.decision, 'error');
  assert.ok(g2.problems.some((p) => p.code === 'invalid_config'));
});

test('evidence labels say what establishes each check; cwd runs a check in a subfolder', async () => {
  const dir = sampleRepo({ rules: { requirements: [], triggers: { globs: [{ glob: 'src/**', require_packet: true }] } } });
  const pocp = createPocp({ cwd: dir });
  write(dir, 'pkg/run.sh', 'test -f marker.txt\n');
  write(dir, 'pkg/marker.txt', 'x\n');
  git(dir, 'add', '-A');
  commitNoHooks(dir, 'subfolder');
  write(dir, 'src/math.js', TWEAK_ADD);
  git(dir, 'add', 'src/math.js');
  const { packet } = await pocp.open({ intent: 'x', touches: ['src/math.js'], obligations: [
    { kind: 'test', run: 'sh run.sh', cwd: 'pkg' },
    { kind: 'test', run: 'node test/math.check.mjs' },
    { kind: 'manual', text: 'Looked at it' },
  ] });
  await assert.rejects(pocp.open({ intent: 'y', touches: ['a'], obligations: [{ kind: 'test', run: 'x', cwd: '../up' }] }), /inside the repository/);
  const r = await pocp.prove({ ids: [packet.id] });
  assert.equal(r.packets[0].evaluation.failed.length, 0, 'the cwd check ran in pkg/');
  pocp.attest(packet.id, 'o3', { by: 'reviewer' });
  await landed(dir, pocp);
  const local = await pocp.verify('HEAD');
  assert.deepEqual(local.packets[0].evidence, { o1: 'local', o2: 'local', o3: 'attested:reviewer' });
  const rerun = await pocp.verify('HEAD', { rerun: true });
  assert.deepEqual(rerun.packets[0].evidence, { o1: 'rerun', o2: 'rerun', o3: 'attested:reviewer' });
  const ci = await pocp.ciRun('node test/math.check.mjs');
  const withCi = await pocp.verify('HEAD', { rerun: true, ciResults: [ci] });
  assert.equal(withCi.packets[0].evidence.o2, 'ci-result');
  assert.equal(withCi.packets[0].evidence.o1, 'rerun', 'a CI result for the root folder does not cover the pkg/ check');
});

test('eval: a saved sample replays exactly; mutants are isolated from each other', async () => {
  const dir = sampleRepo();
  const pocp = createPocp({ cwd: dir });
  const { runMutantEval } = await import('../src/mutants.js');
  // A check that leaves a file behind and fails if it finds one: with shared folders,
  // the second mutant would be "caught" by the first one's leftovers.
  writeRules(dir, { requirements: [{ id: 'sticky', glob: 'src/**', obligation: { kind: 'test', run: 'test ! -f leftover && touch leftover' } }] });
  git(dir, 'add', '-A');
  const r = await runMutantEval(pocp, { count: 'all', jobs: 1 });
  assert.equal(r.caught, 0, 'no mutant is caught by another mutant\'s leftovers');
  assert.ok(r.total >= 2);
  // Save, then replay after a test that kills some of them.
  writeRules(dir, { requirements: [{ id: 'math', glob: 'src/**', obligation: { kind: 'test', run: 'node test/math.check.mjs' } }] });
  git(dir, 'add', '-A');
  const again = await runMutantEval(pocp, { replay: r.mutants, jobs: 2 });
  assert.equal(again.replayed, true);
  assert.equal(again.total, r.total, 'the same sample');
  assert.deepEqual(again.mutants.map((m) => [m.file, m.line_text, m.mutated_line]), r.mutants.map((m) => [m.file, m.line_text, m.mutated_line]));
  assert.ok(again.caught >= 2, 'the real test catches them now');
  // A mutant whose line is gone is reported, not scored.
  write(dir, 'src/math.js', 'export function add(a, b) { return a + b; }\nexport function isPositive(n) { return n > 0; }\n');
  git(dir, 'add', '-A');
  const later = await runMutantEval(pocp, { replay: r.mutants, jobs: 2 });
  assert.equal(later.gone, r.total);
  assert.equal(later.total, 0);
});

// ---------------------------------------------------------------- configurable blocking

test('verify.fail_on: a repo chooses which findings fail; the rest are warnings', async () => {
  const dir = sampleRepo();
  writeConfig(dir, { verify: { fail_on: ['missing_packet', 'failed_proof', 'uncovered'] } });
  git(dir, 'add', '-A');
  commitNoHooks(dir, 'advisory for unproven');
  const pocp = createPocp({ cwd: dir });
  write(dir, 'src/math.js', TWEAK_ADD);
  git(dir, 'add', 'src/math.js');
  const { packet } = await pocp.open({ intent: 'x', touches: ['src/math.js'] });
  // Commit with a trailer but no proof: "unproven" is advisory in this repo.
  const p = pocp.loadPacket(packet.id);
  git(dir, 'add', '-A');
  const subject = (await import('../src/git.js')).subjectHashIndex(dir);
  commitNoHooks(dir, `x\n\nProof-Of-Change: ${packet.id} subject=${subject.slice(0, 19)} policy=${p.policy.slice(0, 19)} proven=0/1 attested=0/0`);
  const v = await pocp.verify('HEAD');
  assert.equal(v.ok, true, 'advisory findings do not fail');
  assert.match(v.packets[0].warnings.join(' '), /no proof for o1/);
  assert.ok(v.findings.some((f) => f.code === 'unproven' && !f.blocking));
});

test('narrowing verify.fail_on is a policy loosening and needs approval', async () => {
  const dir = sampleRepo();
  const pocp = createPocp({ cwd: dir });
  writeConfig(dir, { verify: { fail_on: ['missing_packet'] } });
  git(dir, 'add', '-A');
  commitNoHooks(dir, 'make almost everything advisory');
  const v = await pocp.verify('HEAD');
  assert.equal(v.ok, false);
  assert.match(v.notes.join(' '), /verify\.fail_on no longer includes "unproven"/);
  assert.ok(v.policy.fail_on.includes('unproven'), 'until accepted, the stricter base setting applies');
  assert.equal((await pocp.verify('HEAD', { acceptPolicyChange: true })).ok, true);
  writeConfig(dir, { verify: { fail_on: [] }, guard: { tests: 'off' } });
  git(dir, 'add', '-A');
  commitNoHooks(dir, 'turn off everything');
  const off = await pocp.verify('HEAD');
  assert.match(off.warnings.join(' '), /guard\.tests lowered from "block" to "off"/, 'the base already made loosening advisory, so this is only a warning');
});

test('an invalid policy fails even when nothing is configured to fail', async () => {
  const dir = sampleRepo();
  const pocp = createPocp({ cwd: dir });
  writeConfig(dir, { verify: { fail_on: [] } });
  git(dir, 'add', '-A');
  commitNoHooks(dir, 'advisory');
  write(dir, '.proof/rules.json', '{nope');
  git(dir, 'add', '-A');
  commitNoHooks(dir, 'broken');
  const v = await pocp.verify('HEAD', { acceptPolicyChange: true });
  assert.equal(v.ok, false);
  assert.ok(v.findings.some((f) => f.code === 'invalid_policy' && f.blocking));
});

test('CI definitions are protected: changes need a packet locally and approval in CI', async () => {
  const dir = sampleRepo();
  const pocp = createPocp({ cwd: dir });
  write(dir, '.github/workflows/ci.yml', 'on: push\n');
  git(dir, 'add', '-A');
  const g = await pocp.gate();
  assert.equal(g.decision, 'blocked');
  assert.ok(g.reasons.some((r) => r.code === 'ci_config'));
  commitNoHooks(dir, 'ci');
  const v = await pocp.verify('HEAD', { requireCoverage: true });
  assert.equal(v.ok, false);
  assert.ok(v.findings.some((f) => f.code === 'ci_config_changed'));
  assert.ok(v.coverage.uncovered.includes('.github/workflows/ci.yml'));
  writeConfig(dir, { ci: { files: [] } });
  git(dir, 'add', '-A');
  commitNoHooks(dir, 'stop protecting CI files');
  const w = await pocp.verify('HEAD');
  assert.match(w.notes.join(' '), /ci\.files no longer protects "\.github\/workflows\/\*\*"/);
});

test('verify.require_ci: required CI results must pass on this exact code (head of a range only)', async () => {
  const dir = sampleRepo();
  writeConfig(dir, { verify: { require_ci: ['node test/math.check.mjs'] } });
  git(dir, 'add', '-A');
  commitNoHooks(dir, 'require ci');
  const base = git(dir, 'rev-parse', 'HEAD');
  write(dir, 'README.md', 'a\n');
  git(dir, 'add', '-A');
  commitNoHooks(dir, 'one');
  write(dir, 'README.md', 'b\n');
  git(dir, 'add', '-A');
  commitNoHooks(dir, 'two');
  const pocp = createPocp({ cwd: dir });
  const none = await pocp.verifyRange(`${base}..HEAD`, { ciResults: [] });
  assert.equal(none.ok, false);
  assert.match(none.commits[1].notes.join(' '), /has no result for this code/);
  assert.equal(none.commits[0].ok, true, 'earlier commits are not expected to have CI results');
  const passed = await pocp.ciRun('node test/math.check.mjs');
  assert.equal((await pocp.verifyRange(`${base}..HEAD`, { ciResults: [passed] })).ok, true);
  const failed = { ...passed, passed: false, exit: 1 };
  const f = await pocp.verify('HEAD', { ciResults: [failed] });
  assert.match(f.notes.join(' '), /failed on this code/);
  const stale = { ...passed, subject: `sha256:${'0'.repeat(64)}` };
  assert.match((await pocp.verify('HEAD', { ciResults: [stale] })).notes.join(' '), /has no result for this code/);
  const omitted = await pocp.verify('HEAD');
  assert.equal(omitted.ok, false, 'fails closed when the caller supplies no CI results at all');
  assert.match(omitted.notes.join(' '), /no CI results were supplied/);
  const omittedRange = await pocp.verifyRange(`${base}..HEAD`);
  assert.equal(omittedRange.ok, false);
  assert.equal(omittedRange.commits[0].ok, true, 'still only the head of a range needs CI results');
});

test('config validation rejects unknown finding codes', async () => {
  const { validateConfig, withDefaults: wd } = await import('../src/store.js');
  assert.ok(validateConfig(wd({ verify: { fail_on: ['unproven', 'typo'] } })).some((p) => p.includes('unknown finding "typo"')));
  assert.ok(validateConfig(wd({ ci: { require_pull_request: 'yes' } })).some((p) => p.includes('ci.require_pull_request')));
});

test('dropping a required merge check is flagged by verify until approved', async () => {
  const dir = sampleRepo();
  writeConfig(dir, { ci: { branch: 'main', required_checks: ['verify', 'tests'] } });
  git(dir, 'add', '-A');
  commitNoHooks(dir, 'require checks');
  writeConfig(dir, { ci: { branch: 'main', required_checks: ['tests'], require_pull_request: false } });
  git(dir, 'add', '-A');
  commitNoHooks(dir, 'drop verify and PRs');
  const pocp = createPocp({ cwd: dir });
  const v = await pocp.verify('HEAD');
  assert.equal(v.ok, false);
  assert.match(v.notes.join(' '), /ci\.required_checks no longer requires "verify"/);
  assert.match(v.notes.join(' '), /ci\.require_pull_request turned off/);
  assert.deepEqual(v.effectiveConfig.ci.required_checks, ['verify', 'tests'], 'until approved, the base list stays in force');
  assert.equal((await pocp.verify('HEAD', { acceptPolicyChange: true })).ok, true);
});

test('landed state is derived from git: clean checkouts, fresh clones agree, amends and resets follow', async () => {
  const dir = sampleRepo();
  const pocp = createPocp({ cwd: dir });
  write(dir, 'src/math.js', TWEAK_ADD);
  git(dir, 'add', 'src/math.js');
  const { packet } = await pocp.open({ intent: 'x', touches: ['src/math.js'] });
  await pocp.prove({ ids: [packet.id] });
  const [line] = await pocp.trailers();
  commitNoHooks(dir, `x\n\nProof-Of-Change: ${line}`);
  assert.equal(git(dir, 'status', '--porcelain'), '');
  assert.equal(pocp.loadPacket(packet.id).state, 'landed');
  assert.equal(pocp.allPackets().find((p) => p.id === packet.id).landed.commit, git(dir, 'rev-parse', 'HEAD'));
  // A fresh clone sees the same thing without any local bookkeeping.
  const clone = `${dir}-clone`;
  git(dir, 'clone', '-q', dir, clone);
  assert.equal(createPocp({ cwd: clone }).loadPacket(packet.id).state, 'landed');
  // Undo the commit: the packet is active again.
  git(dir, 'reset', '-q', '--soft', 'HEAD~1');
  const after = createPocp({ cwd: dir });
  assert.equal(after.loadPacket(packet.id).state, 'proven');
  assert.ok(after.activePackets().some((p) => p.id === packet.id));
});
