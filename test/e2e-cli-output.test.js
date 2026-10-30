// CLI details: readable reasons for every failing commit, and ci-run commands as typed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { git, pocp, sampleRepo, write } from './helpers.js';
import { shellJoin } from '../src/cli.js';
import { hooksDir } from '../src/git.js';

test('range verify prints commit-level reasons, not just "BAD <sha>:"', () => {
  const dir = sampleRepo();
  const base = git(dir, 'rev-parse', 'HEAD');
  write(dir, '.github/workflows/ci.yml', 'name: ci\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '--no-verify', '-m', 'edit CI');
  const v = pocp(dir, ['verify', `${base}..HEAD`]);
  assert.equal(v.code, 1);
  assert.match(v.stdout, /BAD [0-9a-f]{12}: CI configuration changed \(\.github\/workflows\/ci\.yml\)/);
});

test('ci-run keeps quoting: several arguments are quoted where the shell would split them', () => {
  assert.equal(shellJoin(['npm', 'test', '--silent']), 'npm test --silent', 'plain words are unchanged');
  assert.equal(shellJoin(['sh', '-c', 'echo one two']), "sh -c 'echo one two'");
  assert.equal(shellJoin(['echo', "it's"]), "echo 'it'\\''s'");
  assert.equal(shellJoin(['make test && echo done']), 'make test && echo done', 'one argument is a command line as written');
  const dir = sampleRepo();
  const results = path.join(dir, '..', `${path.basename(dir)}-r.jsonl`);
  const r = pocp(dir, ['ci-run', '--results', results, '--', 'sh', '-c', 'test "$0 $1" = "x y" || exit 3', 'x', 'y']);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(JSON.parse(fs.readFileSync(results, 'utf8').trim()).run, `sh -c 'test "$0 $1" = "x y" || exit 3' x y`);
});

test('hooksDir is absolute without --path-format', () => {
  const dir = sampleRepo();
  assert.equal(hooksDir(dir), path.join(dir, '.git', 'hooks'));
  assert.equal(hooksDir(path.join(dir, 'src')), path.join(dir, '.git', 'hooks'), 'from a subfolder too');
});
