#!/usr/bin/env node
// Blinded review packs (PREREG §6): every `ambiguous` run (and every run the reference checker
// couldn't label), plus a seeded random audit sample of labelled runs.
//
//   node eval/e1/review-pack.js --eval E1a --batch <id>[,<id>…] --audit 30 --seed 7 --name e1a-audit-01
//
// A pack holds what a reviewer needs and nothing that reveals the arm, the agent or POCP's
// verdict: the frozen task, the final diff against the base with every .proof/ change removed
// (POCP arms have a .proof/ folder; plain doesn't), and the canonical results (plain CI and the
// reference checker's evidence, with its own label taken out for the audit sample).
// Commit messages (POCP adds trailers), transcripts and attempt logs are left out.
// The key that maps packs back to runs is written separately, for whoever is not reviewing.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadResults } from '../lib/record.js';
import { prng } from '../lib/stats.js';
import { CONDITIONS, loadTasks } from './lib/tasks.js';
import { EVAL_DIR, POCP_ROOT, writeJson } from './lib/proc.js';

/** Drop every file section of a unified diff whose path is under .proof/. */
export function blindDiff(diff) {
  const parts = diff.split(/(?=^diff --git )/m);
  const kept = parts.filter((p) => {
    const m = p.match(/^diff --git a\/(\S+) b\/(\S+)/);
    return !m || !(m[1].startsWith('.proof/') || m[2].startsWith('.proof/'));
  });
  return kept.join('');
}

/** The reference evidence without its verdict, and with any .proof/ mention scrubbed (it reveals a POCP arm). */
export function stripLabel(evidence) {
  const scrub = (v) => {
    if (typeof v === 'string') return v.includes('.proof') ? '[.proof/ path removed for blinding]' : v;
    if (Array.isArray(v)) return v.filter((x) => !(typeof x === 'string' && x.includes('.proof'))).map(scrub);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).filter(([k]) => !k.includes('.proof')).map(([k, x]) => [k, scrub(x)]));
    return v;
  };
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) return scrub(evidence ?? null);
  const out = { ...evidence };
  for (const k of ['label', 'kind', 'verdict']) delete out[k];
  return scrub(out);
}

export function selectRuns(records, { audit = 0, seed = 1 } = {}) {
  const usable = records.filter((r) => !r.excluded && r.status !== 'harness-error');
  const toReview = usable.filter((r) => r.outcome?.reference?.label === 'ambiguous' || (r.outcome?.reference && !r.outcome.reference.label));
  const rest = usable.filter((r) => ['cheat', 'honest', 'not-solved'].includes(r.outcome?.reference?.label)).sort((a, b) => a.run_id.localeCompare(b.run_id));
  const rand = prng(seed);
  for (let i = rest.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [rest[i], rest[j]] = [rest[j], rest[i]];
  }
  return [
    ...toReview.map((r) => ({ r, reason: r.outcome.reference.label === 'ambiguous' ? 'ambiguous' : 'reference-error' })),
    ...rest.slice(0, audit).map((r) => ({ r, reason: 'audit' })),
  ];
}

export function buildPacks({ records, outDir, keyFile, audit = 0, seed = 1, frozenDir }) {
  const picked = selectRuns(records, { audit, seed });
  const rand = prng(seed + 1);
  const order = picked.map((p) => ({ ...p, k: rand() })).sort((a, b) => a.k - b.k);
  fs.mkdirSync(outDir, { recursive: true });
  const key = { seed, audit, created_at: new Date().toISOString(), packs: {} };
  const taskCache = new Map();
  for (const { r, reason } of order) {
    const id = `pack-${crypto.createHash('sha256').update(`${seed}:${r.run_id}`).digest('hex').slice(0, 10)}`;
    const dir = path.join(outDir, id);
    fs.mkdirSync(dir, { recursive: true });
    const frozenRel = r.pins?.frozen_file;
    const frozenFile = frozenDir ? path.join(frozenDir, path.basename(frozenRel || '')) : path.join(POCP_ROOT, frozenRel || '');
    if (!taskCache.has(frozenFile)) taskCache.set(frozenFile, fs.existsSync(frozenFile) ? loadTasks(frozenFile) : []);
    const task = taskCache.get(frozenFile).find((t) => t.task_id === r.unit.task) || null;
    const mode = CONDITIONS[r.eval]?.mode;
    const diffFile = path.join(POCP_ROOT, r.run_folder || '', 'final.diff');
    const diff = fs.existsSync(diffFile) ? blindDiff(fs.readFileSync(diffFile, 'utf8')) : '(diff not available)';
    writeJson(path.join(dir, 'task.json'), task ? { task_id: task.task_id, mode, prompt: task.prompt, canonical_test: mode === 'original' ? task.original_test ?? task.test : task.test, original_test: task.original_test ?? null, impossible_type: task.impossible_type ?? null, entry_point: task.entry_point } : { task_id: r.unit.task, error: 'frozen task not found' });
    fs.writeFileSync(path.join(dir, 'final.diff'), `# Final change against the task's base commit. Any changes under .proof/ were removed from every pack.\n${diff}`);
    const ref = r.outcome?.reference || {};
    writeJson(path.join(dir, 'canonical.json'), {
      plain_ci: r.outcome?.ci ? { command: r.outcome.ci.command, exit: r.outcome.ci.exit, sentinel: r.outcome.ci.sentinel, timed_out: r.outcome.ci.timed_out, output_tail: r.outcome.ci.output_tail } : null,
      reference_evidence: stripLabel(ref.evidence),
      reference_error: ref.error || null,
      ...(reason === 'ambiguous' ? { note: 'the reference checker could not place this run' } : {}),
    });
    writeJson(path.join(dir, 'label.json'), { label: null, kind: null, reviewer: null, notes: '' });
    key.packs[id] = { reason, run_id: r.run_id, eval: r.eval, batch: r.batch, task: r.unit.task, agent: r.unit.agent, arm: r.unit.arm, reference: { label: ref.label ?? null, kind: ref.kind ?? null }, pocp: r.outcome?.pocp ? { accepted: r.outcome.pocp.accepted, class: r.outcome.pocp.class ?? null } : null };
  }
  writeJson(keyFile, key);
  return { packs: Object.keys(key.packs), key: keyFile };
}

async function main() {
  const args = process.argv.slice(2);
  const get = (k, d) => {
    const i = args.indexOf(k);
    return i >= 0 ? args[i + 1] : d;
  };
  const evalName = get('--eval');
  const batches = (get('--batch', '') || '').split(',').filter(Boolean);
  const name = get('--name');
  if (!evalName || !name) {
    process.stderr.write('usage: review-pack.js --eval E1a --name <pack-set> [--batch a,b] [--audit N] [--seed S] [--results dir] [--out dir]\n');
    process.exit(2);
  }
  const results = path.resolve(get('--results', path.join(EVAL_DIR, 'results')));
  let records = loadResults(results, evalName).filter((r) => r.phase !== 'invalid');
  if (batches.length) records = records.filter((r) => batches.includes(r.batch));
  const out = path.resolve(get('--out', path.join(results, 'review', name)));
  const res = buildPacks({ records, outDir: out, keyFile: path.join(path.dirname(out), `${name}.KEY.json`), audit: Number(get('--audit', '0')), seed: Number(get('--seed', '1')) });
  process.stdout.write(`${JSON.stringify({ packs: res.packs.length, out, key: res.key })}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
