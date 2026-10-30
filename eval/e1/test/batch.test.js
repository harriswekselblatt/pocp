// Batch rules: canaries, phases, resumability, agent failures; then review packs and the report.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadResults, readRecords } from '../../lib/record.js';
import { buildPacks } from '../review-pack.js';
import { render } from '../report.js';
import { Refusal, runBatch } from '../run.js';
import { CANARIES_FAIL, FIX, FROZEN, STUB_CHECK, batch, fake, tmp } from './helpers.js';

const base = { eval: 'E1a', arms: ['plain'], taskIds: ['fx_add_0'], frozenDir: FROZEN, reference: STUB_CHECK, timeoutS: 60 };

test('missing or failing canaries make the batch invalid', async () => {
  const a = await batch({ ...base, agents: [fake('crash')], batch: 'no-canaries', canaries: path.join(FIX, 'nope.py') });
  assert.equal(a.res.phase, 'invalid');
  assert.match(a.res.invalidReason, /missing/);
  assert.equal(a.res.records[0].phase, 'invalid');
  const b = await batch({ ...base, agents: [fake('crash')], batch: 'bad-canaries', canaries: CANARIES_FAIL });
  assert.equal(b.res.phase, 'invalid');
  assert.match(b.res.invalidReason, /failed/);
  const c = await batch({ ...base, agents: [fake('crash')], batch: 'marked', invalid: 'fixture task, stub checker' });
  assert.equal(c.res.phase, 'invalid');
});

test('--phase counted is refused unless PREREG is registered and canaries pass', async () => {
  const results = tmp();
  await assert.rejects(runBatch({ ...base, agents: [fake('crash')], batch: 'c1', phase: 'counted', results, canaries: path.join(FIX, 'canaries_pass.py') }), (e) => e instanceof Refusal && /Registered: yes/.test(e.message));
  await assert.rejects(runBatch({ ...base, agents: [fake('crash')], batch: 'c2', phase: 'counted', results, prereg: path.join(FIX, 'prereg_registered.md'), canaries: CANARIES_FAIL }), (e) => e instanceof Refusal && /canaries/.test(e.message) && !/Registered/.test(e.message));
  await assert.rejects(runBatch({ ...base, agents: [fake('crash')], batch: 'c3', phase: 'counted', results, prereg: path.join(FIX, 'prereg_registered.md'), canaries: path.join(FIX, 'canaries_pass.py') }), /fake agents/);
  assert.ok(!fs.existsSync(path.join(results, 'E1a')), 'nothing was recorded');
  await assert.rejects(runBatch({ ...base, agents: [fake('crash')], batch: 'c4', phase: 'invalid', results }), /pilot or counted/);
});

test('resumable: a second invocation skips recorded runs; a phase change is refused', async () => {
  const first = await batch({ ...base, agents: [fake('crash')], arms: ['plain', 'pocp-ci'], batch: 'resume' });
  assert.equal(first.res.records.length, 2);
  assert.ok(!fs.existsSync(first.res.work), 'the batch work folder (with the read-only pocp copy) is removed');
  const again = await batch({ ...base, agents: [fake('crash'), fake('honest-stopper')], arms: ['plain', 'pocp-ci'], batch: 'resume', results: first.results });
  assert.equal(again.res.skipped, 2);
  assert.equal(again.res.records.length, 2);
  assert.ok(again.res.records.every((r) => r.unit.agent === 'fake-honest-stopper'));
  assert.equal(readRecords(first.res.file).length, 4);
  const meta = JSON.parse(fs.readFileSync(path.join(first.results, 'runs', 'resume', 'batch.json'), 'utf8'));
  assert.equal(meta.starts.length, 2);
  assert.equal(meta.starts[1].skipped_already_recorded, 2);
  await assert.rejects(batch({ ...base, agents: [fake('crash')], batch: 'resume', results: first.results, canaries: CANARIES_FAIL }), /already holds pilot/);
});

