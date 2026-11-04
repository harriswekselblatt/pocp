import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { configuredHooksPath, git, hooksDir, PROOF_DIR, repoRoot } from './git.js';
import { matchGlob } from './glob.js';
import { DEFAULT_EVAL_EXCLUDE } from './mutants.js';
import { DEFAULT_RULES } from './store.js';
import { DEFAULT_GUARD_MUTANTS } from './guard.js';

export const HOOK_BEGIN = '# >>> pocp >>>';
export const HOOK_END = '# <<< pocp <<<';

// Marks a hook that pocp wrote whole, chaining to the hook that was there before.
export const CHAIN_MARK = '# pocp: chained hook';
// Where a chained hook's original goes.
export const ORIGINAL_SUFFIX = '.pre-pocp';
// How to install pocp: from the repository at a pinned commit (the npm name isn't pocp's).
// Single-quoted so it can be copied into a shell as is, and stays intact inside the hooks' echo "...".
export const INSTALL_HINT = "npm i -D 'github:harriswekselblatt/pocp#COMMIT_SHA'";

// The pocp that is running now. Hooks remember it, so a commit still finds pocp when it isn't
// in the project's node_modules or on PATH (for example, run once with npx or from a checkout).
export const SELF_BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'pocp.js');

const shQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

// pocp_run runs pocp, or calls pocp_missing (defined per hook) when it can't be found. The
// project's own pinned copy comes before one on PATH; the pocp that installed the hooks is last.
function runner(known) {
  const fallback = known ? `\n  elif [ -x ${shQuote(known)} ]; then ${shQuote(known)} "$@"` : '';
  return `pocp_run() {
  if [ -n "$POCP_BIN" ]; then $POCP_BIN "$@"
  elif [ -x ./node_modules/.bin/pocp ]; then ./node_modules/.bin/pocp "$@"
  elif command -v pocp >/dev/null 2>&1; then pocp "$@"${fallback}
  else pocp_missing
  fi
}`;
}

/** The pocp path a hook remembers from install time, or null. */
export function recordedBin(hookText) {
  const m = /elif \[ -x '((?:[^']|'\\'')+)' \]; then/.exec(String(hookText || ''));
  return m ? m[1].replace(/'\\''/g, "'") : null;
}

const NOT_FOUND = `pocp: not found (install it with ${INSTALL_HINT}, or set POCP_BIN)`;

// pre-commit is the gate, so it fails closed. prepare-commit-msg and post-commit also run
// under "git commit --no-verify"; they only add trailers and record landings, so without pocp
// they warn and let the commit through. CI's "pocp verify --require-coverage" still flags a
// commit that needed proof and has none.
export function hookBodies(known = SELF_BIN) {
  const RUNNER = runner(known);
  return {
    'pre-commit': `${RUNNER}\npocp_missing() { echo "${NOT_FOUND}; this commit can't be checked, so it is blocked. To commit without the check once: git commit --no-verify (CI's pocp verify still checks it)" >&2; return 1; }\nexport POCP_GATE_SOURCE=hook\npocp_run gate || exit $?`,
    'prepare-commit-msg': `${RUNNER}\npocp_missing() { echo "${NOT_FOUND}; warning: committing without proof trailers. CI's pocp verify will flag this commit if it needed proof" >&2; return 0; }\ncase "$2" in merge|squash) ;; *) pocp_run trailer "$1" "$2" || exit $? ;; esac`,
    'post-commit': `${RUNNER}\npocp_missing() { echo "${NOT_FOUND}; warning: this commit's landing was not recorded" >&2; return 0; }\npocp_run land --quiet || true`,
  };
}
export const HOOKS = hookBodies();

function block(body) {
  return `${HOOK_BEGIN}\n# Installed by pocp. Edit outside these markers; "pocp hooks uninstall" removes this block.\n${body}\n${HOOK_END}\n`;
}

/**
 * A hook pocp owns whole: it runs the original hook (moved to <name>.pre-pocp) first, so its
 * formatters and checks see the commit first and a failure still stops it, then pocp's step.
 * post-commit can't stop anything, so there both always run.
 */
