#!/usr/bin/env node
// Friction benchmark: replays real, honest commits through POCP's hooks and CI check and
// measures what it costs. See README.md.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BENCH_ROOT, POCP_ROOT, benchEnv, commitsToReplay, git, linkShared, loadTarget, policyFiles, readLog, run } from './lib/replay.js';
import { renderResults } from './lib/report.js';

function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const k = a.slice(2);
    const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
    o[k] = v;
  }
  return o;
}

const args = parseArgs(process.argv.slice(2));
if (args['report-only']) {
  renderResults();
  process.exit(0);
}
if (!args.target) {
  process.stderr.write('usage: node bench/friction/run.js --target <name> [--repo <path>] [--pocp <pocp checkout>] [--label <name>] [--commits N] [--full K] [--protocol fix|manual] [--work <dir>] [--keep]\n');
  process.exit(2);
}

const target = loadTarget(args.target, args.repo);
const pocpDir = path.resolve(args.pocp || POCP_ROOT);
const pocpCli = path.join(pocpDir, 'bin', 'pocp.js');
const label = args.label || 'current';
const nCommits = Number(args.commits || target.commits || 16);
const nFull = Number(args.full ?? nCommits);
const work = path.resolve(args.work || fs.mkdtempSync(path.join(os.tmpdir(), 'pocp-friction-')));
fs.mkdirSync(work, { recursive: true });
const repo = path.join(work, `${target.name}-${label}`);
const logFile = path.join(work, `${target.name}-${label}.hooks.jsonl`);
const env = benchEnv(pocpCli, logFile);
const outFile = path.join(BENCH_ROOT, 'results', `${target.name}-${label}.json`);

const pocp = (cwd, a) => run(process.execPath, [pocpCli, ...a], { cwd, env });
const parse = (r) => {
  try {
    return JSON.parse(r.out);
  } catch {
    return null;
  }
};

async function detectProtocol() {
  if (args.protocol) return args.protocol;
  const help = await run(process.execPath, [pocpCli, 'help'], { env });
  return /^\s+fix\b/m.test(help.out) ? 'fix' : 'manual';
}

/** What the gate says, without committing. */
async function gateReasons(cwd) {
  const r = await pocp(cwd, ['gate', '--json']);
  const j = parse(r) || {};
  return {
    ms: r.ms,
    decision: j.decision,
    reasons: (j.reasons || []).map((x) => x.code),
    problems: (j.problems || []).map((x) => x.code),
    unpacketed: j.unpacketed || [],
    suggestion: j.suggestion || null,
    remedies: j.remedies || null,
    raw: j,
  };
}

/** Commit through the hooks; returns per-hook timings. */
async function commitThroughHooks(cwd, message) {
  fs.rmSync(logFile, { force: true });
  const r = await git(cwd, ['commit', '-q', '-m', message], { env, allowFail: true, raw: true });
  return { ok: r.code === 0, ms: r.ms, hooks: readLog(logFile), stderr: r.err.slice(-1500) };
}

/** The documented flow before `pocp fix`: open the suggested packet, prove, sign off, retry. */
async function manualProtocol(cwd, subject) {
  const steps = [];
  const step = async (a) => {
    const r = await pocp(cwd, a);
    steps.push({ cmd: a.slice(0, 1).concat(a[1] && !a[1].startsWith('--') ? [a[1]] : []).join(' '), ms: r.ms, exit: r.code });
    return r;
  };
  for (let round = 0; round < 2; round++) {
    const g = await gateReasons(cwd);
    if (g.decision === 'pass') break;
    if (g.suggestion) {
      const a = ['open', '--intent', subject, ...g.suggestion.touches.flatMap((t) => ['--touch', t])];
      if (!g.suggestion.obligations.length) a.push('--test', target.ciCommand);
      await step(a);
    }
    let p = await step(['prove', '--json']);
    if (/clean mode refused/.test(p.out + p.err)) p = await step(['prove', '--mode', 'snapshot', '--json']);
    const st = parse(await pocp(cwd, ['status', '--json'])) || { packets: [] };
    for (const pk of st.packets || []) {
      for (const ob of pk.evaluation?.unattested || []) await step(['attest', pk.id, ob, '--by', 'bench-agent', '--note', 'agent sign-off']);
      if (pk.evaluation?.missing_required?.length) await step(['sync', pk.id]);
    }
    const c = await commitThroughHooks(cwd, subject);
    steps.push({ cmd: 'git commit', ms: c.ms, exit: c.ok ? 0 : 1, hooks: c.hooks });
    if (c.ok) return { steps, committed: true };
  }
  return { steps, committed: false };
}

