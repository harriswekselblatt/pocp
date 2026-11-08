// One run outcome: passed, failed (ran to the end and failed: says something about the code)
// or unfinished (timed out, killed, didn't start, exit 126/127: says nothing). An unfinished
// proof is never reported as "fails on this exact code, fix the code", and an unfinished test
// guard result is never cached or reused.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runOutcome } from '../src/run-result.js';
import { evaluatePacket } from '../src/packets.js';
import { obligationDigest } from '../src/obligations.js';
import { createPocp } from '../src/engine.js';
import { gateRemedies, verifyRemedy } from '../src/remedies.js';
import { git, pocp, read, sampleRepo, tmpRepo, write, writeRules } from './helpers.js';

test('runOutcome', () => {
  assert.equal(runOutcome({ passed: true, exit: 0 }), 'passed');
  assert.equal(runOutcome({ passed: false, exit: 1 }), 'failed');
  assert.equal(runOutcome({ passed: false, exit: 0 }), 'failed', 'exit 0 whose expect did not match ran and failed');
  assert.equal(runOutcome({ passed: false, exit: null, timed_out: true }), 'unfinished');
  assert.equal(runOutcome({ passed: false, exit: 1, timed_out: true }), 'unfinished');
  assert.equal(runOutcome({ passed: false, exit: null, signal: 'SIGKILL' }), 'unfinished');
  assert.equal(runOutcome({ passed: false, exit: null, error: 'spawn ENOENT' }), 'unfinished');
  assert.equal(runOutcome({ passed: false, exit: 127 }), 'unfinished');
  assert.equal(runOutcome({ passed: false, exit: 126 }), 'unfinished');
  assert.equal(runOutcome(null), 'unfinished');
});

function packetWith(proofs) {
  const obligations = proofs.map((_, i) => ({ id: `o${i + 1}`, kind: 'test', run: `check ${i + 1}` }));
  return {
    id: 'p-1',
    obligations,
    attestations: [],
    proofs: proofs.map((p, i) => ({ obligation: `o${i + 1}`, obligation_digest: obligationDigest(obligations[i]), subject: 'S', ...p })),
  };
}

test('evaluatePacket: unfinished proofs are named apart from those that ran and failed', () => {
  const ev = evaluatePacket(packetWith([{ passed: false, exit: 1 }, { passed: false, exit: null, timed_out: true }, { passed: true, exit: 0 }]), { subject: 'S' });
  assert.deepEqual(ev.failed, ['o1', 'o2'], 'failed still lists every proof that did not pass (ok and exit codes unchanged)');
  assert.deepEqual(ev.unfinished, ['o2']);
  assert.equal(ev.ok, false);
});

test('gate remedies: a timed-out proof says re-run, never "fix the code"', () => {
  const ev = { ok: false, missing_required: [], unproven: [], failed: ['o2'], unfinished: ['o2'], unattested: [], guard: [] };
  const rem = gateRemedies({ decision: 'blocked', problems: [{ code: 'unfinished_proof', detail: 'x', packet: 'p-1' }], packets: [{ id: 'p-1', evaluation: ev }], reasons: [] });
  assert.deepEqual(rem.map((r) => r.code), ['unfinished_proof']);
  assert.doesNotMatch(`${rem[0].what} ${rem[0].next}`, /fix the code|failed on this exact code/);
  assert.match(rem[0].next, /re-run/);
  const both = gateRemedies({ decision: 'blocked', problems: [], packets: [{ id: 'p-1', evaluation: { ...ev, failed: ['o1', 'o2'] } }], reasons: [] });
  assert.deepEqual(both.map((r) => r.code), ['unfinished_proof', 'failed_proof']);
  assert.match(both[1].what, /o1 failed/);
  assert.doesNotMatch(both[1].what, /o2/);
});

