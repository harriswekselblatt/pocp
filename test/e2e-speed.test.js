// Speed without less checking: the expensive test-change check never runs twice for the same
// code, and its "new tests on the new code" baseline reuses the run that proved the packet.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { git, packetId, pocp, read, sampleRepo, write, writeConfig } from './helpers.js';
import { commit, makeKey, NO_SSH_KEYGEN } from './fixtures.js';
import { obligationDigest } from '../src/obligations.js';

// Counts its own runs in a file outside the repo, so tests can see how often a check ran.
function countingRepo(mode = 'block') {
  const dir = sampleRepo({ hooks: true, rules: { requirements: [] } });
  const counter = path.join(dir, '..', `${path.basename(dir)}-runs`);
  write(dir, '.proof/rules.json', `${JSON.stringify({ pocp: 1, requirements: [{ id: 'math-tests', globs: ['src/**', 'test/**'], obligation: { kind: 'test', run: `echo run >> ${counter} && for f in test/*.check.mjs; do node "$f" || exit 1; done` }, source: 'author' }] }, null, 2)}\n`);
  writeConfig(dir, { guard: { tests: mode, mutants: 2 } });
  git(dir, 'add', '-A');
  git(dir, '-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', 'rules');
  const runs = () => (fs.existsSync(counter) ? fs.readFileSync(counter, 'utf8').split('\n').filter(Boolean).length : 0);
  const reset = () => fs.rmSync(counter, { force: true });
  return { dir, runs, reset };
}

function honestTestEdit(dir) {
  write(dir, 'test/math.check.mjs', read(dir, 'test/math.check.mjs').replace("console.log('math ok');", "console.log('math fine');"));
  git(dir, 'add', '-A');
}

/** Open a packet for the staged change and prove it; returns the packet id. */
function openAndProve(dir, intent = 'reword') {
  const opened = pocp(dir, ['open', '--intent', intent, '--touch', 'src/**', '--touch', 'test/**']);
  assert.equal(opened.code, 0, opened.stderr);
  const id = packetId(opened.stdout);
  const proved = pocp(dir, ['prove', id]);
  assert.equal(proved.code, 0, proved.stdout + proved.stderr);
  return id;
}

test('the guard reuses the packet\'s own passing run as its new-code baseline', () => {
  const { dir, runs } = countingRepo();
  honestTestEdit(dir);
  const id = openAndProve(dir);
  const p = JSON.parse(read(dir, `.proof/packets/${id}.json`));
  const guardProof = p.proofs.find((x) => x.kind === 'guard');
  assert.equal(guardProof.guard.verdict, 'passed');
  assert.equal(guardProof.guard.new_tests.runs[0].reused, true, 'the new-code baseline is the plain proof, not a second run');
  // 1 plain run + 1 old-tests run + mutants (old side, then new side only when caught): never a second baseline.
  const n = runs();
  assert.ok(n <= 2 + 2 * 2, `ran ${n} times`);
});

test('a guard result is cached by what decides it: a new packet on the same code does not re-run it', () => {
  const { dir, runs, reset } = countingRepo();
  honestTestEdit(dir);
  const id = openAndProve(dir, 'one');
  assert.equal(pocp(dir, ['abandon', id, '--reason', 'start over']).code, 0);
  reset();
  const id2 = openAndProve(dir, 'two');
  assert.equal(runs(), 0, 'the plain check is reused from the abandoned packet and the guard from the cache');
  assert.equal(pocp(dir, ['gate']).code, 0);
  const p = JSON.parse(read(dir, `.proof/packets/${id2}.json`));
  assert.equal(p.proofs.find((x) => x.kind === 'guard').guard.verdict, 'passed');
  // --force always runs it again.
  reset();
  pocp(dir, ['prove', id2, '--force']);
  assert.ok(runs() >= 2);
});

test('verify never trusts the local guard cache: CI runs the check itself', () => {
  const { dir, runs, reset } = countingRepo();
  const base = git(dir, 'rev-parse', 'HEAD');
  honestTestEdit(dir);
  openAndProve(dir);
  assert.equal(commit(dir, 'reword').status, 0);
  reset();
  const v = pocp(dir, ['verify', `${base}..HEAD`, '--rerun', '--require-coverage', '--json']);
  assert.equal(v.code, 0, v.stdout);
  assert.ok(runs() >= 2, 'the old-tests run and mutants ran in CI');
  const mech = v.json.commits[0].test_guard.mechanical[0];
  assert.equal(mech.evidence, 'rerun');
  // The range's head re-run reuses the guard's new-code baseline from the same commit.
  const head = v.json.reruns.find((r) => /for f in test/.test(r.run));
  assert.equal(head.status, 'passed');
  assert.match(head.reused, /already run on this commit/);
});

test('verify on one commit: the guard baseline reuses this verify\'s re-run', () => {
  const { dir } = countingRepo();
  honestTestEdit(dir);
  openAndProve(dir);
  assert.equal(commit(dir, 'reword').status, 0);
  const v = pocp(dir, ['verify', 'HEAD', '--rerun', '--json']);
  assert.equal(v.code, 0, v.stdout);
  const runsOfGuard = v.json.test_guard.mechanical[0].result.new_tests.runs;
  assert.equal(runsOfGuard[0].reused, true);
});

test('a CI result for the exact code is the guard\'s baseline in verify', () => {
  const { dir } = countingRepo();
  const base = git(dir, 'rev-parse', 'HEAD');
  honestTestEdit(dir);
  openAndProve(dir);
  assert.equal(commit(dir, 'reword').status, 0);
  const rules = JSON.parse(read(dir, '.proof/rules.json'));
  const cmd = rules.requirements[0].obligation.run;
  const results = path.join(dir, '..', `${path.basename(dir)}-ci.jsonl`);
  assert.equal(pocp(dir, ['ci-run', '--results', results, '--', cmd]).code, 0);
  const v = pocp(dir, ['verify', `${base}..HEAD`, '--rerun', '--ci-results', results, '--json']);
  assert.equal(v.code, 0, v.stdout);
  assert.equal(v.json.commits[0].test_guard.mechanical[0].result.new_tests.runs[0].reused, true);
});

test('hooks list old commits\' trees once: later runs read the subject cache', () => {
  const dir = sampleRepo({ hooks: true });
  for (const n of [1, 2]) {
    write(dir, 'src/math.js', `${read(dir, 'src/math.js')}// ${n}\n`);
    git(dir, 'add', '-A');
    assert.equal(pocp(dir, ['fix', '--intent', `edit ${n}`]).code, 0);
    assert.equal(commit(dir, `edit ${n}`).status, 0);
  }
  write(dir, 'src/math.js', `${read(dir, 'src/math.js')}// 3\n`);
  git(dir, 'add', '-A');
  const trace = (n) => path.join(dir, '..', `${path.basename(dir)}-trace-${n}`);
  pocp(dir, ['gate'], { env: { GIT_TRACE: trace(1) } });
  pocp(dir, ['gate'], { env: { GIT_TRACE: trace(2) } });
  const count = (f, re) => fs.readFileSync(f, 'utf8').split('\n').filter((l) => re.test(l)).length;
  assert.ok(fs.existsSync(path.join(dir, '.proof', 'runs', 'tree-subjects.json')));
  for (const t of git(dir, 'log', '-3', '--format=%T').split('\n')) {
    assert.equal(count(trace(2), new RegExp(`git ls-tree .*${t}`)), 0, 'no old tree is listed again');
  }
  const heads = count(trace(2), /built-in: git rev-parse --verify --quiet HEAD$/);
  assert.ok(heads <= 6, `HEAD is resolved once per listing, not once per packet (${heads})`);
});

test('with signing on, only runs from this prove or validly signed proofs are reused', { skip: NO_SSH_KEYGEN }, () => {
  const { dir, runs, reset } = countingRepo();
  const { key, pub } = makeKey(dir);
  write(dir, '.proof/allowed_signers', `signer@example.com ${pub}\n`);
  git(dir, 'add', '-A');
  git(dir, '-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', 'signers');
  const env = { POCP_SIGN_KEY: key, POCP_SIGN_PRINCIPAL: 'signer@example.com' };
  honestTestEdit(dir);
  const opened = pocp(dir, ['open', '--intent', 'x', '--touch', 'src/**', '--touch', 'test/**'], { env });
  const id = packetId(opened.stdout);
  // A forged, unsigned "pass" for the plain check on this exact code.
  const file = path.join(dir, '.proof', 'packets', `${id}.json`);
  const p = JSON.parse(fs.readFileSync(file, 'utf8'));
  const ob = p.obligations.find((o) => o.kind === 'test');
  const subject = pocp(dir, ['status', '--json']).json.subject;
  p.proofs.push({ obligation: ob.id, obligation_digest: obligationDigest(ob), subject, passed: true, duration_ms: 1 });
  fs.writeFileSync(file, JSON.stringify(p, null, 2));
  const guardOb = p.obligations.find((o) => o.kind === 'guard');
  pocp(dir, ['prove', id, '--only', guardOb.id], { env });
  const after = JSON.parse(fs.readFileSync(file, 'utf8'));
  const g = after.proofs.find((x) => x.kind === 'guard');
  assert.ok(g, 'the guard ran');
  assert.ok(!g.guard.new_tests.runs[0].reused, 'a forged proof is not the baseline of a signed result');
  // Abandon and start over: the cached guard result is not reused when it would be signed.
  assert.equal(pocp(dir, ['abandon', id, '--reason', 'again']).code, 0);
  reset();
  const id2 = packetId(pocp(dir, ['open', '--intent', 'y', '--touch', 'src/**', '--touch', 'test/**'], { env }).stdout);
  assert.equal(pocp(dir, ['prove', id2], { env }).code, 0);
  assert.ok(runs() >= 2, 'the guard ran again rather than signing a cached file');
});
