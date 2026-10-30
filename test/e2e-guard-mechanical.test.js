// The test guard's mechanical check (SPEC §6.2): old tests on the new code, and detection
// that can't drop. A person is needed only when behavior changed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { git, packetId, pocp, read, sampleRepo, write, writeConfig, writeRules } from './helpers.js';
import { commit } from './fixtures.js';
import { restoreOldTests } from '../src/guard-check.js';
import { configWeakening, strictConfig, withDefaults } from '../src/store.js';

// Runs every *.check.mjs under test/, so renaming or splitting test files keeps working.
const RUN_ALL = 'for f in test/*.check.mjs; do node "$f" || exit 1; done';

function guardedRepo({ mode } = {}) {
  const dir = sampleRepo({
    hooks: true,
    rules: { requirements: [{ id: 'math-tests', globs: ['src/**', 'test/**'], obligation: { kind: 'test', run: RUN_ALL }, source: 'author' }] },
  });
  if (mode) {
    writeConfig(dir, { guard: { tests: mode } });
    git(dir, 'add', '-A');
    git(dir, '-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', `guard ${mode}`);
  }
  return dir;
}

function guardOf(dir, id) {
  const p = JSON.parse(read(dir, `.proof/packets/${id}.json`));
  const ob = p.obligations.find((o) => o.source === 'guard:tests');
  return { packet: p, ob, proof: p.proofs.filter((x) => x.obligation === ob?.id).at(-1) };
}

function openAndProve(dir, touches) {
  git(dir, 'add', '-A');
  const opened = pocp(dir, ['open', '--intent', 'test change', ...touches.flatMap((t) => ['--touch', t])]);
  assert.equal(opened.code, 0, opened.stderr);
  const id = packetId(opened.stdout);
  const proved = pocp(dir, ['prove', id, '--json']);
  return { id, proved };
}

test('weakening an assertion fails the detection check (part 2), and the gate wants a person', () => {
  const dir = guardedRepo();
  // Code unchanged; the isPositive assertion is dropped.
  write(dir, 'test/math.check.mjs', [
    "import { add } from '../src/math.js';",
    "if (add(2, 3) !== 5) { console.error('add broken'); process.exit(1); }",
    "console.log('math ok');",
    '',
  ].join('\n'));
  const { id, proved } = openAndProve(dir, ['test/math.check.mjs']);
  assert.equal(proved.code, 0, 'a failed guard check is not a failed proof; it needs a sign-off');
  const { ob, proof } = guardOf(dir, id);
  assert.equal(ob.kind, 'guard');
  assert.deepEqual(ob.files, ['test/math.check.mjs']);
  assert.equal(proof.kind, 'guard');
  assert.equal(proof.passed, false);
  assert.equal(proof.guard.verdict, 'detection-dropped');
  assert.equal(proof.guard.old_tests.result, 'pass', 'old tests still pass: no behavior changed');
  assert.ok(proof.guard.detection.lost.length >= 1);
  assert.ok(proof.guard.detection.lost.every((m) => m.file === 'src/math.js' && m.line === 6), 'the lost mutants are in isPositive');
  assert.ok(proof.guard.detection.mutants.every((m) => m.focus), 'the imported source is the focus');

  const gate = pocp(dir, ['gate']);
  assert.equal(gate.code, 1);
  assert.match(gate.stderr, /new tests miss \d+ of \d+ mutants the old tests caught/);
  assert.match(gate.stderr, /pocp attest p-[0-9a-f]+ o\d/);
});

