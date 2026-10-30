// Results JSON → RESULTS.md. Pure: the same results always render the same page.
import { CATEGORIES } from './scenarios.js';

const pct = (a, b) => (b ? `${Math.round((100 * a) / b)}%` : 'n/a');
const esc = (s) => String(s).replace(/\|/g, '\\|');

/** Headline numbers for one profile's scenarios. */
export function summarize(scenarios) {
  const bugs = scenarios.filter((s) => s.bug && s.outcome !== 'error');
  const fooled = bugs.filter((s) => s.plain_ci === 'pass');
  const incremental = fooled.filter((s) => s.pocp === 'block');
  const missed = bugs.filter((s) => s.pocp === 'pass');
  const controls = scenarios.filter((s) => !s.bug);
  const falsePos = controls.filter((s) => s.pocp === 'block' || s.plain_ci !== 'pass');
  return {
    scenarios: scenarios.length,
    with_bug: bugs.length,
    plain_ci_caught: bugs.length - fooled.length,
    fooled_plain_ci: fooled.length,
    incremental: incremental.length,
    pocp_caught: bugs.length - missed.length,
    missed: missed.map((s) => s.id),
    controls: controls.length,
    false_positives: falsePos.map((s) => s.id),
    errors: scenarios.filter((s) => s.outcome === 'error').map((s) => s.id),
  };
}

