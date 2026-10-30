// Focused, fast tests for boundaries and error paths in the pure modules.
// Written to kill mutants that the end-to-end suite lets survive.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import './helpers.js';
import { canonicalJson, digest, digestJson, digestMatches, randomId, sha256Hex, shortDigest } from '../src/hash.js';
import { globToRegExp, isGlob, matchAny, matchGlob } from '../src/glob.js';
import { describeObligation, isRunnable, normalizeObligation, obligationDigest } from '../src/obligations.js';
import { evaluateTriggers, normalizeRequirement, policyDigest, requirementsFor, strictUnion, validateRules } from '../src/rules.js';
import { DEFAULT_COUNT_EXEMPT, createFsStore, rulesWithDefaults, withDefaults, withLock, withLockAsync } from '../src/store.js';
import * as P from '../src/packets.js';
import { formatTrailer, parseTrailers, parseTrailerValue } from '../src/trailer.js';
import { computeMetrics } from '../src/metrics.js';
import { OPERATORS, applySite, mutationSites, prng } from '../src/mutants.js';
import { FIX_PATTERN } from '../src/history.js';
import { weakeningSignals } from '../src/guard.js';
import { signProof, signedPayload, verifyProofSignature } from '../src/sign.js';
import { buildEnv, createProcessRunner } from '../src/runner.js';
import { parseArgs } from '../src/cli.js';

const NOW = '2026-10-26T12:00:00.000Z';
const cfg = withDefaults({});
const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pocp-unit-')));

// ---------------------------------------------------------------- hash

