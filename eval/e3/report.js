#!/usr/bin/env node
// E3 step 4: pair Stryker's and POCP's outcomes mutant by mutant, classify both with the one
// rule set in lib.js, write run records (once), and generate eval/e3/RESULTS.md.
//
//   node eval/e3/report.js --raw eval/results/E3/<batch> --batch <batch> [--clone <scratch clone>] [--disagreements <out.json>]
//
// With --clone (the scratch clone the runs used, still on disk) it also writes the run
// records, if the batch has none yet. Without it, it only regenerates RESULTS.md from the
// records and raw files already committed.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { basePins, pocpCommit, POCP_ROOT, verifierHash } from '../lib/pins.js';
import { appendRecord, readRecords, runId } from '../lib/record.js';
import { clusterBootstrap, fmtRate, wilson } from '../lib/stats.js';
import { applyLocation, lineDiff, pairCategory, pocpEditSet, sliceLocation, squash, summarize } from './lib.js';
import { TEST_COMMAND, TIMEOUT_FACTOR, TIMEOUT_MS } from './run-stryker.js';

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? def : process.argv[i + 1];
}
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const maybeJson = (f) => (fs.existsSync(f) ? readJson(f) : null);
const HERE = path.dirname(new URL(import.meta.url).pathname);

/** Stryker report → Map(key → mutant), keyed exactly as lib.keyOf. */
export function strykerByKey(report) {
  const map = new Map();
  for (const [file, f] of Object.entries(report?.files || {})) {
    for (const m of f.mutants) {
      const l = m.location;
      map.set(`${file}:${l.start.line}:${l.start.column}-${l.end.line}:${l.end.column}:${m.mutatorName}:${m.replacement}`, { ...m, file });
    }
  }
  return map;
}

/** `node --check` the mutated file: the shared validity rule, decided outside both tools. */
export function nodeCheck(text, dir) {
  const f = path.join(dir, `m-${process.pid}-${Math.random().toString(36).slice(2)}.mjs`);
  fs.writeFileSync(f, text);
  try {
    return spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' }).status === 0;
  } finally {
    fs.rmSync(f, { force: true });
  }
}

/** Ids the gate really ran tests for, from `<report>.marks` ("<id> <exit> <seconds>"), or null if absent. */
export function readMarks(file) {
  if (!fs.existsSync(file)) return null;
  const ran = new Map();
  for (const line of fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)) {
    const [id, exit, secs] = line.split(' ');
    ran.set(id, { exit: Number(exit), seconds: Number(secs) });
  }
  return ran;
}

export function buildPairs({ sample, sources, stryker, pocp, strykerRerun, pocpRerun, equivalent, tmp, marks = null }) {
  const sBy = strykerByKey(stryker);
  const sRe = strykerByKey(strykerRerun);
  const pBy = new Map((pocp?.mutants || []).map((m) => [m.id, m]));
  const pRe = new Map((pocpRerun?.mutants || []).map((m) => [m.id, m]));
  const eq = new Map((equivalent?.mutants || []).map((e) => [e.key, e.reason]));
  return sample.mutants.map((m) => {
    const src = sources(m.file);
    const mutated = applyLocation(src, m.location, m.replacement);
    const valid = nodeCheck(mutated, tmp);
    let s = sBy.get(m.key);
    // With the gate, a sampled mutant counts only if its tests really ran (it's in the marks).
    if (s && marks && !marks.has(String(s.id)) && s.status !== 'Timeout') s = { ...s, status: null, statusReason: 'gate did not run this mutant' };
    const p = pBy.get(m.key);
    const cat = pairCategory({ valid, equivalent: eq.has(m.key), stryker: s?.status, pocp: p?.outcome });
    return {
      key: m.key,
      file: m.file,
      mutator: m.mutatorName,
      line: m.location.start.line,
      original: sliceLocation(src, m.location),
      replacement: m.replacement,
      diff: lineDiff(src, mutated),
      valid,
      equivalent: eq.get(m.key) || null,
      stryker: s ? { id: s.id, status: s.status, killedBy: s.killedBy || null, statusReason: s.statusReason ? String(s.statusReason).slice(0, 300) : null, duration: s.duration ?? null } : null,
      pocp: p ? { outcome: p.outcome, caught_by: p.caught_by || null, ms: p.ms ?? null, gone: p.gone || null } : null,
      rerun: sRe.has(m.key) || pRe.has(m.key) ? { stryker: sRe.get(m.key)?.status ?? null, pocp: pRe.get(m.key)?.outcome ?? null } : null,
      ...cat,
    };
  });
}

