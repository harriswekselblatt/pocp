// The command-line schema: every command, the options it accepts and their types. The parser
// and per-command help are both generated from this table, so an option that is accepted is
// always documented and an option that is documented is always accepted.

export class UsageError extends Error {}

const bool = (desc) => ({ type: 'boolean', desc });
const str = (arg, desc) => ({ type: 'string', arg, desc });
const rep = (arg, desc) => ({ type: 'repeatable', arg, desc });
const num = (arg, desc) => ({ type: 'number', arg, desc });
// An approval: bare (or =true) approves, =false doesn't, =<sha> approves only that head.
const approval = (desc) => ({ type: 'approval', arg: 'sha', desc });

/** Accepted by every command. */
export const GLOBAL_FLAGS = {
  json: bool('machine-readable output'),
  help: bool('show help (-h)'),
  version: bool('print the version (-v, -V)'),
};

/** Accepted by every command that opens the repository. */
export const ENGINE_FLAGS = {
  by: str('who', 'who is acting (default: git user)'),
  host: str('module.js', 'host module adding rules and receiving events (or POCP_HOST)'),
  'no-host': bool('ignore POCP_HOST'),
};

/** Obligations: each adds a check; the modifiers after one apply to it. */
export const OBLIGATION_FLAGS = {
  test: str('cmd', 'add a test obligation'),
  command: str('cmd', 'add a command obligation'),
  probe: str('cmd', 'add a probe obligation'),
  manual: str('text', 'add a manual obligation (a person signs off)'),
};
export const OBLIGATION_MODIFIERS = {
  expect: str('regex', 'after --command: output must match'),
  timeout: num('ms', 'after an obligation: time limit'),
  input: rep('glob', 'after an obligation: files it reads'),
  target: str('url', 'after --probe: what it probes'),
  cwd: str('folder', 'after an obligation: folder it runs in'),
};

const SHORT = { '-h': 'help', '-v': 'version', '-V': 'version' };

/**
 * Every command. `flags`: options it accepts beyond the global ones; `engine`: also takes
 * ENGINE_FLAGS; `obligations`: 'all' for every obligation flag and modifier, or a list of
 * obligation kinds it reads (no modifiers).
 */
