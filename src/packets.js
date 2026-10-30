import { randomId } from './hash.js';
import { matchGlob } from './glob.js';
import { isGuard, isRunnable, normalizeObligation, obligationDigest, ValidationError } from './obligations.js';
import { policyDigest } from './rules.js';

export const ACTIVE_STATES = Object.freeze(new Set(['draft', 'open', 'failed', 'proven']));
// landed, merged and expired are derived from git and the clock on read; abandoned is written.
export const TERMINAL_STATES = Object.freeze(new Set(['landed', 'merged', 'expired', 'abandoned']));
export const MAX_INTENT = 500;

export function isActive(packet) {
  return ACTIVE_STATES.has(packet.state);
}

function nextObligationId(packet) {
  let max = 0;
  for (const ob of packet.obligations) {
    const m = /^o(\d+)$/.exec(ob.id || '');
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `o${max + 1}`;
}

function history(packet, now, event, extra = {}) {
  packet.history.push({ at: now, event, ...extra });
}

export function validateTouches(touches) {
  if (!Array.isArray(touches) || touches.length === 0) throw new ValidationError('a packet needs at least one path in "touches"');
  for (const t of touches) {
    if (typeof t !== 'string' || !t.trim()) throw new ValidationError('every "touches" entry must be a non-empty path or glob');
    if (t.startsWith('/') || t.split('/').includes('..')) throw new ValidationError(`"touches" must be repo-relative: ${t}`);
  }
  return [...new Set(touches.map((t) => t.trim().replace(/^\.\//, '')))].sort();
}

export function createPacket({ intent, touches, obligations = [], by = 'unknown', now, id, draft = false }) {
  if (typeof intent !== 'string' || !intent.trim()) throw new ValidationError('a packet needs an "intent"');
  if (intent.length > MAX_INTENT) throw new ValidationError(`intent is longer than ${MAX_INTENT} characters`);
  const packet = {
    pocp: 1,
    id: id || randomId('p'),
    intent: intent.trim(),
    touches: validateTouches(touches),
    obligations: [],
    state: draft ? 'draft' : 'open',
    policy: null,
    policy_repo: null,
    opened_at: now,
    opened_by: by,
    proofs: [],
    attestations: [],
    history: [],
  };
  history(packet, now, 'opened', { by });
  for (const spec of obligations) addObligation(packet, spec, { now, by });
  return packet;
}

/** Add an author obligation. Duplicate checks (same digest) are refused. */
export function addObligation(packet, spec, { now, by = 'unknown' } = {}) {
  const ob = normalizeObligation({ ...spec, id: undefined }, { id: nextObligationId(packet), source: spec.source || 'author' });
  const d = obligationDigest(ob);
  if (packet.obligations.some((o) => obligationDigest(o) === d)) {
    throw new ValidationError(`packet ${packet.id} already has this obligation`);
  }
  packet.obligations.push(ob);
  history(packet, now, 'obligation_added', { obligation: ob.id, source: ob.source, by });
  return ob;
}

/** Widen `touches`; returns the paths that were new. */
export function widenTouches(packet, files, { now, by = 'unknown' } = {}) {
  const added = validateTouches(files).filter((f) => !packet.touches.includes(f));
  if (added.length) {
    packet.touches = [...packet.touches, ...added].sort();
    history(packet, now, 'touches_widened', { added, by });
  }
  return added;
}

export function covers(packet, file) {
  return packet.touches.some((t) => matchGlob(file, t));
}

/**
 * Bring a packet in line with the requirements that apply to it now.
 * Adds missing required obligations (never removes any) and records the policy digests.
 */
export function syncRequirements(packet, { merged, repoOnly, guard = [] }, { now } = {}) {
  // Guard obligations describe the change as it stands (which tests changed, and the budget
  // in force), so one that no longer matches is replaced rather than left to block forever.
  // Required obligations from rules are never removed.
  const guardNow = new Set(guard.map((r) => r.digest));
  const stale = packet.obligations.filter((o) => o.source === 'guard:tests' && !guardNow.has(obligationDigest(o)));
  if (stale.length) {
    packet.obligations = packet.obligations.filter((o) => !stale.includes(o));
    history(packet, now, 'guard_replaced', { removed: stale.map((o) => o.id) });
  }
  const have = new Set(packet.obligations.map(obligationDigest));
  const added = [];
  // Guard requirements come from the change itself, not the rules, so they are added
  // but left out of the policy digest.
  for (const req of [...merged, ...guard]) {
    if (have.has(req.digest)) continue;
    const ob = { ...req.obligation, id: nextObligationId(packet) };
    packet.obligations.push(ob);
    have.add(req.digest);
    added.push(ob);
  }
  const policy = policyDigest(merged);
  const policyRepo = policyDigest(repoOnly);
  if (added.length || packet.policy !== policy || packet.policy_repo !== policyRepo) {
    history(packet, now, 'requirements_synced', { added: added.map((o) => o.id), policy });
  }
  packet.policy = policy;
  packet.policy_repo = policyRepo;
  return added;
}

/** The latest proof for an obligation that matches the current subject and obligation digest. */
export function currentProof(packet, ob, subject) {
  const d = obligationDigest(ob);
  for (let i = packet.proofs.length - 1; i >= 0; i--) {
    const p = packet.proofs[i];
    if (p.obligation === ob.id && p.subject === subject && p.obligation_digest === d) return p;
  }
  return null;
}

export function currentAttestation(packet, ob, subject) {
  const d = obligationDigest(ob);
  for (let i = packet.attestations.length - 1; i >= 0; i--) {
    const a = packet.attestations[i];
    if (a.obligation === ob.id && a.subject === subject && a.obligation_digest === d) return a;
  }
  return null;
}

/**
 * Where a packet stands against a subject and the requirements that apply now.
 * `required` is the merged requirement list from rules.requirementsFor().
 */
export function evaluatePacket(packet, { subject, required = [] }) {
  const have = new Set(packet.obligations.map(obligationDigest));
  const missing_required = required.filter((r) => !have.has(r.digest)).map((r) => ({ id: r.id, source: r.source, obligation: r.obligation }));
  const unproven = [];
  const failed = [];
  const unattested = [];
  const proven = [];
  const guard = [];
  let guardAttested = 0;
  for (const ob of packet.obligations) {
    if (isGuard(ob)) {
      // Met by a passing mechanical check. When the check fails (or can't decide), it needs
      // a sign-off instead: weaker evidence, and in block mode CI also wants approval.
      const p = currentProof(packet, ob, subject);
      const a = currentAttestation(packet, ob, subject);
      guard.push({ id: ob.id, status: p ? (p.passed ? 'passed' : p.guard?.verdict || 'failed') : 'unproven', attested_by: a?.by || null, detail: p?.guard?.summary || null });
      if (p?.passed) proven.push(ob.id);
      else if (a) guardAttested++;
      else if (!p) unproven.push(ob.id);
      else unattested.push(ob.id);
    } else if (isRunnable(ob)) {
      const p = currentProof(packet, ob, subject);
      if (!p) unproven.push(ob.id);
      else if (!p.passed) failed.push(ob.id);
      else proven.push(ob.id);
    } else if (!currentAttestation(packet, ob, subject)) {
      unattested.push(ob.id);
    }
  }
  // A guard obligation counts as proven when its mechanical check passed, and as a sign-off
  // when it was attested instead.
  const manual = packet.obligations.filter((o) => !isRunnable(o) && !isGuard(o)).length + guardAttested;
  const runnable = packet.obligations.length - manual;
  return {
    id: packet.id,
    subject,
    missing_required,
    unproven,
    failed,
    unattested,
    counts: { runnable, manual, proven: proven.length, attested: manual - unattested.filter((id) => !guard.some((x) => x.id === id)).length },
    guard,
    // A packet with no obligations proves nothing, so it never passes.
    no_obligations: packet.obligations.length === 0,
    ok: packet.obligations.length > 0 && missing_required.length === 0 && unproven.length === 0 && failed.length === 0 && unattested.length === 0,
  };
}

/**
 * A guard result handed to CI: in block mode a test change the mechanical check could not
 * pass is settled only by an independent pass in CI or a maintainer's approval there
 * (`--accept-test-change`), never by a sign-off from the author. `pocp fix` records that
 * explicitly, so the author doesn't have to sign off on its own test change to commit.
 * It is not an approval: verify's test guard still decides.
 */
export function recordDeferral(packet, obligationId, { by, subject, now, reason }) {
  const ob = packet.obligations.find((o) => o.id === obligationId);
  if (!ob || ob.kind !== 'guard') throw new ValidationError(`${obligationId} is not a test-guard obligation of ${packet.id}`);
  packet.deferrals = packet.deferrals || [];
  const d = { obligation: ob.id, obligation_digest: obligationDigest(ob), subject, by, at: now, to: 'ci-approval', reason: reason || null };
  packet.deferrals.push(d);
  history(packet, now, 'deferred', { obligation: ob.id, by, subject });
  return d;
}

export function currentDeferral(packet, ob, subject) {
  const d = obligationDigest(ob);
  return (packet.deferrals || []).findLast((x) => x.obligation === ob.id && x.subject === subject && x.obligation_digest === d) || null;
}

/**
 * Evaluation with deferred guard results taken out of `unattested` (block mode only), and
 * listed under `awaiting_approval`. A guard that never ran is still unproven.
 */
export function deferGuardApproval(packet, ev, mode) {
  if (mode !== 'block') return ev;
  const deferred = (ev.guard || []).filter((x) => {
    if (!ev.unattested.includes(x.id) || x.status === 'unproven') return false;
    const ob = packet.obligations.find((o) => o.id === x.id);
    return Boolean(ob && currentDeferral(packet, ob, ev.subject));
  });
  if (!deferred.length) return ev;
  const ids = new Set(deferred.map((x) => x.id));
  const unattested = ev.unattested.filter((id) => !ids.has(id));
  return {
    ...ev,
    unattested,
    awaiting_approval: deferred.map(({ id, status, detail }) => ({ id, status, detail })),
    ok: !ev.no_obligations && ev.missing_required.length === 0 && ev.unproven.length === 0 && ev.failed.length === 0 && unattested.length === 0,
  };
}

/** Set the stored state from an evaluation. Terminal states are never changed here. */
export function applyEvaluation(packet, evaluation, { now } = {}) {
  if (TERMINAL_STATES.has(packet.state) || packet.state === 'draft') return packet.state;
  const next = evaluation.failed.length ? 'failed' : evaluation.ok ? 'proven' : 'open';
  if (next !== packet.state) {
    history(packet, now, 'state', { from: packet.state, to: next, subject: evaluation.subject });
    packet.state = next;
  }
  return next;
}

export function recordProof(packet, proof, { now, keep = 5 } = {}) {
  packet.proofs.push(proof);
  if (!proof.passed) history(packet, now, 'proof_failed', { obligation: proof.obligation, subject: proof.subject });
  // Keep the last `keep` proofs per obligation so packet files stay small.
  const byOb = new Map();
  for (const p of packet.proofs) {
    if (!byOb.has(p.obligation)) byOb.set(p.obligation, []);
    byOb.get(p.obligation).push(p);
  }
  const keepSet = new Set();
  for (const list of byOb.values()) list.slice(-keep).forEach((p) => keepSet.add(p));
  packet.proofs = packet.proofs.filter((p) => keepSet.has(p));
}

export function recordAttestation(packet, obligationId, { by, note, subject, now }) {
  const ob = packet.obligations.find((o) => o.id === obligationId);
  if (!ob) throw new ValidationError(`packet ${packet.id} has no obligation ${obligationId}`);
  if (isRunnable(ob)) throw new ValidationError(`${obligationId} is a ${ob.kind} obligation; run it with "pocp prove" instead of attesting`);
  if (!by || typeof by !== 'string') throw new ValidationError('an attestation needs "by" (who is attesting)');
  const a = { obligation: ob.id, obligation_digest: obligationDigest(ob), subject, by, at: now };
  if (note) a.note = String(note).slice(0, 500);
  packet.attestations.push(a);
  history(packet, now, 'attested', { obligation: ob.id, by });
  return a;
}

/** When the packet last changed: the latest history entry, or when it was opened. */
export function lastActivity(packet) {
  let t = Date.parse(packet.opened_at) || 0;
  for (const h of packet.history || []) t = Math.max(t, Date.parse(h.at) || 0);
  return t;
}

/** True when an active packet has had no activity for longer than `ttlDays` (0 disables). */
export function isStale(packet, { now, ttlDays }) {
  if (!isActive(packet) || !ttlDays) return false;
  return Date.parse(now) - lastActivity(packet) > ttlDays * 86_400_000;
}

export function expireIfStale(packet, { now, ttlDays }) {
  if (isStale(packet, { now, ttlDays })) {
    history(packet, now, 'state', { from: packet.state, to: 'expired', reason: `open longer than ${ttlDays} days` });
    packet.state = 'expired';
    return true;
  }
  return false;
}

export function abandon(packet, { reason, now, by = 'unknown' }) {
  if (!isActive(packet)) throw new ValidationError(`packet ${packet.id} is ${packet.state}; only active packets can be abandoned`);
  if (!reason || !String(reason).trim()) throw new ValidationError('abandoning a packet needs a reason');
  history(packet, now, 'state', { from: packet.state, to: 'abandoned', reason: String(reason).slice(0, 500), by });
  packet.state = 'abandoned';
}

/** Record a landing in the packet itself. The engine derives landed state from git instead;
 * this is for hosts whose Store has no git history to derive it from. */
export function markLanded(packet, { commit, now }) {
  history(packet, now, 'state', { from: packet.state, to: 'landed', commit });
  packet.state = 'landed';
  packet.landed = { commit, at: now };
}
