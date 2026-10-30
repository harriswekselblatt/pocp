import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { indexEntries, isProofPath, subjectHashIndex } from './git.js';
import { matchGlob } from './glob.js';
import { requirementsFor } from './rules.js';
import { ranAndFailed, unfinishedReason } from './run-result.js';
import { createIndexSnapshot } from './workspace.js';

// Mutating a test file only breaks the test itself, which would inflate the catch rate.
// These are also the test guard's default test patterns (guard.js), so they cover the common
// layouts of each ecosystem. A layout outside them goes in guard.extra_test_globs (pocp init
// detects the usual ones and writes them there).
export const DEFAULT_EVAL_EXCLUDE = Object.freeze([
  // Test folders, at the root or inside a package (monorepos, Maven/Gradle src/test/).
  'test/**', 'tests/**', 'spec/**', '**/test/**', '**/tests/**', '**/spec/**',
  '**/__tests__/**', '**/__test__/**', '**/__mocks__/**', '**/__snapshots__/**', '**/__fixtures__/**',
  '**/test-utils/**', '**/test_utils/**', '**/testutils/**', '**/test-helpers/**', '**/test_helpers/**', '**/test-support/**', '**/test_support/**',
  // JavaScript / TypeScript (and anything else named this way): a.test.js, a.spec.ts, a_spec.js, a_test.js.
  '**/*.test.*', '**/*.spec.*', '**/*_spec.*', '**/*_test.*', '**/*.snap',
  // Python: test_a.py, a_test.py (above), Django's tests.py.
  '**/test_*.py', '**/tests.py',
  // Ruby: a_spec.rb, a_test.rb (above), test_a.rb.
  '**/test_*.rb',
  // Go: a_test.go (above) and golden files.
  '**/testdata/**',
  // Java / Kotlin / Scala / Groovy: src/test/ (above), androidTest, commonTest, testFixtures, ...
  '**/src/*Test/**', '**/src/testFixtures/**', '**/*Test.java', '**/*Tests.java', '**/*IT.java', '**/*Test.kt', '**/*Tests.kt', '**/*Spec.kt',
  '**/*Test.scala', '**/*Spec.scala', '**/*Suite.scala', '**/*Spec.groovy', '**/*Test.groovy',
  // C# and Swift: FooTests.cs, Foo.Tests/, Tests/MyLibTests/.
  '**/*Tests.cs', '**/*Test.cs', '**/*Tests/**', '**/*.Test/**', '**/*Tests.swift',
  // PHP: FooTest.php.
  '**/*Test.php',
]);

export const SOURCE_EXT = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.rb', '.go', '.java', '.rs', '.c', '.cc', '.cpp', '.h', '.cs', '.php', '.swift', '.kt']);

// Small, syntax-preserving edits. Each is [name, regex, replacement].
export const OPERATORS = [
  ['strict-eq', /===/g, '!=='],
  ['strict-neq', /!==/g, '==='],
  ['eq', / == /g, ' != '],
  ['neq', / != /g, ' == '],
  ['lt', / < /g, ' >= '],
  ['gt', / > /g, ' <= '],
  ['lte', / <= /g, ' > '],
  ['gte', / >= /g, ' < '],
  ['and', /&&/g, '||'],
  ['or', /\|\|/g, '&&'],
  ['true', /\btrue\b/g, 'false'],
  ['false', /\bfalse\b/g, 'true'],
  ['plus', / \+ (?!=)/g, ' - '],
  ['minus', / - (?!=)/g, ' + '],
  ['times', / \* (?!=)/g, ' / '],
  ['zero-one', /\b0\b/g, '1'],
];

/** Deterministic PRNG (mulberry32). */
export function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function isCommentLine(line) {
  const t = line.trim();
  return t.startsWith('//') || t.startsWith('#') || t.startsWith('*') || t.startsWith('/*');
}