export const COMMANDS = {
  help: { summary: 'show help for pocp or one command', usage: ['help [<command>]'], flags: {} },
  version: { summary: 'print the version', usage: ['version'], flags: {} },
  init: {
    summary: 'create .proof/, and optionally the git hooks and GitHub workflows',
    usage: ['init [--hooks] [--github] [--force] [--deep] [--pocp-ref <tag|sha>]'],
    flags: {
      hooks: bool('install the git hooks'),
      github: bool('write the GitHub workflows (verify, the pocp status, approval labels)'),
      force: bool('replace existing hooks and workflow files'),
      deep: bool('test guard plants 10 bugs per test edit (guard.mutants 10); slower'),
      'pocp-ref': str('tag|sha', 'pin the workflows to this POCP release instead of this one'),
    },
  },
  doctor: {
    summary: 'check an adoption: hooks, policy, Action access, labels, branch protection',
    usage: ['doctor [--base <rev>] [--offline]'],
    engine: true,
    flags: { base: str('rev', 'compare against this base revision'), offline: bool("don't query GitHub") },
  },
  approvals: {
    summary: "open PRs whose verify fails only for a maintainer's label, or add that label",
    usage: ['approvals [--repo <owner/repo>]... [--owner <login>]...', 'approvals --approve <owner/repo#n> [--label tests|policy]'],
    flags: {
      repo: rep('owner/repo', 'repository to scan (repeatable)'),
      owner: rep('login', "scan this owner's repositories (repeatable)"),
      approve: str('owner/repo#n', 'show the change, ask, and add the label (interactive)'),
      label: str('tests|policy', 'which approval label to add'),
    },
  },
  'status-report': {
    summary: 'the trusted reporter: set the "pocp" commit status on a pull request\'s head',
    usage: ['status-report --repo <owner/name> (--sha <head> | --pr <n>) [--workflow <path>] [--dry-run]'],
    flags: {
      repo: str('owner/name', 'repository (default GITHUB_REPOSITORY)'),
      sha: str('head', 'head commit (default HEAD_SHA)'),
      pr: num('n', 'pull request number (default PR_NUMBER)'),
      workflow: str('path', 'the workflow whose runs decide the status'),
      'dry-run': bool('say what would be set; write nothing'),
    },
  },
  hooks: {
    summary: 'manage and check the pre-commit, prepare-commit-msg, post-commit hooks',
    usage: ['hooks install|uninstall|status [--force]'],
    flags: { force: bool('install: replace hooks pocp cannot chain') },
  },
  rules: { summary: 'validate .proof/rules.json and .proof/config.json', usage: ['rules check'], engine: true, flags: {} },
  open: {
    summary: 'open a packet: what a change is for, the files it touches, and its checks',
    usage: ['open --intent <text> --touch <path>... [obligations] [--draft]'],
    engine: true,
    obligations: 'all',
    flags: { intent: str('text', 'what the change is for'), touch: rep('path', 'file or glob the packet covers (repeatable)'), draft: bool('open as a draft') },
  },
  add: { summary: 'add obligations to a packet', usage: ['add <packet> [obligations]'], engine: true, obligations: 'all', flags: {} },
  widen: { summary: 'cover more files (re-applies required checks)', usage: ['widen <packet> --touch <path>...'], engine: true, flags: { touch: rep('path', 'file or glob to add (repeatable)') } },
  ready: { summary: 'move a draft packet to open', usage: ['ready <packet>'], engine: true, flags: {} },
  sync: { summary: 'add checks the current rules require', usage: ['sync [<packet>...]'], engine: true, flags: {} },
  prove: {
    summary: 'run the checks of the packets covering the staged files',
    usage: ['prove [<packet>...] [--mode clean|snapshot] [--force] [--only <obl>]... [--no-stage]'],
    engine: true,
    flags: {
      mode: str('clean|snapshot', 'where checks run'),
      force: bool('re-run checks that already have proof'),
      only: rep('obl', 'run only this obligation (repeatable)'),
      'no-stage': bool("don't stage the packet files"),
    },
  },
  attest: { summary: 'sign off a manual or test-guard obligation', usage: ['attest <packet> <obligation> --by <who> [--note <text>]'], engine: true, flags: { note: str('text', 'why') } },
  abandon: { summary: 'abandon a packet', usage: ['abandon <packet> --reason <text>'], engine: true, flags: { reason: str('text', 'why') } },
  show: { summary: 'print a packet in full', usage: ['show <packet>'], engine: true, flags: {} },
  packets: { summary: 'list packets (active only unless --all)', usage: ['packets [--all]'], engine: true, flags: { all: bool('include landed and abandoned packets') } },
  status: { summary: 'subject, staged files, packet progress', usage: ['status'], engine: true, flags: {} },
  fix: {
    summary: 'do what a blocked commit needs: open or widen a packet, add required checks, prove, stage',
    usage: ['fix [--intent <text>] [--test <cmd>] [--mode clean|snapshot]'],
    engine: true,
    obligations: ['test'],
    flags: { intent: str('text', 'what the change is for (for a new packet)'), mode: str('clean|snapshot', 'where checks run') },
  },
  gate: {
    summary: 'decide whether the staged change may be committed',
    usage: ['gate [--prove] [--mode clean|snapshot]'],
    engine: true,
    flags: { prove: bool('run missing checks first'), mode: str('clean|snapshot', 'where checks run') },
  },
  trailer: { summary: 'add Proof-Of-Change trailers (prints them with no file)', usage: ['trailer [<message-file> [<source>]]'], engine: true, flags: {} },
  land: {
    summary: "report which packets a commit's trailers land (writes nothing)",
    usage: ['land [--rev <rev>] [--quiet]'],
    engine: true,
    flags: { rev: str('rev', 'commit to read (default HEAD)'), quiet: bool('print nothing') },
  },
  ci: {
    summary: 'which CI checks must pass to merge (from .proof/config.json "ci")',
    usage: ['ci required [--check | --apply]'],
    engine: true,
    flags: { check: bool("read GitHub's branch protection; exit 1 on any gap"), apply: bool('set them as GitHub branch protection via gh') },
  },
  'ci-run': {
    summary: 'CI: run a command on HEAD and record a result bound to its code',
    usage: ['ci-run [--results <file>] [--dir <folder>] -- <command…>'],
    engine: true,
    flags: { results: str('file', 'results file (default .proof/runs/ci-results.jsonl)'), dir: str('folder', 'folder to run in') },
  },
  'check-edit': { summary: 'for pre-edit hooks: does editing these files need a packet first?', usage: ['check-edit <file>...'], engine: true, flags: {} },
  verify: {
    summary: 'check that commits carry proof for the exact code they contain',
    usage: ['verify [<rev>|<base>..<head>] [options]'],
    engine: true,
    flags: {
      rerun: bool('re-run every check once at the head'),
      'rerun-unsigned': bool('re-run checks whose proof is not signed'),
      'ci-results': rep('file', 'trust passing ci-run results in this file (repeatable)'),
      'require-coverage': bool('every commit that needed a packet must carry one'),
      'policy-from': str('rev', 'read rules and signers from this revision (default: the base)'),
      'allowed-signers': str('file', 'pin the trust root for signed proofs'),
      'accept-test-change': approval('a maintainer approves a test change; =<sha>: only for that head'),
      'accept-policy-change': approval('a maintainer approves a policy loosening; =<sha>: only for that head'),
      'accept-uncovered': approval('commits .proof/exceptions.json lists may lack a packet; =<sha>: only for that head'),
      'accept-inconclusive': approval("a test change whose check didn't finish; =<sha>: only for that head"),
      'exit-detail': bool("exit 4 when only an approval is missing, 5 when something didn't finish"),
      jobs: num('n', 'checks run at once (default: CPU cores - 1, at most 4)'),
    },
  },
  blame: { summary: 'packets that changed a file', usage: ['blame <file>'], engine: true, flags: {} },
  miss: {
    summary: 'record, close and list misses: bugs that got past the checks',
    usage: [
      'miss record --description <text> --stage gate|commit|ci|review|production --file <path>... [--severity low|medium|high|critical] [--check <cmd>] [--packet <id>...]',
      'miss close <id> [--fix <text>] [--replay <escaped-rev>]',
      'miss list',
    ],
    engine: true,
    flags: {
      description: str('text', 'record: what got through'),
      stage: str('stage', 'record: where it was caught (gate|commit|ci|review|production)'),
      severity: str('level', 'record: low|medium|high|critical (default medium)'),
      file: rep('path', 'record: a file involved (repeatable)'),
      check: str('cmd', 'record: a check that fails on the bug'),
      packet: rep('id', 'record: link to this packet (repeatable)'),
      fix: str('text', 'close: what fixed it'),
      replay: str('escaped-rev', 'close: confirm the new rule catches this revision'),
    },
  },
  metrics: { summary: 'catch rate, friction, and the ratchet', usage: ['metrics'], engine: true, flags: {} },
  eval: {
    summary: 'mutation evaluation: plant bugs and see which the checks catch',
    usage: [
      'eval --mutants <n|all> [--seed <n>] [--jobs <n>] [--file <glob>]... [--missed] [--save <file>]',
      'eval --replay <file> [--missed]',
      'eval --corpus <file> [--jobs <n>] [--save <file>]',
    ],
    engine: true,
    flags: {
      mutants: str('n|all', 'how many mutants to plant'),
      seed: num('n', 'random seed (default 1)'),
      jobs: num('n', 'parallel workers'),
      file: rep('glob', 'only mutate these files (repeatable)'),
      missed: bool('list only the mutants the checks missed'),
      save: str('file', 'save the sample'),
      replay: str('file', 're-run a saved sample on the current code'),
      corpus: str('file', 'run mutants made by another tool'),
    },
  },
  history: {
    summary: 'day-one numbers from git history: gate friction, and whether past fixes\' tests catch their bugs',
    usage: ['history [--commits <n>] [--range <a..b>] [--test "<cmd {tests}>"] [--fixes <n>] [--jobs <n>] [--scan <n>]'],
    engine: true,
    obligations: ['test'],
    flags: {
      commits: num('n', 'commits to replay the gate on (default 200)'),
      range: str('a..b', 'replay this range'),
      fixes: num('n', 'fix commits to test (default 30)'),
      jobs: num('n', 'parallel workers'),
      scan: num('n', 'commits to scan for fixes (default 1000)'),
    },
  },
};

