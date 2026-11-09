// What a verify result that isn't verified is waiting for, decided from typed findings only.
// The library and the CLI both use decideVerify, so they classify a result the same way, and
// no remedy or detail text can change the outcome.
import { factsOf } from './finding.js';
import { APPROVE_INCONCLUSIVE_LABEL, APPROVE_POLICY_LABEL, APPROVE_TESTS_LABEL } from './remedies.js';

/** The label a maintainer adds for each kind of approval. */
export const APPROVAL_LABEL = Object.freeze({ tests: APPROVE_TESTS_LABEL, policy: APPROVE_POLICY_LABEL, inconclusive: APPROVE_INCONCLUSIVE_LABEL });

/** Codes that only an approval of one fixed kind resolves. */
const APPROVAL_FOR_CODE = Object.freeze({
  test_inconclusive: 'inconclusive',
  policy_loosened: 'policy',
  ci_config_changed: 'policy',
});

/** Codes that wait for a re-run: something didn't finish, so nothing is known yet. */
const RERUN_CODES = new Set(['ci_unfinished']);

/**
 * How a blocking finding is resolved:
 *   { by: 'approval', approval, files }  a maintainer's approval of that kind
 *   { by: 'rerun' }                       running it again (it didn't finish)
 *   { by: 'fix' }                         anything else: a change to the code, policy or commit
 * A test change is approvable only when the code that found it says so (facts.approval).
 */
export function resolutionOf(finding) {
  const facts = factsOf(finding);
  if (RERUN_CODES.has(finding.code)) return { by: 'rerun' };
  const approval = finding.code === 'test_change' ? facts.approval : APPROVAL_FOR_CODE[finding.code];
  if (approval) return { by: 'approval', approval, files: facts.files || [] };
  return { by: 'fix' };
}

/**
 * Summarize blocking findings and re-run failures.
 * Returns { only, needs: [{ label, kind, reasons, files }], outcome, unfinished_reruns }.
 * The outcome follows one precedence: 'failed' when anything needs a fix (or nothing explains
 * the failure), else 'inconclusive' when anything didn't finish or needs an inconclusive
 * approval, else 'waiting' for the listed approvals. An approval never hides a failure, and an
 * unfinished run is never reported as a failure or as approval-only.
 */
export function summarizeFindings(findings = [], rerunFailures = []) {
  const needs = new Map();
  let unfinishedReruns = rerunFailures.filter((f) => f.unfinished === true).length;
  let needsFix = rerunFailures.length > unfinishedReruns;
  for (const f of findings.filter((x) => x.blocking)) {
    const r = resolutionOf(f);
    if (r.by === 'rerun') {
      unfinishedReruns++;
      continue;
    }
    if (r.by === 'fix') {
      needsFix = true;
      continue;
    }
    const label = APPROVAL_LABEL[r.approval];
    const n = needs.get(label) || { label, kind: r.approval, reasons: [], files: [] };
    if (!n.reasons.includes(f.detail)) n.reasons.push(f.detail);
    for (const file of r.files) if (!n.files.includes(file)) n.files.push(file);
    needs.set(label, n);
  }
  const only = !needsFix && needs.size > 0 && unfinishedReruns === 0;
  const outcome = needsFix || (!needs.size && !unfinishedReruns)
    ? 'failed'
    : unfinishedReruns || needs.has(APPROVE_INCONCLUSIVE_LABEL) ? 'inconclusive' : 'waiting';
  return { only, needs: [...needs.values()], outcome, unfinished_reruns: unfinishedReruns };
}

/**
 * The decision for a verify result (engine.verify or engine.verifyRange): null when it
 * verified, otherwise summarizeFindings over every commit's findings, the net change's, the
 * range's own, and its blocking re-run failures.
 */
export function decideVerify(result) {
  if (result.ok) return null;
  const rows = result.commits ? [...result.commits, ...(result.net ? [result.net] : [])] : [result];
  // A range's own findings, apart from re-run failures (rerun_failures lists those).
  const rangeFindings = result.commits && result.findings ? result.findings.filter((f) => f.code !== 'rerun_failed') : [];
  return summarizeFindings([...rows.flatMap((c) => c.findings || []), ...rangeFindings], (result.rerun_failures || []).filter((x) => x.blocking !== false));
}
