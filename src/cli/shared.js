// Helpers every pocp command shares: output, error text, the engine. Moved from src/cli.js.
import fs from 'node:fs';
import path from 'node:path';
import { SELF_BIN } from '../init.js';
import { approvalAnnotation } from '../approvals.js';
import { createPocp } from '../engine.js';
import { loadHost } from '../host.js';
import { remedyLines } from '../remedies.js';
import { shortDigest } from '../hash.js';

export const list = (v) => (v === undefined ? [] : [].concat(v));

export function shellJoin(args) {
  if (args.length === 1) return args[0];
  return args.map((a) => (/^[A-Za-z0-9_\-+=.,/:@%^]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`)).join(' ');
}

// Installed in a project (npm install --save-dev), pocp isn't on PATH: the commands it suggests
// must read "npx pocp …", which finds the project's copy first. Installed globally, "pocp …".
export const LOCAL_INSTALL = SELF_BIN.includes(`${path.sep}node_modules${path.sep}`);
export function localizeCommands(text, local = LOCAL_INSTALL) {
  return local ? String(text).replace(/(?<![\w./-])(?<!npx )pocp (?=[a-z])/g, 'npx pocp ') : text;
}
export const errWrite = (text) => process.stderr.write(localizeCommands(text));

export function out(json, data, human) {
  if (json) process.stdout.write(`${JSON.stringify({ pocp: 1, ...data }, null, 2)}\n`);
  else if (human) process.stdout.write(`${localizeCommands(human)}\n`);
}

/** Why each guard obligation still needs a sign-off: what the mechanical check found. */
export function guardLines(ev, id, indent) {
  return (ev.guard || [])
    .filter((x) => ev.unattested.includes(x.id))
    .map((x) => `${indent}${x.id} (test guard): ${x.detail || x.status}. If this is intended, a person signs off: pocp attest ${id} ${x.id} --by <you>`);
}

export function evalLine(ev) {
  const parts = [`proven ${ev.counts.proven}/${ev.counts.runnable}`];
  if (ev.counts.manual) parts.push(`attested ${ev.counts.attested}/${ev.counts.manual}`);
  if (ev.failed.length) parts.push(`failed: ${ev.failed.join(', ')}`);
  if (ev.missing_required.length) parts.push(`missing required: ${ev.missing_required.map((m) => m.id).join(', ')}`);
  return parts.join(' · ');
}

export function formatGate(r) {
  const lines = [];
  if (r.decision === 'pass') {
    const proven = r.packets.filter((p) => p.evaluation.ok).length;
    lines.push(r.required_files.length ? `pocp: gate passed (${proven} packet(s) proven for ${shortDigest(r.subject)})` : `pocp: gate passed (no packet needed for ${r.files.length} file(s))`);
    for (const w of (r.warnings || []).filter((x) => !x.code?.startsWith('awaiting_'))) lines.push(`  note: ${w.detail}`);
    if (r.pending_approvals?.length) {
      lines.push('  CI requires human approval for this commit:');
      lines.push(...remedyLines(r.pending_approvals, '    '));
    }
    return lines.join('\n');
  }
  lines.push(r.decision === 'error' ? 'pocp: gate error' : 'pocp: commit blocked');
  for (const reason of r.reasons) lines.push(`  why: ${reason.detail}`);
  if (r.unpacketed?.length) {
    lines.push(`  not covered by any packet: ${r.unpacketed.slice(0, 12).join(', ')}${r.unpacketed.length > 12 ? ' …' : ''}`);
  }
  const waiting = r.uncovered.filter((f) => !(r.unpacketed || []).includes(f));
  if (waiting.length) lines.push(`  covered, but no packet is proven for this code yet: ${waiting.slice(0, 12).join(', ')}${waiting.length > 12 ? ' …' : ''}`);
  for (const p of r.packets) {
    if (p.evaluation.ok) continue;
    lines.push(`  ${p.id} (${p.intent}): ${evalLine(p.evaluation)}`);
    if (p.evaluation.unproven.length) lines.push(`    needs proof: ${p.evaluation.unproven.join(', ')}  →  pocp prove ${p.id}`);
    const guardIds = (p.evaluation.guard || []).map((x) => x.id);
    const plain = p.evaluation.unattested.filter((x) => !guardIds.includes(x));
    if (plain.length) lines.push(`    needs attestation: ${plain.join(', ')}  →  pocp attest ${p.id} <obligation> --by <you>`);
    lines.push(...guardLines(p.evaluation, p.id, '    '));
    if (p.evaluation.missing_required.length) lines.push(`    rules changed  →  pocp sync ${p.id}`);
  }
  for (const pr of r.problems) lines.push(`  ${pr.code}: ${pr.detail}`);
  for (const w of r.warnings || []) lines.push(`  note: ${w.detail}`);
  if (r.suggestion) {
    lines.push('  suggested packet:');
    lines.push(`    ${r.suggestion.command}`);
    lines.push(`    ${r.suggestion.note}`);
  }
  if (r.remedies?.length) {
    lines.push('  what to do:');
    lines.push(...remedyLines(r.remedies, '    '));
  }
  if (r.remedies?.some((x) => x.by === 'pocp fix')) lines.push('  "pocp fix" takes every step above marked pocp fix, then commit again.');
  else if (!r.remedies?.some((x) => x.by === 'person')) lines.push('  (prove and commit again, or "pocp gate --prove" to run missing checks first)');
  return lines.join('\n');
}

/** On GitHub Actions, add a results table to the job summary and error annotations. */
export function writeGithubSummary(result, rows, commitProblems, ms, { annotations = true } = {}) {
  const file = process.env.GITHUB_STEP_SUMMARY;
  // Annotations are printed to stdout, so never in --json mode: machine output stays pure JSON.
  if (annotations && process.env.GITHUB_ACTIONS === 'true') {
    for (const c of rows) {
      if (!c.ok) process.stdout.write(`::error title=POCP::${c.kind === 'net' ? 'net change ' : ''}${c.commit.slice(0, 12)} ${commitProblems(c).join(' | ').replace(/\r?\n/g, ' ')}\n`);
    }
    for (const f of result.rerun_failures || []) process.stdout.write(`::error title=POCP rerun::${f.packet}: ${f.problem}\n`);
    // Machine-readable, for "pocp approvals": what a maintainer's label would clear.
    const note = approvalAnnotation(result.approval);
    if (note) process.stdout.write(`${note}\n`);
  }
  if (!file) return;
  const esc = (s) => String(s).replace(/\|/g, '\\|');
  const lines = [
    `### POCP ${result.ok ? '✅ verified' : '❌ not verified'}`,
    '',
    `${rows.length} commit(s) · ${ms}ms`,
    '',
    '| Commit | Packets | Result |',
    '|---|---|---|',
    ...rows.map((c) => `| ${c.kind === 'net' ? 'net change ' : ''}\`${c.commit.slice(0, 12)}\` | ${c.packets.map((p) => p.id).join(', ') || '—'} | ${c.ok ? 'ok' : esc(commitProblems(c).join('; '))} |`),
  ];
  if (result.isolation) lines.push('', result.isolation.secure ? 'Checks ran isolated: each as a fresh unprivileged user.' : 'Checks ran as the job\'s own user (cooperative runner): not the hosted secure profile.');
  if (result.approval?.only) lines.push('', `Waiting only for a maintainer: ${result.approval.needs.map((n) => `\`${n.label}\``).join(' and ')} (see \`pocp approvals\`).`);
  const reruns = [...(result.reruns || []), ...(result.net?.reruns || [])];
  if (reruns.length) {
    lines.push('', '| Check | Result |', '|---|---|', ...reruns.map((x) => `| \`${esc(x.run)}\` | ${esc(x.status)}${x.duration_ms !== undefined ? ` (${x.duration_ms}ms)` : ''} |`));
  }
  try {
    fs.appendFileSync(file, `${lines.join('\n')}\n`);
  } catch { /* summary is best effort */ }
}

