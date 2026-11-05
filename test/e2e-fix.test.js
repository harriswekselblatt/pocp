// Friction: every block explains itself, and `pocp fix` takes the mechanical steps.
// Security doesn't move: fix never signs off for anyone, and a test or policy change still
// needs a maintainer in CI.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { git, pocp, read, sampleRepo, write, writeConfig, writeRules } from './helpers.js';
import { commit } from './fixtures.js';

const RUN_ALL = 'for f in test/*.check.mjs; do node "$f" || exit 1; done';

function guardedRepo(mode) {
  const dir = sampleRepo({
    hooks: true,
    rules: { requirements: [{ id: 'math-tests', globs: ['src/**', 'test/**'], obligation: { kind: 'test', run: RUN_ALL }, source: 'author' }] },
  });
  writeConfig(dir, { guard: { tests: mode, mutants: 4 } });
  git(dir, 'add', '-A');
  git(dir, '-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', `guard ${mode}`);
  return dir;
}

const packetFile = (dir, id) => JSON.parse(read(dir, `.proof/packets/${id}.json`));

test('a blocked gate says what is wrong, why, and the next command', () => {
  const dir = sampleRepo({ hooks: true });
  write(dir, 'src/math.js', read(dir, 'src/math.js').replace('a + b', 'b + a'));
  git(dir, 'add', '-A');
  const g = pocp(dir, ['gate', '--json']);
  assert.equal(g.code, 1);
  const r = g.json.remedies.find((x) => x.code === 'no_packet');
  assert.ok(r, JSON.stringify(g.json.remedies));
  assert.match(r.what, /src\/math\.js/);
  assert.match(r.why, /rule requires checks/);
  assert.match(r.next, /^pocp fix/);
  assert.equal(r.by, 'pocp fix');
  const human = pocp(dir, ['gate']);
  assert.match(human.stderr, /what: 1 staged file\(s\) are not covered/);
  assert.match(human.stderr, /why: /);
  assert.match(human.stderr, /next: pocp fix/);
  assert.match(human.stderr, /"pocp fix" takes every step/);
});

test('pocp fix opens the packet with its required checks, proves it, and the commit goes through', () => {
  const dir = sampleRepo({ hooks: true });
  write(dir, 'src/math.js', read(dir, 'src/math.js').replace('a + b', 'b + a'));
  git(dir, 'add', '-A');
  const f = pocp(dir, ['fix', '--intent', 'commutative add', '--json']);
  assert.equal(f.code, 0, f.stderr);
  assert.equal(f.json.ok, true);
  const opened = f.json.actions.find((a) => a.action === 'open');
  assert.equal(opened.checks.length, 1);
  assert.match(opened.checks[0], /^o1 \(.*math-tests.*\)$/);
  assert.ok(f.json.actions.some((a) => a.action === 'prove' && a.ran === 1));
  assert.equal(packetFile(dir, opened.packet).intent, 'commutative add');
  assert.equal(commit(dir, 'commutative add').status, 0);
  assert.match(git(dir, 'log', '-1', '--format=%B'), /Proof-Of-Change: p-/);
});

test('fix twice on the same code runs nothing the second time', () => {
  const dir = sampleRepo({ hooks: true });
  write(dir, 'src/math.js', read(dir, 'src/math.js').replace('a + b', 'b + a'));
  git(dir, 'add', '-A');
  assert.equal(pocp(dir, ['fix', '--intent', 'x']).code, 0);
  const again = pocp(dir, ['fix', '--json']);
  assert.equal(again.code, 0);
  assert.equal(again.json.actions.length, 0, 'the gate already passes');
  const p = pocp(dir, ['prove', '--json']);
  assert.equal(p.json.ran, 0);
});

test('fix widens the packet the author is working in instead of opening another', () => {
  const dir = sampleRepo({ hooks: true, rules: { triggers: { globs: [] }, requirements: [{ id: 'math-tests', glob: 'src/**', obligation: { kind: 'test', run: 'node test/math.check.mjs' }, source: 'author' }] } });
  write(dir, 'src/math.js', read(dir, 'src/math.js').replace('a + b', 'b + a'));
  git(dir, 'add', '-A');
  const first = pocp(dir, ['fix', '--intent', 'x', '--json']);
  const id = first.json.actions.find((a) => a.action === 'open').packet;
  write(dir, 'src/extra.js', 'export const one = 1;\n');
  git(dir, 'add', '-A');
  const second = pocp(dir, ['fix', '--json']);
  assert.equal(second.code, 0, second.stderr);
  assert.deepEqual(second.json.actions.find((a) => a.action === 'widen')?.packet, id);
  assert.ok(!second.json.actions.some((a) => a.action === 'open'));
});

