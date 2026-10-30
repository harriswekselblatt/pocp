#!/usr/bin/env node
// E3 step 1: list every mutant StrykerJS would make in POCP's guarded source, then draw the
// seeded sample. Uses Stryker's own instrumenter (the pinned install), so the population is
// exactly Stryker's, not ours.
//
//   node eval/e3/enumerate.js --stryker <dir with node_modules/@stryker-mutator> --n 100 --seed 20261028 --out <dir>
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { POCP_ROOT } from '../lib/pins.js';
import { keyOf, sampleMutants } from './lib.js';

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? def : process.argv[i + 1];
}

const strykerDir = path.resolve(arg('stryker'));
const n = Number(arg('n', 100));
const seed = Number(arg('seed', 20261028));
const out = path.resolve(arg('out'));
const root = path.resolve(arg('root', POCP_ROOT));

const instrumenterPkg = path.join(strykerDir, 'node_modules/@stryker-mutator/instrumenter');
const { Instrumenter } = await import(pathToFileURL(path.join(instrumenterPkg, 'dist/src/index.js')).href);
const version = JSON.parse(fs.readFileSync(path.join(instrumenterPkg, 'package.json'), 'utf8')).version;

// The guarded source: src/**/*.js (every requirement in .proof/rules.json globs src/**).
const files = fs.readdirSync(path.join(root, 'src'), { recursive: true })
  .filter((f) => f.endsWith('.js'))
  .map((f) => `src/${f}`)
  .sort();

const quiet = { isDebugEnabled: () => false, isTraceEnabled: () => false, isInfoEnabled: () => false, debug() {}, info() {}, warn() {}, error() {}, trace() {}, fatal() {} };
const inst = new Instrumenter(quiet);
const population = [];
for (const file of files) {
  const content = fs.readFileSync(path.join(root, file), 'utf8');
  const res = await inst.instrument([{ name: path.join(root, file), content, mutate: true }], { plugins: null, excludedMutations: [], ignorers: [] });
  for (const m of res.mutants) {
    if (m.status === 'Ignored') continue;
    // API locations are 0-based lines and columns; the report schema (and our corpus) is 1-based.
    population.push({
      file,
      mutatorName: m.mutatorName,
      replacement: m.replacement,
      location: {
        start: { line: m.location.start.line + 1, column: m.location.start.column + 1 },
        end: { line: m.location.end.line + 1, column: m.location.end.column + 1 },
      },
    });
  }
}

const sample = sampleMutants(population, n, seed).map((m) => ({ ...m, key: keyOf(m) }));
const count = (xs, f) => xs.reduce((acc, x) => ({ ...acc, [f(x)]: (acc[f(x)] || 0) + 1 }), {});
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'sample.json'), `${JSON.stringify({
  stryker_instrumenter: version,
  seed,
  n: sample.length,
  population: population.length,
  population_by_file: count(population, (m) => m.file),
  population_by_mutator: count(population, (m) => m.mutatorName),
  sampling: 'simple random sample without replacement over every non-ignored Stryker mutant in src/**/*.js; population sorted by key, Fisher-Yates with mulberry32(seed) (eval/lib/stats.js prng), first n',
  mutants: sample,
}, null, 2)}\n`);
fs.writeFileSync(path.join(out, 'population.json'), `${JSON.stringify(population)}\n`);
console.log(`population ${population.length} mutants in ${files.length} files · sampled ${sample.length} with seed ${seed} · instrumenter ${version}`);
