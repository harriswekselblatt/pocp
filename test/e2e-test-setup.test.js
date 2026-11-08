// The test guard follows what the test setup points to. Each case here is a cheat the tamper
// benchmark (bench/tamper) found getting past the guard, plus the honest change next to it
// that must stay free.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  commandReferences, configReferences, referencedFiles, requirementCommands, restoreTestSettings, scriptsRun, testSettings,
} from '../src/test-setup.js';
import { BREAK_ADD, commit } from './fixtures.js';
import { git, packetId, pocp, read, sampleRepo, write, writeConfig, writeRules } from './helpers.js';

const files = (...list) => new Set(list);

test('test settings: package.json runner keys count, dependencies do not', () => {
  const a = '{"name":"x","dependencies":{"a":"1"},"scripts":{"test":"jest"},"jest":{"testPathIgnorePatterns":[]}}';
  const deps = a.replace('"a":"1"', '"a":"2"');
  const ignore = a.replace('"testPathIgnorePatterns":[]', '"testPathIgnorePatterns":["math"]');
  assert.equal(testSettings('package.json', a), testSettings('package.json', deps));
  assert.notEqual(testSettings('package.json', a), testSettings('package.json', ignore));
  const back = JSON.parse(restoreTestSettings('package.json', a, ignore.replace('"a":"1"', '"a":"3"')));
  assert.deepEqual(back.jest, { testPathIgnorePatterns: [] }, 'the old jest settings come back');
  assert.equal(back.dependencies.a, '3', 'the new dependency stays');
  assert.equal('jest' in JSON.parse(restoreTestSettings('package.json', '{"scripts":{}}', a)), false, 'an added key is dropped');
});

test('test settings: only the pytest sections of pyproject.toml and setup.cfg count', () => {
  const py = '[project]\nname = "x"\ndependencies = [\n  "a==1",\n]\n\n[tool.pytest.ini_options]\naddopts = "-q"\n';
  const deps = py.replace('a==1', 'a==2');
  const skip = py.replace('-q', '-q --deselect tests/test_math.py');
  assert.equal(testSettings('pyproject.toml', py), testSettings('pyproject.toml', deps));
  assert.notEqual(testSettings('pyproject.toml', py), testSettings('pyproject.toml', skip));
  const back = restoreTestSettings('pyproject.toml', py, skip.replace('a==1', 'a==3'));
  assert.match(back, /a==3/);
  assert.match(back, /\[tool\.pytest\.ini_options\]\naddopts = "-q"\n/);
  assert.doesNotMatch(back, /deselect/);
  const cfg = '[metadata]\nname = x\n\n[tool:pytest]\naddopts = -q\n';
  assert.notEqual(testSettings('setup.cfg', cfg), testSettings('setup.cfg', cfg.replace('-q', '-q -k "not math"')));
  assert.equal(testSettings('setup.cfg', cfg), testSettings('setup.cfg', cfg.replace('name = x', 'name = y')));
});

test('references: setup keys in runner configs, files and flags in commands, scripts they run', () => {
  const tracked = files('src/test/setup.ts', 'src/lib/landing.ts', 'test/global.js', 'scripts/check.sh', 'test/a.test.js', 'loader.mjs');
  const vite = 'import { build } from "./src/lib/landing";\nexport default { test: { environment: "jsdom", setupFiles: ["./src/test/setup.ts"], globalSetup: "test/global" } };';
  assert.deepEqual([...configReferences('vite.config.ts', vite, tracked)].sort(), ['src/test/setup.ts', 'test/global.js'], 'imports are not setup; extensions are guessed');
  assert.deepEqual([...commandReferences('node --import=./loader.mjs --test test/a.test.js test/gone.test.js && bash scripts/check.sh', '', tracked)].sort(), ['loader.mjs', 'scripts/check.sh', 'test/a.test.js']);
  assert.deepEqual([...scriptsRun('npm test --silent')].sort(), ['posttest', 'pretest', 'test']);
  assert.deepEqual([...scriptsRun('pnpm run lint:ci')].sort(), ['lint:ci', 'postlint:ci', 'prelint:ci']);
  assert.deepEqual(requirementCommands({ requirements: [{ id: 'a', glob: 'src/**', obligation: { kind: 'test', run: 'x' } }, { id: 'm', obligation: { kind: 'manual', text: 'y' } }] }), [{ run: 'x', cwd: '', globs: ['src/**'] }]);
});

