import fs from 'node:fs';
import path from 'node:path';
import { globProblem, isGlob, matchGlob } from './glob.js';
import { digestJson } from './hash.js';
import { normalizeObligation, obligationDigest, ValidationError } from './obligations.js';

function globsOf(req) {
  if (Array.isArray(req.globs)) return req.globs;
  if (typeof req.glob === 'string') return [req.glob];
  return [];
}

/** Validate repo rules. Returns a list of problems (empty when valid). */
export function validateRules(rules) {
  const problems = [];
  if (rules && rules.pocp !== undefined && rules.pocp !== 1) {
    problems.push(Number.isInteger(rules.pocp) && rules.pocp > 1 ? `written for POCP format ${rules.pocp}; this version reads format 1 (upgrade pocp)` : `unknown POCP format ${JSON.stringify(rules.pocp)} (expected 1)`);
  }
  const t = rules.triggers || {};
  if (t.broad_files !== undefined && !(Number.isInteger(t.broad_files) && t.broad_files > 0)) {
    problems.push('triggers.broad_files must be a positive integer');
  }
  if (t.cross_area !== undefined && t.cross_area !== null) {
    const { areas, min_files } = t.cross_area;
    if (!(Number.isInteger(areas) && areas > 0) || !(Number.isInteger(min_files) && min_files > 0)) {
      problems.push('triggers.cross_area needs positive integers "areas" and "min_files"');
    }
  }
  const ids = new Set();
  for (const [i, g] of (t.globs || []).entries()) {
    if (!g || typeof g.glob !== 'string') problems.push(`triggers.globs[${i}] needs a "glob"`);
    else if (globProblem(g.glob)) problems.push(`triggers.globs[${i}]: ${globProblem(g.glob)}`);
    if (g && typeof g.require_packet !== 'boolean') problems.push(`triggers.globs[${i}] needs "require_packet": true|false`);
  }
  for (const [i, gl] of (Array.isArray(rules.count_exempt) ? rules.count_exempt : []).entries()) {
    if (globProblem(gl)) problems.push(`count_exempt[${i}]: ${globProblem(gl)}`);
  }
  for (const [i, r] of (rules.requirements || []).entries()) {
    if (!r || typeof r !== 'object') {
      problems.push(`requirements[${i}] must be an object`);
      continue;
    }
    if (!r.id) problems.push(`requirements[${i}] needs an "id"`);
    else if (ids.has(r.id)) problems.push(`requirements[${i}] duplicate id "${r.id}"`);
    else ids.add(r.id);
    if (globsOf(r).length === 0) problems.push(`requirements[${i}] needs a "glob"`);
    for (const gl of globsOf(r)) if (globProblem(gl)) problems.push(`requirements[${i}] (${r.id}): ${globProblem(gl)}`);
    try {
      normalizeObligation(r.obligation || {}, { source: `rule:${r.id}` });
    } catch (err) {
      problems.push(`requirements[${i}] (${r.id}): ${err.message}`);
    }
  }
  return problems;
}

/**
 * Non-fatal advice about rules in a checkout: a wildcard-free glob that names an existing
 * folder matches only a file with that exact path, which is almost never what was meant.
 */
export function ruleWarnings(rules, root) {
  const out = [];
  const all = [
    ...((rules.triggers || {}).globs || []).map((g) => g?.glob),
    ...(rules.requirements || []).flatMap((r) => (r ? globsOf(r) : [])),
  ];
  for (const gl of new Set(all)) {
    if (typeof gl !== 'string' || isGlob(gl) || globProblem(gl)) continue;
    try {
      if (fs.statSync(path.join(root, gl)).isDirectory()) out.push(`"${gl}" is a folder but has no wildcard, so it matches only a file at that exact path; write "${gl}/**" to cover the folder`);
    } catch { /* not there */ }
  }
  return out;
}

function normalizeHostTriggers(raw) {
  if (!raw) return { globs: [] };
  if (Array.isArray(raw)) return { globs: raw };
  return { globs: Array.isArray(raw.globs) ? raw.globs : [], broad_files: raw.broad_files, cross_area: raw.cross_area };
}

function areaOf(file, depth) {
  const parts = file.split('/');
  parts.pop();
  return parts.slice(0, depth).join('/') || '(root)';
}

/**
 * Which changed files need a packet, and why. Host triggers can only add:
 * a host `require_packet: false` is ignored, and thresholds use the lower value.
 *
 * Repo globs with `require_packet: false`, and `count_exempt` globs (docs, tests, lockfiles,
 * assets by default), exempt files from the broad and cross-area counts only; a file still needs a packet if any requiring glob, host trigger, or
 * requirement matches it.
 */
