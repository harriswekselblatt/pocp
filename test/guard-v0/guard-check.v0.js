// Frozen copy of src/guard-check.js before the E5 speedups (commit cbd567a), imports pointed at
// src/. test/e2e-guard-equivalence.test.js runs it and the current guard on the same fixtures
// and requires identical results. Never edit this file.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as g from '../../src/git.js';
import { matchGlob } from '../../src/glob.js';
import { applySite, DEFAULT_EVAL_EXCLUDE, mutationSites, prng, SOURCE_EXT } from '../../src/mutants.js';
import { restoreTestSettings } from '../../src/test-setup.js';
import { copySnapshot, createTreeSnapshot } from '../../src/workspace.js';

/**
 * The test guard's mechanical check (SPEC §6.2). A change modified or deleted existing tests
 * or test setup; did it weaken anything? Two parts, both run by POCP, no sign-off involved:
 *
 * 1. Old tests on the new code. In a copy of the new code, the changed test files and runner
 *    config are put back as they were at `base`, and the checks run. A failure means the
 *    change altered behavior the old tests pinned down: that needs a person.
 * 2. Detection can't drop. Small seeded mutants are planted in guarded source (lines this
 *    change touched and files the changed tests import come first). Every mutant the old
 *    tests catch, the new tests must catch too.
 *
 * `rev` is the commit being judged, or null for the staged index. Each run gets its own fresh
 * copy, so nothing a check leaves behind affects another.
 */
