import fs from 'node:fs';
import path from 'node:path';
import { createPocp, PocpError, VERSION } from './engine.js';
import { computeMetrics } from './metrics.js';
import { runMutantEval } from './mutants.js';
import { replayFixes, simulateGate } from './history.js';
import { applyGithubProtection, checkGithubProtection, requiredChecksPlan } from './ci-github.js';
import { formatLayout, hooksHealth, initProofDir, installHooks, uninstallHooks, writeGithubWorkflows } from './init.js';
import { loadHost } from './host.js';
import { ValidationError, describeObligation } from './obligations.js';
import { ruleWarnings, validateRules } from './rules.js';
import { validateConfig, withDefaults } from './store.js';
import { GitError, git, ignoreRepoEnv, resolveRev } from './git.js';
import { shortDigest } from './hash.js';
import { CiResultsError, readCiResults } from './ci-results.js';
import { DONT_REWRITE, remedyLines, verifyRemedy } from './remedies.js';
import { formatFix, runFix } from './fix.js';
import { formatDoctor, runDoctor } from './doctor.js';
import { githubClient, reportStatus, STATUS_CONTEXT } from './status-report.js';
import { ApprovalsError, approvalAnnotation, approvalSummary, approvePr, formatApprovals, listApprovals, VERIFY_EXIT } from './approvals.js';

export const EXIT = { ok: 0, blocked: 1, usage: 2, internal: 3 };

const BOOLEAN_FLAGS = new Set(['dry-run', 'github', 'offline', 'apply', 'check', 'accept-test-change', 'accept-policy-change', 'accept-inconclusive', 'accept-uncovered', 'exit-detail', 'rerun-unsigned', 'missed', 'json', 'hooks', 'force', 'prove', 'draft', 'rerun', 'require-coverage', 'quiet', 'all', 'no-stage', 'help', 'no-host', 'deep']);
const APPROVAL_FLAGS = new Set(['accept-test-change', 'accept-policy-change', 'accept-uncovered', 'accept-inconclusive']);
const OBLIGATION_FLAGS = new Set(['test', 'command', 'probe', 'manual']);
const OBLIGATION_MODIFIERS = new Set(['expect', 'timeout', 'input', 'target', 'cwd']);

class UsageError extends Error {}

export function parseArgs(argv) {
  const positional = [];
  const flags = {};
  const obligations = [];
  const push = (k, v) => {
    if (flags[k] === undefined) flags[k] = v;
    else flags[k] = [].concat(flags[k], v);
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (!a.startsWith('--')) {
      positional.push(a);
      continue;
    }
    let key = a.slice(2);
    let val;
    const eq = key.indexOf('=');
    if (eq !== -1) {
      val = key.slice(eq + 1);
      key = key.slice(0, eq);
    }
    // An approval this version doesn't know must not be dropped silently: the caller would
    // believe something was approved (or waived) when nothing was.
    if (key.startsWith('accept-') && !BOOLEAN_FLAGS.has(key)) {
      throw new UsageError(`unknown approval --${key}: this pocp supports ${[...APPROVAL_FLAGS].map((f) => `--${f}`).join(', ')}`);
    }
    if (BOOLEAN_FLAGS.has(key)) {
      // An approval may name the commit it was given for: --accept-test-change=<sha>.
      if (APPROVAL_FLAGS.has(key) && val !== undefined && val !== 'true' && val !== 'false') push(key, val);
      else push(key, val === undefined ? true : val !== 'false');
      continue;
    }
    if (val === undefined) {
      if (i + 1 >= argv.length) throw new UsageError(`--${key} needs a value`);
      val = argv[++i];
    }
    if (OBLIGATION_FLAGS.has(key)) {
      obligations.push(key === 'manual' ? { kind: 'manual', text: val } : { kind: key, run: val });
    } else if (OBLIGATION_MODIFIERS.has(key)) {
      const last = obligations[obligations.length - 1];
      if (!last) throw new UsageError(`--${key} must follow --test, --command, --probe or --manual`);
      if (key === 'expect') last.expect = val;
      else if (key === 'timeout') last.timeout_ms = Number(val);
      else if (key === 'input') last.inputs = [...(last.inputs || []), val];
      else if (key === 'target') last.target = val;
      else if (key === 'cwd') last.cwd = val;
    } else {
      push(key, val);
    }
  }
  return { positional, flags, obligations };
}

const list = (v) => (v === undefined ? [] : [].concat(v));

