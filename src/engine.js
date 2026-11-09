import fs from 'node:fs';

import path from 'node:path';
import * as g from './git.js';
import { createFsStore } from './store.js';
import { createProcessRunner, buildEnv } from './runner.js';
import { createIndexSnapshot } from './workspace.js';
import { digestMatches, randomId, sha256Hex } from './hash.js';
import { matchAny } from './glob.js';
import { describeObligation, isGuard, isRunnable, obligationDigest } from './obligations.js';
import { requirementsFor, validateRules } from './rules.js';
import * as P from './packets.js';
import { parseTrailers } from './trailer.js';
import { signProof, verifyProofSignature } from './sign.js';
import { detectTestChanges, effectiveGuardGlobs, guardRequirement } from './guard.js';
import { requirementCommands } from './test-setup.js';
import { runGuardCheck } from './guard-check.js';
import { ranAndFailed, runOutcome } from './run-result.js';
import { DEFAULT_EVAL_EXCLUDE } from './mutants.js';
import { createRunMemo, latestCiResults, PocpError, protectedChangeText, SEVERITIES, STAGES } from './engine/shared.js';
import { createMisses } from './engine/misses.js';
import { createRange } from './engine/range.js';
import { createRerun } from './engine/rerun.js';
import { createPolicyAt } from './engine/policy-at.js';
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

  // ---------------------------------------------------------------- packets

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

  // ------------------------------------------------------------------ proving

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

  // ------------------------------------------------------------------ verify

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

