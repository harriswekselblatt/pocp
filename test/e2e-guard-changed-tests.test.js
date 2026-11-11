// changed_test_command: in fast mode, the test guard runs only the old versions of the edited
// test files instead of the whole check. It's a shortcut that can only pass: any failure,
// timeout, empty run or unusual change runs the whole check, as before.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { git, packetId, pocp, read, tmpRepo, write, writeRules, reviewEveryTestEdit } from './helpers.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { changedTestPlan, countTests, fileLevelOnly, importedByOtherTests, shellQuote } from '../src/guard-check.js';
import { normalizeObligation, obligationDigest } from '../src/obligations.js';
import { policyWeakening } from '../src/rules.js';

const ADD_TEST = [
  "import { test } from 'node:test';",
  "import assert from 'node:assert/strict';",
  "import { add } from '../src/math.js';",
  '',
  "test('adds', () => {",
  '  assert.equal(add(2, 3), 5);',
  '  assert.equal(add(-1, 1), 0);',
  '});',
  '',
].join('\n');
const OTHER_TEST = [
  "import { test } from 'node:test';",
  "import assert from 'node:assert/strict';",
  "import { isPositive } from '../src/math.js';",
  "test('positive', () => assert.equal(isPositive(1), true));",
  "test('zero', () => assert.equal(isPositive(0), false));",
  '',
].join('\n');

/** A fast-mode project: two test files, one rule running all of them, optionally with a changed_test_command. */
function project({ command = ['node', '--test', '{tests}'], helper = false } = {}) {
  const dir = tmpRepo();
  write(dir, 'package.json', '{ "type": "module" }\n');
  write(dir, 'src/math.js', 'export const add = (a, b) => a + b;\nexport const isPositive = (n) => n > 0;\n');
  write(dir, 'test/add.test.js', helper ? ADD_TEST.replace("import { add } from '../src/math.js';", "import { add } from './support.js';") : ADD_TEST);
  if (helper) write(dir, 'test/support.js', "export { add } from '../src/math.js';\n");
  write(dir, 'test/other.test.js', OTHER_TEST);
  const init = pocp(dir, ['init']);
  assert.equal(init.code, 0, init.stderr);
  // These tests use an added test as a vehicle for which old tests run; keep it reviewed.
  reviewEveryTestEdit(dir);
  const obligation = { kind: 'test', run: 'node --test test/*.test.js', ...(command ? { changed_test_command: command } : {}) };
  writeRules(dir, { requirements: [{ id: 'tests', globs: ['src/**', 'test/**'], obligation }] });
  git(dir, 'add', '-A');
  git(dir, '-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', 'start');
  return dir;
}

/** Open a packet for the staged change, prove it, and return the guard's result. */
function guardFor(dir, touches) {
  git(dir, 'add', '-A');
  const opened = pocp(dir, ['open', '--intent', 'test change', ...touches.flatMap((t) => ['--touch', t])]);
  assert.equal(opened.code, 0, opened.stderr);
  const id = packetId(opened.stdout);
  const proved = pocp(dir, ['prove', id, '--json']);
  const p = JSON.parse(read(dir, `.proof/packets/${id}.json`));
  const ob = p.obligations.find((o) => o.source === 'guard:tests');
  assert.ok(ob, `a guard obligation: ${proved.stdout}${proved.stderr}`);
  return p.proofs.filter((x) => x.obligation === ob.id).at(-1).guard;
}

const addLines = (dir) => write(dir, 'test/add.test.js', `${ADD_TEST}test('adds zero', () => {\n  assert.equal(add(0, 0), 0);\n});\n`);