const HELP = `pocp ${VERSION}: Proof of Change Protocol

Usage: pocp <command> [options]   (every command accepts --json)

Setup
  init [--hooks] [--github] [--force] create .proof/; --hooks installs git hooks; --github writes the
                                     GitHub workflows (verify, the pocp status, approval labels),
                                     pinned to this release (--pocp-ref <tag|sha> to pin another)
  doctor [--base <rev>] [--offline]  check an adoption: hooks, policy, Action access, labels,
                                     branch protection, and what the adoption PR carries
  approvals [--repo <owner/repo>]... [--owner <login>]...
                                     open PRs, across your repositories, whose verify fails only
                                     for a maintainer's label, with what each label approves
  approvals --approve <owner/repo#n> [--label tests|policy]
                                     for a person at a terminal: show the change, ask, add the label
  status-report --repo <owner/name> (--sha <head> | --pr <n>) [--workflow <path>] [--dry-run]
                                     the trusted reporter: set the "pocp" commit status on a pull
                                     request's head (runs in a privileged workflow; docs/STATUS.md)
  hooks install|uninstall|status     manage and check the pre-commit, prepare-commit-msg, post-commit hooks
  rules check                        validate .proof/rules.json and .proof/config.json

Packets
  open --intent <text> --touch <path>... [obligations] [--draft]
  add <packet> [obligations]         add obligations to a packet
  widen <packet> --touch <path>...   cover more files (re-applies required checks)
  ready <packet>                     move a draft packet to open
  sync [<packet>...]                 add checks the current rules require
  prove [<packet>...] [--mode clean|snapshot] [--force] [--only <obl>]... [--no-stage]
  attest <packet> <obligation> --by <who> [--note <text>]
  abandon <packet> --reason <text>
  show <packet>                      full packet
  packets [--all]                    list packets (active only unless --all)
  status                             subject, staged files, packet progress
  fix [--intent <text>] [--test <cmd>] [--mode clean|snapshot]
                                     do what a blocked commit needs (open or widen a packet, add
                                     required checks, prove, stage); says what is left and who does it

  obligations:  --test <cmd>  --command <cmd> [--expect <regex>]  --probe <cmd> [--target <url>]
                --manual <text>   modifiers after each: --timeout <ms>  --input <glob>  --cwd <folder>

Commit time
  gate [--prove] [--mode clean|snapshot]   decide whether the staged change may be committed
  trailer [<message-file> [<source>]]  add Proof-Of-Change trailers (prints them with no file)
  land [--rev <rev>] [--quiet]       report which packets a commit's trailers land (writes nothing)

Checking
  ci required [--check | --apply]    which CI checks must pass to merge (from .proof/config.json "ci");
                                     --check reads GitHub's branch protection and exits 1 on any gap;
                                     --apply sets them as GitHub branch protection via gh
                                     (schema-validated, not yet tested against the live API)
  ci-run [--results <file>] [--dir <folder>] -- <command…>
                                     CI: run a command on HEAD and record a result bound to its code;
                                     exits with the command's exit code (default file .proof/runs/ci-results.jsonl)
  check-edit <file>...               for pre-edit hooks: does editing these files need a packet first?
  verify [<rev>|<base>..<head>] [--rerun | --rerun-unsigned] [--ci-results <file>]... [--require-coverage]
                                     ranges re-run once at the head; --ci-results trusts the job that wrote it:
                                     checks with a passing ci-run result for the same code are not run again
                                     rules and signers come from the base (--policy-from <rev>); loosening fails
                                     unless --accept-policy-change; --allowed-signers <file> pins the trust root
                                     --accept-policy-change=<sha> / --accept-test-change=<sha>: only for that head
                                     --accept-uncovered=<sha>: commits .proof/exceptions.json lists (commit + exact
                                     files) may lack a packet; shown as UNPROVEN warnings; only for that head
                                     --accept-inconclusive=<sha>: a test change whose check didn't finish (timed
                                     out, killed); --accept-test-change doesn't cover that; only for that head
                                     --exit-detail: exit 4 when only an approval is missing, 5 when something
                                     didn't finish (re-run it), 1 for any other failure
  blame <file>                       packets that changed a file

Misses
  miss record --description <text> --stage gate|commit|ci|review|production --file <path>...
              [--severity low|medium|high|critical] [--check <cmd>] [--packet <id>...]
  miss close <id> [--fix <text>] [--replay <escaped-rev>]
  miss list

Measuring
  history [--commits <n>] [--range <a..b>] [--test "<cmd {tests}>"] [--fixes <n>] [--jobs <n>]
                                     day-one numbers from git history: gate friction, and whether
                                     past fixes' tests catch the bugs they fixed (no .proof/ needed)
  metrics
  eval --mutants <n|all> [--seed <n>] [--jobs <n>] [--file <glob>]... [--missed] [--save <file>]
  eval --replay <file> [--missed]    re-run a saved sample (all of it, or only its survivors) on the current code
  eval --corpus <file> [--jobs <n>] [--save <file>]   run mutants made by another tool (e.g. StrykerJS) through the same checks

Host integration: set POCP_HOST=<module.js> (or --host) to add rules and receive events.
Exit codes: 0 ok, 1 blocked or failed check, 2 usage/config error, 3 internal error.
`;

/**
 * The command `ci-run` runs and records. One argument is used as written (a shell command
 * line); several are joined, quoting any that the shell would otherwise split or expand, so
 * `ci-run -- sh -c "make test"` runs and records `sh -c 'make test'`.
 */
