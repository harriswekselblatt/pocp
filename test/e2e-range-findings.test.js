// verify --json over a range: findings the range itself raises (a re-run that fails at the
// tip) carry `code` and `blocking`, like the findings of each commit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { git, pocp, sh, tmpRepo, write, writeConfig, writeRules } from './helpers.js';

function repo(config) {
  const dir = tmpRepo();
  write(dir, 'package.json', '{ "type": "module" }\n');
  write(dir, 'src/math.js', 'export const add = (a, b) => a + b;\n');
  write(dir, 'test/math.test.js', "import { add } from '../src/math.js';\nif (add(2, 3) !== 5) process.exit(1);\n");
  assert.equal(pocp(dir, ['init', '--hooks']).code, 0);
  writeRules(dir, { requirements: [{ id: 'math', globs: ['src/**'], obligation: { kind: 'test', run: 'node test/math.test.js' }, source: 'author' }] });
  if (config) writeConfig(dir, config);
  git(dir, 'add', '-A');
  git(dir, '-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', 'base');
  const base = git(dir, 'rev-parse', 'HEAD');
  // An honest, proven commit, then one that breaks the code without going through POCP.
  write(dir, 'src/math.js', 'export const add = (a, b) => b + a;\n');
  git(dir, 'add', '-A');
  assert.equal(pocp(dir, ['fix', '--intent', 'reorder']).code, 0);
  assert.equal(sh(dir, 'git', ['commit', '-q', '-m', 'reorder']).status, 0);
  write(dir, 'src/math.js', 'export const add = (a, b) => b - a;\n');
  git(dir, 'add', '-A');
  git(dir, '-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', 'break');
  return { dir, base };
}

test('a re-run that fails at the tip is a range finding with code and blocking', () => {
  const { dir, base } = repo();
  const v = pocp(dir, ['verify', `${base}..HEAD`, '--rerun', '--json']);
  assert.equal(v.code, 1, v.stdout);
  assert.ok(v.json.rerun_failures.length > 0, v.stdout);
  for (const f of v.json.rerun_failures) {
    assert.equal(f.code, 'rerun_failed');
    assert.equal(f.blocking, true);
    assert.equal(typeof f.detail, 'string');
  }
  const ranged = v.json.findings.filter((f) => f.code === 'rerun_failed');
  assert.ok(ranged.length > 0, JSON.stringify(v.json.findings));
  assert.ok(ranged.every((f) => f.blocking === true && f.detail && f.packet));
});

test('a re-run failure the policy does not block on is marked blocking: false', () => {
  const { dir, base } = repo({ verify: { fail_on: ['missing_packet', 'failed_proof'] } });
  const v = pocp(dir, ['verify', `${base}..HEAD`, '--rerun', '--json']);
  assert.ok(v.json, v.stdout + v.stderr);
  const ranged = v.json.findings.filter((f) => f.code === 'rerun_failed');
  assert.ok(ranged.length > 0, JSON.stringify(v.json));
  assert.ok(ranged.every((f) => f.blocking === false));
  assert.ok(v.json.rerun_failures.every((f) => f.code === 'rerun_failed' && f.blocking === false));
});
