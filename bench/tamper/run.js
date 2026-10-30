#!/usr/bin/env node
// Tamper benchmark: how many known agent cheats POCP blocks that plain CI lets through.
//
//   node bench/tamper/run.js --target pocp
//   node bench/tamper/run.js --target <name> --repo <path to its checkout>
//
// Works only in scratch clones under --work (default: a temp folder). The source checkout
// is cloned, never written to. Writes results/<target>.json and regenerates RESULTS.md.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { matchGlob } from '../../src/glob.js';
import { DEFAULT_CI_FILES } from '../../src/store.js';
import { VERSION } from '../../src/engine.js';
import { DEFAULT_GUARD_MODE } from '../../src/guard.js';
import { discover } from './lib/discover.js';
import { runScenario } from './lib/execute.js';
import { git, pool } from './lib/proc.js';
import { renderReport } from './lib/report.js';
import { buildScenarios } from './lib/scenarios.js';
import { cloneAt, POCP_ROOT, prepareBase } from './lib/workspace.js';

const here = path.dirname(fileURLToPath(import.meta.url));

export const PROFILES = {
  'as-configured': { name: 'as-configured', about: "the repository's own .proof/config.json, with POCP's defaults for anything it leaves out", config: {} },
  block: { name: 'block', about: 'the same, with "guard": { "tests": "block" } (POCP\'s default): CI needs an independent mechanical pass or a maintainer\'s approval for a test change', config: { guard: { tests: 'block' } } },
  attest: { name: 'attest', about: 'the same, with "guard": { "tests": "attest" }: a sign-off, which the author can give, stands in when the mechanical check fails', config: { guard: { tests: 'attest' } } },
};

function parseArgs(argv) {
  const a = { target: [], repo: [], profiles: null, mutants: 1, seed: 1, concurrency: Math.max(1, Math.min(4, os.cpus().length - 2)), out: path.join(here, 'results'), keep: false, only: null };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = () => argv[++i];
    if (k === '--target') a.target.push(v());
    else if (k === '--repo') a.repo.push(v());
    else if (k === '--profiles') a.profiles = v().split(',');
    else if (k === '--mutants') a.mutants = Number(v());
    else if (k === '--seed') a.seed = Number(v());
    else if (k === '--concurrency') a.concurrency = Number(v());
    else if (k === '--work') a.work = v();
    else if (k === '--out') a.out = v();
    else if (k === '--only') a.only = v().split(',');
    else if (k === '--keep') a.keep = true;
    else if (k === '--report-only') a.reportOnly = true;
    else throw new Error(`unknown option ${k}`);
  }
  return a;
}

export function loadTarget(nameOrPath, repo) {
  const file = fs.existsSync(nameOrPath) ? nameOrPath : path.join(here, 'targets', `${nameOrPath}.json`);
  const t = JSON.parse(fs.readFileSync(file, 'utf8'));
  const src = repo || (t.source === 'self' ? POCP_ROOT : null);
  if (!src) throw new Error(`target ${t.name} needs --repo <path to its checkout>`);
  return { ...t, sourceDir: path.resolve(src) };
}

const log = (...m) => process.stderr.write(`${m.join(' ')}\n`);