/** POCP's operators vs Stryker's population: which Stryker edits POCP can make, and the reverse. */
export function blindSpots(population, sources, mutantsModule) {
  const byFile = new Map();
  for (const m of population) {
    if (!byFile.has(m.file)) byFile.set(m.file, []);
    byFile.get(m.file).push(m);
  }
  const strykerKinds = {};
  const pocpOps = {};
  for (const [file, ms] of byFile) {
    const src = sources(file);
    const pocpSet = pocpEditSet(src, mutantsModule);
    const strykerSet = new Set();
    for (const m of ms) {
      const t = squash(applyLocation(src, m.location, m.replacement));
      strykerSet.add(t);
      strykerKinds[m.mutatorName] ||= { total: 0, pocp_can: 0 };
      strykerKinds[m.mutatorName].total++;
      if (pocpSet.has(t)) strykerKinds[m.mutatorName].pocp_can++;
    }
    for (const site of mutantsModule.mutationSites(src)) {
      pocpOps[site.op] ||= { total: 0, stryker_can: 0 };
      pocpOps[site.op].total++;
      if (strykerSet.has(squash(mutantsModule.applySite(src, site)))) pocpOps[site.op].stryker_can++;
    }
  }
  return { stryker_kinds: strykerKinds, pocp_operators: pocpOps };
}

function table(head, rows) {
  return [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rows.map((r) => `| ${r.join(' | ')} |`)].join('\n');
}

function rate(clusters, seed = 1) {
  const k = clusters.reduce((s, c) => s + c.k, 0);
  const n = clusters.reduce((s, c) => s + c.n, 0);
  const w = wilson(k, n);
  const b = clusterBootstrap(clusters, { seed });
  return { k, n, wilson: w, cluster: b, text: n ? `${fmtRate(w)}; file-clustered bootstrap 95% CI ${Math.round(b.lo * 100)}–${Math.round(b.hi * 100)}% over ${b.clusters} files` : `${k}/${n} (n/a)` };
}

