// What a verify result that isn't verified waits for, decided from typed findings only
// (src/decision.js): one precedence for mixed results, and no text can change the outcome.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideVerify, resolutionOf, summarizeFindings } from '../src/decision.js';
import { factsOf, withFacts } from '../src/finding.js';
import { createPocp } from '../src/index.js';
import { git, pocp, sampleRepo, sh, write, read } from './helpers.js';

const typed = (code, facts, detail = `${code} detail`) => withFacts({ code, detail, blocking: true }, facts);
const TESTS = typed('test_change', { approval: 'tests', files: ['t.js'] });
const POLICY = typed('policy_loosened', { files: ['.proof/rules.json'] });
const CI = typed('ci_config_changed', { files: ['.github/workflows/ci.yml'] });
const INCONCLUSIVE = typed('test_inconclusive', { files: ['t.js'] });
const CI_UNFINISHED = typed('ci_unfinished', {});
const FAILED = typed('failed_proof', {});
const outcome = (findings, reruns) => summarizeFindings(findings, reruns).outcome;

test('resolution: each blocking finding is an approval of one kind, a re-run, or a fix', () => {
  assert.deepEqual(resolutionOf(TESTS), { by: 'approval', approval: 'tests', files: ['t.js'] });
  assert.equal(resolutionOf(POLICY).approval, 'policy');
  assert.equal(resolutionOf(CI).approval, 'policy');
  assert.equal(resolutionOf(INCONCLUSIVE).approval, 'inconclusive');
  assert.deepEqual(resolutionOf(CI_UNFINISHED), { by: 'rerun' });
  for (const code of ['failed_proof', 'rerun_failed', 'unfinished_proof', 'uncovered', 'missing_packet', 'trailer_mismatch', 'invalid_policy', 'invalid_signature']) {
    assert.deepEqual(resolutionOf(typed(code, {})), { by: 'fix' }, code);
  }
});

test('a test change is approvable only when the guard said so; otherwise it fails closed', () => {
  assert.deepEqual(resolutionOf(typed('test_change', { files: ['t.js'], variant: 'local_only' })), { by: 'fix' });
  assert.deepEqual(resolutionOf(typed('test_change', { files: ['t.js'], variant: 'packet_checks' })), { by: 'fix' });
  // A finding without facts (built by hand, or read back from JSON) is never an approval.
  assert.deepEqual(resolutionOf({ code: 'test_change', detail: 'existing tests or test setup changed (t.js)', blocking: true }), { by: 'fix' });
});

test('mixed results: one precedence, failed > inconclusive > waiting', () => {
  // Approvals only: waiting, and every label is listed.
  const both = summarizeFindings([TESTS, POLICY, CI]);
  assert.equal(both.outcome, 'waiting');
  assert.equal(both.only, true);
  assert.deepEqual(both.needs.map((n) => [n.label, n.files]), [['pocp-approve-tests', ['t.js']], ['pocp-approve-policy', ['.proof/rules.json', '.github/workflows/ci.yml']]]);
  // A hard failure never becomes approval-only because something else needs an approval.
  for (const fix of [FAILED, typed('uncovered', {}), typed('test_change', { variant: 'local_only' })]) {
    const s = summarizeFindings([TESTS, POLICY, fix]);
    assert.equal(s.outcome, 'failed', fix.code);
    assert.equal(s.only, false, fix.code);
  }
  assert.equal(outcome([TESTS], [{ unfinished: false }]), 'failed');
  // Something that didn't finish keeps its own meaning: inconclusive, never approval-only and
  // never a failure on its own.
  assert.equal(outcome([TESTS, CI_UNFINISHED]), 'inconclusive');
  assert.equal(summarizeFindings([TESTS, CI_UNFINISHED]).only, false);
  assert.equal(outcome([TESTS], [{ unfinished: true }]), 'inconclusive');
  assert.equal(outcome([INCONCLUSIVE]), 'inconclusive');
  assert.equal(outcome([INCONCLUSIVE, TESTS]), 'inconclusive');
  // ...but a failure next to it is still a failure.
  assert.equal(outcome([CI_UNFINISHED, FAILED]), 'failed');
  assert.equal(outcome([INCONCLUSIVE], [{ unfinished: true }, { unfinished: false }]), 'failed');
  // Nothing blocking that explains the failure: failed, not a wait.
  assert.equal(outcome([]), 'failed');
  assert.equal(outcome([withFacts({ code: 'test_change', detail: 'x', blocking: false }, { approval: 'tests' })]), 'failed');
});

test('no text changes the decision: details are rewritten and the outcome stays the same', () => {
  const findings = [TESTS, POLICY, CI, INCONCLUSIVE, CI_UNFINISHED, FAILED];
  const reworded = (text) => findings.map((f) => withFacts({ code: f.code, detail: text, blocking: f.blocking }, factsOf(f)));
  const before = summarizeFindings(findings);
  for (const text of ['', 'the mechanical check passed only locally', 'checks the packet chose', 'pocp-approve-tests (a.js, b.js)', "didn't finish (timed out)", 'fix the code']) {
    const after = summarizeFindings(reworded(text));
    assert.equal(after.outcome, before.outcome, text);
    assert.equal(after.only, before.only, text);
    assert.deepEqual(after.needs.map((n) => [n.label, n.files]), before.needs.map((n) => [n.label, n.files]), text);
  }
});

test('decideVerify: null when verified; a range counts its commits, its net change and its re-runs', () => {
  assert.equal(decideVerify({ ok: true, findings: [FAILED] }), null);
  assert.equal(decideVerify({ ok: false, findings: [TESTS] }).outcome, 'waiting');
  const range = {
    ok: false,
    commits: [{ findings: [TESTS] }],
    net: { findings: [POLICY] },
    // A range lists its re-run failures twice (as findings and in rerun_failures): counted once.
    findings: [typed('rerun_failed', {})],
    rerun_failures: [{ code: 'rerun_failed', unfinished: true, blocking: true }],
  };
  const d = decideVerify(range);
  assert.equal(d.outcome, 'inconclusive');
  assert.deepEqual(d.needs.map((n) => n.label), ['pocp-approve-tests', 'pocp-approve-policy']);
  assert.equal(decideVerify({ ...range, rerun_failures: [{ unfinished: true, blocking: false }] }).outcome, 'waiting');
});

test('the library and the CLI decide a pull request the same way', async () => {
  const dir = sampleRepo({ hooks: true, deep: false });
  const base = git(dir, 'rev-parse', 'HEAD');
  write(dir, 'test/math.check.mjs', `${read(dir, 'test/math.check.mjs')}// note\n`);
  git(dir, 'add', '-A');
  assert.equal(pocp(dir, ['fix', '--intent', 'annotate the test']).code, 0);
  sh(dir, 'git', ['commit', '-q', '-m', 'annotate the test']);
  const opts = { rerun: 'all', requireCoverage: true };
  const lib = decideVerify(await createPocp({ cwd: dir }).verifyRange(`${base}..HEAD`, opts));
  const cli = pocp(dir, ['verify', `${base}..HEAD`, '--rerun', '--require-coverage', '--json']);
  assert.equal(lib.outcome, 'waiting');
  assert.deepEqual(lib, cli.json.approval);
});