/** The options a command accepts, by name, with obligations marked. */
export function flagsFor(cmd) {
  const c = COMMANDS[cmd];
  const out = { ...GLOBAL_FLAGS };
  if (!c) return out;
  if (c.engine) Object.assign(out, ENGINE_FLAGS);
  Object.assign(out, c.flags);
  if (c.obligations === 'all') {
    for (const [k, v] of Object.entries(OBLIGATION_FLAGS)) out[k] = { ...v, obligation: true };
    for (const [k, v] of Object.entries(OBLIGATION_MODIFIERS)) out[k] = { ...v, modifier: true };
  } else if (Array.isArray(c.obligations)) {
    for (const k of c.obligations) out[k] = { ...OBLIGATION_FLAGS[k], obligation: true };
  }
  return out;
}

/** Levenshtein distance, for "did you mean". */
function distance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return d[a.length][b.length];
}

/** The closest name, if it is close enough to be a typo. */
export function suggest(name, names) {
  let best = null;
  let bestD = Infinity;
  for (const n of names) {
    const dd = distance(name, n);
    if (dd < bestD) {
      best = n;
      bestD = dd;
    }
  }
  const limit = Math.max(1, Math.min(3, Math.floor(name.length / 3)));
  if (best && bestD <= limit) return best;
  // A prefix of exactly one option ("--rerun-uns") is also a likely typo.
  const prefixed = names.filter((n) => n.startsWith(name) && name.length >= 3);
  return prefixed.length === 1 ? prefixed[0] : null;
}

