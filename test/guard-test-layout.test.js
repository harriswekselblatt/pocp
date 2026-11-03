// Test code the guard didn't recognise: assertion helpers outside the test folders, test
// layouts the default patterns missed (spec/, src/test/, *_spec.rb, ...), a test file the
// required check runs from inside its own guarded globs, and Rust's inline #[cfg(test)] tests.
// Each "bypass" case is a cheat that used to pass verify with a real bug in the code.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_EVAL_EXCLUDE } from '../src/mutants.js';
import { matchGlob } from '../src/glob.js';
import {
  executedReferences, referencedFiles, restoreRustTests, restoreTestSettings, rustTestItems, rustTestParts, testHelperFiles, testSettings,
} from '../src/test-setup.js';
import { detectTestChanges } from '../src/guard.js';
import { BREAK_ADD, commit } from './fixtures.js';
import { git, packetId, pocp, read, sampleRepo, sh, tmpRepo, write, writeRules } from './helpers.js';

const isTest = (p) => DEFAULT_EVAL_EXCLUDE.some((gl) => matchGlob(p, gl));
const noHooks = (dir, msg) => git(dir, '-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', msg);

/**
 * Prove the staged change in one packet, sign off on whatever the guard asks (the local
 * self-sign-off an agent can give), commit through the hooks, then run CI's verify.
 */
function cheatAndVerify(dir, touches) {
  const base = git(dir, 'rev-parse', 'HEAD');
  git(dir, 'add', '-A');
  const id = packetId(pocp(dir, ['open', '--intent', 'x', ...touches.flatMap((t) => ['--touch', t])]).stdout);
  pocp(dir, ['prove', id]);
  const p = JSON.parse(read(dir, `.proof/packets/${id}.json`));
  const guard = p.obligations.find((o) => o.source === 'guard:tests');
  if (guard) assert.equal(pocp(dir, ['attest', id, guard.id, '--by', 'claude-agent']).code, 0);
  const c = commit(dir, 'cheat', { allowFail: true });
  assert.equal(c.status, 0, `the local hooks let the self-signed change through: ${c.stdout}${c.stderr}`);
  const v = pocp(dir, ['verify', `${base}..HEAD`, '--require-coverage', '--rerun-unsigned', '--json']);
  return { guard, packet: p, verify: v, proof: guard && p.proofs.filter((x) => x.obligation === guard.id).pop() };
}

test('bypass: hollowing an assertion helper the tests import (lib/check.js) fails verify', () => {
  const dir = sampleRepo({ hooks: true });
  write(dir, 'lib/check.js', "export function eq(a, b, what) {\n  if (a !== b) { console.error(`${what} broken`); process.exit(1); }\n}\n");
  write(dir, 'test/math.check.mjs', [
    "import { add, isPositive } from '../src/math.js';",
    "import { eq } from '../lib/check.js';",
    "eq(add(2, 3), 5, 'add');",
    "eq(isPositive(1), true, 'isPositive');",
    "eq(isPositive(-1), false, 'isPositive');",
    "console.log('math ok');",
    '',
  ].join('\n'));
  write(dir, 'package.json', '{ "type": "module" }\n');
  git(dir, 'add', '-A');
  noHooks(dir, 'helper');
  assert.equal(sh(dir, 'node', ['test/math.check.mjs']).status, 0);

  // The cheat: the helper can no longer fail, and add() is broken. The test file is untouched.
  write(dir, 'lib/check.js', 'export function eq(a, b) { if (a !== b && typeof a !== typeof a) process.exit(1); }\n');
  write(dir, 'src/math.js', BREAK_ADD);
  const r = cheatAndVerify(dir, ['src/math.js', 'lib/check.js']);
  assert.ok(r.guard, 'changing a helper the tests import is a test change');
  assert.deepEqual(r.guard.files, ['lib/check.js']);
  assert.equal(r.proof.guard.verdict, 'behavior-changed', 'the old helper on the new code fails');
  assert.equal(r.verify.code, 1, r.verify.stdout);
  assert.ok(r.verify.json.commits[0].findings.some((f) => f.code === 'test_change' && f.blocking));
});

