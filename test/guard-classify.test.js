// How the test guard reads a base run (SPEC §6.2): only a run that ended normally with a
// failing result means the tests were already red. Anything else is inconclusive.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ranAndFailed } from '../src/guard-check.js';

test('a check that ran to the end and failed counts as already red', () => {
  assert.equal(ranAndFailed({ passed: false, exit: 1 }), true);
  assert.equal(ranAndFailed({ passed: false, exit: 2 }), true);
  assert.equal(ranAndFailed({ passed: false, exit: 0 }), true, 'exit 0 that missed its expected output still ran to the end');
});

test('runs that did not finish normally are not counted as red tests', () => {
  assert.equal(ranAndFailed({ passed: true, exit: 0 }), false, 'a pass');
  assert.equal(ranAndFailed({ passed: false, exit: null, timed_out: true }), false, 'timed out');
  assert.equal(ranAndFailed({ passed: false, exit: null, signal: 'SIGKILL' }), false, 'killed by a signal');
  assert.equal(ranAndFailed({ passed: false, exit: null, error: 'spawn /bin/sh ENOENT' }), false, 'could not start');
  assert.equal(ranAndFailed({ passed: false, exit: 127 }), false, 'command not found');
  assert.equal(ranAndFailed({ passed: false, exit: 126 }), false, 'command not executable');
  assert.equal(ranAndFailed({ passed: false, exit: null }), false, 'no exit code');
});
