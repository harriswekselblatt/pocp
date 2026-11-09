import fs from 'node:fs';

import path from 'node:path';
import * as g from './git.js';
import { createFsStore } from './store.js';
import { createProcessRunner, buildEnv } from './runner.js';
import { digestMatches, randomId, sha256Hex } from './hash.js';
import { matchAny } from './glob.js';
import { isRunnable, obligationDigest } from './obligations.js';
import { requirementsFor } from './rules.js';
import * as P from './packets.js';
import { parseTrailers } from './trailer.js';
import { detectTestChanges, effectiveGuardGlobs, guardRequirement } from './guard.js';
import { requirementCommands } from './test-setup.js';
import { runGuardCheck } from './guard-check.js';
import { DEFAULT_EVAL_EXCLUDE } from './mutants.js';
import { createRunMemo, latestCiResults, PocpError, protectedChangeText, SEVERITIES, STAGES } from './engine/shared.js';
import { createMisses } from './engine/misses.js';
import { createRange } from './engine/range.js';
import { createRerun } from './engine/rerun.js';
import { createPolicyAt } from './engine/policy-at.js';
import { createPackets } from './engine/packets.js';
import { createProve } from './engine/prove.js';
import { createVerify } from './engine/verify.js';
import { createGate } from './engine/gate.js';
import { createLand } from './engine/land.js';
import { EXCEPTIONS_FILE, POLICY_FILES, policyFilesTouched } from './policy.js';

// One version source: package.json, read relative to this module so it is right wherever pocp is installed.
export const VERSION = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
export { createRunMemo, latestCiResults, PocpError, protectedChangeText, SEVERITIES, STAGES };
export { EXCEPTIONS_FILE, POLICY_FILES };
const LOCKFILES = ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb', 'Cargo.lock', 'poetry.lock', 'go.sum', 'Gemfile.lock'];

const noopEvents = { emit() {} };

const noopPolicy = {};

/**
 * Create a POCP engine for the repository containing `cwd`.
 *
 * Interfaces (all optional): store, runner, policy, events. Options: now, newId, by, hostName.
 */
