import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { git, packetId, pocp, read, sampleRepo, sh, write, writeConfig, writeRules } from './helpers.js';
import { BREAK_ADD, TWEAK_ADD, commit, makeKey } from './fixtures.js';

test('weakening an existing test needs a sign-off, and is named (attest mode)', () => {
  const dir = sampleRepo({ hooks: true });
  writeConfig(dir, { guard: { tests: 'attest' } });
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '--no-verify', '-m', 'attest mode');
  const base = git(dir, 'rev-parse', 'HEAD');
  // Break the code and gut the assertion that would catch it.
  write(dir, 'src/math.js', BREAK_ADD);
  write(dir, 'test/math.check.mjs', [
    "import { add, isPositive } from '../src/math.js';",
    "if (isPositive(1) !== true || isPositive(-1) !== false) { console.error('isPositive broken'); process.exit(1); }",
    "console.log('math ok');",
    '',
  ].join('\n'));
  git(dir, 'add', '-A');
  const id = packetId(pocp(dir, ['open', '--intent', 'x', '--touch', 'src/math.js', '--touch', 'test/math.check.mjs']).stdout);
  assert.equal(pocp(dir, ['prove', id]).code, 0, 'the gutted test passes');
  const g = pocp(dir, ['gate', '--json']);
  assert.equal(g.code, 1, 'but the gate wants a sign-off');
  assert.ok(g.json.reasons.some((r) => r.code === 'test_change'));
  assert.equal(g.json.test_guard.signals[0].kind, 'test');
  assert.deepEqual(g.json.packets[0].evaluation.unattested, ['o2']);
  const p = JSON.parse(read(dir, `.proof/packets/${id}.json`));
  assert.equal(p.obligations[1].source, 'guard:tests');

  assert.equal(pocp(dir, ['attest', id, 'o2', '--by', 'reviewer']).code, 0);
  assert.equal(commit(dir, 'weaken').status, 0);
  const v = pocp(dir, ['verify', `${base}..HEAD`, '--require-coverage', '--json']);
  assert.equal(v.code, 0, 'attested, so CI accepts it in attest mode');
  assert.equal(v.json.commits[0].test_guard.files[0], 'test/math.check.mjs');
});

test('block mode: changed tests fail CI until accepted; new tests are fine', () => {
  const dir = sampleRepo({ hooks: true });
  writeConfig(dir, { guard: { tests: 'block' } });
  git(dir, 'add', '-A');
  git(dir, '-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', 'block mode');
  const base = git(dir, 'rev-parse', 'HEAD');
  write(dir, 'test/extra.check.mjs', 'process.exit(0);\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '--no-verify', '-m', 'new test only');
  assert.equal(pocp(dir, ['verify', 'HEAD', '--json']).json.test_guard, null, 'adding a test is not guarded');
  write(dir, 'test/math.check.mjs', "import assert from 'node:assert';\nassert.equal(1, 1);\n");
  git(dir, 'add', '-A');
  git(dir, '-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', 'assert style');
  write(dir, 'test/math.check.mjs', "console.log('math ok');\n");
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '--no-verify', '-m', 'gut test');
  const v = pocp(dir, ['verify', 'HEAD', '--json']);
  assert.equal(v.code, 1);
  assert.match(v.json.notes.join(' '), /accept-test-change/);
  assert.ok(v.json.test_guard.signals[0].removed_asserts >= 1);
  assert.equal(pocp(dir, ['verify', 'HEAD', '--accept-test-change']).code, 0);
  assert.ok(base);
});

test('changing the test script in package.json is guarded', () => {
  const dir = sampleRepo();
  write(dir, 'package.json', JSON.stringify({ name: 'x', scripts: { test: 'node test/math.check.mjs' } }));
  git(dir, 'add', '-A');
  git(dir, '-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', 'pkg');
  write(dir, 'package.json', JSON.stringify({ name: 'x', scripts: { test: 'echo ok' } }));
  git(dir, 'add', '-A');
  const g = pocp(dir, ['gate', '--json']);
  assert.equal(g.code, 1);
  assert.equal(g.json.test_guard.signals[0].kind, 'package-scripts');
  write(dir, 'package.json', JSON.stringify({ name: 'x', version: '2.0.0', scripts: { test: 'node test/math.check.mjs' } }));
  git(dir, 'add', '-A');
  assert.equal(pocp(dir, ['gate']).code, 0, 'a version bump is not a script change');
});