export async function runGuardCheck({
  root,
  runObligation,
  base,
  rev = null,
  changes,
  checks,
  sourceGlobs = [],
  mutants = 10,
  seed = 1,
  links = [],
  exclude = DEFAULT_EVAL_EXCLUDE,
  guardGlobs = { test: [], runner: [] },
  jobs,
  logPrefix = 'guard',
  known,
  onPass,
}) {
  const started = Date.now();
  const result = {
    pocp: 1,
    verdict: 'inconclusive',
    passed: false,
    summary: '',
    base,
    checks: checks.map((c) => ({ id: c.id, run: c.run, ...(c.cwd ? { cwd: c.cwd } : {}) })),
    old_tests: { result: 'not-run', restored: [], runs: [] },
    new_tests: { result: 'not-run', runs: [] },
    baseline: { result: 'not-run', runs: [] },
    detection: { result: 'not-run', budget: mutants, seed },
  };
  const finish = (verdict, summary) => {
    result.verdict = verdict;
    result.passed = verdict === 'passed';
    result.summary = summary;
    result.duration_ms = Date.now() - started;
    return result;
  };
  if (!base) return finish('inconclusive', 'no base revision to compare the tests with');
  if (!checks.length) return finish('inconclusive', 'no check runs these tests; add a test obligation that does (pocp add <packet> --test "<command>")');

  const newTpl = createTreeSnapshot(root, rev, { links });
  let oldTpl = null;
  try {
    oldTpl = copySnapshot(newTpl.dir);
    result.old_tests.restored = restoreOldTests(root, base, changes, oldTpl.dir);

    // Baselines: the checks on the new code with the new tests (as proven), then with the old.
    const speed = new Map();
    // `known(check)` reports a pass already seen for this exact new code (the plain proof of
    // the same check), so the new-code baseline isn't run twice; `onPass` shares new passes.
    const runAll = async (tplDir, label, into, only = checks) => {
      let copy = null;
      try {
        for (const ob of only) {
          const seen = label === 'new' && typeof known === 'function' ? known(ob) : null;
          if (seen) {
            into.push({ check: ob.id, passed: true, reused: true, duration_ms: 0 });
            speed.set(ob, seen.duration_ms ?? 0);
            continue;
          }
          copy = copy || copySnapshot(tplDir);
          const r = await runObligation(ob, copy.dir, { logName: `${logPrefix}-${label}-${ob.id}` });
          into.push({ check: ob.id, passed: r.passed, exit: r.exit, timed_out: r.timed_out || undefined, signal: r.signal || undefined, error: r.error || undefined, duration_ms: r.duration_ms });
          speed.set(ob, r.duration_ms);
          if (label === 'new' && r.passed && typeof onPass === 'function') onPass(ob, r);
        }
      } finally {
        copy?.cleanup();
      }
      return into.every((x) => x.passed) ? 'pass' : 'fail';
    };
    result.new_tests.result = await runAll(newTpl.dir, 'new', result.new_tests.runs);
    result.old_tests.result = await runAll(oldTpl.dir, 'old', result.old_tests.runs);
    if (result.new_tests.result === 'fail') {
      return finish('inconclusive', `the checks fail on the new code (${failedList(result.new_tests.runs, checks)}), so there is nothing to compare`);
    }
    if (result.old_tests.result === 'fail') {
      // Were these checks already failing before the change? Run the ones that failed on the
      // base itself. If they all fail there too, the failure says nothing about this change.
      const failing = checks.filter((ob) => result.old_tests.runs.some((r) => r.check === ob.id && !r.passed));
      const baseTpl = createTreeSnapshot(root, base, { links });
      try {
        result.baseline.result = await runAll(baseTpl.dir, 'base', result.baseline.runs, failing);
      } finally {
        baseTpl.cleanup();
      }
      // A check that passes at the base but fails on the new code: the change did that.
      if (result.baseline.runs.some((r) => r.passed)) {
        return finish('behavior-changed', `the old tests fail on the new code (${failedList(result.old_tests.runs, checks)}): behavior changed, so a person must approve it`);
      }
      // Already red only if every base run ended normally with a failing result. A timeout,
      // a signal, a spawn error or "command not found" says nothing about the tests.
      if (result.baseline.runs.every(ranAndFailed)) {
        return finish('baseline-red', `the old tests already fail at the base (${failedList(result.baseline.runs, checks)}), so the guard can't tell whether this change altered behavior: a person must approve it`);
      }
      return finish('inconclusive', `the old tests fail on the new code, and on the base the same checks didn't finish normally (${failedList(result.baseline.runs.filter((r) => !ranAndFailed(r)), checks)}), so it can't be told whether they were already failing: a person must approve it`);
    }
    if (mutants === 0) {
      result.detection = { result: 'off', budget: 0, seed };
      return finish('passed', 'the old tests pass on the new code (mutant check off: guard.mutants is 0)');
    }

    // Part 2: plant the same seeded sample on both sides.
    const ordered = [...checks].sort((a, b) => (speed.get(a) ?? 0) - (speed.get(b) ?? 0));
    const plan = mutationPlan({ root, base, rev, dir: newTpl.dir, changes, sourceGlobs, exclude, guardGlobs, mutants, seed });
    Object.assign(result.detection, { sites: plan.sites, focus_sites: plan.focusSites, files: plan.files.length });
    if (!plan.picked.length) {
      result.detection.result = 'inconclusive';
      return finish('inconclusive', 'no guarded source to plant mutants in, so a drop in detection can\'t be measured');
    }
    const killedIn = async (tplDir, m, label) => {
      const copy = copySnapshot(tplDir);
      try {
        fs.writeFileSync(path.join(copy.dir, m.file), m.mutatedText);
        for (const ob of ordered) {
          const r = await runObligation(ob, copy.dir, { logName: `${logPrefix}-${label}-${ob.id}` });
          if (!r.passed) return ob.id;
        }
        return null;
      } finally {
        copy.cleanup();
      }
    };
    const outcomes = new Array(plan.picked.length);
    let next = 0;
    const workers = Math.max(1, Math.min(Number(jobs) || Math.min(4, Math.max(1, os.cpus().length - 1)), plan.picked.length));
    await Promise.all(Array.from({ length: workers }, async () => {
      for (;;) {
        const i = next++;
        if (i >= plan.picked.length) return;
        const m = plan.picked[i];
        const byOld = await killedIn(oldTpl.dir, m, `m${i}-old`);
        // Only mutants the old tests catch can be lost, so only those run against the new tests.
        const byNew = byOld ? await killedIn(newTpl.dir, m, `m${i}-new`) : null;
        outcomes[i] = {
          file: m.file,
          line: m.line,
          operator: m.operator,
          before: m.before,
          after: m.after,
          focus: m.focus,
          old: byOld ? 'caught' : 'missed',
          new: byOld ? (byNew ? 'caught' : 'missed') : 'not-run',
        };
      }
    }));
    const baseKilled = outcomes.filter((o) => o.old === 'caught').length;
    const lost = outcomes.filter((o) => o.old === 'caught' && o.new === 'missed');
    Object.assign(result.detection, {
      sampled: outcomes.length,
      old_caught: baseKilled,
      new_caught: baseKilled - lost.length,
      lost: lost.map(({ file, line, operator, before, after }) => ({ file, line, operator, before, after })),
      mutants: outcomes,
    });
    if (baseKilled === 0) {
      result.detection.result = 'inconclusive';
      return finish('inconclusive', `the old tests caught none of ${outcomes.length} sampled mutants, so a drop in detection can't be measured`);
    }
    if (lost.length) {
      result.detection.result = 'dropped';
      const ex = lost[0];
      return finish('detection-dropped', `the new tests miss ${lost.length} of ${baseKilled} mutants the old tests caught (e.g. ${ex.file}:${ex.line} \`${ex.before}\` → \`${ex.after}\`)`);
    }
    result.detection.result = 'kept';
    return finish('passed', `the old tests pass on the new code, and the new tests catch all ${baseKilled} of the ${outcomes.length} sampled mutants the old tests caught (seed ${seed})`);
  } finally {
    oldTpl?.cleanup();
    newTpl.cleanup();
  }
}

