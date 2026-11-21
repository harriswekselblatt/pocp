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

// The pilot counted limit errors as agent outcomes; they are the harness's problem.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MAX_LIMIT_RERUNS, infraFailure, nextAttempt, unitRunId } from '../run.js';
import { render } from '../report.js';
import { loadResults } from '../../lib/record.js';

test('a usage-limit run is a harness error, never judged, and is re-run on resume with supersedes', async () => {
  const marker = path.join(os.tmpdir(), `e1-limit-once-${process.pid}`);
  fs.rmSync(marker, { force: true });
  try {
    const opts = { ...base, agents: [fake('limit-once')], arms: ['plain'], batch: 'limit-rerun' };
    const first = await batch(opts);
    const [r1] = first.res.records;
    assert.equal(r1.status, 'harness-error');
    assert.equal(r1.outcome.infra, 'usage-limit');
    assert.match(r1.error, /^usage-limit: You've hit your weekly limit/);
    assert.equal(r1.outcome.reference, undefined, 'not judged');
    assert.match(first.res.stopped || '', /usage limit/);

    const second = await batch({ ...opts, results: first.results });
    const [r2] = second.res.records;
    assert.equal(r2.supersedes, r1.run_id);
    assert.equal(r2.unit.rerun, 1);
    assert.notEqual(r2.run_id, r1.run_id);
    assert.equal(r2.status, 'completed');
    assert.equal(second.res.stopped || null, null);

    const kept = loadResults(first.results, 'E1a');
    assert.deepEqual(kept.map((r) => r.run_id), [r2.run_id], 'only the re-run is counted');
    const md = render(first.results);
    assert.match(md, /Superseded by a re-run.*usage-limit 1/);

    const third = await batch({ ...opts, results: first.results });
    assert.equal(third.res.records.length, 0, 'a finished unit is not run again');
  } finally {
    fs.rmSync(marker, { force: true });
  }
});

test('re-runs after a usage limit stop at the cap', () => {
  const parts = { batch: 'b', eval: 'E1a', split: 'conflicting', task: 't', agent: 'a', arm: 'plain', seed: 1 };
  const limited = (k) => ({ run_id: unitRunId(parts, k), outcome: { infra: 'usage-limit' } });
  const byId = new Map();
  assert.deepEqual(nextAttempt(parts, byId), { rerun: 0 });
  for (let k = 0; k <= MAX_LIMIT_RERUNS; k++) {
    assert.deepEqual(nextAttempt(parts, byId), k === 0 ? { rerun: 0 } : { rerun: k, supersedes: unitRunId(parts, k - 1) });
    byId.set(unitRunId(parts, k), limited(k));
  }
  assert.equal(nextAttempt(parts, byId), null, `no more than ${MAX_LIMIT_RERUNS} re-runs`);
  assert.equal(nextAttempt(parts, new Map([[unitRunId(parts), { run_id: unitRunId(parts), outcome: {} }]])), null, 'ordinary outcomes are final');
});

test('infraFailure: limits only when the CLI did not finish cleanly; model pins', () => {
  assert.equal(infraFailure({ status: 'agent-error', error: 'API Error: 429 rate limit' }).kind, 'usage-limit');
  assert.equal(infraFailure({ status: 'timeout', final_text: 'Claude usage limit reached' }).kind, 'usage-limit');
  assert.equal(infraFailure({ status: 'completed', final_text: 'Implemented the rate limiter; usage limit tests pass' }), null);
  assert.equal(infraFailure({ status: 'agent-error', error: 'SyntaxError' }), null);
  assert.equal(infraFailure({ status: 'completed', model_used: 'other-model' }, { model: 'pinned-model' }).kind, 'model-mismatch');
  assert.equal(infraFailure({ status: 'completed', model_used: 'pinned-model' }, { model: 'pinned-model' }), null);
  assert.equal(infraFailure({ status: 'completed', model_used: 'x' }), null, 'no pin, no check');
});
