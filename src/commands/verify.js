// pocp verify: moved from src/cli.js unchanged; main() dispatches here.
import fs from 'node:fs';
import path from 'node:path';
import { COOPERATIVE } from '../runner.js';
import { DONT_REWRITE, verifyRemedy } from '../remedies.js';
import { EXIT } from '../errors.js';
import { VERIFY_EXIT } from '../approvals.js';
import { createRevCheckout } from '../workspace.js';
import { decideVerify } from '../decision.js';
import { errWrite, evidenceSummary, list, out, writeGithubSummary } from '../cli/shared.js';
import { failedOutputLines } from '../output-tail.js';
import { git, resolveRev } from '../git.js';
import { readCiResults } from '../ci-results.js';
import { shortDigest } from '../hash.js';

export async function run({ engine, flags, isolated, json, rest }) {
  const started = Date.now();
  // Before any of the pull request's code runs: set up and probe the isolation. If it
  // can't be set up, this throws and verify fails; it never falls back.
  const isolation = isolated ? isolated.isolation : COOPERATIVE;
  if (isolated) {
    await isolated.prepare({ root: engine.root });
    if (flags.install) {
      const headRev = rest[0] && rest[0].includes('..') ? rest[0].split(/\.\.\.?/)[1] || 'HEAD' : rest[0] || 'HEAD';
      const cfg = engine.config();
      const co = createRevCheckout(engine.root, resolveRev(engine.root, headRev), { links: [] });
      try {
        const logFile = engine.store.kind === 'fs' ? path.join(engine.store.runsDir(), 'install.log') : null;
        const r = await isolated.installDeps(flags.install, { dir: co.dir, links: cfg.snapshot.link, timeoutMs: cfg.run.timeout_ms, killGraceMs: cfg.run.kill_grace_ms, logFile, logCapBytes: cfg.run.log_cap_bytes, envAllow: cfg.run.env_allow || [] });
        errWrite(`pocp: installed dependencies isolated (${flags.install}): ${r.installed.join(', ') || 'no dependency folders'}\n`);
      } finally {
        co.cleanup();
      }
    } else if ((engine.config().snapshot.link || []).some((l) => fs.existsSync(path.join(engine.root, l)))) {
      errWrite('pocp: note: isolated checks can\'t read this checkout, so dependency folders installed in it aren\'t visible to them; install with verify --install <cmd>\n');
    }
  }
  let ignoredCi = 0;
  const ciResults = list(flags['ci-results']).flatMap((file) => {
    const r = readCiResults(file, { root: engine.root });
    ignoredCi += r.ignored;
    return r.records;
  });
  if (ignoredCi) errWrite(`pocp: ignored ${ignoredCi} CI result(s) recorded by a different CI run\n`);
  if (ciResults.length) errWrite('pocp: trusting CI results from --ci-results: anything that ran earlier in this job could have written them (docs/THREAT-MODEL.md)\n');
  // An approval that names a commit covers only that head: a later push needs a new one.
  const headRev = rest[0] && rest[0].includes('..') ? rest[0].split(/\.\.\.?/)[1] || 'HEAD' : rest[0] || 'HEAD';
  const approval = (name) => {
    const v = [].concat(flags[name] ?? false).pop();
    if (typeof v !== 'string') return Boolean(v);
    const head = resolveRev(engine.root, headRev);
    const given = /^[0-9a-f]{7,64}$/i.test(v) ? git(engine.root, ['rev-parse', '--verify', '--quiet', `${v}^{commit}`], { allowFail: true }) : null;
    if (given === head) return true;
    errWrite(`pocp: approval for ${v} does not cover ${head.slice(0, 12)}, the head being verified: a push after the approval needs a new one (--${name})\n`);
    return false;
  };
  const vopts = {
    rerun: flags['rerun-unsigned'] ? 'unsigned' : Boolean(flags.rerun),
    requireCoverage: Boolean(flags['require-coverage']),
    ciResults,
    policyFrom: flags['policy-from'],
    acceptPolicyChange: approval('accept-policy-change'),
    acceptTestChange: approval('accept-test-change'),
    acceptInconclusive: approval('accept-inconclusive'),
    acceptUncovered: approval('accept-uncovered'),
    allowedSignersFile: flags['allowed-signers'],
    jobs: flags.jobs,
  };
  const rerunLines = (reruns) => reruns.map((x) => `  rerun ${x.status.padEnd(8)} ${x.run}${x.duration_ms !== undefined ? ` (${x.duration_ms}ms)` : ''}${x.kind === 'guard' && x.summary ? `: ${x.summary}` : ''}`);
  const nextSteps = (rows2) => {
    const seen = new Map();
    for (const c of rows2) for (const f of (c.findings || []).filter((x) => x.blocking)) if (!seen.has(f.code)) seen.set(f.code, { code: f.code, ...verifyRemedy(f.code, f.detail, f) });
    // A re-run that ran and failed outranks one that only timed out, for what to do next.
    const reruns = (result?.rerun_failures || []).filter((x) => x.blocking !== false);
    const worst = reruns.find((x) => !x.unfinished) || reruns[0];
    if (worst && !seen.has('rerun_failed')) seen.set('rerun_failed', { code: 'rerun_failed', ...verifyRemedy('rerun_failed', worst.detail || worst.problem, worst) });
    const list2 = [...seen.values()];
    if (!list2.length) return [];
    const out2 = ['  what to do:', ...list2.map((x) => `    ${x.code}: ${x.why ? `${x.why} ` : ''}next: ${x.next}${x.by === 'person' ? '   (needs a person)' : ''}`)];
    if (list2.some((x) => x.by === 'person')) out2.push(`    ${DONT_REWRITE}`);
    return out2;
  };
  // A range's own findings, apart from re-run failures (rerun_failures lists those).
  const rangeFindings = (r) => (r.findings && r.commits ? r.findings.filter((f) => f.code !== 'rerun_failed') : []);
  const commitProblems = (c) => [
    // Commit-level findings (policy, CI files, test guard, required CI); coverage is listed below.
    ...(c.findings || []).filter((f) => f.blocking && !f.packet && f.code !== 'uncovered').map((f) => f.detail),
    ...c.packets.filter((p) => !p.ok).map((p) => `${p.id}: ${p.problems.join('; ')}`),
    ...(c.coverage?.uncovered.length ? [`not covered: ${c.coverage.uncovered.join(', ')}`] : []),
  ];
  // How the checks verify ran were run: isolated, or the cooperative runner, which is not
  // the hosted secure profile. Shown whenever a check ran.
  const isolationLine = (reruns) => (isolated || reruns.some((x) => x.duration_ms !== undefined && !x.reused) ? [`  checks: ${isolation.mode}: ${isolation.detail}`] : []);
  let result;
  let human;
  let rows;
  if (rest[0] && rest[0].includes('..')) {
    result = await engine.verifyRange(rest[0], vopts);
    // The range's net change (all commits and merges as one change) is judged like a commit.
    rows = [...result.commits, ...(result.net ? [result.net] : [])];
    human = [
      `${result.ok ? 'verified' : 'NOT verified'}: ${result.commits.length} commit(s) in ${result.range} · ${Date.now() - started}ms`,
      ...result.commits.map((c) => `  ${c.ok ? 'ok ' : 'BAD'} ${c.commit.slice(0, 12)}${c.ok ? '' : `: ${commitProblems(c).join(' | ')}`}`),
      ...(result.net ? [`  ${result.net.ok ? 'ok ' : 'BAD'} net change ${result.net.base.slice(0, 12)}..${result.net.commit.slice(0, 12)}${result.net.ok ? '' : `: ${commitProblems(result.net).join(' | ')}`}`] : []),
      ...(result.notes || []).map((n) => `  note: ${n}`),
      ...isolationLine([...result.reruns, ...(result.net?.reruns || [])]),
      ...rerunLines([...result.reruns, ...(result.net?.reruns || [])]),
      ...(result.ok ? [] : nextSteps([...rows, { findings: rangeFindings(result) }])),
      ...failedOutputLines([...result.reruns, ...(result.net?.reruns || [])]),
    ].join('\n');
  } else {
    result = await engine.verify(rest[0] || 'HEAD', vopts);
    rows = [result];
    human = [
      `${result.ok ? 'verified' : 'NOT verified'}: ${result.commit.slice(0, 12)} subject ${shortDigest(result.subject)} · ${Date.now() - started}ms`,
      ...result.notes.map((n) => `  note: ${n}`),
      ...result.warnings.map((w) => `  warning: ${w}`),
      ...result.packets.map((p) => `  ${p.id}: ${p.ok ? 'ok' : p.problems.join('; ')}${p.evidence && Object.keys(p.evidence).length ? ` · evidence: ${evidenceSummary(p.evidence)}` : ''}`),
      ...(result.coverage?.uncovered.length ? [`  not covered: ${result.coverage.uncovered.join(', ')}`] : []),
      ...isolationLine(result.reruns),
      ...rerunLines(result.reruns),
      ...(result.ok ? [] : nextSteps([result])),
      ...failedOutputLines(result.reruns),
    ].join('\n');
  }
  result.isolation = { mode: isolation.mode, secure: isolation.secure };
  // One decision for the library and the CLI, from typed findings (src/decision.js).
  if (!result.ok) result.approval = decideVerify(result);
  writeGithubSummary(result, rows, commitProblems, Date.now() - started, { annotations: !json });
  out(json, result, human);
  if (result.ok) return EXIT.ok;
  // --exit-detail: 4 when only a maintainer's approval is missing, 5 when something didn't
  // finish (re-run, or approve with --accept-inconclusive); every other failure stays 1.
  if (flags['exit-detail'] && result.approval?.outcome in VERIFY_EXIT) return VERIFY_EXIT[result.approval.outcome];
  return EXIT.blocked;
}