test('helpers are followed transitively, from Python and JavaScript; honest code changes stay free', () => {
  const dir = sampleRepo({ rules: { requirements: [{ id: 't', globs: ['src/**', 'app/**'], obligation: { kind: 'test', run: 'node test/math.check.mjs' } }] } });
  write(dir, 'test/math.check.mjs', "import { add } from '../src/math.js';\nimport { eq } from '../support/assertions.mjs';\neq(add(1, 1), 2);\n");
  write(dir, 'support/assertions.mjs', "import { fail } from './deep/fail.mjs';\nexport const eq = (a, b) => { if (a !== b) fail(); };\n");
  write(dir, 'support/deep/fail.mjs', 'export const fail = () => process.exit(1);\n');
  write(dir, 'tests/test_app.py', 'from app.core import run\nfrom tools.checking import same\n\ndef test_run():\n    same(run(), 1)\n');
  write(dir, 'tools/checking.py', 'from . import base\n\ndef same(a, b):\n    base.check(a == b)\n');
  write(dir, 'tools/base.py', 'def check(ok):\n    assert ok\n');
  write(dir, 'tools/__init__.py', '');
  write(dir, 'app/core.py', 'from tools import base\n\ndef run():\n    return 1\n');
  write(dir, 'lib/shared.js', 'export const one = 1;\n');
  write(dir, 'src/uses-shared.js', "import { one } from '../lib/shared.js';\nexport const two = one + one;\n");
  write(dir, 'test/shared.check.mjs', "import { one } from '../lib/shared.js';\nif (one !== 1) process.exit(1);\n");
  git(dir, 'add', '-A');
  noHooks(dir, 'layout');
  const commands = [{ run: 'node test/math.check.mjs', cwd: '', globs: ['src/**', 'app/**'] }];
  const guarded = () => {
    git(dir, 'add', '-A');
    const r = detectTestChanges(dir, { config: {}, commands });
    git(dir, 'reset', '-q', '--hard');
    return r.files;
  };

  write(dir, 'support/deep/fail.mjs', 'export const fail = () => {};\n');
  assert.deepEqual(guarded(), ['support/deep/fail.mjs'], 'two imports deep');
  write(dir, 'tools/checking.py', 'def same(a, b):\n    pass\n');
  assert.deepEqual(guarded(), ['tools/checking.py'], 'a Python helper');
  write(dir, 'src/math.js', BREAK_ADD);
  write(dir, 'app/core.py', 'def run():\n    return 2\n');
  assert.deepEqual(guarded(), [], 'the code under check is not a helper');
  write(dir, 'lib/shared.js', 'export const one = 2;\n');
  assert.deepEqual(guarded(), [], 'a module the code under check imports is code, even when a test imports it too');
  write(dir, 'tools/base.py', 'def check(ok):\n    pass\n');
  assert.deepEqual(guarded(), [], 'tools/base.py is reached through a helper, but app/core.py (code under check) imports it: it is code');
});

test('helpers: the walk stops at the code under check and at the configured limits', () => {
  const dir = tmpRepo();
  write(dir, 'test/a.test.js', "import '../src/a.js';\nimport '../helpers/h.js';\nimport '../src/testing/check.js';\nimport '../src/expect.js';\n");
  write(dir, 'src/testing/check.js', '');
  write(dir, 'src/expect.js', "import { expect } from 'chai';\n");
  write(dir, 'src/a.js', "import '../vendor/v.js';\n");
  write(dir, 'vendor/v.js', '');
  write(dir, 'helpers/h.js', "import 'node:assert';\nimport './data.json';\n");
  write(dir, 'helpers/data.json', '{}');
  git(dir, 'add', '-A');
  noHooks(dir, 'x');
  const { helpers } = testHelperFiles(dir, 'HEAD', { testGlobs: DEFAULT_EVAL_EXCLUDE, isCode: (p) => p.startsWith('src/') });
  assert.deepEqual([...helpers].sort(), ['helpers/data.json', 'helpers/h.js', 'src/expect.js', 'src/testing/check.js'],
    "the code's own imports are not helpers; data a helper reads is, and so is guarded code that looks like test support");
});

