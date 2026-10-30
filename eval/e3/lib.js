// E3 helpers: sampling, Stryker report → POCP corpus, and the one rule set that classifies
// both paths' outcomes (eval/e3/README.md "Classification"). Pure functions, no POCP imports.
import { prng } from '../lib/stats.js';

/** Stryker's report columns and our corpus columns are 1-based; Babel's (used for mutate ranges) are 0-based. */
export function keyOf(m) {
  const l = m.location;
  return `${m.file}:${l.start.line}:${l.start.column}-${l.end.line}:${l.end.column}:${m.mutatorName}:${m.replacement}`;
}

/** Seeded simple random sample without replacement (Fisher–Yates on a copy, sorted input). */
export function sampleMutants(population, n, seed) {
  const sorted = [...population].sort((a, b) => (keyOf(a) < keyOf(b) ? -1 : keyOf(a) > keyOf(b) ? 1 : 0));
  const rand = prng(seed);
  for (let i = sorted.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [sorted[i], sorted[j]] = [sorted[j], sorted[i]];
  }
  return sorted.slice(0, Math.min(n, sorted.length));
}

function offsetOf(text, { line, column }) {
  let pos = 0;
  for (let l = 1; l < line; l++) {
    const nl = text.indexOf('\n', pos);
    if (nl === -1) return -1;
    pos = nl + 1;
  }
  return pos + column - 1;
}

/** The original text a 1-based, end-exclusive location covers. */
export function sliceLocation(source, location) {
  const a = offsetOf(source, location.start);
  const b = offsetOf(source, location.end);
  if (a < 0 || b < a) throw new Error(`bad location ${JSON.stringify(location)}`);
  return source.slice(a, b);
}

/** The mutated file text (used for the shared validity check and for diffs). */
export function applyLocation(source, location, replacement) {
  const a = offsetOf(source, location.start);
  const b = offsetOf(source, location.end);
  return source.slice(0, a) + replacement + source.slice(b);
}

/** A Stryker mutant (report schema, 1-based) as a `pocp eval --corpus` entry. */
export function toCorpusEntry(file, mutant, source) {
  return {
    id: mutant.id,
    file,
    mutator: mutant.mutatorName,
    start: { ...mutant.location.start },
    end: { ...mutant.location.end },
    replacement: mutant.replacement,
    original: sliceLocation(source, mutant.location),
  };
}

/** A Stryker mutate pattern for exactly this location: lines 1-based, columns 0-based. */
export function mutatePattern(file, location) {
  return `${file}:${location.start.line}:${location.start.column - 1}-${location.end.line}:${location.end.column - 1}`;
}

// ---- Classification (one rule set, both paths) ----

/** Stryker status → shared class. */
export function classifyStryker(status) {
  switch (status) {
    case 'Killed': return 'detected';
    case 'Survived':
    case 'NoCoverage': return 'undetected';
    case 'Timeout': return 'timeout';
    case 'CompileError': return 'invalid';
    case 'RuntimeError': return 'error';
    case 'Ignored':
    case 'Pending':
    case undefined:
    case null: return 'not-run';
    default: return 'error';
  }
}

/** POCP eval outcome → shared class. */
export function classifyPocp(outcome) {
  switch (outcome) {
    case 'caught': return 'detected';
    case 'missed': return 'undetected';
    case 'timeout': return 'timeout';
    case 'error': return 'error';
    case 'gone':
    case undefined:
    case null: return 'not-run';
    default: return 'error';
  }
}

const MEASURED = new Set(['detected', 'undetected']);

/**
 * The pair's category, in priority order:
 *   invalid     the shared `node --check` of the mutated file failed, or Stryker says CompileError
 *   equivalent  listed in the manual review file (eval/e3/equivalent.json) with a reason
 *   not-run     either side didn't run it (POCP couldn't apply it, Stryker ignored it)
 *   error       either side had a runner error
 *   timeout     either side timed out ("not measured")
 *   agree / disagree   both sides measured it
 */
export function pairCategory({ valid, equivalent, stryker, pocp }) {
  const s = classifyStryker(stryker);
  const p = classifyPocp(pocp);
  if (valid === false || s === 'invalid') return { category: 'invalid', s, p };
  if (equivalent) return { category: 'equivalent', s, p };
  if (s === 'not-run' || p === 'not-run') return { category: 'not-run', s, p };
  if (s === 'error' || p === 'error') return { category: 'error', s, p };
  if (s === 'timeout' || p === 'timeout') return { category: 'timeout', s, p };
  if (MEASURED.has(s) && MEASURED.has(p)) return { category: s === p ? 'agree' : 'disagree', s, p };
  return { category: 'error', s, p };
}

/** Counts per category and per side, and per-file clusters for agreement and each side's score. */
export function summarize(pairs) {
  const by = {};
  const clusters = { agreement: {}, stryker: {}, pocp: {} };
  const bump = (m, f, hit) => {
    m[f] ||= { k: 0, n: 0 };
    m[f].n++;
    if (hit) m[f].k++;
  };
  for (const r of pairs) {
    by[r.category] = (by[r.category] || 0) + 1;
    if (r.category === 'agree' || r.category === 'disagree') {
      bump(clusters.agreement, r.file, r.category === 'agree');
      bump(clusters.stryker, r.file, r.s === 'detected');
      bump(clusters.pocp, r.file, r.p === 'detected');
    }
  }
  const list = (m) => Object.values(m);
  return { by_category: by, clusters: { agreement: list(clusters.agreement), stryker: list(clusters.stryker), pocp: list(clusters.pocp) }, per_file: clusters };
}

/**
 * Blind spots: can POCP's own operators (src/mutants.js) produce this exact edit? We apply
 * every POCP site in the file and compare whole mutated files with whitespace removed, since
 * Stryker reprints the replacement with Babel and may change spacing.
 */
export function pocpEditSet(source, { mutationSites, applySite }) {
  const set = new Set();
  for (const site of mutationSites(source)) set.add(squash(applySite(source, site)));
  return set;
}

export function squash(text) {
  return text.replace(/\s+/g, '');
}

/** A short unified-style diff of the changed lines. */
export function lineDiff(before, after) {
  const a = before.split('\n');
  const b = after.split('\n');
  let s = 0;
  while (s < a.length && s < b.length && a[s] === b[s]) s++;
  let ea = a.length - 1;
  let eb = b.length - 1;
  while (ea >= s && eb >= s && a[ea] === b[eb]) { ea--; eb--; }
  const cap = (xs) => (xs.length > 6 ? [...xs.slice(0, 6), `… (${xs.length - 6} more lines)`] : xs);
  return [`@@ line ${s + 1}`, ...cap(a.slice(s, ea + 1)).map((l) => `- ${l}`), ...cap(b.slice(s, eb + 1)).map((l) => `+ ${l}`)].join('\n');
}