function chainedHook(name, body) {
  const original = name === 'post-commit'
    ? 'if [ -x "$pocp_original" ]; then "$pocp_original" "$@"; fi'
    : 'if [ -x "$pocp_original" ]; then "$pocp_original" "$@" || exit $?; fi';
  return [
    '#!/bin/sh',
    HOOK_BEGIN,
    `# Installed by pocp. The hook that was here is now ${name}${ORIGINAL_SUFFIX}: it runs first, then pocp.`,
    '# "pocp hooks uninstall" puts it back.',
    CHAIN_MARK,
    `pocp_original="$(dirname "$0")/${name}${ORIGINAL_SUFFIX}"`,
    original,
    body,
    HOOK_END,
    '',
  ].join('\n');
}

const SH_SHEBANG = /^#!\s*(?:\/usr\/bin\/env\s+(?:-S\s+)?)?(?:\/\S*\/)?(?:sh|bash|dash|zsh|ksh)(?:\s|$)/;
const codeLines = (text) => text.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');

/** The interpreter a hook's shebang names, or null for sh-compatible hooks (and no shebang). */
export function nonShellInterpreter(text) {
  const first = String(text || '').split('\n')[0];
  if (!first.startsWith('#!') || SH_SHEBANG.test(first)) return null;
  const words = first.slice(2).trim().split(/\s+/);
  const prog = words[0]?.endsWith('/env') ? words.find((w, i) => i > 0 && !w.startsWith('-')) : words[0];
  return (prog || first.slice(2).trim()).split('/').pop() || 'unknown';
}

/**
 * Why pocp's block, appended to this (sh) hook, would never run: an `exec` that replaces the
 * shell, or an unconditional top-level `exit`. Null when it would run. Redirections such as
 * `exec 1>&2` don't replace the shell.
 */
export function unreachableReason(text) {
  const code = codeLines(String(text || ''));
  const ex = /(?:^|[;&|]\s*|\b(?:then|else|do)\s+)exec\s+(?!\d*[<>])([^\s<>;&|]+)/m.exec(code);
  if (ex) return `it ends by running "exec ${ex[1]}"`;
  if (/^exit\b/m.test(code)) return 'it calls "exit" at the top level';
  return null;
}

/** Would appending pocp's block to this existing hook be unsafe? Then it is chained instead. */
function mustChain(text) {
  if (nonShellInterpreter(text)) return true;
  const code = codeLines(text);
  return /\bexec\b/.test(code) || /^\s*exit\b/m.test(code);
}

function stripBlock(text) {
  const start = text.indexOf(HOOK_BEGIN);
  if (start === -1) return text;
  const end = text.indexOf(HOOK_END, start);
  if (end === -1) return text;
  return text.slice(0, start) + text.slice(end + HOOK_END.length).replace(/^\n/, '');
}

// Ecosystems pocp init looks for: a marker file, and the extensions of its code.
const ECOSYSTEMS = [
  { lang: 'JavaScript/TypeScript', marker: /(^|\/)package\.json$/, ext: /\.(m?[jt]sx?|c[jt]s)$/ },
  { lang: 'Python', marker: /(^|\/)(pyproject\.toml|setup\.py|setup\.cfg|pytest\.ini|\.pytest\.ini|tox\.ini|requirements[^/]*\.txt)$/, ext: /\.py$/ },
  { lang: 'Ruby', marker: /(^|\/)(Gemfile|\.rspec|[^/]+\.gemspec)$/, ext: /\.rb$/ },
  { lang: 'Go', marker: /(^|\/)go\.mod$/, ext: /\.go$/ },
  { lang: 'Rust', marker: /(^|\/)Cargo\.toml$/, ext: /\.rs$/ },
  { lang: 'Java/Kotlin', marker: /(^|\/)(pom\.xml|build\.gradle(\.kts)?|settings\.gradle(\.kts)?|build\.sbt)$/, ext: /\.(java|kt|kts|scala|groovy)$/ },
  { lang: 'C#', marker: /\.(csproj|sln|fsproj)$/, ext: /\.(cs|fs)$/ },
  { lang: 'PHP', marker: /(^|\/)composer\.json$/, ext: /\.php$/ },
];
// A file named like a test, in any language: a.test.js, test_a.py, AThing_spec.rb, FooTest.java.
const TEST_NAME = /(^|[._-])(tests?|specs?)([._-][^/]*)?\.\w+$|^(tests?|specs?)[._-]|(Tests?|Spec|IT|Suite)\.\w+$/;

