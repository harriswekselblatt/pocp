#!/usr/bin/env node
// E5 part 2: where the test guard's time goes.
//
// Reproduces a real commit that edits an existing test file, in a scratch clone (the source
// checkout is only read), and runs `pocp fix` on it exactly as an agent would, with POCP's
// process runner wrapped so every check run is timestamped. Nothing in POCP changes: the
// wrapper only records start, end and the log name POCP gave the run, which says what the run
// was (plain proof, guard baseline new/old/base, mutant i on the old or new side).
//
//   node eval/e5/profile-guard.js --commit ca3e9f6 [--pocp <checkout>] [--label before] [--runs 1]
//   node eval/e5/profile-guard.js --report        # re-render GUARD-PROFILE.md from raw files
//
// Raw data: eval/results/E5/guard-profile/<label>-<commit>-<n>-<time>.json
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { basePins, POCP_ROOT } from '../lib/pins.js';

export const RAW_DIR = path.join(POCP_ROOT, 'eval', 'results', 'E5', 'guard-profile');
const SOURCE_REPO = process.env.POCP_E5_SOURCE || POCP_ROOT;

const git = (cwd, args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 << 20 }).trim();

/** A scratch clone at the commit's parent with the commit's non-.proof changes staged. */
export function prepareScenario(commit, { source = SOURCE_REPO, into, timeoutMs = null } = {}) {
  const dir = into || fs.mkdtempSync(path.join(os.tmpdir(), 'pocp-e5-scn-'));
  execFileSync('git', ['clone', '--quiet', '--no-hardlinks', '--no-checkout', source, dir], { stdio: 'ignore' });
  const sha = git(dir, ['rev-parse', commit]);
  const parent = git(dir, ['rev-parse', `${sha}^`]);
  git(dir, ['checkout', '--quiet', '--detach', parent]);
  git(dir, ['config', 'user.email', 'e5-profile@example.invalid']);
  git(dir, ['config', 'user.name', 'e5-profile']);
  git(dir, ['config', 'core.hooksPath', '/dev/null']);
  // A longer check timeout, committed on top of the parent (so it is the base's policy too):
  // under heavy outside load the full suite can pass 10 minutes and the guard's verdict would
  // be decided by the machine, not the code.
  if (timeoutMs) {
    const cfgFile = path.join(dir, '.proof', 'config.json');
    const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
    cfg.run = { ...(cfg.run || {}), timeout_ms: timeoutMs };
    fs.writeFileSync(cfgFile, `${JSON.stringify(cfg, null, 2)}\n`);
    // Fixed dates, so every clone of a scenario gets the same base commit.
    execFileSync('git', ['-C', dir, 'commit', '-q', '-m', `e5 profile: run.timeout_ms ${timeoutMs}`, '--', '.proof/config.json'], {
      stdio: 'ignore',
      env: { ...process.env, GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z' },
    });
  }
  const files = git(dir, ['diff', '--name-only', parent, sha]).split('\n').filter((f) => f && !f.startsWith('.proof/'));
  git(dir, ['checkout', sha, '--', ...files]);
  return { dir, commit: sha, parent, files, timeout_ms: timeoutMs, intent: git(dir, ['log', '-1', '--format=%s', sha]) };
}

/** Wraps a POCP runner; records every run without changing what it does or returns. */
export function timingRunner(inner, t0) {
  const runs = [];
  return {
    runs,
    runner: {
      kind: inner.kind,
      async run(command, opts = {}) {
        const rec = { command, log: opts.logFile ? path.basename(opts.logFile) : null, start_ms: Date.now() - t0, load_at_start: os.loadavg()[0] };
        runs.push(rec);
        const res = await inner.run(command, opts);
        Object.assign(rec, { end_ms: Date.now() - t0, duration_ms: res.duration_ms, exit: res.exit, timed_out: res.timed_out || false, signal: res.signal || null });
        return res;
      },
    },
  };
}

/** What a run was, from the log name POCP gave it (guard-<packet>-<ob>-<label>-<check>.log). */
export function classifyRun(run, checkIds) {
  const m = /^guard-p-[0-9a-z]+-[^-]+-(new|old|base|m(\d+)-(old|new))-(.+)\.log$/.exec(run.log || '');
  if (!m) {
    const check = checkIds.byCommand.get(run.command) || run.command;
    return { phase: 'plain', check };
  }
  const check = m[4];
  if (m[2] !== undefined) return { phase: 'mutant', mutant: Number(m[2]), side: m[3], check };
  return { phase: `guard-${m[1]}`, check };
}

async function microbench(pocpRoot, dir, reps = 3) {
  const ws = await import(pathToFileURL(path.join(pocpRoot, 'src', 'workspace.js')).href);
  const out = { tree_snapshot_ms: [], copy_snapshot_ms: [] };
  for (let i = 0; i < reps; i++) {
    let t = Date.now();
    const snap = ws.createTreeSnapshot(dir, null, { links: ['node_modules'] });
    out.tree_snapshot_ms.push(Date.now() - t);
    t = Date.now();
    const copy = ws.copySnapshot(snap.dir);
    out.copy_snapshot_ms.push(Date.now() - t);
    copy.cleanup();
    snap.cleanup();
  }
  return out;
}

export async function profileOnce({ commit, pocpRoot = POCP_ROOT, label = 'current', n = 1, keep = false, pair = null, timeoutMs = null }) {
  const scn = prepareScenario(commit, { timeoutMs });
  const { createPocp } = await import(pathToFileURL(path.join(pocpRoot, 'src', 'engine.js')).href);
  const { createProcessRunner } = await import(pathToFileURL(path.join(pocpRoot, 'src', 'runner.js')).href);
  const { runFix } = await import(pathToFileURL(path.join(pocpRoot, 'src', 'fix.js')).href);
  const rules = JSON.parse(fs.readFileSync(path.join(scn.dir, '.proof', 'rules.json'), 'utf8'));
  const byCommand = new Map(rules.requirements.filter((r) => r.obligation?.run).map((r) => [r.obligation.run, r.id]));

  const load = [];
  const t0 = Date.now();
  const sampler = setInterval(() => load.push({ t_ms: Date.now() - t0, load1: os.loadavg()[0] }), 10_000);
  const timed = timingRunner(createProcessRunner(), t0);
  const engine = await createPocp({ cwd: scn.dir, runner: timed.runner, by: 'e5-profile' });
  const startedAt = new Date().toISOString();
  let fix;
  let error = null;
  try {
    fix = await runFix(engine, { intent: scn.intent, actor: 'e5-profile' });
  } catch (err) {
    error = String(err?.stack || err);
  }
  clearInterval(sampler);
  const total_ms = Date.now() - t0;

  // The proofs POCP recorded (the guard result is the thing compared before/after).
  const proofs = [];
  for (const f of fs.readdirSync(path.join(scn.dir, '.proof', 'packets'))) {
    let p;
    try {
      p = JSON.parse(fs.readFileSync(path.join(scn.dir, '.proof', 'packets', f), 'utf8'));
    } catch {
      continue; // an empty or broken packet file committed earlier; not part of this run
    }
    for (const pr of p.proofs || []) if (Date.parse(pr.started_at) >= t0 - 1000) proofs.push({ packet: p.id, ...pr });
  }
  const micro = await microbench(pocpRoot, scn.dir);
  const raw = {
    schema: 'pocp-e5-guard-profile/1',
    label,
    pair,
    timeout_ms: scn.timeout_ms,
    commit: scn.commit,
    parent: scn.parent,
    files: scn.files,
    pocp_root_commit: (() => { try { return git(pocpRoot, ['rev-parse', 'HEAD']); } catch { return null; } })(),
    pins: basePins(),
    cpus: os.cpus().length,
    cpu_model: os.cpus()[0]?.model || null,
    started_at: startedAt,
    total_ms,
    error,
    fix: fix ? { ok: fix.ok, actions: fix.actions } : null,
    runs: timed.runs.map((r) => ({ ...r, ...classifyRun(r, { byCommand }) })),
    load,
    proofs,
    microbench: micro,
  };
  fs.mkdirSync(RAW_DIR, { recursive: true });
  const file = path.join(RAW_DIR, `${label}-${scn.commit.slice(0, 7)}-${n}-${startedAt.replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(file, `${JSON.stringify(raw, null, 1)}\n`);
  if (!keep) fs.rmSync(scn.dir, { recursive: true, force: true });
  return { file, raw };
}

// ---------- analysis ----------

const med = (xs) => {
  const s = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!s.length) return null;
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const sec = (ms) => (ms == null ? '–' : `${(ms / 1000).toFixed(1)} s`);

/** Average and peak number of check runs in flight over [from, to). */
export function concurrency(runs, from, to) {
  const ev = [];
  for (const r of runs) {
    const s = Math.max(r.start_ms, from);
    const e = Math.min(r.end_ms, to);
    if (e > s) ev.push([s, 1], [e, -1]);
  }
  ev.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let cur = 0;
  let peak = 0;
  let area = 0;
  let last = from;
  for (const [t, d] of ev) {
    area += cur * (t - last);
    last = t;
    cur += d;
    peak = Math.max(peak, cur);
  }
  return { avg: to > from ? area / (to - from) : 0, peak };
}

export function analyze(raw) {
  const runs = raw.runs.filter((r) => r.end_ms != null);
  const guardProof = raw.proofs.find((p) => p.kind === 'guard');
  const guard = guardProof?.guard || null;
  const checks = guard ? guard.checks.map((c) => c.id) : [...new Set(runs.map((r) => r.check))];
  const phaseRuns = (ph) => runs.filter((r) => r.phase === ph);
  const span = (rs) => (rs.length ? { from: Math.min(...rs.map((r) => r.start_ms)), to: Math.max(...rs.map((r) => r.end_ms)) } : null);

  const plain = phaseRuns('plain');
  const gOld = phaseRuns('guard-old');
  const gNew = phaseRuns('guard-new');
  const gBase = phaseRuns('guard-base');
  const mut = phaseRuns('mutant');
  const mutSpan = span(mut);
  const guardStart = guardProof ? Date.parse(guardProof.started_at) - Date.parse(raw.started_at) : null;

  // Per mutant and side: which checks ran, how long, which one caught it.
  const mutants = [];
  for (const i of [...new Set(mut.map((r) => r.mutant))].sort((a, b) => a - b)) {
    const side = (s) => {
      const rs = mut.filter((r) => r.mutant === i && r.side === s).sort((a, b) => a.start_ms - b.start_ms);
      const killer = rs.find((r) => r.exit !== 0 || r.timed_out);
      return { ran: rs.map((r) => ({ check: r.check, ms: r.end_ms - r.start_ms, failed: r.exit !== 0 || r.timed_out })), killer: killer?.check || null, ms: sum(rs.map((r) => r.end_ms - r.start_ms)) };
    };
    const o = guard?.detection?.mutants?.[i];
    mutants.push({ i, file: o?.file, line: o?.line, operator: o?.operator, old: side('old'), new: side('new'), outcome: o ? `${o.old}/${o.new}` : null });
  }
  // Check-seconds by check across mutant runs; and the full-suite runs that came after the
  // faster checks had passed (the suite contains those tests, so they ran twice).
  const byCheck = {};
  for (const r of mut) byCheck[r.check] = (byCheck[r.check] || 0) + (r.end_ms - r.start_ms);
  const last = checks[checks.length - 1];
  const fullRuns = mutants.flatMap((m) => ['old', 'new'].flatMap((s) => m[s].ran.filter((x) => x.check === 'test-suite')));
  // Killer-first on the new side: the check that caught the mutant on the old side runs first.
  let killerFirstSaving = 0;
  for (const m of mutants) {
    if (!m.new.ran.length || !m.old.killer) continue;
    const k = m.new.ran.find((x) => x.check === m.old.killer);
    if (k && k.failed) killerFirstSaving += m.new.ms - k.ms;
  }
  const cpuBusy = sum(mut.map((r) => r.end_ms - r.start_ms));
  return {
    label: raw.label,
    commit: raw.commit.slice(0, 7),
    started_at: raw.started_at,
    cpus: raw.cpus,
    load_median: med(raw.load.map((l) => l.load1)),
    load_max: raw.load.length ? Math.max(...raw.load.map((l) => l.load1)) : null,
    total_ms: raw.total_ms,
    verdict: guard?.verdict || null,
    guard_ms: guardProof?.duration_ms ?? null,
    guard_start_ms: guardStart,
    plain: plain.map((r) => ({ check: r.check, ms: r.end_ms - r.start_ms })),
    old_baseline: gOld.map((r) => ({ check: r.check, ms: r.end_ms - r.start_ms })),
    new_baseline: gNew.map((r) => ({ check: r.check, ms: r.end_ms - r.start_ms })),
    new_baseline_reused: guard ? guard.new_tests.runs.filter((r) => r.reused).length : null,
    base_runs: gBase.map((r) => ({ check: r.check, ms: r.end_ms - r.start_ms })),
    old_baseline_span_ms: span(gOld) ? span(gOld).to - span(gOld).from : null,
    plan_gap_ms: span(gOld) && mutSpan ? mutSpan.from - span(gOld).to : null,
    mutant_phase_ms: mutSpan ? mutSpan.to - mutSpan.from : null,
    mutant_check_ms: cpuBusy,
    mutant_concurrency: mutSpan ? concurrency(mut, mutSpan.from, mutSpan.to) : null,
    by_check_ms: byCheck,
    mutants,
    sampled: mutants.length,
    old_caught: mutants.filter((m) => m.old.killer).length,
    reached_last_check_old: mutants.filter((m) => m.old.ran.some((x) => x.check === last)).length,
    reached_last_check_new: mutants.filter((m) => m.new.ran.some((x) => x.check === last)).length,
    full_suite_runs: fullRuns.length,
    full_suite_ms: sum(fullRuns.map((x) => x.ms)),
    killer_first_saving_check_ms: killerFirstSaving,
    microbench: raw.microbench,
  };
}

export function loadRaw(dir = RAW_DIR) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort().map((f) => ({ file: f, raw: JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) }));
}

export { med, sec, sum };

async function main(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) args[a.slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
  }
  if (args.report) {
    const { renderProfile } = await import('./profile-report.js');
    fs.writeFileSync(path.join(POCP_ROOT, 'eval', 'e5', 'GUARD-PROFILE.md'), renderProfile(loadRaw()));
    return;
  }
  // --compare before=<pocp dir>,after=<pocp dir>: each round runs both versions at the same
  // time on the same scenario (alternating which one starts first), so both see the same load.
  if (args.compare) {
    const variants = String(args.compare).split(',').map((kv) => kv.split('='));
    const commits2 = String(args.commit || 'ca3e9f6').split(',');
    const rounds = Number(args.rounds || 2);
    for (let n = 1; n <= rounds; n++) {
      for (const c of commits2) {
        const pair = `${c}-${new Date().toISOString()}`;
        const order = n % 2 ? variants : [...variants].reverse();
        const done = await Promise.all(order.map(([label, dir], k) => new Promise((r) => setTimeout(r, k * 2000)).then(() => profileOnce({ commit: c, pocpRoot: path.resolve(dir), label: `${label}-paired`, n, pair, timeoutMs: args['timeout-ms'] ? Number(args['timeout-ms']) : null }))));
        for (const { file, raw } of done) {
          const a = analyze(raw);
          process.stdout.write(`${path.relative(POCP_ROOT, file)}  total ${sec(a.total_ms)}  guard ${sec(a.guard_ms)}  verdict ${a.verdict}  load~${a.load_median?.toFixed(1)}\n`);
        }
      }
    }
    return;
  }
  const commits = String(args.commit || 'ca3e9f6,df0305b').split(',');
  const runs = Number(args.runs || 1);
  const pocpRoot = path.resolve(args.pocp || POCP_ROOT);
  for (let n = 1; n <= runs; n++) {
    for (const c of commits) {
      const { file, raw } = await profileOnce({ commit: c, pocpRoot, label: args.label || 'current', n, keep: Boolean(args.keep) });
      const a = analyze(raw);
      process.stdout.write(`${path.relative(POCP_ROOT, file)}  total ${sec(a.total_ms)}  guard ${sec(a.guard_ms)}  verdict ${a.verdict}  load~${a.load_median?.toFixed(1)}\n`);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((err) => {
    process.stderr.write(`${err.stack || err}\n`);
    process.exit(1);
  });
}
