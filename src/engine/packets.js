// Packet operations: open a packet, add a check, widen what it covers, sync, mark ready,
// abandon, attest, defer to CI, evaluate one against a subject, and report status.
import * as g from '../git.js';
import * as P from '../packets.js';
import { PocpError } from './shared.js';
import { describeObligation, isGuard } from '../obligations.js';
import { validateRules } from '../rules.js';

/** Packet operations for one engine, given the packet store helpers and locks it uses. */
export function createPackets({ activePackets, actor, emit, loadPacket, mutex, mutexAsync, nowFn, opts, requiredFor, root, savePacket, stagedForCoverage, stagedGuard, store }) {
  async function open(args) {
    return mutexAsync(() => openUnlocked(args));
  }
  async function openUnlocked({ intent, touches, obligations = [], by = actor, draft = false }) {
    const now = nowFn();
    const packet = P.createPacket({ intent, touches, obligations, by, now, id: opts.newId?.('p'), draft });
    const added = P.syncRequirements(packet, await requiredFor(packet), { now });
    savePacket(packet);
    emit('packet.opened', { id: packet.id, touches: packet.touches, required_added: added.map((o) => o.id) });
    return { packet, required_added: added };
  }

  async function addObligation(id, spec, o = {}) {
    return mutexAsync(() => addObligationUnlocked(id, spec, o));
  }
  async function addObligationUnlocked(id, spec, { by = actor } = {}) {
    const packet = loadPacket(id);
    if (!P.isActive(packet)) throw new PocpError(`packet ${packet.id} is ${packet.state}`);
    const ob = P.addObligation(packet, spec, { now: nowFn(), by });
    savePacket(packet);
    return { packet, obligation: ob };
  }

  async function widen(id, files, o = {}) {
    return mutexAsync(() => widenUnlocked(id, files, o));
  }
  async function widenUnlocked(id, files, { by = actor } = {}) {
    const packet = loadPacket(id);
    if (!P.isActive(packet)) throw new PocpError(`packet ${packet.id} is ${packet.state}`);
    const now = nowFn();
    const added = P.widenTouches(packet, files, { now, by });
    const required_added = P.syncRequirements(packet, await requiredFor(packet), { now });
    savePacket(packet);
    return { packet, added, required_added };
  }

  async function sync(ids) {
    return mutexAsync(() => syncUnlocked(ids));
  }
  async function syncUnlocked(ids) {
    const packets = ids?.length ? ids.map(loadPacket) : activePackets();
    const out = [];
    for (const packet of packets) {
      if (!P.isActive(packet)) continue;
      const added = P.syncRequirements(packet, await requiredFor(packet), { now: nowFn() });
      savePacket(packet);
      out.push({ id: packet.id, added: added.map((o) => o.id) });
    }
    return out;
  }

  function ready(id) {
    return mutex(() => readyUnlocked(id));
  }
  function readyUnlocked(id) {
    const packet = loadPacket(id);
    if (packet.state !== 'draft') throw new PocpError(`packet ${packet.id} is ${packet.state}, not draft`);
    packet.state = 'open';
    packet.history.push({ at: nowFn(), event: 'state', from: 'draft', to: 'open' });
    savePacket(packet);
    return packet;
  }

  function abandon(id, reason, opts2 = {}) {
    return mutex(() => abandonUnlocked(id, reason, opts2));
  }
  function abandonUnlocked(id, reason, { by = actor } = {}) {
    const packet = loadPacket(id);
    P.abandon(packet, { reason, now: nowFn(), by });
    savePacket(packet);
    emit('packet.abandoned', { id: packet.id, reason });
    return packet;
  }

  function attest(id, obligationId, opts2 = {}) {
    return mutex(() => attestUnlocked(id, obligationId, opts2));
  }
  function attestUnlocked(id, obligationId, { by = actor, note } = {}) {
    const packet = loadPacket(id);
    if (!P.isActive(packet)) throw new PocpError(`packet ${packet.id} is ${packet.state}`);
    const subject = g.subjectHashIndex(root);
    const a = P.recordAttestation(packet, obligationId, { by, note, subject, now: nowFn() });
    savePacket(packet, { stage: true });
    emit('attestation.recorded', { id: packet.id, obligation: obligationId, by });
    return { packet, attestation: a };
  }

  /** Hand block-mode guard results that didn't pass to CI approval (see P.recordDeferral). */
  function deferToCi(id, { by = actor } = {}) {
    return mutex(() => {
      const packet = loadPacket(id);
      if (!P.isActive(packet)) throw new PocpError(`packet ${packet.id} is ${packet.state}`);
      if (stagedGuard().mode !== 'block') throw new PocpError('only guard.tests "block" hands test changes to CI approval; in other modes a person signs off with pocp attest');
      const subject = g.subjectHashIndex(root);
      const out = [];
      for (const ob of packet.obligations.filter(isGuard)) {
        const proof = P.currentProof(packet, ob, subject);
        if (!proof || proof.passed || P.currentAttestation(packet, ob, subject) || P.currentDeferral(packet, ob, subject)) continue;
        out.push(P.recordDeferral(packet, ob.id, { by, subject, now: nowFn(), reason: proof.guard?.summary }));
      }
      if (out.length) savePacket(packet, { stage: true });
      return out;
    });
  }

  async function evaluate(packet, subject, rulesObj) {
    const req = await requiredFor(packet, rulesObj);
    return P.deferGuardApproval(packet, P.evaluatePacket(packet, { subject, required: [...req.merged, ...req.guard] }), stagedGuard().mode);
  }

  async function status() {
    const subject = g.subjectHashIndex(root);
    const staged = stagedForCoverage();
    const packets = [];
    for (const p of activePackets()) {
      const ev = await evaluate(p, subject);
      packets.push({ id: p.id, state: p.state, intent: p.intent, touches: p.touches, evaluation: ev,
        obligations: p.obligations.map((o) => ({ id: o.id, kind: o.kind, source: o.source, what: describeObligation(o) })) });
    }
    const rulesProblems = validateRules(store.readRawRules() || {});
    return { root, subject, staged, packets, rules_problems: rulesProblems };
  }

  return { open, addObligation, widen, sync, ready, abandon, attest, deferToCi, evaluate, status };
}