test('an added test case runs only the old version of the edited file, which passes (fast mode: a person still reviews it)', () => {
  const dir = project();
  addLines(dir);
  const guard = guardFor(dir, ['test/add.test.js']);
  assert.equal(guard.old_tests.result, 'pass');
  assert.equal(guard.verdict, 'needs-review', guard.summary);
  assert.equal(guard.old_tests.scope, 'changed-tests');
  const ct = guard.old_tests.changed_tests;
  assert.equal(ct.result, 'pass');
  assert.deepEqual(ct.files, ['test/add.test.js']);
  assert.deepEqual(ct.runs[0].args, ['node', '--test', 'test/add.test.js'], 'only the edited file, as its own argument');
  assert.equal(ct.runs[0].tests.passed, 1, 'the OLD version: one test, not the two it has now, and not other.test.js');
  assert.match(guard.summary, /the old versions of the edited tests \(test\/add\.test\.js\) pass on the new code/);
});

test('the edited test is never what runs: a weakened test on broken code is still a behavior change', () => {
  const dir = project();
  write(dir, 'src/math.js', 'export const add = (a, b) => Math.abs(a) + b;\nexport const isPositive = (n) => n > 0;\n');
  write(dir, 'test/add.test.js', ADD_TEST.replace('add(-1, 1), 0)', 'add(-1, 1), 2)'));
  const guard = guardFor(dir, ['src/math.js', 'test/add.test.js']);
  const ct = guard.old_tests.changed_tests;
  assert.equal(ct.result, 'escalated', JSON.stringify(ct));
  assert.deepEqual(ct.runs.map((r) => [r.side, r.outcome]), [['new-code', 'fail'], ['base', 'pass']], 'old file fails on the new code, passes on the base');
  assert.deepEqual(ct.runs[0].args, ['node', '--test', 'test/add.test.js']);
  assert.equal(guard.old_tests.scope, 'changed-tests');
  assert.ok(guard.old_tests.runs.every((r) => r.scope === 'changed-tests'), 'no whole-suite run');
  assert.equal(guard.baseline.runs.length, 0, 'no whole-suite run on the base either');
  assert.equal(guard.verdict, 'behavior-changed', guard.summary);
  assert.match(guard.summary, /the old tests fail on the new code \(the old versions of test\/add\.test\.js, run alone, fail on the new code and pass on the base\); failing: adds/);
});

test('old edited tests failing on the base too: the shortcut never decides, the whole check does (baseline-red)', () => {
  const dir = project();
  // The base is already red: add() is wrong and its test says so.
  write(dir, 'src/math.js', 'export const add = (a, b) => a * b;\nexport const isPositive = (n) => n > 0;\n');
  git(dir, 'add', '-A');
  git(dir, '-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', 'broken base');
  // The change rewrites the test to match the wrong behavior.
  write(dir, 'test/add.test.js', ADD_TEST.replace('add(2, 3), 5)', 'add(2, 3), 6)').replace('add(-1, 1), 0)', 'add(-1, 1), -1)'));
  const guard = guardFor(dir, ['test/add.test.js']);
  const ct = guard.old_tests.changed_tests;
  assert.equal(ct.result, 'not-used');
  assert.match(ct.reason, /fail on the new code, and on the base .* fails too; running the whole check instead/);
  assert.equal(guard.old_tests.scope, undefined);
  assert.equal(guard.verdict, 'baseline-red', guard.summary);
});

test('a test helper edit runs the whole check', () => {
  const dir = project({ helper: true });
  write(dir, 'test/support.js', "export { add } from '../src/math.js';\n// tidied\n");
  const guard = guardFor(dir, ['test/support.js']);
  assert.equal(guard.old_tests.changed_tests.result, 'not-used');
  assert.match(guard.old_tests.changed_tests.reason, /test\/support\.js is named in test\/add\.test\.js, so it may be test setup/);
  assert.equal(guard.old_tests.scope, undefined);
  assert.equal(guard.old_tests.result, 'pass');
});

test('a rule without changed_test_command runs the whole check', () => {
  const dir = project({ command: null });
  addLines(dir);
  const guard = guardFor(dir, ['test/add.test.js']);
  assert.match(guard.old_tests.changed_tests.reason, /check \S+ has no changed_test_command/);
  assert.equal(guard.old_tests.scope, undefined);
  assert.equal(guard.old_tests.result, 'pass');
  assert.equal(guard.verdict, 'needs-review', guard.summary);
});

