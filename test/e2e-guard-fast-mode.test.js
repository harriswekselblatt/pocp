// The fast test guard (guard.mutants 0, what `pocp init` writes for new projects): no planted
// bugs. A test edit passes on its own only when it adds lines to existing tests and none of
// them is risky; everything else goes to a person. Deep mode (planted bugs) stays opt-in, and
// projects set up before this keep it, since the built-in default is still 10.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { git, packetId, pocp, read, sampleRepo, tmpRepo, write, writeConfig } from './helpers.js';
import { DEFAULT_GUARD_MUTANTS, guardBudget, structuralReview } from '../src/guard.js';
import { configWeakening, withDefaults } from '../src/store.js';

const MATH_TEST = [
  "import { add, isPositive } from '../src/math.js';",
  "if (add(2, 3) !== 5) { console.error('add broken'); process.exitCode = 1; }",
  "if (isPositive(1) !== true || isPositive(-1) !== false) { console.error('isPositive broken'); process.exitCode = 1; }",
  "console.log('math ok');",
  '',
].join('\n');

// A fast-mode repo: the same sample, set up by a plain `pocp init` (no --deep).
function fastRepo() {
  const dir = sampleRepo({
    deep: false,
    rules: { requirements: [{ id: 'math-tests', globs: ['src/**', 'test/**', 'package.json', '.mocharc.json'], obligation: { kind: 'test', run: 'for f in test/*.check.mjs; do node "$f" || exit 1; done' }, source: 'author' }] },
  });
  write(dir, 'test/math.check.mjs', MATH_TEST);
  git(dir, 'add', '-A');
  git(dir, '-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', 'tests without early exit');
  return dir;
}

function guardOf(dir, touches) {
  git(dir, 'add', '-A');
  const opened = pocp(dir, ['open', '--intent', 'test change', ...touches.flatMap((t) => ['--touch', t])]);
  assert.equal(opened.code, 0, opened.stderr);
  const id = packetId(opened.stdout);
  const proved = pocp(dir, ['prove', id, '--json']);
  assert.equal(proved.code, 0, proved.stderr);
  const p = JSON.parse(read(dir, `.proof/packets/${id}.json`));
  const ob = p.obligations.find((o) => o.source === 'guard:tests');
  return { ob, guard: p.proofs.filter((x) => x.obligation === ob.id).at(-1).guard };
}

