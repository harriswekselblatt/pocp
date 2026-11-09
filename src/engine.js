import fs from 'node:fs';
import * as g from './git.js';
import { createRunMemo, latestCiResults, PocpError, protectedChangeText, SEVERITIES, STAGES } from './engine/shared.js';
import { createMisses } from './engine/misses.js';
import { createRange } from './engine/range.js';
import { createRerun } from './engine/rerun.js';
import { createPolicyAt } from './engine/policy-at.js';
import { createContext } from './engine/context.js';
import { createRun } from './engine/run.js';
import { createPackets } from './engine/packets.js';
import { createProve } from './engine/prove.js';
import { createVerify } from './engine/verify.js';
import { createGate } from './engine/gate.js';
import { createLand } from './engine/land.js';
import { EXCEPTIONS_FILE, POLICY_FILES } from './policy.js';

// One version source: package.json, read relative to this module so it is right wherever pocp is installed.
export const VERSION = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
export { createRunMemo, latestCiResults, PocpError, protectedChangeText, SEVERITIES, STAGES };
export { EXCEPTIONS_FILE, POLICY_FILES };

/**
 * Create a POCP engine for the repository containing `cwd`.
 *
 * Interfaces (all optional): store, runner, policy, events. Options: now, newId, by, hostName.
 */
export function createPocp(opts = {}) {
  const { root, store, runner, hostName, nowFn, actor, emit, mutex, mutexAsync, mergeFilter, mergeAware, stagedForCoverage, config, rules, hostRequirements, hostTriggers, requiredFor, effectiveFiles, stagedGuard, allPackets, loadPacket, savePacket, activePackets } = createContext(opts);
  const { guardInputs, guardCacheKey, readGuardCache, writeGuardCache, guardCheckFor, runnerIdentity, signingSetup, localSigners, flagProblem, cleanProblems, runObligation } = createRun({ root, store, VERSION, config, runner });

  // ------------------------------------------------------------------- parts

  const { open, addObligation, widen, sync, ready, abandon, attest, deferToCi, evaluate, status } = createPackets({ activePackets, actor, emit, loadPacket, mutex, mutexAsync, nowFn, opts, requiredFor, root, savePacket, stagedForCoverage, stagedGuard, store });
  const { prove } = createProve({ store, activePackets, cleanProblems, config, emit, evaluate, guardCacheKey, guardCheckFor, guardInputs, loadPacket, localSigners, mutexAsync, nowFn, readGuardCache, requiredFor, root, runObligation, runnerIdentity, savePacket, signingSetup, stagedForCoverage, stagedGuard, writeGuardCache });
  const { rerunAt, rerunRequiredCi, checkRequiredCi, applyRerunEvidence, ciRun } = createRerun({ root, runObligation, flagProblem, runnerIdentity });
  const { readJsonAt, readRulesAt, policyAt, notEnrolled, policyInForce, readUncoveredExceptions, applyUncoveredExceptions, acceptedText, changedCiFiles } = createPolicyAt({ root });
  const { verify, findingSink, reportPolicy } = createVerify({ opts, root, emit, hostName, hostRequirements, hostTriggers, guardCheckFor, effectiveFiles, readJsonAt, readRulesAt, policyInForce, notEnrolled, readUncoveredExceptions, applyUncoveredExceptions, acceptedText, changedCiFiles, rerunAt, rerunRequiredCi, checkRequiredCi, applyRerunEvidence });
  const { gate, suggestPacket, checkEdit } = createGate({ root, store, hostName, nowFn, emit, config, rules, activePackets, stagedGuard, mergeFilter, mergeAware, hostRequirements, hostTriggers, evaluate, prove, policyAt, readRulesAt, changedCiFiles });
  const { trailers, addTrailersToFile, land } = createLand({ root, store, emit, stagedForCoverage, activePackets, evaluate });

  const { verifyRange } = createRange({ opts, root, emit, hostName, hostRequirements, hostTriggers, guardCheckFor, verify, policyAt, policyInForce, notEnrolled, readRulesAt, reportPolicy, findingSink, readUncoveredExceptions, applyUncoveredExceptions, acceptedText, changedCiFiles, checkRequiredCi, applyRerunEvidence, rerunAt, rerunRequiredCi });

  // ------------------------------------------------------------- misses/blame

  const { blame, recordMiss, loadMiss, ratchetRules, closeMiss } = createMisses({ opts, root, store, actor, nowFn, emit, mutexAsync, config, rules, runObligation });

  function isolatedVerify(fn) {
    // In a shallow clone a commit at the boundary looks like a root with no parent, so its own
    // (possibly deleted) policy would be taken as the base's. Verify needs the whole history.
    if (g.git(root, ['rev-parse', '--is-shallow-repository'], { allowFail: true }) === 'true') {
      return Promise.reject(new PocpError('this is a shallow clone: verify needs the full history to read the base\'s rules (fetch with fetch-depth: 0 on GitHub Actions, GIT_DEPTH: 0 on GitLab, or run git fetch --unshallow)', { code: 'shallow_history' }));
    }
    return g.withGitIsolation(root, fn).catch((err) => {
      throw err instanceof g.GitTamperError ? new PocpError(err.message, { code: 'git_tampered' }, { code: 'git_tampered' }) : err;
    });
  }

  return {
    root,
    store,
    version: VERSION,
    config,
    rules,
    loadPacket,
    activePackets,
    allPackets,
    open,
    addObligation,
    widen,
    sync,
    ready,
    abandon,
    attest,
    status,
    prove,
    gate,
    suggestPacket,
    checkEdit,
    trailers,
    addTrailersToFile,
    land,
    // Verify runs the code under review; its git calls are isolated from what that code can
    // change, and a change to the repository's git config, hooks or refs fails the verify.
    verify: (rev, o) => isolatedVerify(() => verify(rev, o)),
    verifyRange: (range, o) => isolatedVerify(() => verifyRange(range, o)),
    ciRun,
    blame,
    recordMiss,
    loadMiss,
    closeMiss,
    ratchetRules,
    runObligation,
    hostName,
    actor,
    deferToCi,
    /** Stage packet files (after `pocp fix` proves them). */
    stagePackets(ids) {
      if (store.kind === 'fs') g.addPaths(root, ids.map((id) => store.packetRelPath(id)));
    },
    _internals: { requiredFor, evaluate, cleanProblems },
  };
}

