import { digestJson } from './hash.js';

export const KINDS = Object.freeze(['test', 'command', 'probe', 'manual']);
export const RUNNABLE = Object.freeze(new Set(['test', 'command', 'probe']));
// The test guard's own obligation (SPEC §6.2). POCP runs it itself rather than a command
// from the repo, so it is neither runnable nor manual, and only the guard can create it.
export const GUARD_KIND = 'guard';

export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
  }
}

export function isRunnable(ob) {
  return RUNNABLE.has(ob?.kind);
}

export function isGuard(ob) {
  return ob?.kind === GUARD_KIND;
}

/** Validate and normalize an obligation spec (as written by an author or a rule). */
export function normalizeObligation(spec, { id, source } = {}) {
  if (!spec || typeof spec !== 'object') throw new ValidationError('obligation must be an object');
  const kind = spec.kind;
  if (kind === GUARD_KIND) return normalizeGuard(spec, { id, source });
  if (!KINDS.includes(kind)) throw new ValidationError(`obligation kind must be one of ${KINDS.join(', ')} (got ${JSON.stringify(kind)})`);
  const ob = { id: spec.id || id, kind };
  if (RUNNABLE.has(kind)) {
    if (typeof spec.run !== 'string' || !spec.run.trim()) throw new ValidationError(`${kind} obligation needs a "run" command`);
    ob.run = spec.run.trim();
    if (spec.expect !== undefined && spec.expect !== null) {
      if (kind !== 'command') throw new ValidationError('"expect" is only allowed on command obligations');
      if (typeof spec.expect !== 'string') throw new ValidationError('"expect" must be a regex string');
      try {
        new RegExp(spec.expect, 'm');
      } catch (err) {
        throw new ValidationError(`"expect" is not a valid regex: ${err.message}`);
      }
      ob.expect = spec.expect;
    }
    if (spec.inputs !== undefined) {
      if (!Array.isArray(spec.inputs) || spec.inputs.some((g) => typeof g !== 'string')) {
        throw new ValidationError('"inputs" must be an array of globs');
      }
      ob.inputs = [...new Set(spec.inputs)].sort();
    }
    if (spec.timeout_ms !== undefined) {
      if (!Number.isInteger(spec.timeout_ms) || spec.timeout_ms <= 0) throw new ValidationError('"timeout_ms" must be a positive integer');
      ob.timeout_ms = spec.timeout_ms;
    }
    if (spec.cwd !== undefined && spec.cwd !== null && spec.cwd !== '' && spec.cwd !== '.') {
      const cwd = String(spec.cwd).replace(/\/+$/, '');
      if (cwd.startsWith('/') || cwd.split('/').includes('..')) throw new ValidationError('"cwd" must be a folder inside the repository');
      ob.cwd = cwd;
    }
    if (spec.target !== undefined) {
      if (kind !== 'probe') throw new ValidationError('"target" is only allowed on probe obligations');
      ob.target = String(spec.target);
    }
  } else {
    if (typeof spec.text !== 'string' || !spec.text.trim()) throw new ValidationError('manual obligation needs "text"');
    ob.text = spec.text.trim();
  }
  ob.source = spec.source || source || 'author';
  return ob;
}

function normalizeGuard(spec, { id, source }) {
  const src = spec.source || source;
  if (src !== 'guard:tests') throw new ValidationError('"guard" obligations come from the test guard only');
  if (!Array.isArray(spec.files) || !spec.files.length || spec.files.some((f) => typeof f !== 'string' || !f)) {
    throw new ValidationError('guard obligation needs "files"');
  }
  if (!Number.isInteger(spec.mutants) || spec.mutants < 0) throw new ValidationError('guard obligation needs "mutants" (a whole number, 0 or more)');
  if (!Number.isInteger(spec.seed)) throw new ValidationError('guard obligation needs a whole-number "seed"');
  const ob = { id: spec.id || id, kind: GUARD_KIND, files: [...new Set(spec.files)].sort(), mutants: spec.mutants, seed: spec.seed };
  if (typeof spec.text === 'string' && spec.text.trim()) ob.text = spec.text.trim();
  ob.source = src;
  return ob;
}

/** Digest over the fields that define what an obligation checks. */
export function obligationDigest(ob) {
  // The text only describes the check; the files, budget and seed define it.
  if (isGuard(ob)) return digestJson({ kind: ob.kind, files: ob.files, mutants: ob.mutants, seed: ob.seed });
  if (isRunnable(ob)) {
    const fields = {
      kind: ob.kind,
      run: ob.run,
      expect: ob.expect ?? null,
      inputs: ob.inputs ?? [],
      timeout_ms: ob.timeout_ms ?? null,
    };
    // Only present when set, so digests of checks without a cwd never change.
    if (ob.cwd) fields.cwd = ob.cwd;
    return digestJson(fields);
  }
  return digestJson({ kind: ob.kind, text: ob.text });
}

export function describeObligation(ob) {
  if (isGuard(ob)) return `guard: old tests pass on the new code, and the new tests catch what the old ones did (${ob.mutants} mutants, seed ${ob.seed})`;
  return isRunnable(ob) ? `${ob.kind}: ${ob.run}${ob.cwd ? ` (in ${ob.cwd})` : ''}` : `manual: ${ob.text}`;
}
