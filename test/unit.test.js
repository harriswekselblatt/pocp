import { test } from 'node:test';
import assert from 'node:assert/strict';
import './helpers.js';
import { canonicalJson, digestJson, digestMatches, shortDigest } from '../src/hash.js';
import { matchGlob } from '../src/glob.js';
import { normalizeObligation, obligationDigest, ValidationError } from '../src/obligations.js';
import { evaluateTriggers, policyDigest, requirementsFor, validateRules } from '../src/rules.js';
import { rulesWithDefaults, withDefaults } from '../src/store.js';
import * as P from '../src/packets.js';
import { formatTrailer, parseTrailers } from '../src/trailer.js';
import { computeMetrics } from '../src/metrics.js';
import { applySite, mutationSites, prng } from '../src/mutants.js';
import { parseArgs } from '../src/cli.js';

const NOW = '2026-10-26T12:00:00.000Z';
const cfg = withDefaults({});

test('canonical JSON sorts keys at every level', () => {
  assert.equal(canonicalJson({ b: 1, a: { d: 2, c: [3, { f: 1, e: 2 }] } }), '{"a":{"c":[3,{"e":2,"f":1}],"d":2},"b":1}');
  assert.equal(digestJson({ a: 1, b: 2 }), digestJson({ b: 2, a: 1 }));
});

test('short digests match their full form only', () => {
  const d = digestJson({ x: 1 });
  assert.ok(digestMatches(d, shortDigest(d)));
  assert.ok(!digestMatches(d, 'sha256:000000000000'));
  assert.ok(!digestMatches(d, 'sha256:abc'), 'too short to trust');
});

test('glob matching', () => {
  assert.ok(matchGlob('src/a/b.js', 'src/**'));
  assert.ok(matchGlob('src/b.js', 'src/**/*.js'));
  assert.ok(matchGlob('src/a/b.js', 'src/**/*.js'));
  assert.ok(!matchGlob('lib/b.js', 'src/**'));
  assert.ok(matchGlob('src/x.js', 'src/*.js'));
  assert.ok(!matchGlob('src/a/x.js', 'src/*.js'));
  assert.ok(matchGlob('docs/a/b.md', 'docs/'));
  assert.ok(matchGlob('exact.txt', 'exact.txt'));
  assert.ok(!matchGlob('exact.txtx', 'exact.txt'));
  assert.ok(matchGlob('a.b', 'a.b') && !matchGlob('axb', 'a.b'), 'dots are literal');
});

test('obligations: validation and digests', () => {
  assert.throws(() => normalizeObligation({ kind: 'nope' }), ValidationError);
  assert.throws(() => normalizeObligation({ kind: 'test' }), /run/);
  assert.throws(() => normalizeObligation({ kind: 'manual' }), /text/);
  assert.throws(() => normalizeObligation({ kind: 'test', run: 'x', expect: 'y' }), /only allowed on command/);
  assert.throws(() => normalizeObligation({ kind: 'command', run: 'x', expect: '(' }), /regex/);
  const a = normalizeObligation({ kind: 'test', run: 'npm test' });
  const b = normalizeObligation({ kind: 'test', run: 'npm test', source: 'rule:x' });
  assert.equal(obligationDigest(a), obligationDigest(b), 'source does not change what is checked');
  const c = normalizeObligation({ kind: 'test', run: 'npm test', timeout_ms: 5 });
  assert.notEqual(obligationDigest(a), obligationDigest(c));
  const i1 = normalizeObligation({ kind: 'test', run: 't', inputs: ['b', 'a', 'a'] });
  assert.deepEqual(i1.inputs, ['a', 'b']);
});

test('rules validation reports problems', () => {
  assert.deepEqual(validateRules(rulesWithDefaults({})), []);
  const bad = validateRules({ triggers: { broad_files: 0, globs: [{}] }, requirements: [{ id: 'a', glob: 'x', obligation: { kind: 'test' } }, { id: 'a', glob: 'y', obligation: { kind: 'manual', text: 'ok' } }] });
  assert.ok(bad.some((p) => p.includes('broad_files')));
  assert.ok(bad.some((p) => p.includes('needs a "glob"')));
  assert.ok(bad.some((p) => p.includes('run')));
  assert.ok(bad.some((p) => p.includes('duplicate id')));
});