test('hash: digests, short forms and matching rules', () => {
  assert.equal(sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(digest('abc'), 'sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(shortDigest('sha256:ba7816bf8f01cfea414140de'), 'sha256:ba7816bf8f01');
  assert.equal(shortDigest(null), null);
  assert.equal(shortDigest('nocolon'), 'nocolon');
  const d = digest('abc');
  assert.ok(digestMatches(d, 'sha256:ba7816bf8f01'));
  assert.ok(digestMatches(d, d));
  assert.ok(!digestMatches(d, 'md5:ba7816bf8f01'), 'algorithm must match');
  assert.ok(!digestMatches(d, 'sha256:ba7816bf8f0'), '11 hex chars is too short');
  assert.ok(!digestMatches(null, d));
  assert.ok(!digestMatches(d, ''));
  assert.ok(!digestMatches(d, 'sha256'));
  assert.equal(canonicalJson({ a: undefined, b: null, c: [] }), '{"b":null,"c":[]}');
  assert.equal(canonicalJson('x'), '"x"');
  assert.notEqual(digestJson({ a: 1 }), digestJson({ a: 2 }));
  assert.match(randomId('p'), /^p-[0-9a-f]{8}$/);
  assert.notEqual(randomId('p'), randomId('p'));
});

// ---------------------------------------------------------------- glob

test('glob: segments, double star, question mark, literals', () => {
  assert.ok(matchGlob('a/b/c.js', '**/c.js'));
  assert.ok(matchGlob('c.js', '**/c.js'), '**/ matches zero folders');
  assert.ok(matchGlob('a/b/c.js', 'a/**'));
  assert.ok(!matchGlob('ab/c.js', 'a/**'));
  assert.ok(matchGlob('a.js', '?.js'));
  assert.ok(!matchGlob('ab.js', '?.js'));
  assert.ok(!matchGlob('a/b.js', '?/b.js') === false);
  assert.ok(!matchGlob('x/y.js', '?.js'));
  assert.ok(matchGlob('a+b(c).js', 'a+b(c).js'), 'regex characters are literal');
  assert.ok(matchGlob('a+b(c).js', 'a+b(c)*'), 'and literal inside a glob too');
  assert.ok(!matchGlob('aab(c).js', 'a+b(c)*'));
  assert.ok(matchGlob('x/a$b.js', 'x/a$b.*'));
  assert.ok(matchGlob('lib/deep/x', 'lib/'));
  assert.ok(!matchGlob('libx', 'lib/'));
  assert.ok(!matchGlob('', 'a'));
  assert.ok(!matchGlob('a', ''));
  assert.ok(isGlob('a*') && isGlob('a?') && isGlob('a/') && !isGlob('a.js'));
  assert.ok(matchAny('a.md', ['x', '*.md']));
  assert.ok(!matchAny('a.md', []));
  assert.ok(!matchAny('a.md'));
  assert.equal(globToRegExp('src/*.js'), globToRegExp('src/*.js'), 'compiled patterns are cached');
});

// ---------------------------------------------------------------- obligations

test('obligations: every validation error and field', () => {
  assert.throws(() => normalizeObligation(null), /must be an object/);
  assert.throws(() => normalizeObligation('x'), /must be an object/);
  assert.throws(() => normalizeObligation({ kind: 'test', run: '   ' }), /run/);
  assert.throws(() => normalizeObligation({ kind: 'command', run: 'x', expect: 5 }), /regex string/);
  assert.throws(() => normalizeObligation({ kind: 'test', run: 'x', inputs: 'a' }), /inputs/);
  assert.throws(() => normalizeObligation({ kind: 'test', run: 'x', inputs: [1] }), /inputs/);
  assert.throws(() => normalizeObligation({ kind: 'test', run: 'x', timeout_ms: 0 }), /timeout_ms/);
  assert.throws(() => normalizeObligation({ kind: 'test', run: 'x', timeout_ms: 1.5 }), /timeout_ms/);
  assert.throws(() => normalizeObligation({ kind: 'test', run: 'x', target: 'u' }), /only allowed on probe/);
  assert.throws(() => normalizeObligation({ kind: 'manual', text: '  ' }), /text/);
  const probe = normalizeObligation({ kind: 'probe', run: ' curl x ', target: 'http://x' });
  assert.deepEqual(probe, { id: undefined, kind: 'probe', run: 'curl x', target: 'http://x', source: 'author' });
  const cmd = normalizeObligation({ kind: 'command', run: 'x', expect: 'ok', timeout_ms: 1 }, { id: 'o9', source: 'rule:r' });
  assert.deepEqual(cmd, { id: 'o9', kind: 'command', run: 'x', expect: 'ok', timeout_ms: 1, source: 'rule:r' });
  assert.equal(normalizeObligation({ kind: 'command', run: 'x', expect: null }).expect, undefined);
  const man = normalizeObligation({ kind: 'manual', text: ' look ' });
  assert.equal(man.text, 'look');
  assert.ok(isRunnable({ kind: 'probe' }) && !isRunnable({ kind: 'manual' }) && !isRunnable(null));
  assert.equal(describeObligation(cmd), 'command: x');
  assert.equal(describeObligation(man), 'manual: look');
  assert.notEqual(obligationDigest(man), obligationDigest({ kind: 'manual', text: 'other' }));
  assert.notEqual(obligationDigest(cmd), obligationDigest({ ...cmd, expect: 'other' }));
  assert.notEqual(obligationDigest({ kind: 'test', run: 'a', inputs: ['x'] }), obligationDigest({ kind: 'test', run: 'a' }));
  assert.notEqual(obligationDigest({ kind: 'test', run: 'a' }), obligationDigest({ kind: 'command', run: 'a' }));
});

// ---------------------------------------------------------------- rules

test('rules: validation of each field', () => {
  assert.deepEqual(validateRules({}), []);
  assert.ok(validateRules({ triggers: { broad_files: 2.5 } }).some((p) => p.includes('broad_files')));
  assert.ok(validateRules({ triggers: { cross_area: { areas: 0, min_files: 2 } } }).some((p) => p.includes('cross_area')));
  assert.ok(validateRules({ triggers: { cross_area: { areas: 2, min_files: 0 } } }).some((p) => p.includes('cross_area')));
  assert.deepEqual(validateRules({ triggers: { cross_area: null } }), []);
  assert.ok(validateRules({ triggers: { globs: [{ glob: 'a' }] } }).some((p) => p.includes('require_packet')));
  assert.ok(validateRules({ requirements: [null] }).some((p) => p.includes('must be an object')));
  assert.ok(validateRules({ requirements: [{ glob: 'a', obligation: { kind: 'test', run: 'x' } }] }).some((p) => p.includes('needs an "id"')));
  assert.deepEqual(validateRules({ requirements: [{ id: 'a', globs: ['x', 'y'], obligation: { kind: 'test', run: 't' } }] }), []);
  assert.throws(() => normalizeRequirement(null), /must be an object/);
  assert.throws(() => normalizeRequirement({ glob: 'a' }), /needs an "id"/);
  assert.throws(() => normalizeRequirement({ id: 'a' }), /needs a "glob"/);
  const r = normalizeRequirement({ id: 'g', globs: ['a', 'b'], obligation: { kind: 'test', run: 't' }, source: 'guard' });
  assert.equal(r.obligation.source, 'guard:tests');
  assert.deepEqual(r.globs, ['a', 'b']);
  assert.equal(normalizeRequirement({ id: 'x', glob: 'a', obligation: { kind: 'test', run: 't' } }).source, 'author');
});

test('triggers: exact thresholds and area grouping', () => {
  const rules = rulesWithDefaults({ triggers: { broad_files: 3, cross_area: { areas: 2, min_files: 2 }, globs: [] }, count_exempt: [] });
  const t2 = evaluateTriggers(['a/1.js', 'a/2.js'], { rules, config: cfg });
  assert.deepEqual(t2.required_files, [], '2 files in 1 area: below both thresholds');
  const t3 = evaluateTriggers(['a/1.js', 'a/2.js', 'a/3.js'], { rules, config: cfg });
  assert.equal(t3.reasons[0].code, 'broad', 'exactly the threshold counts');
  const ca = evaluateTriggers(['a/1.js', 'b/2.js'], { rules, config: cfg });
  assert.equal(ca.reasons[0].code, 'cross_area', 'exactly 2 areas and 2 files');
  assert.deepEqual(ca.reasons[0].areas, ['a', 'b']);
  const one = evaluateTriggers(['a/1.js', 'b/2.js'], { rules: rulesWithDefaults({ triggers: { broad_files: 9, cross_area: { areas: 2, min_files: 3 } }, count_exempt: [] }), config: cfg });
  assert.deepEqual(one.required_files, [], 'enough areas but too few files');
  const root = evaluateTriggers(['x.js', 'y.js'], { rules, config: cfg });
  assert.deepEqual(root.reasons, [], 'root files share one area');
  const deep = evaluateTriggers(['src/a/1.js', 'src/b/2.js'], { rules, config: withDefaults({ area_depth: 1 }) });
  assert.deepEqual(deep.reasons, [], 'area depth 1 groups both under src');
  const deep2 = evaluateTriggers(['src/a/1.js', 'src/b/2.js'], { rules, config: cfg });
  assert.equal(deep2.reasons[0].code, 'cross_area');
  assert.deepEqual(evaluateTriggers(['a.md', 'b.md', 'c.md'], { rules: rulesWithDefaults({ triggers: { broad_files: 3 } }), config: cfg }).required_files, [], 'default count exemptions');
  assert.ok(DEFAULT_COUNT_EXEMPT.includes('test/**'));
  const hostArr = evaluateTriggers(['lib/x.js'], { rules, config: cfg, hostTriggers: [{ glob: 'lib/**', id: 'h' }], hostName: 'acme' });
  assert.deepEqual(hostArr.file_reasons['lib/x.js'], ['acme:h']);
  const noBroad = evaluateTriggers(['a/1.js', 'a/2.js', 'a/3.js', 'a/4.js'], { rules: rulesWithDefaults({ triggers: { broad_files: undefined, cross_area: null } }), config: cfg });
  assert.equal(noBroad.reasons.length, 0);
});

test('requirements: host ids are namespaced once; applies only to matching touches', () => {
  const rules = rulesWithDefaults({ requirements: [{ id: 'unit', glob: 'src/**', obligation: { kind: 'test', run: 'a' } }] });
  const r = requirementsFor(['docs/x.md'], { rules, hostRequirements: [{ id: 'acme:x', glob: 'docs/**', obligation: { kind: 'test', run: 'b' } }], hostName: 'acme' });
  assert.deepEqual(r.merged.map((x) => x.id), ['acme:x']);
  assert.deepEqual(r.repoOnly, []);
  assert.notEqual(policyDigest([]), policyDigest(r.merged));
});

test('strict union: thresholds, cross-area, count exemptions, id clashes', () => {
  const base = rulesWithDefaults({ triggers: { broad_files: 8, cross_area: { areas: 3, min_files: 9 } }, count_exempt: ['a/**', 'b/**'], requirements: [{ id: 'r', glob: 's/**', obligation: { kind: 'test', run: 'old' } }] });
  const head = rulesWithDefaults({ triggers: { broad_files: 12, cross_area: { areas: 5, min_files: 4 } }, count_exempt: ['b/**', 'c/**'], requirements: [{ id: 'r', glob: 's/**', obligation: { kind: 'test', run: 'new' } }] });
  const u = strictUnion(base, head);
  assert.equal(u.triggers.broad_files, 8);
  assert.deepEqual(u.triggers.cross_area, { areas: 3, min_files: 4 });
  assert.deepEqual(u.count_exempt, ['b/**']);
  assert.deepEqual(u.requirements.map((r) => r.id), ['r', 'r@base']);
  assert.equal(strictUnion(null, head), head);
});

// ---------------------------------------------------------------- store

test('store: defaults merge deeply and arrays replace', () => {
  const c = withDefaults({ run: { timeout_ms: 5 }, snapshot: { link: [] } });
  assert.equal(c.run.timeout_ms, 5);
  assert.equal(c.run.mode, 'clean', 'sibling keys survive');
  assert.deepEqual(c.snapshot.link, []);
  assert.equal(withDefaults(null).packet_ttl_days, 14);
  const r = rulesWithDefaults({ triggers: { globs: 'nope' }, requirements: 'nope', count_exempt: 'nope' });
  assert.deepEqual(r.triggers.globs, []);
  assert.deepEqual(r.requirements, []);
  assert.deepEqual(r.count_exempt, [...DEFAULT_COUNT_EXEMPT]);
  assert.equal(r.triggers.broad_files, 10);
});

test('store: files, invalid JSON, logs', () => {
  const root = tmp();
  const st = createFsStore(root);
  assert.equal(st.exists(), false);
  assert.equal(st.readPacket('p-x'), null);
  assert.deepEqual(st.readPackets(), []);
  assert.equal(st.readRawRules(), null);
  st.writePacket({ id: 'p-b', n: 2 });
  st.writePacket({ id: 'p-a', n: 1 });
  assert.deepEqual(st.readPackets().map((p) => p.id), ['p-a', 'p-b'], 'sorted by file name');
  assert.equal(st.packetRelPath('p-a'), '.proof/packets/p-a.json');
  fs.writeFileSync(path.join(root, '.proof/rules.json'), '{bad');
  assert.throws(() => st.readRules(), /invalid JSON/);
  st.appendLog('gate', { a: 1 });
  fs.appendFileSync(path.join(root, '.proof/runs/gate.jsonl'), 'not json\n');
  st.appendLog('gate', { a: 2 });
  assert.deepEqual(st.readLog('gate'), [{ a: 1 }, { a: 2 }], 'bad lines are skipped');
  assert.deepEqual(st.readLog('none'), []);
  st.writeMiss({ id: 'm-1' });
  assert.equal(st.readMiss('m-1').id, 'm-1');
  assert.equal(st.readMiss('m-2'), null);
});

test('locks: exclusive, broken when the holder is dead, released after use', async () => {
  const dir = tmp();
  const lock = path.join(dir, 'x.lock');
  assert.equal(withLock(lock, () => 42), 42);
  assert.ok(!fs.existsSync(lock), 'released');
  fs.writeFileSync(lock, String(process.pid));
  assert.throws(() => withLock(lock, () => 1, { waitMs: 100 }), /holds/);
  fs.writeFileSync(lock, '999999999');
  assert.equal(withLock(lock, () => 'took over'), 'took over', 'dead holder');
  const order = [];
  await Promise.all([
    withLockAsync(lock, async () => { order.push('a1'); await new Promise((r) => setTimeout(r, 150)); order.push('a2'); }),
    new Promise((r) => setTimeout(r, 20)).then(() => withLockAsync(lock, async () => { order.push('b'); })),
  ]);
  assert.deepEqual(order, ['a1', 'a2', 'b']);
  assert.throws(() => withLock(lock, () => { throw new Error('boom'); }), /boom/);
  assert.ok(!fs.existsSync(lock), 'released after an error');
});

// ---------------------------------------------------------------- packets

test('packets: lifecycle details', () => {
  assert.throws(() => P.createPacket({ intent: '', touches: ['a'], now: NOW }), /intent/);
  assert.throws(() => P.createPacket({ intent: 'x'.repeat(501), touches: ['a'], now: NOW }), /500/);
  assert.equal(P.createPacket({ intent: 'x'.repeat(500), touches: ['a'], now: NOW }).intent.length, 500);
  assert.throws(() => P.createPacket({ intent: 'x', touches: [''], now: NOW }), /non-empty/);
  const p = P.createPacket({ intent: ' x ', touches: ['./b', 'a', 'a'], now: NOW, draft: true, by: 'me' });
  assert.equal(p.intent, 'x');
  assert.deepEqual(p.touches, ['a', 'b']);
  assert.equal(p.state, 'draft');
  assert.equal(p.history[0].by, 'me');
  assert.equal(P.applyEvaluation(p, { failed: [], ok: true }, { now: NOW }), 'draft', 'drafts are not promoted');
  assert.ok(P.isActive(p));
  assert.deepEqual(P.widenTouches(p, ['c', 'a'], { now: NOW }), ['c']);
  assert.deepEqual(P.widenTouches(p, ['a'], { now: NOW }), []);
  assert.ok(P.covers(p, 'c') && !P.covers(p, 'd'));
  const g = P.createPacket({ intent: 'g', touches: ['src/**'], now: NOW });
  assert.ok(P.covers(g, 'src/x/y.js'));
  const o1 = P.addObligation(g, { kind: 'test', run: 'a' }, { now: NOW });
  const o2 = P.addObligation(g, { kind: 'test', run: 'b' }, { now: NOW });
  assert.deepEqual([o1.id, o2.id], ['o1', 'o2']);
  g.obligations.push({ id: 'custom', kind: 'test', run: 'c' });
  assert.equal(P.addObligation(g, { kind: 'test', run: 'd' }, { now: NOW }).id, 'o3');
  P.markLanded(g, { commit: 'abc', now: NOW });
  assert.equal(g.state, 'landed');
  assert.deepEqual(g.landed, { commit: 'abc', at: NOW });
  assert.ok(!P.isActive(g));
  assert.throws(() => P.abandon(g, { reason: 'x', now: NOW }), /only active/);
  assert.ok(!P.expireIfStale(g, { now: '2030-01-01T00:00:00.000Z', ttlDays: 1 }), 'terminal packets do not expire');
  const fresh = P.createPacket({ intent: 'f', touches: ['a'], now: NOW });
  assert.ok(!P.expireIfStale(fresh, { now: NOW, ttlDays: 1 }));
  assert.ok(!P.expireIfStale(fresh, { now: '2030-01-01T00:00:00.000Z', ttlDays: 0 }), 'ttl 0 disables expiry');
  assert.ok(!P.expireIfStale(fresh, { now: '2026-10-27T11:59:00.000Z', ttlDays: 1 }), 'just under a day');
  assert.ok(P.expireIfStale(fresh, { now: '2026-10-27T12:01:00.000Z', ttlDays: 1 }), 'just over a day');
});

test('packets: evaluation counts and current proof selection', () => {
  const p = P.createPacket({ intent: 'x', touches: ['a'], obligations: [{ kind: 'test', run: 't' }, { kind: 'manual', text: 'm' }], now: NOW });
  const [t, m] = p.obligations;
  const d = obligationDigest(t);
  P.recordProof(p, { obligation: t.id, obligation_digest: d, subject: 's', passed: false }, { now: NOW });
  P.recordProof(p, { obligation: t.id, obligation_digest: d, subject: 's', passed: true }, { now: NOW });
  assert.equal(P.currentProof(p, t, 's').passed, true, 'latest wins');
  P.recordProof(p, { obligation: t.id, obligation_digest: d, subject: 's', passed: false }, { now: NOW });
  const ev = P.evaluatePacket(p, { subject: 's' });
  assert.deepEqual(ev.failed, [t.id]);
  assert.deepEqual(ev.counts, { runnable: 1, manual: 1, proven: 0, attested: 0 });
  P.recordAttestation(p, m.id, { by: 'me', subject: 's', now: NOW, note: 'n'.repeat(600) });
  assert.equal(p.attestations[0].note.length, 500);
  assert.throws(() => P.recordAttestation(p, 'o9', { by: 'me', subject: 's', now: NOW }), /no obligation/);
  assert.throws(() => P.recordAttestation(p, m.id, { subject: 's', now: NOW }), /"by"/);
  const ev2 = P.evaluatePacket(p, { subject: 's' });
  assert.equal(ev2.counts.attested, 1);
  assert.equal(P.applyEvaluation(p, ev2, { now: NOW }), 'failed');
  P.recordProof(p, { obligation: t.id, obligation_digest: d, subject: 's', passed: true }, { now: NOW });
  assert.equal(P.applyEvaluation(p, P.evaluatePacket(p, { subject: 's' }), { now: NOW }), 'proven');
  assert.equal(P.applyEvaluation(p, P.evaluatePacket(p, { subject: 'z' }), { now: NOW }), 'open');
  const empty = P.createPacket({ intent: 'e', touches: ['a'], now: NOW });
  const ee = P.evaluatePacket(empty, { subject: 's' });
  assert.equal(ee.ok, false);
  assert.equal(ee.no_obligations, true);
});

test('packets: syncing records the policy and stays quiet when nothing changes', () => {
  const p = P.createPacket({ intent: 'x', touches: ['src/a.js'], now: NOW });
  const req = requirementsFor(['src/a.js'], { rules: rulesWithDefaults({ requirements: [{ id: 'u', glob: 'src/**', obligation: { kind: 'test', run: 't' } }] }) });
  P.syncRequirements(p, req, { now: NOW });
  const n = p.history.length;
  assert.equal(P.syncRequirements(p, req, { now: NOW }).length, 0);
  assert.equal(p.history.length, n, 'no history entry when nothing changed');
  assert.equal(p.policy, policyDigest(req.merged));
  assert.equal(p.policy_repo, policyDigest(req.repoOnly));
  const guard = normalizeRequirement({ id: 'guard:tests', globs: ['t'], source: 'guard', obligation: { kind: 'manual', text: 'g' } });
  const policyBefore = p.policy;
  P.syncRequirements(p, { ...req, guard: [guard] }, { now: NOW });
  assert.equal(p.obligations.at(-1).source, 'guard:tests');
  assert.equal(p.policy, policyBefore, 'guard requirements stay out of the policy digest');
});

// ---------------------------------------------------------------- trailers

test('trailers: parsing details', () => {
  assert.deepEqual(parseTrailerValue('p-1'), { id: 'p-1' });
  assert.deepEqual(parseTrailerValue('p-1 =x proven=3 attested=a/b'), { id: 'p-1', proven: '3', attested: 'a/b' });
  assert.deepEqual(parseTrailers(''), []);
  assert.deepEqual(parseTrailers(null), []);
  assert.equal(parseTrailers('subject\n\nproof-of-change: p-2 proven=1/2').length, 1, 'key is case-insensitive');
  assert.deepEqual(parseTrailers('only a subject Proof-Of-Change: p-3'), []);
  assert.equal(parseTrailers('Proof-Of-Change: p-4\n\n\n').length, 1, 'trailing blank lines are ignored');
  assert.equal(formatTrailer({ id: 'p', subject: 'sha256:aaaaaaaaaaaaaaaa', policy: 'sha256:bbbbbbbbbbbbbbbb', proven: 0, runnable: 1, attested: 2, manual: 3 }), 'p subject=sha256:aaaaaaaaaaaa policy=sha256:bbbbbbbbbbbb proven=0/1 attested=2/3');
});

// ---------------------------------------------------------------- metrics

test('metrics: empty input and null ratios', () => {
  const m = computeMetrics({});
  assert.equal(m.catch_rate, null);
  assert.equal(m.escape_rate_per_100, null);
  assert.equal(m.proven_share, null);
  assert.equal(m.friction, null);
  assert.equal(m.cost_ms_median, null);
  assert.equal(m.packets.total, 0);
});

test('metrics: friction is not counted when a proof failed in between or a file was uncovered', () => {
  const log = [
    { decision: 'blocked', subject: 'A', uncovered: 0, packets: [{ failed: 0 }] },
    { decision: 'blocked', subject: 'A', uncovered: 0, packets: [{ failed: 1 }] },
    { decision: 'pass', subject: 'A', packets: [] },
    { decision: 'blocked', subject: 'B', uncovered: 0, packets: [{ failed: 1 }] },
    { decision: 'pass', subject: 'B', packets: [] },
    { decision: 'blocked', subject: 'C', uncovered: 0, packets: [{ failed: 0 }] },
    { decision: 'pass', subject: 'D', packets: [] },
  ];
  const m = computeMetrics({ gateLog: log });
  assert.equal(m.gate.blocks, 4);
  assert.equal(m.gate.friction_blocks, 0, 'A: failure in between; B: itself failed; C: never passed');
  assert.equal(m.gate.evaluations, 7);
});

test('metrics: median of an odd and even count, misses by state', () => {
  const landed = (ms) => ({ state: 'landed', obligations: [{ id: 'o1', kind: 'test', run: 't' }], proofs: [{ obligation: 'o1', obligation_digest: obligationDigest({ kind: 'test', run: 't' }), passed: true, duration_ms: ms }], history: [] });
  assert.equal(computeMetrics({ packets: [landed(10), landed(30), landed(20)] }).cost_ms_median, 20);
  assert.equal(computeMetrics({ packets: [landed(10), landed(30)] }).cost_ms_median, 20);
  const m = computeMetrics({ packets: [landed(1)], misses: [{ stage: 'ci', state: 'closed', closed: 'rule-added' }, { stage: 'review', state: 'open' }] });
  assert.equal(m.escaped, 2);
  assert.equal(m.catch_rate, 0);
  assert.equal(m.escape_rate_per_100, 200);
  assert.equal(m.ratchet.misses_closed_rule_added, 1);
  assert.equal(m.ratchet.misses_open, 1);
});

// ---------------------------------------------------------------- mutants, history, guard

test('mutation operators each produce their replacement', () => {
  const cases = { 'strict-eq': 'a === b', 'strict-neq': 'a !== b', eq: 'a == b', neq: 'a != b', lt: 'a < b', gt: 'a > b', lte: 'a <= b', gte: 'a >= b', and: 'a && b', or: 'a || b', true: 'x = true', false: 'x = false', plus: 'a + b', minus: 'a - b', times: 'a * b', 'zero-one': 'x = 0' };
  for (const [op, text] of Object.entries(cases)) {
    const site = mutationSites(text).find((s) => s.op === op);
    assert.ok(site, `no ${op} site in "${text}"`);
    assert.notEqual(applySite(text, site), text);
  }
  assert.equal(OPERATORS.length, Object.keys(cases).length);
  assert.equal(mutationSites('x += 1').filter((s) => s.op === 'plus').length, 0, '+= is left alone');
  assert.equal(mutationSites('# a === b\n/* x */\n * y === z').length, 0, 'comment lines are skipped');
  const r = prng(1);
  const vals = Array.from({ length: 50 }, r);
  assert.ok(vals.every((v) => v >= 0 && v < 1));
  assert.notEqual(prng(1)(), prng(2)());
});

test('fix pattern recognises fix commits only', () => {
  for (const s of ['Fix login', 'fixes #12', 'fixed it', 'bug in parser', 'regression in X', 'hotfix', 'Broke build', 'crash on start']) assert.ok(FIX_PATTERN.test(s), s);
  for (const s of ['Add feature', 'prefix handling', 'refactor', 'Debugger UI']) assert.ok(!FIX_PATTERN.test(s), s);
});

test('weakening signals: patterns', () => {
  const removed = ['-  t.is(a, 1)', '-  should.exist(x)', '-  self.assertEqual(a, b)', '-  expect(x).toThrow()', '-  assert(x)'];
  assert.equal(weakeningSignals(removed.join('\n')).removed_asserts, 5);
  const skips = ['+  describe.only("x")', '+  xit("y")', '+  test.todo("z")', '+@pytest.mark.skip', '+  t.skip()', "+  it('a', { skip: true })"];
  assert.equal(weakeningSignals(skips.join('\n')).added_skips, 6);
  assert.deepEqual(weakeningSignals('+  assert.equal(1, 1)\n-  it.skip("x")\n--- a/x\n+++ b/x'), { removed_asserts: 0, added_skips: 0 }, 'added asserts and removed skips are fine');
});

// ---------------------------------------------------------------- signing

test('signing: round trip, tamper, wrong principal, no allowed signers', { skip: spawnSync('ssh-keygen', ['-?']).error ? 'no ssh-keygen' : false }, () => {
  const dir = tmp();
  const key = path.join(dir, 'k');
  spawnSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', key]);
  const pub = fs.readFileSync(`${key}.pub`, 'utf8').trim();
  const allowed = `me@x namespaces="pocp-proof" ${pub}\n`;
  const proof = { obligation: 'o1', subject: 's', passed: true };
  proof.signature = signProof(proof, { key, principal: 'me@x' });
  assert.equal(signedPayload(proof), canonicalJson({ obligation: 'o1', subject: 's', passed: true }));
  assert.equal(verifyProofSignature(proof, allowed), 'valid');
  assert.equal(verifyProofSignature({ ...proof, passed: false }, allowed), 'invalid');
  assert.equal(verifyProofSignature({ ...proof, signature: { ...proof.signature, principal: 'other@x' } }, allowed), 'invalid');
  assert.equal(verifyProofSignature(proof, ''), 'untrusted');
  assert.equal(verifyProofSignature({ obligation: 'o1' }, allowed), 'unsigned');
  assert.throws(() => signProof(proof, { principal: 'me@x' }), /no signing key/);
  assert.throws(() => signProof(proof, { key, principal: '' }), /principal/);
  assert.throws(() => signProof(proof, { key: path.join(dir, 'missing'), principal: 'me@x' }), /not found/);
});

// ---------------------------------------------------------------- runner

test('runner: env modes, expect-able output capture, log cap', async () => {
  process.env.POCP_TEST_SECRET = 'shh';
  const minimal = buildEnv({ mode: 'minimal', allow: ['POCP_TEST_SECRET'], extra: { X: '1' } });
  assert.equal(minimal.POCP_TEST_SECRET, 'shh');
  assert.equal(minimal.X, '1');
  assert.equal(buildEnv({ mode: 'minimal' }).POCP_TEST_SECRET, undefined);
  assert.equal(buildEnv({}).POCP_TEST_SECRET, 'shh');
  delete process.env.POCP_TEST_SECRET;
  const dir = tmp();
  const runner = createProcessRunner();
  const log = path.join(dir, 'r.log');
  const r = await runner.run('printf "abcdefghij"; echo err >&2; exit 3', { cwd: dir, env: process.env, logFile: log, logCapBytes: 4 });
  assert.equal(r.exit, 3);
  assert.equal(r.truncated, true);
  assert.equal(r.output.length, 4);
  assert.match(fs.readFileSync(log, 'utf8'), /output truncated at 4 bytes/);
  const ok = await runner.run('echo hi', { cwd: dir, env: process.env });
  assert.equal(ok.exit, 0);
  assert.equal(ok.output, 'hi\n');
  assert.equal(ok.truncated, false);
  assert.equal(ok.timed_out, false);
});

// ---------------------------------------------------------------- cli args

test('cli args: separators, booleans, missing values', () => {
  assert.deepEqual(parseArgs(['a', '--', '--json', 'b']).positional, ['a', '--json', 'b']);
  assert.equal(parseArgs(['--json=false']).flags.json, false);
  assert.equal(parseArgs(['--json=true']).flags.json, true);
  assert.throws(() => parseArgs(['--intent']), /needs a value/);
  const { obligations } = parseArgs(['--probe', 'curl x', '--target', 'u', '--input', 'a', '--input', 'b']);
  assert.deepEqual(obligations, [{ kind: 'probe', run: 'curl x', target: 'u', inputs: ['a', 'b'] }]);
  assert.deepEqual(parseArgs(['--by=me', '--by', 'you']).flags.by, ['me', 'you']);
});

test('interrupted runs remove their temporary snapshots', async () => {
  const { spawn } = await import('node:child_process');
  const { tmpRepo, write: w, git: gg } = await import('./helpers.js');
  const dir = tmpRepo();
  w(dir, 'a.txt', 'x\n');
  gg(dir, 'add', '-A');
  const script = `import { createIndexSnapshot } from ${JSON.stringify(path.resolve('src/workspace.js'))};
const s = createIndexSnapshot(${JSON.stringify(dir)});
console.log(s.dir);
setInterval(() => {}, 1000);`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'inherit'] });
  const snapDir = await new Promise((resolve) => child.stdout.once('data', (d) => resolve(String(d).trim())));
  assert.ok(fs.existsSync(snapDir));
  child.kill('SIGTERM');
  await new Promise((r) => child.on('close', r));
  assert.ok(!fs.existsSync(snapDir), 'snapshot removed on SIGTERM');
});