test('fresh init writes the fast guard; --deep writes planted bugs', () => {
  const fast = tmpRepo();
  const r = pocp(fast, ['init']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(JSON.parse(read(fast, '.proof/config.json')).guard.mutants, 0);
  assert.match(r.stdout, /test guard: fast \(guard\.mutants 0\)/);
  const deep = tmpRepo();
  assert.match(pocp(deep, ['init', '--deep']).stdout, /test guard: deep/);
  assert.equal(JSON.parse(read(deep, '.proof/config.json')).guard.mutants, 10);
  // init never rewrites an existing config.
  assert.match(pocp(fast, ['init', '--deep']).stdout, /already set up/);
  assert.equal(JSON.parse(read(fast, '.proof/config.json')).guard.mutants, 0);
});

test('upgrade: a config without guard.mutants keeps the planted-bug check (built-in default 10)', () => {
  assert.equal(DEFAULT_GUARD_MUTANTS, 10, 'lowering the built-in default would turn deep mode off for existing projects');
  assert.equal(guardBudget({}).mutants, 10);
  assert.equal(guardBudget(withDefaults({ pocp: 1 })).mutants, 10);
  const dir = sampleRepo();
  const cfg = JSON.parse(read(dir, '.proof/config.json'));
  delete cfg.guard;
  fs.writeFileSync(path.join(dir, '.proof/config.json'), `${JSON.stringify(cfg, null, 2)}\n`);
  git(dir, 'add', '-A');
  git(dir, '-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', 'config from before fast mode');
  write(dir, 'test/math.check.mjs', `${read(dir, 'test/math.check.mjs')}// more\n`);
  const { ob, guard } = guardOf(dir, ['test/math.check.mjs']);
  assert.equal(ob.mutants, 10);
  assert.notEqual(guard.detection.result, 'off', 'planted bugs ran');
  assert.equal(guard.structural, undefined);
});

test('turning planted bugs off, explicitly or by dropping the key from 10, is a policy change', () => {
  const base = withDefaults({ pocp: 1 });
  assert.deepEqual(configWeakening(base, withDefaults({ pocp: 1, guard: { mutants: 0 } })), ['guard.mutants lowered from 10']);
  assert.deepEqual(configWeakening(withDefaults({ pocp: 1, guard: { mutants: 10 } }), withDefaults({ pocp: 1, guard: { mutants: 0 } })), ['guard.mutants lowered from 10']);
  assert.deepEqual(configWeakening(withDefaults({ pocp: 1, guard: { mutants: 0 } }), withDefaults({ pocp: 1, guard: { mutants: 10 } })), [], 'turning deep mode on is not a weakening');

  const dir = sampleRepo({ hooks: true });
  writeConfig(dir, { ...JSON.parse(read(dir, '.proof/config.json')), guard: { mutants: 0 } });
  git(dir, 'add', '-A');
  const gate = pocp(dir, ['gate', '--json']);
  assert.equal(gate.code, 1);
  assert.match(JSON.stringify(gate.json), /guard\.mutants lowered from 10/);
});

test('fast: an honest added test passes, without planted bugs', () => {
  const dir = fastRepo();
  write(dir, 'test/math.check.mjs', MATH_TEST.replace("console.log('math ok');", "if (add(0, 0) !== 0) { console.error('add zero'); process.exitCode = 1; }\nconsole.log('math ok');"));
  const { ob, guard } = guardOf(dir, ['test/math.check.mjs']);
  assert.equal(ob.mutants, 0);
  assert.match(ob.text, /only adds lines/);
  assert.equal(guard.verdict, 'passed', guard.summary);
  assert.equal(guard.detection.result, 'off');
  assert.deepEqual(guard.structural, { result: 'passed', reasons: [] });
});

const NEEDS_REVIEW = [
  ['a loosened assertion (> becomes >=)', (dir) => write(dir, 'test/math.check.mjs', MATH_TEST.replace('isPositive(-1) !== false', 'isPositive(-1) !== false && false')), /existing test lines were changed or removed/],
  ['a changed expected value', (dir) => write(dir, 'test/math.check.mjs', MATH_TEST.replace('!== 5', '!== add(2, 3)')), /existing test lines were changed or removed/],
  ['a removed assertion', (dir) => write(dir, 'test/math.check.mjs', MATH_TEST.split('\n').filter((l) => !l.includes('isPositive(1)')).join('\n')), /changed or removed/],
  ['an added early exit', (dir) => write(dir, 'test/math.check.mjs', `process.exit(0);\n${MATH_TEST}`), /exits the process/],
  ['an added bare return', (dir) => write(dir, 'test/math.check.mjs', `${MATH_TEST}function later() {\n  return\n}\nlater();\n`), /returns early/],
  ['an overridden assertion', (dir) => write(dir, 'test/math.check.mjs', `import assert from 'node:assert';\nassert.equal = () => {};\n${MATH_TEST}`), /reassigns an assertion/],
  ['Object.assign on assert', (dir) => write(dir, 'test/math.check.mjs', `import assert from 'node:assert';\nObject.assign(assert, { equal() {} });\n${MATH_TEST}`), /patches an assertion or a prototype/],
  ['defineProperty on assert', (dir) => write(dir, 'test/math.check.mjs', `import assert from 'node:assert';\nObject.defineProperty(assert, 'ok', { value() {} });\n${MATH_TEST}`), /patches an assertion or a prototype/],
  ['Object.assign on assert, split over lines', (dir) => write(dir, 'test/math.check.mjs', `import assert from 'node:assert';\nObject.assign(\n  assert,\n  { equal() {} },\n);\n${MATH_TEST}`), /patches an assertion or a prototype/],
  ['defineProperty on assert, split over lines', (dir) => write(dir, 'test/math.check.mjs', `import assert from 'node:assert';\nObject\n  .defineProperty(\n    assert,\n    'ok',\n    { value() {} });\n${MATH_TEST}`), /patches an assertion or a prototype/],
  ['a patched prototype', (dir) => write(dir, 'test/math.check.mjs', `Number.prototype.valueOf = function () { return 5; };\n${MATH_TEST}`), /patches an assertion or a prototype/],
  ['a mocked module', (dir) => write(dir, 'test/math.check.mjs', `${MATH_TEST}const mock = { module() {} };\nmock.module('../src/math.js', {});\n`), /mocks or stubs/],
  ['an exit code reset in an exit handler', (dir) => write(dir, 'test/math.check.mjs', `${MATH_TEST}process.on('exit', () => { process.exitCode = 0; });\n`), /resets the exit code or handles process exit/],
  ['an added global hook', (dir) => write(dir, 'test/math.check.mjs', `${MATH_TEST}const afterEach = () => {};\nafterEach(() => {});\n`), /adds a test hook/],
  ['a replaced global', (dir) => write(dir, 'test/math.check.mjs', `globalThis.console = { error() {}, log() {} };\n${MATH_TEST}`), /changes a global/],
  ['an empty catch', (dir) => write(dir, 'test/math.check.mjs', `${MATH_TEST}try { risky(); } catch {}\n`), /swallows errors/],
  ['an added skip', (dir) => write(dir, 'test/math.check.mjs', `${MATH_TEST}const test = { skip() {} };\ntest.skip('later', () => {});\n`), /skips or focuses tests/],
  ['a deleted test file', (dir) => fs.rmSync(path.join(dir, 'test/extra.check.mjs')), /a test file was deleted/],
  ['a renamed test file', (dir) => fs.renameSync(path.join(dir, 'test/math.check.mjs'), path.join(dir, 'test/math2.check.mjs')), /a test file was renamed/],
  ['new runner config', (dir) => write(dir, '.mocharc.json', '{ "spec": [] }\n'), /test setup or a test helper changed/],
  ['a test script that runs nothing', (dir) => write(dir, 'package.json', `${JSON.stringify({ name: 's', scripts: { test: 'true' } })}\n`), /test settings changed/],
];

for (const [name, change, why] of NEEDS_REVIEW) {
  test(`fast: ${name} goes to a person`, (t) => {
    const dir = fastRepo();
    if (name === 'a deleted test file') {
      write(dir, 'test/extra.check.mjs', "console.log('extra ok');\n");
      git(dir, 'add', '-A');
      git(dir, '-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', 'extra test');
    }
    if (name === 'a test script that runs nothing') {
      write(dir, 'package.json', `${JSON.stringify({ name: 's', scripts: { test: 'node test/math.check.mjs' } })}\n`);
      git(dir, 'add', '-A');
      git(dir, '-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', 'package.json');
    }
    change(dir);
    git(dir, 'add', '-A');
    const opened = pocp(dir, ['open', '--intent', 'test change', '--touch', '**']);
    if (opened.code !== 0) return t.skip(`no packet: ${opened.stderr}`);
    const id = packetId(opened.stdout);
    pocp(dir, ['prove', id, '--json']);
    const p = JSON.parse(read(dir, `.proof/packets/${id}.json`));
    const ob = p.obligations.find((o) => o.source === 'guard:tests');
    assert.ok(ob, 'the change is guarded');
    const g = p.proofs.filter((x) => x.obligation === ob.id).at(-1)?.guard;
    assert.ok(g, 'the guard ran');
    assert.notEqual(g.verdict, 'passed', g.summary);
    // A removed assertion can also show up as a behavior change; everything else must reach
    // the structural review with the reason named.
    if (g.verdict === 'behavior-changed') assert.match(name, /removed|loosened|expected/, g.summary);
    else {
      assert.equal(g.verdict, 'needs-review', g.summary);
      assert.match(g.summary, why);
    }
    const gate = pocp(dir, ['gate']);
    assert.notEqual(gate.code, 0, 'the gate does not pass it on its own');
  });
}

test('structuralReview only passes added, non-risky lines in existing test files', () => {
  const dir = fastRepo();
  write(dir, 'test/math.check.mjs', `${MATH_TEST}// a comment\n`);
  git(dir, 'add', '-A');
  assert.deepEqual(structuralReview(dir, { base: 'HEAD', changes: [{ status: 'M', path: 'test/math.check.mjs', kind: 'test' }] }), []);
  assert.match(structuralReview(dir, { base: 'HEAD', changes: [{ status: 'M', path: 'jest.config.js', kind: 'runner-config' }] })[0].why, /test setup/);
  assert.match(structuralReview(dir, { base: 'HEAD', changes: [{ status: 'M', path: 'package.json', kind: 'package-json' }] })[0].why, /test settings/);
});

test('a known limit: patching through an alias is not recognized (documented, not claimed)', () => {
  const dir = fastRepo();
  write(dir, 'test/math.check.mjs', `import assert from 'node:assert';\nconst a = assert;\na.equal = () => {};\n${MATH_TEST}`);
  git(dir, 'add', '-A');
  // structuralReview sees only added lines; `a.equal = ...` doesn't match its patterns. The
  // threat model lists this; the test pins it so a future fix changes this on purpose.
  assert.deepEqual(structuralReview(dir, { base: 'HEAD', changes: [{ status: 'M', path: 'test/math.check.mjs', kind: 'test' }] }), []);
});
