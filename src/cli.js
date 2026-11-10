import fs from 'node:fs';
import path from 'node:path';
import { VERSION } from './engine.js';
import { ignoreRepoEnv } from './git.js';
import { COMMANDS, commandHelp, parseArgs, UsageError } from './cli-args.js';
import { createIsolatedRunner } from './isolate.js';

import { EXIT, exitCodeFor, isKnownError } from './errors.js';
import { run as initCommand } from './commands/init.js';
import { run as hooksCommand } from './commands/hooks.js';
import { run as statusReportCommand } from './commands/status-report.js';
import { run as approvalsCommand } from './commands/approvals.js';
import { run as rulesCommand } from './commands/rules.js';
import { run as openCommand } from './commands/open.js';
import { run as addCommand } from './commands/add.js';
import { run as widenCommand } from './commands/widen.js';
import { run as readyCommand } from './commands/ready.js';
import { run as syncCommand } from './commands/sync.js';
import { run as proveCommand } from './commands/prove.js';
import { run as attestCommand } from './commands/attest.js';
import { run as abandonCommand } from './commands/abandon.js';
import { run as showCommand } from './commands/show.js';
import { run as packetsCommand } from './commands/packets.js';
import { run as statusCommand } from './commands/status.js';
import { run as fixCommand } from './commands/fix.js';
import { run as doctorCommand } from './commands/doctor.js';
import { run as gateCommand } from './commands/gate.js';
import { run as ciRunCommand } from './commands/ci-run.js';
import { run as ciCommand } from './commands/ci.js';
import { run as checkEditCommand } from './commands/check-edit.js';
import { run as trailerCommand } from './commands/trailer.js';
import { run as landCommand } from './commands/land.js';
import { run as verifyCommand } from './commands/verify.js';
import { run as blameCommand } from './commands/blame.js';
import { run as missCommand } from './commands/miss.js';
import { run as metricsCommand } from './commands/metrics.js';
import { run as evalCommand } from './commands/eval.js';
import { run as historyCommand } from './commands/history.js';
import { buildEngine, errWrite, localizeCommands, out, shellJoin } from './cli/shared.js';

export { localizeCommands, shellJoin };

const EARLY_COMMANDS = {
  'init': initCommand,
  'hooks': hooksCommand,
  'status-report': statusReportCommand,
  'approvals': approvalsCommand,
};
const COMMAND_HANDLERS = {
  'rules': rulesCommand,
  'open': openCommand,
  'add': addCommand,
  'widen': widenCommand,
  'ready': readyCommand,
  'sync': syncCommand,
  'prove': proveCommand,
  'attest': attestCommand,
  'abandon': abandonCommand,
  'show': showCommand,
  'packets': packetsCommand,
  'status': statusCommand,
  'fix': fixCommand,
  'doctor': doctorCommand,
  'gate': gateCommand,
  'ci-run': ciRunCommand,
  'ci': ciCommand,
  'check-edit': checkEditCommand,
  'trailer': trailerCommand,
  'land': landCommand,
  'verify': verifyCommand,
  'blame': blameCommand,
  'miss': missCommand,
  'metrics': metricsCommand,
  'eval': evalCommand,
  'history': historyCommand,
};

export { EXIT };

export { parseArgs };