// ---------------------------------------------------------------- tests written from surviving mutants

test('survivors: small exact behaviours', async () => {
  const { computeMetrics: cm } = await import('../src/metrics.js');
  assert.equal(cm({ rules: { requirements: [{ id: 'r', source: 'miss:m-1' }, { id: 's', source: 'author' }, { id: 't' }] } }).ratchet.rules_from_misses, 1);
  assert.ok(mutationSites('true || x').some((s) => s.op === 'true' && s.index === 0), 'a site at the very start of the text');
  assert.ok(validateRules({ triggers: { globs: [{ glob: 'a' }] } }).includes('triggers.globs[0] needs "require_packet": true|false'));
  const r = evaluateTriggers(['src/auth/a.js'], { rules: rulesWithDefaults({ triggers: { globs: [{ id: 'auth', glob: 'src/auth/**', require_packet: true }] } }), config: cfg });
  assert.deepEqual(r.file_reasons['src/auth/a.js'], ['glob:auth']);
  const r2 = evaluateTriggers(['src/auth/a.js'], { rules: rulesWithDefaults({ triggers: { globs: [{ glob: 'src/auth/**', require_packet: true }] } }), config: cfg });
  assert.deepEqual(r2.file_reasons['src/auth/a.js'], ['glob:src/auth/**']);
  assert.deepEqual(parseTrailerValue('p-1 x=1 ab=2'), { id: 'p-1', x: '1', ab: '2' });
  assert.equal(weakeningSignals('-  t.true(ok)').removed_asserts, 1);
  assert.equal(weakeningSignals('--- a/test/assert_helpers.js\n+++ b/test/assert_helpers.js\n+describe.only').added_skips, 1);
  assert.equal(weakeningSignals('--- a/test/assert_helpers.js\n+++ b/test/expect.js').removed_asserts, 0, 'diff headers are not removed lines');
  const { VERSION } = await import('../src/engine.js');
  assert.equal(VERSION, JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url))).version);
});