test('triggers: protected globs, requirements, broad and cross-area changes', () => {
  const rules = rulesWithDefaults({
    triggers: { broad_files: 4, cross_area: { areas: 3, min_files: 3 }, globs: [{ glob: 'src/auth/**', require_packet: true }, { glob: 'docs/**', require_packet: false }] },
    requirements: [{ id: 'bill', glob: 'src/billing/**', obligation: { kind: 'test', run: 't' } }],
  });
  const r1 = evaluateTriggers(['src/auth/login.js', 'README.md'], { rules, config: cfg });
  assert.deepEqual(r1.required_files, ['src/auth/login.js']);
  const r2 = evaluateTriggers(['src/billing/x.js'], { rules, config: cfg });
  assert.deepEqual(r2.required_files, ['src/billing/x.js'], 'a file with required checks always needs a packet');
  const r3 = evaluateTriggers(['docs/a.md', 'docs/b.md', 'docs/c.md', 'docs/d.md', 'docs/e.md'], { rules, config: cfg });
  assert.deepEqual(r3.required_files, [], 'exempt files do not count toward broad changes');
  const r4 = evaluateTriggers(['a/1.js', 'b/2.js', 'c/3.js'], { rules, config: cfg });
  assert.ok(r4.reasons.some((x) => x.code === 'cross_area'));
  const r5 = evaluateTriggers(['a/1.js', 'a/2.js', 'a/3.js', 'a/4.js'], { rules, config: cfg });
  assert.ok(r5.reasons.some((x) => x.code === 'broad'));
});

test('host triggers can only make the gate stricter', () => {
  const rules = rulesWithDefaults({ triggers: { broad_files: 10, globs: [] } });
  const loosen = evaluateTriggers(['src/auth/a.js'], { rules, config: cfg, hostTriggers: { globs: [{ glob: 'src/**', require_packet: false }], broad_files: 50 } });
  assert.deepEqual(loosen.required_files, [], 'nothing required either way');
  const repoStrict = rulesWithDefaults({ triggers: { broad_files: 2, globs: [{ glob: 'src/**', require_packet: true }] } });
  const tryWeaken = evaluateTriggers(['src/a.js'], { rules: repoStrict, config: cfg, hostTriggers: { globs: [{ glob: 'src/**', require_packet: false }], broad_files: 99 } });
  assert.deepEqual(tryWeaken.required_files, ['src/a.js'], 'host false cannot exempt a repo-protected file');
  const tighten = evaluateTriggers(['lib/a.js', 'lib/b.js'], { rules, config: cfg, hostTriggers: { globs: [{ glob: 'lib/a.js' }], broad_files: 2 } });
  assert.deepEqual(tighten.required_files, ['lib/a.js', 'lib/b.js'], 'lower broad threshold wins');
});

test('requirements merge repo first, dedupe by digest, tag host ones', () => {
  const rules = rulesWithDefaults({ requirements: [{ id: 'unit', glob: 'src/**', obligation: { kind: 'test', run: 'npm test' } }] });
  const hostRequirements = [
    { id: 'dup', glob: 'src/**', obligation: { kind: 'test', run: 'npm test' } },
    { id: 'lint', glob: 'src/**', obligation: { kind: 'command', run: 'npm run lint' } },
    { id: 'other', glob: 'lib/**', obligation: { kind: 'command', run: 'x' } },
  ];
  const r = requirementsFor(['src/a.js'], { rules, hostRequirements, hostName: 'acme' });
  assert.deepEqual(r.merged.map((x) => x.id), ['unit', 'acme:lint']);
  assert.equal(r.merged[1].source, 'host:acme');
  assert.equal(r.merged[1].obligation.source, 'host:acme');
  assert.deepEqual(r.repoOnly.map((x) => x.id), ['unit']);
  assert.equal(policyDigest(r.merged), policyDigest([...r.merged].reverse()), 'order does not matter');
  assert.notEqual(policyDigest(r.merged), policyDigest(r.repoOnly));
});

function req(id, run, glob = 'src/**') {
  return requirementsFor(['src/a.js'], { rules: rulesWithDefaults({ requirements: [{ id, glob, obligation: { kind: 'test', run } }] }) });
}

test('packets: required checks are added and never removed', () => {
  const p = P.createPacket({ intent: 'x', touches: ['src/a.js'], now: NOW });
  const added = P.syncRequirements(p, req('unit', 'npm test'), { now: NOW });
  assert.equal(added.length, 1);
  assert.equal(p.obligations[0].source, 'rule:unit');
  P.syncRequirements(p, { merged: [], repoOnly: [] }, { now: NOW });
  assert.equal(p.obligations.length, 1, 'a rule going away does not remove its obligation');
  assert.throws(() => P.addObligation(p, { kind: 'test', run: 'npm test' }, { now: NOW }), /already has/);
});

