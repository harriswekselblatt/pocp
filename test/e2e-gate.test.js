import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { git, packetId, pocp, read, sampleRepo, sh, write, writeConfig, writeRules } from './helpers.js';
import { BREAK_ADD, TWEAK_ADD, commit, makeKey } from './fixtures.js';

test('deleting a protected file needs a packet; renaming out of a protected folder counts both paths', () => {
  const dir = sampleRepo({ rules: { requirements: [], triggers: { globs: [{ glob: 'src/**', require_packet: true }] } } });
  git(dir, 'rm', '-q', 'src/math.js');
  const del = pocp(dir, ['gate', '--json']);
  assert.equal(del.code, 1);
  assert.deepEqual(del.json.uncovered, ['src/math.js']);
  git(dir, 'reset', '-q', '--hard');

  fs.mkdirSync(path.join(dir, 'lib'));
  git(dir, 'mv', 'src/math.js', 'lib/math.js');
  const mv = pocp(dir, ['gate', '--json']);
  assert.equal(mv.code, 1);
  assert.deepEqual(mv.json.uncovered, ['src/math.js']);
});

test('policy changes need a packet, and removed requirements are named', () => {
  const dir = sampleRepo({ hooks: true });
  writeRules(dir, { requirements: [] });
  git(dir, 'add', '-A');
  const g = pocp(dir, ['gate', '--json']);
  assert.equal(g.code, 1);
  const reason = g.json.reasons.find((r) => r.code === 'policy_change');
  assert.deepEqual(reason.removed_requirements, ['math-tests']);
  assert.deepEqual(g.json.uncovered, ['.proof/rules.json']);

  const id = packetId(pocp(dir, ['open', '--intent', 'Drop math tests requirement', '--touch', '.proof/rules.json', '--manual', 'Team agreed to drop it']).stdout);
  assert.equal(pocp(dir, ['attest', id, 'o1', '--by', 'lead']).code, 0);
  const r = sh(dir, 'git', ['commit', '-m', 'relax rules']);
  assert.equal(r.status, 0, r.stderr);
  const v1 = pocp(dir, ['verify', 'HEAD', '--require-coverage', '--json']);
  assert.equal(v1.code, 1, 'loosening the rules needs a maintainer to accept it in CI');
  assert.match(v1.json.notes.join(' '), /requirement "math-tests" removed/);
  assert.equal(pocp(dir, ['verify', 'HEAD', '--require-coverage', '--accept-policy-change']).code, 0);
  const sneaky = sampleRepo();
  writeRules(sneaky, { requirements: [] });
  git(sneaky, 'add', '-A');
  git(sneaky, 'commit', '-q', '--no-verify', '-m', 'quietly relax');
  const v = pocp(sneaky, ['verify', 'HEAD', '--require-coverage', '--json']);
  assert.equal(v.code, 1);
  assert.deepEqual(v.json.coverage.uncovered, ['.proof/rules.json']);
});

test('a packet with no obligations never passes', () => {
  const dir = sampleRepo({ rules: { triggers: { broad_files: 3, globs: [] }, requirements: [] } });
  for (const n of [1, 2, 3]) write(dir, `lib/mod${n}.js`, `export const x${n} = ${n};\n`);
  git(dir, 'add', '-A');
  pocp(dir, ['open', '--intent', 'lib', '--touch', 'lib/**']);
  const g = pocp(dir, ['gate', '--json']);
  assert.equal(g.code, 1);
  assert.equal(g.json.packets[0].evaluation.no_obligations, true);
});

test('hooks: keep existing hook content, uninstall cleanly, refuse shared hooksPath', () => {
  const dir = sampleRepo();
  const hook = path.join(dir, '.git/hooks/pre-commit');
  fs.writeFileSync(hook, '#!/bin/sh\necho existing-hook\n');
  assert.equal(pocp(dir, ['hooks', 'install']).code, 0);
  const text = fs.readFileSync(hook, 'utf8');
  assert.match(text, /existing-hook/);
  assert.match(text, /pocp_run gate/);
  assert.equal(pocp(dir, ['hooks', 'install']).code, 0);
  assert.equal(fs.readFileSync(hook, 'utf8').match(/>>> pocp >>>/g).length, 1, 'reinstall does not duplicate');
  assert.equal(pocp(dir, ['hooks', 'uninstall']).code, 0);
  assert.equal(fs.readFileSync(hook, 'utf8'), '#!/bin/sh\necho existing-hook\n');
  assert.ok(!fs.existsSync(path.join(dir, '.git/hooks/post-commit')), 'hooks pocp created are removed');

  git(dir, 'config', 'core.hooksPath', '/tmp/shared-hooks');
  const r = pocp(dir, ['hooks', 'install']);
  assert.equal(r.code, 2);
  assert.match(r.stdout, /core\.hooksPath/);
});

test('invalid rules stop the gate with a config error, not a pass', () => {
  const dir = sampleRepo();
  write(dir, '.proof/rules.json', '{"pocp":1,"requirements":[{"id":"x"}]}');
  write(dir, 'src/math.js', TWEAK_ADD);
  git(dir, 'add', 'src/math.js');
  const g = pocp(dir, ['gate']);
  assert.equal(g.code, 2);
  assert.match(g.stderr, /invalid_rules/);
  assert.equal(pocp(dir, ['rules', 'check']).code, 2);
});

test('broad changes need a packet even without rules', () => {
  const dir = sampleRepo({ rules: { triggers: { broad_files: 3, globs: [] }, requirements: [] } });
  for (const n of [1, 2, 3]) write(dir, `lib/mod${n}.js`, `export const x${n} = ${n};\n`);
  git(dir, 'add', '-A');
  const g = pocp(dir, ['gate', '--json']);
  assert.equal(g.code, 1);
  assert.equal(g.json.reasons[0].code, 'broad');
  assert.match(g.json.suggestion.note, /No rule requires a check/);
});

test('check-edit tells a pre-edit hook whether a packet is needed first', () => {
  const dir = sampleRepo();
  const r1 = pocp(dir, ['check-edit', 'src/math.js', '--json']);
  assert.equal(r1.code, 1);
  assert.deepEqual(r1.json.uncovered, ['src/math.js']);
  assert.equal(pocp(dir, ['check-edit', 'README.md']).code, 0);
  assert.equal(pocp(dir, ['check-edit', '.proof/rules.json']).code, 1, 'policy files are protected');
  pocp(dir, ['open', '--intent', 'x', '--touch', 'src/**']);
  assert.equal(pocp(dir, ['check-edit', './src/math.js']).code, 0);
});

test('docs, tests and lockfiles do not count toward a "big change"', () => {
  const dir = sampleRepo({ rules: { triggers: { broad_files: 3, globs: [] }, requirements: [] } });
  for (const n of [1, 2, 3, 4]) write(dir, `docs/page${n}.md`, `page ${n}\n`);
  write(dir, 'package-lock.json', '{}');
  git(dir, 'add', '-A');
  assert.equal(pocp(dir, ['gate']).code, 0);
});

test('status warns when a hook is not executable (git would silently skip it)', () => {
  const dir = sampleRepo({ hooks: true });
  assert.equal(pocp(dir, ['hooks', 'status']).code, 0);
  fs.chmodSync(path.join(dir, '.git/hooks/pre-commit'), 0o644);
  const h = pocp(dir, ['hooks', 'status', '--json']);
  assert.equal(h.code, 1);
  assert.equal(h.json.hooks['pre-commit'], 'not executable');
  assert.match(pocp(dir, ['status']).stdout, /warning: pre-commit is not executable/);
});
