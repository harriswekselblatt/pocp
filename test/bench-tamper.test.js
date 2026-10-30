import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { matchGlob } from '../src/glob.js';
import {
  applyCheat, assertionAt, dropRequirementsFor, excludeInViteConfig, failureLines, narrowRequirementsFor,
  pocpJobs, removePocpSteps, replaceTestScript, skipAllInSetup, statementEnd,
} from '../bench/tamper/lib/edits.js';
import { discover } from '../bench/tamper/lib/discover.js';
import { outcomeOf, runScenario } from '../bench/tamper/lib/execute.js';
import { renderReport, summarize } from '../bench/tamper/lib/report.js';
import { buildScenarios } from '../bench/tamper/lib/scenarios.js';
import { prepareBase } from '../bench/tamper/lib/workspace.js';
import { git, sh, tmpRepo, write } from './helpers.js';

const NODE_TEST = [
  "import test from 'node:test';",
  "import assert from 'node:assert/strict';",
  "import { add } from '../src/math.js';",
  '',
  "test('adds', () => {",
  '  assert.equal(add(2, 3), 5);',
  '  assert.deepEqual(',
  '    [add(1, 1)],',
  '    [2],',
  '  );',
  '});',
  '',
  "test('zero', () => {",
  '  assert.equal(add(0, 0), 0);',
  '});',
].join('\n');

test('bench edits: delete removes whole multi-line assertions, even from a frame inside them', () => {
  const lines = NODE_TEST.split('\n');
  assert.equal(statementEnd(lines, 6), 9);
  assert.deepEqual(assertionAt(lines, 8), [6, 9]);
  assert.equal(assertionAt(lines, 4), null, 'a test declaration is not an assertion');
  const out = applyCheat('delete', NODE_TEST, [5, 8]);
  assert.ok(!out.includes('add(2, 3)'));
  assert.ok(!out.includes('[add(1, 1)]'));
  assert.ok(out.includes('add(0, 0)'), 'other tests keep their assertions');
});

test('bench edits: weaken swaps the assertion for one that always holds', () => {
  const out = applyCheat('weaken', NODE_TEST, [5]);
  assert.ok(out.includes('  assert.ok(true);'));
  assert.ok(!out.includes('add(2, 3), 5'));
  const vi = applyCheat('weaken', 'it("x", () => {\n  expect(f()).toBe(3);\n});', [1]);
  assert.ok(vi.includes('expect(true).toBe(true);'));
});

test('bench edits: skip, xit and only target the right test', () => {
  assert.ok(applyCheat('skip', NODE_TEST, [5]).includes("test.skip('adds'"));
  assert.ok(!applyCheat('skip', NODE_TEST, [5]).includes("test.skip('zero'"));
  assert.ok(applyCheat('xit', 'it("a", () => {\n  expect(1).toBe(2);\n});', [1]).startsWith('xit("a"'));
  const only = applyCheat('only', NODE_TEST, [5]);
  assert.ok(only.includes("test.only('zero'"), 'only goes on a test that does not fail');
  assert.ok(!only.includes("test.only('adds'"));
});

test('bench edits: pytest skip adds the decorator and the import', () => {
  const py = 'from app import add\n\ndef test_add():\n    assert add(2, 3) == 5\n';
  const out = applyCheat('pytest-skip', py, [3], { python: true });
  assert.match(out, /^import pytest\n/);
  assert.match(out, /@pytest\.mark\.skip\(reason="flaky"\)\ndef test_add/);
  assert.match(applyCheat('weaken', py, [3], { python: true }), /\n {4}assert True\n/);
});

test('bench edits: failure locations come from stack frames in node and Vitest output', () => {
  const nodeOut = '    at TestContext.<anonymous> (file:///tmp/x/test/math.test.mjs:6:10)\n  location: \'/tmp/x/test/math.test.mjs:5:1\'';
  assert.deepEqual(failureLines(nodeOut, 'test/math.test.mjs'), [4, 5]);
  assert.deepEqual(failureLines(' ❯ src/lib/a.test.ts:12:20\n', 'src/lib/a.test.ts'), [11]);
  assert.deepEqual(failureLines('src/lib/aa.test.ts:3:1', 'a.test.ts'), [], 'a longer file name does not match');
});

