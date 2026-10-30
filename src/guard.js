import * as g from './git.js';
import { matchGlob } from './glob.js';
import { DEFAULT_EVAL_EXCLUDE } from './mutants.js';
import { normalizeRequirement } from './rules.js';
import { hasTestSettings, referencedFiles, settingsKind, testSettings } from './test-setup.js';

// Files that decide what a test run means. Changing them can hollow out a check
// without touching its command, so they're guarded like existing tests.
// Defaults cover common JavaScript, Python, Rust and PHP harnesses. On top of these, the
// guard follows what the setup points to (test-setup.js): files a runner config names,
// files a required check's command names, and the test settings inside package.json,
// pyproject.toml and setup.cfg. Anything else (a Makefile target, a Gradle task) can be
// added with guard.extra_runner_globs.
export const DEFAULT_RUNNER_GLOBS = [
  // JavaScript / TypeScript. Vitest reads the `test` block of vite.config.* when there is no
  // vitest.config.*; .npmrc can set node-options or script-shell for every npm script.
  '**/jest.config.*', '**/jest.setup.*', '**/vitest.config.*', '**/vitest.workspace.*', '**/vitest.setup.*', '**/vite.config.*',
  '**/.npmrc', '**/.yarnrc', '**/.yarnrc.yml',
  '**/.mocharc*', '**/ava.config.*', '**/playwright.config.*', '**/cypress.config.*', '**/karma.conf.*',
  '**/.nycrc*', '**/.c8rc*', '**/.babelrc*', '**/babel.config.*',
  // Python
  '**/pytest.ini', '**/conftest.py', '**/tox.ini', '**/noxfile.py',
  // Rust
  '**/.config/nextest.toml', '**/.cargo/config.toml',
  // PHP
  '**/phpunit.xml', '**/phpunit.xml.dist',
];

