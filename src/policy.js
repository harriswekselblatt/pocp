// POCP's policy algebra, in one place: which files are policy, what a change to them loosens,
// how the base's and the head's policies combine, and which findings block. Pure functions over
// policies already read; reading them from git or the working copy is the caller's job.
import { policyWeakening, strictUnion } from './rules.js';
import { configWeakening, strictConfig } from './store.js';

export const POLICY_FILES = Object.freeze(['.proof/rules.json', '.proof/config.json', '.proof/allowed_signers', '.proof/exceptions.json']);
/** Maintainer exceptions for commits that carry no proof record (verify --accept-uncovered). */
export const EXCEPTIONS_FILE = '.proof/exceptions.json';

const signerLines = (text) => (text || '').split('\n').map((l) => l.trim()).filter(Boolean);

/**
 * Everything the head's policy loosens compared with the base's, as readable lines. Each part
 * is compared only when given:
 *   rules       { base, head }: requirements and triggers (base null: nothing to loosen)
 *   config      { base, head }: the configuration
 *   signers     { base, head }: allowed_signers text; a new key is a loosening
 *   exceptions  { base, head }: exceptions.json text; any change is one, since it waives proof
 */
export function policyLoosenings({ rules, config, signers, exceptions } = {}) {
  const out = [];
  if (rules) out.push(...policyWeakening(rules.base, rules.head));
  if (config) out.push(...configWeakening(config.base, config.head));
  if (signers && (signers.head || '').trim() !== (signers.base || '').trim()) {
    const baseKeys = new Set(signerLines(signers.base));
    if (signerLines(signers.head).some((l) => !baseKeys.has(l))) out.push('allowed_signers gained a key');
  }
  if (exceptions && (exceptions.head || '').trim() !== (exceptions.base || '').trim()) {
    out.push(`${EXCEPTIONS_FILE} changed (exceptions for commits with no proof record)`);
  }
  return out;
}

/**
 * The rules and config that judge a change: the base's strictly combined with the head's (a
 * change can't loosen what judges it, and its stricter rules still apply), or the head's alone
 * when there is no enrolled base or a loosening was approved.
 */
export function combinePolicy({ base, head, accepted = false }) {
  if (!base || accepted) return { rules: head.rules, config: head.config };
  return { rules: strictUnion(base.hasRules ? base.rules : null, head.rules), config: strictConfig(base.config, head.config) };
}

// Finding codes that block exactly when their parent code does, so a fail_on list written before
// they existed can't turn them into warnings: a test change whose check didn't finish, a
// required CI check whose re-run didn't finish, a proof that didn't finish, a signature
// ssh-keygen couldn't check.
const BLOCKS_WITH = Object.freeze({ test_inconclusive: 'test_change', ci_unfinished: 'ci_failed', unfinished_proof: 'failed_proof', signature_unavailable: 'invalid_signature' });

/** Which findings fail verify under a config: its verify.fail_on, and an invalid policy always. */
export function blockingRule(config) {
  const failOn = new Set(config.verify?.fail_on || []);
  const blocks = (code) => code === 'invalid_policy' || failOn.has(BLOCKS_WITH[code] || code);
  return { failOn, blocks };
}

/** The policy files a list of changes touches ({ path, oldPath }). */
export function policyFilesTouched(changes) {
  return POLICY_FILES.filter((f) => changes.some((c) => c.path === f || c.oldPath === f));
}

/**
 * A change to a policy file is a policy change: it needs a packet that covers the file, so
 * weakening the rules is never silent. Returns null when no policy file changed.
 */
export function policyChange(changes, newRules, oldRules) {
  const touched = policyFilesTouched(changes);
  if (!touched.length) return null;
  const removed = [];
  if (oldRules) {
    const now = new Set((newRules.requirements || []).map((r) => r.id));
    for (const r of oldRules.requirements || []) if (!now.has(r.id)) removed.push(r.id);
  }
  return {
    files: touched,
    reason: {
      code: 'policy_change',
      detail: `POCP policy changed (${touched.join(', ')})${removed.length ? `; requirements removed: ${removed.join(', ')}` : ''}`,
      files: touched,
      removed_requirements: removed,
    },
  };
}