export function evidenceSummary(evidence) {
  const counts = {};
  for (const v of Object.values(evidence)) {
    const k = v.split(':')[0];
    counts[k] = (counts[k] || 0) + 1;
  }
  return Object.entries(counts).map(([k, n]) => `${n} ${k}`).join(', ');
}

/** What a failed --apply means, in full: the branch is unchanged, POCP itself still works. */
export function applyFailureMessage(r, plan) {
  if (r.refused) return `could not set branch protection: ${r.error}`;
  const where = r.repo ? `${r.repo}@${plan.branch}` : plan.branch;
  const planLimited = /upgrade to github pro|make this repository public/i.test(r.error || '');
  return [
    `could not set branch protection on ${where}: ${r.error}`,
    `  ${where} is unchanged: GitHub will not block merges on these checks until protection is set.`,
    ...(planLimited ? ['  GitHub only allows branch protection on private repositories with a paid plan; public repositories can use it on any plan.'] : []),
    '  POCP verification is unaffected: `pocp verify` still runs in CI and fails its check on a bad change.',
    planLimited
      ? '  Once protection is available (public repository or paid plan), require these checks, with this command or in Settings → Branches:'
      : '  To enforce the same rules by hand (repository Settings → Branches), require these checks:',
    ...plan.required_checks.map((c) => `    - ${c}`),
    ...(plan.require_pull_request ? ['  and require a pull request before merging.'] : []),
  ].join('\n');
}


export async function buildEngine(flags, { runner } = {}) {
  const hostSpec = flags['no-host'] ? null : flags.host || process.env.POCP_HOST;
  const host = await loadHost(hostSpec);
  return createPocp({
    cwd: process.cwd(),
    runner,
    by: flags.by,
    policy: host?.policy,
    events: host?.events,
    hostName: host?.name,
  });
}