test('survivors: git helpers keep exact bytes and odd file names', async () => {
  const { tmpRepo, write: w, git: gg } = await import('./helpers.js');
  const g = await import('../src/git.js');
  const dir = tmpRepo();
  w(dir, 'trailing ', 'x\n');
  w(dir, 'f.txt', 'line\n\n');
  gg(dir, 'add', '-A');
  gg(dir, 'commit', '-q', '-m', 'odd names');
  assert.deepEqual(g.changedPaths(g.commitChanges(dir, 'HEAD')), ['f.txt', 'trailing ']);
  assert.equal(g.showFile(dir, 'HEAD', 'f.txt'), 'line\n\n', 'content is not trimmed');
  assert.equal(g.showFile(dir, 'HEAD', 'missing'), null);
});

test('survivors: runner reports a command that cannot start', async () => {
  const r = await createProcessRunner().run('true', { cwd: '/nonexistent/pocp/dir', env: process.env });
  assert.notEqual(r.exit, 0);
  assert.equal(r.truncated, false);
  assert.ok(r.error || r.exit !== 0);
});

test('survivors 4: policy digest order, guard text, snapshot links stay inside the repo', async () => {
  const reqs = ['c', 'a', 'b', 'e', 'd'].map((x, i) => ({ id: `r${i}`, digest: `sha256:${x}` }));
  const shuffled = [reqs[3], reqs[0], reqs[4], reqs[2], reqs[1]];
  assert.equal(policyDigest(reqs), policyDigest(shuffled));
  assert.equal(policyDigest(reqs), policyDigest([...reqs].reverse()));
  const { guardRequirement } = await import('../src/guard.js');
  const g = guardRequirement(['test/a.js', 'test/b.js']);
  assert.match(g.obligation.text, /\(test\/a\.js, test\/b\.js\)/);
  const many = guardRequirement(Array.from({ length: 10 }, (_, i) => `t${i}.js`));
  assert.match(many.obligation.text, /\(t0\.js, .*t7\.js and 2 more\)/);
  const { tmpRepo, write: w, git: gg } = await import('./helpers.js');
  const { createIndexSnapshot } = await import('../src/workspace.js');
  const dir = tmpRepo();
  w(dir, 'a.txt', 'x\n');
  gg(dir, 'add', '-A');
  fs.mkdirSync(path.join(dir, 'deps'));
  const outside = path.join(dir, '..', `${path.basename(dir)}-outside`);
  fs.mkdirSync(outside, { recursive: true });
  const snap = createIndexSnapshot(dir, { links: ['deps', `../${path.basename(outside)}`, outside] });
  try {
    assert.ok(fs.lstatSync(path.join(snap.dir, 'deps')).isSymbolicLink());
    assert.deepEqual(fs.readdirSync(snap.dir).sort(), ['a.txt', 'deps'], 'nothing else was linked into the snapshot');
    const escaped = path.join(snap.dir, '..', path.basename(outside));
    assert.ok(!fs.existsSync(escaped) || !fs.lstatSync(escaped).isSymbolicLink(), 'no link created outside the snapshot');
  } finally {
    snap.cleanup();
  }
});

