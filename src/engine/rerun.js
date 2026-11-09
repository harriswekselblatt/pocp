// Re-running checks on a commit's exact code: the packets' checks (rerunAt), the checks
// verify.require_ci lists (rerunRequiredCi, checkRequiredCi), what a re-run says about each
// recorded proof (applyRerunEvidence), and recording a CI test step's result (ciRun).
import * as g from '../git.js';
import { createRevCheckout } from '../workspace.js';
import { isRunnable, obligationDigest } from '../obligations.js';
import { allSettled } from '../guard-check.js';
import { ranAndFailed, runOutcome, unfinishedReason } from '../run-result.js';
import { outputTail } from '../output-tail.js';
import { ciKey, createRunMemo, latestCiResults, PocpError } from './shared.js';

/** Re-runs for one engine: `runObligation` runs one check; `flagProblem` and `runnerIdentity` describe the run. */
export function createRerun({ root, runObligation, flagProblem, runnerIdentity }) {
  /**
   * Re-run checks in a clean checkout of `commit`, once per distinct check.
   * mode "all" re-runs everything; "unsigned" skips checks whose proof is validly signed
   * by an allowed signer. A check with a passing CI result recorded by `pocp ci-run` for
   * this exact subject and command is skipped. Returns failures as [{ packet, problem }].
   */
  async function rerunAt(commit, packets, { mode = 'all', ciResults = [], subject, signed = new Map(), links, into = [], memo = createRunMemo() }) {
    const subj = subject || g.subjectHashRev(root, commit);
    // The latest record for a command decides: a later failure overrides an earlier pass.
    const ran = new Set(latestCiResults(ciResults.filter((r) => r.subject === subj)).filter((r) => r.passed).map(ciKey));
    const jobs = new Map(); // digest -> { ob, packets: [] }
    for (const packet of packets) {
      for (const ob of packet.obligations.filter(isRunnable)) {
        const d = obligationDigest(ob);
        if (!jobs.has(d)) jobs.set(d, { ob, packets: [] });
        jobs.get(d).packets.push(packet.id);
      }
    }
    const failures = [];
    const todo = [];
    const entries = []; // in job order, whatever order the runs finish in
    for (const [d, job] of jobs) {
      // A CI result can't stand in for a check that also matches output (`expect`).
      if (ran.has(`${job.ob.cwd || ''}\0${job.ob.run}`) && !job.ob.expect) entries.push({ run: job.ob.run, digest: d, packets: job.packets, status: 'skipped: passing CI result for this code', evidence: 'ci-result' });
      else if (mode === 'unsigned' && signed.get(d) === 'valid') entries.push({ run: job.ob.run, digest: d, packets: job.packets, status: 'skipped: signed by an allowed signer', evidence: 'signed' });
      else {
        job.at = entries.length;
        entries.push(null);
        todo.push(job);
      }
    }
    // Each check gets its own fresh copy of the commit (no .git), so one check's code can't
    // change the files another check runs. The checks run side by side, up to verify's limit;
    // one this verify already ran (or is running, in the test guard) on this code is reused.
    const done = await allSettled(todo.map((job) => memo.share(subj, job.ob, () => memo.limit(async () => {
      const co = createRevCheckout(root, commit, { links });
      try {
        return await runObligation(job.ob, co.dir);
      } finally {
        co.cleanup();
      }
    }))));
    todo.forEach((job, i) => {
      const { reused, result: r } = done[i];
      if (reused) {
        entries[job.at] = { run: job.ob.run, cwd: job.ob.cwd || null, subject: subj, digest: obligationDigest(job.ob), packets: job.packets, status: 'passed', reused: 'already run on this commit by this verify', duration_ms: 0 };
        return;
      }
      entries[job.at] = { run: job.ob.run, cwd: job.ob.cwd || null, subject: subj, digest: obligationDigest(job.ob), packets: job.packets, status: r.passed ? 'passed' : 'failed', exit: r.exit, timed_out: r.timed_out, ...(r.signal ? { signal: r.signal } : {}), ...(r.error ? { error: r.error } : {}), duration_ms: r.duration_ms };
      // What a failed check printed (its end), for verify's report only: never part of a proof.
      if (!r.passed) {
        const tail = outputTail(r.output);
        if (tail) Object.assign(entries[job.at], { output_tail: tail, ...(r.truncated ? { output_truncated: true } : {}) });
      }
      // unfinished: it timed out, was killed or didn't start, so it says nothing about the code.
      if (!r.passed) {
        const unfinished = runOutcome(r) === 'unfinished';
        const problem = unfinished
          ? `rerun of "${job.ob.run}" didn't finish (exit ${r.exit}, ${unfinishedReason(r)})`
          : `rerun of "${job.ob.run}" failed (exit ${r.exit})`;
        for (const id of job.packets) failures.push({ packet: id, problem, unfinished });
      }
    });
    into.push(...entries);
    return failures;
  }

  /**
   * With --rerun, verify runs each verify.require_ci command that no packet check already
   * re-ran, so the default CI recipe (verify --rerun, no results file) satisfies require_ci.
   */
  async function rerunRequiredCi(commit, cfg, { mode, ciResults, subject, into, memo }) {
    const cmds = cfg.verify?.require_ci || [];
    if (!cmds.length) return;
    const packet = { id: 'verify.require_ci', obligations: cmds.map((run, i) => ({ id: `require_ci-${i + 1}`, kind: 'test', run })) };
    await rerunAt(commit, [packet], { mode, ciResults, subject, links: cfg.snapshot.link, into, memo });
  }

  /**
   * verify.require_ci: each listed command needs a passing result for this exact code: the
   * latest ci-result for it, or a passing re-run of the same command by this verify.
   */
  function checkRequiredCi(cfg, ciResults, subject, finding, reruns = [], notes = []) {
    for (const cmd of cfg.verify?.require_ci || []) {
      const rerunHit = reruns.find((r) => r.run === cmd && r.subject === subject && r.status === 'passed');
      if (rerunHit) {
        notes.push(`required CI check "${cmd}" passed when re-run by this verify`);
        continue;
      }
      const failedRuns = reruns.filter((r) => r.run === cmd && r.subject === subject && r.status === 'failed');
      if (failedRuns.length) {
        // A re-run that timed out, was killed or didn't start says nothing about the code: it
        // waits for a re-run (ci_unfinished), it isn't a failure. One that ran and failed is.
        if (failedRuns.every((r) => !ranAndFailed({ passed: false, exit: r.exit, timed_out: r.timed_out, signal: r.signal, error: r.error }))) {
          finding('ci_unfinished', `required CI check "${cmd}" didn't finish when re-run by this verify (${failedRuns.some((r) => r.timed_out) ? 'timed out' : 'no exit code'}): re-run verify`);
        } else finding('ci_failed', `required CI check "${cmd}" failed when re-run by this verify`);
        continue;
      }
      const records = (ciResults || []).filter((r) => r.run === cmd && r.subject === subject);
      if (records.length && records[records.length - 1].passed) continue;
      if (records.length) finding('ci_failed', `required CI check "${cmd}" failed on this code (latest result)`);
      else if (!ciResults) finding('ci_missing', `required CI check "${cmd}" has no result for this code (no CI results were supplied)`);
      else finding('ci_missing', `required CI check "${cmd}" has no result for this code`);
    }
  }

  /** Upgrade evidence labels for checks this verify re-ran or matched to a CI result. */
  function applyRerunEvidence(entries, packets, reruns) {
    const byDigest = new Map(reruns.filter((r) => r.digest).map((r) => [r.digest, r]));
    for (const packet of packets) {
      const entry = entries.find((e) => e.id === packet.id);
      if (!entry?.evidence) continue;
      for (const ob of packet.obligations.filter(isRunnable)) {
        const r = byDigest.get(obligationDigest(ob));
        if (!r) continue;
        if (r.evidence === 'ci-result') entry.evidence[ob.id] = 'ci-result';
        else if (r.status === 'passed') entry.evidence[ob.id] = 'rerun';
        else if (r.status === 'failed') entry.evidence[ob.id] = 'rerun-failed';
      }
    }
  }

  /**
   * CI-side check run: run `command` against HEAD (the working folder must match it) and
   * return a result record bound to HEAD's subject hash and the exact command text.
   * The command's exit code is passed through, so this can replace a CI test step.
   */
  async function ciRun(command, { env, cwd } = {}) {
    const flags = flagProblem();
    if (flags) throw new PocpError('ci-run needs a clean checkout of the commit: some files are flagged so their edits are invisible to git', { problems: [flags] });
    const diffs = g.worktreeDiffs(root);
    const staged = g.stagedChanges(root);
    if (diffs.length || g.changedPaths(staged).length) {
      throw new PocpError('ci-run needs a clean checkout of the commit: the working folder differs from HEAD', { problems: [{ code: 'worktree_differs', detail: 'files differ from HEAD', files: [...diffs, ...g.changedPaths(staged)].slice(0, 20) }] });
    }
    const commit = g.resolveRev(root, 'HEAD');
    const subject = g.subjectHashRev(root, commit);
    const started_at = new Date().toISOString();
    const r = await runObligation({ id: 'ci', kind: 'test', run: command, ...(cwd ? { cwd } : {}) }, root, { env, keepCiFiles: true });
    return {
      pocp: 1,
      kind: 'ci-result',
      commit,
      subject,
      run: command,
      cwd: cwd || null,
      exit: r.exit,
      timed_out: r.timed_out,
      passed: r.passed,
      started_at,
      duration_ms: r.duration_ms,
      stdout_sha256: r.stdout_sha256,
      stderr_sha256: r.stderr_sha256,
      runner: runnerIdentity(root),
      ci: ['GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT', 'GITHUB_SHA', 'CI_PIPELINE_ID', 'BUILDKITE_BUILD_ID'].reduce((o, k) => (process.env[k] ? { ...o, [k]: process.env[k] } : o), {}),
    };
  }

  return { rerunAt, rerunRequiredCi, checkRequiredCi, applyRerunEvidence, ciRun };
}
