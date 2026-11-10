// A test change whose CI re-run disagrees with a recorded local pass stays approvable: the
// re-run verdict decides, and a failing required check still blocks whatever is approved.
import test from 'node:test';
import assert from 'node:assert/strict';
import { git, pocp, read, sampleRepo, write } from './helpers.js';

function recordedLocalPass({ failingRequiredCheck = false } = {}) {
  const dir = sampleRepo({ hooks: true, deep: true, rules: {
    requirements: [{ id: 'checks', globs: ['src/**', 'test/**', 'scripts/**'], obligation: {
      kind: 'test', run: 'node test/math.check.mjs && node scripts/release-check.mjs',
    } }],
  } });
  // No mutation sites: CI's deterministic result will be inconclusive, not unfinished.
  write(dir, 'src/math.js', "export const answer = 'ok';\n");
  write(dir, 'test/math.check.mjs', "import { answer } from '../src/math.js';\nif (answer !== 'ok') process.exit(1);\n");
  write(dir, 'scripts/release-check.mjs', 'process.exit(0);\n');
  git(dir, 'add', '-A');
  git(dir, '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'constant-value baseline');
  const base = git(dir, 'rev-parse', 'HEAD');
  write(dir, 'test/math.check.mjs', `${read(dir, 'test/math.check.mjs')}\n// clarify the check\n`);
  if (failingRequiredCheck) write(dir, 'scripts/release-check.mjs', 'process.exit(1);\n');
  git(dir, 'add', '-A');
  const fixed = pocp(dir, ['fix', '--json']);
  const id = fixed.json.actions.find((action) => action.packet)?.packet;
  assert.ok(id, fixed.stdout);
  const file = `.proof/packets/${id}.json`;
  const packet = JSON.parse(read(dir, file));
  // Model a previously passing local sample, as can legitimately happen when CI uses
  // its independent range-derived seed. Local proof records are untrusted in CI.
  for (const proof of packet.proofs) {
    proof.passed = true;
    delete proof.deferred;
    if (proof.kind === 'guard') {
      proof.guard = { ...proof.guard, passed: true, verdict: 'passed', summary: 'recorded local pass' };
    } else proof.exit = 0;
  }
  packet.state = 'proven';
  write(dir, file, `${JSON.stringify(packet, null, 2)}\n`);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'test wording update');
  const head = git(dir, 'rev-parse', 'HEAD');
  const verify = (...flags) => pocp(dir, ['verify', `${base}..${head}`, '--rerun', '--require-coverage', '--json', ...flags]);
  return { head, verify };
}

test('a local guard pass followed by an inconclusive CI sample has a working test-approval path', () => {
  const { head, verify } = recordedLocalPass();
  const waiting = verify();
  assert.equal(waiting.code, 1);
  assert.equal(waiting.json.approval.only, true, waiting.stdout);
  assert.deepEqual(waiting.json.approval.needs.map((entry) => entry.label), ['pocp-approve-tests']);
  const wrongApproval = verify(`--accept-inconclusive=${head}`);
  assert.equal(wrongApproval.code, 1, 'an unfinished-run approval does not approve a completed inconclusive sample');
  const approved = verify(`--accept-test-change=${head}`);
  assert.equal(approved.code, 0, approved.stdout);
  assert.ok(approved.json.commits[0].reruns.some((run) => run.kind === 'guard' && run.verdict === 'inconclusive'), 'the unsuccessful mechanical result remains visible');
});

test('a test approval cannot waive a failing required runnable check, even with forged local passes', () => {
  const { head, verify } = recordedLocalPass({ failingRequiredCheck: true });
  const result = verify(`--accept-test-change=${head}`);
  assert.equal(result.code, 1, result.stdout);
  assert.equal(result.json.approval.only, false, result.stdout);
  // The required check's failure is reported on the range (where the tip's checks re-run).
  const all = [...result.json.commits[0].findings, ...(result.json.findings || [])];
  assert.ok(all.some((finding) => finding.code === 'rerun_failed' && finding.blocking && /release-check/.test(finding.detail)), result.stdout);
});
