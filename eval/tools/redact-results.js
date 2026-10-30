#!/usr/bin/env node
// Redact personal paths in every text file under eval/results/ (README rule 9), in place.
// Writes eval/results/REDACTIONS.md: each file changed, with its sha256 before and after, so
// the edit is on the record. Values other than paths are never touched.
//
//   node eval/tools/redact-results.js          # dry run: list what would change
//   node eval/tools/redact-results.js --write
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { POCP_ROOT } from '../lib/pins.js';
import { personalPaths, redactText } from '../lib/redact.js';

const RESULTS = path.join(POCP_ROOT, 'eval', 'results');
const TEXT = /\.(jsonl?|md|txt|log|diff|ids|marks|csv)$/i;
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

export function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.isFile() && TEXT.test(e.name) && e.name !== 'REDACTIONS.md') out.push(p);
  }
  return out.sort();
}

export function redactAll({ write = false, root = RESULTS } = {}) {
  const changed = [];
  for (const f of walk(root)) {
    const before = fs.readFileSync(f, 'utf8');
    const after = redactText(before);
    if (after === before) continue;
    changed.push({ file: path.relative(POCP_ROOT, f), before: sha(before), after: sha(after), left: personalPaths(after) });
    if (write) fs.writeFileSync(f, after);
  }
  return changed;
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const write = process.argv.includes('--write');
  const changed = redactAll({ write });
  for (const c of changed) console.log(`${write ? 'redacted' : 'would redact'} ${c.file}${c.left.length ? `  (still: ${c.left.join(', ')})` : ''}`);
  if (write && changed.length) {
    const log = path.join(RESULTS, 'REDACTIONS.md');
    const head = fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '# Path redactions\n\nFiles under `eval/results/` whose absolute paths were replaced by `eval/tools/redact-results.js` (README rule 9). Only paths changed; sha256 before and after.\n\n| File | Before | After | Date |\n|---|---|---|---|\n';
    const at = new Date().toISOString().slice(0, 10);
    fs.writeFileSync(log, head + changed.map((c) => `| \`${c.file}\` | \`${c.before.slice(0, 16)}\` | \`${c.after.slice(0, 16)}\` | ${at} |`).join('\n') + '\n');
  }
  console.log(`${changed.length} file(s)`);
}
