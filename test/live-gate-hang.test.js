// Live gate test (never merged): hangs in GitHub Actions on a run's first attempt, so verify's
// re-run times out (inconclusive). A re-run of the job (attempt 2) finishes and passes.
import { test } from 'node:test';

test('live gate: a deliberate hang on the first attempt in CI', async () => {
  if (process.env.GITHUB_ACTIONS === 'true' && process.env.GITHUB_RUN_ATTEMPT === '1') {
    setInterval(() => {}, 1000);
    await new Promise(() => {});
  }
});