/** The flow with `pocp fix`: one command, then commit. */
async function fixProtocol(cwd, subject) {
  const steps = [];
  const r = await pocp(cwd, ['fix', '--intent', subject, '--json']);
  const j = parse(r);
  steps.push({ cmd: 'fix', ms: r.ms, exit: r.code, needs_person: j?.needs_person?.map((x) => x.code) || [], did: j?.actions?.map((x) => x.action) || [] });
  const c = await commitThroughHooks(cwd, subject);
  steps.push({ cmd: 'git commit', ms: c.ms, exit: c.ok ? 0 : 1, hooks: c.hooks });
  return { steps, committed: c.ok, fix: j };
}

/** CI: a fresh clone of the commit, the plain test step through ci-run, then pocp verify. */
async function ciVerify(base) {
  const ci = path.join(work, `${target.name}-${label}-ci`);
  fs.rmSync(ci, { recursive: true, force: true });
  await git(work, ['clone', '-q', repo, ci]);
  linkShared(ci, target);
  const results = path.join(work, 'ci-results.jsonl');
  fs.rmSync(results, { force: true });
  const testStep = await pocp(ci, ['ci-run', '--results', results, '--', target.ciCommand]);
  const v = await pocp(ci, ['verify', `${base}..HEAD`, '--rerun-unsigned', '--require-coverage', '--ci-results', results, '--json']);
  const j = parse(v) || {};
  const findings = (j.commits || []).flatMap((c) => (c.findings || []).filter((f) => f.blocking).map((f) => f.code));
  const reruns = j.reruns || [];
  fs.rmSync(ci, { recursive: true, force: true });
  return {
    test_step_ms: testStep.ms,
    test_step_ok: testStep.code === 0,
    verify_ms: v.ms,
    ok: j.ok === true,
    findings: [...new Set(findings)],
    guard_reruns: (j.commits || []).flatMap((c) => c.reruns || []).filter((x) => x.kind === 'guard').length,
    reruns: reruns.length,
    error: j.error || null,
  };
}

async function setupClone() {
  fs.rmSync(repo, { recursive: true, force: true });
  await git(work, ['clone', '-q', '--no-checkout', target.sourceDir, repo]);
  await git(repo, ['checkout', '-q', '--detach', target.head]);
  linkShared(repo, target);
  const h = await pocp(repo, ['hooks', 'install', '--force']);
  if (h.code !== 0) throw new Error(`hooks install failed: ${h.err}`);
}

