// POCP's policy algebra (src/policy.js): what a change loosens, how the base's and the head's
// policies combine, which findings block, and which changes are policy changes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blockingRule, combinePolicy, EXCEPTIONS_FILE, POLICY_FILES, policyChange, policyFilesTouched, policyLoosenings } from '../src/policy.js';
import { rulesWithDefaults, withDefaults } from '../src/store.js';

const req = (id, glob) => ({ id, glob, obligation: { kind: 'test', run: `npm test -- ${id}` }, source: 'author' });
const rules = (...reqs) => rulesWithDefaults({ requirements: reqs });
const config = (extra = {}) => withDefaults(extra);

test('loosenings: each part is compared only when given', () => {
  const base = rules(req('unit', 'src/**'));
  const head = rules();
  assert.deepEqual(policyLoosenings({}), []);
  assert.deepEqual(policyLoosenings({ rules: { base, head } }), ['requirement "unit" removed or changed']);
  // No base rules (a repository adopting POCP): nothing to loosen.
  assert.deepEqual(policyLoosenings({ rules: { base: null, head } }), []);
  assert.deepEqual(policyLoosenings({ rules: { base, head: base } }), []);
  assert.deepEqual(policyLoosenings({ config: { base: config({ verify: { require_ci: ['npm test'] } }), head: config() } }), ['verify.require_ci no longer requires "npm test"']);
});

test('loosenings: a new signer key, or any change to the exception list', () => {
  const key = 'alice ssh-ed25519 AAAA';
  assert.deepEqual(policyLoosenings({ signers: { base: null, head: key } }), ['allowed_signers gained a key']);
  assert.deepEqual(policyLoosenings({ signers: { base: `${key}\n`, head: key } }), [], 'whitespace only');
  assert.deepEqual(policyLoosenings({ signers: { base: `${key}\nbob ssh-ed25519 BBBB`, head: key } }), [], 'removing a key tightens');
  assert.deepEqual(policyLoosenings({ exceptions: { base: null, head: '{"uncovered":[]}' } }), [`${EXCEPTIONS_FILE} changed (exceptions for commits with no proof record)`]);
  assert.deepEqual(policyLoosenings({ exceptions: { base: '{}', head: '{}\n' } }), []);
});

test('loosenings come in a fixed order: rules, config, signers, exceptions', () => {
  const out = policyLoosenings({
    rules: { base: rules(req('unit', 'src/**')), head: rules() },
    config: { base: config({ verify: { require_ci: ['npm test'] } }), head: config() },
    signers: { base: '', head: 'k' },
    exceptions: { base: '', head: '{}' },
  });
  assert.deepEqual(out.map((l) => l.split(' ')[0]), ['requirement', 'verify.require_ci', 'allowed_signers', EXCEPTIONS_FILE]);
});

test('combination: the base judges the head, strictly, unless approved or not enrolled', () => {
  const base = { hasRules: true, rules: rules(req('unit', 'src/**')), config: config({ verify: { require_ci: ['npm test'] } }) };
  const head = { hasRules: true, rules: rules(req('lint', 'src/**')), config: config() };
  const strict = combinePolicy({ base, head });
  assert.deepEqual(strict.rules.requirements.map((r) => r.id).sort(), ['lint', 'unit'], 'both the base\'s and the head\'s requirements apply');
  assert.deepEqual(strict.config.verify.require_ci, ['npm test'], 'the base\'s required CI stays');
  assert.equal(combinePolicy({ base, head, accepted: true }).rules, head.rules, 'an approved loosening: the head\'s policy');
  assert.equal(combinePolicy({ base: null, head }).rules, head.rules, 'no enrolled base: the head\'s policy');
  // A base whose rules file is missing or invalid contributes no requirements, but its config still counts.
  const noRules = combinePolicy({ base: { ...base, hasRules: false }, head });
  assert.deepEqual(noRules.rules.requirements.map((r) => r.id), ['lint']);
  assert.deepEqual(noRules.config.verify.require_ci, ['npm test']);
});

test('blocking: fail_on decides, children block with their parent, invalid policy always', () => {
  const { blocks, failOn } = blockingRule(config({ verify: { fail_on: ['test_change', 'ci_failed'] } }));
  assert.deepEqual([...failOn].sort(), ['ci_failed', 'test_change']);
  for (const code of ['test_change', 'test_inconclusive', 'ci_failed', 'ci_unfinished', 'invalid_policy']) assert.equal(blocks(code), true, code);
  for (const code of ['failed_proof', 'unfinished_proof', 'invalid_signature', 'signature_unavailable', 'uncovered']) assert.equal(blocks(code), false, code);
  assert.equal(blockingRule(config({ verify: { fail_on: [] } })).blocks('invalid_policy'), true);
});

test('policy changes: any of the four policy files, by path or old path', () => {
  assert.deepEqual(POLICY_FILES, ['.proof/rules.json', '.proof/config.json', '.proof/allowed_signers', '.proof/exceptions.json']);
  assert.deepEqual(policyFilesTouched([{ path: 'src/a.js' }]), []);
  assert.deepEqual(policyFilesTouched([{ path: 'x', oldPath: '.proof/config.json' }, { path: '.proof/rules.json' }]), ['.proof/rules.json', '.proof/config.json']);
  assert.equal(policyChange([{ path: 'src/a.js' }], rules(), rules()), null);
  const pc = policyChange([{ path: '.proof/rules.json' }], rules(req('lint', 'src/**')), rules(req('unit', 'src/**'), req('lint', 'src/**')));
  assert.deepEqual(pc.files, ['.proof/rules.json']);
  assert.deepEqual(pc.reason.removed_requirements, ['unit']);
  assert.match(pc.reason.detail, /requirements removed: unit/);
  assert.deepEqual(policyChange([{ path: '.proof/rules.json' }], rules(), null).reason.removed_requirements, [], 'no earlier rules: nothing removed');
});