test('a failing check is reported with its log, and fix does not run it again on the same code', () => {
  const dir = sampleRepo({ hooks: true });
  write(dir, 'src/math.js', read(dir, 'src/math.js').replace('a + b', 'a - b'));
  git(dir, 'add', '-A');
  const f = pocp(dir, ['fix', '--intent', 'broken', '--json']);
  assert.equal(f.code, 1);
  const failed = f.json.needs_agent.find((x) => x.code === 'failed_proof');
  assert.match(failed.what, /o1 fails on this exact code · log \.proof\/runs\/r-/);
  assert.match(failed.next, /fix the code \(not the tests\)/);
  const again = pocp(dir, ['fix', '--json']);
  assert.equal(again.code, 1);
  assert.equal(again.json.actions.find((a) => a.action === 'prove')?.ran ?? 0, 0, 'not run again on unchanged code');
  assert.match(again.json.needs_agent[0].what, /failed here before/);
  const human = pocp(dir, ['fix']);
  assert.match(human.stderr, /pocp fix: needs you/);
});

test('with no rule naming a check, fix uses the repo\'s required CI check, or asks for --test', () => {
  const dir = sampleRepo({ hooks: true, rules: { triggers: { globs: [{ id: 'deploy', glob: 'deploy.sh', require_packet: true }] }, requirements: [] } });
  write(dir, 'deploy.sh', 'echo deploy\n');
  git(dir, 'add', '-A');
  const asks = pocp(dir, ['fix', '--json']);
  assert.equal(asks.code, 1);
  assert.equal(asks.json.needs_agent[0].code, 'no_check');
  assert.match(asks.json.needs_agent[0].next, /pocp fix --test/);
  const withTest = pocp(dir, ['fix', '--test', 'node test/math.check.mjs', '--json']);
  assert.equal(withTest.code, 0, withTest.stderr);
  assert.equal(withTest.json.actions.find((a) => a.action === 'open').check_from, '--test');

  const dir2 = sampleRepo({ hooks: true, rules: { triggers: { globs: [{ id: 'deploy', glob: 'deploy.sh', require_packet: true }] }, requirements: [] } });
  writeConfig(dir2, { verify: { require_ci: ['node test/math.check.mjs'] } });
  git(dir2, 'add', '-A');
  git(dir2, '-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', 'ci');
  write(dir2, 'deploy.sh', 'echo deploy\n');
  git(dir2, 'add', '-A');
  const auto = pocp(dir2, ['fix', '--json']);
  assert.equal(auto.code, 0, auto.stderr);
  assert.match(auto.json.actions.find((a) => a.action === 'open').check_from, /verify\.require_ci/);
});

test('fix proves a snapshot of the staged code when the working folder differs', () => {
  const dir = sampleRepo({ hooks: true });
  write(dir, 'src/math.js', read(dir, 'src/math.js').replace('a + b', 'b + a'));
  git(dir, 'add', '-A');
  write(dir, 'src/math.js', `${read(dir, 'src/math.js')}// not staged\n`);
  const f = pocp(dir, ['fix', '--intent', 'x', '--json']);
  assert.equal(f.code, 0, f.stderr);
  assert.equal(f.json.actions.find((a) => a.action === 'prove').mode, 'snapshot');
});

