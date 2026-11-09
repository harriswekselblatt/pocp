// Verifying a range of commits (a pull request): each commit judged by the policy at its base,
// then the net change (every commit and merge as one change), judged like a commit, with the
// test guard run on the whole pull request.
import * as g from '../git.js';
import { sha256Hex } from '../hash.js';
import { isGuard, isRunnable } from '../obligations.js';
import { evaluateTriggers, requirementsFor } from '../rules.js';
import * as P from '../packets.js';
import { detectTestChanges, guardBudget, isLegacyGuardObligation } from '../guard.js';
import { requirementCommands } from '../test-setup.js';
import { allSettled } from '../guard-check.js';
import { policyChange, policyFilesTouched } from '../policy.js';
import { createRunMemo, PocpError, protectedApprovalFiles, protectedChangeText } from './shared.js';

/**
 * Range verification for one engine. It gets the single-commit verify and the policy, rerun and
 * finding helpers it builds on; `opts` is the engine's options object (for its policy host).
 */
export function createRange({ opts, root, emit, hostName, hostRequirements, hostTriggers, guardCheckFor, verify, policyAt, policyInForce, notEnrolled, readRulesAt, reportPolicy, findingSink, readUncoveredExceptions, applyUncoveredExceptions, acceptedText, changedCiFiles, checkRequiredCi, applyRerunEvidence, rerunAt, rerunRequiredCi }) {
  /**
   * The guard's mutant sample seed for a check CI runs over a range: derived from the policy's
   * seed and the two revisions compared, so it is fixed for a given pull request (verify is
   * reproducible, and the seed is in the output) but differs from the seed a local `prove` uses.
   */
  function rangeGuardSeed(configSeed, oldRev, newRev) {
    return Number.parseInt(sha256Hex(`pocp-guard-seed\0${configSeed}\0${oldRev}\0${newRev}`).slice(0, 8), 16) & 0x7fffffff;
  }

  /**
   * A commit object with the tip's tree and the net base as its only parent: the whole range
   * as one change, merges included. Written to the object store only (no ref points to it), with
   * a fixed identity and date so the same range always gives the same object.
   */
  function netChangeCommit(netBase, tip) {
    const tree = g.git(root, ['rev-parse', '--verify', '--quiet', `${tip}^{tree}`]);
    const text = `tree ${tree}\nparent ${netBase}\nauthor pocp <pocp@invalid> 0 +0000\ncommitter pocp <pocp@invalid> 0 +0000\n\npocp net change ${netBase}..${tip}\n`;
    const id = g.git(root, ['hash-object', '-t', 'commit', '--stdin'], { input: text });
    // The id is predictable, so an object may already be stored under it (an earlier verify,
    // or something planted there). Git reads an object without checking its content against
    // its id, so one that is there must hold exactly this content.
    const stored = g.git(root, ['cat-file', 'commit', id], { allowFail: true, trim: false });
    if (stored === null) {
      g.git(root, ['hash-object', '-t', 'commit', '-w', '--stdin'], { input: text });
      g.trustObjects();
    } else if (stored !== text) {
      throw new g.GitTamperError(`the object store holds different content under the id of the net change's commit ${id.slice(0, 12)}: run verify on a fresh checkout`);
    }
    return id;
  }

  /**
   * Verify a range such as "origin/main..HEAD" (SPEC §7.2). Every non-merge commit is checked
   * on its own: digests, coverage and signatures (fast, nothing runs). Re-runs happen once, at
   * the tip of the range, for the union of checks across the range plus the checks the rules
   * require for the range's net change: the code being merged must still pass all of them.
   *
   * The range is also judged as one change, its net change: from the merge base of the range's
   * base and tip to the tip, merges included. The test guard and coverage run on it, so
   * splitting a test change and a code change across commits, or making either inside a merge
   * commit, gives the same verdict as making them in one commit. Nothing about it comes from the
   * author: verify computes it, like a re-run, and it fails closed (in block mode, a net test
   * change passes only on this verify's own mechanical re-run, or with --accept-test-change).
   */
  async function verifyRange(range, options = {}) {
    const list = (args) => (g.git(root, ['rev-list', ...args, range]) || '').split('\n').filter(Boolean);
    const commits = list(['--reverse', '--topo-order', '--no-merges']);
    const merges = list(['--merges']);
    const results = [];
    // Policy for every commit comes from the range's base unless told otherwise.
    const isRange = range.includes('..');
    const [baseSpec, tipSpec] = isRange ? range.split(/\.\.\.?/) : [null, range];
    const rangeBase = baseSpec || null;
    const policyFrom = options.policyFrom !== undefined ? options.policyFrom : rangeBase || undefined;
    const any = commits.length > 0 || merges.length > 0;
    // The tip is the code being merged: the range's right side, which may itself be a merge.
    const tip = any ? g.resolveRev(root, tipSpec || 'HEAD') : null;
    const lastCommit = commits.length ? commits[commits.length - 1] : null;
    const policyBase = policyFrom ? g.resolveRev(root, policyFrom) : null;
    const pol = tip ? policyInForce(tip, policyBase, options) : null;
    const baseRev = isRange && rangeBase && tip ? g.resolveRev(root, rangeBase) : null;
    const netBase = baseRev ? g.git(root, ['merge-base', baseRev, tip], { allowFail: true }) : null;
    // No common history (an unrelated branch, missing objects): there is no pull request's net
    // change to judge, so fail rather than compare against an arbitrary base.
    if (baseRev && !netBase) throw new PocpError(`${rangeBase} and ${tipSpec || 'HEAD'} share no history here, so the net change can't be computed (fetch the full history of both)`, { code: 'no_merge_base' });
    // One plain commit on the base: its own check is the net change's check, so it isn't run twice.
    const single = merges.length === 0 && commits.length === 1 && tip === lastCommit && netBase
      && g.parentOf(root, lastCommit) === netBase;
    const seed = netBase && pol ? rangeGuardSeed(guardBudget(pol.cfgAt).seed, netBase, tip) : undefined;

    // The net change's commit is written before any code under review runs: verify trusts the
    // object store as it was then (git.js watches it from the start of isolation).
    const synth = netBase && !single ? netChangeCommit(netBase, tip) : null;

    // Required CI results are checked once, at the tip (where CI ran), after the range's re-runs.
    const memo = createRunMemo({ jobs: options.jobs });
    const rerun = options.rerun === true ? 'all' : options.rerun;
    // The tip's re-run of every packet's checks. It runs side by side with the test guard (the
    // one-commit range's own, or the net change's); a check both need runs once (memo.share).
    let tipRerun = null;
    const startTipRerun = (packets, signed) => {
      const into = [];
      const done = rerunAt(tip, packets, { mode: rerun, ciResults: options.ciResults || [], signed, links: pol.cfgAt.snapshot.link, into, memo });
      tipRerun = { into, done: done.then((failures) => ({ failures }), (err) => ({ err })) };
    };
    // Exceptions come from the code being merged, and count only with an approval for it.
    const uncoveredExceptions = options.acceptUncovered && tip ? { head: tip, ...readUncoveredExceptions(tip) } : null;
    try {
      for (const c of commits) {
        // With a net change, a test change is judged once, on the whole pull request (old tests
        // from the merge base, new code from the tip): that check alone decides, so running it
        // again on each commit only multiplied the cost (the slowest part of verify).
        // A one-commit range's tip is that commit: its re-run starts alongside the commit's guard.
        const alongside = single && rerun ? ({ packets, signed }) => startTipRerun(tipPackets([{ packetData: packets }], null), signed) : null;
        results.push(await verify(c, { ...options, uncoveredExceptions, policyFrom, rerun: false, guardRerun: synth ? false : (options.rerun || false), testGuardOnNet: Boolean(synth), rulesGuardFallback: single, checkRequiredCiHere: false, guardSeed: single ? seed : undefined, memo, alongside }));
      }
    } catch (err) {
      if (tipRerun) await tipRerun.done; // never leave a re-run running in folders being removed
      throw err;
    }
    const result = { range, ok: results.every((r) => r.ok), commits: results, reruns: [], findings: [] };
    for (const p of uncoveredExceptions?.problems || []) {
      result.findings.push({ code: 'invalid_policy', detail: `invalid policy: ${p}`, blocking: true });
      result.ok = false;
    }
    if (!any) return result;

    let net = null;
    if (synth) net = await prepareNetChange({ tip, netBase, synth, pol, options });
    else if (!netBase && commits.length + merges.length > 1) result.notes = [`no range base, so the range's net change was not judged as one change`];

    const headResult = tip === lastCommit ? results[results.length - 1] : null;
    // A signature covers the commit it was made on; when the tip is a merge, none covers the tip.
    if (rerun && !tipRerun) startTipRerun(tipPackets(results, net), headResult ? headResult.signedDigests : new Map());
    // Started after the tip's re-run, as they ran before: a check they share with it is its run.
    const netGuard = net ? startNetGuard(net, { options, memo, seed }) : null;
    // Required CI results belong to the tip's code: the last commit's result, or the net change's when the tip is a merge.
    const tipSubject = tip ? g.subjectHashRev(root, tip) : null;
    const requiredCiReruns = [];
    // With --rerun, verify runs the required CI commands itself at the tip (no results file needed).
    const requiredCi = rerun && (headResult || net) ? rerunRequiredCi(tip, pol.cfgAt, { mode: rerun, ciResults: options.ciResults || [], subject: tipSubject, into: requiredCiReruns, memo }) : null;
    const [tipDone, netGuardRes] = await allSettled([tipRerun?.done, netGuard, requiredCi]);
    if (tipDone?.err) throw tipDone.err;

    if (rerun) {
      const failures = tipDone.failures;
      result.reruns.push(...tipRerun.into);
      if (failures.length) {
        // Range-level findings carry code and blocking like a commit's.
        const blocking = pol.failOn.has('rerun_failed');
        result.rerun_failures = failures.map((f) => ({ code: 'rerun_failed', detail: f.problem, blocking, ...f }));
        result.findings.push(...result.rerun_failures.map(({ code, detail, packet }) => ({ code, detail, blocking, packet })));
        if (blocking) result.ok = false;
        else result.warnings = [...(result.warnings || []), ...failures.map((f) => f.problem)];
      }
      if (headResult) applyRerunEvidence(headResult.packets, headResult.packetData || [], result.reruns);
    }
    if (net) {
      result.net = await judgeNetChange(net, { results, merges, lastCommit, policyBase, options: { ...options, uncoveredExceptions }, seed, guardRes: netGuardRes });
      result.ok = result.ok && result.net.ok;
    }
    const tipOut = headResult || result.net;
    if (tipOut) {
      const finding = headResult ? headResult.addFinding : findingSink(result.net, pol.blocks);
      result.reruns.push(...requiredCiReruns);
      checkRequiredCi(pol.cfgAt, options.ciResults, tipSubject, finding, result.reruns, tipOut.notes);
      result.ok = result.ok && tipOut.ok;
    } else if ((pol.cfgAt.verify?.require_ci || []).length) {
      // A merge tip with no net change to judge (no range base): nothing to attach results to, so fail closed.
      result.ok = false;
      const detail = 'required CI results could not be checked: the tip is a merge and the range has no base';
      result.notes = [...(result.notes || []), detail];
      result.findings.push({ code: 'ci_missing', detail, blocking: true });
    }
    return result;
  }

  /** The checks the tip's re-run runs: each packet in the range once (the latest commit's copy), and the net change's. */
  function tipPackets(results, net) {
    const packets = [];
    const seenIds = new Set();
    for (const r of [...results].reverse()) {
      for (const p of r.packetData || []) if (!seenIds.has(p.id)) { seenIds.add(p.id); packets.push(p); }
    }
    if (net?.obligations.length) packets.push({ id: 'net-change', obligations: net.obligations });
    return packets;
  }

  /** What the net change is, before the tip's re-runs: its changes, test guard and required checks. */
  async function prepareNetChange({ tip, netBase, synth, pol, options }) {
    const useHost = options.useHost ?? Boolean(opts.policy);
    const changes = g.commitChanges(root, synth);
    const paths = g.changedPaths(changes);
    const files = [...paths];
    files.push(...policyFilesTouched(changes));
    const guard = detectTestChanges(root, { to: synth, config: pol.cfgAt, commands: requirementCommands(pol.rulesAt) });
    const hostReqs = useHost ? await hostRequirements(files, { rev: tip }) : [];
    const req = requirementsFor(files, { rules: pol.rulesAt, hostRequirements: hostReqs, hostName });
    const required = useHost ? req.merged : req.repoOnly;
    const obligations = required.filter((r) => isRunnable(r.obligation)).map((r) => ({ ...r.obligation, id: r.id }));
    return { tip, netBase, synth, changes, paths, files, guard, required, obligations, pol, useHost };
  }

  /**
   * Judge the net change: policy and CI files when the tip is a merge (no per-commit result saw
   * them), the test guard, and coverage. A result shaped like a commit's, with kind "net".
   */
  /**
   * Start the test guard on the net change (old tests and setup from the net base, new code and
   * tests from the tip), or null when there is none to run. judgeNetChange reads its result.
   */
  function startNetGuard(net, { options, memo, seed }) {
    const { tip, netBase, synth, guard, required, pol } = net;
    const guardRerun = options.rerun === true ? 'all' : options.rerun;
    if (!guard.files.length || guard.mode === 'warn' || !guardRerun) return null;
    const ob = { id: 'net', kind: 'guard', files: guard.files, ...guardBudget(pol.cfgAt) };
    return guardCheckFor(ob, {
      packet: { id: 'net-change', touches: [], obligations: [] }, required, guardInfo: guard, base: netBase, rev: synth, cfg: pol.cfgAt, seed,
      memo, subject: g.subjectHashRev(root, tip), ciResults: options.ciResults || [],
    });
  }

  async function judgeNetChange(net, { results, merges, lastCommit, policyBase, options, seed, guardRes = null }) {
    const { tip, netBase, changes, paths, files, guard, pol, useHost } = net;
    const { cfgAt, rulesAt, blocks } = pol;
    const subject = g.subjectHashRev(root, tip);
    const span = `${netBase.slice(0, 12)}..${tip.slice(0, 12)}`;
    const out = { kind: 'net', commit: tip, base: netBase, subject, ok: true, merges: merges.length, packets: [], coverage: null, reruns: [], notes: [], warnings: [], findings: [], test_guard: null, seed: seed ?? null };
    const finding = findingSink(out, blocks);
    out.notes.push(`net change ${span} judged as one change (${results.length} commit(s), ${merges.length} merge(s))`);

    // When the tip is a merge commit, no per-commit result looked at the final policy or CI files.
    const touchedByCommits = new Set(results.flatMap((r) => (r.changes || []).flatMap((c) => [c.path, c.oldPath].filter(Boolean))));
    if (tip !== lastCommit) reportPolicy(finding, out, { baseRev: policyBase, ...pol });
    const ciFiles = changedCiFiles(changes, cfgAt);
    const ciUnseen = ciFiles.filter((f) => !touchedByCommits.has(f));
    if (ciUnseen.length && !options.acceptPolicyChange) {
      finding('ci_config_changed', `${protectedChangeText(ciUnseen)} in a merge commit; re-run with --accept-policy-change once a maintainer approves`, { files: protectedApprovalFiles(ciUnseen) });
    }

    // Test guard on the net change: the old tests and test setup from the net base, the new code
    // and tests from the tip. Only this verify's own re-run can pass it.
    if (guard.files.length) {
      out.test_guard = guard;
      const results2 = [];
      const guardRerun = options.rerun === true ? 'all' : options.rerun;
      if (guardRes) {
        const ob = { id: 'net', ...guardBudget(cfgAt) };
        const res = guardRes;
        results2.push({ packet: null, obligation: 'net', files: guard.files, evidence: 'rerun', passed: res.passed, verdict: res.verdict, summary: res.summary, checks_from: res.checks_from, seed, result: res });
        out.reruns.push({ run: `test guard (net change ${span}, ${ob.mutants} mutants, seed ${seed})`, kind: 'guard', packets: [], status: res.passed ? 'passed' : 'failed', verdict: res.verdict, summary: res.summary, duration_ms: res.duration_ms });
      }
      guard.mechanical = results2;
      const r = results2[0];
      const independent = Boolean(r?.passed && r.checks_from !== 'packet');
      const why = !guardRerun || !r
        ? 'the net change was not re-checked here (verify the range with --rerun: the check runs on the whole pull request, so no proof made on one commit can stand in for it)'
        : r.checks_from === 'packet'
          ? 'no rule requires a check covering these files, so nothing independent can run the old tests (add a requirement covering them)'
          : `the mechanical check did not pass: ${r.summary}`;
      const detail = `existing tests or test setup changed (${guard.files.join(', ')}) in the pull request's net change ${span}; ${why}. Re-run with --accept-test-change once a person approves`;
      const testApproval = { approval: 'tests', files: guard.files };
      const netUnfinished = Boolean(guardRerun && r && !r.passed && r.result?.unfinished);
      if (guard.mode === 'block' && !independent && netUnfinished) {
        if (!options.acceptInconclusive) finding('test_inconclusive', `existing tests or test setup changed (${guard.files.join(', ')}) in the pull request's net change ${span} and the check didn't finish: ${r.summary}. Re-run verify, or re-run with --accept-inconclusive once a person approves`, { files: guard.files });
      } else if (guard.mode === 'block' && !independent && !options.acceptTestChange) finding('test_change', detail, testApproval);
      else if (guard.mode === 'attest' && !independent && !options.acceptTestChange) {
        // Attest mode accepts a recorded sign-off on a test change; a check that ran here and
        // failed needs one for every changed file, from some packet in the range.
        const attested = (f) => results.some((x) => (x.packetData || []).some((p) => p.obligations.some((o) => (isGuard(o) || isLegacyGuardObligation(o)) && (o.files || x.test_guard?.files || []).includes(f) && P.currentAttestation(p, o, x.subject))));
        if (guardRerun && r && !guard.files.every(attested)) finding('test_change', detail, testApproval);
        else if (!guardRerun) out.warnings.push(detail);
      }
    }

    if (options.requireCoverage) {
      const trig = evaluateTriggers(paths, {
        rules: rulesAt,
        hostTriggers: useHost ? await hostTriggers(files, { rev: tip }) : null,
        hostRequirements: useHost ? await hostRequirements(files, { rev: tip }) : [],
        config: cfgAt,
        hostName,
      });
      // A range that adopts POCP (no policy at its base) creates the first policy: not a change.
      const pc = notEnrolled(netBase) ? null : policyChange(changes, rulesAt, readRulesAt(netBase));
      if (pc) {
        trig.required_files = [...new Set([...trig.required_files, ...pc.files])].sort();
        trig.reasons.push(pc.reason);
      }
      if (ciFiles.length) {
        trig.required_files = [...new Set([...trig.required_files, ...ciFiles])].sort();
        trig.reasons.push({ code: 'ci_config', detail: protectedChangeText(ciFiles), files: ciFiles });
      }
      if (guard.files.length && guard.mode !== 'warn') {
        trig.required_files = [...new Set([...trig.required_files, ...guard.files])].sort();
        trig.reasons.push({ code: 'test_change', detail: 'existing tests or test setup changed', files: guard.files });
      }
      // One rule for rules-based coverage, per commit and net alike: a file's requirements,
      // protected paths and trigger globs are judged where it changed, by the policy at that
      // commit. So a file some commit's own check already judged is required again here only
      // by what concerns the whole change (broad, cross-area, test setup), or by the base's
      // policy (a range can't loosen that). A rule added inside the range applies from its own
      // commit on, not back to files changed before it. Files no per-commit check saw (merge
      // content) are judged by the policy in force at the tip, as before.
      const basePol = policyAt(netBase);
      const baseTrig = evaluateTriggers(paths, { rules: basePol.rules, config: basePol.config, hostName });
      const baseCi = new Set(changedCiFiles(changes, basePol.config));
      const ruleCodes = new Set(['requirement', 'glob']);
      const wholeChange = new Set(trig.reasons.filter((r) => !ruleCodes.has(r.code) && r.code !== 'ci_config').flatMap((r) => r.files || []));
      const byBase = new Set([...baseTrig.required_files, ...baseCi]);
      const notRetroactive = trig.required_files.filter((f) => touchedByCommits.has(f) && !wholeChange.has(f) && !byBase.has(f));
      if (notRetroactive.length) {
        trig.required_files = trig.required_files.filter((f) => !notRetroactive.includes(f));
        out.notes.push(`required only by policy added inside the range, and judged by its own commit's policy: ${notRetroactive.join(', ')}`);
      }
      // Any packet in the range may cover a file; files a commit already reported are not repeated.
      const packets = results.flatMap((x) => x.packetData || []);
      const reported = new Set(results.flatMap((x) => x.coverage?.uncovered || []));
      const uncovered = trig.required_files.filter((f) => !packets.some((p) => P.covers(p, f)) && !reported.has(f));
      out.coverage = { required_files: trig.required_files, uncovered, reasons: trig.reasons };
      // An exception covers a net-change file only if it names a commit in the range that changed it.
      const changedBy = new Map(results.map((x) => [x.commit, new Set((x.changes || []).flatMap((c) => [c.path, c.oldPath].filter(Boolean)))]));
      const exceptions = options.uncoveredExceptions || null;
      const { accepted, rest } = applyUncoveredExceptions(uncovered, exceptions, (e, f) => e.files.includes(f) && Boolean(changedBy.get(e.commit)?.has(f)));
      if (rest.length) finding('uncovered', `not covered by a packet in the range (changed in the net change ${span}): ${rest.join(', ')}`);
      for (const a of accepted) finding('uncovered_accepted', acceptedText(a, exceptions.head));
      if (accepted.length) out.coverage.accepted = accepted;
    }
    Object.defineProperty(out, 'addFinding', { value: finding, enumerable: false });
    if (out.findings.some((f) => f.blocking)) out.ok = false;
    emit('range.net_verified', { commit: tip, base: netBase, ok: out.ok });
    return out;
  }

  return { verifyRange };
}
