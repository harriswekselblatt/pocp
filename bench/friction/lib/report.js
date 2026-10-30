import fs from 'node:fs';
import path from 'node:path';
import { BENCH_ROOT } from './replay.js';

const pct = (n, d) => (d ? `${Math.round((n / d) * 100)}%` : 'n/a');
const sec = (ms) => (ms === null || ms === undefined ? '—' : ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`);
function quantile(xs, q) {
  const s = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!s.length) return null;
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
}
const sum = (xs) => xs.reduce((a, b) => a + (b || 0), 0);

/** Headline numbers for one results file. */
export function summarize(r) {
  const rows = r.commits.filter((c) => c.outcome && c.outcome !== 'empty' && c.outcome !== 'error');
  const full = rows.filter((c) => c.full);
  const hookMs = (name) => rows.flatMap((c) => [...(c.first_attempt?.hooks || []), ...(c.steps || []).flatMap((s) => s.hooks || [])]).filter((h) => h.cmd === name).map((h) => h.ms);
  const proveMs = full.map((c) => sum((c.steps || []).filter((s) => s.cmd === 'prove' || s.cmd === 'fix').map((s) => s.ms))).filter((x) => x > 0);
  return {
    commits: rows.length,
    errors: r.commits.filter((c) => c.outcome === 'error').length,
    free: rows.filter((c) => c.outcome === 'free').length,
    ceremony: rows.filter((c) => c.outcome !== 'free').length,
    stuck: full.filter((c) => c.outcome === 'stuck').length,
    full: full.length,
    explained: rows.filter((c) => c.outcome !== 'free' && c.gate?.explained).length,
    needs_person: full.filter((c) => c.needs_person).length,
    ci_failed: full.filter((c) => c.ci && !c.ci.ok).length,
    commands_per_blocked: (() => {
      const b = full.filter((c) => c.outcome !== 'free' && c.ceremony_commands !== undefined);
      return b.length ? Math.round((sum(b.map((c) => c.ceremony_commands)) / b.length) * 10) / 10 : null;
    })(),
    hooks: Object.fromEntries(['gate', 'trailer', 'land'].map((h) => [h, { median: quantile(hookMs(h), 0.5), p90: quantile(hookMs(h), 0.9), max: quantile(hookMs(h), 1) }])),
    prove: { median: quantile(proveMs, 0.5), max: quantile(proveMs, 1), total: sum(proveMs) },
    repeat_prove: { max: quantile(full.map((c) => c.repeat_prove?.ms), 1), ran: sum(full.map((c) => c.repeat_prove?.ran || 0)) },
    verify: { median: quantile(full.map((c) => c.ci?.verify_ms), 0.5), max: quantile(full.map((c) => c.ci?.verify_ms), 1), total: sum(full.map((c) => c.ci?.verify_ms)) },
  };
}

function table(results) {
  const lines = [
    '| Repo | POCP | Commits | Blocked at commit | Explained | Stuck | Commands per block | CI needs a person | CI failed |',
    '|---|---|---|---|---|---|---|---|---|',
  ];
  for (const r of results) {
    const s = summarize(r);
    lines.push(`| ${r.target} | ${r.label} (\`${r.pocp}\`, ${r.protocol}) | ${s.commits} | ${s.ceremony} (${pct(s.ceremony, s.commits)}) | ${s.explained}/${s.ceremony} | ${s.stuck}/${s.full} | ${s.commands_per_blocked ?? '—'} | ${s.needs_person}/${s.full} | ${s.ci_failed}/${s.full} |`);
  }
  lines.push('', '| Repo | POCP | pre-commit (median / p90 / max) | prepare-commit-msg | post-commit | prove per commit (median / max) | prove again, same code | verify in CI (median / max) |', '|---|---|---|---|---|---|---|---|');
  for (const r of results) {
    const s = summarize(r);
    const h = (k) => `${sec(s.hooks[k].median)} / ${sec(s.hooks[k].p90)} / ${sec(s.hooks[k].max)}`;
    lines.push(`| ${r.target} | ${r.label} | ${h('gate')} | ${h('trailer')} | ${h('land')} | ${sec(s.prove.median)} / ${sec(s.prove.max)} | ${sec(s.repeat_prove.max)} (${s.repeat_prove.ran} checks re-ran) | ${sec(s.verify.median)} / ${sec(s.verify.max)} |`);
  }
  return lines.join('\n');
}

function perCommit(r) {
  const lines = [`#### ${r.target}, ${r.label}`, '', '| Commit | Files | Gate said | Outcome | Commands | prove | verify | CI findings |', '|---|---|---|---|---|---|---|---|'];
  for (const c of r.commits) {
    const prove = sum((c.steps || []).filter((s) => s.cmd === 'prove' || s.cmd === 'fix').map((s) => s.ms));
    lines.push(`| \`${c.commit}\` ${c.subject.slice(0, 50).replace(/\|/g, '/')} | ${c.files ?? '—'} | ${(c.gate?.reasons || []).join(', ') || (c.gate ? 'pass' : '—')} | ${c.outcome}${c.error ? `: ${c.error.slice(0, 80)}` : ''} | ${c.ceremony_commands ?? '—'} | ${prove ? sec(prove) : '—'} | ${sec(c.ci?.verify_ms)} | ${c.ci ? (c.ci.ok ? 'ok' : c.ci.findings.join(', ') || c.ci.error || 'failed') : '—'} |`);
  }
  return lines.join('\n');
}

/** Rewrite the generated part of RESULTS.md from results/*.json. */
export function renderResults() {
  const dir = path.join(BENCH_ROOT, 'results');
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort() : [];
  const results = files.map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
  const rank = { main: 0, before: 0, pr8: 1, after: 2 };
  const order = (r) => `${r.target}\0${rank[r.label] ?? 3}`;
  results.sort((a, b) => (order(a) < order(b) ? -1 : 1));
  const body = [
    '<!-- generated by `node bench/friction/run.js --report-only`; edit the text outside these markers -->',
    table(results),
    '',
    '<details><summary>Per commit</summary>',
    '',
    ...results.map(perCommit).flatMap((t) => [t, '']),
    '</details>',
    '<!-- end generated -->',
  ].join('\n');
  const file = path.join(BENCH_ROOT, 'RESULTS.md');
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '# Friction benchmark results\n\n<!-- generated --><!-- end generated -->\n';
  const start = text.indexOf('<!-- generated');
  const end = text.indexOf('<!-- end generated -->');
  const next = start === -1 || end === -1 ? `${text}\n${body}\n` : `${text.slice(0, start)}${body}${text.slice(end + '<!-- end generated -->'.length)}`;
  fs.writeFileSync(file, next);
  return results.map(summarize);
}