test('a command that runs no tests is not a pass: the whole check decides', () => {
  const dir = project({ command: ['node', '--test', '--test-name-pattern=^no-such-test$', '{tests}'] });
  addLines(dir);
  const guard = guardFor(dir, ['test/add.test.js']);
  assert.equal(guard.old_tests.changed_tests.result, 'not-used');
  assert.match(guard.old_tests.changed_tests.reason, /no test passed/);
  assert.equal(guard.old_tests.scope, undefined);
  assert.equal(guard.old_tests.result, 'pass', 'the whole check still ran and passed');
  assert.equal(guard.verdict, 'needs-review', guard.summary);
});

test('changedTestPlan: only modified ordinary test files, only rule checks that have a command', () => {
  const rule = { id: 'o1', source: 'rule:tests', run: 'npm test', changed_test_command: ['node', '--test', '{tests}'] };
  const M = (p) => ({ path: p, status: 'M', kind: 'test' });
  assert.deepEqual(changedTestPlan([M('test/b.js'), M('test/a.js')], [rule]).files, ['test/a.js', 'test/b.js']);
  assert.match(changedTestPlan([M('test/a.js'), { path: 'test/new.js', status: 'A', kind: 'test' }], [rule]).skip, /test\/new\.js is a test file that was added/, 'an added file has no base version: whole check');
  assert.match(changedTestPlan([{ path: 'test/a.js', status: 'D', kind: 'test' }], [rule]).skip, /deleted/);
  assert.match(changedTestPlan([{ path: 'test/b.js', oldPath: 'test/a.js', status: 'R', kind: 'test' }], [rule]).skip, /renamed/);
  assert.match(changedTestPlan([{ path: 'jest.config.js', status: 'M', kind: 'runner-config' }], [rule]).skip, /test setup/);
  assert.match(changedTestPlan([{ path: 'package.json', status: 'M', kind: 'package-scripts' }], [rule]).skip, /test setup/);
  assert.match(changedTestPlan([M('test/a.js')], []).skip, /no check to run the edited tests with/, 'nothing to run is never a pass');
  assert.match(changedTestPlan([M('test/a.js')], [{ ...rule, source: 'author' }]).skip, /doesn't come from a rule/, 'a packet can\'t supply the command');
  assert.match(changedTestPlan([M('test/a.js')], [rule, { id: 'o2', source: 'rule:other', run: 'make test' }]).skip, /o2 has no changed_test_command/);
  // Same command twice runs once; a cwd makes paths relative to it.
  assert.equal(changedTestPlan([M('test/a.js')], [rule, { ...rule, id: 'o2' }]).commands.length, 1);
  assert.deepEqual(changedTestPlan([M('pkg/test/a.js')], [{ ...rule, cwd: 'pkg' }]).commands[0].files, ['test/a.js']);
  assert.match(changedTestPlan([M('test/a.js')], [{ ...rule, cwd: 'pkg' }]).skip, /outside/);
  assert.deepEqual(changedTestPlan([M('-x.test.js')], [rule]).commands[0].files, ['./-x.test.js'], 'a leading dash stays a path');
});

