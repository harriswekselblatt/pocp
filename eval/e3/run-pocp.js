#!/usr/bin/env node
// E3 step 3: replay the same sampled Stryker mutants through POCP's own runner
// (`pocp eval --corpus`) in a scratch clone at the same commit.
//
//   node eval/e3/run-pocp.js --clone <scratch clone> --sample <sample.json> --out <dir> [--jobs 4] [--only <keys.json>] [--name pocp-eval]
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { toCorpusEntry } from './lib.js';

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? def : process.argv[i + 1];
}

/** The corpus for `pocp eval --corpus`: one entry per sampled mutant, id = the mutant's key. */
export function buildCorpus(sample, readSource) {
  return sample.mutants.map((m) => ({ ...toCorpusEntry(m.file, m, readSource(m.file)), id: m.key }));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const clone = path.resolve(arg('clone'));
  const sample = JSON.parse(fs.readFileSync(path.resolve(arg('sample')), 'utf8'));
  const outDir = path.resolve(arg('out'));
  const name = arg('name', 'pocp-eval');
  const jobs = arg('jobs', '4');
  if (arg('only')) {
    const only = new Set(JSON.parse(fs.readFileSync(path.resolve(arg('only')), 'utf8')));
    sample.mutants = sample.mutants.filter((m) => only.has(m.key));
  }
  fs.mkdirSync(outDir, { recursive: true });
  const corpus = buildCorpus(sample, (f) => fs.readFileSync(path.join(clone, f), 'utf8'));
  const corpusFile = path.join(outDir, `${name}.corpus.json`);
  fs.writeFileSync(corpusFile, `${JSON.stringify({ mutants: corpus }, null, 2)}\n`);
  const save = path.join(outDir, `${name}.json`);
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [path.join(clone, 'bin/pocp.js'), 'eval', '--corpus', corpusFile, '--jobs', String(jobs), '--save', save], {
    cwd: clone,
    stdio: 'inherit',
  });
  console.log(`pocp eval --corpus exit ${r.status} in ${Math.round((Date.now() - t0) / 1000)}s`);
  process.exit(r.status ?? 1);
}
