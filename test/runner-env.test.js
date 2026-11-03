import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildEnv } from '../src/runner.js';

test('checks never inherit NODE_TEST_CONTEXT (a nested node --test would hide failures)', () => {
  const before = process.env.NODE_TEST_CONTEXT;
  process.env.NODE_TEST_CONTEXT = 'child-v8';
  try {
    assert.equal(buildEnv({}).NODE_TEST_CONTEXT, undefined);
    assert.equal(buildEnv({ mode: 'minimal', allow: ['NODE_TEST_CONTEXT'] }).NODE_TEST_CONTEXT, undefined, 'not even when allowed by name');
  } finally {
    if (before === undefined) delete process.env.NODE_TEST_CONTEXT;
    else process.env.NODE_TEST_CONTEXT = before;
  }
});