test('verify remedies use the unfinished flag, not the wording', () => {
  const fix = /fix the code/;
  assert.doesNotMatch(verifyRemedy('rerun_failed', 'rerun of "x" failed (exit null)', { unfinished: true }).next, fix);
  assert.match(verifyRemedy('rerun_failed', 'rerun of "x" failed (exit null, timed out)', { unfinished: false }).next, fix);
  // Without the flag, any unfinished wording (a signal, a failed start) is still recognized.
  assert.doesNotMatch(verifyRemedy('rerun_failed', 'rerun of "x" didn\'t finish (exit null, killed by SIGKILL)').next, fix);
  assert.doesNotMatch(verifyRemedy('rerun_failed', 'rerun of "x" didn\'t finish (exit 127, exit 127 (command not found))').next, fix);
  assert.match(verifyRemedy('rerun_failed', 'rerun of "x" failed (exit 1)').next, fix);
  assert.doesNotMatch(verifyRemedy('unfinished_proof', 'proof for o1 didn\'t finish').next, fix);
  assert.match(verifyRemedy('failed_proof', 'proof for o1 failed').next, fix);
});

// The check hangs only while POCP_TEST_HANG is set: a timeout from load, not from the code.
const HANG = "if (process.env.POCP_TEST_HANG === '1') { setInterval(() => {}, 1000); await new Promise(() => {}); }\n";
const RULES = { requirements: [{ id: 'math-tests', globs: ['src/**', 'test/**'], obligation: { kind: 'test', run: 'node test/math.check.mjs', timeout_ms: 1500 }, source: 'author' }] };