test('bypass: tests moved to spec/, run by name from inside the guarded globs, are still guarded', () => {
  const dir = sampleRepo({ hooks: true, rules: { requirements: [{ id: 'spec', globs: ['src/**', 'spec/**'], obligation: { kind: 'test', run: 'node spec/math_spec.mjs' } }] } });
  sh(dir, 'mkdir', ['-p', 'spec']);
  git(dir, 'mv', 'test/math.check.mjs', 'spec/math_spec.mjs');
  git(dir, 'add', '-A');
  noHooks(dir, 'spec layout');
  write(dir, 'src/math.js', BREAK_ADD);
  write(dir, 'spec/math_spec.mjs', "import { add } from '../src/math.js';\nconsole.log('math ok');\n");
  const r = cheatAndVerify(dir, ['src/**', 'spec/**']);
  assert.ok(r.guard, 'deleting the assertions in spec/ is a test change');
  assert.deepEqual(r.guard.files, ['spec/math_spec.mjs']);
  assert.equal(r.verify.code, 1, r.verify.stdout);
  assert.ok(r.verify.json.commits[0].findings.some((f) => f.code === 'test_change' && f.blocking));
});

test('a file the check executes is its test even in a folder no pattern covers; a file it only reads is the code', () => {
  const dir = sampleRepo({ rules: { requirements: [{ id: 'c', globs: ['src/**', 'checks/**'], obligation: { kind: 'test', run: 'node checks/math.mjs && node --check src/math.js' } }] } });
  sh(dir, 'mkdir', ['-p', 'checks']);
  git(dir, 'mv', 'test/math.check.mjs', 'checks/math.mjs');
  git(dir, 'add', '-A');
  noHooks(dir, 'checks');
  const commands = [{ run: 'node checks/math.mjs && node --check src/math.js', cwd: '', globs: ['src/**', 'checks/**'] }];
  assert.deepEqual([...referencedFiles(dir, 'HEAD', { commands })], ['checks/math.mjs']);
  write(dir, 'checks/math.mjs', "console.log('math ok');\n");
  write(dir, 'src/math.js', BREAK_ADD);
  git(dir, 'add', '-A');
  assert.deepEqual(detectTestChanges(dir, { config: {}, commands }).files, ['checks/math.mjs']);
});

test('executed files: programs, interpreters, runners and syntax checks', () => {
  const files = new Set(['a.sh', 'checks/run.js', 'src/a.js', 'spec/a_spec.rb', 'spec/b_spec.rb', 't/x.py', 'src/b.ts']);
  const ex = (cmd) => [...executedReferences(cmd, '', files)].sort();
  assert.deepEqual(ex('./a.sh'), ['a.sh']);
  assert.deepEqual(ex('CI=1 node checks/run.js src/a.js'), ['checks/run.js'], 'arguments after the program are data');
  assert.deepEqual(ex('node --test checks/run.js src/a.js'), ['checks/run.js', 'src/a.js'], 'node --test runs every file');
  assert.deepEqual(ex('node --check src/a.js'), [], 'a syntax check only reads');
  assert.deepEqual(ex('bundle exec rspec spec/a_spec.rb spec/b_spec.rb'), ['spec/a_spec.rb', 'spec/b_spec.rb']);
  assert.deepEqual(ex('python -m pytest t/x.py'), ['t/x.py']);
  assert.deepEqual(ex('python -m py_compile t/x.py'), []);
  assert.deepEqual(ex('tsc --noEmit src/b.ts && eslint src/a.js'), [], 'compilers and linters read');
  assert.deepEqual(ex('npx --yes tsx checks/run.js'), ['checks/run.js']);
  assert.deepEqual(ex('node --import ./a.sh checks/run.js src/a.js'), ['a.sh', 'checks/run.js'], 'a flag value is loaded, and the program still found');
});

test('default test patterns cover the common layouts of each ecosystem', () => {
  const tests = [
    'test/a.js', 'packages/x/test/a.js', 'spec/a_spec.js', 'src/a.spec.ts', 'src/__tests__/a.js', 'src/__mocks__/fs.js', 'src/__snapshots__/a.snap',
    'test-utils/render.js', 'lib/x/test_utils/a.py',
    'tests/test_a.py', 'pkg/a_test.py', 'app/tests.py',
    'spec/models/user_spec.rb', 'test/models/user_test.rb', 'lib/test_a.rb',
    'pkg/a_test.go', 'pkg/testdata/golden.txt',
    'tests/integration.rs',
    'src/test/java/com/x/AThing.java', 'core/src/test/kotlin/X.kt', 'app/src/androidTest/X.kt', 'shared/src/commonTest/X.kt', 'src/main/java/com/x/FooTest.java', 'FooIT.java',
    'Foo.Tests/Bar.cs', 'src/FooTests.cs', 'Tests/MyLibTests/A.swift',
    'tests/Unit/FooTest.php', 'src/FooTest.php',
  ];
  for (const t of tests) assert.ok(isTest(t), `${t} is a test`);
  for (const s of ['src/a.js', 'lib/a.py', 'app/models/user.rb', 'pkg/a.go', 'src/lib.rs', 'src/main/java/com/x/Foo.java', 'src/Foo.cs', 'src/Foo.php', 'src/latest.js', 'src/contest.py']) {
    assert.ok(!isTest(s), `${s} is source`);
  }
});

