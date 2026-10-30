import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appendRecord, loadResults, validateRecord } from '../record.js';
import { basePins, verifierHash } from '../pins.js';
import { clusterBootstrap, wilson, wilsonOneSided } from '../stats.js';

const good = () => ({
  eval: 'E1a', batch: 'b1', phase: 'pilot', run_id: 'r1', unit: { task: 't' },
  pins: { pocp_commit: 'abcdef1' }, status: 'completed', started_at: new Date().toISOString(), outcome: {},
});

test('valid records append; invalid and duplicate ones are refused', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evalrec-'));
  appendRecord(dir, good());
  assert.throws(() => appendRecord(dir, good()), /already recorded/);
  assert.throws(() => appendRecord(dir, { ...good(), run_id: 'r2', phase: 'final' }), /phase/);
  assert.throws(() => appendRecord(dir, { ...good(), run_id: 'r3', excluded: 'looked bad' }), /excluded/);
  assert.deepEqual(validateRecord({ schema: 'pocp-eval-run/1', excluded: null, ...good() }), []);
});

test('a superseded record drops out of loaded results', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evalrec-'));
  appendRecord(dir, { ...good(), status: 'harness-error' });
  appendRecord(dir, { ...good(), run_id: 'r1b', supersedes: 'r1' });
  assert.deepEqual(loadResults(dir).map((r) => r.run_id), ['r1b']);
});

test('Wilson intervals match known values', () => {
  const w = wilson(90, 100);
  assert.ok(Math.abs(w.lo - 0.8256) < 0.001 && Math.abs(w.hi - 0.9448) < 0.001, JSON.stringify(w));
  const zero = wilson(0, 100);
  assert.equal(zero.lo, 0);
  assert.ok(Math.abs(zero.hi - 0.0370) < 0.001);
  // 95/100 against a 90% bar: the two-sided 95% lower bound (0.888) misses it, the
  // one-sided 95% lower bound (0.901) just clears it. PREREG §5 uses one-sided bounds.
  assert.ok(wilson(95, 100).lo < 0.9);
  assert.ok(Math.abs(wilsonOneSided(95, 100).lower - 0.9008) < 0.001);
  assert.ok(wilsonOneSided(94, 100).lower < 0.9, '94/100 does not clear 90%');
  assert.equal(wilson(0, 0).p, null);
});

test('cluster bootstrap is seeded and wider than ignoring clusters when clusters disagree', () => {
  const clusters = [{ k: 10, n: 10 }, { k: 0, n: 10 }, { k: 10, n: 10 }, { k: 0, n: 10 }, { k: 5, n: 10 }];
  const a = clusterBootstrap(clusters, { seed: 3 });
  const b = clusterBootstrap(clusters, { seed: 3 });
  assert.deepEqual(a, b);
  const flat = wilson(25, 50);
  assert.ok(a.hi - a.lo > flat.hi - flat.lo, 'clustered interval should be wider here');
});

test('pins name the commit (when in a git checkout) and hash the verifier', () => {
  const p = basePins();
  // POCP runs checks in a snapshot without .git, where there's no commit to name.
  assert.match(p.pocp_commit, /^([0-9a-f]{40}|no-git:[0-9a-f]{16})/);
  assert.match(verifierHash(), /^[0-9a-f]{64}$/);
  assert.ok(p.node.startsWith('v'));
});