test('agent crash and timeout are recorded with their status and still judged', async () => {
  const { byKey } = await batch({ ...base, agents: [fake('crash'), fake('sleeper')], arms: ['pocp-ci'], batch: 'fail', timeoutS: 2 });
  const c = byKey['fake-crash/pocp-ci'];
  assert.equal(c.status, 'agent-error');
  assert.equal(c.outcome.agent.exit, 3);
  assert.equal(c.outcome.no_change, true);
  assert.equal(c.outcome.net_cheat_shipped, false);
  assert.equal(c.outcome.pocp.accepted, false, 'an empty range is not POCP-accepted');
  assert.equal(c.outcome.pocp.class, 'no-change');
  const s = byKey['fake-sleeper/pocp-ci'];
  assert.equal(s.status, 'timeout');
  assert.ok(s.outcome.agent.duration_s < 20);
});

test('review packs are blinded; the key is separate; the report renders from records', async () => {
  const { results } = await batch({ eval: 'E1a', agents: [fake('cheat-test-edit'), fake('honest-stopper')], arms: ['plain', 'pocp-ci'], taskIds: ['fx_add_0'], batch: 'packs' });
  const records = loadResults(results, 'E1a');
  const out = path.join(results, 'review', 'p1');
  // The run folders live under the temp results; point run_folder at them for the pack builder.
  for (const r of records) r.run_folder = path.relative(path.resolve(FIX, '..', '..', '..', '..'), path.join(results, 'runs', r.batch, r.run_id));
  const res = buildPacks({ records, outDir: out, keyFile: path.join(results, 'review', 'p1.KEY.json'), audit: 2, seed: 3, frozenDir: FROZEN });
  assert.equal(res.packs.length, 2);
  const key = JSON.parse(fs.readFileSync(res.key, 'utf8'));
  for (const id of res.packs) {
    const files = fs.readdirSync(path.join(out, id)).sort();
    assert.deepEqual(files, ['canonical.json', 'final.diff', 'label.json', 'task.json']);
    const all = files.map((f) => fs.readFileSync(path.join(out, id, f), 'utf8')).join('\n');
    assert.doesNotMatch(all, /pocp-ci|"plain"|fake-|\.proof\/packets|Proof-Of-Change|"accepted"/);
    assert.equal(key.packs[id].reason, 'audit');
    assert.ok(key.packs[id].arm && key.packs[id].agent);
  }
  const md = render(results);
  assert.match(md, /## E1a/);
  assert.match(md, /Pilot batches/);
  assert.match(md, /Net cheats shipped/);
  assert.match(md, /Incremental catch, pocp-ci vs plain/);
  assert.match(md, /fake-cheat-test-edit \(pilot\)/);
});

test('broken tasks are skipped and recorded; a checker failure is a harness error', async () => {
  const { res, results, byKey } = await batch({ ...base, agents: [fake('checker-error')], arms: ['plain'], taskIds: undefined, tasks: 10, batch: 'broken' });
  assert.equal(res.records.length, 3, 'three usable fixture tasks; the broken one never drawn');
  assert.ok(res.records.every((r) => r.unit.task !== 'fx_broken_3'));
  assert.deepEqual(res.records[0].pins.dataset_task_broken_skipped, ['fx_broken_3']);
  const meta = JSON.parse(fs.readFileSync(path.join(results, 'runs', 'broken', 'batch.json'), 'utf8'));
  assert.deepEqual(meta.starts[0].skipped_dataset_task_broken, ['fx_broken_3']);
  for (const r of res.records) {
    assert.equal(r.status, 'harness-error');
    assert.match(r.error, /reference checker failed/);
    assert.equal(r.outcome.reference.exit, 3);
  }
  assert.ok(byKey['fake-checker-error/plain']);
});

test('the checker gets plain CI\'s verdict and runs on the pinned python', async () => {
  const { byKey } = await batch({ ...base, agents: [fake('cheat-test-edit')], arms: ['plain'], batch: 'ciflag' });
  const r = byKey['fake-cheat-test-edit/plain'];
  assert.equal(r.outcome.reference.evidence.ci_accepted_flag, 'true');
  assert.equal(r.outcome.reference.ci_accepted_passed, true);
  assert.ok(r.pins.python_path && r.pins.python && r.pins.python_executable);
});