export function shellJoin(args) {
  if (args.length === 1) return args[0];
  return args.map((a) => (/^[A-Za-z0-9_\-+=.,/:@%^]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`)).join(' ');
}

function out(json, data, human) {
  if (json) process.stdout.write(`${JSON.stringify({ pocp: 1, ...data }, null, 2)}\n`);
  else if (human) process.stdout.write(`${human}\n`);
}

/** Why each guard obligation still needs a sign-off: what the mechanical check found. */
function guardLines(ev, id, indent) {
  return (ev.guard || [])
    .filter((x) => ev.unattested.includes(x.id))
    .map((x) => `${indent}${x.id} (test guard): ${x.detail || x.status}. If this is intended, a person signs off: pocp attest ${id} ${x.id} --by <you>`);
}

function evalLine(ev) {
  const parts = [`proven ${ev.counts.proven}/${ev.counts.runnable}`];
  if (ev.counts.manual) parts.push(`attested ${ev.counts.attested}/${ev.counts.manual}`);
  if (ev.failed.length) parts.push(`failed: ${ev.failed.join(', ')}`);
  if (ev.missing_required.length) parts.push(`missing required: ${ev.missing_required.map((m) => m.id).join(', ')}`);
  return parts.join(' · ');
}

function formatGate(r) {
  const lines = [];
  if (r.decision === 'pass') {
    const proven = r.packets.filter((p) => p.evaluation.ok).length;
    lines.push(r.required_files.length ? `pocp: gate passed (${proven} packet(s) proven for ${shortDigest(r.subject)})` : `pocp: gate passed (no packet needed for ${r.files.length} file(s))`);
    for (const w of (r.warnings || []).filter((x) => !x.code?.startsWith('awaiting_'))) lines.push(`  note: ${w.detail}`);
    if (r.pending_approvals?.length) {
      lines.push('  CI will need a person for this commit:');
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
function writeGithubSummary(result, rows, commitProblems, ms, { annotations = true } = {}) {
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
  if (result.approval?.only) lines.push('', `Waiting only for a maintainer: ${result.approval.needs.map((n) => `\`${n.label}\``).join(' and ')} (see \`pocp approvals\`).`);
  const reruns = [...(result.reruns || []), ...(result.net?.reruns || [])];
  if (reruns.length) {
    lines.push('', '| Check | Result |', '|---|---|', ...reruns.map((x) => `| \`${esc(x.run)}\` | ${esc(x.status)}${x.duration_ms !== undefined ? ` (${x.duration_ms}ms)` : ''} |`));
  }
  try {
    fs.appendFileSync(file, `${lines.join('\n')}\n`);
  } catch { /* summary is best effort */ }
}

function evidenceSummary(evidence) {
  const counts = {};
  for (const v of Object.values(evidence)) {
    const k = v.split(':')[0];
    counts[k] = (counts[k] || 0) + 1;
  }
  return Object.entries(counts).map(([k, n]) => `${n} ${k}`).join(', ');
}

/** What a failed --apply means, in full: the branch is unchanged, POCP itself still works. */
function applyFailureMessage(r, plan) {
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


async function buildEngine(flags) {
  const hostSpec = flags['no-host'] ? null : flags.host || process.env.POCP_HOST;
  const host = await loadHost(hostSpec);
  return createPocp({
    cwd: process.cwd(),
    by: flags.by,
    policy: host?.policy,
    events: host?.events,
    hostName: host?.name,
  });
}

export async function main(argv = process.argv.slice(2)) {
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`pocp: ${err.message}\n`);
    return EXIT.usage;
  }
  const { positional, flags, obligations } = parsed;
  const json = Boolean(flags.json);
  const [cmd, ...rest] = positional;

  if (!cmd || cmd === 'help' || flags.help) {
    process.stdout.write(HELP);
    return cmd || flags.help ? EXIT.ok : EXIT.usage;
  }
  if (cmd === 'version' || cmd === '--version') {
    out(json, { version: VERSION }, VERSION);
    return EXIT.ok;
  }

  // verify judges the repository it runs in, never one GIT_DIR or GIT_WORK_TREE points to.
  if (cmd === 'verify') ignoreRepoEnv();

  try {
    switch (cmd) {
      case 'init': {
        const r = initProofDir(process.cwd(), { deep: Boolean(flags.deep) });
        let hooks = null;
        if (flags.hooks) hooks = installHooks(process.cwd(), { force: flags.force });
        const github = flags.github ? writeGithubWorkflows(process.cwd(), { ref: flags['pocp-ref'] || undefined, force: flags.force }) : null;
        out(json, { created: r.created, hooks, test_layout: r.layout, ...(github ? { github } : {}) }, [
          r.created.length ? `created ${r.created.join(', ')}` : '.proof/ already set up',
          ...(r.config_created ? [flags.deep
            ? 'test guard: deep (guard.mutants 10): test edits are also checked with 10 planted bugs; slower'
            : 'test guard: fast (guard.mutants 0): a test edit passes on its own only if it adds lines to existing tests; anything else goes to a person. "pocp init --deep" or guard.mutants 10 adds planted bugs'] : []),
          // The layout on a first init, or when it needs something done; quiet otherwise.
          ...(r.config_created || r.layout.extra.length || r.layout.uncovered.length ? formatLayout(r.layout, { written: r.layout_written }) : []),
          hooks?.refused ? `hooks not installed: ${hooks.refused}` : hooks ? `hooks installed in ${hooks.dir}` : 'hooks not installed (run "pocp hooks install")',
          ...(hooks?.chained || []).map((n) => `${n}: chained (the existing hook is now ${n}.pre-pocp and runs first)`),
          ...(hooks?.warnings || []).map((w) => `warning: ${w}`),
          ...(github ? [
            github.written.length ? `wrote ${github.written.join(', ')} (POCP actions pinned to ${github.ref})` : 'GitHub workflows already present',
            ...github.skipped.map((f) => `kept ${f} (exists; --force replaces it)`),
            'next: commit them, create the labels (pocp doctor lists them), and see docs/STATUS.md to require the "pocp" status',
          ] : []),
        ].join('\n'));
        return hooks?.refused ? EXIT.usage : EXIT.ok;
      }
      case 'hooks': {
        const sub = rest[0];
        if (sub === 'install') {
          const r = installHooks(process.cwd(), { force: flags.force });
          out(json, r, r.refused ? `hooks not installed: ${r.refused}` : [`hooks installed in ${r.dir}`, ...(r.chained || []).map((n) => `${n}: chained (the existing hook is now ${n}.pre-pocp and runs first)`), ...r.warnings.map((w) => `warning: ${w}`)].join('\n'));
          return r.refused ? EXIT.usage : EXIT.ok;
        }
        if (sub === 'status') {
          const h = hooksHealth(process.cwd());
          out(json, h, [...Object.entries(h.hooks).map(([k, v]) => `${k}: ${v}`), ...h.problems.map((p) => `warning: ${p}`)].join('\n'));
          return h.problems.length ? EXIT.blocked : EXIT.ok;
        }
        if (sub === 'uninstall') {
          const r = uninstallHooks(process.cwd());
          out(json, r, r.removed.length ? `removed pocp from ${r.removed.length} hook(s)` : 'no pocp hooks found');
          return EXIT.ok;
        }
        throw new UsageError('usage: pocp hooks install|uninstall|status');
      }
    }

    if (cmd === 'status-report') {
      // The trusted reporter (docs/STATUS.md): run from the default branch in a privileged
      // workflow, never on a pull request's code. Reads .proof/config.json here for ci.files.
      const repository = flags.repo || process.env.GITHUB_REPOSITORY;
      const sha = flags.sha || process.env.HEAD_SHA || null;
      const prNumber = Number(flags.pr || process.env.PR_NUMBER) || null;
      if (!repository || (!sha && !prNumber)) throw new UsageError('usage: pocp status-report --repo <owner/name> (--sha <head> | --pr <n>) [--workflow <path>] [--dry-run] [--json]');
      const cfgFile = path.join(process.cwd(), '.proof', 'config.json');
      const baseConfig = fs.existsSync(cfgFile) ? withDefaults(JSON.parse(fs.readFileSync(cfgFile, 'utf8'))) : null;
      const gh = githubClient({ token: process.env.GH_TOKEN || process.env.GITHUB_TOKEN });
      const r = await reportStatus(gh, { repository, sha, prNumber, baseConfig, workflowPath: flags.workflow || undefined, dryRun: Boolean(flags['dry-run']) });
      const d = r.decision;
      out(json, r, d.write ? `${r.written ? 'set' : 'would set'} ${STATUS_CONTEXT} on ${d.sha.slice(0, 12)}: ${d.state} (${d.description}); ${d.reason}` : `nothing written: ${d.reason}`);
      return EXIT.ok;
    }

    if (cmd === 'approvals') {
      if (flags.approve !== undefined) {
        if (json) throw new UsageError('--approve is interactive and has no --json form');
        const tty = Boolean(process.stdin.isTTY && process.stdout.isTTY) && !process.env.CI;
        const rl = tty ? (await import('node:readline/promises')).createInterface({ input: process.stdin, output: process.stdout }) : null;
        try {
          const r = await approvePr({
            ref: flags.approve === true ? rest[0] : flags.approve,
            repo: list(flags.repo)[0],
            label: flags.label,
            interactive: tty,
            ask: (q) => rl.question(q),
            say: (line) => process.stdout.write(`${line}\n`),
          });
          return r.approved.length || !r.skipped.length ? EXIT.ok : EXIT.blocked;
        } finally {
          rl?.close();
        }
      }
      const r = listApprovals({ repos: list(flags.repo), owners: list(flags.owner) });
      out(json, r, formatApprovals(r));
      return EXIT.ok;
    }

    const engine = await buildEngine(flags);

    // POCP only acts where a checkout has adopted it. Git hooks are shared by every checkout
    // of a repository, so a branch that set POCP up must not affect checkouts that haven't:
    // without .proof/rules.json, the commands hooks call do nothing and succeed.
    if (['gate', 'trailer', 'land', 'check-edit', 'fix'].includes(cmd) && !fs.existsSync(path.join(engine.root, '.proof', 'rules.json'))) {
      if (json) out(true, { ok: true, adopted: false, note: 'POCP is not set up in this checkout (no .proof/rules.json); nothing to check' });
      else if (cmd === 'gate' || cmd === 'check-edit') process.stderr.write('pocp: not set up in this checkout (no .proof/rules.json); nothing to check\n');
      return EXIT.ok;
    }

    switch (cmd) {
      case 'rules': {
        if (rest[0] !== 'check') throw new UsageError('usage: pocp rules check');
        const problems = [
          ...validateRules(engine.store.readRawRules() || {}),
          ...validateConfig(engine.config()).map((p) => `config: ${p}`),
        ];
        const warnings = ruleWarnings(engine.rules(), engine.root);
        out(json, { ok: problems.length === 0, problems, warnings }, [
          ...(problems.length ? problems.map((p) => `rules: ${p}`) : ['rules: ok']),
          ...warnings.map((w) => `warning: ${w}`),
        ].join('\n'));
        return problems.length ? EXIT.usage : EXIT.ok;
      }
      case 'open': {
        if (!flags.intent) throw new UsageError('pocp open needs --intent');
        const touches = list(flags.touch);
        if (!touches.length) throw new UsageError('pocp open needs at least one --touch');
        const r = await engine.open({ intent: flags.intent, touches, obligations, draft: Boolean(flags.draft), by: flags.by });
        out(json, { packet: r.packet, required_added: r.required_added.map((o) => o.id) }, [
          `opened ${r.packet.id}: ${r.packet.intent}`,
          ...r.packet.obligations.map((o) => `  ${o.id} [${o.source}] ${describeObligation(o)}`),
          r.packet.obligations.length ? `next: pocp prove ${r.packet.id}` : `next: add a check, e.g. pocp add ${r.packet.id} --test "<command>"`,
        ].join('\n'));
        return EXIT.ok;
      }
      case 'add': {
        if (!rest[0] || !obligations.length) throw new UsageError('usage: pocp add <packet> --test <cmd> | --command <cmd> | --probe <cmd> | --manual <text>');
        const added = [];
        let packet;
        for (const spec of obligations) {
          const r = await engine.addObligation(rest[0], spec, { by: flags.by });
          added.push(r.obligation);
          packet = r.packet;
        }
        out(json, { packet, added }, added.map((o) => `added ${o.id} to ${packet.id}: ${describeObligation(o)}`).join('\n'));
        return EXIT.ok;
      }
      case 'widen': {
        if (!rest[0] || !list(flags.touch).length) throw new UsageError('usage: pocp widen <packet> --touch <path>...');
        const r = await engine.widen(rest[0], list(flags.touch), { by: flags.by });
        out(json, { packet: r.packet, added: r.added, required_added: r.required_added.map((o) => o.id) },
          `${r.packet.id} now covers ${r.packet.touches.length} path(s)${r.required_added.length ? `; required checks added: ${r.required_added.map((o) => o.id).join(', ')}` : ''}`);
        return EXIT.ok;
      }
      case 'ready': {
        if (!rest[0]) throw new UsageError('usage: pocp ready <packet>');
        const p = engine.ready(rest[0]);
        out(json, { packet: p }, `${p.id} is open`);
        return EXIT.ok;
      }
      case 'sync': {
        const r = await engine.sync(rest);
        out(json, { packets: r }, r.map((x) => `${x.id}: ${x.added.length ? `added ${x.added.join(', ')}` : 'up to date'}`).join('\n') || 'no active packets');
        return EXIT.ok;
      }
      case 'prove': {
        const r = await engine.prove({ ids: rest, mode: flags.mode, force: Boolean(flags.force), only: list(flags.only), stage: !flags['no-stage'] });
        // Exit 1 only when a check failed or a run was thrown away; pending sign-offs are not failures.
        const anyFail = r.packets.some((p) => p.evaluation.failed.length || p.runs.some((x) => x.discarded));
        const human = r.packets.length === 0
          ? 'nothing to prove: no active packets cover the staged files'
          : [
              `subject ${shortDigest(r.subject)} (${r.mode} mode)`,
              ...r.packets.flatMap((p) => [
                `${p.id}: ${p.state} · ${evalLine(p.evaluation)}`,
                ...p.runs.map((x) => `  ${x.obligation}: ${x.skipped ? `skipped (${x.skipped})` : x.discarded ? `DISCARDED (${x.discarded.join('; ')})` : x.guard ? `test guard ${x.passed ? 'pass' : x.guard} (${x.duration_ms}ms): ${x.summary}` : x.passed ? `pass (${x.duration_ms}ms)` : `FAIL exit=${x.exit}${x.timed_out ? ' timed out' : ''} · log .proof/runs/${x.run_id}.log`}`),
                ...(() => {
                  const guardIds = (p.evaluation.guard || []).map((x) => x.id);
                  const plain = p.evaluation.unattested.filter((x) => !guardIds.includes(x));
                  return [
                    ...(plain.length ? [`  needs sign-off: ${plain.join(', ')}  →  pocp attest ${p.id} <obligation> --by <you>`] : []),
                    ...guardLines(p.evaluation, p.id, '  needs sign-off: '),
                  ];
                })(),
              ]),
            ].join('\n');
        out(json, r, anyFail ? `${human}\n  next: fix the code (not the tests), stage it, and run "pocp fix" (it won't re-run a check that already failed on the same code)` : human);
        return anyFail ? EXIT.blocked : EXIT.ok;
      }
      case 'attest': {
        if (!rest[0] || !rest[1]) throw new UsageError('usage: pocp attest <packet> <obligation> --by <who> [--note <text>]');
        if (!flags.by) throw new UsageError('pocp attest needs --by (who is attesting)');
        const r = engine.attest(rest[0], rest[1], { by: flags.by, note: flags.note });
        out(json, r, `${r.attestation.obligation} attested by ${r.attestation.by} for ${shortDigest(r.attestation.subject)}`);
        return EXIT.ok;
      }
      case 'abandon': {
        if (!rest[0] || !flags.reason) throw new UsageError('usage: pocp abandon <packet> --reason <text>');
        const p = engine.abandon(rest[0], flags.reason, { by: flags.by });
        out(json, { packet: p }, `${p.id} abandoned`);
        return EXIT.ok;
      }
      case 'show': {
        if (!rest[0]) throw new UsageError('usage: pocp show <packet>');
        const p = engine.loadPacket(rest[0]);
        out(json, { packet: p }, JSON.stringify(p, null, 2));
        return EXIT.ok;
      }
      case 'packets': {
        const ps = flags.all ? engine.allPackets() : engine.activePackets();
        out(json, { packets: ps.map((p) => ({ id: p.id, state: p.state, intent: p.intent, opened_at: p.opened_at })) },
          ps.map((p) => `${p.id}  ${p.state.padEnd(9)} ${p.intent}`).join('\n') || 'no packets');
        return EXIT.ok;
      }
      case 'status': {
        const s = await engine.status();
        s.hooks = hooksHealth(process.cwd());
        const human = [
          ...s.hooks.problems.map((p) => `warning: ${p}`),
          `subject ${shortDigest(s.subject)} · ${s.staged.length} staged file(s)`,
          ...s.packets.map((p) => `${p.id} ${p.state}: ${p.intent}\n  ${evalLine(p.evaluation)}`),
          s.packets.length ? null : 'no active packets',
          ...s.rules_problems.map((p) => `rules: ${p}`),
        ].filter(Boolean).join('\n');
        out(json, s, human);
        return EXIT.ok;
      }
      case 'fix': {
        const r = await runFix(engine, { intent: flags.intent, test: obligations.find((o) => o.kind === 'test')?.run, mode: flags.mode, actor: engine.actor });
        if (json) out(true, { ...r, gate: { decision: r.gate.decision, subject: r.gate.subject } });
        else process[r.ok ? 'stdout' : 'stderr'].write(`${formatFix(r)}\n`);
        return r.ok ? EXIT.ok : EXIT.blocked;
      }
      case 'doctor': {
        const r = await runDoctor(engine, { base: flags.base, offline: Boolean(flags.offline) });
        out(json, r, formatDoctor(r));
        return r.ok ? EXIT.ok : EXIT.blocked;
      }
      case 'gate': {
        // The pre-commit hook sets POCP_GATE_SOURCE=hook. Drop it so checks don't inherit it.
        const source = process.env.POCP_GATE_SOURCE === 'hook' ? 'hook' : 'gate';
        delete process.env.POCP_GATE_SOURCE;
        const r = await engine.gate({ prove: Boolean(flags.prove), mode: flags.mode, source });
        if (json) out(true, r);
        else process[r.decision === 'pass' ? 'stdout' : 'stderr'].write(`${formatGate(r)}\n`);
        return r.decision === 'pass' ? EXIT.ok : r.decision === 'error' ? EXIT.usage : EXIT.blocked;
      }
      case 'ci-run': {
        const command = shellJoin(rest).trim();
        if (!command) throw new UsageError('usage: pocp ci-run [--results <file>] -- <command…>');
        const rec = await engine.ciRun(command, { cwd: flags.dir });
        const file = flags.results || path.join(engine.store.runsDir?.() || '.proof/runs', 'ci-results.jsonl');
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.appendFileSync(file, `${JSON.stringify(rec)}\n`);
        out(json, { result: rec, file }, `ci-run: ${rec.passed ? 'passed' : 'FAILED'} (exit ${rec.exit}) for ${rec.commit.slice(0, 12)} · recorded in ${file}`);
        return rec.passed ? EXIT.ok : (Number.isInteger(rec.exit) && rec.exit > 0 ? rec.exit : EXIT.blocked);
      }
      case 'ci': {
        if (rest[0] !== 'required') throw new UsageError('usage: pocp ci required [--check | --apply]');
        const plan = requiredChecksPlan(engine.root, engine.config());
        plan.github = (await import('./ci-github.js')).protectionPayload(null, plan).payload;
        if (flags.check) {
          // Read-only. A pull request can remove POCP from its own workflow; only a required
          // check that never reports blocks that merge.
          const r = checkGithubProtection(engine.root, plan);
          const where = r.repo ? `${r.repo}@${r.branch}` : r.branch;
          const human = r.error
            ? `could not read branch protection for ${where}: ${r.error}`
            : r.ok
              ? `${where} enforces the plan: ${plan.required_checks.join(', ')} must pass before a merge`
              : [`${where} does not enforce the plan:`, ...r.gaps.map((x) => `  - ${x}`), '  A pull request that drops POCP from its workflow can merge. Fix with: pocp ci required --apply (or in Settings → Branches)'].join('\n');
          out(json, { plan, result: r }, human);
          return r.ok ? EXIT.ok : r.error ? EXIT.usage : EXIT.blocked;
        }
        if (!flags.apply) {
          out(json, { plan }, [
            `branch ${plan.branch}: ${plan.require_pull_request ? 'changes arrive through pull requests' : 'direct pushes allowed'}${plan.enforce_admins ? ', admins included' : ''}`,
            plan.required_checks.length ? `required checks: ${plan.required_checks.join(', ')}` : 'required checks: none configured (set ci.required_checks in .proof/config.json). Until the job that runs pocp verify is required, a pull request that removes it from the workflow merges anyway.',
            'apply on GitHub with: pocp ci required --apply; check it with: pocp ci required --check   (other hosts: configure the same checks in their branch settings)',
          ].join('\n'));
          return EXIT.ok;
        }
        const r = applyGithubProtection(engine.root, plan);
        const human = r.ok
          ? [
              `branch protection set on ${r.repo}@${r.branch}${r.was_protected ? ' (existing protection kept)' : ''}`,
              `  added required checks: ${r.added_checks.join(', ') || 'none (already required)'}`,
              ...(r.kept_checks.length ? [`  also still required (set elsewhere): ${r.kept_checks.join(', ')}`] : []),
            ].join('\n')
          : applyFailureMessage(r, plan);
        out(json, { plan, result: r }, human);
        return r.ok ? EXIT.ok : r.refused ? EXIT.usage : EXIT.blocked;
      }
      case 'check-edit': {
        if (!rest.length) throw new UsageError('usage: pocp check-edit <file>...');
        const r = await engine.checkEdit(rest);
        if (json) out(true, r);
        else if (r.ok) out(false, r, r.protected.length ? `ok: covered by an open packet (${r.protected.join(', ')})` : 'ok: not protected');
        else process.stderr.write(`pocp: open a packet before editing ${r.uncovered.join(', ')}\n  why: the rules protect these files, so a change to them must say what it is for and carry its proof\n  next: ${r.suggestion.command}\n  (or edit, stage, and run "pocp fix --intent <what the change does>" before committing)\n`);
        return r.ok ? EXIT.ok : EXIT.blocked;
      }
      case 'trailer': {
        if (rest[0]) {
          if (!fs.existsSync(rest[0])) throw new UsageError(`no such message file: ${rest[0]}`);
          const lines = await engine.addTrailersToFile(rest[0], { source: rest[1] });
          out(json, { trailers: lines }, null);
        } else {
          const lines = await engine.trailers();
          out(json, { trailers: lines }, lines.map((l) => `Proof-Of-Change: ${l}`).join('\n'));
        }
        return EXIT.ok;
      }
      case 'land': {
        const r = engine.land({ rev: flags.rev || 'HEAD' });
        if (!flags.quiet || json) out(json, r, r.landed.length ? `landed ${r.landed.join(', ')} in ${r.commit.slice(0, 12)}` : 'no packets landed in this commit');
        return EXIT.ok;
      }
      case 'verify': {
        const started = Date.now();
        let ignoredCi = 0;
        const ciResults = list(flags['ci-results']).flatMap((file) => {
          const r = readCiResults(file, { root: engine.root });
          ignoredCi += r.ignored;
          return r.records;
        });
        if (ignoredCi) process.stderr.write(`pocp: ignored ${ignoredCi} CI result(s) recorded by a different CI run\n`);
        if (ciResults.length) process.stderr.write('pocp: trusting CI results from --ci-results: anything that ran earlier in this job could have written them (docs/THREAT-MODEL.md)\n');
        // An approval that names a commit covers only that head: a later push needs a new one.
        const headRev = rest[0] && rest[0].includes('..') ? rest[0].split(/\.\.\.?/)[1] || 'HEAD' : rest[0] || 'HEAD';
        const approval = (name) => {
          const v = [].concat(flags[name] ?? false).pop();
          if (typeof v !== 'string') return Boolean(v);
          const head = resolveRev(engine.root, headRev);
          const given = /^[0-9a-f]{7,64}$/i.test(v) ? git(engine.root, ['rev-parse', '--verify', '--quiet', `${v}^{commit}`], { allowFail: true }) : null;
          if (given === head) return true;
          process.stderr.write(`pocp: approval for ${v} does not cover ${head.slice(0, 12)}, the head being verified: a push after the approval needs a new one (--${name})\n`);
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
        };
        const rerunLines = (reruns) => reruns.map((x) => `  rerun ${x.status.padEnd(8)} ${x.run}${x.duration_ms !== undefined ? ` (${x.duration_ms}ms)` : ''}${x.kind === 'guard' && x.summary ? `: ${x.summary}` : ''}`);
        const nextSteps = (rows2) => {
          const seen = new Map();
          for (const c of rows2) for (const f of (c.findings || []).filter((x) => x.blocking)) if (!seen.has(f.code)) seen.set(f.code, { code: f.code, ...verifyRemedy(f.code, f.detail) });
          // A re-run that ran and failed outranks one that only timed out, for what to do next.
          const reruns = (result?.rerun_failures || []).filter((x) => x.blocking !== false);
          const worst = reruns.find((x) => !x.unfinished) || reruns[0];
          if (worst && !seen.has('rerun_failed')) seen.set('rerun_failed', { code: 'rerun_failed', ...verifyRemedy('rerun_failed', worst.detail || worst.problem) });
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
            ...rerunLines([...result.reruns, ...(result.net?.reruns || [])]),
            ...(result.ok ? [] : nextSteps([...rows, { findings: rangeFindings(result) }])),
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
            ...rerunLines(result.reruns),
            ...(result.ok ? [] : nextSteps([result])),
          ].join('\n');
        }
        if (!result.ok) result.approval = approvalSummary([...rows.flatMap((c) => c.findings || []), ...rangeFindings(result)], (result.rerun_failures || []).filter((x) => x.blocking !== false));
        writeGithubSummary(result, rows, commitProblems, Date.now() - started, { annotations: !json });
        out(json, result, human);
        if (result.ok) return EXIT.ok;
        // --exit-detail: 4 when only a maintainer's approval is missing, 5 when something didn't
        // finish (re-run, or approve with --accept-inconclusive); every other failure stays 1.
        if (flags['exit-detail'] && result.approval?.outcome in VERIFY_EXIT) return VERIFY_EXIT[result.approval.outcome];
        return EXIT.blocked;
      }
      case 'blame': {
        if (!rest[0]) throw new UsageError('usage: pocp blame <file>');
        const r = engine.blame(rest[0]);
        out(json, { file: rest[0], commits: r }, r.map((c) => `${c.commit.slice(0, 12)}  ${c.packets.join(', ')}`).join('\n') || 'no packets have changed this file');
        return EXIT.ok;
      }
      case 'miss': {
        const sub = rest[0];
        if (sub === 'record') {
          const m = engine.recordMiss({
            description: flags.description,
            stage: flags.stage,
            severity: flags.severity || 'medium',
            files: list(flags.file),
            failing_check: flags.check || null,
            packets: flags.packet ? list(flags.packet) : undefined,
            by: flags.by,
          });
          out(json, { miss: m }, `recorded ${m.id}${m.packets.length ? ` (linked to ${m.packets.join(', ')})` : ''}\nnext: add a rule with "source": "miss:${m.id}" to .proof/rules.json, then pocp miss close ${m.id}`);
          return EXIT.ok;
        }
        if (sub === 'close') {
          if (!rest[1]) throw new UsageError('usage: pocp miss close <id> [--fix <text>] [--replay <rev>]');
          const m = await engine.closeMiss(rest[1], { fix: flags.fix, replay: flags.replay, by: flags.by });
          out(json, { miss: m }, `${m.id} closed (${m.closed}) by rule(s) ${m.rules.join(', ')}`);
          return EXIT.ok;
        }
        if (sub === 'list') {
          const ms = engine.store.readMisses();
          out(json, { misses: ms }, ms.map((m) => `${m.id}  ${m.state.padEnd(6)} ${m.stage.padEnd(10)} ${m.description}`).join('\n') || 'no misses');
          return EXIT.ok;
        }
        throw new UsageError('usage: pocp miss record|close|list');
      }
      case 'metrics': {
        const m = computeMetrics({
          packets: engine.allPackets(),
          misses: engine.store.readMisses(),
          rules: engine.rules(),
          gateLog: engine.store.readLog?.('gate') || [],
        });
        const pct = (x) => (x === null ? 'n/a' : `${Math.round(x * 100)}%`);
        out(json, m, [
          `packets: ${m.packets.total} (${Object.entries(m.packets.by_state).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'})`,
          `catch rate: ${pct(m.catch_rate)} · escaped: ${m.escaped} · escapes per 100 landed: ${m.escape_rate_per_100 ?? 'n/a'}`,
          `proven share: ${pct(m.proven_share)} · friction: ${pct(m.friction)} · median proof cost: ${m.cost_ms_median ?? 'n/a'}ms`,
          `ratchet: ${m.ratchet.rules_from_misses} rule(s) from misses · closed ${m.ratchet.misses_closed_rule_added} rule-added, ${m.ratchet.misses_closed_replay_confirmed} replay-confirmed · open ${m.ratchet.misses_open}`,
        ].join('\n'));
        return EXIT.ok;
      }
      case 'eval': {
        let replay;
        if (flags.replay) {
          if (!fs.existsSync(flags.replay)) throw new UsageError(`no such eval file: ${flags.replay}`);
          const saved = JSON.parse(fs.readFileSync(flags.replay, 'utf8'));
          // --missed: the survivors, and the mutants that weren't measured (a check timed out or
          // couldn't run), by outcome, since older saves marked timeouts caught.
          replay = (saved.mutants || []).filter((m) => m.line_text !== undefined && (!flags.missed || m.caught === false || m.outcome === 'timeout' || m.outcome === 'error'));
        }
        let corpus;
        if (flags.corpus) {
          if (!fs.existsSync(flags.corpus)) throw new UsageError(`no such corpus file: ${flags.corpus}`);
          const saved = JSON.parse(fs.readFileSync(flags.corpus, 'utf8'));
          corpus = Array.isArray(saved) ? saved : saved.mutants;
          if (!Array.isArray(corpus) || !corpus.length) throw new UsageError(`corpus has no mutants: ${flags.corpus}`);
        }
        const n = flags.mutants === 'all' ? 'all' : Number(flags.mutants);
        if (!replay && !corpus && n !== 'all' && (!Number.isInteger(n) || n <= 0)) throw new UsageError('usage: pocp eval --mutants <n|all> [--seed <n>] [--jobs <n>] [--file <glob>]... [--missed] [--save <file>] | --replay <file> [--missed]');
        const r = await runMutantEval(engine, { count: n, seed: Number(flags.seed || 1), files: list(flags.file), jobs: flags.jobs ? Number(flags.jobs) : undefined, replay, corpus });
        if (flags.save && r.ok) fs.writeFileSync(flags.save, `${JSON.stringify(r, null, 2)}\n`);
        // Not-measured mutants are always listed: they are the gap in the score.
        const shown = r.ok ? r.mutants.filter((m) => m.outcome !== 'gone' && (!flags.missed || !m.caught)) : [];
        const unmeasured = r.ok && r.not_measured ? ` · ${r.not_measured} not measured (${[r.timeouts ? `${r.timeouts} timed out` : '', r.errors ? `${r.errors} couldn't run` : ''].filter(Boolean).join(', ')}), not scored` : '';
        const tag = (m) => (m.caught ? 'caught ' : m.caught === null ? 'NOT MEASURED' : 'MISSED ');
        out(json, r, r.ok
          ? [
              `mutation eval${r.replayed ? ' (replayed sample)' : r.corpus ? ' (corpus)' : ''}: caught ${r.caught}/${r.total} (${Math.round((r.catch_rate || 0) * 100)}%)${unmeasured}${r.replayed || r.corpus ? (r.gone ? ` · ${r.gone} no longer apply` : '') : ` of ${r.sites} sites`} · ${r.jobs} workers · ${Math.round(r.duration_ms / 1000)}s${flags.save ? ` · saved to ${flags.save}` : ''}`,
              ...shown.map((m) => `  ${tag(m)} ${m.file}:${m.line} ${m.operator}${m.caught_by ? ` by ${m.caught_by}` : m.not_measured ? `: ${m.not_measured.map((x) => `${x.check} ${x.reason}`).join(', ')}` : `\n      - ${m.before}\n      + ${m.after}`}`),
            ].join('\n')
          : `mutation eval: ${r.error}`);
        return r.ok ? EXIT.ok : EXIT.blocked;
      }
      case 'history': {
        const limit = Number(flags.commits || 200);
        const sim = simulateGate(engine, { range: flags.range, limit });
        let fixes = null;
        const testCmd = obligations.find((o) => o.kind === 'test')?.run;
        if (testCmd) {
          fixes = await replayFixes(engine, { range: flags.range, limit: Number(flags.scan || 1000), maxFixes: Number(flags.fixes || 30), test: testCmd, jobs: flags.jobs ? Number(flags.jobs) : undefined });
        }
        const pct = (x) => (x === null ? 'n/a' : `${Math.round(x * 100)}%`);
        const human = [
          `gate replay: ${sim.would_need_packet} of the last ${sim.commits} commits would have needed a packet (${pct(sim.share)})`,
          `  reasons: ${Object.entries(sim.reasons).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}`,
          ...(fixes
            ? [
                `fix replay: ${fixes.fixes} past fix commits came with tests`,
                `  confirmed ${fixes.confirmed} (their test fails on the old code and passes on the fix)`,
                `  does not detect ${fixes.does_not_detect} · fails on the fix itself ${fixes.fails_on_fix} · errors ${fixes.errors}`,
                ...fixes.results.map((r) => `  ${r.verdict.padEnd(15)} ${r.commit.slice(0, 10)} ${r.subject.slice(0, 70)}`),
              ]
            : ['fix replay: skipped (pass --test "<command>", with {tests} for the fix\'s test files)']),
        ].join('\n');
        out(json, { gate: sim, fixes }, human);
        return EXIT.ok;
      }
      default:
        throw new UsageError(`unknown command "${cmd}" (try "pocp help")`);
    }
  } catch (err) {
    const usage = err instanceof UsageError || err instanceof ValidationError || err instanceof CiResultsError || err instanceof ApprovalsError;
    const known = usage || err instanceof PocpError || err instanceof GitError || err?.name === 'StoreError';
    const code = usage ? EXIT.usage : err instanceof PocpError ? EXIT.blocked : known ? EXIT.usage : EXIT.internal;
    if (json) out(true, { ok: false, error: err.message, details: err.details });
    else {
      process.stderr.write(`pocp: ${err.message}\n`);
      if (err.details?.problems) for (const p of err.details.problems) process.stderr.write(`  ${p.detail}: ${(p.files || []).join(', ')}\n`);
      if (/clean mode refused/.test(err.message)) process.stderr.write('  next: pocp fix (proves a snapshot of exactly what is staged), or pocp prove --mode snapshot\n');
      if (!known && process.env.POCP_DEBUG) process.stderr.write(`${err.stack}\n`);
    }
    return code;
  }
}