test('changed_test_command: an argument array with "{tests}" as one element, on test checks; part of the digest and of the rules', () => {
  const ok = normalizeObligation({ kind: 'test', run: 'npm test', changed_test_command: ['npx', 'jest', '{tests}'] }, { id: 'o1' });
  assert.deepEqual(ok.changed_test_command, ['npx', 'jest', '{tests}']);
  for (const bad of ['node --test {tests}', [], ['{tests}'], ['node', '--test'], ['node', '--test={tests}'], ['node', '{tests}', '{tests}'], ['node', '']]) {
    assert.throws(() => normalizeObligation({ kind: 'test', run: 'x', changed_test_command: bad }), /changed_test_command/, JSON.stringify(bad));
  }
  assert.throws(() => normalizeObligation({ kind: 'command', run: 'x', changed_test_command: ['a', '{tests}'] }), /only allowed on test obligations/);
  const plain = normalizeObligation({ kind: 'test', run: 'npm test' }, { id: 'o1' });
  assert.notEqual(obligationDigest(plain), obligationDigest(ok), 'changing it changes the check');
  assert.equal(obligationDigest(plain), obligationDigest(normalizeObligation({ kind: 'test', run: 'npm test', changed_test_command: null }, { id: 'o1' })), 'unset leaves existing digests alone');
  // Adding it to a rule is a rule change: judged by the base branch's rules, approved like one.
  const base = { pocp: 1, requirements: [{ id: 't', globs: ['src/**'], obligation: { kind: 'test', run: 'npm test' } }] };
  const head = { pocp: 1, requirements: [{ id: 't', globs: ['src/**'], obligation: { kind: 'test', run: 'npm test', changed_test_command: ['node', '--test', '{tests}'] } }] };
  assert.deepEqual(policyWeakening(base, head), ['requirement "t" removed or changed']);
});

test('countTests reads the common summaries, and nothing else counts', () => {
  assert.deepEqual(countTests('# tests 3\n# pass 2\n# fail 0\n# skipped 1\n# todo 0\n'), { passed: 2, failed: 0, skipped: 1 });
  assert.deepEqual(countTests('ℹ tests 1\nℹ pass 1\nℹ fail 0\n'), { passed: 1, failed: 0, skipped: 0 });
  assert.deepEqual(countTests('Tests:       1 skipped, 2 passed, 3 total\n'), { passed: 2, failed: 0, skipped: 1 });
  assert.deepEqual(countTests('      Tests  1 failed | 2 passed (3)\n'), { passed: 2, failed: 1, skipped: 0 });
  assert.deepEqual(countTests('===== 2 passed, 1 skipped in 0.12s =====\n'), { passed: 2, failed: 0, skipped: 1 });
  assert.deepEqual(countTests('===== no tests ran in 0.01s =====\n'), { passed: 0, failed: 0, skipped: 0 });
  assert.deepEqual(countTests('3 examples, 0 failures, 1 pending\n'), { passed: 2, failed: 0, skipped: 1 });
  assert.deepEqual(countTests('  2 passing (5ms)\n  1 pending\n'), { passed: 2, failed: 0, skipped: 1 });
  assert.equal(countTests('ok\nall good\n'), null, 'unknown output is unknown, never a pass');
});

test("node's file-level entry (a file that ran no test) is not a passing test", () => {
  assert.equal(fileLevelOnly('TAP version 13\nok 1 - test/support.js\n# pass 1\n', ['test/support.js']), true);
  assert.equal(fileLevelOnly('\u2714 test/a.test.js (3ms)\n', ['test/a.test.js']), true);
  assert.equal(fileLevelOnly('ok 1 - adds\n# pass 1\n', ['test/a.test.js']), false);
  assert.equal(fileLevelOnly('ok 1 - test/a.test.js\nok 2 - adds\n', ['test/a.test.js']), false);
  assert.equal(fileLevelOnly('Tests: 2 passed, 2 total\n', ['test/a.test.js']), false, 'no per-test lines: the counts decide');
});

