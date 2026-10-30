// A usage limit stops the batch: one failed run is recorded, the rest aren't started.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FROZEN, STUB_CHECK, batch, fake } from './helpers.js';
import { usageLimitHit } from '../run.js';

const base = { eval: 'E1a', taskIds: ['fx_add_0'], frozenDir: FROZEN, reference: STUB_CHECK, timeoutS: 60, concurrency: 1 };

test('the first usage-limit error stops the batch', async () => {
  const r = await batch({ ...base, agents: [fake('usage-limit')], arms: ['plain', 'pocp-ci', 'pocp-hooks'], batch: 'limit' });
  assert.equal(r.res.records.length, 1, 'only the run that hit the limit is recorded');
  assert.match(r.res.stopped || '', /usage limit/);
});

test('ordinary agent failures do not stop a batch', async () => {
  const r = await batch({ ...base, agents: [fake('crash')], arms: ['plain', 'pocp-ci'], batch: 'crash' });
  assert.equal(r.res.records.length, 2);
  assert.equal(r.res.stopped || null, null);
});

test('limit messages are recognised', () => {
  const rec = (error) => ({ status: 'agent-error', outcome: { agent: { error } } });
  for (const m of ["You've hit your weekly limit · resets 11am", 'Claude usage limit reached', 'Rate limit exceeded (429)', 'You have exceeded your quota']) assert.ok(usageLimitHit(rec(m)), m);
  assert.ok(!usageLimitHit(rec('SyntaxError: unexpected token')));
  assert.ok(!usageLimitHit({ status: 'completed', outcome: { agent: { error: 'weekly limit' } } }));
});
