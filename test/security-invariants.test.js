// The security properties POCP must keep through every change. Golden outputs
// (golden.test.js) show that behavior stayed the same; these decide whether the behavior is
// acceptable. They assert outcomes (does it pass or block, which finding), never wording.
//
// A restructuring PR must not edit this file. A PR that changes one of these properties on
// purpose needs its own security review. Invariants that become testable in a later step are
// listed as `todo`, each with the change that makes it testable.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { TEST_TMP, git, pocp, sampleRepo, sh, write, writeRules } from './helpers.js';
import { createPocp, decideVerify } from '../src/index.js';
import { VERIFY_EXIT } from '../src/approvals.js';
import { BREAK_ADD, TWEAK_ADD } from './fixtures.js';

const CI = ['--rerun', '--require-coverage', '--exit-detail', '--json'];
const findingsOf = (v) => [...(v.json?.findings || []), ...(v.json?.commits || []).flatMap((c) => c.findings || []), ...(v.json?.net?.findings || [])];
const blocking = (v, code) => findingsOf(v).some((f) => f.code === code && f.blocking);

function proven(dir, intent) {
  git(dir, 'add', '-A');
  const r = pocp(dir, ['fix', '--intent', intent]);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  sh(dir, 'git', ['commit', '-q', '-m', intent]);
}

/** A PR that removes the rule judging it, proven by its own (loosened) rules. */
function loosenedPr() {
  const dir = sampleRepo({ hooks: true, deep: false });
  const base = git(dir, 'rev-parse', 'HEAD');
  writeRules(dir, { triggers: { globs: [] }, requirements: [] });
  write(dir, 'src/math.js', BREAK_ADD);
  git(dir, 'add', '-A');
  const opened = pocp(dir, ['open', '--intent', 'drop the rule', '--touch', '.proof/rules.json', '--touch', 'src/math.js', '--command', 'true', '--json']);
  assert.equal(pocp(dir, ['prove', opened.json.packet.id]).code, 0);
  sh(dir, 'git', ['commit', '-q', '-m', 'drop the rule']);
  return { dir, base, head: git(dir, 'rev-parse', 'HEAD') };
}

test('invariant: the base judges the head; a PR cannot loosen the rules that judge it', () => {
  const { dir, base } = loosenedPr();
  const v = pocp(dir, ['verify', `${base}..HEAD`, ...CI]);
  assert.notEqual(v.code, 0, 'a self-loosening PR must not verify');
  assert.ok(blocking(v, 'policy_loosened'), 'the loosening is a blocking finding');
});

test('invariant: an approval counts only for the head it names', () => {
  const { dir, base, head } = loosenedPr();
  const other = git(dir, 'rev-parse', 'HEAD~1');
  const wrong = pocp(dir, ['verify', `${base}..HEAD`, ...CI, `--accept-policy-change=${other}`]);
  assert.ok(blocking(wrong, 'policy_loosened'), 'an approval for another commit is ignored');
  const right = pocp(dir, ['verify', `${base}..HEAD`, ...CI, `--accept-policy-change=${head}`]);
  assert.equal(blocking(right, 'policy_loosened'), false, 'an approval for this head applies');
  // With the loosening approved, the head's rules are in force, and its code is judged by them.
  assert.equal(right.json.commits[0].policy.accepted, true);
});

test('invariant: evidence is bound to content; a proof does not carry over to different code', () => {
  const dir = sampleRepo({ hooks: true, deep: false });
  const base = git(dir, 'rev-parse', 'HEAD');
  write(dir, 'src/math.js', TWEAK_ADD);
  proven(dir, 'swap the operands');
  // The real trailer pasted onto different code, with the hooks off (the hooks would strip it).
  const trailer = git(dir, 'log', '-1', '--format=%B').split('\n').find((l) => l.startsWith('Proof-Of-Change:'));
  assert.ok(trailer, 'the proven commit carries a trailer');
  write(dir, 'src/math.js', BREAK_ADD);
  git(dir, 'add', '-A');
  git(dir, '-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', `looks proven\n\n${trailer}`);
  const v = pocp(dir, ['verify', `${base}..HEAD`, ...CI]);
  assert.notEqual(v.code, 0);
  assert.ok(blocking(v, 'trailer_mismatch'), 'the trailer names other code');
});

test('invariant: malformed records never pass', () => {
  // A corrupt packet, an incomplete packet (no obligations), and invalid rules: none verifies.
  const cases = {
    'corrupt packet': (p) => '{ not json',
    'incomplete packet': (p) => JSON.stringify({ ...JSON.parse(p), obligations: undefined }),
  };
  for (const [name, mangle] of Object.entries(cases)) {
    const dir = sampleRepo({ hooks: true, deep: false });
    const base = git(dir, 'rev-parse', 'HEAD');
    write(dir, 'src/math.js', TWEAK_ADD);
    proven(dir, 'swap the operands');
    const rel = git(dir, 'ls-files', '.proof/packets').split('\n').find((p) => p.endsWith('.json'));
    write(dir, rel, mangle(fs.readFileSync(path.join(dir, rel), 'utf8')));
    git(dir, 'add', '-A');
    git(dir, '-c', 'core.hooksPath=/dev/null', 'commit', '-q', '--amend', '--no-edit');
    const v = pocp(dir, ['verify', `${base}..HEAD`, ...CI]);
    assert.notEqual(v.code, 0, `${name}: must not verify`);
  }
  const dir = sampleRepo({ hooks: true, deep: false });
  const base = git(dir, 'rev-parse', 'HEAD');
  write(dir, '.proof/rules.json', '{ "pocp": 1, "requirements": [');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '--no-verify', '-m', 'corrupt the rules');
  const v = pocp(dir, ['verify', `${base}..HEAD`, ...CI]);
  assert.notEqual(v.code, 0, 'invalid rules must not verify');
  assert.ok(blocking(v, 'invalid_policy'), 'invalid policy always blocks');
});

