// Typed facts about a finding or a problem: what a decision needs, kept apart from the prose a
// person reads. A finding's `detail` and its remedy text are for people; decisions read only
// these facts and the finding's code.
//
// Facts:
//   approval  'tests' | 'policy' | 'inconclusive': a maintainer's approval of this kind resolves it
//   files     the exact files it is about (repository paths)
//   variant   which case of a code it is, where the remedy differs (e.g. 'local_only')
//   errorCode the code of the error that caused a problem (e.g. 'clean_mode_refused')
//
// They are kept under a symbol, so they are not part of the JSON output or of a result's
// enumerable keys.

const FACTS = Symbol('pocp.facts');

/** Attach facts to a finding or problem object (in place), and return it. */
export function withFacts(target, facts) {
  if (facts) target[FACTS] = Object.freeze({ ...facts, ...(facts.files ? { files: Object.freeze([...facts.files]) } : {}) });
  return target;
}

/** The facts attached to a finding or problem; an empty object when there are none. */
export function factsOf(target) {
  return target?.[FACTS] || {};
}