test('packets: proofs count only for the same subject and the same obligation', () => {
  const p = P.createPacket({ intent: 'x', touches: ['src/a.js'], obligations: [{ kind: 'test', run: 'npm test' }], now: NOW });
  const ob = p.obligations[0];
  const proof = { obligation: ob.id, obligation_digest: obligationDigest(ob), subject: 'sha256:aaa', passed: true };
  P.recordProof(p, proof, { now: NOW });
  assert.ok(P.evaluatePacket(p, { subject: 'sha256:aaa' }).ok);
  assert.deepEqual(P.evaluatePacket(p, { subject: 'sha256:bbb' }).unproven, [ob.id], 'new code, no proof');
  ob.run = 'npm test -- --changed';
  assert.deepEqual(P.evaluatePacket(p, { subject: 'sha256:aaa' }).unproven, [ob.id], 'edited command, no proof');
});

test('packets: missing required obligations block, failed proofs set failed state', () => {
  const p = P.createPacket({ intent: 'x', touches: ['src/a.js'], obligations: [{ kind: 'test', run: 'a' }], now: NOW });
  const ob = p.obligations[0];
  P.recordProof(p, { obligation: ob.id, obligation_digest: obligationDigest(ob), subject: 's', passed: false }, { now: NOW });
  const ev = P.evaluatePacket(p, { subject: 's', required: req('unit', 'npm test').merged });
  assert.equal(ev.missing_required.length, 1);
  assert.deepEqual(ev.failed, [ob.id]);
  assert.equal(P.applyEvaluation(p, ev, { now: NOW }), 'failed');
  assert.ok(p.history.some((h) => h.event === 'proof_failed'));
});

test('packets: manual attestations bind to subject; runnable ones cannot be attested', () => {
  const p = P.createPacket({ intent: 'x', touches: ['a'], obligations: [{ kind: 'manual', text: 'looked at it' }, { kind: 'test', run: 't' }], now: NOW });
  assert.throws(() => P.recordAttestation(p, 'o2', { by: 'me', subject: 's', now: NOW }), /prove/);
  P.recordAttestation(p, 'o1', { by: 'me', subject: 's', now: NOW });
  assert.deepEqual(P.evaluatePacket(p, { subject: 's' }).unattested, []);
  assert.deepEqual(P.evaluatePacket(p, { subject: 't' }).unattested, ['o1']);
});

test('packets: expiry and abandonment are terminal and never "done"', () => {
  const p = P.createPacket({ intent: 'x', touches: ['a'], now: '2026-01-01T00:00:00.000Z' });
  assert.ok(P.expireIfStale(p, { now: NOW, ttlDays: 14 }));
  assert.equal(p.state, 'expired');
  assert.equal(P.applyEvaluation(p, { failed: [], ok: true }, { now: NOW }), 'expired');
  const q = P.createPacket({ intent: 'y', touches: ['a'], now: NOW });
  assert.throws(() => P.abandon(q, { now: NOW }), /reason/);
  P.abandon(q, { reason: 'superseded', now: NOW });
  assert.equal(q.state, 'abandoned');
});

test('packets: touches must be repo-relative', () => {
  assert.throws(() => P.createPacket({ intent: 'x', touches: ['/etc/passwd'], now: NOW }), /repo-relative/);
  assert.throws(() => P.createPacket({ intent: 'x', touches: ['../x'], now: NOW }), /repo-relative/);
  assert.throws(() => P.createPacket({ intent: 'x', touches: [], now: NOW }), /touches/);
});

test('packets: proof history is trimmed per obligation', () => {
  const p = P.createPacket({ intent: 'x', touches: ['a'], obligations: [{ kind: 'test', run: 't' }], now: NOW });
  for (let i = 0; i < 9; i++) P.recordProof(p, { obligation: 'o1', subject: `s${i}`, passed: true }, { now: NOW, keep: 3 });
  assert.deepEqual(p.proofs.map((x) => x.subject), ['s6', 's7', 's8']);
});

test('trailers round-trip and ignore non-trailer paragraphs', () => {
  const line = formatTrailer({ id: 'p-12345678', subject: `sha256:${'a'.repeat(64)}`, policy: `sha256:${'b'.repeat(64)}`, proven: 2, runnable: 2, attested: 1, manual: 1 });
  assert.equal(line, `p-12345678 subject=sha256:${'a'.repeat(12)} policy=sha256:${'b'.repeat(12)} proven=2/2 attested=1/1`);
  const msg = `Fix rounding\n\nProof-Of-Change: not-a-trailer-paragraph\nmore body\n\nProof-Of-Change: ${line}\nCo-Authored-By: X <x@example.com>\n`;
  const t = parseTrailers(msg);
  assert.equal(t.length, 1);
  assert.equal(t[0].id, 'p-12345678');
  assert.deepEqual(t[0].proven, { done: 2, total: 2 });
});