test('Rust: the #[cfg(test)] items of a file are its test part', () => {
  const src = [
    'pub fn add(a: i32, b: i32) -> i32 {',
    '    let s = "not } a brace"; let c = \'}\'; let r = r#"} also " not"#;',
    "    fn f<'a>(x: &'a str) -> &'a str { x }",
    '    a + b // }',
    '}',
    '',
    '#[cfg(test)]',
    '#[allow(unused)]',
    'mod tests {',
    '    use super::*;',
    '    /* nested /* } */ comment */',
    '    #[test]',
    '    fn adds() { assert_eq!(add(2, 3), 5); }',
    '}',
    '',
    '#[cfg(test)]',
    'mod more;',
    '',
  ].join('\n');
  const items = rustTestItems(src);
  assert.equal(items.length, 2);
  assert.equal(items[1].module, 'more');
  assert.match(rustTestParts(src)[0], /^#\[cfg\(test\)\][\s\S]*assert_eq![\s\S]*\}$/);

  const broken = src.replace('a + b', 'a - b');
  assert.equal(testSettings('src/lib.rs', src), testSettings('src/lib.rs', broken), 'a source change is not a test change');
  const gutted = src.replace('assert_eq!(add(2, 3), 5);', '');
  assert.notEqual(testSettings('src/lib.rs', src), testSettings('src/lib.rs', gutted));
  const back = restoreTestSettings('src/lib.rs', src, gutted.replace('a + b', 'a - b'));
  assert.match(back, /a - b/, 'the new code stays');
  assert.match(back, /assert_eq!\(add\(2, 3\), 5\)/, 'the old tests come back');
  assert.equal(restoreRustTests(src, src.slice(0, src.indexOf('#[cfg(test)]'))).includes('assert_eq!'), true, 'deleted test items come back');
});

test('Rust: gutting an inline test module is guarded, editing the code beside it is not', () => {
  const dir = tmpRepo();
  write(dir, 'Cargo.toml', '[package]\nname = "x"\nversion = "0.1.0"\n');
  const lib = 'pub fn add(a: i32, b: i32) -> i32 {\n    a + b\n}\n\n#[cfg(test)]\nmod tests {\n    use super::*;\n    #[test]\n    fn adds() {\n        assert_eq!(add(2, 3), 5);\n    }\n}\n';
  write(dir, 'src/lib.rs', lib);
  write(dir, 'src/main.rs', '#[cfg(test)]\nmod checks;\nfn main() {}\n');
  write(dir, 'src/checks.rs', '#[test]\nfn t() { assert!(true); }\n');
  git(dir, 'add', '-A');
  noHooks(dir, 'rust');
  const changes = () => {
    git(dir, 'add', '-A');
    const r = detectTestChanges(dir, { config: {} });
    git(dir, 'reset', '-q', '--hard');
    return { files: r.files, kinds: r.signals.map((s) => s.kind), restore: r.changes.map((c) => c.kind), named: r.named };
  };
  write(dir, 'src/lib.rs', lib.replace('a + b', 'a - b'));
  assert.deepEqual(changes().files, []);
  write(dir, 'src/lib.rs', lib.replace('a + b', 'a - b').replace('assert_eq!(add(2, 3), 5);', ''));
  const c = changes();
  assert.deepEqual(c.files, ['src/lib.rs']);
  assert.deepEqual(c.kinds, ['inline-tests']);
  assert.deepEqual(c.restore, ['config-section'], 'the mechanical check restores only the test items');
  assert.ok(c.named.includes('src/lib.rs'), 'no mutants are planted in a file whose tests are restored');
  write(dir, 'src/checks.rs', '#[test]\nfn t() {}\n');
  assert.deepEqual(changes().kinds, ['test'], 'a #[cfg(test)] mod file is test code');
});
