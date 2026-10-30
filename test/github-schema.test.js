// The --apply payload checked against GitHub's own API description for
// PUT /repos/{owner}/{repo}/branches/{branch}/protection (test/fixtures, from
// github/rest-api-description). A small validator covering the keywords that schema uses.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { protectionPayload } from '../src/ci-github.js';

const { schema } = JSON.parse(fs.readFileSync(new URL('./fixtures/github-branch-protection-put.schema.json', import.meta.url), 'utf8'));

function validate(value, s, path = '$', errors = []) {
  if (value === null) {
    if (!s.nullable) errors.push(`${path}: null is not allowed`);
    return errors;
  }
  if (s.oneOf || s.anyOf) {
    const options = s.oneOf || s.anyOf;
    const ok = options.filter((o) => validate(value, o, path, []).length === 0).length;
    if (s.oneOf ? ok !== 1 : ok < 1) errors.push(`${path}: does not match ${s.oneOf ? 'exactly one' : 'any'} allowed shape`);
    return errors;
  }
  const t = s.type;
  const actual = Array.isArray(value) ? 'array' : Number.isInteger(value) ? 'integer' : typeof value;
  if (t && !(t === actual || (t === 'number' && actual === 'integer'))) {
    errors.push(`${path}: expected ${t}, got ${actual}`);
    return errors;
  }
  if (s.enum && !s.enum.includes(value)) errors.push(`${path}: ${JSON.stringify(value)} not in ${JSON.stringify(s.enum)}`);
  if (t === 'object') {
    for (const k of s.required || []) if (!(k in value)) errors.push(`${path}: missing required "${k}"`);
    for (const [k, v] of Object.entries(value)) {
      if (s.properties?.[k]) validate(v, s.properties[k], `${path}.${k}`, errors);
      else if (s.additionalProperties === false) errors.push(`${path}: unexpected "${k}"`);
    }
  }
  if (t === 'array' && s.items) value.forEach((v, i) => validate(v, s.items, `${path}[${i}]`, errors));
  return errors;
}

test('the validator itself catches schema violations', () => {
  assert.deepEqual(validate({ required_status_checks: null, enforce_admins: null, required_pull_request_reviews: null, restrictions: null }, schema), []);
  assert.ok(validate({}, schema).some((e) => e.includes('missing required "required_status_checks"')));
  const missingContexts = { required_status_checks: { strict: false, checks: [{ context: 'x' }] }, enforce_admins: true, required_pull_request_reviews: null, restrictions: null };
  assert.ok(validate(missingContexts, schema).some((e) => e.includes('missing required "contexts"')), 'the payload POCP used to send is rejected');
  assert.ok(validate({ ...missingContexts, required_status_checks: { strict: 'no', contexts: [] } }, schema).some((e) => e.includes('expected boolean')));
  assert.ok(validate({ ...missingContexts, restrictions: { users: [] } }, schema).some((e) => e.includes('missing required "teams"')));
});

const plan = { branch: 'main', required_checks: ['verify', 'tests'], require_pull_request: true, enforce_admins: true };

test('a fresh --apply payload matches GitHub\'s schema', () => {
  const { payload } = protectionPayload(null, plan);
  assert.deepEqual(validate(payload, schema), []);
  assert.deepEqual(payload.required_status_checks.contexts, ['verify', 'tests']);
  assert.deepEqual(payload.required_status_checks.checks.map((c) => c.context), payload.required_status_checks.contexts, 'contexts and checks name the same checks');
});

test('a payload merged with existing protection matches GitHub\'s schema', () => {
  const existing = {
    required_status_checks: { strict: true, contexts: ['lint'], checks: [{ context: 'lint', app_id: 15368 }] },
    enforce_admins: { enabled: false },
    required_pull_request_reviews: {
      dismiss_stale_reviews: true, require_code_owner_reviews: false, required_approving_review_count: 1, require_last_push_approval: true,
      dismissal_restrictions: { users: [{ login: 'alice' }], teams: [], apps: [] },
      bypass_pull_request_allowances: { users: [], teams: [{ slug: 'release' }], apps: [] },
    },
    restrictions: { users: [], teams: [{ slug: 'core' }], apps: [] },
    required_linear_history: { enabled: true },
  };
  const { payload } = protectionPayload(existing, { ...plan, require_pull_request: false, enforce_admins: false });
  assert.deepEqual(validate(payload, schema), []);
  assert.deepEqual(payload.required_status_checks.contexts, ['lint', 'verify', 'tests']);
  assert.deepEqual(payload.required_status_checks.checks, [{ context: 'lint', app_id: 15368 }, { context: 'verify' }, { context: 'tests' }]);
});
