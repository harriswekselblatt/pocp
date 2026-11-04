// A required CI check (verify.require_ci) whose re-run times out says nothing about the code:
// it's inconclusive (exit 5 with --exit-detail, a yellow wait), not a failure. Found live: a
// suite that hung in CI read as red because require_ci reported it as ci_failed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { VERIFY_EXIT } from '../src/approvals.js';
import { git, pocp, read, sampleRepo, write } from './helpers.js';

const CHECK = 'node test/math.check.mjs';
const RULES = { requirements: [{ id: 'math-tests', globs: ['src/**', 'test/**'], obligation: { kind: 'test', run: CHECK, timeout_ms: 3000 }, source: 'author' }] };

function setup({ hangIn = 'verify', requireCi = true } = {}) {
  const dir = sampleRepo({ rules: RULES, deep: false, hooks: true });
  if (requireCi) {
    const cfg = JSON.parse(read(dir, '.proof/config.json'));
    // require_ci re-runs the command with the default run.timeout_ms: keep it short here.
    write(dir, '.proof/config.json', `${JSON.stringify({ ...cfg, verify: { ...(cfg.verify || {}), require_ci: [CHECK] }, run: { ...cfg.run, timeout_ms: 3000 } }, null, 2)}\n`);
    git(dir, 'add', '-A');
    git(dir, '-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', 'require the check in CI');
  }
  const base = git(dir, 'rev-parse', 'HEAD');
  // The new code hangs only when POCP_TEST_HANG is set: the local proof passes, verify's re-run hangs.
  write(dir, 'src/math.js', `if (process.env.POCP_TEST_HANG === '${hangIn}') { setInterval(() => {}, 1000); await new Promise(() => {}); }\n${read(dir, 'src/math.js')}`);
  git(dir, 'add', '-A');
  const fix = pocp(dir, ['fix', '--intent', 'hang only in verify']);
  assert.equal(fix.code, 0, fix.stdout + fix.stderr);
  const c = spawnSync('git', ['commit', '-q', '-m', 'hang only in verify'], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  assert.equal(c.status, 0, c.stderr);
  return { dir, range: `${base}..HEAD` };
}

const codes = (r) => [...new Set([...(r.json?.commits || []), ...(r.json?.net ? [r.json.net] : [])].flatMap((c) => c.findings || []).filter((f) => f.blocking).map((f) => f.code))];

test('a required CI check whose re-run times out is inconclusive (exit 5), not a failure', () => {
  const { dir, range } = setup();
  const r = pocp(dir, ['verify', range, '--rerun', '--json', '--exit-detail'], { env: { POCP_TEST_HANG: 'verify' } });
  assert.equal(r.code, VERIFY_EXIT.inconclusive, r.stdout);
  assert.deepEqual(codes(r), ['ci_unfinished']);
  assert.equal(r.json.approval.outcome, 'inconclusive');
  // No label clears it: only a re-run that finishes.
  const labelled = pocp(dir, ['verify', range, '--rerun', '--json', '--exit-detail', '--accept-inconclusive', '--accept-test-change', '--accept-policy-change'], { env: { POCP_TEST_HANG: 'verify' } });
  assert.equal(labelled.code, VERIFY_EXIT.inconclusive, labelled.stdout);
  // The re-run that finishes passes.
  assert.equal(pocp(dir, ['verify', range, '--rerun', '--exit-detail']).code, 0);
});

test('ci_unfinished blocks whenever ci_failed does, even with an explicit fail_on list', () => {
  const { dir, range } = setup();
  const cfg = JSON.parse(read(dir, '.proof/config.json'));
  // A base whose fail_on lists ci_failed but predates ci_unfinished.
  write(dir, '.proof/config.json', `${JSON.stringify({ ...cfg, verify: { ...cfg.verify, fail_on: ['ci_failed', 'rerun_failed'] } }, null, 2)}\n`);
  git(dir, 'add', '-A');
  git(dir, '-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', 'explicit fail_on');
  const base = git(dir, 'rev-parse', 'HEAD~2');
  const r = pocp(dir, ['verify', `${base}..HEAD~1`, '--rerun', '--json', '--exit-detail', '--policy-from', 'HEAD'], { env: { POCP_TEST_HANG: 'verify' } });
  assert.notEqual(r.code, 0, r.stdout);
  assert.ok(codes(r).includes('ci_unfinished'), JSON.stringify(codes(r)));
});
