// Run records (eval/README.md "The run record"): append-only JSONL, validated on write.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { redactValue } from './redact.js';

export const SCHEMA = 'pocp-eval-run/1';
export const EVALS = ['E1a', 'E1b', 'E2', 'E3', 'E4', 'E5'];
export const PHASES = ['pilot', 'counted', 'invalid'];
export const STATUSES = ['completed', 'agent-error', 'timeout', 'harness-error'];
export const EXCLUSIONS = ['harness-error-rerun', 'canary-failed-batch', 'dataset-task-broken'];

/** Problems with a record, as strings. Empty means valid. */
export function validateRecord(r) {
  const errs = [];
  const need = (cond, msg) => { if (!cond) errs.push(msg); };
  need(r && typeof r === 'object', 'record must be an object');
  if (errs.length) return errs;
  need(r.schema === SCHEMA, `schema must be ${SCHEMA}`);
  need(EVALS.includes(r.eval), `eval must be one of ${EVALS.join(', ')}`);
  need(typeof r.batch === 'string' && r.batch.length > 0, 'batch is required');
  need(PHASES.includes(r.phase), `phase must be one of ${PHASES.join(', ')}`);
  need(typeof r.run_id === 'string' && r.run_id.length > 0, 'run_id is required');
  need(r.unit && typeof r.unit === 'object', 'unit is required');
  need(r.pins && typeof r.pins === 'object', 'pins are required');
  if (r.pins) need(typeof r.pins.pocp_commit === 'string' && r.pins.pocp_commit.length >= 7, 'pins.pocp_commit is required');
  need(STATUSES.includes(r.status), `status must be one of ${STATUSES.join(', ')}`);
  need(r.excluded === null || r.excluded === undefined || EXCLUSIONS.includes(r.excluded), `excluded must be null or one of ${EXCLUSIONS.join(', ')}`);
  need(typeof r.started_at === 'string' && !Number.isNaN(Date.parse(r.started_at)), 'started_at must be an ISO time');
  need(r.outcome && typeof r.outcome === 'object', 'outcome is required');
  return errs;
}

export function runId(parts) {
  return crypto.createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 16);
}

/**
 * Append one record to results/<eval>/<batch>.jsonl. Refuses invalid records and a run_id
 * already in the file (records are never edited; corrections use `supersedes`).
 */
export function appendRecord(resultsDir, record) {
  // Paths are redacted before anything is written (README rule 9): no user names or home folders.
  const full = redactValue({ schema: SCHEMA, excluded: null, ...record });
  const errs = validateRecord(full);
  if (errs.length) throw new Error(`invalid run record: ${errs.join('; ')}`);
  const dir = path.join(resultsDir, full.eval);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${full.batch}.jsonl`);
  if (fs.existsSync(file)) {
    for (const prev of readRecords(file)) {
      if (prev.run_id === full.run_id) throw new Error(`run_id ${full.run_id} already recorded in ${file}`);
    }
  }
  fs.appendFileSync(file, `${JSON.stringify(full)}\n`);
  return file;
}

export function readRecords(file) {
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

/** All records in a results folder (optionally one eval), with superseded ones dropped. */
export function loadResults(resultsDir, evalName) {
  const dirs = evalName ? [path.join(resultsDir, evalName)] : EVALS.map((e) => path.join(resultsDir, e));
  const out = [];
  for (const d of dirs) {
    if (!fs.existsSync(d)) continue;
    for (const f of fs.readdirSync(d).filter((x) => x.endsWith('.jsonl')).sort()) out.push(...readRecords(path.join(d, f)));
  }
  const superseded = new Set(out.map((r) => r.supersedes).filter(Boolean));
  return out.filter((r) => !superseded.has(r.run_id));
}
