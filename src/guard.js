import * as g from './git.js';
import { matchGlob } from './glob.js';
import { DEFAULT_EVAL_EXCLUDE } from './mutants.js';
import { normalizeRequirement } from './rules.js';
import {
  hasTestSettings, isRust, looksLikeTestSupport, notImportedByCode, readBlobs, referencedFiles, requirementCommands, rustTestModuleFile, settingsKind, supportByUse, testHelperFiles, testSettings, trackedBlobs,
} from './test-setup.js';

// Files that decide what a test run means. Changing them can hollow out a check
// without touching its command, so they're guarded like existing tests.
// Defaults cover common JavaScript, Python, Ruby, Rust, PHP, JVM and .NET harnesses. On top
// of these, the guard follows what the setup points to (test-setup.js): files a runner config
// names, files a required check's command names or runs, files the tests import (helpers),
// the test settings inside package.json, pyproject.toml and setup.cfg, and the #[cfg(test)]
// items of Rust files. Anything else (a Makefile target, a Gradle task) can be added with
// guard.extra_runner_globs.
export const DEFAULT_RUNNER_GLOBS = [
  // JavaScript / TypeScript. Vitest reads the `test` block of vite.config.* when there is no
  // vitest.config.*; .npmrc can set node-options or script-shell for every npm script.
  '**/jest.config.*', '**/jest.setup.*', '**/vitest.config.*', '**/vitest.workspace.*', '**/vitest.setup.*', '**/vite.config.*',
  '**/.npmrc', '**/.yarnrc', '**/.yarnrc.yml',
  '**/.mocharc*', '**/ava.config.*', '**/playwright.config.*', '**/cypress.config.*', '**/karma.conf.*',
  '**/.nycrc*', '**/.c8rc*', '**/.babelrc*', '**/babel.config.*',
  // Python
  '**/pytest.ini', '**/.pytest.ini', '**/conftest.py', '**/tox.ini', '**/noxfile.py',
  // Ruby
  '**/.rspec', '**/.rspec-local', '**/spec_helper.rb', '**/rails_helper.rb', '**/test_helper.rb',
  // Rust
  '**/.config/nextest.toml', '**/.cargo/config.toml',
  // PHP
  '**/phpunit.xml', '**/phpunit.xml.dist', '**/phpunit.dist.xml', '**/pest.php',
  // .NET
  '**/*.runsettings', '**/xunit.runner.json',
];