test('survivors 5: log cap across several chunks; a spawn that throws', async () => {
  const dir = tmp();
  const r = await createProcessRunner().run("printf ab; sleep 0.1; printf cdef; sleep 0.1; printf gh", { cwd: dir, env: process.env, logCapBytes: 4 });
  assert.equal(r.output, 'abcd');
  assert.equal(r.truncated, true);
  const bad = await createProcessRunner().run('true', { cwd: 123, env: process.env });
  assert.ok(bad.error);
  assert.equal(bad.timed_out, false);
  assert.equal(bad.exit, null);
});

test('survivors 6: exact small behaviours', async () => {
  const { policyWeakening } = await import('../src/rules.js');
  const base = rulesWithDefaults({ triggers: { cross_area: { areas: 3, min_files: 4 } } });
  assert.ok(policyWeakening(base, rulesWithDefaults({ triggers: { cross_area: { areas: 5, min_files: 4 } } })).includes('cross_area loosened'));
  assert.ok(policyWeakening(base, rulesWithDefaults({ triggers: { cross_area: { areas: 3, min_files: 9 } } })).includes('cross_area loosened'));
  assert.equal(Math.round(prng(1)() * 1e6), Math.round(prng(1)() * 1e6));
  assert.equal(prng(1)().toFixed(6), '0.627074', 'the sample for a seed never changes between versions');
  const p = P.createPacket({ intent: 'x', touches: ['a'], now: NOW });
  P.abandon(p, { reason: 'Superseded by p-2', now: NOW });
  assert.equal(p.history.at(-1).reason, 'Superseded by p-2');
  const ob = { id: 'o1', kind: 'test', run: 't' };
  const d = obligationDigest(ob);
  const m = computeMetrics({ packets: [{ state: 'landed', obligations: [ob], proofs: [{ obligation: 'o1', obligation_digest: d, passed: true, duration_ms: 10 }, { obligation: 'o1', obligation_digest: d, passed: false, duration_ms: 500 }], history: [] }] });
  assert.equal(m.cost_ms_median, 10, 'cost counts the passing proof, not a later failure');
  const { tmpRepo, write: w, git: gg } = await import('./helpers.js');
  const g = await import('../src/git.js');
  const dir = tmpRepo();
  w(dir, 'x ', '1\n');
  gg(dir, 'add', '-A');
  gg(dir, 'commit', '-q', '-m', 'x');
  w(dir, 'x ', '2\n');
  assert.deepEqual(g.worktreeDiffs(dir), ['x ']);
  w(dir, 'vitest.config.js', 'export default {};\n');
  gg(dir, 'add', '-A');
  gg(dir, 'commit', '-q', '-m', 'cfg');
  gg(dir, 'mv', 'vitest.config.js', 'settings.js');
  const { detectTestChanges } = await import('../src/guard.js');
  assert.ok(detectTestChanges(dir, { config: {} }).files.includes('vitest.config.js'), 'renaming runner config away is guarded');
});