const APPROVAL_SHA = /^[0-9a-f]{7,64}$/i;
const valueLike = (t) => t !== undefined && !t.startsWith('--') && !(t in SHORT);

/** The command named on a command line: the first word that is neither an option nor an option's value. */
export function findCommand(argv) {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') return null;
    if (!a.startsWith('-') || a === '-') return a;
    // An option before the command: skip its value if, for every command that has it, it takes one.
    if (a.startsWith('--') && !a.includes('=')) {
      const name = a.slice(2);
      const kinds = [GLOBAL_FLAGS, ENGINE_FLAGS, OBLIGATION_FLAGS, OBLIGATION_MODIFIERS, ...Object.values(COMMANDS).map((c) => c.flags)].map((f) => f[name]).filter(Boolean);
      if (kinds.length && kinds.every((f) => f.type !== 'boolean' && f.type !== 'approval') && valueLike(argv[i + 1])) i++;
    }
  }
  return null;
}

/**
 * Parse a command line against the command's schema. Throws UsageError for an unknown
 * command, an unknown option, a missing or ill-typed value, or a repeated option that takes
 * one value; when --help or --version is also given, those win and nothing is thrown.
 */
export function parseArgs(argv) {
  const cmd = findCommand(argv);
  if (cmd !== null && !COMMANDS[cmd]) {
    const near = suggest(cmd, Object.keys(COMMANDS));
    throw new UsageError(`unknown command "${cmd}"${near ? `; did you mean "${near}"?` : ''} (try "pocp help")`);
  }
  const schema = flagsFor(cmd);
  const positional = [];
  const flags = {};
  const obligations = [];
  const errors = [];
  const where = cmd ? ` for "${cmd}"` : '';
  const tryHelp = cmd ? `pocp help ${cmd}` : 'pocp help';

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (a in SHORT) {
      flags[SHORT[a]] = true;
      continue;
    }
    if (!a.startsWith('-') || a === '-') {
      positional.push(a);
      continue;
    }
    if (!a.startsWith('--')) {
      errors.push(`unknown option "${a}"${where} (try "${tryHelp}")`);
      continue;
    }
    let key = a.slice(2);
    let val;
    const eq = key.indexOf('=');
    if (eq !== -1) {
      val = key.slice(eq + 1);
      key = key.slice(0, eq);
    }
    const spec = schema[key];
    if (!spec) {
      // An approval this version doesn't know must not be dropped silently: the caller would
      // believe something was approved (or waived) when nothing was.
      const approvals = Object.keys(schema).filter((k) => schema[k].type === 'approval');
      if (key.startsWith('accept-') && approvals.length) {
        errors.push(`unknown approval --${key}: this pocp supports ${approvals.map((f) => `--${f}`).join(', ')}`);
      } else {
        const near = suggest(key, Object.keys(schema));
        errors.push(`unknown option "--${key}"${where}${near ? `; did you mean "--${near}"?` : ''} (try "${tryHelp}")`);
      }
      continue; // never takes the next argument as its value
    }
    if (spec.type === 'boolean') {
      if (val !== undefined && val !== 'true' && val !== 'false') {
        errors.push(`--${key} takes no value (got "${val}"; only =true or =false)`);
        continue;
      }
      flags[key] = val !== 'false';
      continue;
    }
    if (spec.type === 'approval') {
      let v;
      if (val === undefined || val === 'true') v = true;
      else if (val === 'false') v = false;
      else if (APPROVAL_SHA.test(val)) v = val;
      else {
        errors.push(`--${key} takes a commit sha (=<sha>, 7 to 64 hex digits), or nothing; got "${val}"`);
        continue;
      }
      // The same approval twice with different values is ambiguous: refuse rather than pick one.
      if (key in flags && flags[key] !== v) {
        errors.push(`--${key} is given more than once with different values (${[flags[key], v].map(String).join(', ')}); give it once`);
        continue;
      }
      flags[key] = v;
      continue;
    }
    if (val === undefined) {
      if (!valueLike(argv[i + 1])) {
        errors.push(`--${key} needs a value${argv[i + 1] !== undefined ? ` (to give one that starts with "-", write --${key}=<value>)` : ''}`);
        continue;
      }
      val = argv[++i];
    }
    if (spec.type === 'number' && !/^\d+$/.test(val)) {
      errors.push(`--${key} needs a whole number, got "${val}"`);
      continue;
    }
    if (spec.obligation) {
      obligations.push(key === 'manual' ? { kind: 'manual', text: val } : { kind: key, run: val });
    } else if (spec.modifier) {
      const last = obligations[obligations.length - 1];
      if (!last) {
        errors.push(`--${key} must follow --test, --command, --probe or --manual`);
        continue;
      }
      if (key === 'expect') last.expect = val;
      else if (key === 'timeout') last.timeout_ms = Number(val);
      else if (key === 'input') last.inputs = [...(last.inputs || []), val];
      else if (key === 'target') last.target = val;
      else if (key === 'cwd') last.cwd = val;
    } else if (spec.type === 'repeatable') {
      flags[key] = [...(flags[key] || []), val];
    } else {
      if (key in flags) {
        errors.push(`--${key} is given more than once; give it once`);
        continue;
      }
      flags[key] = val;
    }
  }
  if (errors.length && !flags.help && !flags.version) {
    const err = new UsageError(errors[0]);
    err.json = Boolean(flags.json);
    throw err;
  }
  return { command: cmd, positional, flags, obligations };
}