/** Every place an operator could apply in `text`: [{ op, index, length, replacement, line }]. */
export function mutationSites(text) {
  const sites = [];
  const lines = text.split('\n');
  const lineStarts = [];
  let pos = 0;
  for (const l of lines) {
    lineStarts.push(pos);
    pos += l.length + 1;
  }
  const lineOf = (idx) => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= idx) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
  for (const [name, re, replacement] of OPERATORS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text))) {
      const ln = lineOf(m.index);
      if (!isCommentLine(lines[ln])) sites.push({ op: name, index: m.index, length: m[0].length, replacement, line: ln + 1 });
    }
  }
  return sites;
}

export function applySite(text, site) {
  return text.slice(0, site.index) + site.replacement + text.slice(site.index + site.length);
}

/** Offset of a 1-based { line, column } position in `text`, or -1 if it is outside the text. */
function offsetOf(text, { line, column }) {
  let pos = 0;
  for (let l = 1; l < line; l++) {
    const nl = text.indexOf('\n', pos);
    if (nl === -1) return -1;
    pos = nl + 1;
  }
  const nl = text.indexOf('\n', pos);
  const lineEnd = nl === -1 ? text.length : nl;
  const off = pos + column - 1;
  return column >= 1 && off <= lineEnd ? off : -1;
}

/**
 * Apply one mutant from an outside tool (a corpus entry) to `text`.
 * `start` and `end` are 1-based { line, column }; `end` is exclusive, as in the
 * mutation-testing-report-schema that StrykerJS writes. When `original` is given, the text
 * in the range must equal it, so a corpus never applies to code it wasn't drawn from.
 * Returns { mutatedText, line, line_text, mutated_line } or { gone: reason }.
 */
export function applyCorpusEdit(text, m) {
  if (!m?.start || !m?.end || typeof m.replacement !== 'string') return { gone: 'entry needs start, end and replacement' };
  const a = offsetOf(text, m.start);
  const b = offsetOf(text, m.end);
  if (a === -1 || b === -1 || b < a) return { gone: 'the range is outside the file' };
  if (typeof m.original === 'string' && text.slice(a, b) !== m.original) return { gone: 'the original text is no longer at that range' };
  const mutatedText = text.slice(0, a) + m.replacement + text.slice(b);
  const line = m.start.line;
  return { mutatedText, line, line_text: text.split('\n')[line - 1], mutated_line: mutatedText.split('\n')[line - 1] };
}