const HELP = `pocp ${VERSION}: Proof of Change Protocol

Usage: pocp <command> [options]   (every command accepts --json)
       pocp help <command>         one command's options (or: pocp <command> --help)
       pocp --version              print the version (also -v, -V, pocp version)

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
                                     --isolate: each check runs as a fresh unprivileged user (Linux, sudo); if
                                     that can't be set up, verify fails. --install <cmd>: dependencies too
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

export async function main(argv = process.argv.slice(2)) {
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    // --json asks for machine-readable errors too, even when the command line itself is wrong.
    const before = argv.includes('--') ? argv.slice(0, argv.indexOf('--')) : argv;
    if (err.json || before.includes('--json') || before.includes('--json=true')) out(true, { ok: false, error: err.message });
    else errWrite(`pocp: ${err.message}\n`);
    return EXIT.usage;
  }
  const { positional, flags, obligations } = parsed;
  const json = Boolean(flags.json);
  const [cmd, ...rest] = positional;

  // Help and version need no repository: they run before anything looks for one.
  if (flags.version || cmd === 'version') {
    out(json, { version: VERSION }, `pocp ${VERSION}`);
    return EXIT.ok;
  }
  if (cmd === 'help' && rest[0] && rest[0] !== 'help') {
    if (!COMMANDS[rest[0]]) {
      const message = `unknown command "${rest[0]}" (try "pocp help")`;
      if (json) out(true, { ok: false, error: message });
      else errWrite(`pocp: ${message}\n`);
      return EXIT.usage;
    }
    process.stdout.write(commandHelp(rest[0], VERSION));
    return EXIT.ok;
  }
  if (flags.help && cmd && cmd !== 'help') {
    process.stdout.write(commandHelp(cmd, VERSION));
    return EXIT.ok;
  }
  if (!cmd || cmd === 'help' || flags.help) {
    process.stdout.write(HELP);
    // No command at all is a usage error (exit 2); asking for help is not.
    return cmd || flags.help ? EXIT.ok : EXIT.usage;
  }

  // verify judges the repository it runs in, never one GIT_DIR or GIT_WORK_TREE points to.
  if (cmd === 'verify') ignoreRepoEnv();

  try {
    // Commands that need no engine (and, for init, no .proof/ yet).
    if (EARLY_COMMANDS[cmd]) return await EARLY_COMMANDS[cmd]({ cmd, rest, flags, json, obligations });

    // verify --isolate: the pull request's code runs only as separate unprivileged users
    // (src/isolate.js). Without it, checks run as this user: the cooperative runner.
    if (flags.install && !(cmd === 'verify' && flags.isolate)) throw new UsageError('--install needs verify --isolate (without isolation, install dependencies before running pocp)');
    const isolated = cmd === 'verify' && flags.isolate ? createIsolatedRunner() : null;
    const engine = await buildEngine(flags, { runner: isolated || undefined });

    // POCP only acts where a checkout has adopted it. Git hooks are shared by every checkout
    // of a repository, so a branch that set POCP up must not affect checkouts that haven't:
    // without .proof/rules.json, the commands hooks call do nothing and succeed.
    if (['gate', 'trailer', 'land', 'check-edit', 'fix'].includes(cmd) && !fs.existsSync(path.join(engine.root, '.proof', 'rules.json'))) {
      if (json) out(true, { ok: true, adopted: false, note: 'POCP is not set up in this checkout (no .proof/rules.json); nothing to check' });
      else if (cmd === 'gate' || cmd === 'check-edit') errWrite('pocp: not set up in this checkout (no .proof/rules.json); nothing to check\n');
      return EXIT.ok;
    }

    const handler = COMMAND_HANDLERS[cmd];
    if (!handler) throw new UsageError(`unknown command "${cmd}" (try "pocp help")`);
    return await handler({ cmd, rest, flags, json, obligations, engine, isolated });
  } catch (err) {
    // The exit code comes from the error's category (src/errors.js). An isolation failure is
    // blocked (exit 1): a failed verify, never a wait or an inconclusive result.
    const known = isKnownError(err);
    const code = exitCodeFor(err);
    if (json) out(true, { ok: false, error: err.message, details: err.details });
    else {
      errWrite(`pocp: ${err.message}\n`);
      if (err.details?.problems) for (const p of err.details.problems) errWrite(`  ${p.detail}: ${(p.files || []).join(', ')}\n`);
      if (err.code === 'clean_mode_refused') errWrite('  next: pocp fix (proves a snapshot of exactly what is staged), or pocp prove --mode snapshot\n');
      if (!known && process.env.POCP_DEBUG) errWrite(`${err.stack}\n`);
    }
    return code;
  }
}
