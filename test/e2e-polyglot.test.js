// POCP in a repository that isn't a JavaScript project: a shell tool with a shell test
// harness, a check that runs in a subfolder, and CI results. Nothing here uses npm.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { git, packetId, pocp, sh, tmpRepo, write, writeRules } from './helpers.js';

test('a shell project: gate, prove, commit, CI results and verify, with no Node project at all', () => {
  const dir = tmpRepo();
  write(dir, 'bin/greet', '#!/bin/sh\necho "hello, $1"\n');
  fs.chmodSync(path.join(dir, 'bin/greet'), 0o755);
  write(dir, 'tests/run.sh', '#!/bin/sh\nset -e\nout=$(../bin/greet world)\n[ "$out" = "hello, world" ] || { echo "got: $out"; exit 1; }\necho ok\n');
  assert.equal(pocp(dir, ['init', '--hooks']).code, 0);
  writeRules(dir, {
    triggers: { globs: [{ glob: 'bin/**', require_packet: true }] },
    requirements: [{ id: 'shell-tests', glob: 'bin/**', obligation: { kind: 'test', run: 'sh run.sh', cwd: 'tests' } }],
  });
  git(dir, 'add', '-A');
  git(dir, '-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', 'baseline');
  const base = git(dir, 'rev-parse', 'HEAD');

  write(dir, 'bin/greet', '#!/bin/sh\necho "hello, ${1:-you}"\n');
  git(dir, 'add', 'bin/greet');
  assert.notEqual(sh(dir, 'git', ['commit', '-m', 'default name'], { allowFail: true }).status, 0, 'gated');
  const id = packetId(pocp(dir, ['open', '--intent', 'Default the name', '--touch', 'bin/greet']).stdout);
  const proved = pocp(dir, ['prove', id]);
  assert.equal(proved.code, 0, proved.stdout + proved.stderr);
  assert.equal(sh(dir, 'git', ['commit', '-m', 'default name']).status, 0);
  assert.match(git(dir, 'log', '-1', '--format=%B'), /Proof-Of-Change: p-/);

  // CI: run the harness once through ci-run, then verify without running it again.
  const results = path.join(dir, '..', `${path.basename(dir)}-ci.jsonl`);
  assert.equal(pocp(dir, ['ci-run', '--results', results, '--dir', 'tests', '--', 'sh', 'run.sh']).code, 0);
  const v = pocp(dir, ['verify', `${base}..HEAD`, '--require-coverage', '--rerun', '--ci-results', results, '--json']);
  assert.equal(v.code, 0, v.stdout);
  assert.match(v.json.reruns[0].status, /passing CI result/);
  assert.equal(v.json.commits[0].packets[0].evidence.o1, 'ci-result');

  // A regression the harness catches.
  write(dir, 'bin/greet', '#!/bin/sh\necho "hi, $1"\n');
  git(dir, 'add', 'bin/greet');
  const id2 = packetId(pocp(dir, ['open', '--intent', 'Shorter greeting', '--touch', 'bin/greet']).stdout);
  assert.equal(pocp(dir, ['prove', id2]).code, 1);
  assert.notEqual(sh(dir, 'git', ['commit', '-m', 'oops'], { allowFail: true }).status, 0);
});