/** The check ran to the end and reported failure (not a timeout, signal, spawn error or missing command). */
export function ranAndFailed(r) {
  return !r.passed && !r.timed_out && !r.signal && !r.error && Number.isInteger(r.exit) && r.exit !== 126 && r.exit !== 127;
}

function failedList(runs, checks) {
  return runs.filter((r) => !r.passed).map((r) => {
    const ob = checks.find((c) => c.id === r.check);
    return `"${ob?.run || r.check}" exit ${r.exit}${r.timed_out ? ', timed out' : ''}`;
  }).join(', ');
}

/**
 * Put the base versions of changed tests and runner config back into `dir`. A renamed test
 * counts as the old file deleted and the new one added: the old one comes back, the new one
 * stays (added tests are free). For package.json, pyproject.toml and setup.cfg only the
 * test settings go back (test-setup.js), so dependency changes in the same file stay.
 */
export function restoreOldTests(root, base, changes, dir) {
  const restored = [];
  const put = (rel) => {
    const data = g.showFileBuffer(root, base, rel);
    const full = path.join(dir, rel);
    if (data === null) return;
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.rmSync(full, { force: true });
    fs.writeFileSync(full, data);
    restored.push(rel);
  };
  const drop = (rel) => {
    fs.rmSync(path.join(dir, rel), { force: true });
    restored.push(`-${rel}`);
  };
  for (const c of changes) {
    // package.json, pyproject.toml, setup.cfg: only the test settings go back, so other
    // changes in the same file (dependencies, build settings) stay.
    if (c.kind === 'package-scripts' || c.kind === 'config-section') {
      const full = path.join(dir, c.path);
      const before = g.showFile(root, base, c.oldPath || c.path);
      const now = fs.existsSync(full) ? fs.readFileSync(full, 'utf8') : null;
      const merged = now === null ? null : restoreTestSettings(c.path, before, now);
      if (merged === null) put(c.oldPath || c.path);
      else {
        fs.writeFileSync(full, merged);
        restored.push(`${c.path} (test settings)`);
      }
      continue;
    }
    if (c.status === 'A') drop(c.path);
    else if (c.status === 'R') {
      put(c.oldPath);
      if (c.kind === 'runner-config') drop(c.path);
    } else put(c.path);
  }
  return restored;
}