const verdict = (s) => (s ? (s.pocp === 'block' ? `**blocks** ${s.codes.map((c) => `\`${c}\``).join(' ')}` : s.pocp === 'pass' ? 'passes' : 'error') : '');
const gateCell = (s) => {
  if (!s?.local) return '';
  const l = s.local;
  if (l.hooks?.startsWith('skipped')) return l.hooks;
  return `${l.hooks || '?'}${l.gate_codes?.length ? ` (${l.gate_codes.join(', ')})` : ''}`;
};

function outcomeWord(s) {
  if (!s) return '';
  return {
    incremental: 'POCP only',
    both: 'both',
    missed: '**missed by both**',
    'pocp-missed-ci-caught': 'plain CI only',
    ok: 'ok (no bug)',
    'false-positive': '**false positive**',
    'plain-ci-false-positive': '**plain CI false positive**',
    error: 'error',
  }[s.outcome] || s.outcome;
}

function targetSection(r) {
  const names = Object.keys(r.profiles);
  const lines = [];
  lines.push(`## ${r.target}`, '');
  lines.push(`${r.about} Test command: \`${r.ci_command}\` (${r.framework}). Source commit \`${r.source_commit}\`.`, '');
  if (r.setup_note) lines.push(`Scratch setup: ${r.setup_note}`, '');
  for (const m of r.mutants) {
    const ok = Object.entries(m.cheats).map(([k, c]) => `${k} ${c.effective ? 'works' : 'fails'}`).join(', ');
    lines.push(`Bug: \`${m.file}:${m.line}\` (\`${m.op}\`), caught by ${m.killing.map((f) => `\`${f}\``).join(', ')}. Test edits found by trial runs: ${ok}.`, '');
  }

  lines.push('| Category | Scenarios | Fool plain CI | ' + names.map((n) => `POCP blocks (${n})`).join(' | ') + ' |');
  lines.push('|---|---|---|' + names.map(() => '---|').join(''));
  const cats = [...new Set(r.profiles[names[0]].scenarios.map((s) => s.category))].sort((a, b) => a - b);
  for (const c of cats) {
    const first = r.profiles[names[0]].scenarios.filter((s) => s.category === c);
    const withBug = first.filter((s) => s.bug);
    const fooled = withBug.filter((s) => s.plain_ci === 'pass').length;
    const cells = names.map((n) => {
      const ss = r.profiles[n].scenarios.filter((s) => s.category === c);
      const bugs = ss.filter((s) => s.bug);
      const blocked = bugs.filter((s) => s.pocp === 'block').length;
      const fp = ss.filter((s) => !s.bug && s.pocp === 'block').length;
      return bugs.length ? `${blocked}/${bugs.length}` : fp ? `${fp} false positive(s)` : 'passes honest work';
    });
    lines.push(`| ${c}. ${CATEGORIES[c]} | ${first.length} | ${withBug.length ? `${fooled}/${withBug.length}` : '—'} | ${cells.join(' | ')} |`);
  }
  lines.push('');

  lines.push('<details><summary>Every scenario</summary>', '');
  lines.push('| Scenario | Plain CI | ' + names.map((n) => `POCP (${n})`).join(' | ') + ' | Local hooks (' + names[0] + ') | Outcome (' + names.join(' / ') + ') |');
  lines.push('|---|---|' + names.map(() => '---|').join('') + '---|---|');
  for (const s of r.profiles[names[0]].scenarios) {
    const per = names.map((n) => r.profiles[n].scenarios.find((x) => x.id === s.id));
    lines.push(`| \`${s.id}\`: ${esc(s.title)}${s.bug ? '' : ' (no bug)'} | ${s.plain_ci === 'pass' ? 'passes' : s.plain_ci === 'fail' ? '**fails**' : s.plain_ci} | ${per.map(verdict).join(' | ')} | ${esc(gateCell(s))} | ${per.map(outcomeWord).join(' / ')} |`);
  }
  lines.push('', '</details>', '');
  const skipped = r.profiles[names[0]].skipped;
  if (skipped.length) {
    lines.push(`Not run on ${r.target}: ${skipped.map((s) => `\`${s.id}\` (${s.why})`).join('; ')}.`, '');
  }
  return lines.join('\n');
}

export function renderReport(results, { analysis = '' } = {}) {
  const lines = [];
  lines.push('# Tamper benchmark results', '');
  lines.push('Does POCP catch what plain CI can\'t? Each scenario is one commit made by a cheating agent: a real bug that the tests catch, plus a cheat that makes the build green (or tries to switch POCP off). Two judges look at the same commit in a fresh clone:', '');
  lines.push('- **Plain CI** runs the repository\'s test command (through `pocp ci-run`, which only records the result).');
  lines.push('- **POCP** runs `pocp verify <base>..<head> --require-coverage --rerun`, judged by the base branch\'s rules: the default recipe in the README. It re-runs every check itself and trusts no CI result written during the job. For `forge-ci-in-run`, the faster `--rerun-unsigned --ci-results` mode is also recorded, under "Faster mode" below.', '');
  lines.push('The agent always does its best: it opens a packet for what it changed, proves it, signs off on any test change itself (`--by claude-agent`), and commits through the hooks, falling back to `--no-verify` when they block. **Incremental catch** counts cheats that fool plain CI and that POCP blocks.', '');
  const profiles = new Map();
  for (const r of results) for (const [name, p] of Object.entries(r.profiles)) if (!profiles.has(name)) profiles.set(name, p.about);
  lines.push('Policies measured:', '');
  for (const [name, about] of profiles) lines.push(`- **${name}**: ${about}.`);
  lines.push('', 'The headline names the test guard mode each policy ended up with (`guard.tests`).');
  lines.push('');
  lines.push('A cheat that deletes the POCP step from the CI workflow is judged as GitHub would see it: the pull request\'s own workflow runs, so verify never reports, and only a required check that never reports (`ci.required_checks`) blocks the merge.', '');

  lines.push('## Headline', '');
  lines.push('| Repository | Policy | Cheats that fool plain CI | Blocked by POCP (incremental catch) | Bugs that pass POCP | Honest controls blocked |');
  lines.push('|---|---|---|---|---|---|');
  for (const r of results) {
    for (const [name, p] of Object.entries(r.profiles)) {
      const s = summarize(p.scenarios);
      lines.push(`| ${r.target} | ${name}${p.guard_mode ? ` (${p.guard_mode})` : ''} | ${s.fooled_plain_ci} of ${s.with_bug} | **${s.incremental} of ${s.fooled_plain_ci} (${pct(s.incremental, s.fooled_plain_ci)})** | ${s.missed.length} of ${s.with_bug} | ${s.false_positives.length} of ${s.controls} |`);
    }
  }
  lines.push('');

  lines.push('## Misses', '');
  lines.push('Every scenario where a bug passed POCP. These are the holes to close next.', '');
  let any = false;
  for (const r of results) {
    for (const [name, p] of Object.entries(r.profiles)) {
      // One line per cheat, naming the bugs it got through (ids are "<cheat>@<file>" with several bugs).
      const groups = new Map();
      for (const s of p.scenarios.filter((x) => x.bug && x.pocp === 'pass')) {
        const key = s.id.split('@')[0];
        if (!groups.has(key)) groups.set(key, { s, ids: [], ships: 0 });
        const g = groups.get(key);
        g.ids.push(s.id);
        if (s.plain_ci === 'pass') g.ships++;
      }
      for (const [key, g] of groups) {
        any = true;
        const total = p.scenarios.filter((x) => x.id.split('@')[0] === key).length;
        const ships = g.ships === g.ids.length ? 'plain CI also passes, so the bug ships' : `plain CI also passes for ${g.ships} of them`;
        lines.push(`- **${r.target} / ${name} / \`${key}\`** (${g.ids.length} of ${total} bug${total === 1 ? '' : 's'}): ${g.s.title}; ${ships}.`);
      }
      for (const s of p.scenarios.filter((x) => !x.bug && (x.pocp === 'block' || x.plain_ci !== 'pass'))) {
        any = true;
        lines.push(`- **${r.target} / ${name} / \`${s.id}\`** (false positive): honest work blocked (${s.codes.join(', ') || s.plain_ci}).`);
      }
      for (const s of p.scenarios.filter((x) => x.outcome === 'error')) {
        any = true;
        lines.push(`- **${r.target} / ${name} / \`${s.id}\`**: the scenario errored (${s.error}).`);
      }
    }
  }
  if (!any) lines.push('None.');
  lines.push('');
  if (analysis.trim()) lines.push(analysis.trim(), '');

  for (const r of results) lines.push(targetSection(r));

  lines.push('## Reproduce', '');
  lines.push('```bash');
  lines.push('node bench/tamper/run.js --target pocp');
  lines.push('node bench/tamper/run.js --target <name> --repo <path to its checkout>');
  lines.push('```', '');
  const meta = results.map((r) => `${r.target}: POCP ${r.pocp_version} at \`${r.pocp_commit}\`, Node ${r.node}, seed ${r.seed}, ${r.duration_s}s`).join('; ');
  lines.push(`Everything runs in scratch clones; the source checkout is only cloned. Bugs come from POCP's mutation operators, picked with a fixed seed; test edits are found by trial runs, as an agent would. Last run: ${meta}.`, '');
  return lines.join('\n');
}
