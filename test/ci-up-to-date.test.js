// ci.require_up_to_date: GitHub's "branches must be up to date before merging" (strict). Without
// it, what merges is the pull request plus base commits nobody verified together with it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { protectionGaps } from '../src/ci-github.js';
import { configWeakening, validateConfig, withDefaults } from '../src/store.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const plan = (over = {}) => ({ branch: 'main', required_checks: ['pocp'], require_pull_request: true, enforce_admins: false, require_up_to_date: true, ...over });
const protection = (strict) => ({ required_status_checks: { strict, contexts: ['pocp'], checks: [{ context: 'pocp' }] }, required_pull_request_reviews: {}, enforce_admins: { enabled: false } });

test('a plan that requires up-to-date branches reports protection without strict as a gap', () => {
  assert.match(protectionGaps(protection(false), plan()).join('\n'), /up to date/);
  assert.deepEqual(protectionGaps(protection(true), plan()), []);
  assert.deepEqual(protectionGaps(protection(false), plan({ require_up_to_date: false })), []);
});

test('turning require_up_to_date off is a policy loosening; a non-boolean is invalid', () => {
  const on = withDefaults({ ci: { require_up_to_date: true } });
  const off = withDefaults({ ci: { require_up_to_date: false } });
  assert.ok(configWeakening(on, off).some((w) => /require_up_to_date/.test(w)));
  assert.ok(validateConfig(withDefaults({ ci: { require_up_to_date: 'yes' } })).some((p) => /require_up_to_date/.test(p)));
});

test("POCP's own config lists the checks its workflows produce, and asks for up-to-date branches", () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, '.proof/config.json'), 'utf8'));
  assert.deepEqual(cfg.ci.required_checks, ['pocp', 'test (ubuntu-latest, 20)', 'test (ubuntu-latest, 22)', 'test (ubuntu-latest, 24)', 'eval (ubuntu-latest)']);
  assert.equal(cfg.ci.require_up_to_date, true);
  // Every required check is a job name test.yml (or the reporter) can produce on a pull request.
  const testYml = fs.readFileSync(path.join(ROOT, '.github/workflows/test.yml'), 'utf8');
  assert.match(testYml, /ubuntu-latest/);
  assert.doesNotMatch(cfg.ci.required_checks.join(' '), /macos|\bverify\b/);
});