test('invariant: a run that did not finish is never reported as a failure of the code', () => {
  const dir = sampleRepo({ hooks: true, deep: false, rules: {
    triggers: { globs: [] },
    requirements: [{ id: 'slow', glob: 'src/**', obligation: { kind: 'test', run: 'node -e "setTimeout(() => {}, 60000)"', timeout_ms: 300 }, source: 'author' }],
  } });
  write(dir, 'src/math.js', TWEAK_ADD);
  git(dir, 'add', '-A');
  assert.notEqual(pocp(dir, ['fix', '--intent', 'slow']).code, 0);
  const g = pocp(dir, ['gate', '--json']);
  const codes = (g.json.remedies || []).map((r) => r.code);
  assert.ok(codes.includes('unfinished_proof'), `expected unfinished_proof, got ${codes.join(', ')}`);
  assert.equal(codes.includes('failed_proof'), false, 'an unfinished run is not a failed proof');
});

test('invariant: an edited test never passes without the test-edit check or a person', () => {
  const dir = sampleRepo({ hooks: true, deep: false });
  const base = git(dir, 'rev-parse', 'HEAD');
  write(dir, 'test/math.check.mjs', `${fs.readFileSync(path.join(dir, 'test/math.check.mjs'), 'utf8')}// note\n`);
  proven(dir, 'annotate the test');
  const head = git(dir, 'rev-parse', 'HEAD');
  const v = pocp(dir, ['verify', `${base}..HEAD`, ...CI]);
  assert.notEqual(v.code, 0, 'fast mode: an edited test needs a person');
  assert.ok(blocking(v, 'test_change'));
  const approved = pocp(dir, ['verify', `${base}..HEAD`, ...CI, `--accept-test-change=${head}`]);
  assert.equal(approved.code, 0, approved.stdout + approved.stderr);
});

test('invariant: incomplete history is refused, never verified', () => {
  const src = sampleRepo({ hooks: true, deep: false });
  write(src, 'src/math.js', TWEAK_ADD);
  git(src, 'add', '-A');
  git(src, '-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', 'second');
  const shallow = path.join(TEST_TMP, `shallow-${path.basename(src)}`);
  git(TEST_TMP, 'clone', '-q', '--depth', '1', `file://${src}`, shallow);
  assert.notEqual(pocp(shallow, ['verify', 'HEAD', ...CI]).code, 0, 'shallow clone');

  git(src, 'checkout', '-q', '--orphan', 'other');
  git(src, 'rm', '-rq', '--cached', '.');
  write(src, 'other.txt', 'x\n');
  git(src, 'add', 'other.txt');
  git(src, '-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', 'unrelated');
  assert.notEqual(pocp(src, ['verify', 'main..other', ...CI]).code, 0, 'no merge base');
});

test('invariant: wording never changes a decision or an exit code', async () => {
  const dir = sampleRepo({ hooks: true, deep: false });
  const base = git(dir, 'rev-parse', 'HEAD');
  write(dir, 'test/math.check.mjs', `${fs.readFileSync(path.join(dir, 'test/math.check.mjs'), 'utf8')}// note\n`);
  proven(dir, 'annotate the test');
  const result = await createPocp({ cwd: dir }).verifyRange(`${base}..HEAD`, { rerun: 'all', requireCoverage: true });
  const decided = decideVerify(result);
  assert.equal(decided.outcome, 'waiting');
  // Rewrite every finding's text, including into words other cases use: the decision is the same.
  for (const text of ['', 'the mechanical check passed only locally', "didn't finish (timed out)", 'pocp-approve-policy']) {
    for (const f of [...result.commits.flatMap((c) => c.findings), ...(result.net?.findings || [])]) f.detail = text;
    const again = decideVerify(result);
    assert.equal(again.outcome, decided.outcome, text);
    assert.deepEqual(again.needs.map((n) => [n.label, n.files]), decided.needs.map((n) => [n.label, n.files]), text);
  }
  // The CLI's exit code follows the same decision.
  assert.equal(pocp(dir, ['verify', `${base}..HEAD`, ...CI]).code, VERIFY_EXIT.waiting);
});

test('invariant: an unknown policy key is never silent', () => {
  const dir = sampleRepo({ hooks: true, deep: false });
  const base = git(dir, 'rev-parse', 'HEAD');
  const cfg = JSON.parse(fs.readFileSync(path.join(dir, '.proof/config.json'), 'utf8'));
  write(dir, '.proof/config.json', JSON.stringify({ ...cfg, verify: { ...(cfg.verify || {}), fail_one: ['uncovered'] } }));
  git(dir, 'add', '-A');
  git(dir, '-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', 'misspell fail_on');
  const v = pocp(dir, ['verify', `${base}..HEAD`, ...CI]);
  assert.ok(v.json.commits[0].warnings.some((w) => w.includes('"verify.fail_one"')), 'verify reports it');
  assert.ok(pocp(dir, ['rules', 'check', '--json']).json.warnings.some((w) => w.includes('"verify.fail_one"')), 'rules check reports it');
});

// Testable once the change named in each lands.
test.todo('invariant: an unknown policy key makes a format-2 policy invalid (once policy format 2 exists)');
test.todo('invariant: each evaluation watches its own repository; a change in one is never missed because another is watched (once each evaluation has its own repository session)');
test.todo('invariant: a failed git read is never treated as an absent file (once each evaluation has its own repository session)');
test.todo('invariant: evidence is never reused across subjects or execution profiles (once evidence reuse is keyed by subject and profile)');