test('setup detection: any mention in another test or runner config counts, and an unfinished scan is unknown', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pocp-setup-'));
  const put = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  };
  put('test/a.test.js', "import {\n  add,\n} from\n  './support.js';\n");
  put('test/support.js', 'export const add = (a, b) => a + b;\n');
  put('test/b.test.js', "import { add } from '../src/math.js';\n");
  put('test/conftest.py', 'import fixtures\n');
  put('test/fixtures.py', 'X = 1\n');
  put('test/setup-env.js', 'globalThis.X = 1;\n');
  put('jest.config.js', "module.exports = { setupFiles: ['<rootDir>/test/setup-env.js'] };\n");
  const tests = ['test/**'];
  const runner = ['jest.config.js'];
  assert.deepEqual(importedByOtherTests(dir, ['test/support.js'], tests, runner), { file: 'test/support.js', by: 'test/a.test.js' }, 'an import split over lines');
  assert.deepEqual(importedByOtherTests(dir, ['test/fixtures.py'], tests, runner), { file: 'test/fixtures.py', by: 'test/conftest.py' });
  assert.deepEqual(importedByOtherTests(dir, ['test/setup-env.js'], tests, runner), { file: 'test/setup-env.js', by: 'jest.config.js' }, 'loaded by runner config');
  assert.equal(importedByOtherTests(dir, ['test/b.test.js'], tests, runner), null);
  put('test/huge.data.js', 'x'.repeat(1_000_001));
  assert.match(importedByOtherTests(dir, ['test/b.test.js'], tests, runner).unknown, /too large/, 'a file it can\'t check is unknown, not "no mention"');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('shellQuote: each argument reaches the program as written', () => {
  const args = ["it's.test.js", 'a b.test.js', '$(touch pwned).js', '`touch pwned`.js', '--flag-like.js', 'plain/path.test.js', '*.js', 'semi;colon.js'];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pocp-quote-'));
  const r = spawnSync('sh', ['-c', `printf '%s\\n' ${args.map(shellQuote).join(' ')}`], { cwd: dir, encoding: 'utf8' });
  assert.deepEqual(r.stdout.trimEnd().split('\n'), args);
  assert.equal(fs.existsSync(path.join(dir, 'pwned')), false, 'nothing was executed');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('in CI the base branch decides: a pull request that adds changed_test_command gets the whole check, and is a rule change', () => {
  const T = "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add } from '../src/math.js';\ntest('adds', () => { assert.equal(add(2, 3), 5); });\n";
  const find = (o, k, acc = []) => {
    if (o && typeof o === 'object') {
      if (k in o) acc.push(o[k]);
      for (const x of Object.values(o)) find(x, k, acc);
    }
    return acc;
  };
  for (const baseHas of [true, false]) {
    const dir = tmpRepo();
    write(dir, 'package.json', '{ "type": "module" }\n');
    write(dir, 'src/math.js', 'export const add = (a, b) => a + b;\n');
    write(dir, 'test/add.test.js', T);
    assert.equal(pocp(dir, ['init', '--hooks']).code, 0);
    const withCommand = { kind: 'test', run: 'node --test test/*.test.js', changed_test_command: ['node', '--test', '{tests}'] };
    const { changed_test_command: _, ...without } = withCommand;
    writeRules(dir, { requirements: [{ id: 'tests', globs: ['src/**', 'test/**'], obligation: baseHas ? withCommand : without }] });
    git(dir, 'add', '-A');
    git(dir, '-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', 'start');
    git(dir, 'branch', 'base');
    write(dir, 'test/add.test.js', `${T}test('more', () => { assert.equal(add(0, 0), 0); });\n`);
    if (!baseHas) writeRules(dir, { requirements: [{ id: 'tests', globs: ['src/**', 'test/**'], obligation: withCommand }] });
    git(dir, 'add', '-A');
    assert.equal(pocp(dir, ['fix', '--intent', 'more tests']).code, 0);
    git(dir, 'commit', '-q', '-m', 'more tests');
    const v = pocp(dir, ['verify', 'base..HEAD', '--rerun', '--json']);
    const ct = find(v.json, 'changed_tests');
    assert.ok(ct.length, v.stdout + v.stderr);
    if (baseHas) {
      // The shortcut ran and passed; in fast mode the test edit still waits for a person.
      assert.ok(ct.every((x) => x.result === 'pass'));
      assert.match(v.stdout + v.stderr, /test_change|pocp-approve-tests/, v.stdout + v.stderr);
      assert.equal(pocp(dir, ['verify', 'base..HEAD', '--rerun', '--accept-test-change']).code, 0, 'approved, it verifies');
    } else {
      assert.ok(ct.every((x) => x.result === 'not-used' && /has no changed_test_command/.test(x.reason)), JSON.stringify(ct));
      assert.match(v.stdout + v.stderr, /pocp-approve-policy|policy/, 'adding the command is a rule change');
    }
  }
});