export function renderResults({ batch, meta, sample, pairs, notes, own, blind, extras, records }) {
  const sum = summarize(pairs);
  const agreement = rate(sum.clusters.agreement, 1);
  const sRate = rate(sum.clusters.stryker, 2);
  const pRate = rate(sum.clusters.pocp, 3);
  const cats = ['agree', 'disagree', 'timeout', 'error', 'invalid', 'equivalent', 'not-run'];
  const xt = {};
  for (const r of pairs) {
    const a = r.stryker?.status ?? '(none)';
    const b = r.pocp?.outcome ?? '(none)';
    xt[a] ||= {};
    xt[a][b] = (xt[a][b] || 0) + 1;
  }
  const pocpCols = [...new Set(pairs.map((r) => r.pocp?.outcome ?? '(none)'))].sort();
  const dis = pairs.filter((r) => r.category === 'disagree');
  const unmeasured = pairs.filter((r) => !['agree', 'disagree'].includes(r.category));
  const count = (xs, f) => Object.entries(xs.reduce((a, x) => ({ ...a, [f(x)]: (a[f(x)] || 0) + 1 }), {})).sort((a, b) => b[1] - a[1]);

  const L = [];
  L.push('# E3 results: StrykerJS mutants replayed through POCP');
  L.push('');
  L.push(`Generated by \`eval/e3/report.js\` from \`eval/results/E3/${batch}.jsonl\` and \`eval/results/E3/${batch}/\`. Do not edit by hand.`);
  L.push('');
  L.push(`**Phase: pilot.** These numbers size the study; they are not counted toward any bar (PREREG §5 lists E3 as "report only"). A mutation score is the share of planted mutants a test command detects. It is not a probability that the code is correct, and it is not a measure of bugs found.`);
  L.push('');
  L.push('## What ran');
  L.push('');
  L.push(table(['', ''], [
    ['Batch', `\`${batch}\``],
    ['POCP commit (clone the runs used)', `\`${meta.pocp_commit}\``],
    ['Verifier hash (bin/, src/)', `\`${meta.pocp_verifier_sha256.slice(0, 16)}…\``],
    ['Outside tool', `StrykerJS \`@stryker-mutator/core@${meta.stryker_version}\` (installed outside the repo), command test runner, \`coverageAnalysis: off\``],
    ['Test command (both paths)', `\`${TEST_COMMAND}\` — Stryker runs it as one command; POCP runs the three required checks of \`.proof/rules.json\` fastest first and stops at the first failure`],
    ['Timeouts', `Stryker: per mutant, net dry-run time × ${TIMEOUT_FACTOR} + ${TIMEOUT_MS / 1000} s (≈${meta.stryker_timeout_s ?? '?'} s here). POCP: 600 s per check (\`run.timeout_ms\`)`],
    ['Concurrency', `Stryker ${meta.stryker_concurrency} workers, POCP ${meta.pocp_jobs} jobs, ${meta.parallel ? 'run at the same time (PARALLEL=1, so both saw the same load)' : 'run one after the other'} on the same machine (${meta.os}, ${meta.cpus} CPUs, Node ${meta.node})`],
    ['Machine load', `1/5/15-min load average ${meta.load_start ? `${meta.load_start.join('/')} at the start, ` : ''}${meta.load_end ? meta.load_end.join('/') : '?'} when the runs ended${meta.load_note ? ` (${meta.load_note})` : ''}, on ${meta.cpus} CPUs. The machine was shared with other agents' test runs (load ~475 was seen earlier the same day), so run times, and any timeouts, reflect that load, not POCP or Stryker alone`],
    ['Population', `${sample.population} Stryker mutants in \`src/**/*.js\``],
    ['Sample', `${sample.n} mutants, seed ${sample.seed}: ${sample.sampling}`],
    ['Extra mutants Stryker also tested', `${extras.tested} (other mutators on a sampled node; not counted) · ${extras.ignored} nested mutants ignored by the sample plugin`],
    ['Run times', `Stryker ${meta.stryker_duration_s} s · POCP corpus replay ${meta.pocp_duration_s} s · POCP own operators ${meta.own_duration_s} s · reruns: Stryker ${meta.stryker_rerun_duration_s ?? '—'} s, POCP ${meta.pocp_rerun_duration_s ?? '—'} s`],
  ]));
  L.push('');
  if (notes?._run) {
    L.push('## Run notes');
    L.push('');
    for (const n of [].concat(notes._run)) L.push(`- ${n}`);
    L.push('');
  }
  L.push('## Sample');
  L.push('');
  L.push(`By mutator: ${count(sample.mutants, (m) => m.mutatorName).map(([k, v]) => `${k} ${v}`).join(', ')}.`);
  L.push('');
  L.push(`By file (the cluster): ${count(sample.mutants, (m) => m.file).map(([k, v]) => `\`${k}\` ${v}`).join(', ')}.`);
  L.push('');
  L.push('## Paired outcomes (shared corpus)');
  L.push('');
  L.push('Categories, by the rules in `eval/e3/README.md` (priority order):');
  L.push('');
  L.push(table(['Category', 'Mutants'], cats.map((c) => [c, String(sum.by_category[c] || 0)])));
  L.push('');
  L.push(`**Agreement** (both sides measured the mutant, and both detected or both missed it): ${agreement.text}.`);
  L.push('');
  L.push('On the same measured mutants, each side\'s detection rate (reported separately, not as agreement):');
  L.push('');
  L.push(`- Stryker: ${sRate.text}`);
  L.push(`- POCP (\`eval --corpus\`): ${pRate.text}`);
  L.push('');
  L.push('Stryker status × POCP outcome, all sampled mutants:');
  L.push('');
  L.push(table(['Stryker \\ POCP', ...pocpCols], Object.keys(xt).sort().map((a) => [a, ...pocpCols.map((b) => String(xt[a][b] || 0))])));
  L.push('');
  L.push('## Disagreements');
  L.push('');
  if (!dis.length) L.push('None.');
  for (const r of dis) {
    const note = notes?.[r.key];
    L.push(`### \`${r.file}:${r.line}\` ${r.mutator}`);
    L.push('');
    L.push(`- Stryker: **${r.stryker?.status}**${r.stryker?.killedBy?.length ? ` (killed by ${r.stryker.killedBy.join(', ')})` : ''}${r.stryker?.statusReason ? ` — ${String(r.stryker.statusReason).split('\n')[0].slice(0, 200)}` : ''}`);
    L.push(`- POCP: **${r.pocp?.outcome}**${r.pocp?.caught_by ? ` by \`${r.pocp.caught_by}\`` : ''}${r.pocp?.ms ? ` after ${Math.round(r.pocp.ms / 1000)} s` : ''}`);
    L.push(`- Re-run once: ${r.rerun ? `Stryker ${r.rerun.stryker ?? 'not re-run'}, POCP ${r.rerun.pocp ?? 'not re-run'}${r.rerun.stryker && r.rerun.pocp ? (r.rerun.stryker === r.stryker?.status && r.rerun.pocp === r.pocp?.outcome ? ' (same as the first run: stable)' : ' (changed: flaky)') : ''}` : 'not re-run'}`);
    L.push(`- Why: ${note || 'not yet explained'}`);
    L.push('');
    L.push('```diff');
    L.push(r.diff);
    L.push('```');
    L.push('');
  }
  L.push('## Not measured on one or both sides');
  L.push('');
  if (!unmeasured.length) L.push('None.');
  else L.push(table(['Mutant', 'Category', 'Stryker', 'POCP', 'Note'], unmeasured.map((r) => [`\`${r.file}:${r.line}\` ${r.mutator}`, r.category, r.stryker?.status ?? '—', r.pocp?.outcome ?? '—', (r.equivalent || notes?.[r.key] || r.pocp?.gone || '').replace(/\|/g, '\\|')])));
  L.push('');
  L.push('## POCP\'s own operators (separate measurement)');
  L.push('');
  L.push('This is **not** agreement with Stryker: a different generator makes different mutants, so the two scores aren\'t comparable as numbers ([EVAL-PLAN](../../docs/EVAL-PLAN.md) E3).');
  L.push('');
  if (own) {
    // Everything that ran (before POCP stopped scoring timeouts, those had caught: true).
    const scored = own.mutants.filter((m) => m.outcome !== 'gone');
    const byOutcome = count(scored, (m) => m.outcome);
    const measured = scored.filter((m) => m.outcome === 'caught' || m.outcome === 'missed');
    const clusters = Object.values(measured.reduce((a, m) => { a[m.file] ||= { k: 0, n: 0 }; a[m.file].n++; if (m.outcome === 'caught') a[m.file].k++; return a; }, {}));
    const ownScore = own.not_measured === undefined ? 'POCP\'s own score (this POCP counted timeouts as caught)' : `POCP's own score (timeouts and errors not scored: ${own.not_measured})`;
    L.push(`\`pocp eval --mutants ${own.total + own.gone + (own.not_measured || 0)} --seed ${own.seed ?? meta.seed} --jobs ${own.jobs}\` on the same commit and checks: ${own.sites} sites in guarded source; ${ownScore} ${own.caught}/${own.total}. Outcomes: ${byOutcome.map(([k, v]) => `${k} ${v}`).join(', ')}.`);
    L.push('');
    L.push(`Excluding timeouts and errors as above: ${rate(clusters, 4).text}.`);
    L.push('');
    L.push(`By operator: ${count(scored, (m) => m.operator).map(([k, v]) => `${k} ${v}`).join(', ')}.`);
    L.push('');
  } else L.push('Not run.');
  L.push('## Blind spots: what each generator can\'t make');
  L.push('');
  L.push('Over the whole Stryker population, can POCP\'s 16 regex operators make the exact same edit (whole mutated file, whitespace ignored)?');
  L.push('');
  const sk = Object.entries(blind.stryker_kinds).sort((a, b) => b[1].total - a[1].total);
  L.push(table(['Stryker mutator', 'Mutants', 'POCP can make', 'POCP can\'t'], sk.map(([k, v]) => [k, String(v.total), String(v.pocp_can), String(v.total - v.pocp_can)])));
  const tot = sk.reduce((s, [, v]) => s + v.total, 0);
  const can = sk.reduce((s, [, v]) => s + v.pocp_can, 0);
  L.push('');
  L.push(`In all, POCP's operators can make ${can} of Stryker's ${tot} mutants (${Math.round((can / tot) * 100)}%). Kinds POCP can't make at all: ${sk.filter(([, v]) => v.pocp_can === 0).map(([k]) => k).join(', ')}.`);
  L.push('');
  L.push('The reverse: POCP sites whose edit Stryker never makes.');
  L.push('');
  const po = Object.entries(blind.pocp_operators).sort((a, b) => b[1].total - a[1].total);
  L.push(table(['POCP operator', 'Sites', 'Stryker makes it too', 'Only POCP'], po.map(([k, v]) => [k, String(v.total), String(v.stryker_can), String(v.total - v.stryker_can)])));
  L.push('');
  L.push('## Records');
  L.push('');
  L.push(`${records} run records (one per sampled mutant, \`phase: "pilot"\`, cluster = source file) in \`eval/results/E3/${batch}.jsonl\`. Raw inputs and outputs in \`eval/results/E3/${batch}/\`.`);
  L.push('');
  L.push('## Reproduce');
  L.push('');
  L.push('```bash');
  L.push(`# Stryker lives outside the repo; POCP stays zero-dependency.`);
  L.push(`STRYKER_DIR=$(mktemp -d) && (cd "$STRYKER_DIR" && npm init -y >/dev/null && npm i @stryker-mutator/core@${meta.stryker_version})`);
  L.push(`git checkout ${meta.pocp_commit.replace(/\+dirty$/, '')}`);
  L.push(`STRYKER_DIR="$STRYKER_DIR" N=${sample.n} SEED=${sample.seed} JOBS=${meta.pocp_jobs} BATCH=${batch}-repro eval/e3/run.sh`);
  L.push('```');
  L.push('');
  L.push('`eval/e3/run.sh` prints each step\'s exact command. To only regenerate this file from the committed records and raw files:');
  L.push('');
  L.push('```bash');
  L.push(`node eval/e3/report.js --raw eval/results/E3/${batch} --batch ${batch}`);
  L.push('```');
  L.push('');
  return L.join('\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const raw = path.resolve(arg('raw'));
  const batch = arg('batch');
  const resultsDir = path.resolve(arg('results', path.join(POCP_ROOT, 'eval/results')));
  const clone = arg('clone') ? path.resolve(arg('clone')) : null;
  const sample = readJson(path.join(raw, 'sample.json'));
  const meta = readJson(path.join(raw, 'meta.json'));
  const strykerFull = readJson(path.join(raw, 'stryker-report.json'));
  const sourceOf = (f) => strykerFull.files[f]?.source ?? (clone ? fs.readFileSync(path.join(clone, f), 'utf8') : null);
  // Every sampled file must be in the report with the same source the corpus was cut from.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'e3-check-'));
  const pairs = buildPairs({
    sample,
    sources: sourceOf,
    stryker: strykerFull,
    pocp: readJson(path.join(raw, 'pocp-eval.json')),
    strykerRerun: maybeJson(path.join(raw, 'stryker-rerun.json')),
    pocpRerun: maybeJson(path.join(raw, 'pocp-rerun.json')),
    equivalent: maybeJson(path.join(HERE, 'equivalent.json')),
    tmp,
    marks: readMarks(path.join(raw, 'stryker-report.json.marks')),
  });
  fs.rmSync(tmp, { recursive: true, force: true });

  if (arg('disagreements')) {
    const keys = pairs.filter((r) => r.category === 'disagree').map((r) => r.key);
    fs.writeFileSync(path.resolve(arg('disagreements')), `${JSON.stringify(keys, null, 2)}\n`);
    console.log(`${keys.length} disagreements → ${arg('disagreements')}`);
    process.exit(0);
  }

  const sampled = new Set(sample.mutants.map((m) => m.key));
  const allS = [...strykerByKey(strykerFull).entries()];
  const extras = { tested: allS.filter(([k, m]) => !sampled.has(k) && m.status !== 'Ignored').length, ignored: allS.filter(([k, m]) => !sampled.has(k) && m.status === 'Ignored').length };

  let blind = maybeJson(path.join(raw, 'blind-spots.json'));
  if (!blind) {
    if (!clone) throw new Error('blind-spots.json is missing; pass --clone to compute it');
    const population = readJson(path.join(raw, 'population.json'));
    const mod = await import(pathToFileURL(path.join(clone, 'src/mutants.js')).href);
    blind = blindSpots(population, (f) => fs.readFileSync(path.join(clone, f), 'utf8'), mod);
    fs.writeFileSync(path.join(raw, 'blind-spots.json'), `${JSON.stringify(blind, null, 2)}\n`);
  }

  const recordsFile = path.join(resultsDir, 'E3', `${batch}.jsonl`);
  if (clone && !fs.existsSync(recordsFile)) {
    const pins = {
      ...basePins(),
      pocp_commit: pocpCommit(clone),
      pocp_verifier_sha256: verifierHash(clone),
      outside_tool: `@stryker-mutator/core ${meta.stryker_version}`,
      test_command: TEST_COMMAND,
      budget: { stryker_timeout: `net×${TIMEOUT_FACTOR}+${TIMEOUT_MS}ms`, stryker_timeout_s: meta.stryker_timeout_s ?? null, pocp_timeout_ms_per_check: 600000 },
      concurrency: { stryker: meta.stryker_concurrency, pocp: meta.pocp_jobs },
      seed: sample.seed,
      sample_n: sample.n,
      population: sample.population,
    };
    for (const r of pairs) {
      appendRecord(resultsDir, {
        eval: 'E3',
        batch,
        phase: 'pilot',
        run_id: runId([batch, r.key]),
        unit: { mutant: r.key, file: r.file, mutator: r.mutator, stryker_id: r.stryker?.id ?? null },
        cluster: r.file,
        pins,
        started_at: meta.started_at,
        ended_at: meta.ended_at,
        duration_s: null,
        status: 'completed',
        outcome: { category: r.category, stryker_class: r.s, pocp_class: r.p, valid: r.valid, equivalent: r.equivalent, stryker: r.stryker, pocp: r.pocp, rerun: r.rerun, diff: r.diff },
      });
    }
    console.log(`wrote ${pairs.length} records → ${recordsFile}`);
  }
  const records = fs.existsSync(recordsFile) ? readRecords(recordsFile).length : 0;
  const notes = maybeJson(path.join(HERE, 'notes.json')) || {};
  const own = maybeJson(path.join(raw, 'pocp-own.json'));
  const md = renderResults({ batch, meta, sample, pairs, notes, own, blind, extras, records });
  fs.writeFileSync(path.join(HERE, 'RESULTS.md'), md);
  const sum = summarize(pairs);
  console.log(`RESULTS.md written · ${JSON.stringify(sum.by_category)}`);
}