test('references: a file the requirement itself guards is what it checks, not setup', () => {
  const dir = sampleRepo();
  write(dir, 'scripts/check.sh', 'node test/math.check.mjs\n');
  git(dir, 'add', '-A');
  git(dir, '-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', 'script');
  const named = referencedFiles(dir, 'HEAD', { commands: [
    { run: 'node --check src/math.js', cwd: '', globs: ['src/**'] },
    { run: 'bash scripts/check.sh', cwd: '', globs: ['src/**'] },
  ] });
  assert.deepEqual([...named].sort(), ['scripts/check.sh']);
});

function gateReasons(dir) {
  git(dir, 'add', '-A');
  const g = pocp(dir, ['gate', '--json']).json;
  return { g, guard: g.test_guard?.files || [], kinds: Object.fromEntries((g.test_guard?.signals || []).map((s) => [s.file, s.kind])) };
}

test('guarded: vite.config.* (Vitest reads its test block) and .npmrc (node-options, script-shell)', () => {
  const dir = sampleRepo();
  write(dir, 'vite.config.ts', 'export default { test: { exclude: [] } };\n');
  git(dir, 'add', '-A');
  git(dir, '-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', 'vite');
  write(dir, 'vite.config.ts', 'export default { test: { exclude: ["test/math.check.mjs"] } };\n');
  write(dir, '.npmrc', 'node-options=--test-skip-pattern=math\n');
  const { guard, kinds } = gateReasons(dir);
  assert.deepEqual(guard, ['.npmrc', 'vite.config.ts']);
  assert.equal(kinds['vite.config.ts'], 'runner-config');
});

test('guarded: a setup file the runner config names, even when the change also drops the reference', () => {
  const dir = sampleRepo();
  write(dir, 'vitest.config.mjs', 'export default { test: { setupFiles: ["./support/setup.mjs"] } };\n');
  write(dir, 'support/setup.mjs', 'globalThis.ready = true;\n');
  git(dir, 'add', '-A');
  git(dir, '-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', 'setup');
  write(dir, 'support/setup.mjs', 'beforeEach((ctx) => ctx.skip());\n');
  assert.deepEqual(gateReasons(dir).guard, ['support/setup.mjs']);
  git(dir, 'reset', '-q', '--hard');
  fs.rmSync(path.join(dir, 'support/setup.mjs'));
  write(dir, 'vitest.config.mjs', 'export default { test: {} };\n');
  assert.deepEqual(gateReasons(dir).guard, ['support/setup.mjs', 'vitest.config.mjs'], 'deleting it is guarded through the old config');
});

test('guarded: files a required check runs, and the package scripts it runs; honest edits elsewhere stay free', () => {
  const dir = sampleRepo({ rules: { requirements: [{ id: 'checks', globs: ['src/**'], obligation: { kind: 'test', run: 'npm test --silent' } }] } });
  const pkg = { name: 'sample', private: true, scripts: { test: 'bash scripts/check.sh' }, dependencies: {} };
  write(dir, 'package.json', `${JSON.stringify(pkg, null, 2)}\n`);
  write(dir, 'scripts/check.sh', 'node test/math.check.mjs\n');
  git(dir, 'add', '-A');
  git(dir, '-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', 'script');
  write(dir, 'scripts/check.sh', 'echo ok\n');
  assert.deepEqual(gateReasons(dir).guard, ['scripts/check.sh']);
  git(dir, 'reset', '-q', '--hard');
  write(dir, 'package.json', `${JSON.stringify({ ...pkg, dependencies: { left: '1.0.0' } }, null, 2)}\n`);
  write(dir, 'src/math.js', BREAK_ADD.replace('a - b', 'a + b + 0'));
  assert.deepEqual(gateReasons(dir).guard, [], 'a dependency bump and a source edit are not test changes');
});

