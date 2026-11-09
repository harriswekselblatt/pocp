// The run records live in their own repository; eval/results.sha256 pins exactly which files the
// reports came from. A local copy counts only when it matches that list.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { POCP_ROOT } from '../pins.js';
import { checkResults, readManifest, RESULTS_COMMIT, RESULTS_REPO } from '../results-source.js';

const MANIFEST = path.join(POCP_ROOT, 'eval', 'results.sha256');
const sha256Of = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

test('the checksum list is well formed: one line per file, sorted, no duplicates', () => {
  const entries = readManifest(fs.readFileSync(MANIFEST, 'utf8'));
  assert.ok(entries.length > 0);
  const files = entries.map((e) => e.file);
  assert.equal(new Set(files).size, files.length, 'no file twice');
  assert.deepEqual(files, [...files].sort((a, b) => (Buffer.from(a) < Buffer.from(b) ? -1 : 1)), 'sorted bytewise');
  assert.match(RESULTS_COMMIT, /^[0-9a-f]{40}$/, 'pinned to one commit');
  assert.match(RESULTS_REPO, /^https:\/\/github\.com\//);
  assert.throws(() => readManifest('not a checksum line\n'), /not "<sha256>  results\/<path>"/);
});

test('a copy matches only when no file is changed, missing or added', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pocp-results-'));
  try {
    fs.mkdirSync(path.join(root, 'results', 'E1a'), { recursive: true });
    fs.writeFileSync(path.join(root, 'results', 'E1a', 'a.jsonl'), '{"a":1}\n');
    fs.writeFileSync(path.join(root, 'results', 'REDACTIONS.md'), '# none\n');
    const manifest = readManifest([
      '5b0f3b1d9c4f4bb0d1aa1a7c1ff1a1b6ff56b7a5c1a33b1b8f4e4d5a5f7d1e2c  results/E1a/a.jsonl',
      '0000000000000000000000000000000000000000000000000000000000000000  results/REDACTIONS.md',
    ].join('\n'));
    // The list above is made up: both files differ from it.
    assert.deepEqual(checkResults(root, manifest).changed, ['results/E1a/a.jsonl', 'results/REDACTIONS.md']);
    const real = (file) => ({ file, sha256: sha256Of(path.join(root, file)) });
    const good = [real('results/E1a/a.jsonl'), real('results/REDACTIONS.md')];
    assert.deepEqual(checkResults(root, good), { ok: true, changed: [], missing: [], extra: [] });
    fs.writeFileSync(path.join(root, 'results', 'E1a', 'b.jsonl'), '{}\n');
    assert.deepEqual(checkResults(root, good).extra, ['results/E1a/b.jsonl']);
    fs.rmSync(path.join(root, 'results', 'REDACTIONS.md'));
    assert.deepEqual(checkResults(root, good).missing, ['results/REDACTIONS.md']);
    assert.equal(checkResults(root, good).ok, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a fetched copy in this checkout matches the list (skipped when none was fetched)', (t) => {
  const eval_ = path.join(POCP_ROOT, 'eval');
  if (!fs.existsSync(path.join(eval_, 'results'))) return t.skip('eval/results/ not fetched (node eval/tools/fetch-results.js)');
  const r = checkResults(eval_, readManifest(fs.readFileSync(MANIFEST, 'utf8')));
  assert.ok(r.ok, JSON.stringify(r));
});