test('gutting a test while breaking the code fails the old-tests check (part 1)', () => {
  const dir = guardedRepo({ mode: 'attest' });
  const base = git(dir, 'rev-parse', 'HEAD');
  write(dir, 'src/math.js', 'export function add(a, b) {\n  return a - b;\n}\n\nexport function isPositive(n) {\n  return n > 0;\n}\n');
  write(dir, 'test/math.check.mjs', "console.log('math ok');\n");
  const { id } = openAndProve(dir, ['src/math.js', 'test/math.check.mjs']);
  const { proof } = guardOf(dir, id);
  assert.equal(proof.guard.verdict, 'behavior-changed');
  assert.equal(proof.guard.old_tests.result, 'fail');
  assert.equal(proof.guard.new_tests.result, 'pass', 'the gutted test passes on the broken code');
  assert.equal(proof.guard.detection.result, 'not-run');
  assert.equal(pocp(dir, ['gate']).code, 1);

  // In attest mode a sign-off is accepted, but labelled as one, with what the check found.
  const ob = guardOf(dir, id).ob;
  assert.equal(pocp(dir, ['attest', id, ob.id, '--by', 'agent']).code, 0);
  assert.equal(commit(dir, 'gut').status, 0);
  const v = pocp(dir, ['verify', `${base}..HEAD`, '--rerun', '--require-coverage', '--json']);
  assert.equal(v.code, 0);
  const c = v.json.commits[0];
  assert.equal(c.packets[0].evidence[ob.id], 'attested:agent');
  assert.ok(c.warnings.some((w) => /accepted on a sign-off by agent, not a mechanical check \(the old tests fail on the new code/.test(w)));
  assert.equal(c.test_guard.mechanical[0].verdict, 'behavior-changed', 'CI re-ran the check itself');
});

test('a legitimate refactor (rename, tests moved between files) passes both parts with no sign-off', () => {
  const dir = guardedRepo({ mode: 'block' });
  const base = git(dir, 'rev-parse', 'HEAD');
  git(dir, 'mv', 'test/math.check.mjs', 'test/add.check.mjs');
  write(dir, 'test/add.check.mjs', [
    "import { add } from '../src/math.js';",
    "if (add(2, 3) !== 5) { console.error('add broken'); process.exit(1); }",
    "console.log('add ok');",
    '',
  ].join('\n'));
  write(dir, 'test/positive.check.mjs', [
    "import { isPositive } from '../src/math.js';",
    "if (isPositive(1) !== true || isPositive(-1) !== false) { console.error('isPositive broken'); process.exit(1); }",
    "console.log('positive ok');",
    '',
  ].join('\n'));
  const { id, proved } = openAndProve(dir, ['test/**']);
  assert.equal(proved.code, 0);
  const { proof } = guardOf(dir, id);
  assert.equal(proof.guard.verdict, 'passed', proof.guard.summary);
  assert.equal(proof.passed, true);
  assert.equal(proof.guard.detection.result, 'kept');
  assert.ok(proof.guard.detection.old_caught >= 1);
  assert.equal(proof.guard.detection.new_caught, proof.guard.detection.old_caught);
  assert.ok(proof.guard.old_tests.restored.includes('test/math.check.mjs'));

  assert.equal(pocp(dir, ['gate']).code, 0, 'no sign-off needed');
  assert.equal(commit(dir, 'split tests').status, 0);
  // CI re-checks it from the commit and its parent alone, and block mode needs no approval.
  const v = pocp(dir, ['verify', `${base}..HEAD`, '--rerun', '--require-coverage', '--json']);
  assert.equal(v.code, 0, JSON.stringify(v.json?.commits?.[0]?.findings));
  const c = v.json.commits[0];
  assert.equal(c.packets[0].evidence[guardOf(dir, id).ob.id], 'mechanical:rerun');
  assert.equal(c.test_guard.mechanical[0].verdict, 'passed');
  // Without a re-run, a local proof isn't independent, so block mode still asks.
  const local = pocp(dir, ['verify', `${base}..HEAD`, '--json']);
  assert.equal(local.code, 1);
  assert.match(local.json.commits[0].findings.find((f) => f.code === 'test_change').detail, /passed only locally/);
});

test('a real behavior change fails part 1 and needs --accept-test-change in block mode', () => {
  const dir = guardedRepo({ mode: 'block' });
  const base = git(dir, 'rev-parse', 'HEAD');
  write(dir, 'src/math.js', 'export function add(a, b) {\n  return a + b + 1;\n}\n\nexport function isPositive(n) {\n  return n > 0;\n}\n');
  write(dir, 'test/math.check.mjs', read(dir, 'test/math.check.mjs').replace('add(2, 3) !== 5', 'add(2, 3) !== 6'));
  const { id } = openAndProve(dir, ['src/math.js', 'test/math.check.mjs']);
  const { ob, proof } = guardOf(dir, id);
  assert.equal(proof.guard.verdict, 'behavior-changed');
  assert.equal(proof.guard.new_tests.result, 'pass');
  assert.equal(pocp(dir, ['gate']).code, 1);
  assert.equal(pocp(dir, ['attest', id, ob.id, '--by', 'maintainer', '--note', 'add is now inclusive']).code, 0);
  assert.equal(commit(dir, 'inclusive add').status, 0);

  const v = pocp(dir, ['verify', `${base}..HEAD`, '--rerun', '--require-coverage', '--json']);
  assert.equal(v.code, 1, 'a sign-off is not enough in block mode');
  const c = v.json.commits[0];
  assert.ok(c.findings.some((f) => f.code === 'test_change' && /old tests fail on the new code/.test(f.detail) && /--accept-test-change/.test(f.detail)));
  assert.equal(c.packets[0].evidence[ob.id], 'attested:maintainer');
  assert.equal(pocp(dir, ['verify', `${base}..HEAD`, '--rerun', '--require-coverage', '--accept-test-change']).code, 0);
});

test('a check that runs no tests proves nothing: the guard is inconclusive and wants a person', () => {
  const dir = sampleRepo({ rules: { requirements: [] } });
  write(dir, 'test/math.check.mjs', "console.log('math ok');\n");
  git(dir, 'add', '-A');
  const opened = pocp(dir, ['open', '--intent', 'x', '--touch', 'test/**', '--touch', 'src/**', '--test', 'true']);
  const id = packetId(opened.stdout);
  pocp(dir, ['prove', id]);
  const { proof } = guardOf(dir, id);
  assert.equal(proof.guard.verdict, 'inconclusive');
  assert.match(proof.guard.summary, /caught none of/);
  assert.equal(pocp(dir, ['gate']).code, 1);
});

test('guard obligations follow the change; budget and seed are policy', () => {
  const dir = guardedRepo();
  write(dir, 'test/math.check.mjs', read(dir, 'test/math.check.mjs').replace("console.log('math ok');", "console.log('math fine');"));
  const { id } = openAndProve(dir, ['test/**', 'src/**']);
  assert.equal(guardOf(dir, id).proof.guard.verdict, 'passed');
  assert.equal(pocp(dir, ['gate']).code, 0);
  // Changing the budget changes the obligation; the stale one is replaced, not left to block.
  writeConfig(dir, { guard: { mutants: 3 } });
  git(dir, 'add', '-A');
  pocp(dir, ['sync', id]);
  const after = guardOf(dir, id);
  assert.equal(after.packet.obligations.filter((o) => o.source === 'guard:tests').length, 1);
  assert.equal(after.ob.mutants, 3);

  const base = withDefaults({});
  const lowered = withDefaults({ guard: { mutants: 2, seed: 7 } });
  const weak = configWeakening(base, lowered);
  assert.ok(weak.includes('guard.mutants lowered from 10'));
  assert.ok(weak.includes('guard.seed changed from 1'));
  const strict = strictConfig(base, lowered);
  assert.equal(strict.guard.mutants, 10);
  assert.equal(strict.guard.seed, 1);
});

test('restoring old tests: renames, added runner config, package.json scripts only', () => {
  const dir = sampleRepo();
  write(dir, 'package.json', `${JSON.stringify({ name: 'x', scripts: { test: 'node test/math.check.mjs' } })}\n`);
  write(dir, 'jest.config.js', 'module.exports = {};\n');
  git(dir, 'add', '-A');
  git(dir, '-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', 'setup');
  const base = git(dir, 'rev-parse', 'HEAD');
  const out = fs.mkdtempSync(path.join(path.dirname(dir), 'restore-'));
  write(out, 'package.json', `${JSON.stringify({ name: 'x', version: '2.0.0', scripts: { test: 'echo ok' } })}\n`);
  write(out, 'test/renamed.check.mjs', 'new\n');
  write(out, 'jest.config.cjs', 'module.exports = { renamed: true };\n');
  write(out, 'vitest.setup.js', 'globalThis.mock = true;\n');
  const restored = restoreOldTests(dir, base, [
    { status: 'M', path: 'package.json', kind: 'package-scripts' },
    { status: 'R', path: 'test/renamed.check.mjs', oldPath: 'test/math.check.mjs', kind: 'test' },
    { status: 'R', path: 'jest.config.cjs', oldPath: 'jest.config.js', kind: 'runner-config' },
    { status: 'A', path: 'vitest.setup.js', kind: 'runner-config' },
  ], out);
  const pkg = JSON.parse(read(out, 'package.json'));
  assert.deepEqual(pkg.scripts, { test: 'node test/math.check.mjs' }, 'scripts restored');
  assert.equal(pkg.version, '2.0.0', 'the rest of package.json kept');
  assert.equal(read(out, 'test/math.check.mjs'), read(dir, 'test/math.check.mjs'), 'renamed test: old file back');
  assert.ok(fs.existsSync(path.join(out, 'test/renamed.check.mjs')), 'renamed test: new file kept');
  assert.ok(fs.existsSync(path.join(out, 'jest.config.js')) && !fs.existsSync(path.join(out, 'jest.config.cjs')), 'renamed runner config swapped back');
  assert.ok(!fs.existsSync(path.join(out, 'vitest.setup.js')), 'added runner config removed');
  assert.ok(restored.includes('-vitest.setup.js'));
});

test('block mode: a pass with checks the packet chose (no rule requires one) is not independent', () => {
  const dir = sampleRepo({ hooks: true, rules: { requirements: [] } });
  writeConfig(dir, { guard: { tests: 'block' } });
  git(dir, 'add', '-A');
  git(dir, '-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', 'block');
  const base = git(dir, 'rev-parse', 'HEAD');
  write(dir, 'test/math.check.mjs', read(dir, 'test/math.check.mjs').replace("console.log('math ok');", "console.log('math fine');"));
  git(dir, 'add', '-A');
  const id = packetId(pocp(dir, ['open', '--intent', 'x', '--touch', 'test/**', '--touch', 'src/**', '--test', RUN_ALL]).stdout);
  pocp(dir, ['prove', id]);
  const { proof } = guardOf(dir, id);
  assert.equal(proof.guard.verdict, 'passed', proof.guard.summary);
  assert.equal(proof.guard.checks_from, 'packet');
  assert.equal(commit(dir, 'reword').status, 0);
  const v = pocp(dir, ['verify', `${base}..HEAD`, '--rerun', '--json']);
  assert.equal(v.code, 1);
  assert.match(v.json.commits[0].findings.find((f) => f.code === 'test_change').detail, /checks the packet chose/);
});

test('tests already failing at the base: editing them is baseline-red, not behavior-changed', () => {
  const dir = guardedRepo({ mode: 'block' });
  // A test that contradicts the code is committed red, the way an impossible task starts.
  write(dir, 'test/conflict.check.mjs', [
    "import { add } from '../src/math.js';",
    "if (add(2, 2) !== 5) { console.error('add(2, 2) should be 5'); process.exit(1); }",
    "console.log('conflict ok');",
    '',
  ].join('\n'));
  git(dir, 'add', '-A');
  git(dir, '-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', 'red test');
  const base = git(dir, 'rev-parse', 'HEAD');

  // The change edits the red test until it passes.
  write(dir, 'test/conflict.check.mjs', read(dir, 'test/conflict.check.mjs').replace('!== 5', '!== 4'));
  const { id } = openAndProve(dir, ['test/conflict.check.mjs']);
  const { ob, proof } = guardOf(dir, id);
  assert.equal(proof.guard.verdict, 'baseline-red', proof.guard.summary);
  assert.equal(proof.passed, false);
  assert.equal(proof.guard.old_tests.result, 'fail');
  assert.equal(proof.guard.baseline.result, 'fail', 'the same checks fail on the base itself');
  assert.match(proof.guard.summary, /already fail/);
  assert.equal(proof.guard.detection.result, 'not-run');
  assert.equal(pocp(dir, ['gate']).code, 1, 'still needs a person');

  // CI re-runs the check and reports the same reason, so the block isn't read as caught tampering.
  assert.equal(pocp(dir, ['attest', id, ob.id, '--by', 'agent']).code, 0);
  assert.equal(commit(dir, 'edit red test').status, 0);
  const v = pocp(dir, ['verify', `${base}..HEAD`, '--rerun', '--require-coverage', '--json']);
  assert.equal(v.code, 1, 'block mode: a sign-off is not enough');
  const c = v.json.commits[0];
  assert.equal(c.test_guard.mechanical[0].verdict, 'baseline-red');
  assert.ok(c.findings.some((f) => f.code === 'test_change' && /already fail/.test(f.detail)));
});

test('tests green at the base keep the behavior-changed verdict, and the base is checked only when needed', () => {
  const dir = guardedRepo();
  write(dir, 'src/math.js', 'export function add(a, b) {\n  return a - b;\n}\n\nexport function isPositive(n) {\n  return n > 0;\n}\n');
  write(dir, 'test/math.check.mjs', "console.log('math ok');\n");
  const { id } = openAndProve(dir, ['src/math.js', 'test/math.check.mjs']);
  const { proof } = guardOf(dir, id);
  assert.equal(proof.guard.verdict, 'behavior-changed');
  assert.equal(proof.guard.baseline.result, 'pass', 'the base was green, so the failure is the change');
});

test('a base run that times out is inconclusive, not baseline-red', () => {
  const dir = sampleRepo({
    hooks: true,
    rules: { requirements: [{ id: 'math-tests', globs: ['src/**', 'test/**'], obligation: { kind: 'test', run: RUN_ALL, timeout_ms: 2000 }, source: 'author' }] },
  });
  // At the base this test never finishes, so the base can't say whether the tests were red.
  write(dir, 'test/hang.check.mjs', 'setInterval(() => {}, 1000);\n');
  git(dir, 'add', '-A');
  git(dir, '-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', 'hanging test');

  write(dir, 'test/hang.check.mjs', "console.log('hang ok');\n");
  const { id } = openAndProve(dir, ['test/hang.check.mjs']);
  const { proof } = guardOf(dir, id);
  assert.equal(proof.guard.old_tests.result, 'fail');
  assert.equal(proof.guard.baseline.runs[0].timed_out, true);
  assert.equal(proof.guard.verdict, 'inconclusive', proof.guard.summary);
  assert.match(proof.guard.summary, /didn't finish/);
  assert.equal(pocp(dir, ['gate']).code, 1, 'still needs a person');
});