/** One command's usage, generated from the schema it is parsed with. */
export function commandHelp(cmd, version) {
  const c = COMMANDS[cmd];
  const schema = flagsFor(cmd);
  const label = (k, f) => {
    if (f.type === 'boolean') return `--${k}`;
    if (f.type === 'approval') return `--${k}[=<${f.arg}>]`;
    return `--${k} <${f.arg}>${f.type === 'repeatable' ? '...' : ''}`;
  };
  const rows = (names) => names.map((k) => [label(k, schema[k]), schema[k].desc]);
  const section = (title, names) => {
    if (!names.length) return [];
    const r = rows(names);
    const w = Math.min(34, Math.max(...r.map(([l]) => l.length)) + 2);
    return ['', `${title}:`, ...r.map(([l, d]) => `  ${l.padEnd(w)}${l.length >= w ? `\n  ${' '.repeat(w)}` : ''}${d}`)];
  };
  const obligationNames = Object.keys(schema).filter((k) => schema[k].obligation || schema[k].modifier);
  return [
    `pocp ${version} ${cmd}: ${c.summary}`,
    '',
    ...c.usage.map((u, i) => `${i ? '       ' : 'Usage: '}pocp ${u}`),
    ...section('Options', Object.keys(c.flags)),
    ...section('Obligations', obligationNames),
    ...section('Repository options', c.engine ? Object.keys(ENGINE_FLAGS) : []),
    ...section('Global options', Object.keys(GLOBAL_FLAGS)),
    '',
  ].join('\n');
}