async function benchTarget(target, args) {
  const started = Date.now();
  const work = args.work ? path.resolve(args.work, target.name) : fs.mkdtempSync(path.join(os.tmpdir(), `pocp-tamper-${target.name}-`));
  fs.mkdirSync(work, { recursive: true });
  log(`${target.name}: scratch folder ${work}`);
  const sourceCommit = await git(target.sourceDir, ['rev-parse', target.ref || 'HEAD']);

  // Each target compares its own config with the other guard mode (targets/<name>.json "profiles").
  args = { ...args, profiles: args.profiles || target.profiles || ['as-configured', 'attest'] };
  const bases = {};
  for (const p of args.profiles) bases[p] = await prepareBase(target, PROFILES[p], path.join(work, `base-${p}`));
  const first = bases[args.profiles[0]];
  log(`${target.name}: base ready, baseline "${target.ciCommand}" passes; finding bugs the tests catch`);
  const lab = await cloneAt(first.dir, path.join(work, 'lab'), first.head, target);
  const found = await discover(lab, target, { config: first.config, mutants: args.mutants, seed: args.seed, log });
  if (!found.mutants.length) throw new Error(`${target.name}: no mutant was caught by the tests in ${found.tries} tries`);
  const pkgText = found.files.includes('package.json') ? fs.readFileSync(path.join(lab, 'package.json'), 'utf8') : null;
  const ciGlobs = first.config.ci?.files || DEFAULT_CI_FILES;
  const workflows = found.files.filter((f) => ciGlobs.some((gl) => matchGlob(f, gl))).map((f) => ({ path: f, text: fs.readFileSync(path.join(lab, f), 'utf8') }));

  const profiles = {};
  for (const p of args.profiles) {
    const base = bases[p];
    const all = [];
    const skipped = [];
    for (const m of found.mutants) {
      const built = buildScenarios(m, {
        rules: base.rules, config: base.config, target, files: found.files, runner: found.runner,
        excludeConfig: found.excludeConfig, skipSetup: found.skipSetup, workflows,
        packageJson: pkgText ? { text: pkgText, scripts: JSON.parse(pkgText).scripts } : null,
        npmrc: found.files.includes('.npmrc') ? fs.readFileSync(path.join(lab, '.npmrc'), 'utf8') : null,
      });
      const tag = found.mutants.length > 1 ? `@${m.file.split('/').pop()}` : '';
      all.push(...built.scenarios.map((s) => ({ ...s, id: `${s.id}${tag}` })));
      skipped.push(...built.skipped.map((s) => ({ ...s, id: `${s.id}${tag}` })));
    }
    const chosen = args.only ? all.filter((s) => args.only.some((o) => s.id.startsWith(o))) : all;
    log(`${target.name} [${p}]: ${chosen.length} scenario(s), ${args.concurrency} at a time`);
    const results = await pool(chosen, args.concurrency, async (sc) => {
      const r = await runScenario(sc, { baseDir: base.dir, base: base.head, target, workDir: work, profile: p, baseConfig: base.config, keep: args.keep });
      log(`  ${p} ${r.id}: plain CI ${r.plain_ci}, POCP ${r.pocp}${r.codes.length ? ` (${r.codes.join(', ')})` : ''} → ${r.outcome}${r.error ? ` [${r.error}]` : ''} ${Math.round(r.ms / 1000)}s`);
      return r;
    });
    const mode = base.config.guard?.tests || DEFAULT_GUARD_MODE;
    profiles[p] = { about: PROFILES[p].about, guard_mode: mode, scenarios: results, skipped };
  }
  if (!args.keep) fs.rmSync(work, { recursive: true, force: true });
  return {
    target: target.name,
    about: target.about,
    setup_note: target.setupNote,
    framework: target.framework,
    ci_command: target.ciCommand,
    source_commit: sourceCommit.slice(0, 12),
    pocp_version: VERSION,
    pocp_commit: (await git(POCP_ROOT, ['rev-parse', 'HEAD'])).slice(0, 12),
    node: process.versions.node,
    seed: args.seed,
    judge: 'pocp ci-run -- <ci command>; pocp verify <base>..<head> --require-coverage --rerun-unsigned --ci-results <that file>',
    mutants: found.mutants.map((m) => ({ file: m.file, line: m.line, op: m.op, killing: m.killing, cheats: Object.fromEntries(Object.entries(m.cheats).map(([k, c]) => [k, { effective: c.effective, rounds: c.rounds }])) })),
    mutant_tries: found.tries,
    profiles,
    duration_s: Math.round((Date.now() - started) / 1000),
  };
}

export function writeReport(outDir) {
  const results = fs.readdirSync(outDir).filter((f) => f.endsWith('.json')).sort().map((f) => JSON.parse(fs.readFileSync(path.join(outDir, f), 'utf8')));
  const file = path.join(here, 'RESULTS.md');
  // Hand-written reading of the misses, kept next to the generated tables.
  const notes = path.join(here, 'analysis.md');
  fs.writeFileSync(file, renderReport(results, { analysis: fs.existsSync(notes) ? fs.readFileSync(notes, 'utf8') : '' }));
  return file;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  fs.mkdirSync(args.out, { recursive: true });
  if (!args.reportOnly) {
    if (!args.target.length) throw new Error('usage: node bench/tamper/run.js --target <name|spec.json> [--repo <path>] [--profiles as-configured,strict] [--mutants N] [--seed N] [--concurrency N] [--only id,...] [--work dir] [--keep]');
    for (const [i, t] of args.target.entries()) {
      const target = loadTarget(t, args.repo[i]);
      const result = await benchTarget(target, args);
      fs.writeFileSync(path.join(args.out, `${target.name}.json`), `${JSON.stringify(result, null, 2)}\n`);
      log(`${target.name}: done in ${result.duration_s}s`);
    }
  }
  log(`wrote ${path.relative(process.cwd(), writeReport(args.out))}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    process.stderr.write(`tamper bench: ${e.message}\n`);
    process.exit(2);
  });
}