test('config validation covers every field', async () => {
  const { validateConfig } = await import('../src/store.js');
  assert.deepEqual(validateConfig(withDefaults({})), []);
  const bad = validateConfig(withDefaults({ packet_ttl_days: -1, area_depth: 0, proofs_kept_per_obligation: 0, run: { mode: 'x', env: 'y', timeout_ms: 0, kill_grace_ms: -1, log_cap_bytes: 1.5, env_allow: 'PATH', lockfile: 5 }, snapshot: { link: 'node_modules' }, sign: { key: 1, principal: 2 }, guard: { tests: 'z', test_globs: 'x', runner_globs: [1] }, eval: { exclude: 'x' } }));
  for (const f of ['packet_ttl_days', 'area_depth', 'proofs_kept', 'run.mode', 'run.env', 'run.timeout_ms', 'run.kill_grace_ms', 'run.log_cap_bytes', 'run.env_allow', 'run.lockfile', 'snapshot.link', 'sign.key', 'sign.principal', 'guard.tests', 'guard.test_globs', 'guard.runner_globs', 'eval.exclude']) {
    assert.ok(bad.some((p) => p.includes(f)), f);
  }
});

test('protocol test vectors: hashes stay stable across versions', async () => {
  const vectors = JSON.parse(fs.readFileSync(new URL('./vectors.json', import.meta.url), 'utf8'));
  const g = await import('../src/git.js');
  for (const v of vectors.obligation_digests) assert.equal(obligationDigest(v.obligation), v.digest, JSON.stringify(v.obligation));
  for (const v of vectors.policy_digests) assert.equal(policyDigest(v.requirements), v.digest);
  for (const v of vectors.subjects) assert.equal(g.subjectFromEntries(v.entries), v.subject);
  for (const v of vectors.canonical_json) assert.equal(canonicalJson(v.value), v.json);
});

