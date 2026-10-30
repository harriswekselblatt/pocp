// Shared by the E1 tests: fixture paths and a runBatch wrapper that writes into a temp folder.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runBatch } from '../run.js';

export const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
export const FROZEN = path.join(FIX, 'frozen');
export const STUB_CHECK = path.join(FIX, 'stub_check.py');
export const CANARIES_PASS = path.join(FIX, 'canaries_pass.py');
export const CANARIES_FAIL = path.join(FIX, 'canaries_fail.py');
export const fake = (name) => `fake:${path.join(FIX, 'agents', `${name}.js`)}`;

export function tmp(prefix = 'e1test-') {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

/** runBatch against the fixtures; returns { res, results, byKey } where byKey is "agent/arm". */
export async function batch(opts) {
  const results = opts.results || tmp('e1res-');
  const res = await runBatch({
    phase: 'pilot',
    frozenDir: FROZEN,
    reference: STUB_CHECK,
    canaries: CANARIES_PASS,
    results,
    concurrency: 3,
    timeoutS: 60,
    ...opts,
  });
  const byKey = Object.fromEntries(res.records.map((r) => [`${r.unit.agent}/${r.unit.arm}`, r]));
  return { res, results, byKey };
}