test('pocp fix and gate: a check that timed out is reported as unfinished, with the same blocked exit', () => {
  const dir = sampleRepo({ rules: RULES, deep: false, hooks: true });
  write(dir, 'src/math.js', `${HANG}${read(dir, 'src/math.js')}`);
  git(dir, 'add', '-A');
  const f = pocp(dir, ['fix', '--intent', 'x', '--json'], { env: { POCP_TEST_HANG: '1' } });
  assert.notEqual(f.code, 0, f.stdout);
  const agent = f.json.needs_agent;
  assert.ok(agent.some((x) => x.code === 'unfinished_proof'), JSON.stringify(agent));
  assert.ok(!agent.some((x) => x.code === 'failed_proof'), JSON.stringify(agent));
  assert.ok(!agent.some((x) => /fix the code/.test(x.next)), JSON.stringify(agent));
  const g = pocp(dir, ['gate', '--json']);
  assert.notEqual(g.code, 0);
  const codes = g.json.problems.map((p) => p.code);
  assert.ok(codes.includes('unfinished_proof') && !codes.includes('failed_proof'), JSON.stringify(g.json.problems));
  const human = pocp(dir, ['fix', '--intent', 'x'], { env: { POCP_TEST_HANG: '1' } });
  const text = human.stdout + human.stderr;
  assert.doesNotMatch(text, /fails on this exact code|fix the code/);
  assert.match(text, /didn't finish/);
});

test('verify: a committed proof that timed out is unfinished_proof, not failed_proof; it still fails verify', async () => {
  const dir = sampleRepo({ rules: RULES, deep: false, hooks: true });
  write(dir, 'src/math.js', `${HANG}${read(dir, 'src/math.js')}`);
  git(dir, 'add', '-A');
  const api = createPocp({ cwd: dir, by: 'tester' });
  const { packet } = await api.open({ intent: 'x', touches: ['src/math.js'] });
  await api.prove({ ids: [packet.id] });
  // Committed past the hooks, with the trailers the commit hook would have added, and the
  // proof recorded as one that timed out (as a commit made with --no-verify would carry).
  const lines = await api.trailers();
  const file = path.join(dir, `.proof/packets/${packet.id}.json`);
  const p = JSON.parse(fs.readFileSync(file, 'utf8'));
  Object.assign(p.proofs.at(-1), { passed: false, exit: null, signal: 'SIGTERM', timed_out: true });
  p.state = 'failed';
  fs.writeFileSync(file, JSON.stringify(p, null, 2));
  git(dir, 'add', '-A');
  git(dir, '-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', `timed out\n\n${lines.map((l) => `Proof-Of-Change: ${l}`).join('\n')}`);
  const v = pocp(dir, ['verify', 'HEAD', '--json']);
  assert.equal(v.code, 1, v.stdout);
  const codes = v.json.findings.map((x) => x.code);
  assert.ok(codes.includes('unfinished_proof'), JSON.stringify(v.json.findings));
  assert.ok(!codes.includes('failed_proof'), JSON.stringify(v.json.findings));
  assert.ok(v.json.findings.find((x) => x.code === 'unfinished_proof').blocking);
});

// ------------------------------------------------------------------ test guard cache

const noHooks = ['-c', 'core.hooksPath=/dev/null'];
const MATH = 'export const add = (a, b) => a + b;\nexport const lt = (a, b) => a < b;\n';
const CHECK = [
  "import { add, lt } from '../src/math.js';",
  'if (add(2, 3) !== 5) process.exit(1);',
  'if (lt(1, 2) !== true || lt(2, 1) !== false) process.exit(1);',
  '',
].join('\n');

function guardRepo() {
  const dir = tmpRepo();
  write(dir, 'package.json', '{ "type": "module" }\n');
  write(dir, 'src/math.js', MATH);
  write(dir, 'test/math.check.mjs', CHECK);
  pocp(dir, ['init', '--deep']);
  writeRules(dir, { requirements: [{ id: 'unit', globs: ['src/**', 'test/**'], obligation: { kind: 'test', run: 'node test/math.check.mjs', timeout_ms: 1500 }, source: 'author' }] });
  git(dir, 'add', '-A');
  git(dir, ...noHooks, 'commit', '-q', '-m', 'base');
  // A stronger existing test, staged: the guard judges it. It hangs while POCP_TEST_HANG is set.
  write(dir, 'test/math.check.mjs', `${HANG}${CHECK}if (add(0, 0) !== 0) process.exit(1);\n`);
  git(dir, 'add', '-A');
  return dir;
}
const cacheDir = (dir) => path.join(dir, '.proof', 'runs', 'guard-cache');
const cacheEntries = (dir) => (fs.existsSync(cacheDir(dir)) ? fs.readdirSync(cacheDir(dir)).map((f) => JSON.parse(fs.readFileSync(path.join(cacheDir(dir), f), 'utf8'))) : []);
const guardRun = (r) => r.json.packets.flatMap((p) => p.runs).find((x) => x.guard !== undefined || /already checked/.test(x.skipped || ''));

test('an unfinished guard result is not cached, and the next prove runs the guard again', () => {
  const dir = guardRepo();
  const first = pocp(dir, ['fix', '--intent', 'stronger test', '--json'], { env: { POCP_TEST_HANG: '1' } });
  const id = first.json.actions.find((a) => a.action === 'open')?.packet;
  assert.ok(id, first.stdout);
  const packet = JSON.parse(read(dir, `.proof/packets/${id}.json`));
  const guardProof = packet.proofs.find((p) => p.kind === 'guard');
  assert.ok(guardProof, 'the guard ran');
  assert.equal(guardProof.guard.unfinished, true, guardProof.guard.summary);
  assert.ok(!cacheEntries(dir).some((e) => e.unfinished), 'no unfinished result in the cache');

  const second = pocp(dir, ['prove', id, '--json']);
  const run = guardRun(second);
  assert.ok(run && !run.skipped, `the guard ran again: ${JSON.stringify(run)}`);
  assert.equal(run.passed, true, run.summary);
});

test('a legacy cache entry for an unfinished guard result is never reused', () => {
  const dir = guardRepo();
  const first = pocp(dir, ['fix', '--intent', 'stronger test', '--json']);
  const id = first.json.actions.find((a) => a.action === 'open')?.packet;
  const files = fs.readdirSync(cacheDir(dir));
  assert.equal(files.length, 1, 'the passing result was cached');
  // Turn it into what older versions cached for a guard that timed out.
  const file = path.join(cacheDir(dir), files[0]);
  const entry = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, JSON.stringify({ ...entry, verdict: 'inconclusive', passed: false, unfinished: true, summary: 'the old tests didn\'t finish (legacy)' }));
  // Drop the recorded guard proof, so the next prove looks the result up again.
  const pfile = path.join(dir, `.proof/packets/${id}.json`);
  const packet = JSON.parse(fs.readFileSync(pfile, 'utf8'));
  packet.proofs = packet.proofs.filter((p) => p.kind !== 'guard');
  fs.writeFileSync(pfile, JSON.stringify(packet, null, 2));
  const again = pocp(dir, ['prove', id, '--json']);
  const run = guardRun(again);
  assert.ok(run, again.stdout);
  assert.ok(!run.cached, 'the legacy entry was not reused');
  assert.equal(run.passed, true, run.summary);
});