function shuffleInPlace(arr, rand) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * Mutation evaluation (SPEC §11.2). Plants small bugs in files guarded by requirements
 * and checks whether the required checks for that file catch each one.
 *
 * - Every mutant runs in its own fresh snapshot of the staged code, so nothing a test
 *   leaves behind (generated files, caches, edits) can affect another mutant.
 * - The baseline runs once, one check at a time, in its own snapshot.
 * - Mutants run in parallel (`jobs`) and checks run fastest-first.
 * - `count: 'all'` evaluates every site. `replay` re-runs a saved sample (from `--save`)
 *   against the current code instead of drawing a new one. `corpus` runs mutants made by
 *   another tool ({ id, file, start, end, replacement, original? }, see applyCorpusEdit), so
 *   POCP's runner can be compared with that tool's on exactly the same mutants.
 * - A mutant is caught only by a check that ran to the end and failed (`ranAndFailed`, the
 *   test guard's rule). A check that timed out, was killed, couldn't start or exited 126/127
 *   says nothing about the mutant, so the next checks still run. If none fails normally and
 *   one didn't finish, the mutant is not measured: `outcome` timeout (a check timed out) or
 *   error (otherwise), `caught: null`, and `not_measured` lists the checks and why. It counts
 *   neither way: the catch rate is caught ÷ (caught + missed), and `not_measured`, `timeouts`
 *   and `errors` are reported beside it. Under load a full suite times out whether or not it
 *   would catch the mutant; counting that as a catch inflated the rate.
 */
export async function runMutantEval(engine, { count = 10, seed = 1, files: onlyFiles, jobs, replay, corpus } = {}) {
  const root = engine.root;
  const rules = engine.rules();
  const cfg = engine.config();
  const guardedGlobs = (rules.requirements || []).flatMap((r) => (Array.isArray(r.globs) ? r.globs : [r.glob])).filter(Boolean);
  let candidates = indexEntries(root)
    .filter((e) => e.stage === 0 && e.mode.startsWith('100') && !isProofPath(e.path))
    .map((e) => e.path)
    .filter((p) => SOURCE_EXT.has(path.extname(p)))
    .filter((p) => guardedGlobs.some((gl) => matchGlob(p, gl)))
    .filter((p) => !(cfg.eval?.exclude || DEFAULT_EVAL_EXCLUDE).some((gl) => matchGlob(p, gl)));
  if (onlyFiles?.length) candidates = candidates.filter((p) => onlyFiles.some((gl) => matchGlob(p, gl)));
  if (candidates.length === 0) {
    return { ok: false, error: 'no source files are guarded by requirements in .proof/rules.json', mutants: [] };
  }

  const started = Date.now();
  const snapOpts = { links: cfg.snapshot.link, readOnly: false };
  const base = createIndexSnapshot(root, snapOpts);
  try {
    const checksFor = new Map();
    for (const f of candidates) {
      const req = requirementsFor([f], { rules });
      checksFor.set(f, req.merged.map((r) => ({ ...r.obligation, id: r.id })).filter((o) => o.run));
    }

    // Baseline, one check at a time: every check must pass on the unmodified code.
    const allChecks = new Map();
    for (const list of checksFor.values()) for (const ob of list) allChecks.set(ob.run, ob);
    const baseline = [];
    const speed = new Map();
    for (const ob of allChecks.values()) {
      const r = await engine.runObligation(ob, base.dir, { logName: `eval-baseline-${ob.id}` });
      baseline.push({ rule: ob.id, passed: r.passed, exit: r.exit, duration_ms: r.duration_ms });
      speed.set(ob.run, r.duration_ms);
    }
    if (baseline.some((b) => !b.passed)) {
      return { ok: false, error: 'baseline failed: a required check does not pass on the unmodified code', baseline, mutants: [] };
    }
    for (const [f, list] of checksFor) checksFor.set(f, [...list].sort((a, b) => (speed.get(a.run) ?? 0) - (speed.get(b.run) ?? 0)));

    const texts = new Map();
    for (const f of candidates) texts.set(f, fs.readFileSync(path.join(base.dir, f), 'utf8'));

    // The sample: drawn from every site with the seed, or taken from a saved run.
    let chosen;
    let sites = 0;
    if (corpus) {
      chosen = corpus.map((m) => {
        const base = { id: m.id, file: m.file, line: m.start?.line, operator: m.mutator || 'corpus', replacement: m.replacement };
        const text = texts.get(m.file);
        if (text === undefined) return { ...base, line_text: '', mutated_line: '', gone: 'file is not guarded by requirements or does not exist' };
        const r = applyCorpusEdit(text, m);
        if (r.gone) return { ...base, line_text: '', mutated_line: '', gone: r.gone };
        return { ...base, ...r };
      });
    } else if (replay) {
      chosen = replay.map((m) => {
        const text = texts.get(m.file);
        if (text === undefined) return { ...m, gone: 'file is no longer guarded or no longer exists' };
        const lines = text.split('\n');
        // The same original line, nearest to where it was.
        let best = -1;
        for (let i = 0; i < lines.length; i++) {
          if (lines[i] === m.line_text && (best === -1 || Math.abs(i + 1 - m.line) < Math.abs(best + 1 - m.line))) best = i;
        }
        if (best === -1) return { ...m, gone: 'the original line is no longer in the file' };
        const mutatedText = [...lines.slice(0, best), m.mutated_line, ...lines.slice(best + 1)].join('\n');
        return { ...m, line: best + 1, mutatedText };
      });
    } else {
      const plan = [];
      for (const f of candidates) for (const site of mutationSites(texts.get(f))) plan.push({ file: f, site });
      sites = plan.length;
      if (plan.length === 0) return { ok: false, error: 'no mutation sites found in guarded files', baseline, mutants: [] };
      shuffleInPlace(plan, prng(seed));
      const picked = count === 'all' ? plan : plan.slice(0, Math.min(Number(count), plan.length));
      chosen = picked.map(({ file, site }) => {
        const text = texts.get(file);
        const mutatedText = applySite(text, site);
        return {
          file,
          line: site.line,
          operator: site.op,
          line_text: text.split('\n')[site.line - 1],
          mutated_line: mutatedText.split('\n')[site.line - 1],
          mutatedText,
        };
      });
    }

    const workers = Math.max(1, Math.min(Number(jobs) || Math.max(1, os.cpus().length - 1), chosen.length || 1));
    const results = new Array(chosen.length);
    let next = 0;
    const work = async (w) => {
      for (;;) {
        const i = next++;
        if (i >= chosen.length) return;
        const m = chosen[i];
        const record = {
          ...(m.id !== undefined ? { id: m.id } : {}),
          file: m.file,
          line: m.line,
          operator: m.operator,
          line_text: m.line_text,
          mutated_line: m.mutated_line,
          before: String(m.line_text).trim().slice(0, 160),
          after: String(m.mutated_line).trim().slice(0, 160),
        };
        if (m.gone) {
          results[i] = { ...record, caught: null, outcome: 'gone', gone: m.gone };
          continue;
        }
        const t0 = Date.now();
        const snap = createIndexSnapshot(root, snapOpts); // fresh copy for every mutant
        let caughtBy = null;
        const unfinished = [];
        let timedOut = false;
        try {
          fs.writeFileSync(path.join(snap.dir, m.file), m.mutatedText);
          for (const ob of checksFor.get(m.file)) {
            const r = await engine.runObligation(ob, snap.dir, { logName: `eval-w${w}-${i}-${ob.id}` });
            if (r.passed) continue;
            if (ranAndFailed(r)) {
              caughtBy = ob.id;
              break;
            }
            if (r.timed_out) timedOut = true;
            unfinished.push({ check: ob.id, reason: unfinishedReason(r) });
          }
        } finally {
          snap.cleanup();
        }
        const measured = Boolean(caughtBy) || unfinished.length === 0;
        const outcome = caughtBy ? 'caught' : measured ? 'missed' : timedOut ? 'timeout' : 'error';
        results[i] = { ...record, caught: measured ? Boolean(caughtBy) : null, caught_by: caughtBy, outcome, ...(measured ? {} : { not_measured: unfinished }), ms: Date.now() - t0 };
      }
    };
    await Promise.all(Array.from({ length: workers }, (_, w) => work(w)));

    // Scored: caught or missed. Gone mutants and ones not measured (timeout, error) are not.
    const scored = results.filter((r) => r.outcome === 'caught' || r.outcome === 'missed');
    const unmeasured = results.filter((r) => r.outcome === 'timeout' || r.outcome === 'error');
    const caught = scored.filter((r) => r.caught).length;
    const byFile = {};
    for (const r of [...scored, ...unmeasured]) {
      byFile[r.file] ||= { total: 0, caught: 0 };
      if (r.caught === null) byFile[r.file].not_measured = (byFile[r.file].not_measured || 0) + 1;
      else byFile[r.file].total++;
      if (r.caught) byFile[r.file].caught++;
    }
    const summary = {
      ok: true,
      pocp: 1,
      seed: replay || corpus ? null : seed,
      replayed: Boolean(replay),
      corpus: Boolean(corpus),
      subject: subjectHashIndex(root),
      sites,
      total: scored.length,
      gone: results.filter((r) => r.outcome === 'gone').length,
      caught,
      missed: scored.length - caught,
      not_measured: unmeasured.length,
      timeouts: unmeasured.filter((r) => r.outcome === 'timeout').length,
      errors: unmeasured.filter((r) => r.outcome === 'error').length,
      catch_rate: scored.length ? Math.round((caught / scored.length) * 1000) / 1000 : null,
      jobs: workers,
      duration_ms: Date.now() - started,
      by_file: byFile,
      baseline,
      mutants: results,
    };
    try {
      engine.store.appendLog?.('eval', { at: new Date().toISOString(), seed: summary.seed, replayed: summary.replayed, subject: summary.subject, total: summary.total, caught, not_measured: summary.not_measured, catch_rate: summary.catch_rate, jobs: workers });
    } catch { /* best effort */ }
    return summary;
  } finally {
    base.cleanup();
  }
}
