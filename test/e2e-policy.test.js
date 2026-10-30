// Policy integrity in CI: a pull request can't loosen the rules it is judged by, however it
// phrases the change.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { git, packetId, pocp, sampleRepo, write, writeConfig, writeRules } from './helpers.js';
import { BREAK_ADD, commit } from './fixtures.js';
import { policyWeakening, strictUnion } from '../src/rules.js';
import { configWeakening, rulesWithDefaults, strictConfig, withDefaults } from '../src/store.js';

test('narrowing a requirement\'s glob is a loosening, and the base glob still applies', () => {
  const dir = sampleRepo({ hooks: true });
  const base = git(dir, 'rev-parse', 'HEAD');
  // Same check, but it now guards a folder that doesn't exist; the broken code escapes it.
  writeRules(dir, { triggers: { globs: [] }, requirements: [
    { id: 'math-tests', glob: 'src/none/**', obligation: { kind: 'test', run: 'node test/math.check.mjs' }, source: 'author' },
  ] });
  write(dir, 'src/math.js', BREAK_ADD);
  git(dir, 'add', '-A');
  const id = packetId(pocp(dir, ['open', '--intent', 'narrow', '--touch', '.proof/rules.json', '--command', 'true']).stdout);
  assert.equal(pocp(dir, ['prove', id]).code, 0);
  assert.equal(commit(dir, 'narrow the rule').status, 0, 'passes locally, by its own rules');
  const v = pocp(dir, ['verify', `${base}..HEAD`, '--require-coverage', '--rerun-unsigned', '--json']);
  assert.equal(v.code, 1);
  const c = v.json.commits[0];
  assert.ok(c.policy.weakened.some((w) => /requirement "math-tests" no longer guards "src\/\*\*"/.test(w)), c.policy.weakened.join('; '));
  assert.ok(c.coverage.uncovered.includes('src/math.js'), 'the base glob still requires a packet for src/math.js');
  // Once approved, the head's rules are in force.
  const ok = pocp(dir, ['verify', `${base}..HEAD`, '--rerun-unsigned', '--accept-policy-change', '--json']);
  assert.equal(ok.json.commits[0].policy.accepted, true);
});

test('strict union keeps every glob a check guarded in the base', () => {
  const base = rulesWithDefaults({ requirements: [{ id: 'a', globs: ['src/**', 'lib/**'], obligation: { kind: 'test', run: 't' } }] });
  const head = rulesWithDefaults({ requirements: [{ id: 'a', glob: 'src/**', obligation: { kind: 'test', run: 't' } }] });
  const u = strictUnion(base, head);
  assert.equal(u.requirements.length, 1, 'merged into the head requirement, not duplicated');
  assert.deepEqual(u.requirements[0].globs, ['src/**', 'lib/**']);
  assert.deepEqual(policyWeakening(base, head), ['requirement "a" no longer guards "lib/**"']);
  // Moving a glob to another requirement with the same check is not a loosening.
  const split = rulesWithDefaults({ requirements: [
    { id: 'a', glob: 'src/**', obligation: { kind: 'test', run: 't' } },
    { id: 'b', glob: 'lib/**', obligation: { kind: 'test', run: 't' } },
  ] });
  assert.deepEqual(policyWeakening(base, split), []);
  // Widening is fine.
  const wider = rulesWithDefaults({ requirements: [{ id: 'a', globs: ['src/**', 'lib/**', 'bin/**'], obligation: { kind: 'test', run: 't' } }] });
  assert.deepEqual(policyWeakening(base, wider), []);
});

test('replacing the test guard\'s globs is a loosening; the base globs stay in force', () => {
  const dir = sampleRepo({ hooks: true });
  writeConfig(dir, { guard: { tests: 'block' } });
  git(dir, 'add', '-A');
  git(dir, '-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', 'block mode');
  const base = git(dir, 'rev-parse', 'HEAD');
  writeConfig(dir, { guard: { tests: 'block', test_globs: ['nothing/**'] } });
  write(dir, 'test/math.check.mjs', "console.log('math ok');\n");
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '--no-verify', '-m', 'hide the gutted test');
  const v = pocp(dir, ['verify', `${base}..HEAD`, '--json']);
  assert.equal(v.code, 1);
  const codes = v.json.commits[0].findings.map((f) => f.code);
  assert.ok(codes.includes('policy_loosened'), codes.join(','));
  assert.ok(codes.includes('test_change'), 'the gutted test is still guarded');
  assert.match(v.json.commits[0].policy.weakened.join(' '), /guard no longer treats "test\/\*\*" as a test file/);
});

test('config weakening: guard globs, area depth, environment', () => {
  const base = withDefaults({ area_depth: 2, run: { env: 'minimal', env_allow: ['A'] } });
  assert.deepEqual(configWeakening(base, withDefaults({ area_depth: 2, run: { env: 'minimal', env_allow: ['A'] } })), []);
  assert.deepEqual(configWeakening(base, withDefaults({ area_depth: 2, run: { env: 'minimal', env_allow: ['A'] }, guard: { extra_test_globs: ['spec/**'] } })), [], 'adding guard globs is stricter');
  const w = configWeakening(base, withDefaults({ area_depth: 1, run: { env: 'inherit' }, guard: { runner_globs: [] } }));
  assert.ok(w.includes('area_depth lowered from 2'));
  assert.ok(w.includes('run.env changed from "minimal" to "inherit"'));
  assert.ok(w.some((x) => /guard no longer treats "\*\*\/jest\.config\.\*" as test setup/.test(x)));
  assert.deepEqual(configWeakening(base, withDefaults({ area_depth: 2, run: { env: 'minimal', env_allow: ['A', 'SECRET'] } })), ['run.env_allow gained "SECRET"']);
  const s = strictConfig(base, withDefaults({ area_depth: 1, run: { env: 'inherit', env_allow: ['A', 'SECRET'] }, guard: { test_globs: ['spec/**'] } }));
  assert.equal(s.area_depth, 2);
  assert.equal(s.run.env, 'minimal');
  assert.deepEqual(s.run.env_allow, ['A']);
  assert.ok(s.guard.test_globs.includes('test/**') && s.guard.test_globs.includes('spec/**'));
});