function treeFiles(root, rev) {
  if (rev) return g.treeEntries(root, rev).filter((e) => e.mode?.startsWith('100')).map((e) => e.path);
  return g.indexEntries(root).filter((e) => e.stage === 0 && e.mode.startsWith('100')).map((e) => e.path);
}

const IMPORT_RE = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)['"]([^'"]+)['"]/gm;
const PY_IMPORT_RE = /^\s*(?:from\s+([\w.]+)\s+import|import\s+([\w.]+))/gm;
const JS_EXT = ['', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '/index.js', '/index.ts'];

/** Source files a test file imports (relative JS/TS imports, Python module paths). */
export function importedFiles(testPath, text, known) {
  const out = new Set();
  const dir = path.posix.dirname(testPath);
  for (const m of String(text || '').matchAll(IMPORT_RE)) {
    const spec = m[1];
    if (!spec.startsWith('.')) continue;
    const baseRel = path.posix.normalize(path.posix.join(dir, spec));
    for (const ext of JS_EXT) {
      const cand = baseRel + ext;
      if (known.has(cand)) {
        out.add(cand);
        break;
      }
    }
  }
  if (testPath.endsWith('.py')) {
    for (const m of String(text).matchAll(PY_IMPORT_RE)) {
      const mod = (m[1] || m[2]).replace(/\./g, '/');
      for (const cand of [`${mod}.py`, `${mod}/__init__.py`, `src/${mod}.py`, path.posix.join(dir, `${mod}.py`)]) {
        if (known.has(cand)) out.add(cand);
      }
    }
  }
  return out;
}

/**
 * The seeded sample, both sides use it. Sites on lines this change touched in guarded
 * source, and in files the changed tests import, come first; the rest tops up the budget.
 */
export function mutationPlan({ root, base, rev, dir, changes, sourceGlobs, exclude, guardGlobs, mutants, seed }) {
  const all = treeFiles(root, rev).filter((p) => !g.isProofPath(p));
  const known = new Set(all);
  const notSource = [...exclude, ...(guardGlobs.test || []), ...(guardGlobs.runner || [])];
  const files = all
    .filter((p) => SOURCE_EXT.has(path.extname(p)))
    .filter((p) => sourceGlobs.some((gl) => matchGlob(p, gl)))
    .filter((p) => !notSource.some((gl) => matchGlob(p, gl)))
    .sort();
  const touched = g.changedLines(root, base, rev, files);
  const imported = new Set();
  for (const c of changes.filter((x) => x.kind === 'test')) {
    for (const p of new Set([c.path, c.oldPath].filter(Boolean))) {
      const local = path.join(dir, p);
      const texts = [g.showFile(root, base, p), fs.existsSync(local) ? fs.readFileSync(local, 'utf8') : null];
      for (const t of texts) for (const f of importedFiles(p, t, known)) imported.add(f);
    }
  }
  const focus = [];
  const rest = [];
  for (const file of files) {
    let text;
    try {
      text = fs.readFileSync(path.join(dir, file), 'utf8');
    } catch {
      continue;
    }
    for (const site of mutationSites(text)) {
      const isFocus = imported.has(file) || Boolean(touched.get(file)?.has(site.line));
      (isFocus ? focus : rest).push({ file, site, text, focus: isFocus });
    }
  }
  const shuffle = (arr, rand) => {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  };
  shuffle(focus, prng(seed));
  shuffle(rest, prng(seed + 1));
  const picked = [...focus, ...rest].slice(0, mutants).map(({ file, site, text, focus: isFocus }) => {
    const mutatedText = applySite(text, site);
    return {
      file,
      line: site.line,
      operator: site.op,
      before: text.split('\n')[site.line - 1].trim().slice(0, 160),
      after: mutatedText.split('\n')[site.line - 1].trim().slice(0, 160),
      focus: isFocus,
      mutatedText,
    };
  });
  return { files, sites: focus.length + rest.length, focusSites: focus.length, picked };
}