export function evaluateTriggers(files, { rules, hostTriggers, hostRequirements = [], config, hostName = 'host' }) {
  const host = normalizeHostTriggers(hostTriggers);
  const required = new Map(); // file -> Set(reason codes)
  const reasons = [];
  const mark = (file, code) => {
    if (!required.has(file)) required.set(file, new Set());
    required.get(file).add(code);
  };

  const repoGlobs = rules.triggers.globs || [];
  const exempt = new Set();
  for (const file of files) {
    let fileExempt = false;
    for (const g of repoGlobs) {
      if (matchGlob(file, g.glob)) {
        if (g.require_packet) mark(file, `glob:${g.id || g.glob}`);
        else fileExempt = true;
      }
    }
    if (fileExempt || (rules.count_exempt || []).some((gl) => matchGlob(file, gl))) exempt.add(file);
    for (const g of host.globs) {
      if (g && g.require_packet !== false && matchGlob(file, g.glob)) mark(file, `${hostName}:${g.id || g.glob}`);
    }
  }
  const globHits = [...required.keys()];
  if (globHits.length) reasons.push({ code: 'glob', detail: `${globHits.length} file(s) match protected paths`, files: globHits });

  // Requirements always imply that a packet is needed for the files they guard.
  const allReqs = [...(rules.requirements || []), ...hostRequirements];
  const reqHits = [];
  for (const file of files) {
    for (const r of allReqs) {
      if (globsOf(r).some((g) => matchGlob(file, g))) {
        mark(file, `requirement:${r.id}`);
        reqHits.push(file);
        break;
      }
    }
  }
  if (reqHits.length) reasons.push({ code: 'requirement', detail: `${reqHits.length} file(s) have required checks`, files: reqHits });

  const counted = files.filter((f) => !exempt.has(f));
  const broad = Math.min(...[rules.triggers.broad_files, host.broad_files].filter((n) => Number.isInteger(n) && n > 0));
  if (Number.isFinite(broad) && counted.length >= broad) {
    counted.forEach((f) => mark(f, 'broad'));
    reasons.push({ code: 'broad', detail: `${counted.length} files changed (threshold ${broad})`, files: counted });
  }

  const ca = [rules.triggers.cross_area, host.cross_area].filter((c) => c && Number.isInteger(c.areas) && Number.isInteger(c.min_files));
  if (ca.length) {
    const areasNeeded = Math.min(...ca.map((c) => c.areas));
    const minFiles = Math.min(...ca.map((c) => c.min_files));
    const areas = [...new Set(counted.map((f) => areaOf(f, config.area_depth)))];
    if (areas.length >= areasNeeded && counted.length >= minFiles) {
      counted.forEach((f) => mark(f, 'cross_area'));
      reasons.push({ code: 'cross_area', detail: `change spans ${areas.length} areas: ${areas.slice(0, 5).join(', ')}`, files: counted, areas });
    }
  }

  return {
    required_files: [...required.keys()].sort(),
    file_reasons: Object.fromEntries([...required.entries()].map(([f, s]) => [f, [...s].sort()])),
    reasons,
  };
}

/** Normalize a requirement into { id, globs, obligation, source }. */
export function normalizeRequirement(req, { defaultSource } = {}) {
  if (!req || typeof req !== 'object') throw new ValidationError('requirement must be an object');
  if (!req.id) throw new ValidationError('requirement needs an "id"');
  const globs = globsOf(req);
  if (globs.length === 0) throw new ValidationError(`requirement ${req.id} needs a "glob"`);
  const source = req.source || defaultSource || 'author';
  const obSource = source.startsWith('host:') ? source : source === 'guard' ? 'guard:tests' : `rule:${req.id}`;
  const obligation = normalizeObligation({ ...req.obligation, source: undefined }, { source: obSource });
  return { id: req.id, globs, obligation, source, digest: obligationDigest(obligation) };
}

/**
 * Requirements that apply to `touches`, repo rules first, then host policy.
 * Deduped by obligation digest. Returns { merged, repoOnly }.
 */
export function requirementsFor(touches, { rules, hostRequirements = [], hostName = 'host' }) {
  const applies = (r) => touches.some((t) => r.globs.some((g) => matchGlob(t, g)));
  const repo = (rules.requirements || []).map((r) => normalizeRequirement(r)).filter(applies);
  const host = hostRequirements
    .map((r) =>
      normalizeRequirement({
        ...r,
        id: String(r.id || '').startsWith(`${hostName}:`) ? r.id : `${hostName}:${r.id}`,
        source: `host:${hostName}`,
      }),
    )
    .filter(applies);

  const seen = new Set();
  const dedupe = (list) =>
    list.filter((r) => {
      if (seen.has(r.digest)) return false;
      seen.add(r.digest);
      return true;
    });
  const repoOnly = dedupe(repo);
  const merged = [...repoOnly, ...dedupe(host)];
  return { merged, repoOnly };
}

/** Policy digest over a requirement set: sorted obligation digests with their rule ids. */
export function policyDigest(reqs) {
  const items = reqs
    .map((r) => ({ id: r.id, obligation: r.digest }))
    .sort((a, b) => (a.obligation < b.obligation ? -1 : a.obligation > b.obligation ? 1 : a.id < b.id ? -1 : 1));
  return digestJson({ pocp: 1, requirements: items });
}

export { globsOf };

