// Verifying one commit: the policy that judges it, its packets and their proofs, the test guard
// that checks a change to existing tests, and the findings that decide the result. Also returns
// findingSink and reportPolicy, which verifying a range uses too.
import * as g from '../git.js';
import * as P from '../packets.js';
import { POLICY_FILES, policyChange, policyFilesTouched } from '../policy.js';
import { allSettled } from '../guard-check.js';
import { createRunMemo, protectedApprovalFiles, protectedChangeText } from './shared.js';
import { detectTestChanges, guardBudget, guardRequirement, isLegacyGuardObligation } from '../guard.js';
import { digestMatches } from '../hash.js';
import { evaluateTriggers, normalizeRequirement, policyDigest, requirementsFor } from '../rules.js';
import { formatProblem } from '../store.js';
import { isGuard, isRunnable, obligationDigest } from '../obligations.js';
import { packetProblem } from '../records.js';
import { parseTrailers } from '../trailer.js';
import { requirementCommands } from '../test-setup.js';
import { verifyProofSignature } from '../sign.js';
import { withFacts } from '../finding.js';

/** Single-commit verify for one engine, given the policy readers and re-runs it uses. */
export function createVerify({ opts, root, emit, hostName, hostRequirements, hostTriggers, guardCheckFor, effectiveFiles, readJsonAt, readRulesAt, policyInForce, notEnrolled, readUncoveredExceptions, applyUncoveredExceptions, acceptedText, changedCiFiles, rerunAt, rerunRequiredCi, checkRequiredCi, applyRerunEvidence }) {
  /** A finding recorder for a verify result: blocking findings fail it, the rest warn. */
  function findingSink(out, blocks) {
    return (code, detail, facts) => {
      const blocking = blocks(code);
      out.findings.push(withFacts({ code, detail, blocking }, facts));
      if (blocking) {
        out.ok = false;
        out.notes.push(detail);
      } else {
        out.warnings.push(detail);
      }
    };
  }

  function reportPolicy(finding, out, { baseRev, policyProblems, weakened, accepted }) {
    for (const p of policyProblems) finding('invalid_policy', `invalid policy: ${p}`);
    if (accepted) out.notes.push(`policy loosened and accepted: ${weakened.join('; ')}`);
    else if (baseRev && weakened.length) finding('policy_loosened', `policy loosened without approval: ${weakened.join('; ')} (re-run with --accept-policy-change once a maintainer approves)`, { files: POLICY_FILES });
  }

  /**
   * Check a commit without trusting its trailers. With `rerun`, run every runnable
   * obligation again in a clean checkout of that commit. With `requireCoverage`,
   * also require that files the commit changed are covered when the rules say so.
   */
  async function verify(rev = 'HEAD', { rerun = false, guardRerun, requireCoverage = false, useHost = Boolean(opts.policy), ciResults, policyFrom, acceptPolicyChange = false, acceptTestChange = false, acceptInconclusive = false, acceptUncovered = false, uncoveredExceptions, testGuardOnNet = false, rulesGuardFallback = false, allowedSignersFile, checkRequiredCiHere = true, guardSeed, jobs, memo = createRunMemo({ jobs }), alongside = null } = {}) {
    if (rerun === true) rerun = 'all';
    // The test guard's check compares a commit with its parent, so in a range it re-runs per
    // commit (verifyRange passes guardRerun) rather than once at the head.
    if (guardRerun === undefined) guardRerun = rerun;
    if (guardRerun === true) guardRerun = 'all';
    const commit = g.resolveRev(root, rev);
    const subject = g.subjectHashRev(root, commit);
    const message = g.commitMessage(root, commit);
    const trailerList = parseTrailers(message);
    const out = { commit, subject, ok: true, packets: [], coverage: null, reruns: [], notes: [], warnings: [], findings: [], policy: null };

    // Policy comes from the base (default: the commit's parent), so a change can't loosen
    // the rules it is judged by. Stricter rules from the commit still apply.
    const baseRev = policyFrom === undefined ? g.parentOf(root, commit) : policyFrom ? g.resolveRev(root, policyFrom) : null;
    const { policyProblems, weakened, accepted, rulesAt, cfgAt, allowedSigners, failOn, blocks, keyWarnings } = policyInForce(commit, baseRev, { acceptPolicyChange, allowedSignersFile });
    const commitFinding = findingSink(out, blocks);
    reportPolicy(commitFinding, out, { baseRev, policyProblems, weakened, accepted });
    if (!baseRev && policyFrom === undefined) out.notes.push('root commit: rules and signers come from the commit itself');

    const commitChangeList = g.commitChanges(root, commit);
    const commitFiles = g.changedPaths(commitChangeList);
    commitFiles.push(...policyFilesTouched(commitChangeList));
    // Unknown policy keys are reported on the commit that changes a policy file, not on every one.
    if (commitChangeList.some((c) => POLICY_FILES.includes(c.path))) out.warnings.push(...keyWarnings);

    // CI definitions changed: they can switch POCP off, so they need the same approval.
    const ciFilesChanged = changedCiFiles(commitChangeList, cfgAt);
    if (ciFilesChanged.length && !acceptPolicyChange) {
      commitFinding('ci_config_changed', `${protectedChangeText(ciFilesChanged)}; re-run with --accept-policy-change once a maintainer approves`, { files: protectedApprovalFiles(ciFilesChanged) });
    }

    // Test guard: modified tests or test setup in this commit. Mode comes from the policy in force.
    const commitGuard = detectTestChanges(root, { to: commit, config: cfgAt, commands: requirementCommands(rulesAt) });
    out.test_guard = commitGuard.files.length ? commitGuard : null;
    const guardJobs = []; // one per packet that carries the guard obligation
    out.policy = { from: baseRev, weakened, accepted, problems: policyProblems, fail_on: [...failOn] };
    const sigOf = new Map(); // obligation digest -> "valid" when a current proof is validly signed

    if (trailerList.length === 0) out.notes.push('commit has no Proof-Of-Change trailers');
    const packetsAt = [];
    for (const t of trailerList) {
      const findings = [];
      const flag = (code, detail) => findings.push({ code, detail, blocking: blocks(code) });
      const finish = (extra = {}) => {
        const entry = {
          id: extra.id || t.id,
          ok: !findings.some((f) => f.blocking),
          problems: findings.filter((f) => f.blocking).map((f) => f.detail),
          warnings: findings.filter((f) => !f.blocking).map((f) => f.detail),
          findings,
          ...extra,
        };
        out.packets.push(entry);
        for (const f of findings) out.findings.push({ ...f, packet: entry.id });
        return entry;
      };
      const rel = `.proof/packets/${t.id}.json`;
      const packet = readJsonAt(commit, rel);
      if (!packet) {
        flag('missing_packet', `packet file ${rel} is not in the commit`);
        finish();
        continue;
      }
      if (packet.__invalid) {
        flag('missing_packet', `packet file ${rel} is not valid JSON`);
        finish();
        continue;
      }
      if (formatProblem(packet)) {
        flag('missing_packet', `packet file ${rel} was ${formatProblem(packet)}`);
        finish();
        continue;
      }
      const shape = packetProblem(packet, { id: t.id });
      if (shape) {
        flag('missing_packet', `packet file ${rel} is malformed: ${shape}`);
        finish();
        continue;
      }
      packetsAt.push(packet);
      if (!digestMatches(subject, t.subject)) flag('trailer_mismatch', 'trailer subject does not match the commit');
      if (!digestMatches(packet.policy || '', t.policy)) flag('trailer_mismatch', 'trailer policy does not match the packet');

      const files = effectiveFiles(packet, commitFiles);
      const hostReqs = useHost ? await hostRequirements(files, { packet: packet.id, rev: commit }) : [];
      const req = requirementsFor(files, { rules: rulesAt, hostRequirements: hostReqs, hostName });
      const guardFiles = (commitGuard.files || []).filter((f) => P.covers(packet, f));
      let guardReqs = commitGuard.mode === 'attest' || commitGuard.mode === 'block' ? (guardFiles.length ? [guardRequirement(guardFiles, cfgAt)] : []) : [];
      // Packets made before the mechanical check carry a free-text sign-off instead. It is
      // still accepted, as an attestation, so older commits keep verifying.
      const legacyGuard = packet.obligations.find(isLegacyGuardObligation);
      if (guardReqs.length && legacyGuard && !packet.obligations.some((o) => obligationDigest(o) === guardReqs[0].digest)) {
        guardReqs = [normalizeRequirement({ id: 'guard:tests', globs: guardFiles, source: 'guard', obligation: legacyGuard })];
        out.notes.push(`${packet.id}: test change signed off the old way (free text, no mechanical check)`);
      }
      if (policyDigest(req.repoOnly) !== packet.policy_repo) flag('policy_mismatch', 'repo rules at this commit do not match the policy the packet was proven under');
      if (useHost && policyDigest(req.merged) !== packet.policy) flag('policy_mismatch', 'rules plus host policy do not match the policy the packet was proven under');
      // In block mode a guard result handed to CI (`pocp fix`) is judged by checkTestGuard
      // (an independent pass or a maintainer's approval), not by a sign-off in the packet.
      const ev = P.deferGuardApproval(packet, P.evaluatePacket(packet, { subject, required: [...(useHost ? req.merged : req.repoOnly), ...guardReqs] }), commitGuard.mode);
      for (const m of ev.missing_required) flag('missing_required', `required obligation missing: ${m.id}`);
      for (const id of ev.unproven) flag('unproven', `no proof for ${id} against this commit`);
      // A proof that didn't finish says nothing about the code: reported as such (it blocks
      // exactly when failed_proof does), never as a failure of the code.
      for (const id of ev.failed) {
        if ((ev.unfinished || []).includes(id)) flag('unfinished_proof', `proof for ${id} didn't finish (timed out, killed or didn't start): re-run it`);
        else flag('failed_proof', `proof for ${id} failed`);
      }
      for (const id of ev.unattested) flag('unattested', `no attestation for ${id} against this commit`);
      if (t.proven && t.proven.done !== ev.counts.proven) flag('trailer_mismatch', `trailer says ${t.proven.done} proven, packet shows ${ev.counts.proven}`);
      // `unavailable` is counted only when it happens, so the usual JSON shape doesn't change.
      const signatures = { valid: 0, invalid: 0, unsigned: 0, untrusted: 0 };
      for (const ob of packet.obligations.filter((o) => isRunnable(o) || isGuard(o))) {
        const proof = P.currentProof(packet, ob, subject);
        if (!proof) continue;
        const st = verifyProofSignature(proof, allowedSigners);
        signatures[st] = (signatures[st] || 0) + 1;
        if (st === 'invalid') flag('invalid_signature', `proof for ${ob.id} has an invalid signature (edited after signing, or signer not allowed)`);
        // ssh-keygen missing, failing or timing out: nothing is known about the signature. Not
        // valid, and not "edited" either.
        if (st === 'unavailable') flag('signature_unavailable', `proof for ${ob.id} is signed, but the signature could not be checked here (ssh-keygen missing, failed or timed out)`);
        if (st === 'valid') sigOf.set(obligationDigest(ob), 'valid');
      }
      // What establishes each check, weakest to strongest: local (unsigned, not re-run),
      // signed:<principal>, ci-result, rerun; manual checks are attested:<by>.
      const evidence = {};
      for (const ob of packet.obligations) {
        if (isGuard(ob)) {
          // A passing mechanical check is proof; a sign-off over a failed one is an attestation.
          const proof = P.currentProof(packet, ob, subject);
          const a = P.currentAttestation(packet, ob, subject);
          const signed = proof && verifyProofSignature(proof, allowedSigners) === 'valid';
          if (proof?.passed) evidence[ob.id] = signed ? `mechanical:signed:${proof.signature.principal}` : 'mechanical:local';
          else if (a) evidence[ob.id] = `attested:${a.by}`;
          if (!proof?.passed && a) {
            const why = proof?.guard?.summary || 'the mechanical check was not run';
            out.warnings.push(`${packet.id}: test change accepted on a sign-off by ${a.by}, not a mechanical check (${why})`);
          }
          if (guardFiles.length && obligationDigest(ob) === guardReqs[0]?.digest) {
            guardJobs.push({ packet, ob, required: useHost ? req.merged : req.repoOnly, proof, attestation: a, signed, files: guardFiles });
          }
        } else if (isRunnable(ob)) {
          const proof = P.currentProof(packet, ob, subject);
          if (!proof) continue;
          evidence[ob.id] = verifyProofSignature(proof, allowedSigners) === 'valid' ? `signed:${proof.signature.principal}` : 'local';
        } else {
          const a = P.currentAttestation(packet, ob, subject);
          if (a) evidence[ob.id] = `attested:${a.by}`;
        }
      }
      finish({ id: packet.id, counts: ev.counts, signatures, evidence });
    }

    if (requireCoverage) {
      const trig = evaluateTriggers(g.changedPaths(commitChangeList), {
        rules: rulesAt,
        hostTriggers: useHost ? await hostTriggers(commitFiles, { rev: commit }) : null,
        hostRequirements: useHost ? await hostRequirements(commitFiles, { rev: commit }) : [],
        config: cfgAt,
        hostName,
      });
      const parent = g.parentOf(root, commit);
      // Adopting POCP is not a policy change (as in the gate): this commit creates the first
      // policy, so there is nothing earlier to loosen. Only when neither its parent nor the
      // policy that judges it has any policy file; removing or corrupting a policy is not this.
      const adopting = notEnrolled(parent) && notEnrolled(baseRev);
      const pc = adopting ? null : policyChange(commitChangeList, rulesAt, parent ? readRulesAt(parent) : null);
      if (adopting && commitChangeList.some((c) => POLICY_FILES.includes(c.path))) out.notes.push('this commit adopts POCP (no earlier policy): its policy files are not a policy change');
      if (pc) {
        trig.required_files = [...new Set([...trig.required_files, ...pc.files])].sort();
        trig.reasons.push(pc.reason);
      }
      if (ciFilesChanged.length) {
        trig.required_files = [...new Set([...trig.required_files, ...ciFilesChanged])].sort();
        trig.reasons.push({ code: 'ci_config', detail: protectedChangeText(ciFilesChanged), files: ciFilesChanged });
      }
      if (commitGuard.files.length && commitGuard.mode !== 'warn') {
        trig.required_files = [...new Set([...trig.required_files, ...commitGuard.files])].sort();
        trig.reasons.push({ code: 'test_change', detail: 'existing tests or test setup changed', files: commitGuard.files });
      }
      const uncovered = trig.required_files.filter((f) => !packetsAt.some((p) => P.covers(p, f)));
      out.coverage = { required_files: trig.required_files, uncovered, reasons: trig.reasons };
      // With an approval for the head, a listed exception keeps the gap visible but not blocking.
      const exceptions = acceptUncovered ? (uncoveredExceptions || { head: commit, ...readUncoveredExceptions(commit) }) : null;
      if (exceptions && !uncoveredExceptions) for (const p of exceptions.problems) commitFinding('invalid_policy', `invalid policy: ${p}`);
      const { accepted, rest } = applyUncoveredExceptions(uncovered, exceptions, (e, f) => e.commit === commit && e.files.includes(f));
      if (rest.length) commitFinding('uncovered', `not covered by a packet: ${rest.join(', ')}`);
      for (const a of accepted) commitFinding('uncovered_accepted', acceptedText(a, exceptions.head));
      if (accepted.length) out.coverage.accepted = accepted;
    }

    // The re-runs, the test guard and the required CI re-runs start together and run side by
    // side (up to the memo's limit), in this order, so a check two of them need runs once: the
    // later one waits for it (memo.share). Their results are then judged in the same order as
    // when they ran one after another, so the findings and their order don't change.
    const rerunning = rerun && packetsAt.length ? rerunAt(commit, packetsAt, { mode: rerun, ciResults: ciResults || [], subject, signed: sigOf, links: cfgAt.snapshot.link, into: out.reruns, memo }) : null;
    const guardOnNet = Boolean(testGuardOnNet && commitGuard.files.length);
    // A one-commit range: test files no packet's guard covers are checked from the base
    // branch's rules, as a range of several commits checks them on its net change.
    const rulesRequired = rulesGuardFallback
      ? async () => {
        const hostReqs = useHost ? await hostRequirements(commitFiles, { rev: commit }) : [];
        const req = requirementsFor(commitFiles, { rules: rulesAt, hostRequirements: hostReqs, hostName });
        return useHost ? req.merged : req.repoOnly;
      }
      : null;
    const guardRunning = guardOnNet ? null : startTestGuard({ commit, out, commitGuard, guardJobs, guardRerun, cfgAt, signed: sigOf, memo, ciResults: ciResults || [], seed: guardSeed, rulesRequired });
    // verifyRange's re-run of a one-commit range's tip, started once this commit's guard has
    // claimed its runs (so the guard's baseline is the one run and the re-run reuses it).
    if (alongside) alongside({ packets: packetsAt, signed: sigOf });
    // Required CI results (verify.require_ci). Fails closed: with no results supplied at all,
    // every required command counts as missing. A passing re-run by this verify also counts.
    const requiredCiReruns = [];
    const requiredCiRunning = checkRequiredCiHere && rerun ? rerunRequiredCi(commit, cfgAt, { mode: rerun, ciResults: ciResults || [], subject, into: requiredCiReruns, memo }) : null;
    const [failures, guardRan] = await allSettled([rerunning, guardRunning, requiredCiRunning]);

    for (const f of failures || []) {
      const entry = out.packets.find((x) => x.id === f.packet);
      const blocking = blocks('rerun_failed');
      out.findings.push({ code: 'rerun_failed', detail: f.problem, blocking, packet: f.packet, unfinished: f.unfinished });
      if (entry) {
        if (blocking) {
          entry.ok = false;
          entry.problems.push(f.problem);
        } else entry.warnings.push(f.problem);
      }
    }
    if (guardOnNet) {
      commitGuard.mechanical = [];
      out.notes.push(`test change (${commitGuard.files.join(', ')}) is judged once, on the pull request's net change`);
    } else {
      await checkTestGuard({ out, commitGuard, guardJobs, acceptTestChange, acceptInconclusive, cfgAt, commitFinding, blocks, seed: guardSeed, ran: guardRan });
    }
    out.reruns.push(...requiredCiReruns);
    if (checkRequiredCiHere) checkRequiredCi(cfgAt, ciResults, subject, commitFinding, out.reruns, out.notes);
    applyRerunEvidence(out.packets, packetsAt, out.reruns);
    Object.defineProperty(out, 'packetData', { value: packetsAt, enumerable: false });
    Object.defineProperty(out, 'addFinding', { value: commitFinding, enumerable: false });
    Object.defineProperty(out, 'signedDigests', { value: sigOf, enumerable: false });
    Object.defineProperty(out, 'effectiveConfig', { value: cfgAt, enumerable: false });
    Object.defineProperty(out, 'effectiveRules', { value: rulesAt, enumerable: false });
    Object.defineProperty(out, 'changes', { value: commitChangeList, enumerable: false });

    if (out.packets.some((p) => !p.ok)) out.ok = false;
    emit('commit.verified', { commit, ok: out.ok });
    return out;
  }

  /**
   * The test guard in verify. With a re-run, the mechanical check runs again here, on the
   * commit and its parent, with nothing taken from local state. In block mode a test change
   * passes only on an independent mechanical pass (this re-run, or a proof signed by a
   * trusted key); anything else needs --accept-test-change, which is meant for a person.
   */
  /**
   * Start the test guard's re-runs for a commit (startTestGuard), so they run while verify's
   * own re-runs do. Resolves once all of them have ended to { jobs: [result or null per guard
   * job], rules: result or null }; checkTestGuard judges them.
   */
  function startTestGuard({ commit, out, commitGuard, guardJobs, guardRerun, cfgAt, signed, memo, ciResults, seed, rulesRequired = null }) {
    if (!commitGuard.files.length) return Promise.resolve(null);
    const base = g.parentOf(root, commit);
    const reruns = (job) => guardRerun && !(guardRerun === 'unsigned' && signed.get(obligationDigest(job.ob)) === 'valid' && job.proof?.passed);
    // The new code's baseline is the same run as a re-run or CI result for this commit, if one exists.
    const jobs = guardJobs.map((job) => (reruns(job) ? guardCheckFor(job.ob, { packet: job.packet, required: job.required, guardInfo: commitGuard, base, rev: commit, cfg: cfgAt, seed, memo, subject: out.subject, ciResults }) : null));
    // The rules' check for test files no packet's guard covers (one-commit ranges only, see
    // verify's rulesGuardFallback): the same check a range of several commits runs on its net
    // change. Packets keep their own path; a bad packet's findings are unaffected.
    const notInJobs = commitGuard.files.filter((f) => !guardJobs.some((j) => j.files.includes(f)));
    const rules = rulesRequired && guardRerun && notInJobs.length && (commitGuard.mode === 'block' || commitGuard.mode === 'attest')
      ? (async () => guardCheckFor({ id: 'rules', kind: 'guard', files: notInJobs, ...guardBudget(cfgAt) }, { packet: { id: 'rules', touches: [], obligations: [] }, required: await rulesRequired(), guardInfo: commitGuard, base, rev: commit, cfg: cfgAt, seed, memo, subject: out.subject, ciResults }))()
      : null;
    return allSettled([...jobs, rules]).then((done) => ({ jobs: done.slice(0, -1), rules: done[done.length - 1] }));
  }

  async function checkTestGuard({ out, commitGuard, guardJobs, acceptTestChange, acceptInconclusive = false, cfgAt, commitFinding, blocks, seed, ran }) {
    if (!commitGuard.files.length) return;
    const results = [];
    for (const [i, job] of guardJobs.entries()) {
      const entry = out.packets.find((e) => e.id === job.packet.id);
      const r = { packet: job.packet.id, obligation: job.ob.id, files: job.files };
      const res = ran.jobs[i];
      if (res) {
        Object.assign(r, { evidence: 'rerun', passed: res.passed, verdict: res.verdict, summary: res.summary, checks_from: res.checks_from, unfinished: Boolean(res.unfinished), result: res });
        out.reruns.push({ run: `test guard (${job.ob.id}, ${job.ob.mutants} mutants${seed !== undefined ? `, seed ${seed}` : ''})`, kind: 'guard', packets: [job.packet.id], status: res.passed ? 'passed' : 'failed', verdict: res.verdict, summary: res.summary, duration_ms: res.duration_ms });
        if (entry?.evidence) {
          if (res.passed) entry.evidence[job.ob.id] = 'mechanical:rerun';
          else if (!job.attestation) entry.evidence[job.ob.id] = 'mechanical:rerun-failed';
        }
        // The packet claimed a mechanical pass and it doesn't hold here.
        if (!res.passed && job.proof?.passed && !job.attestation && entry) {
          const problem = `test guard re-run failed: ${res.summary}`;
          // In block mode the re-run's own verdict decides (test_change or test_inconclusive
          // below, each with its own approval): this disagreement with the packet's recorded
          // pass stays visible as a warning, not a second block no approval could clear. In
          // attest mode it still blocks until attested. Required checks are re-run separately
          // and still block when they fail.
          const blocking = commitGuard.mode !== 'block' && blocks('rerun_failed');
          out.findings.push({ code: 'rerun_failed', detail: problem, blocking, packet: entry.id, unfinished: Boolean(res.unfinished) });
          if (blocking) {
            entry.ok = false;
            entry.problems.push(problem);
          } else entry.warnings.push(problem);
        }
      } else if (job.proof) {
        const independent = job.signed;
        Object.assign(r, { evidence: independent ? 'signed' : 'local', passed: job.proof.passed, verdict: job.proof.guard?.verdict || null, summary: job.proof.guard?.summary || null, checks_from: job.proof.guard?.checks_from || 'packet' });
      } else {
        Object.assign(r, { evidence: job.attestation ? 'attested' : null, passed: false, verdict: null, summary: null });
      }
      results.push(r);
    }
    const notInJobs = commitGuard.files.filter((f) => !guardJobs.some((j) => j.files.includes(f)));
    let rulesRun = null;
    if (ran.rules) {
      const res = ran.rules;
      const ob = { id: 'rules', ...guardBudget(cfgAt) };
      rulesRun = { packet: null, obligation: 'rules', files: notInJobs, evidence: 'rerun', passed: res.passed, verdict: res.verdict, summary: res.summary, checks_from: res.checks_from, unfinished: Boolean(res.unfinished), result: res };
      results.push(rulesRun);
      out.reruns.push({ run: `test guard (rules, ${ob.mutants} mutants${seed !== undefined ? `, seed ${seed}` : ''})`, kind: 'guard', packets: [], status: res.passed ? 'passed' : 'failed', verdict: res.verdict, summary: res.summary, duration_ms: res.duration_ms });
    }
    commitGuard.mechanical = results;
    // Attest mode with no packet: nothing can carry a sign-off, so a rules check that didn't
    // pass needs the approval, as on a range's net change.
    if (commitGuard.mode === 'attest' && rulesRun && !(rulesRun.passed && rulesRun.checks_from !== 'packet') && !acceptTestChange) {
      commitFinding('test_change', `existing tests or test setup changed (${notInJobs.join(', ')}); ${rulesRun.checks_from === 'packet' ? 'no rule requires a check covering these files, so nothing independent can run the old tests (add a requirement covering them)' : `the mechanical check did not pass: ${rulesRun.summary}`}. Re-run with --accept-test-change once a person approves`, { approval: 'tests', files: notInJobs });
    }
    if (commitGuard.mode !== 'block') return;
    // Independent: re-run here or signed by a trusted key, with checks the rules chose.
    const independentPass = (f) => results.some((r) => r.files.includes(f) && r.passed && (r.evidence === 'rerun' || r.evidence === 'signed') && r.checks_from !== 'packet');
    const missing = commitGuard.files.filter((f) => !independentPass(f));
    if (!missing.length) return;
    // A file whose re-run check failed only because a run didn't finish needs a different
    // approval: one for an unfinished run, not one for the test change (docs/REFERENCE.md).
    const unfinishedFor = (f) => {
      const failedHere = results.filter((r) => r.files.includes(f) && r.evidence === 'rerun' && !r.passed);
      return failedHere.length > 0 && failedHere.every((r) => r.unfinished);
    };
    const notFinished = missing.filter(unfinishedFor);
    if (notFinished.length && !acceptInconclusive) {
      const ran = results.find((r) => r.unfinished && r.summary);
      commitFinding('test_inconclusive', `existing tests or test setup changed (${notFinished.join(', ')}) and the check didn't finish: ${ran?.summary || 'a run timed out or was killed'}. Re-run verify, or re-run with --accept-inconclusive once a person approves`, { files: notFinished });
    }
    const toReview = missing.filter((f) => !unfinishedFor(f));
    if (!toReview.length || acceptTestChange) return;
    const failed = results.find((r) => r.verdict && r.verdict !== 'passed' && r.summary);
    // Two cases a maintainer's test approval doesn't resolve: the check passed on checks the
    // packet chose (a rule must require them), or it passed only on the author's machine (CI
    // must re-run it). Every other case is approvable.
    const [why, variant] = rulesRun?.checks_from === 'packet' && !results.some((r) => r !== rulesRun && r.passed)
      ? ['no rule requires a check covering these files, so nothing independent can run the old tests (add a requirement covering them)']
      : failed
      ? [`the mechanical check did not pass: ${failed.summary}`]
      : results.some((r) => r.passed && r.checks_from === 'packet')
        ? ['the mechanical check ran checks the packet chose, not ones a rule requires (add a requirement covering these tests)', 'packet_checks']
        : results.some((r) => r.passed)
        ? ['the mechanical check passed only locally (re-run verify with --rerun to check it here)', 'local_only']
        : ['no mechanical check covers them'];
    commitFinding('test_change', `existing tests or test setup changed (${toReview.join(', ')}); ${why}. Re-run with --accept-test-change once a person approves`, { files: toReview, ...(variant ? { variant } : { approval: 'tests' }) });
  }

  return { verify, findingSink, reportPolicy };
}