async function main() {
  const protocol = await detectProtocol();
  const policy = await policyFiles(target);
  const commits = await commitsToReplay(target, nCommits);
  const dirty = (await git(pocpDir, ['status', '--porcelain', '--', 'src', 'bin'], { allowFail: true })) ? '+changes' : '';
  const pocpRev = `${(await git(pocpDir, ['rev-parse', '--short', 'HEAD'], { allowFail: true })) || 'unknown'}${dirty}`;
  await setupClone();
  const result = {
    target: target.name,
    label,
    pocp: pocpRev,
    protocol,
    node: process.versions.node,
    platform: `${process.platform}-${process.arch}`,
    cpus: os.cpus().length,
    started_at: new Date().toISOString(),
    policy: { rules: JSON.parse(policy['.proof/rules.json']), config: JSON.parse(policy['.proof/config.json']) },
    commits: [],
  };
  const save = () => {
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, `${JSON.stringify(result, null, 2)}\n`);
  };

  for (const [i, sha] of commits.entries()) {
    const full = i >= commits.length - nFull;
    const subject = await git(target.sourceDir, ['log', '-1', '--format=%s', sha]);
    const parent = await git(target.sourceDir, ['rev-parse', `${sha}^1`]);
    const row = { commit: sha.slice(0, 10), subject, full };
    process.stderr.write(`[${i + 1}/${commits.length}] ${sha.slice(0, 10)} ${subject.slice(0, 60)}\n`);
    try {
      await git(repo, ['checkout', '-q', '-f', '--detach', parent]);
      await git(repo, ['clean', '-q', '-fd']);
      for (const [rel, text] of Object.entries(policy)) {
        fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
        fs.writeFileSync(path.join(repo, rel), text);
      }
      await git(repo, ['add', '-A', '.proof'], { env });
      await git(repo, ['commit', '-q', '--no-verify', '--allow-empty', '-m', 'bench: policy'], { env });
      const base = await git(repo, ['rev-parse', 'HEAD']);
      const diff = await run('git', ['diff', '--binary', parent, sha, '--', '.', ':(exclude).proof'], { cwd: target.sourceDir });
      const applied = await run('git', ['apply', '--index', '--whitespace=nowarn'], { cwd: repo, input: diff.out, env });
      if (applied.code !== 0) throw new Error(`could not apply the commit: ${applied.err.slice(0, 300)}`);
      row.files = (await git(repo, ['diff', '--cached', '--name-only'])).split('\n').filter(Boolean).length;
      if (!row.files) {
        row.outcome = 'empty';
        result.commits.push(row);
        continue;
      }
      const gate = await gateReasons(repo);
      row.gate = { ms: gate.ms, decision: gate.decision, reasons: gate.reasons, problems: gate.problems, explained: Boolean(gate.remedies?.length) };
      const first = await commitThroughHooks(repo, subject);
      row.first_attempt = { ok: first.ok, ms: first.ms, hooks: first.hooks };
      if (first.ok) {
        row.outcome = 'free';
      } else if (!full) {
        row.outcome = 'ceremony';
      } else {
        const proto = protocol === 'fix' ? await fixProtocol(repo, subject) : await manualProtocol(repo, subject);
        row.steps = proto.steps;
        row.ceremony_commands = proto.steps.filter((s) => s.cmd !== 'git commit').length;
        row.outcome = proto.committed ? 'ceremony' : 'stuck';
        if (!proto.committed) row.stuck_on = (await gateReasons(repo)).raw?.reasons?.map((x) => x.detail).slice(0, 3);
        if (proto.fix) row.fix_needs_person = proto.fix.needs_person || [];
      }
      if (full && row.outcome !== 'stuck') {
        // Proving again on the same code must not run anything again.
        const again = await pocp(repo, ['prove', '--json']);
        const aj = parse(again);
        row.repeat_prove = { ms: again.ms, ran: aj?.ran ?? null };
        row.ci = await ciVerify(base);
        row.needs_person = !row.ci.ok && row.ci.findings.some((f) => ['test_change', 'policy_loosened', 'ci_config_changed'].includes(f));
      }
    } catch (err) {
      row.outcome = 'error';
      row.error = String(err.message || err).slice(0, 500);
    }
    result.commits.push(row);
    save();
  }
  result.finished_at = new Date().toISOString();
  save();
  if (!args.keep) fs.rmSync(work, { recursive: true, force: true });
  process.stderr.write(`wrote ${path.relative(process.cwd(), outFile)}\n`);
}

main().catch((err) => {
  process.stderr.write(`${err.stack || err}\n`);
  process.exit(1);
});