/**
 * Combine base-branch rules with a commit's rules, keeping whichever is stricter:
 * requirements and protected globs are unioned, thresholds take the lower value, and
 * exemptions survive only if both sides have them. Used by CI so a change can't loosen
 * the rules it is checked against.
 */
export function strictUnion(base, head) {
  if (!base) return head;
  const out = structuredClone(head);
  const norm = (r) => {
    try {
      return normalizeRequirement(r);
    } catch {
      return null;
    }
  };
  const headNorm = (out.requirements || []).map(norm);
  const ids = new Set((head.requirements || []).map((r) => r.id));
  for (const r of base.requirements || []) {
    const n = norm(r);
    if (!n) continue;
    const idx = headNorm.findIndex((h) => h && h.digest === n.digest);
    if (idx === -1) {
      out.requirements.push({ ...r, id: ids.has(r.id) ? `${r.id}@base` : r.id });
      continue;
    }
    // Same check in both: it keeps guarding every path the base guarded, so narrowing a
    // requirement's globs can't drop it from files it used to cover.
    const have = new Set(headNorm.filter((h) => h && h.digest === n.digest).flatMap((h) => h.globs));
    const missing = n.globs.filter((gl) => !have.has(gl));
    if (missing.length) {
      const target = out.requirements[idx];
      target.globs = [...globsOf(target), ...missing];
      delete target.glob;
      headNorm[idx] = norm(target);
    }
  }
  const bt = base.triggers || {};
  const ht = out.triggers;
  const minPos = (a, b) => [a, b].filter((n) => Number.isInteger(n) && n > 0).reduce((m, n) => Math.min(m, n), Infinity);
  const broad = minPos(bt.broad_files, ht.broad_files);
  ht.broad_files = Number.isFinite(broad) ? broad : undefined;
  if (bt.cross_area || ht.cross_area) {
    const cs = [bt.cross_area, ht.cross_area].filter(Boolean);
    ht.cross_area = { areas: Math.min(...cs.map((c) => c.areas)), min_files: Math.min(...cs.map((c) => c.min_files)) };
  }
  const key = (g) => `${g.glob}|${g.require_packet}`;
  const baseGlobs = bt.globs || [];
  const headGlobs = ht.globs || [];
  const protectedGlobs = [...baseGlobs, ...headGlobs].filter((g) => g.require_packet);
  const exemptions = headGlobs.filter((g) => !g.require_packet && baseGlobs.some((b) => key(b) === key(g)));
  const seen = new Set();
  ht.globs = [...protectedGlobs, ...exemptions].filter((g) => (seen.has(key(g)) ? false : seen.add(key(g))));
  const be = base.count_exempt;
  const he = head.count_exempt;
  if (Array.isArray(be) || Array.isArray(he)) {
    out.count_exempt = (he || []).filter((gl) => (be || []).includes(gl));
  }
  return out;
}

/** Ways `head` is looser than `base`. Empty when head is equal or stricter. */
export function policyWeakening(base, head) {
  if (!base) return [];
  const out = [];
  const reqs = (rules) => (rules.requirements || []).flatMap((r) => {
    try {
      return [normalizeRequirement(r)];
    } catch {
      return [];
    }
  });
  // Globs each check guards in the head, keyed by obligation digest.
  const headGlobs = new Map();
  for (const h of reqs(head)) {
    if (!headGlobs.has(h.digest)) headGlobs.set(h.digest, new Set());
    for (const gl of h.globs) headGlobs.get(h.digest).add(gl);
  }
  for (const b of reqs(base)) {
    const hg = headGlobs.get(b.digest);
    if (!hg) {
      out.push(`requirement "${b.id}" removed or changed`);
      continue;
    }
    // Globs are compared as written: rewriting one, even to something broader, needs approval.
    const missing = b.globs.filter((gl) => !hg.has(gl));
    if (missing.length) out.push(`requirement "${b.id}" no longer guards ${missing.map((gl) => `"${gl}"`).join(', ')}`);
  }
  const bt = base.triggers || {};
  const ht = head.triggers || {};
  if (Number.isInteger(bt.broad_files) && !(Number.isInteger(ht.broad_files) && ht.broad_files <= bt.broad_files)) out.push(`broad_files raised from ${bt.broad_files}`);
  if (bt.cross_area && (!ht.cross_area || ht.cross_area.areas > bt.cross_area.areas || ht.cross_area.min_files > bt.cross_area.min_files)) out.push('cross_area loosened');
  for (const g of bt.globs || []) {
    if (g.require_packet && !(ht.globs || []).some((h) => h.glob === g.glob && h.require_packet)) out.push(`protected path "${g.glob}" removed`);
  }
  for (const g of ht.globs || []) {
    if (!g.require_packet && !(bt.globs || []).some((b) => b.glob === g.glob && !b.require_packet)) out.push(`exemption "${g.glob}" added`);
  }
  for (const gl of head.count_exempt || []) if (!(base.count_exempt || []).includes(gl)) out.push(`count exemption "${gl}" added`);
  return out;
}