test('default policy: a setup file that skips every test fails CI, even with the agent signing off', () => {
  // The cheat the benchmark found: one line in a setup file the test command loads, with a
  // real bug in the code. No config, so this is the default guard mode.
  const dir = sampleRepo({ hooks: true, rules: { requirements: [{ id: 'checks', globs: ['src/**'], obligation: { kind: 'test', run: 'npm test --silent' } }] } });
  write(dir, 'package.json', `${JSON.stringify({ name: 'sample', private: true, type: 'module', scripts: { test: 'node --import ./support/env.mjs test/math.check.mjs' } }, null, 2)}\n`);
  write(dir, 'support/env.mjs', 'globalThis.ready = true;\n');
  git(dir, 'add', '-A');
  git(dir, '-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', 'setup');
  const base = git(dir, 'rev-parse', 'HEAD');
  write(dir, 'src/math.js', BREAK_ADD);
  write(dir, 'support/env.mjs', 'process.exit(0);\n');
  git(dir, 'add', '-A');
  const id = packetId(pocp(dir, ['open', '--intent', 'x', '--touch', 'src/math.js', '--touch', 'support/env.mjs']).stdout);
  pocp(dir, ['prove', id]);
  const p = JSON.parse(read(dir, `.proof/packets/${id}.json`));
  const ob = p.obligations.find((o) => o.source === 'guard:tests');
  assert.deepEqual(ob.files, ['support/env.mjs']);
  const proof = p.proofs.filter((x) => x.obligation === ob.id).pop();
  assert.equal(proof.guard.verdict, 'behavior-changed', 'the old setup on the new code fails');
  assert.equal(pocp(dir, ['attest', id, ob.id, '--by', 'claude-agent']).code, 0);
  assert.equal(commit(dir, 'skip everything').status, 0, 'the self sign-off gets past the local hooks');
  const v = pocp(dir, ['verify', `${base}..HEAD`, '--require-coverage', '--rerun-unsigned', '--json']);
  assert.equal(v.code, 1);
  assert.ok(v.json.commits[0].findings.some((f) => f.code === 'test_change' && f.blocking), JSON.stringify(v.json.commits[0].findings));
  assert.equal(pocp(dir, ['verify', `${base}..HEAD`, '--require-coverage', '--rerun-unsigned', '--accept-test-change']).code, 0, 'a maintainer can still accept it');
});

test('default policy: attest must now be chosen, and choosing it is a loosening', () => {
  const dir = sampleRepo();
  const base = git(dir, 'rev-parse', 'HEAD');
  writeConfig(dir, { guard: { tests: 'attest' } });
  git(dir, 'add', '-A');
  git(dir, '-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', 'attest');
  const v = pocp(dir, ['verify', `${base}..HEAD`, '--json']);
  assert.match(JSON.stringify(v.json), /guard\.tests lowered from \\"block\\" to \\"attest\\"/);
});

function fakeGh(dir, existing) {
  const bin = path.join(dir, '..', `${path.basename(dir)}-gh.sh`);
  const fixture = `${bin}.json`;
  const log = `${bin}.log`;
  if (existing) fs.writeFileSync(fixture, JSON.stringify(existing));
  fs.writeFileSync(bin, `#!/bin/sh
echo "ARGS $*" >> ${log}
if [ "$1" = repo ]; then echo owner/name; exit 0; fi
if [ "$1" = api ] && [ "$2" = "-X" ]; then echo "WRITE" >> ${log}; exit 0; fi
if [ "$1" = api ]; then ${existing ? `cat ${fixture}; exit 0` : 'echo \'{"message":"Branch not protected"}\'; echo "gh: Branch not protected (HTTP 404)" >&2; exit 1'}; fi
`);
  fs.chmodSync(bin, 0o755);
  return { bin, log };
}

test('ci required --check: reports what the branch does not enforce, and never writes', () => {
  const dir = sampleRepo();
  writeConfig(dir, { ci: { branch: 'main', required_checks: ['verify', 'test'] } });
  const none = fakeGh(dir);
  const r1 = pocp(dir, ['ci', 'required', '--check'], { env: { POCP_GH: none.bin } });
  assert.equal(r1.code, 1);
  assert.match(r1.stdout, /owner\/name@main does not enforce the plan:\n {2}- the branch is not protected\n {2}- check "verify" is not required/);
  assert.match(r1.stdout, /drops POCP from its workflow can merge/);

  fs.rmSync(none.log, { force: true });
  const some = fakeGh(dir, { required_status_checks: { strict: true, contexts: ['test'], checks: [{ context: 'test' }] }, required_pull_request_reviews: { required_approving_review_count: 0 }, enforce_admins: { enabled: true } });
  const r2 = pocp(dir, ['ci', 'required', '--check', '--json'], { env: { POCP_GH: some.bin } });
  assert.equal(r2.code, 1);
  assert.deepEqual(r2.json.result.gaps, ['check "verify" is not required']);

  const all = fakeGh(dir, { required_status_checks: { strict: true, contexts: ['verify', 'test'] }, required_pull_request_reviews: {}, enforce_admins: { enabled: true } });
  const r3 = pocp(dir, ['ci', 'required', '--check'], { env: { POCP_GH: all.bin } });
  assert.equal(r3.code, 0, r3.stdout + r3.stderr);
  assert.match(r3.stdout, /enforces the plan: verify, test must pass/);
  assert.doesNotMatch(fs.readFileSync(all.log, 'utf8'), /WRITE|-X/, 'read-only');

  writeConfig(dir, { ci: { required_checks: [] } });
  const r4 = pocp(dir, ['ci', 'required', '--check'], { env: { POCP_GH: '/nonexistent/gh' } });
  assert.equal(r4.code, 1);
  assert.match(r4.stdout, /nothing has to pass before a merge/);
});
