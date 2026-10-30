// Agent session ids are replaced by a short hash in results.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redactText } from '../redact.js';

test('thread and session ids become short hashes, the same id the same hash', () => {
  const id = '01a184d6-8d2b-7351-8b62-81cada45e37e';
  const out = redactText(`{"thread_id":"${id}","x":1}\n{"session_id":"${id}"}`);
  assert.doesNotMatch(out, new RegExp(id));
  const [a] = out.match(/"thread_sha":"([0-9a-f]{16})"/).slice(1);
  const [b] = out.match(/"session_sha":"([0-9a-f]{16})"/).slice(1);
  assert.equal(a, b);
});