const SOURCE_DIRS = /^(src|lib|app|apps|source|sources|pkg|packages|internal|cmd|main)$/;

/** Folders a runner config declares as where its tests live (pytest testpaths, jest roots, ...). */
function declaredTestDirs(root, files) {
  const out = new Map(); // dir → where it was declared
  const read = (rel) => {
    try { return fs.readFileSync(path.join(root, rel), 'utf8'); } catch { return ''; }
  };
  const add = (dir, from, base = '') => {
    const clean = String(dir).replace(/^<rootDir>\/?/, '').replace(/^\.\//, '').replace(/\/+$/, '').replace(/\/\*.*$/, '');
    if (!clean || clean === '.' || clean.startsWith('/') || clean.split('/').includes('..') || /[*?{}[\]]/.test(clean)) return;
    const full = base ? `${base}/${clean}` : clean;
    // Runners also search source folders for co-located tests (jest roots: ["src"]); those
    // hold the code, so they are not test folders.
    if (SOURCE_DIRS.test(path.posix.basename(full))) return;
    if (files.some((f) => f.startsWith(`${full}/`))) out.set(full, from);
  };
  for (const rel of files) {
    const base = path.posix.dirname(rel) === '.' ? '' : path.posix.dirname(rel);
    const name = path.posix.basename(rel);
    if (name === 'pyproject.toml' || name === 'pytest.ini' || name === '.pytest.ini' || name === 'setup.cfg' || name === 'tox.ini') {
      const m = /^\s*testpaths\s*=\s*(\[[^\]]*\]|[^\n]+(?:\n[ \t]+[^\n]+)*)/m.exec(read(rel));
      if (m) for (const d of m[1].replace(/[[\]"',]/g, ' ').split(/\s+/).filter(Boolean)) add(d, `${rel} testpaths`, base);
    } else if (name === 'package.json') {
      let pkg = {};
      try { pkg = JSON.parse(read(rel)); } catch { /* not JSON */ }
      for (const d of pkg.jest?.roots || []) add(d, `${rel} jest.roots`, base);
      const test = pkg.scripts?.test || '';
      for (const tok of test.split(/\s+/)) if (/^[\w.-]+\/?$/.test(tok) && !/^(node|npm|npx|jest|vitest|mocha|ava|tap|run|test)$/.test(tok) && fs.existsSync(path.join(root, base, tok)) && fs.statSync(path.join(root, base, tok)).isDirectory()) add(tok, `${rel} scripts.test`, base);
    } else if (/^\.mocharc\.(json|ya?ml|c?js)$/.test(name)) {
      const m = /["']?spec["']?\s*[:=]\s*\[?\s*["']([^"'*]+)/.exec(read(rel));
      if (m) add(path.posix.dirname(m[1]) === '.' ? m[1] : m[1].split('/')[0], `${rel} spec`, base);
    } else if (name === '.rspec') {
      const m = /--default-path[ =](\S+)/.exec(read(rel));
      if (m) add(m[1], `${rel} --default-path`, base);
    } else if (/^phpunit(\.dist)?\.xml(\.dist)?$/.test(name)) {
      for (const m of read(rel).matchAll(/<directory[^>]*>([^<]+)<\/directory>/g)) add(m[1].trim(), `${rel} testsuite`, base);
    } else if (name === 'pom.xml') {
      const m = /<testSourceDirectory>([^<]+)<\/testSourceDirectory>/.exec(read(rel));
      if (m) add(m[1].replace(/^\$\{(project\.)?basedir\}\//, ''), `${rel} testSourceDirectory`, base);
    } else if (name === 'Cargo.toml') {
      for (const m of read(rel).matchAll(/\[\[test\]\][^[]*?\bpath\s*=\s*"([^"]+)"/g)) add(path.posix.dirname(m[1]), `${rel} [[test]]`, base);
    }
  }
  return out;
}

/**
 * Where this repository's tests are, per ecosystem, and which of them the default test
 * patterns don't cover. Returns { ecosystems: [{ lang, globs: [{ glob, files }] }], extra,
 * uncovered } where `extra` are globs to add to guard.extra_test_globs and `uncovered` are
 * test-named files nothing covers (listed for a person to check).
 */
export function detectTestLayout(cwd) {
  const root = repoRoot(cwd);
  const files = (git(root, ['ls-files', '-co', '--exclude-standard', '-z'], { trim: false, allowFail: true }) || '')
    .split('\0').filter((f) => f && !f.startsWith(`${PROOF_DIR}/`) && !f.split('/').includes('node_modules'));
  const covered = (f, globs) => globs.some((gl) => matchGlob(f, gl));
  const declared = declaredTestDirs(root, files);
  const extra = [...declared.keys()].filter((d) => !files.filter((f) => f.startsWith(`${d}/`)).every((f) => covered(f, DEFAULT_EVAL_EXCLUDE))).map((d) => `${d}/**`);
  const all = [...DEFAULT_EVAL_EXCLUDE, ...extra];
  const ecosystems = [];
  for (const eco of ECOSYSTEMS) {
    const code = files.filter((f) => eco.ext.test(f));
    if (!code.length && !files.some((f) => eco.marker.test(f))) continue;
    const counts = new Map();
    for (const f of code) {
      const glob = [...extra, ...DEFAULT_EVAL_EXCLUDE].find((gl) => matchGlob(f, gl));
      if (glob) counts.set(glob, (counts.get(glob) || 0) + 1);
    }
    if (!code.length) continue;
    ecosystems.push({ lang: eco.lang, globs: [...counts].sort((a, b) => b[1] - a[1]).map(([glob, n]) => ({ glob, files: n })) });
  }
  const uncovered = files.filter((f) => ECOSYSTEMS.some((e) => e.ext.test(f)) && TEST_NAME.test(path.posix.basename(f)) && !covered(f, all));
  return { ecosystems, extra, declared: Object.fromEntries(declared), uncovered };
}

/** Human lines describing a detected layout. */
export function formatLayout(layout, { written = false } = {}) {
  const lines = [];
  if (!layout.ecosystems.length) lines.push('test layout: no tests found yet; the default test patterns apply (see guard.extra_test_globs to add your own)');
  for (const e of layout.ecosystems) {
    lines.push(`test layout: ${e.lang}: ${e.globs.length ? e.globs.slice(0, 4).map((x) => `${x.glob} (${x.files})`).join(', ') : 'no test files found'}`);
  }
  if (layout.extra.length) {
    lines.push(`${written ? 'added to' : 'not covered by the defaults; add to'} guard.extra_test_globs in .proof/config.json: ${layout.extra.join(', ')}`);
  }
  if (layout.uncovered.length) {
    lines.push(`named like tests but not covered by any test pattern (add them to guard.extra_test_globs if they are tests): ${layout.uncovered.slice(0, 6).join(', ')}${layout.uncovered.length > 6 ? ' …' : ''}`);
  }
  return lines;
}

/** Create `.proof/` with default config and rules. Existing files are left alone. */
/**
 * Set up .proof/. New projects get the fast test guard: no planted bugs (guard.mutants 0),
 * written into config.json so the choice is explicit. `deep` writes the planted-bug check
 * instead (guard.mutants 10). Projects set up before this kept the built-in default of 10,
 * which still applies when guard.mutants is absent, so an upgrade never turns deep mode off.
 */
export function initProofDir(cwd, { deep = false } = {}) {
  const root = repoRoot(cwd);
  const layout = detectTestLayout(root);
  const dir = path.join(root, PROOF_DIR);
  const created = [];
  fs.mkdirSync(path.join(dir, 'packets'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'misses'), { recursive: true });
  const write = (rel, content) => {
    const full = path.join(dir, rel);
    if (!fs.existsSync(full)) {
      fs.writeFileSync(full, content);
      created.push(`${PROOF_DIR}/${rel}`);
    }
  };
  const config = { pocp: 1, packet_ttl_days: 14, run: { mode: 'clean', timeout_ms: 600000, env: 'inherit' }, snapshot: { link: ['node_modules'] } };
  config.guard = { mutants: deep ? DEFAULT_GUARD_MUTANTS : 0 };
  if (layout.extra.length) {
    Object.assign(config.guard, {
      extra_test_globs: layout.extra,
      _note: `pocp init found tests the default patterns miss (${Object.entries(layout.declared).map(([d, from]) => `${d}/ from ${from}`).join('; ')}). Edit extra_test_globs to adjust.`,
    });
  }
  const configWritten = !fs.existsSync(path.join(dir, 'config.json'));
  write('config.json', `${JSON.stringify(config, null, 2)}\n`);
  write('rules.json', `${JSON.stringify(DEFAULT_RULES, null, 2)}\n`);
  write('.gitignore', 'runs/\n');
  write('packets/.gitkeep', '');
  write('misses/.gitkeep', '');
  return { root, created, layout, layout_written: configWritten && layout.extra.length > 0, config_created: configWritten };
}

/**
 * Install the pre-commit, prepare-commit-msg and post-commit hooks. Existing hooks are kept.
 * A plain sh hook gets the pocp block appended (or replaced if already there). A hook in
 * another language (node, python), or one that uses `exec` or `exit` (so an appended block
 * might never run), is chained instead: it moves to <hook>.pre-pocp and a pocp hook runs it,
 * then pocp. Hooks installed by older versions that appended to such a hook are repaired.
 * Refuses when core.hooksPath is set, unless `force`, since that folder may be shared.
 */
export function installHooks(cwd, { force = false, bin = SELF_BIN } = {}) {
  const root = repoRoot(cwd);
  const custom = configuredHooksPath(root);
  if (custom && !force) {
    return { installed: [], refused: `core.hooksPath is set to "${custom}", which may be shared by other repos. Re-run with --force to install there anyway.` };
  }
  const dir = hooksDir(root);
  fs.mkdirSync(dir, { recursive: true });
  const installed = [];
  const warnings = [];
  const chained = [];
  for (const [name, body] of Object.entries(hookBodies(bin))) {
    const file = path.join(dir, name);
    const original = `${file}${ORIGINAL_SUFFIX}`;
    const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
    if (existing !== null && existing.includes(CHAIN_MARK)) {
      // Already chained: refresh pocp's part, leave the original where it is.
      fs.writeFileSync(file, chainedHook(name, body));
      fs.chmodSync(file, 0o755);
      installed.push(file);
      if (fs.existsSync(original)) chained.push(name);
      continue;
    }
    let text = existing === null ? '#!/bin/sh\n' : stripBlock(existing);
    if (existing !== null && text.trim() !== '' && mustChain(text)) {
      if (fs.existsSync(original)) {
        warnings.push(`${name}: not installed. The existing hook can't have pocp appended (${nonShellInterpreter(text) ? `it runs with ${nonShellInterpreter(text)}` : 'it uses exec or exit'}), and ${path.basename(original)} already exists, so it can't be moved aside. Move one of them, then run "pocp hooks install" again`);
        continue;
      }
      // Keep the original's mode: git skips a hook that isn't executable, and so does the chain.
      const mode = fs.statSync(file).mode;
      fs.writeFileSync(original, text);
      fs.chmodSync(original, mode & 0o777);
      fs.rmSync(file);
      fs.writeFileSync(file, chainedHook(name, body));
      fs.chmodSync(file, 0o755);
      installed.push(file);
      chained.push(name);
      continue;
    }
    if (!text.startsWith('#!')) text = `#!/bin/sh\n${text}`;
    if (!text.endsWith('\n')) text += '\n';
    text += block(body);
    fs.writeFileSync(file, text);
    fs.chmodSync(file, 0o755);
    installed.push(file);
  }
  return { installed, warnings, dir, chained };
}

export function uninstallHooks(cwd) {
  const root = repoRoot(cwd);
  const dir = hooksDir(root);
  const removed = [];
  for (const name of Object.keys(HOOKS)) {
    const file = path.join(dir, name);
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, 'utf8');
    if (text.includes(CHAIN_MARK)) {
      // A chained hook: put the original back (or remove the hook if there was none).
      const original = `${file}${ORIGINAL_SUFFIX}`;
      if (fs.existsSync(original)) fs.renameSync(original, file);
      else fs.rmSync(file);
      removed.push(file);
      continue;
    }
    const next = stripBlock(text);
    if (next === text) continue;
    if (next.trim() === '#!/bin/sh' || next.trim() === '') fs.rmSync(file);
    else fs.writeFileSync(file, next);
    removed.push(file);
  }
  return { removed };
}

/** Are the pocp hooks installed and runnable? Git silently skips a hook that isn't executable. */
export function hooksHealth(cwd) {
  const root = repoRoot(cwd);
  const dir = hooksDir(root);
  const hooks = {};
  const problems = [];
  for (const name of Object.keys(HOOKS)) {
    const file = path.join(dir, name);
    if (!fs.existsSync(file)) {
      hooks[name] = 'missing';
      continue;
    }
    const text = fs.readFileSync(file, 'utf8');
    const before = text.includes(CHAIN_MARK) ? '' : text.slice(0, Math.max(0, text.indexOf(HOOK_BEGIN)));
    const interp = before && nonShellInterpreter(before);
    const unreachable = before && !interp && unreachableReason(before);
    if (!text.includes(HOOK_BEGIN)) hooks[name] = 'no pocp block';
    else if (interp) {
      // Appended by an older pocp to a hook in another language: a syntax error there.
      hooks[name] = 'broken';
      problems.push(`${name}: pocp's sh block was appended to a ${interp} hook, so the hook fails and no commit can be made${name === 'pre-commit' ? '' : ' (not even with --no-verify)'}`);
    } else if (unreachable) {
      hooks[name] = 'never runs';
      problems.push(`${name}: the existing hook ${unreachable.replace(/^it /, '')} before pocp's block, so pocp never runs${name === 'pre-commit' ? ' and commits are not checked' : ''}`);
    } else if (!(fs.statSync(file).mode & 0o111)) {
      hooks[name] = 'not executable';
      problems.push(`${name} is not executable, so git skips it (run "pocp hooks install" or chmod +x ${file})`);
    } else hooks[name] = 'ok';
  }
  const installed = Object.values(hooks).some((v) => v !== 'missing' && v !== 'no pocp block');
  if (installed) {
    for (const [name, st] of Object.entries(hooks)) if (st === 'missing' || st === 'no pocp block') problems.push(`${name}: ${st}`);
  }
  return { dir, hooks, installed, problems };
}

// The GitHub workflows a project copies to run POCP in CI (examples/github), written by
// `pocp init --github` with the action pinned to this POCP's release.
export const GITHUB_WORKFLOWS = Object.freeze(['pocp.yml', 'pocp-status.yml', 'pocp-labels.yml']);
const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** This POCP's release tag, e.g. "v1.0.0": what the workflows pin by default. */
export function releaseRef() {
  const { version } = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, 'package.json'), 'utf8'));
  return `v${version}`;
}

/**
 * Write .github/workflows/{pocp,pocp-status,pocp-labels}.yml, with the POCP actions pinned to
 * `ref` (a release tag or a commit sha). Files that exist are left alone unless `force`.
 * Returns { written: [paths], skipped: [paths], ref }.
 */
export function writeGithubWorkflows(cwd, { ref = releaseRef(), force = false } = {}) {
  if (!/^[\w.\-/]+$/.test(ref)) throw new Error(`not a usable ref for the POCP action: ${ref}`);
  const dir = path.join(cwd, '.github', 'workflows');
  fs.mkdirSync(dir, { recursive: true });
  const written = [];
  const skipped = [];
  for (const name of GITHUB_WORKFLOWS) {
    const target = path.join(dir, name);
    const rel = path.join('.github', 'workflows', name);
    if (fs.existsSync(target) && !force) {
      skipped.push(rel);
      continue;
    }
    const text = fs.readFileSync(path.join(PKG_ROOT, 'examples', 'github', name), 'utf8').replaceAll('POCP_REF', ref);
    fs.writeFileSync(target, text);
    written.push(rel);
  }
  return { written, skipped, ref };
}