export function createPocp(opts = {}) {
  const root = g.repoRoot(opts.cwd || process.cwd());
  const store = opts.store || createFsStore(root);
  const runner = opts.runner || createProcessRunner();
  const policy = opts.policy || noopPolicy;
  const events = opts.events || noopEvents;
  const hostName = opts.hostName || policy.name || 'host';
  const nowFn = opts.now || (() => new Date().toISOString());
  const actor = opts.by || process.env.POCP_ACTOR || g.git(root, ['config', '--get', 'user.name'], { allowFail: true }) || 'unknown';

  const emit = (type, payload) => {
    try {
      events.emit(type, payload);
    } catch { /* events never break the engine */ }
  };

  const mutex = (fn) => (store.lock ? store.lock('pocp', fn) : fn());
  const mutexAsync = (fn) => (store.lockAsync ? store.lockAsync('pocp', fn) : fn());

  /**
   * During a merge, a staged file that matches a commit being merged in came from that
   * branch, whose own commits carry (and are verified with) their proofs. Only files that
   * differ from HEAD and from every merged commit (conflict resolutions, edits made during
   * the merge) are judged. CI's verify judges what a merge adds as part of the range's net change.
   */
  let mergeCache = null;
  function mergeFilter() {
    const heads = g.mergeHeads(root);
    if (!heads.length) return null;
    const subject = g.subjectHashIndex(root);
    if (mergeCache?.subject === subject) return mergeCache.info;
    const sets = heads.map((h) => new Set(g.stagedChanges(root, h).flatMap((c) => [c.path, c.oldPath].filter(Boolean))));
    const resolved = (p) => sets.every((s) => s.has(p));
    const info = { heads, keep: (c) => resolved(c.path) || Boolean(c.oldPath && resolved(c.oldPath)) };
    mergeCache = { subject, info };
    return info;
  }
  const mergeAware = (changes) => {
    const m = mergeFilter();
    return m ? changes.filter(m.keep) : changes;
  };

  /** Staged paths that count for coverage: code changes plus POCP policy files. */
  function stagedForCoverage({ amend = false } = {}) {
    // When amending, the new commit replaces HEAD, so compare with HEAD's parent.
    let base = null;
    if (amend) base = g.git(root, ['rev-parse', '--verify', '--quiet', 'HEAD^1'], { allowFail: true }) || g.emptyTree(root);
    const changes = amend ? g.stagedChanges(root, base) : mergeAware(g.stagedChanges(root, base));
    const files = g.changedPaths(changes);
    files.push(...policyFilesTouched(changes));
    return files;
  }

  const config = () => store.readConfig();
  const rules = () => store.readRules();

  async function hostRequirements(files, ctx = {}) {
    if (typeof policy.requirementsFor !== 'function') return [];
    return (await policy.requirementsFor(files, { root, ...ctx })) || [];
  }
  async function hostTriggers(files, ctx = {}) {
    if (typeof policy.triggersFor !== 'function') return null;
    return (await policy.triggersFor(files, { root, ...ctx })) || null;
  }

  /**
   * Requirements for a packet: rules (repo + host) plus, when the change being judged
   * modifies existing tests or test setup that the packet covers, the test guard.
   * `guardInfo` is a detectTestChanges() result; by default the staged change is used.
   */
  async function requiredFor(packet, rulesObj = rules(), guardInfo, changedFiles) {
    // Match requirements against the packet's literal paths AND the changed files it
    // actually covers. Matching patterns against patterns would let a catch-all packet
    // ("**") dodge every requirement.
    const files = effectiveFiles(packet, changedFiles === undefined ? stagedFilesCached() : changedFiles);
    const req = requirementsFor(files, {
      rules: rulesObj,
      hostRequirements: await hostRequirements(files, { packet: packet.id }),
      hostName,
    });
    const info = guardInfo === undefined ? stagedGuard() : guardInfo;
    const guarded = (info?.files || []).filter((f) => P.covers(packet, f));
    req.guard = info && info.mode !== 'off' && info.mode !== 'warn' && guarded.length ? [guardRequirement(guarded, config())] : [];
    return req;
  }

  /**
   * What the guard's mechanical check runs for a packet: the required checks for the files it
   * covers (from the rules in force, so the change can't pick its own), and the source those
   * rules guard as the place to plant mutants. With no required check, the packet's own.
   */
  function guardInputs(packet, required) {
    const seen = new Set();
    const checks = [];
    const sourceGlobs = new Set();
    for (const r of required) {
      if (!isRunnable(r.obligation) || seen.has(r.digest)) continue;
      seen.add(r.digest);
      checks.push({ ...r.obligation, id: r.id });
      for (const gl of r.globs) sourceGlobs.add(gl);
    }
    if (!checks.length) {
      for (const ob of packet.obligations.filter(isRunnable)) {
        if (seen.has(obligationDigest(ob))) continue;
        seen.add(obligationDigest(ob));
        checks.push(ob);
      }
      for (const t of packet.touches) sourceGlobs.add(t);
      return { checks, sourceGlobs: [...sourceGlobs], from: 'packet' };
    }
    return { checks, sourceGlobs: [...sourceGlobs], from: 'rules' };
  }

  /** Local cache of guard results by everything that decides them (prove only; verify never reads it). */
  function guardCacheKey(ob, { subject, base, inputs, guardInfo, cfg }) {
    const files = new Set(ob.files);
    const changes = (guardInfo.changes || []).filter((c) => files.has(c.path) || (c.oldPath && files.has(c.oldPath)));
    return sha256Hex(JSON.stringify({
      v: 1, subject, base, ob: obligationDigest(ob), checks: inputs.checks.map((c) => [obligationDigest(c), c.cwd || null]),
      source: [...inputs.sourceGlobs].sort(), changes, links: cfg.snapshot.link, exclude: cfg.eval?.exclude || null, globs: effectiveGuardGlobs(cfg),
    }));
  }
  function guardCacheFile(key) {
    return store.kind === 'fs' ? path.join(store.runsDir(), 'guard-cache', `${key}.json`) : null;
  }
  function readGuardCache(key) {
    const f = guardCacheFile(key);
    if (!f) return null;
    try {
      const r = JSON.parse(fs.readFileSync(f, 'utf8'));
      // A result that didn't finish says nothing about the tests: never reused, including
      // entries written before such results stopped being cached.
      return r && typeof r.verdict === 'string' && !r.unfinished ? r : null;
    } catch {
      return null;
    }
  }
  function writeGuardCache(key, res) {
    const f = guardCacheFile(key);
    // Under load a run times out; caching that would make it stick until the code changes.
    if (!f || res?.unfinished) return;
    try {
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, JSON.stringify(res));
    } catch { /* the cache is best effort */ }
  }

  /** Run the mechanical check for one guard obligation. `rev` null means the staged index. */
  /**
   * In verify, pass `memo` and `subject`: the guard's runs then count toward verify's limit on
   * checks at once, and its new-code baseline is shared with verify's re-runs (memo.share).
   */
  async function guardCheckFor(ob, { packet, required, guardInfo, base, rev, cfg, known, onPass, seed, memo, subject, ciResults = [] }) {
    const { checks, sourceGlobs, from } = guardInputs(packet, required);
    const files = new Set(ob.files);
    const changes = (guardInfo.changes || []).filter((c) => files.has(c.path) || (c.oldPath && files.has(c.oldPath)));
    const res = await runGuardCheck({
      root,
      runObligation: memo ? (o, dir, x) => memo.limit(() => runObligation(o, dir, x)) : runObligation,
      // In verify, the guard's own slots match verify's limit (--jobs): with fewer, its old-tests
      // runs queued behind its new-code baseline instead of running alongside it.
      ...(memo ? { jobs: memo.jobs } : {}),
      share: memo ? (o, run) => memo.share(subject, o, run, ciResults) : undefined,
      base,
      rev,
      changes,
      checks,
      sourceGlobs,
      mutants: ob.mutants,
      seed: seed ?? ob.seed,
      links: cfg.snapshot.link,
      exclude: cfg.eval?.exclude || DEFAULT_EVAL_EXCLUDE,
      guardGlobs: withNamedSetup(effectiveGuardGlobs(cfg), guardInfo),
      logPrefix: `guard-${packet.id}-${ob.id}`,
      known,
      onPass,
    });
    // Checks the packet chose itself (no rule requires one) could skip the changed tests.
    res.checks_from = from;
    return res;
  }

  /** Guard globs plus the setup files found by following references (exact paths). */
  function withNamedSetup(globs, guardInfo) {
    return { ...globs, runner: [...new Set([...globs.runner, ...(guardInfo?.named || [])])] };
  }

  function effectiveFiles(packet, changed) {
    return [...new Set([...packet.touches, ...changed.filter((f) => P.covers(packet, f))])].sort();
  }

  let stagedCache = null;
  function stagedFilesCached() {
    const subject = g.subjectHashIndex(root);
    if (stagedCache?.subject !== subject) stagedCache = { subject, files: stagedForCoverage() };
    return stagedCache.files;
  }

  let guardCache = null;
  function stagedGuard() {
    const subject = g.subjectHashIndex(root);
    if (guardCache?.subject === subject) return guardCache.info;
    let info = detectTestChanges(root, { config: config(), commands: requirementCommands(rules()) });
    const m = mergeFilter();
    if (m && info.files.length) {
      const keep = (c) => m.keep(c);
      const kept = (info.changes || []).filter(keep);
      const names = new Set(kept.flatMap((c) => [c.path, c.oldPath].filter(Boolean)));
      const next = { mode: info.mode, files: info.files.filter((f) => names.has(f)), signals: info.signals.filter((s) => names.has(s.file)) };
      Object.defineProperty(next, 'changes', { value: kept, enumerable: false });
      Object.defineProperty(next, 'base', { value: info.base, enumerable: false });
      // Keep the files the tests rely on (helpers, setup a command names) marked as test
      // setup, so the mechanical check never plants a mutant in them during a merge either.
      if (info.named) Object.defineProperty(next, 'named', { value: info.named, enumerable: false });
      info = next;
    }
    guardCache = { subject, info };
    return info;
  }

  // "Landed" is derived from git, never written: a packet has landed when a commit reachable
  // from HEAD carries its trailer and that trailer's subject matches the commit. Committed
  // packet files stay as they were proven, and the working copy stays clean after commits.
  let landedCache = null;
  const headNow = () => g.git(root, ['rev-parse', '--verify', '--quiet', 'HEAD'], { allowFail: true });
  function landedIndex(head = headNow()) {
    if (!head) {
      landedCache = null;
      return new Map();
    }
    if (landedCache?.head === head) return landedCache.map;
    const map = new Map(); // id -> [{ commit, subject }], newest first
    const mentions = new Map(); // id -> newest commit naming it anywhere in its message
    const out = g.git(root, ['log', '--grep=Proof-Of-Change:', '-i', '--format=%H%x1f%T%x1f%B%x1e', head], { allowFail: true, trim: false }) || '';
    for (const rec of out.split('\x1e')) {
      const [commit, tree, message] = rec.replace(/^\n/, '').split('\x1f');
      if (!commit || message === undefined) continue;
      for (const t of parseTrailers(message)) {
        if (!map.has(t.id)) map.set(t.id, []);
        map.get(t.id).push({ commit: commit.trim(), tree: tree.trim(), subject: t.subject });
      }
      // Squash and rebase merges keep the trailer text (often not in the last paragraph) but
      // not the proven tree.
      for (const m of message.matchAll(/^[ \t]*(?:[*-][ \t]+)?Proof-Of-Change:[ \t]*(p-[0-9a-z-]+)/gim)) {
        if (!mentions.has(m[1])) mentions.set(m[1], commit.trim());
      }
    }
    landedCache = { head, map, mentions };
    return map;
  }

  function landedIn(id, head) {
    const entries = landedIndex(head).get(id);
    if (!entries) return null;
    for (const e of entries) {
      if (digestMatches(treeSubject(e.tree, e.commit), e.subject)) return e.commit;
    }
    return null;
  }

  // A tree's subject hash never changes, so it is computed once per tree and kept in
  // .proof/runs (local, never committed). Hooks read it instead of listing old trees again.
  let subjectCache = null;
  let subjectCacheDirty = false;
  function subjectCacheFile() {
    return store.kind === 'fs' ? path.join(store.runsDir(), 'tree-subjects.json') : null;
  }
  function treeSubject(tree, commit) {
    if (!subjectCache) {
      subjectCache = new Map();
      const f = subjectCacheFile();
      try {
        if (f) for (const [k, v] of Object.entries(JSON.parse(fs.readFileSync(f, 'utf8')))) if (/^[0-9a-f]{40,64}$/.test(k) && typeof v === 'string') subjectCache.set(k, v);
      } catch { /* no cache yet */ }
    }
    const key = tree || commit;
    let subject = subjectCache.get(key);
    if (!subject) {
      subject = g.subjectHashRev(root, tree || commit);
      subjectCache.set(key, subject);
      subjectCacheDirty = true;
    }
    return subject;
  }
  function saveSubjectCache() {
    const f = subjectCacheFile();
    if (!f || !subjectCacheDirty) return;
    subjectCacheDirty = false;
    try {
      fs.mkdirSync(path.dirname(f), { recursive: true });
      const entries = [...subjectCache.entries()].slice(-5000);
      fs.writeFileSync(`${f}.tmp`, JSON.stringify(Object.fromEntries(entries)));
      fs.renameSync(`${f}.tmp`, f);
    } catch { /* the cache is best effort */ }
  }

  /**
   * The packet as it stands: its file, plus states derived on read (never written):
   *   landed  a reachable commit carries its trailer and that commit's code is what was proven;
   *   merged  a reachable commit names it, but its code differs from what was proven (a squash
   *           or rebase merge onto a moved branch, or code changed after proving);
   *   expired no activity for longer than packet_ttl_days.
   */
  function withLanded(p, head = headNow()) {
    if (!p || !P.isActive(p)) return p;
    const commit = landedIn(p.id, head);
    if (commit) return { ...p, state: 'landed', landed: { commit, derived: true } };
    const named = landedCache?.mentions?.get(p.id);
    if (named) return { ...p, state: 'merged', merged: { commit: named, derived: true } };
    const cfg = config();
    if (P.isStale(p, { now: nowFn(), ttlDays: cfg.packet_ttl_days })) return { ...p, state: 'expired', expired: { derived: true, ttl_days: cfg.packet_ttl_days } };
    return p;
  }

  function allPackets() {
    const head = headNow();
    const out = store.readPackets().map((p) => withLanded(p, head));
    saveSubjectCache();
    return out;
  }

  function loadPacket(idOrPrefix) {
    const exact = store.readPacket(idOrPrefix);
    if (exact) return withLanded(exact);
    const head = headNow();
    const matches = store.readPackets().filter((p) => p.id.startsWith(idOrPrefix)).map((p) => withLanded(p, head));
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) throw new PocpError(`packet id "${idOrPrefix}" is ambiguous: ${matches.map((p) => p.id).join(', ')}`);
    throw new PocpError(`no packet "${idOrPrefix}"`);
  }

  function savePacket(packet, { stage = false } = {}) {
    store.writePacket(packet);
    if (stage && store.kind === 'fs') g.addPaths(root, [store.packetRelPath(packet.id)]);
  }

  /** Active packets. Stale ones read as expired (nothing is written). */
  function activePackets() {
    const out = [];
    const head = headNow();
    for (const raw of store.readPackets()) {
      const p = withLanded(raw, head);
      if (p.state === 'expired' && P.isActive(raw)) emit('packet.expired', { id: p.id });
      if (P.isActive(p)) out.push(p);
    }
    saveSubjectCache();
    return out;
  }

  // ---------------------------------------------------------- running checks

  function lockfileHash(dir) {
    const cfg = config();
    const candidates = cfg.run.lockfile ? [cfg.run.lockfile] : LOCKFILES;
    for (const f of candidates) {
      const full = path.join(dir, f);
      if (fs.existsSync(full)) return sha256Hex(fs.readFileSync(full));
    }
    return null;
  }

  function runnerIdentity(dir) {
    return {
      pocp: VERSION,
      node: process.versions.node,
      platform: `${process.platform}-${process.arch}`,
      ci: Boolean(process.env.CI),
      lockfile_sha256: lockfileHash(dir),
    };
  }

  /** Signing key and principal: env vars override .proof/config.json. Off unless a key is set. */
  function signingSetup() {
    const cfg = config();
    const key = process.env.POCP_SIGN_KEY || cfg.sign?.key || null;
    if (!key) return null;
    const principal = process.env.POCP_SIGN_PRINCIPAL || cfg.sign?.principal || g.git(root, ['config', '--get', 'user.email'], { allowFail: true });
    return { key, principal };
  }

  function localSigners() {
    const f = path.join(root, '.proof', 'allowed_signers');
    return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
  }

  /** Index flags that would hide working-copy edits from the checks below. */
  function flagProblem() {
    const flagged = g.flaggedEntries(root);
    if (!flagged.length) return null;
    return {
      code: 'index_flags',
      detail: 'files are marked assume-unchanged or skip-worktree, so git would not report edits to them (clear the flags with git update-index --no-assume-unchanged / --no-skip-worktree, or use --mode snapshot)',
      files: flagged.slice(0, 20).map((e) => `${e.path} (${e.flag})`),
    };
  }

  function cleanProblems(paths) {
    const problems = [];
    const flags = flagProblem();
    if (flags) problems.push(flags);
    const diffs = g.worktreeDiffs(root);
    if (diffs.length) problems.push({ code: 'worktree_differs', detail: 'tracked files differ from what is staged', files: diffs.slice(0, 20) });
    if (paths.length) {
      const untracked = g.untrackedFiles(root).filter((f) => matchAny(f, paths));
      if (untracked.length) problems.push({ code: 'untracked_inputs', detail: 'untracked files inside touches or inputs', files: untracked.slice(0, 20) });
    }
    return problems;
  }

  /** Run one obligation in `dir`; returns the runner result plus pass/fail. */
  async function runObligation(ob, dir, { logName, keepCiFiles = false } = {}) {
    const cfg = config();
    const runId = randomId('r');
    const logFile = store.kind === 'fs' ? path.join(store.runsDir(), `${logName || runId}.log`) : null;
    const env = buildEnv({ mode: cfg.run.env, allow: cfg.run.env_allow, extra: { POCP: '1', POCP_OBLIGATION: ob.id }, keepCiFiles });
    const res = await runner.run(ob.run, {
      cwd: ob.cwd ? path.join(dir, ob.cwd) : dir,
      // The snapshot the check runs in, and the variables run.env_allow passes: the isolated
      // runner copies the snapshot for each check and gives it only those variables.
      root: dir,
      envAllow: cfg.run.env_allow || [],
      env,
      timeoutMs: ob.timeout_ms || cfg.run.timeout_ms,
      killGraceMs: cfg.run.kill_grace_ms,
      logFile,
      logCapBytes: cfg.run.log_cap_bytes,
    });
    let passed = res.exit === 0 && !res.timed_out && !res.error;
    if (passed && ob.expect) passed = new RegExp(ob.expect, 'm').test(res.output || '');
    return { ...res, passed, run_id: runId };
  }

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