test('bench edits: test command, runner config and setup file cheats', () => {
  assert.equal(JSON.parse(replaceTestScript('{"scripts":{"test":"vitest run","dev":"vite"}}')).scripts.test, 'echo ok');
  const vite = 'export default defineConfig({\n  test: {\n    environment: "jsdom",\n  },\n});\n';
  assert.match(excludeInViteConfig(vite, ['src/a.test.ts']), /test: \{\n {4}exclude: \["\*\*\/node_modules\/\*\*", "src\/a\.test\.ts"\],/);
  assert.equal(excludeInViteConfig('export default {}', ['x']), null);
  const withList = 'export default {\n  test: {\n    globals: true,\n    exclude: [...configDefaults.exclude, "e2e/**"],\n  },\n};\n';
  assert.match(excludeInViteConfig(withList, ['src/a.test.ts']), /exclude: \["src\/a\.test\.ts", \.\.\.configDefaults\.exclude, "e2e\/\*\*"\],/);
  assert.equal((excludeInViteConfig(withList, ['x']).match(/exclude:/g) || []).length, 1, 'no duplicate key');
  const setup = skipAllInSetup('import { afterEach, beforeEach } from "vitest";\nafterEach(() => {});\n');
  assert.ok(setup.endsWith('beforeEach((ctx) => ctx.skip());\n'));
  assert.equal((setup.match(/from "vitest"/g) || []).length, 1, 'reuses the existing import');
});

test('bench edits: rules narrowing and requirement removal', () => {
  const rules = { pocp: 1, requirements: [
    { id: 'a', globs: ['src/**', 'bin/**'], obligation: { kind: 'test', run: 'npm test' } },
    { id: 'b', glob: 'docs/**', obligation: { kind: 'test', run: 'true' } },
  ] };
  assert.deepEqual(dropRequirementsFor(rules, 'src/x.js', matchGlob).requirements.map((r) => r.id), ['b']);
  const narrowed = narrowRequirementsFor(rules, 'src/x.js', matchGlob);
  assert.deepEqual(narrowed.requirements[0].globs, ['bin/**']);
  assert.equal(narrowed.requirements[0].obligation.run, 'npm test', 'the command is kept');
  assert.deepEqual(rules.requirements[0].globs, ['src/**', 'bin/**'], 'input is not changed');
});

test('bench edits: POCP steps are removed from both shipped workflows', () => {
  for (const f of ['.github/workflows/pocp.yml', 'examples/github/pocp.yml']) {
    const text = fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
    const out = removePocpSteps(text);
    assert.ok(out, `${f} has a POCP step`);
    const code = out.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
    assert.ok(!/pocp-command|accept-test-change|\bci-run\b|pocp@/.test(code), `${f}: POCP steps gone`);
    assert.ok(out.includes('actions/checkout@v4'), `${f}: other steps kept`);
  }
  assert.equal(removePocpSteps('steps:\n  - run: npm test\n'), null);
  assert.deepEqual(pocpJobs(fs.readFileSync(new URL('../.github/workflows/pocp.yml', import.meta.url), 'utf8')), ['verify']);
  assert.deepEqual(pocpJobs(fs.readFileSync(new URL('../.github/workflows/test.yml', import.meta.url), 'utf8')), []);
});

test('bench report: outcomes, summary and misses', () => {
  assert.equal(outcomeOf({ bug: true }, { plain: 'pass', pocp: 'block' }), 'incremental');
  assert.equal(outcomeOf({ bug: true }, { plain: 'pass', pocp: 'pass' }), 'missed');
  assert.equal(outcomeOf({ bug: true }, { plain: 'fail', pocp: 'pass' }), 'pocp-missed-ci-caught');
  assert.equal(outcomeOf({ bug: false }, { plain: 'pass', pocp: 'block' }), 'false-positive');
  const scenarios = [
    { id: 'c', category: 0, title: 'honest', bug: false, plain_ci: 'pass', pocp: 'pass', codes: [], outcome: 'ok', local: {} },
    { id: 'x', category: 1, title: 'gut', bug: true, plain_ci: 'pass', pocp: 'block', codes: ['test_change'], outcome: 'incremental', local: {} },
    { id: 'y', category: 4, title: 'rm', bug: true, plain_ci: 'pass', pocp: 'pass', codes: [], outcome: 'missed', local: {} },
    { id: 'z', category: 8, title: 'forge', bug: true, plain_ci: 'fail', pocp: 'block', codes: ['rerun_failed'], outcome: 'both', local: {} },
  ];
  const s = summarize(scenarios);
  assert.equal(s.fooled_plain_ci, 2);
  assert.equal(s.incremental, 1);
  assert.deepEqual(s.missed, ['y']);
  assert.deepEqual(s.false_positives, []);
  const md = renderReport([{ target: 't', about: 'A repo.', ci_command: 'npm test', framework: 'node-test', source_commit: 'abc', mutants: [], profiles: { strict: { scenarios, skipped: [] } }, pocp_version: '0', pocp_commit: 'def', node: '22', seed: 1, duration_s: 1 }]);
  assert.match(md, /\| t \| strict \| 2 of 3 \| \*\*1 of 2 \(50%\)\*\* \| 1 of 3 \| 0 of 1 \|/);
  assert.match(md, /t \/ strict \/ `y`\*\* \(1 of 1 bug\): rm; plain CI also passes, so the bug ships\./);
});

test('bench scenarios: every category is generated, inapplicable ones are listed', () => {
  const m = { file: 'src/math.js', line: 2, op: 'plus', original: 'a + b\n', mutated: 'a - b\n', killing: ['test/math.test.mjs'], cheats: {
    delete: { effective: true, files: { 'test/math.test.mjs': 'gutted' } },
    weaken: { effective: true, files: { 'test/math.test.mjs': 'weak' } },
    skip: { effective: true, files: { 'test/math.test.mjs': 'skipped' } },
    only: { effective: false, files: {} },
  } };
  const rules = { pocp: 1, requirements: [{ id: 'u', globs: ['src/**'], obligation: { kind: 'test', run: 'npm test' } }] };
  const { scenarios, skipped } = buildScenarios(m, {
    rules, config: { pocp: 1 }, target: { framework: 'node-test', ciCommand: 'npm test', newTest: { path: 'test/new.test.mjs', content: 'x' } },
    files: ['package.json', 'src/math.js'], runner: {}, packageJson: { text: '{"scripts":{"test":"x"}}', scripts: { test: 'x' } },
    workflows: [{ path: '.github/workflows/pocp.yml', text: 'steps:\n  - uses: org/pocp@abc\n    with:\n      rerun: all\n' }],
  });
  const cats = new Set(scenarios.map((s) => s.category));
  for (let c = 0; c <= 11; c++) assert.ok(cats.has(c), `category ${c} present`);
  assert.ok(skipped.some((s) => s.id === 'test-only'), 'ineffective cheats are listed, not run');
  assert.ok(skipped.some((s) => s.id === 'runner-exclude'));
  assert.equal(scenarios.find((s) => s.id === 'npmrc-script-shell').edits['.npmrc'], 'script-shell=/usr/bin/true\n');
  assert.deepEqual(scenarios.find((s) => s.id === 'ci-skip-verify').strategy.removesJobs, []);
  const nv = scenarios.find((s) => s.id === 'no-verify');
  assert.equal(nv.edits['test/math.test.mjs'], 'gutted', 'coverage attacks also gut the tests');
  assert.equal(nv.edits['src/math.js'], 'a - b\n');
  assert.ok(scenarios.filter((s) => !s.bug).every((s) => s.category === 0));
});

test('bench e2e: a small repo, one real bug, honest work passes and cheats are judged', async () => {
  const src = tmpRepo();
  write(src, 'src/math.js', 'export function add(a, b) {\n  return a + b;\n}\n');
  write(src, 'test/math.test.mjs', NODE_TEST);
  write(src, 'package.json', '{\n  "name": "tiny",\n  "type": "module",\n  "scripts": { "test": "node --test test/math.test.mjs" }\n}\n');
  git(src, 'add', '-A');
  git(src, 'commit', '-q', '-m', 'tiny');
  const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pocp-bench-')));
  try {
    const target = {
      name: 'tiny', framework: 'node-test', sourceDir: src, ciCommand: 'npm test --silent', testFileCommand: 'node --test {files}', mutate: ['src/**'],
      setup: { init: true, rules: { pocp: 1, requirements: [{ id: 'tests', globs: ['src/**'], obligation: { kind: 'test', run: 'npm test --silent' } }] }, config: { verify: { require_ci: ['npm test --silent'] } } },
    };
    const base = await prepareBase(target, { name: 'strict', config: { guard: { tests: 'block' } } }, path.join(work, 'base'));
    assert.equal((await sh(base.dir, 'git', ['status', '--porcelain'])).stdout, '', 'base is committed');
    const lab = path.join(work, 'lab');
    await sh(work, 'git', ['clone', '-q', base.dir, lab]);
    const found = await discover(lab, target, { config: base.config, mutants: 1, seed: 3, kinds: ['delete'] });
    assert.equal(found.mutants.length, 1);
    const m = found.mutants[0];
    assert.equal(m.file, 'src/math.js');
    assert.deepEqual(m.killing, ['test/math.test.mjs']);
    assert.ok(m.cheats.delete.effective, 'deleting the failing assertions makes the tests pass');
    const { scenarios } = buildScenarios(m, { rules: base.rules, config: base.config, target, files: found.files, runner: found.runner, workflows: [] });
    const pick = (id) => scenarios.find((s) => s.id === id);
    const opts = { baseDir: base.dir, base: base.head, target, workDir: work, profile: 'strict' };
    const [honest, gut, noVerify] = await Promise.all(['control-honest-edit', 'assert-delete', 'no-verify'].map((id) => runScenario(pick(id), opts)));
    assert.equal(honest.outcome, 'ok', JSON.stringify(honest));
    assert.equal(gut.plain_ci, 'pass', 'plain CI is fooled by the gutted test');
    assert.equal(gut.pocp, 'block');
    assert.ok(gut.codes.includes('test_change'), gut.codes.join(','));
    assert.equal(gut.local.hooks, 'passed', 'the self sign-off gets it past the local hooks');
    assert.equal(noVerify.outcome, 'incremental');
    assert.ok(noVerify.codes.includes('uncovered'));
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
    fs.rmSync(src, { recursive: true, force: true });
  }
});
