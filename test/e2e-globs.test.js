// Globs that look right but can't match are configuration errors, not silent no-ops.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { git, pocp, sampleRepo, write, writeConfig, writeRules } from './helpers.js';
import { globProblem, matchGlob } from '../src/glob.js';
import { validateRules } from '../src/rules.js';
import { validateConfig, withDefaults } from '../src/store.js';

test('globProblem names unsupported syntax and leaves valid globs alone', () => {
  for (const ok of ['src/**', '**/*.test.*', 'src/a?.js', 'Makefile', 'docs/']) assert.equal(globProblem(ok), null, ok);
  assert.match(globProblem('src/**/*.{js,ts}'), /brace expansion/);
  assert.match(globProblem('src/[ab].js'), /character classes/);
  assert.match(globProblem('./src/**'), /without it/);
  assert.match(globProblem('/etc/**'), /absolute/);
  assert.match(globProblem('../x/**'), /outside the repository/);
  assert.equal(matchGlob('src/a/b.js', 'src/**/*.{js,ts}'), false, 'which is why: braces are literal');
});

test('rules and config with unmatchable globs are invalid, and the gate stops', () => {
  assert.match(validateRules({ requirements: [{ id: 'r', glob: 'src/**/*.{js,ts}', obligation: { kind: 'test', run: 't' } }] }).join(' '), /requirements\[0\] \(r\): .*brace/);
  assert.match(validateRules({ triggers: { globs: [{ glob: './src/**', require_packet: true }] } }).join(' '), /triggers\.globs\[0\]/);
  assert.match(validateRules({ count_exempt: ['[ab].md'] }).join(' '), /count_exempt\[0\]/);
  assert.match(validateConfig(withDefaults({ guard: { extra_test_globs: ['spec/**/*.{js,ts}'] } })).join(' '), /guard\.extra_test_globs/);
  assert.match(validateConfig(withDefaults({ ci: { files: ['./.github/workflows/**'] } })).join(' '), /ci\.files/);
  const dir = sampleRepo();
  writeRules(dir, { requirements: [{ id: 'r', glob: 'src/**/*.{js,ts}', obligation: { kind: 'test', run: 'true' } }] });
  const check = pocp(dir, ['rules', 'check']);
  assert.equal(check.code, 2);
  assert.match(check.stdout, /brace expansion/);
  write(dir, 'src/math.js', 'x\n');
  git(dir, 'add', '-A');
  assert.equal(pocp(dir, ['gate']).code, 2);
});

test('a wildcard-free glob that names a folder gets a warning', () => {
  const dir = sampleRepo();
  writeRules(dir, { triggers: { globs: [{ glob: 'src', require_packet: true }] }, requirements: [] });
  const check = pocp(dir, ['rules', 'check', '--json']);
  assert.equal(check.code, 0, 'a warning, not an error');
  assert.match(check.json.warnings.join(' '), /"src" is a folder .* write "src\/\*\*"/);
  writeConfig(dir, {});
  write(dir, 'src/math.js', 'x\n');
  git(dir, 'add', '-A');
  const g = pocp(dir, ['gate', '--json']);
  assert.ok(g.json.warnings.some((w) => w.code === 'rule_glob'));
});