const REMOVED_ASSERT = /\b(assert\w*|expect|should|t\.(is|deepEqual|equal|true|false|throws|ok|not\w*)|toBe\w*|toEqual|toMatch\w*|toThrow\w*|toHave\w*|self\.assert\w*)\b/;
const ADDED_SKIP = /(\b(describe|it|test|context|suite)\.(skip|only|todo)\b|\bx(it|describe|test)\s*\(|\bt\.skip\b|@pytest\.mark\.(skip|xfail)|\{\s*skip\s*:\s*true|\.skip\(\))/;

/** The globs the test guard actually uses: replacements (or defaults) plus extras. */
export function effectiveGuardGlobs(config = {}) {
  const guardCfg = config.guard || {};
  return {
    test: [...new Set([...(guardCfg.test_globs || DEFAULT_EVAL_EXCLUDE), ...(guardCfg.extra_test_globs || [])])],
    runner: [...new Set([...(guardCfg.runner_globs || DEFAULT_RUNNER_GLOBS), ...(guardCfg.extra_runner_globs || [])])],
  };
}

/** Count weakening signals in a unified diff: removed assertions, added skips/onlys. */
export function weakeningSignals(diffText) {
  let removedAsserts = 0;
  let addedSkips = 0;
  for (const line of String(diffText || '').split('\n')) {
    if (line.startsWith('---') || line.startsWith('+++')) continue;
    if (line.startsWith('-') && REMOVED_ASSERT.test(line)) removedAsserts++;
    if (line.startsWith('+') && ADDED_SKIP.test(line)) addedSkips++;
  }
  return { removed_asserts: removedAsserts, added_skips: addedSkips };
}

/**
 * Changes that could weaken checks: existing test files modified/deleted/renamed, test
 * setup changed (runner config, files it or a required check names, the test settings in
 * package.json / pyproject.toml / setup.cfg). New test files are fine.
 *
 * `from` is the base revision; `to` is a commit, or null for the staged index. `commands`
 * are the required checks' commands ([{ run, cwd }]): files they name are test setup too.
 */
export function detectTestChanges(root, { from, to = null, config = {}, commands = [] }) {
  const guardCfg = config.guard || {};
  const mode = guardCfg.tests || DEFAULT_GUARD_MODE;
  if (mode === 'off') return { mode, files: [], signals: [] };
  // test_globs / runner_globs replace the defaults; extra_* add to them.
  const { test: testGlobs, runner: runnerGlobs } = effectiveGuardGlobs(config);
  const changes = to ? g.commitChanges(root, to) : g.stagedChanges(root, from);
  const base = to ? g.git(root, ['rev-parse', '--verify', '--quiet', `${to}^1`], { allowFail: true }) : from || (g.hasHead(root) ? 'HEAD' : null);

  // What the setup pointed to before the change, and what it points to now: a file the old
  // setup named is guarded even if the change also drops the reference.
  const named = new Set();
  if (base) for (const f of referencedFiles(root, base, { runnerGlobs, commands })) named.add(f);
  for (const f of referencedFiles(root, to, { runnerGlobs, commands })) named.add(f);

  const files = new Set();
  const signals = [];
  // What the mechanical check needs to rebuild the old test setup (guard-check.js).
  const detail = [];
  for (const c of changes) {
    const old = c.status === 'R' ? c.oldPath : c.path;
    if (c.status === 'A') {
      if (runnerGlobs.some((gl) => matchGlob(c.path, gl))) {
        files.add(c.path);
        detail.push({ status: 'A', path: c.path, kind: 'runner-config' });
      }
      continue;
    }
    const isTest = testGlobs.some((gl) => matchGlob(old, gl));
    const isRunner = [old, c.path].some((p) => runnerGlobs.some((gl) => matchGlob(p, gl)) || named.has(p));
    // package.json, pyproject.toml, setup.cfg: only their test settings count.
    let settingsChanged = false;
    if (!isTest && !isRunner && hasTestSettings(c.path) && base) {
      const before = g.showFile(root, base, old);
      const after = c.status === 'D' ? null : to ? g.showFile(root, to, c.path) : g.git(root, ['show', `:${c.path}`], { allowFail: true, trim: false });
      settingsChanged = testSettings(old, before) !== testSettings(c.path, after) || (testSettings(old, before) === null && before !== null);
    }
    if (!isTest && !isRunner && !settingsChanged) continue;
    files.add(old);
    if (c.path !== old) files.add(c.path);
    let diff = '';
    if (base) {
      const args = to ? ['diff', '-U0', base, to, '--', ...new Set([old, c.path])] : ['diff', '--cached', '-U0', base, '--', ...new Set([old, c.path])];
      diff = g.git(root, args, { allowFail: true, trim: false }) || '';
    }
    const kind = isTest ? 'test' : isRunner ? 'runner-config' : settingsKind(c.path);
    signals.push({ file: c.path, status: c.status, kind, ...weakeningSignals(diff) });
    detail.push({ status: c.status, path: c.path, ...(c.status === 'R' ? { oldPath: c.oldPath } : {}), kind });
  }
  const out = { mode, files: [...files].sort(), signals };
  // Kept off the JSON output: it repeats the signals, and only the engine needs it.
  Object.defineProperty(out, 'changes', { value: detail, enumerable: false });
  Object.defineProperty(out, 'base', { value: base || null, enumerable: false });
  // Setup files found by following references; the mechanical check doesn't plant mutants there.
  Object.defineProperty(out, 'named', { value: [...named].sort(), enumerable: false });
  return out;
}

export const DEFAULT_GUARD_MUTANTS = 10;
// Block: CI fails a test change unless the mechanical check passes independently there
// (verify --rerun) or a maintainer approves it. A self-given sign-off never suffices.
export const DEFAULT_GUARD_MODE = 'block';
export const DEFAULT_GUARD_SEED = 1;

/** Mutant budget and seed for the mechanical check, from config.guard. */
export function guardBudget(config = {}) {
  const gc = config.guard || {};
  return {
    mutants: Number.isInteger(gc.mutants) ? gc.mutants : DEFAULT_GUARD_MUTANTS,
    seed: Number.isInteger(gc.seed) ? gc.seed : DEFAULT_GUARD_SEED,
  };
}

/**
 * The obligation a packet gains when it covers guarded changes. POCP checks it mechanically
 * (guard-check.js): the old tests must pass on the new code, and the new tests must catch
 * every sampled mutant the old tests caught. A sign-off can stand in when that fails.
 */
export function guardRequirement(files, config = {}) {
  const shown = files.slice(0, 8).join(', ') + (files.length > 8 ? ` and ${files.length - 8} more` : '');
  return normalizeRequirement({
    id: 'guard:tests',
    globs: files,
    source: 'guard',
    obligation: {
      kind: 'guard',
      files,
      ...guardBudget(config),
      text: `Existing tests or test setup changed (${shown}): the old tests still pass on the new code, and the new tests catch every sampled mutant the old ones caught`,
    },
  });
}

/** The free-text sign-off older packets carry instead (before the mechanical check). */
export function isLegacyGuardObligation(ob) {
  return ob?.kind === 'manual' && ob.source === 'guard:tests';
}
