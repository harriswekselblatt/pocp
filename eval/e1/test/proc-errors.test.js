// Regression: a git step that times out must say so; it used to fail with a blank message.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../lib/proc.js';

test('a command killed by the timeout reports timedOut, so git() can name it', async () => {
  const r = await run(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { timeoutMs: 300 });
  assert.equal(r.timedOut, true);
  assert.notEqual(r.code, 0);
});