test('test guard: other ecosystems by default, extra globs add to the defaults', async () => {
  const { tmpRepo, write: w, git: gg } = await import('./helpers.js');
  const { detectTestChanges } = await import('../src/guard.js');
  const dir = tmpRepo();
  for (const f of ['tox.ini', '.cargo/config.toml', 'phpunit.xml', 'Makefile', 'scripts/check.sh']) w(dir, f, 'x\n');
  gg(dir, 'add', '-A');
  gg(dir, 'commit', '-q', '-m', 'x');
  for (const f of ['tox.ini', '.cargo/config.toml', 'phpunit.xml', 'Makefile', 'scripts/check.sh']) w(dir, f, 'y\n');
  gg(dir, 'add', '-A');
  assert.deepEqual(detectTestChanges(dir, { config: {} }).files, ['.cargo/config.toml', 'phpunit.xml', 'tox.ini']);
  const more = detectTestChanges(dir, { config: { guard: { extra_runner_globs: ['Makefile', 'scripts/check.sh'] } } }).files;
  assert.deepEqual(more, ['.cargo/config.toml', 'Makefile', 'phpunit.xml', 'scripts/check.sh', 'tox.ini']);
  gg(dir, 'rm', '-qf', 'tox.ini');
  assert.ok(detectTestChanges(dir, { config: {} }).files.includes('tox.ini'), 'deleting a runner config is guarded too');
  const { validateConfig } = await import('../src/store.js');
  assert.ok(validateConfig(withDefaults({ guard: { extra_runner_globs: 'Makefile' } })).some((p) => p.includes('extra_runner_globs')));
});

