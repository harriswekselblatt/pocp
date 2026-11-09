// Unknown keys in .proof/rules.json and .proof/config.json: POCP ignores them, so a misspelling
// silently turns a setting off. They are reported as warnings, with the key that was probably
// meant, and never change what passes or blocks. Keys starting with "$" are comments.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { git, pocp, sampleRepo, sh, tmpRepo, write } from './helpers.js';
import { TWEAK_ADD } from './fixtures.js';
import { CONFIG_SCHEMA, RULES_SCHEMA, policyKeyWarnings, unknownKeys } from '../src/schema.js';
import { DEFAULT_CONFIG, DEFAULT_RULES } from '../src/store.js';

test('unknown keys at every level, with the key probably meant', () => {
  assert.deepEqual(unknownKeys({ verify: { fail_one: [] } }, CONFIG_SCHEMA), [{ path: 'verify.fail_one', suggestion: 'fail_on' }]);
  assert.deepEqual(unknownKeys({ requirements: [{ id: 'a', glob: 'x', obligation: { kind: 'test', run: 'x', timout_ms: 1 } }] }, RULES_SCHEMA), [{ path: 'requirements[0].obligation.timout_ms', suggestion: 'timeout_ms' }]);
  assert.deepEqual(unknownKeys({ triggers: { glbos: [], cross_area: { area: 3 } } }, RULES_SCHEMA), [{ path: 'triggers.glbos', suggestion: 'globs' }, { path: 'triggers.cross_area.area', suggestion: 'areas' }]);
  assert.deepEqual(unknownKeys({ Verify: {} }, CONFIG_SCHEMA), [{ path: 'Verify', suggestion: 'verify' }], 'case is a typo too');
  assert.deepEqual(unknownKeys({ colour: 'blue' }, CONFIG_SCHEMA), [{ path: 'colour', suggestion: null }], 'nothing close: no suggestion');
});

test('"$" keys are comments, wrong types are left to validation, and the defaults are known', () => {
  assert.deepEqual(unknownKeys({ $why: 'x', verify: { $note: 'y', fail_on: [] }, requirements: [{ $todo: 1, id: 'a' }] }, { ...RULES_SCHEMA, ...CONFIG_SCHEMA }), []);
  assert.deepEqual(unknownKeys({ verify: 'not an object', requirements: 'not a list', triggers: { globs: [null, 3] } }, { ...RULES_SCHEMA, ...CONFIG_SCHEMA }), []);
  assert.deepEqual(unknownKeys(null, CONFIG_SCHEMA), []);
  assert.deepEqual(unknownKeys(DEFAULT_CONFIG, CONFIG_SCHEMA), [], 'every default config key is known');
  assert.deepEqual(unknownKeys(DEFAULT_RULES, RULES_SCHEMA), [], 'every default rules key is known');
  assert.deepEqual(policyKeyWarnings({ rules: null, config: undefined }), []);
});

test('what pocp init writes, and this repository\'s own policy, have no unknown keys', () => {
  for (const flags of [[], ['--deep'], ['--github']]) {
    const dir = tmpRepo();
    assert.equal(pocp(dir, ['init', ...flags]).code, 0);
    const read = (f) => JSON.parse(fs.readFileSync(path.join(dir, '.proof', f), 'utf8'));
    assert.deepEqual(policyKeyWarnings({ rules: read('rules.json'), config: read('config.json') }), [], flags.join(' '));
  }
  const own = (f) => JSON.parse(fs.readFileSync(new URL(`../.proof/${f}`, import.meta.url), 'utf8'));
  assert.deepEqual(policyKeyWarnings({ rules: own('rules.json'), config: own('config.json') }), []);
});

/** A sample repository whose config has a misspelled key (and a comment). `commit`: commit it. */
function withTypo({ commit = false } = {}) {
  const dir = sampleRepo({ hooks: true, deep: false });
  const before = git(dir, 'rev-parse', 'HEAD');
  const cfg = JSON.parse(fs.readFileSync(path.join(dir, '.proof/config.json'), 'utf8'));
  write(dir, '.proof/config.json', JSON.stringify({ ...cfg, $why: 'kept as a comment', verify: { ...(cfg.verify || {}), fail_one: ['uncovered'] } }, null, 2));
  if (commit) {
    git(dir, 'add', '-A');
    git(dir, '-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', 'add a typo');
  }
  return { dir, before };
}

test('rules check and doctor warn, with the same exit as before', () => {
  const { dir } = withTypo();
  const rc = pocp(dir, ['rules', 'check', '--json']);
  assert.equal(rc.code, 0);
  assert.equal(rc.json.ok, true);
  assert.equal(rc.json.warnings.length, 1);
  assert.match(rc.json.warnings[0], /\.proof\/config\.json: unknown key "verify\.fail_one" is ignored \(did you mean "fail_on"\?\)/);
  const d = pocp(dir, ['doctor', '--json']);
  const check = d.json.checks.find((c) => c.id === 'policy_keys');
  assert.equal(check?.status, 'warning');
  assert.match(check.what, /verify\.fail_one/);
});

test('gate and verify warn, and decide exactly as without the typo', () => {
  const run = (dir) => {
    const base = git(dir, 'rev-parse', 'HEAD');
    write(dir, 'src/math.js', TWEAK_ADD);
    git(dir, 'add', '-A');
    const gate = pocp(dir, ['gate', '--json']);
    assert.equal(pocp(dir, ['fix', '--intent', 'change']).code, 0);
    sh(dir, 'git', ['commit', '-q', '-m', 'change']);
    const verify = pocp(dir, ['verify', `${base}..HEAD`, '--rerun', '--require-coverage', '--json']);
    return { gate, verify };
  };
  const typoRepo = withTypo({ commit: true });
  const typo = run(typoRepo.dir);
  const control = run(sampleRepo({ hooks: true, deep: false }));
  assert.equal(typo.gate.code, control.gate.code);
  assert.equal(typo.gate.json.decision, control.gate.json.decision);
  assert.equal(typo.gate.json.warnings.filter((w) => w.code === 'unknown_key').length, 1);
  assert.equal(typo.verify.code, control.verify.code);
  assert.deepEqual(typo.verify.json.commits.map((c) => c.findings.map((f) => [f.code, f.blocking])), control.verify.json.commits.map((c) => c.findings.map((f) => [f.code, f.blocking])));
  assert.deepEqual(typo.verify.json.commits[0].warnings.filter((w) => w.includes('unknown key')), [], 'a commit that leaves the policy alone does not repeat it');
  // The commit that brought the typo in is where verify reports it.
  const whole = pocp(typoRepo.dir, ['verify', `${typoRepo.before}..HEAD`, '--json']);
  assert.ok(whole.json.commits[0].warnings.some((w) => w.includes('verify.fail_one')), JSON.stringify(whole.json.commits[0].warnings));
});
