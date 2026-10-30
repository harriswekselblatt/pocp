#!/usr/bin/env node
// E3 step 2: run StrykerJS (pinned install, outside the repo) on the sampled mutants of a
// scratch clone of POCP, with the same checks POCP's rules require for src/**.
//
//   node eval/e3/run-stryker.js --stryker <install dir> --clone <scratch clone> --sample <sample.json> \
//     --out <report.json> [--concurrency 4] [--only <ids.json>]
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { mutatePattern } from './lib.js';

export const TEST_COMMAND = 'node --test test/unit.test.js test/unit-more.test.js test/git.test.js && node --test test/engine.test.js && npm test --silent';
// POCP gives each check 600 s (.proof/config.json run.timeout_ms). Stryker's limit is per
// mutant for the whole command: net dry-run time × timeoutFactor + timeoutMS.
export const TIMEOUT_FACTOR = 1.5;
export const TIMEOUT_MS = 360_000;

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? def : process.argv[i + 1];
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const strykerDir = path.resolve(arg('stryker'));
  const clone = path.resolve(arg('clone'));
  const sample = JSON.parse(fs.readFileSync(path.resolve(arg('sample')), 'utf8'));
  const out = path.resolve(arg('out'));
  const concurrency = Number(arg('concurrency', 4));
  let mutants = sample.mutants;
  if (arg('only')) {
    const only = new Set(JSON.parse(fs.readFileSync(path.resolve(arg('only')), 'utf8')));
    mutants = mutants.filter((m) => only.has(m.key));
  }

  // Babel coordinates for the ignorer: 1-based lines, 0-based columns.
  const ranges = mutants.map((m) => ({
    start: { line: m.location.start.line, column: m.location.start.column - 1 },
    end: { line: m.location.end.line, column: m.location.end.column - 1 },
  }));
  const rangesFile = path.join(clone, '.e3-ranges.json');
  fs.writeFileSync(rangesFile, JSON.stringify(ranges));
  const here = path.dirname(new URL(import.meta.url).pathname);
  const plugin = path.join(here, 'stryker-sample-ignorer.js');
  const mutate = [...new Set(mutants.map((m) => mutatePattern(m.file, m.location)))];
  // Predict Stryker's mutant ids (same instrumenter, same files in sorted order, same ignorer)
  // so the gate runs only sampled mutants. The marks file proves each one really ran.
  process.env.E3_SAMPLE_RANGES = rangesFile;
  const { Instrumenter } = await import(pathToFileURL(path.join(strykerDir, 'node_modules/@stryker-mutator/instrumenter/dist/src/index.js')).href);
  const { strykerPlugins } = await import(pathToFileURL(plugin).href);
  const byFile = {};
  for (const m of mutants) {
    (byFile[m.file] ||= []).push({ start: { line: m.location.start.line - 1, column: m.location.start.column - 1 }, end: { line: m.location.end.line - 1, column: m.location.end.column - 1 } });
  }
  const quiet = { isDebugEnabled: () => false, debug() {}, info() {}, warn() {} };
  const files = Object.keys(byFile).sort().map((f) => ({ name: path.join(clone, f), content: fs.readFileSync(path.join(clone, f), 'utf8'), mutate: byFile[f] }));
  const predicted = (await new Instrumenter(quiet).instrument(files, { plugins: null, excludedMutations: [], ignorers: [strykerPlugins[0].value] })).mutants;
  const wanted = new Set(mutants.map((m) => m.key));
  const idMap = {};
  for (const m of predicted) {
    const file = path.relative(clone, m.fileName);
    const l = m.location;
    const key = `${file}:${l.start.line + 1}:${l.start.column + 1}-${l.end.line + 1}:${l.end.column + 1}:${m.mutatorName}:${m.replacement}`;
    if (wanted.has(key) && m.status !== 'Ignored') idMap[m.id] = key;
  }
  const runIds = path.join(clone, '.e3-run-ids');
  fs.writeFileSync(runIds, `${Object.keys(idMap).join('\n')}\n`);
  fs.writeFileSync(`${out}.ids.json`, `${JSON.stringify(idMap, null, 2)}\n`);
  const marks = `${out}.marks`;
  fs.rmSync(marks, { force: true });
  const config = {
    $schema: path.join(strykerDir, 'node_modules/@stryker-mutator/core/schema/stryker-schema.json'),
    testRunner: 'command',
    commandRunner: { command: `sh ${path.join(here, 'stryker-gate.sh')}` },
    coverageAnalysis: 'off',
    mutate,
    plugins: [plugin],
    ignorers: ['e3-sample'],
    concurrency,
    timeoutFactor: TIMEOUT_FACTOR,
    timeoutMS: TIMEOUT_MS,
    dryRunTimeoutMinutes: 20,
    disableTypeChecks: false, // otherwise Stryker prepends // @ts-nocheck to src and test files
    reporters: ['json', 'progress-append-only'],
    jsonReporter: { fileName: out },
    ignorePatterns: ['.e3-*', 'eval/results', 'stryker.e3.config.json'],
    tempDirName: '.stryker-tmp',
    cleanTempDir: 'always',
    incremental: false,
  };
  const configFile = path.join(clone, 'stryker.e3.config.json');
  fs.writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const t0 = Date.now();
  const r = spawnSync(path.join(strykerDir, 'node_modules/.bin/stryker'), ['run', configFile], {
    cwd: clone,
    encoding: 'utf8',
    maxBuffer: 512 * 1024 * 1024,
    env: { ...process.env, E3_SAMPLE_RANGES: rangesFile, E3_RUN_IDS: runIds, E3_MARKS: marks, E3_TEST_COMMAND: TEST_COMMAND },
  });
  const log = `${r.stdout || ''}${r.stderr || ''}`;
  fs.writeFileSync(`${out}.log`, log);
  process.stdout.write(log.split('\n').slice(-25).join('\n'));
  // "Initial test run succeeded. Ran 1 tests in 2 minutes (net 150123 ms, overhead 1234 ms)."
  const dry = /net (\d+) ms, overhead (\d+) ms/.exec(log);
  const timeoutS = dry ? Math.round((Number(dry[1]) * TIMEOUT_FACTOR + TIMEOUT_MS + Number(dry[2])) / 1000) : null;
  const meta = { exit: r.status, duration_s: Math.round((Date.now() - t0) / 1000), dry_run_net_ms: dry ? Number(dry[1]) : null, dry_run_overhead_ms: dry ? Number(dry[2]) : null, timeout_s: timeoutS, concurrency, mutate_patterns: config.mutate.length, sampled: mutants.length, config };
  fs.writeFileSync(`${out}.meta.json`, `${JSON.stringify(meta, null, 2)}\n`);
  console.log(`\nstryker exit ${r.status} in ${meta.duration_s}s · dry run net ${meta.dry_run_net_ms} ms · per-mutant timeout ≈${timeoutS}s`);
  process.exit(r.status ?? 1);
}