const REMOVED_ASSERT = /\b(assert\w*|expect|should|t\.(is|deepEqual|equal|true|false|throws|ok|not\w*)|toBe\w*|toEqual|toMatch\w*|toThrow\w*|toHave\w*|self\.assert\w*)\b/;
const ADDED_SKIP = /(\b(describe|it|test|context|suite)\.(skip|only|todo)\b|\bx(it|describe|test)\s*\(|\bt\.skip\b|@pytest\.mark\.(skip|xfail)|\{\s*skip\s*:\s*true|\.skip\(\))/;

// Added lines that can hollow out a test without removing anything: leaving early, exiting,
// overriding or patching assertions, the common mocking APIs named below, test hooks,
// assignments to globalThis/global, swallowing errors. A heuristic: it can't catch every way an added line weakens a
// test (a new helper later tests call instead of the real assertion, a change made through an
// alias such as `const a = assert; a.equal = ...`, shared state set in an added test that runs
// first), so the fast mode only promises what it lists here.
const RISKY_ADDED = [
  [ADDED_SKIP, 'skips or focuses tests'],
  [/\b(?:todo|only|skip)\s*:\s*true\b/, 'skips or focuses tests'],
  [/\bprocess\.(?:exit|abort)\s*\(|\bsys\.exit\s*\(|\bos\._exit\s*\(/, 'exits the process'],
  [/^\s*return\s*;?\s*$|\bif\s*\(\s*(?:true|1|!0)\s*\)\s*return\b/, 'returns early'],
  [/\b(?:assert|expect|should|t)(?:\.\w+)+\s*=(?![=>])|^\s*(?:assert|expect|should)\s*=(?![=>])/, 'reassigns an assertion'],
  [/\bObject\.(?:assign|defineProperty|defineProperties|setPrototypeOf)\s*\(\s*(?:assert|expect|should|t)\b|\.prototype\.\w+\s*=(?![=>])|\b__proto__\b/, 'patches an assertion or a prototype'],
  [/\b(?:jest|vi)\.(?:mock|doMock|spyOn|stubGlobal)\s*\(|\bmock\.(?:module|method|fn)\s*\(|\bsinon\.(?:stub|replace)\s*\(|\bmonkeypatch\.|\b(?:mock\.)?patch\s*\(/, 'mocks or stubs a module or function'],
  [/\bprocess\.exitCode\s*=\s*(?:0|undefined|null)\b|\bprocess\.on\s*\(\s*['"](?:exit|beforeExit|uncaughtException|unhandledRejection)['"]/, 'resets the exit code or handles process exit'],
  [/\b(?:before|after|beforeEach|afterEach|beforeAll|afterAll|setup|teardown|setUp|tearDown)\s*\(|\bdef\s+(?:setUp|tearDown|setup_method|teardown_method)\b|@pytest\.fixture\b/, 'adds a test hook or fixture'],
  [/\bglobalThis\.\w+\s*=(?![=>])|\bglobal\.\w+\s*=(?![=>])/, 'changes a global'],
  [/\bcatch\s*(?:\([^)]*\))?\s*\{\s*\}|\bexcept\b[^:]*:\s*pass\b/, 'swallows errors'],
];

/**
 * The fast mode's check (guard.mutants 0), run after the old tests pass on the new code.
 * It lets a change through only when every guarded change is an existing test file that is
 * modified by adding lines, none of which match RISKY_ADDED. Anything else goes to a person:
 * changed or removed lines, deleted or renamed tests, helpers, runner config, test settings.
 * Returns the reasons a person must look, [] when none. `rev` null means the staged index.
 */
export function structuralReview(root, { base, rev = null, changes = [] }) {
  const reasons = [];
  for (const c of changes) {
    const file = c.status === 'R' ? `${c.oldPath} → ${c.path}` : c.path;
    if (c.kind !== 'test') {
      reasons.push({ file, why: c.kind === 'runner-config' ? 'test setup or a test helper changed' : 'test settings changed' });
      continue;
    }
    if (c.status === 'D') {
      reasons.push({ file, why: 'a test file was deleted' });
      continue;
    }
    if (c.status === 'R') {
      reasons.push({ file, why: 'a test file was renamed' });
      continue;
    }
    if (c.status !== 'M') {
      reasons.push({ file, why: `a test file changed (${c.status})` });
      continue;
    }
    const args = rev ? ['diff', '-U0', base, rev, '--', c.path] : ['diff', '--cached', '-U0', base, '--', c.path];
    const diff = g.git(root, args, { allowFail: true, trim: false }) || '';
    const lines = diff.split('\n').filter((l) => !l.startsWith('---') && !l.startsWith('+++'));
    if (lines.some((l) => l.startsWith('-'))) {
      reasons.push({ file, why: 'existing test lines were changed or removed' });
      continue;
    }
    // Each added line, and all of a file's added lines joined into one, so a call split over
    // several lines (`Object.assign(\n  assert,\n  {...})`) still matches.
    const added = lines.filter((l) => l.startsWith('+')).map((l) => l.slice(1));
    const texts = [...added, added.map((l) => l.trim()).join(' ').replace(/\s*\.\s*/g, '.')];
    const hits = [...new Set(texts.flatMap((t) => RISKY_ADDED.filter(([re]) => re.test(t)).map(([, why]) => why)))];
    if (hits.length) reasons.push({ file, why: `an added line ${hits.join(', ')}` });
  }
  return reasons;
}

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
  if (base) for (const f of referencedFiles(root, base, { runnerGlobs, commands, testGlobs })) named.add(f);
  for (const f of referencedFiles(root, to, { runnerGlobs, commands, testGlobs })) named.add(f);

  const isTestPath = (p) => testGlobs.some((gl) => matchGlob(p, gl));
  const isRunnerPath = (p) => runnerGlobs.some((gl) => matchGlob(p, gl)) || named.has(p);
  // Test helpers: changed files the tests import (test-setup.js). Only looked for when an
  // existing file outside the tests and runner config changed.
  const helpers = findHelpers(root, {
    base, to, testGlobs, commands, named,
    candidates: changes.filter((c) => c.status !== 'A').flatMap((c) => [...new Set([c.status === 'R' ? c.oldPath : c.path, c.path])])
      .filter((p) => !isTestPath(p) && !isRunnerPath(p) && !hasTestSettings(p) && !g.isProofPath(p)),
  });
  // Rust: a file declared as `#[cfg(test)] mod name;` is test code as a whole.
  const rustTestFiles = new Set();
  for (const c of changes) {
    if (c.status === 'A') continue;
    const old = c.status === 'R' ? c.oldPath : c.path;
    if (!isRust(old) || isTestPath(old)) continue;
    if ((base && rustTestModuleFile(root, base, old)) || rustTestModuleFile(root, to, c.path)) rustTestFiles.add(old);
  }

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
    const isTest = isTestPath(old) || rustTestFiles.has(old);
    const isHelper = !isTest && [old, c.path].some((p) => helpers.has(p));
    const isRunner = isHelper || [old, c.path].some(isRunnerPath);
    // package.json, pyproject.toml, setup.cfg: only their test settings count. Rust files:
    // only their #[cfg(test)] items.
    let settingsChanged = false;
    if (!isTest && !isRunner && hasTestSettings(c.path) && base) {
      const before = g.showFile(root, base, old);
      const after = c.status === 'D' ? null : to ? g.showFile(root, to, c.path) : g.git(root, ['show', `:${c.path}`], { allowFail: true, trim: false });
      if (isRust(c.path)) settingsChanged = (before === null ? '' : testSettings(old, before)) !== (after === null ? '' : testSettings(c.path, after));
      else settingsChanged = testSettings(old, before) !== testSettings(c.path, after) || (testSettings(old, before) === null && before !== null);
    }
    if (!isTest && !isRunner && !settingsChanged) continue;
    files.add(old);
    if (c.path !== old) files.add(c.path);
    let diff = '';
    if (base) {
      const args = to ? ['diff', '-U0', base, to, '--', ...new Set([old, c.path])] : ['diff', '--cached', '-U0', base, '--', ...new Set([old, c.path])];
      diff = g.git(root, args, { allowFail: true, trim: false }) || '';
    }
    const kind = isTest ? 'test' : isHelper ? 'test-helper' : isRunner ? 'runner-config' : settingsKind(c.path);
    signals.push({ file: c.path, status: c.status, kind, ...weakeningSignals(diff) });
    // What the mechanical check restores (guard-check.js): a helper goes back whole, like
    // runner config; a Rust file gets only its #[cfg(test)] items back, like a config section.
    const restoreKind = kind === 'test-helper' ? 'runner-config' : kind === 'inline-tests' ? 'config-section' : kind;
    detail.push({ status: c.status, path: c.path, ...(c.status === 'R' ? { oldPath: c.oldPath } : {}), kind: restoreKind });
    // Test code and helpers are not where the mechanical check plants bugs.
    const plantable = isHelper && [old, c.path].every((p) => !helpers.has(p) || helpers.byUse?.has(p));
    if ((isHelper && !plantable) || rustTestFiles.has(old) || kind === 'inline-tests') for (const p of new Set([old, c.path])) named.add(p);
  }
  const out = { mode, files: [...files].sort(), signals };
  // Kept off the JSON output: it repeats the signals, and only the engine needs it.
  Object.defineProperty(out, 'changes', { value: detail, enumerable: false });
  Object.defineProperty(out, 'base', { value: base || null, enumerable: false });
  // Setup files found by following references; the mechanical check doesn't plant mutants there.
  Object.defineProperty(out, 'named', { value: [...named].sort(), enumerable: false });
  return out;
}

/**
 * Changed files (`candidates`) that are test helpers at the base or after the change: reached
 * from the tests by imports, not the code the required checks guard (their globs), and not
 * imported by that code at the base. With no required check, only files that look like test
 * support count (test-setup.js). Returns a Set; limits in HELPER_LIMITS.
 */
function findHelpers(root, { base, to, testGlobs, commands, named, candidates }) {
  if (!candidates.length) return new Set();
  // The code under check: what the required checks guard, by the rules in force and by the
  // base's rules (a change that narrows a rule doesn't turn the code it stops guarding into
  // test helpers; the narrowing itself is a policy change).
  let baseCommands = [];
  if (base) {
    try {
      baseCommands = requirementCommands(JSON.parse(g.showFile(root, base, '.proof/rules.json') || '{}'));
    } catch { /* unreadable base rules: the rules in force only */ }
  }
  const codeGlobs = [...new Set([...commands, ...baseCommands].flatMap((c) => c.globs || []))];
  const isCode = (p) => !named.has(p) && (codeGlobs.length ? codeGlobs.some((gl) => matchGlob(p, gl)) : true);
  // The usual commit changes only code under check: no import walk for that. A guarded file
  // that looks like test support (by path, or test-framework imports on either side) stays.
  const guardedOnes = candidates.filter((p) => isCode(p));
  const names = guardedOnes.flatMap((p) => [...(base ? [`${base}:${p}`] : []), `${to || ''}:${p}`]);
  const texts = readBlobs(root, names);
  const looksLike = (p) => [base && `${base}:${p}`, `${to || ''}:${p}`].some((n) => n && looksLikeTestSupport(p, texts.get(n)));
  const baseFiles = base ? trackedBlobs(root, base) : null;
  // Guarded files that don't look like test support may still be used as it: an assertion
  // helper the tests import next to the code, which no code imports (supportByUse). They
  // are restored like helpers, but stay where mutants are planted, since the heuristic can
  // take a module under test for one.
  const byUse = base ? supportByUse(root, base, guardedOnes.filter((p) => !looksLike(p)), { isCode, testGlobs, files: baseFiles }) : new Set();
  candidates = candidates.filter((p) => !isCode(p) || looksLike(p));
  if (!candidates.length) return Object.assign(byUse, { byUse });
  const seeds = [...named];
  const found = new Set();
  const revs = [...new Set([base || undefined, to])].filter((r) => r !== undefined);
  for (const rev of revs) {
    const files = rev === base && baseFiles ? baseFiles : trackedBlobs(root, rev);
    const { helpers } = testHelperFiles(root, rev, { testGlobs, seeds, isCode, files });
    for (const p of candidates) if (helpers.has(p)) found.add(p);
  }
  const helpers = found.size && base ? notImportedByCode(root, base, found, { isCode, testGlobs, files: baseFiles }) : found;
  for (const p of byUse) helpers.add(p);
  return Object.assign(helpers, { byUse });
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
      text: guardBudget(config).mutants === 0
        ? `Existing tests or test setup changed (${shown}): the old tests still pass on the new code, and the change only adds lines to existing tests (anything else goes to a person)`
        : `Existing tests or test setup changed (${shown}): the old tests still pass on the new code, and the new tests catch every sampled mutant the old ones caught`,
    },
  });
}

/** The free-text sign-off older packets carry instead (before the mechanical check). */
export function isLegacyGuardObligation(ob) {
  return ob?.kind === 'manual' && ob.source === 'guard:tests';
}