test('config weakening covers required merge checks, pull requests, admins and the branch', async () => {
  const { configWeakening, strictConfig } = await import('../src/store.js');
  const base = withDefaults({ ci: { branch: 'main', required_checks: ['verify', 'tests'], require_pull_request: true, enforce_admins: true } });
  const dropCheck = withDefaults({ ci: { branch: 'main', required_checks: ['tests'], require_pull_request: true, enforce_admins: true } });
  assert.deepEqual(configWeakening(base, dropCheck), ['ci.required_checks no longer requires "verify"']);
  const noPr = withDefaults({ ci: { branch: 'main', required_checks: ['verify', 'tests'], require_pull_request: false, enforce_admins: true } });
  assert.deepEqual(configWeakening(base, noPr), ['ci.require_pull_request turned off']);
  const noAdmins = withDefaults({ ci: { branch: 'main', required_checks: ['verify', 'tests'], require_pull_request: true, enforce_admins: false } });
  assert.deepEqual(configWeakening(base, noAdmins), ['ci.enforce_admins turned off']);
  const otherBranch = withDefaults({ ci: { branch: 'dev', required_checks: ['verify', 'tests'], require_pull_request: true, enforce_admins: true } });
  assert.deepEqual(configWeakening(base, otherBranch), ['ci.branch changed from "main"']);
  const more = withDefaults({ ci: { branch: 'main', required_checks: ['verify', 'tests', 'lint'], require_pull_request: true, enforce_admins: true } });
  assert.deepEqual(configWeakening(base, more), [], 'adding a required check is not a loosening');

  const merged = strictConfig(base, withDefaults({ ci: { branch: 'dev', required_checks: ['lint'], require_pull_request: false, enforce_admins: false } }));
  assert.deepEqual(merged.ci.required_checks, ['verify', 'tests', 'lint']);
  assert.equal(merged.ci.require_pull_request, true);
  assert.equal(merged.ci.enforce_admins, true);
  assert.equal(merged.ci.branch, 'main');
});