test('block mode: fix hands a failed test-change check to CI, never signs off, and CI needs the label', () => {
  const dir = guardedRepo('block');
  const base = git(dir, 'rev-parse', 'HEAD');
  // A real behavior change: the old test fails on the new code.
  write(dir, 'src/math.js', 'export function add(a, b) {\n  return a + b + 1;\n}\n\nexport function isPositive(n) {\n  return n > 0;\n}\n');
  write(dir, 'test/math.check.mjs', read(dir, 'test/math.check.mjs').replace('add(2, 3) !== 5', 'add(2, 3) !== 6'));
  git(dir, 'add', '-A');
  const f = pocp(dir, ['fix', '--intent', 'inclusive add', '--json']);
  assert.equal(f.code, 0, f.stderr);
  const id = f.json.actions.find((a) => a.action === 'open').packet;
  assert.ok(f.json.actions.some((a) => a.action === 'defer'));
  assert.equal(f.json.needs_person[0].code, 'test_change');
  assert.match(f.json.needs_person[0].next, /pocp-approve-tests/);
  assert.match(f.json.advice, /Do not squash, force-push/);
  const p = packetFile(dir, id);
  assert.equal(p.attestations.length, 0, 'fix never signs off');
  assert.equal(p.deferrals.length, 1);
  const human = pocp(dir, ['fix']);
  assert.match(human.stdout, /CI requires human approval/);
  assert.match(human.stdout, /the one action: a maintainer adds the `pocp-approve-tests` label/);

  const g = pocp(dir, ['gate']);
  assert.equal(g.code, 0);
  assert.match(g.stdout, /CI requires human approval/);
  assert.equal(commit(dir, 'inclusive add').status, 0);

  const v = pocp(dir, ['verify', `${base}..HEAD`, '--rerun', '--require-coverage']);
  assert.equal(v.code, 1, 'the hand-over is not an approval');
  assert.match(v.stdout, /test_change: .*next: a maintainer reviews the test change and adds the `pocp-approve-tests` label/);
  assert.match(v.stdout, /Do not squash, force-push/);
  const vj = pocp(dir, ['verify', `${base}..HEAD`, '--rerun', '--require-coverage', '--json']);
  const findings = vj.json.commits[0].findings.filter((x) => x.blocking).map((x) => x.code);
  assert.deepEqual(findings, ['test_change'], 'only the approval is missing; no self sign-off is asked for');
  assert.equal(pocp(dir, ['verify', `${base}..HEAD`, '--rerun', '--require-coverage', '--accept-test-change']).code, 0);
});

test('attest mode: fix leaves the test-change sign-off to a person', () => {
  const dir = guardedRepo('attest');
  write(dir, 'src/math.js', 'export function add(a, b) {\n  return a + b + 1;\n}\n\nexport function isPositive(n) {\n  return n > 0;\n}\n');
  write(dir, 'test/math.check.mjs', read(dir, 'test/math.check.mjs').replace('add(2, 3) !== 5', 'add(2, 3) !== 6'));
  git(dir, 'add', '-A');
  const f = pocp(dir, ['fix', '--intent', 'x', '--json']);
  assert.equal(f.code, 1);
  assert.ok(!f.json.actions.some((a) => a.action === 'defer'));
  const person = f.json.needs_person.find((x) => x.code === 'test_change');
  assert.match(person.next, /a person who reviewed the test change runs: pocp attest p-\w+ o\d+ --by <their name>/);
  const id = f.json.actions.find((a) => a.action === 'open').packet;
  assert.equal(packetFile(dir, id).attestations.length, 0);
  assert.equal(pocp(dir, ['gate']).code, 1);
});

test('a hand-over to CI only exists in block mode', () => {
  const dir = guardedRepo('attest');
  write(dir, 'test/math.check.mjs', "console.log('math ok');\n");
  git(dir, 'add', '-A');
  const f = pocp(dir, ['fix', '--intent', 'x', '--json']);
  assert.ok(!f.json.actions.some((a) => a.action === 'defer'));
});

test('loosening policy: the gate says CI will need the policy label', () => {
  const dir = sampleRepo({ hooks: true });
  writeRules(dir, { requirements: [] });
  git(dir, 'add', '-A');
  const g = pocp(dir, ['gate', '--json']);
  assert.ok(g.json.warnings.some((w) => w.code === 'awaiting_policy_approval' && /requirement/.test(w.detail)), JSON.stringify(g.json.warnings));
  assert.ok(g.json.pending_approvals.some((x) => /pocp-approve-policy/.test(x.next)));
});

test('fix with nothing staged says so', () => {
  const dir = sampleRepo({ hooks: true });
  const f = pocp(dir, ['fix']);
  assert.equal(f.code, 0);
  assert.match(f.stdout, /nothing is staged/);
});
