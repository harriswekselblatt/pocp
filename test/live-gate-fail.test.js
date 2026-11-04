// Live gate test (never merged): fails only in GitHub Actions, so verify's re-run fails for real.
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('live gate: a deliberate failure in CI', () => {
  if (process.env.GITHUB_ACTIONS === 'true') assert.fail('deliberate CI-only failure (live gate test)');
});
