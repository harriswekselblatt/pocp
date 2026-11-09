// Proving: run the outstanding checks for packets (prove), reusing passing proofs for the same
// subject from any packet (reusableProofs).
import * as g from '../git.js';
import * as P from '../packets.js';
import { PocpError } from './shared.js';
import { createIndexSnapshot } from '../workspace.js';
import { isGuard, isRunnable, obligationDigest } from '../obligations.js';
import { ranAndFailed, runOutcome } from '../run-result.js';
import { signProof, verifyProofSignature } from '../sign.js';

/** Proving for one engine, given the check runner, guard and signing helpers it uses. */
export function createProve({ store, activePackets, cleanProblems, config, emit, evaluate, guardCacheKey, guardCheckFor, guardInputs, loadPacket, localSigners, mutexAsync, nowFn, readGuardCache, requiredFor, root, runObligation, runnerIdentity, savePacket, signingSetup, stagedForCoverage, stagedGuard, writeGuardCache }) {
  /** Passing proofs for this subject from any packet, keyed by obligation digest (for reuse). */
  function reusableProofs(subject, exceptId) {
    const out = new Map();
    for (const p of store.readPackets()) {
      if (p.id === exceptId) continue;
      for (const proof of p.proofs || []) {
        if (proof.subject === subject && proof.passed && !out.has(proof.obligation_digest)) out.set(proof.obligation_digest, { proof, from: p.id });
      }
    }
    return out;
  }

  /**
   * Run outstanding obligations for the given packets (default: active packets
   * covering staged files, or all active packets when nothing is staged).
   */
  /** Prove under the repo lock so two agents can't overwrite each other's proofs. */
  async function prove(args = {}) {
    return mutexAsync(() => proveUnlocked(args));
  }

  async function proveUnlocked({ ids, mode, force = false, only, stage = true, retryFailed = true } = {}) {
    const cfg = config();
    mode = mode || cfg.run.mode;
    if (!['clean', 'snapshot'].includes(mode)) throw new PocpError(`unknown run mode "${mode}"`);
    let packets;
    if (ids?.length) packets = ids.map(loadPacket);
    else {
      const staged = stagedForCoverage();
      const active = activePackets().filter((p) => p.state !== 'draft');
      packets = staged.length ? active.filter((p) => staged.some((f) => P.covers(p, f))) : active;
    }
    packets = packets.filter((p) => P.isActive(p) && p.state !== 'draft');
    if (packets.length === 0) return { subject: g.subjectHashIndex(root), mode, packets: [], ran: 0 };

    const now = nowFn();
    for (const p of packets) P.syncRequirements(p, await requiredFor(p), { now });

    const subject = g.subjectHashIndex(root);
    const scopeGlobs = packets.flatMap((p) => [...p.touches, ...p.obligations.flatMap((o) => o.inputs || [])]);
    if (mode === 'clean') {
      const problems = cleanProblems(scopeGlobs);
      if (problems.length) {
        for (const p of packets) savePacket(p);
        throw new PocpError('clean mode refused: the working folder does not match what is staged. Stage or stash the changes, or use --mode snapshot.', { problems }, { code: 'clean_mode_refused' });
      }
    }

    let snap = null;
    let snapHashBefore = null;
    if (mode === 'snapshot') {
      snap = createIndexSnapshot(root, { links: cfg.snapshot.link });
      snapHashBefore = snap.hash();
    }
    const dir = snap ? snap.dir : root;
    const identity = runnerIdentity(root);
    const signing = signingSetup();
    const cache = new Map(); // obligation digest -> result (one run per check per prove)
    const reusable = force ? new Map() : reusableProofs(subject, null);
    const results = [];
    let ran = 0;
    const guardRuns = new Map(); // guard digest + checks -> result (one check per prove)

    // The test guard's mechanical check. It is deterministic for a subject, so a recorded
    // result (pass or fail) stands until the code changes or --force. One that didn't finish
    // (a timeout, a kill, a failed start) says nothing, so it is always run again.
    async function proveGuard(packet, ob, pr) {
      const existing = P.currentProof(packet, ob, subject);
      if (existing && !force && !existing.guard?.unfinished) {
        pr.runs.push({ obligation: ob.id, skipped: `already checked for this subject (${existing.guard?.verdict || (existing.passed ? 'passed' : 'failed')})`, guard: existing.guard?.verdict });
        return;
      }
      const guardInfo = stagedGuard();
      const base = guardInfo.base ? g.git(root, ['rev-parse', '--verify', '--quiet', `${guardInfo.base}^{commit}`], { allowFail: true }) : null;
      const required = (await requiredFor(packet)).merged;
      const inputs = guardInputs(packet, required);
      const key = `${obligationDigest(ob)}\0${inputs.checks.map(obligationDigest).join(',')}`;
      // The same check on the same code, from another packet or an earlier prove (kept in
      // .proof/runs, never committed and never read by verify): not run again.
      const cacheKey = guardCacheKey(ob, { subject, base, inputs, guardInfo, cfg });
      // With signing on, only what ran in this prove gets signed: a cached file is unsigned.
      let res = guardRuns.get(key) || (force || signing ? null : readGuardCache(cacheKey));
      const startedAt = new Date().toISOString();
      const cached = Boolean(res && !guardRuns.has(key));
      if (cached) guardRuns.set(key, res);
      if (!res) {
        emit('proof.started', { id: packet.id, obligation: ob.id });
        res = await guardCheckFor(ob, { packet, required, guardInfo, base, rev: null, cfg, known: knownPass });
        ran++;
        guardRuns.set(key, res);
        if (g.subjectHashIndex(root) === subject) writeGuardCache(cacheKey, res);
      }
      if (g.subjectHashIndex(root) !== subject) {
        packet.history.push({ at: nowFn(), event: 'proof_discarded', obligation: ob.id, reasons: ['the staged files changed during the run'] });
        pr.runs.push({ obligation: ob.id, discarded: ['the staged files changed during the run'] });
        return;
      }
      const proof = {
        obligation: ob.id,
        obligation_digest: obligationDigest(ob),
        subject,
        policy: packet.policy,
        kind: 'guard',
        mode: 'snapshot',
        passed: res.passed,
        started_at: startedAt,
        duration_ms: res.duration_ms,
        runner: identity,
        guard: res,
      };
      if (signing) {
        try {
          proof.signature = signProof(proof, signing);
        } catch (err) {
          throw new PocpError(`signing failed: ${err.message}. Fix the key (sign.key / POCP_SIGN_KEY) or unset it.`);
        }
      }
      P.recordProof(packet, proof, { now: nowFn(), keep: cfg.proofs_kept_per_obligation });
      emit('proof.recorded', { id: packet.id, obligation: ob.id, passed: res.passed, subject });
      pr.runs.push({ obligation: ob.id, guard: res.verdict, passed: res.passed, summary: res.summary, duration_ms: cached ? 0 : res.duration_ms, ...(cached ? { cached: true } : {}) });
    }

    // A check that already passed on this exact code (this prove, or a proof in any packet).
    // The guard's "new tests on the new code" baseline is that same run, so it isn't repeated.
    // With signing on, a recorded proof counts only if it is itself validly signed, so an
    // edited packet file can't turn into a signed guard result.
    const trusted = (proof) => !signing || verifyProofSignature(proof, localSigners()) === 'valid';
    function knownPass(check) {
      const d = obligationDigest(check);
      const c = cache.get(d);
      if (c?.passed && !c.discarded) return { duration_ms: c.duration_ms };
      for (const p of packets) {
        for (const o of p.obligations) {
          if (!isRunnable(o) || obligationDigest(o) !== d) continue;
          const pr = P.currentProof(p, o, subject);
          if (pr?.passed && trusted(pr)) return { duration_ms: pr.duration_ms };
        }
      }
      const r = reusable.get(d);
      return r && trusted(r.proof) ? { duration_ms: r.proof.duration_ms } : null;
    }

    try {
      for (const packet of packets) {
        const pr = { id: packet.id, runs: [] };
        // Plain checks first: the guard reuses their passes as its baseline.
        const ordered = [...packet.obligations].sort((a, b) => Number(isGuard(a)) - Number(isGuard(b)));
        for (const ob of ordered) {
          if (isGuard(ob) && !(only?.length && !only.includes(ob.id))) {
            await proveGuard(packet, ob, pr);
            continue;
          }
          if (!isRunnable(ob)) continue;
          if (only?.length && !only.includes(ob.id)) continue;
          const existing = P.currentProof(packet, ob, subject);
          if (existing?.passed && !force) {
            pr.runs.push({ obligation: ob.id, skipped: 'already proven for this subject' });
            continue;
          }
          // A check that ran and failed on this exact code isn't run again (the code must change).
          // One that didn't finish (timed out, killed, didn't start) says nothing about the code,
          // so it's always run again: under load, a timeout would otherwise stick as a failure.
          if (existing && !retryFailed && !force && ranAndFailed(existing)) {
            pr.runs.push({ obligation: ob.id, skipped: 'failed on this exact code before; not run again (pocp prove --force to retry)', failed_before: true, run_id: existing.run_id });
            continue;
          }
          const d = obligationDigest(ob);
          const prior = reusable.get(d);
          // With signing on, only reuse a proof that is itself validly signed by a trusted key:
          // re-signing an unsigned copy would turn an unverifiable record into a trusted one.
          const reusableHere = prior && prior.from !== packet.id && (!signing || verifyProofSignature(prior.proof, localSigners()) === 'valid');
          if (reusableHere) {
            // Same check, same code, already proven in another packet: reuse it.
            const { signature, ...rest } = prior.proof;
            const proof = { ...rest, obligation: ob.id, policy: packet.policy, reused_from: prior.from };
            if (signing) proof.signature = signProof(proof, signing);
            P.recordProof(packet, proof, { now: nowFn(), keep: cfg.proofs_kept_per_obligation });
            pr.runs.push({ obligation: ob.id, passed: true, reused_from: prior.from, duration_ms: 0 });
            continue;
          }
          let res = cache.get(d);
          if (!res) {
            const startedAt = new Date().toISOString();
            emit('proof.started', { id: packet.id, obligation: ob.id });
            res = { ...(await runObligation(ob, dir)), started_at: startedAt };
            ran++;
            // Did anything move underneath the run?
            const afterSubject = g.subjectHashIndex(root);
            const moved = [];
            if (afterSubject !== subject) moved.push('the staged files changed during the run');
            if (mode === 'clean') {
              const probs = cleanProblems(scopeGlobs);
              if (probs.length) moved.push('the command changed files in the working folder');
            } else if (snap.hash() !== snapHashBefore) {
              moved.push('the command changed files in the snapshot');
            }
            res.discarded = moved.length ? moved : null;
            cache.set(d, res);
          }
          if (res.discarded) {
            packet.history.push({ at: nowFn(), event: 'proof_discarded', obligation: ob.id, reasons: res.discarded });
            pr.runs.push({ obligation: ob.id, discarded: res.discarded, exit: res.exit });
            continue;
          }
          const proof = {
            obligation: ob.id,
            obligation_digest: d,
            subject,
            policy: packet.policy,
            run: ob.run,
            mode,
            exit: res.exit,
            signal: res.signal,
            timed_out: res.timed_out,
            passed: res.passed,
            started_at: res.started_at,
            duration_ms: res.duration_ms,
            stdout_sha256: res.stdout_sha256,
            stderr_sha256: res.stderr_sha256,
            truncated: res.truncated || undefined,
            run_id: res.run_id,
            runner: identity,
          };
          if (signing) {
            try {
              proof.signature = signProof(proof, signing);
            } catch (err) {
              throw new PocpError(`signing failed: ${err.message}. Fix the key (sign.key / POCP_SIGN_KEY) or unset it.`);
            }
          }
          P.recordProof(packet, proof, { now: nowFn(), keep: cfg.proofs_kept_per_obligation });
          emit('proof.recorded', { id: packet.id, obligation: ob.id, passed: res.passed, subject });
          pr.runs.push({ obligation: ob.id, passed: res.passed, exit: res.exit, timed_out: res.timed_out, ...(res.passed ? {} : { outcome: runOutcome(res) }), duration_ms: res.duration_ms, run_id: res.run_id });
        }
        const ev = await evaluate(packet, subject);
        P.applyEvaluation(packet, ev, { now: nowFn() });
        savePacket(packet, { stage });
        results.push({ ...pr, state: packet.state, evaluation: ev });
      }
    } finally {
      if (snap) snap.cleanup();
    }
    return { subject, mode, packets: results, ran };
  }

  return { prove };
}