test('metrics: catch rate, escapes, friction, and expired packets not completed', () => {
  const landedCaught = { state: 'landed', obligations: [{ id: 'o1', kind: 'test', run: 't' }], proofs: [{ obligation: 'o1', obligation_digest: obligationDigest({ kind: 'test', run: 't' }), passed: true, duration_ms: 100 }], history: [{ event: 'proof_failed' }] };
  const landedClean = { state: 'landed', obligations: [{ id: 'o1', kind: 'manual', text: 'm' }], proofs: [], history: [] };
  const expired = { state: 'expired', obligations: [], proofs: [], history: [] };
  const m = computeMetrics({
    packets: [landedCaught, landedClean, expired],
    misses: [{ stage: 'production', state: 'closed', closed: 'replay-confirmed' }, { stage: 'gate', state: 'open' }],
    rules: { requirements: [{ id: 'r', source: 'miss:m-1' }] },
    gateLog: [
      { decision: 'blocked', subject: 'A', uncovered: 0, packets: [{ failed: 0 }] },
      { decision: 'pass', subject: 'A', packets: [] },
      { decision: 'blocked', subject: 'B', uncovered: 1, packets: [] },
    ],
  });
  assert.equal(m.catch_rate, 0.667); // 1 packet + 1 gate miss caught, 1 escaped
  assert.equal(m.escape_rate_per_100, 50);
  assert.equal(m.proven_share, 0.5);
  assert.equal(m.friction, 0.5);
  assert.equal(m.cost_ms_median, 50);
  assert.equal(m.packets.by_state.expired, 1);
  assert.equal(m.ratchet.misses_closed_replay_confirmed, 1);
});

test('mutation sites skip comments and apply cleanly', () => {
  const text = '// a === b\nif (a === b && c) { return true; }\n';
  const sites = mutationSites(text);
  assert.ok(sites.every((s) => s.line === 2));
  const s = sites.find((x) => x.op === 'strict-eq');
  assert.equal(applySite(text, s), '// a === b\nif (a !== b && c) { return true; }\n');
  const r1 = prng(7);
  const r2 = prng(7);
  assert.equal(r1(), r2());
});

test('CLI argument parsing attaches modifiers to the previous obligation', () => {
  const { positional, flags, obligations } = parseArgs(['open', '--intent', 'x', '--touch', 'a', '--touch=b', '--command', 'npm run lint', '--expect', 'ok', '--timeout', '500', '--manual', 'eyeballed', '--json']);
  assert.deepEqual(positional, ['open']);
  assert.deepEqual(flags.touch, ['a', 'b']);
  assert.equal(flags.json, true);
  assert.deepEqual(obligations, [{ kind: 'command', run: 'npm run lint', expect: 'ok', timeout_ms: 500 }, { kind: 'manual', text: 'eyeballed' }]);
  assert.throws(() => parseArgs(['add', '--expect', 'x']), /must follow/);
});

test('strict union keeps the stricter side; weakening is listed', async () => {
  const { strictUnion, policyWeakening } = await import('../src/rules.js');
  const base = rulesWithDefaults({ triggers: { broad_files: 5, globs: [{ glob: 'src/auth/**', require_packet: true }, { glob: 'docs/**', require_packet: false }] }, requirements: [{ id: 'unit', glob: 'src/**', obligation: { kind: 'test', run: 'npm test' } }] });
  const head = rulesWithDefaults({ triggers: { broad_files: 50, globs: [{ glob: 'vendor/**', require_packet: false }] }, requirements: [] });
  const u = strictUnion(base, head);
  assert.equal(u.triggers.broad_files, 5);
  assert.deepEqual(u.triggers.globs.map((x) => x.glob), ['src/auth/**']);
  assert.deepEqual(u.requirements.map((r) => r.id), ['unit']);
  const w = policyWeakening(base, head);
  assert.ok(w.some((x) => x.includes('requirement "unit"')));
  assert.ok(w.some((x) => x.includes('broad_files raised')));
  assert.ok(w.some((x) => x.includes('protected path "src/auth/**" removed')));
  assert.ok(w.some((x) => x.includes('exemption "vendor/**" added')));
  assert.deepEqual(policyWeakening(base, base), []);
  assert.deepEqual(policyWeakening(head, base).filter((x) => x.includes('requirement')), [], 'adding a requirement is not weakening');
});

test('weakening signals count removed asserts and added skips', async () => {
  const { weakeningSignals } = await import('../src/guard.js');
  assert.deepEqual(weakeningSignals('--- a/x\n+++ b/x\n-  assert.equal(a, 1);\n-  expect(x).toBe(2);\n+  it.skip("y", () => {});\n+  console.log(1);\n'), { removed_asserts: 2, added_skips: 1 });
  assert.deepEqual(weakeningSignals(''), { removed_asserts: 0, added_skips: 0 });
});
