// Adopting POCP, judged the way CI judges it (verify --rerun --require-coverage). The commit that
// creates the first policy is not a policy change: there is no earlier policy to loosen. Only
// that commit, though: removing, corrupting or editing an existing policy keeps its protection,
// and the rest of an adoption commit is still checked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { git, pocp, tmpRepo, write, writeRules } from './helpers.js';

const CI = ['--rerun', '--require-coverage', '--exit-detail', '--json'];
const findings = (v) => [...(v.json?.commits || []).flatMap((c) => c.findings || []), ...(v.json?.net?.findings || [])];
const uncovered = (v) => findings(v).filter((f) => f.code === 'uncovered').map((f) => f.detail).join('\n');
const bare = (dir, message) => git(dir, '-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', message);

/** Commit through the hooks the way a person would; fail the test if the hooks refuse. */
function hooked(dir, message) {
  const c = spawnSync('git', ['commit', '-q', '-m', message], { cwd: dir, encoding: 'utf8' });
  assert.equal(c.status, 0, c.stdout + c.stderr);
}

/** A repository with history and no POCP yet. */
function existingRepo() {
  const dir = tmpRepo();
  write(dir, 'README.md', '# before\n');
  write(dir, 'src/math.js', 'export const add = (a, b) => a + b;\n');
  git(dir, 'add', '-A');
  bare(dir, 'before pocp');
  return { dir, base: git(dir, 'rev-parse', 'HEAD') };
}

function adopt(dir) {
  const init = pocp(dir, ['init', '--hooks']);
  assert.equal(init.code, 0, init.stderr);
  git(dir, 'add', '-A');
}

test('an existing repository adopting POCP verifies with the CI flags', () => {
  const { dir, base } = existingRepo();
  adopt(dir);
  hooked(dir, 'adopt pocp');
  const v = pocp(dir, ['verify', `${base}..HEAD`, ...CI]);
  assert.equal(v.code, 0, v.stdout + v.stderr);
  assert.ok(v.json.commits[0].notes.some((n) => n.includes('adopts POCP')), JSON.stringify(v.json.commits[0].notes));
});

test('a root commit that enrolls POCP verifies with the CI flags', () => {
  const dir = tmpRepo();
  write(dir, 'README.md', '# new\n');
  adopt(dir);
  hooked(dir, 'start with pocp');
  const v = pocp(dir, ['verify', 'HEAD', ...CI]);
  assert.equal(v.code, 0, v.stdout + v.stderr);
});

test('adoption with a source change: the source is still judged by the new rules', () => {
  const { dir, base } = existingRepo();
  adopt(dir);
  writeRules(dir, { requirements: [{ id: 'unit', glob: 'src/**', obligation: { kind: 'test', run: 'true' }, source: 'author' }] });
  write(dir, 'src/math.js', 'export const add = (a, b) => b + a;\n');
  git(dir, 'add', '-A');
  bare(dir, 'adopt and change the source');
  const v = pocp(dir, ['verify', `${base}..HEAD`, ...CI]);
  assert.notEqual(v.code, 0, v.stdout);
  assert.match(uncovered(v), /src\/math\.js/);
  assert.doesNotMatch(uncovered(v), /\.proof\//, 'the new policy files themselves are adoption, not a change');
});

test('adoption that also edits a CI workflow still needs approval for the workflow', () => {
  const { dir, base } = existingRepo();
  adopt(dir);
  write(dir, '.github/workflows/ci.yml', 'name: ci\non: push\njobs: {}\n');
  git(dir, 'add', '-A');
  bare(dir, 'adopt and add a workflow');
  const v = pocp(dir, ['verify', `${base}..HEAD`, ...CI]);
  assert.notEqual(v.code, 0, v.stdout);
  assert.ok(findings(v).some((f) => f.code === 'ci_config_changed' && f.blocking), JSON.stringify(findings(v)));
});

test('deleting an enrolled policy is not adoption', () => {
  const { dir } = existingRepo();
  adopt(dir);
  hooked(dir, 'adopt pocp');
  const base = git(dir, 'rev-parse', 'HEAD');
  git(dir, 'rm', '-q', '-r', '.proof/rules.json', '.proof/config.json');
  bare(dir, 'drop the policy');
  const v = pocp(dir, ['verify', `${base}..HEAD`, ...CI]);
  assert.notEqual(v.code, 0, v.stdout);
  assert.match(uncovered(v), /\.proof\/rules\.json/);
});

test('replacing a corrupt policy is not adoption', () => {
  const { dir } = existingRepo();
  write(dir, '.proof/rules.json', '{ "pocp": 1, "requirements": [');
  git(dir, 'add', '-A');
  bare(dir, 'a corrupt policy');
  const base = git(dir, 'rev-parse', 'HEAD');
  writeRules(dir, { requirements: [] });
  git(dir, 'add', '-A');
  bare(dir, 'replace the policy');
  const v = pocp(dir, ['verify', `${base}..HEAD`, ...CI]);
  assert.notEqual(v.code, 0, v.stdout);
  assert.match(uncovered(v), /\.proof\/rules\.json/);
});

test('a later commit that edits the just-adopted policy is a policy change', () => {
  const { dir, base } = existingRepo();
  adopt(dir);
  hooked(dir, 'adopt pocp');
  writeRules(dir, { requirements: [] });
  git(dir, 'add', '-A');
  bare(dir, 'edit the new policy');
  const v = pocp(dir, ['verify', `${base}..HEAD`, ...CI]);
  assert.notEqual(v.code, 0, v.stdout);
  const second = v.json.commits[1];
  assert.ok(second.findings.some((f) => f.code === 'uncovered' && f.detail.includes('.proof/rules.json')), JSON.stringify(second.findings));
});
