// Git hooks are shared by every checkout of a repository. A checkout that hasn't adopted
// POCP (no .proof/rules.json) must be untouched by POCP's hooks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { git, pocp, sh, tmpRepo, write } from './helpers.js';

test('without .proof/rules.json, the hook commands do nothing and succeed', () => {
  const dir = tmpRepo();
  write(dir, 'README.md', 'x\n');
  git(dir, 'add', '-A');
  git(dir, '-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', 'base');
  assert.equal(pocp(dir, ['hooks', 'install']).code, 0);
  // A change that would trip every default trigger: many files, a CI workflow, a test edit.
  for (let i = 0; i < 15; i++) write(dir, `src/m${i}.js`, `export const x${i} = ${i};\n`);
  write(dir, '.github/workflows/ci.yml', 'on: push\n');
  write(dir, 'test/a.test.js', 'assert(true)\n');
  git(dir, 'add', '-A');
  const g = pocp(dir, ['gate']);
  assert.equal(g.code, 0);
  assert.match(g.stderr, /not set up in this checkout/);
  assert.equal(pocp(dir, ['gate', '--json']).json.adopted, false);
  assert.equal(pocp(dir, ['check-edit', 'src/m1.js']).code, 0);
  const c = sh(dir, 'git', ['commit', '-m', 'big change'], { allowFail: true });
  assert.equal(c.status, 0, `commit should go through: ${c.stderr}`);
  assert.doesNotMatch(git(dir, 'log', '-1', '--format=%B'), /Proof-Of-Change/);
  assert.equal(git(dir, 'status', '--porcelain'), '');
});

test('a worktree that adopted POCP is gated; the main checkout sharing its hooks is not', () => {
  const dir = tmpRepo();
  write(dir, 'src/a.js', 'export const a = 1;\n');
  git(dir, 'add', '-A');
  git(dir, '-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', 'base');
  const wt = `${dir}-adopt`;
  git(dir, 'worktree', 'add', '-q', '-b', 'adopt', wt);
  assert.equal(pocp(wt, ['init', '--hooks']).code, 0);
  write(wt, '.proof/rules.json', JSON.stringify({ pocp: 1, triggers: { globs: [{ glob: 'src/**', require_packet: true }] }, requirements: [] }));
  // The hooks live in the shared .git, so they are installed for the main checkout too.
  write(dir, 'src/a.js', 'export const a = 2;\n');
  git(dir, 'add', 'src/a.js');
  assert.equal(sh(dir, 'git', ['commit', '-m', 'main checkout'], { allowFail: true }).status, 0, 'main checkout unaffected');
  write(wt, 'src/a.js', 'export const a = 3;\n');
  git(wt, 'add', '-A');
  assert.notEqual(sh(wt, 'git', ['commit', '-m', 'adopted'], { allowFail: true }).status, 0, 'the adopted worktree is gated');
  fs.rmSync(wt, { recursive: true, force: true });
  assert.ok(path.isAbsolute(dir));
});
