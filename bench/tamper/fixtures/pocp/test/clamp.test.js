import test from 'node:test';
import { clamp } from '../src/bench/clamp.js';
import { eq } from '../lib/check.js';

test('bench fixture: clamp keeps values inside the range', () => {
  eq(clamp(5, 0, 10), 5, 'inside');
  eq(clamp(-1, 0, 10), 0, 'below');
  eq(clamp(11, 0, 10), 10, 'above');
});
