import fs from 'node:fs';

import path from 'node:path';
import * as g from './git.js';
import { configWeakening, createFsStore, DEFAULT_CI_FILES, formatProblem, rulesWithDefaults, strictConfig, validateConfig, withDefaults } from './store.js';
import { createProcessRunner, buildEnv } from './runner.js';
import { createIndexSnapshot, createRevCheckout } from './workspace.js';
import { digestMatches, randomId, sha256Hex } from './hash.js';
import { matchAny, matchGlob } from './glob.js';
import { describeObligation, isGuard, isRunnable, obligationDigest, ValidationError } from './obligations.js';
import { evaluateTriggers, globsOf, normalizeRequirement, policyDigest, policyWeakening, requirementsFor, ruleWarnings, strictUnion, validateRules } from './rules.js';
import * as P from './packets.js';
import { formatTrailer, parseTrailers, TRAILER_KEY } from './trailer.js';
import { signProof, verifyProofSignature } from './sign.js';
import { detectTestChanges, effectiveGuardGlobs, guardBudget, guardRequirement, isLegacyGuardObligation } from './guard.js';
import { requirementCommands } from './test-setup.js';
import { runGuardCheck } from './guard-check.js';
import { ranAndFailed } from './run-result.js';
import { DEFAULT_EVAL_EXCLUDE } from './mutants.js';
import { gateRemedies, pendingApprovals } from './remedies.js';

export const VERSION = '0.1.0';
export const STAGES = Object.freeze(['gate', 'commit', 'ci', 'review', 'production']);
export const SEVERITIES = Object.freeze(['low', 'medium', 'high', 'critical']);
export const POLICY_FILES = Object.freeze(['.proof/rules.json', '.proof/config.json', '.proof/allowed_signers', '.proof/exceptions.json']);
/** Maintainer exceptions for commits that carry no proof record (verify --accept-uncovered). */
export const EXCEPTIONS_FILE = '.proof/exceptions.json';
const LOCKFILES = ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb', 'Cargo.lock', 'poetry.lock', 'go.sum', 'Gemfile.lock'];

/**
 * Names the files ci.files protects, by what they are: CI definitions as "CI configuration",
 * anything else a repository chose to protect (e.g. an evaluation's judging code) as
 * "protected files", so a reviewer sees which kind of change needs approval.
 */
export function protectedChangeText(files) {
  const isCi = (f) => DEFAULT_CI_FILES.some((gl) => matchGlob(f, gl));
  const ci = files.filter(isCi);
  const other = files.filter((f) => !isCi(f));
  return [ci.length ? `CI configuration changed (${ci.join(', ')})` : '', other.length ? `protected files changed (${other.join(', ')})` : ''].filter(Boolean).join('; ');
}

export class PocpError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'PocpError';
    this.details = details;
  }
}

const noopEvents = { emit() {} };

const ciKey = (r) => `${r.cwd || ''}\0${r.run}`;
/** The last record per (subject, cwd, command), in file order. */
export function latestCiResults(records = []) {
  const m = new Map();
  for (const r of records) m.set(`${r.subject}\0${ciKey(r)}`, r);
  return [...m.values()];
}
const noopPolicy = {};

/**
 * Create a POCP engine for the repository containing `cwd`.
 *
 * Interfaces (all optional): store, runner, policy, events. Options: now, newId, by, hostName.
 */
/**
 * Passes seen by one verify, by (subject, cwd, command): a check that already passed on a
 * commit's exact code in this verify (a re-run, or the test guard's baseline) is not run again.
 * Checks that match output (`expect`) are never shared. CI results count only for the guard's
 * baseline (rerunAt applies its own rule for them).
 */
export function createRunMemo() {
  const seen = new Map();
  const key = (subject, ob) => `${subject}\0${ob.cwd || ''}\0${ob.run}`;
  return {
    record(subject, ob, r) {
      if (!ob.expect && ob.run) seen.set(key(subject, ob), { duration_ms: r.duration_ms });
    },
    ran(subject, ob) {
      return !ob.expect && seen.has(key(subject, ob));
    },
    known(subject, ob, ciResults = []) {
      if (ob.expect || !ob.run) return null;
      const hit = seen.get(key(subject, ob));
      if (hit) return hit;
      const last = latestCiResults(ciResults.filter((r) => r.subject === subject && r.run === ob.run && (r.cwd || '') === (ob.cwd || ''))).pop();
      return last?.passed ? { duration_ms: last.duration_ms } : null;
    },
  };
}

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
    for (const f of POLICY_FILES) if (changes.some((c) => c.path === f || c.oldPath === f)) files.push(f);
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
      return r && typeof r.verdict === 'string' ? r : null;
    } catch {
      return null;
    }
  }
  function writeGuardCache(key, res) {
    const f = guardCacheFile(key);
    if (!f) return;
    try {
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, JSON.stringify(res));
    } catch { /* the cache is best effort */ }
  }

  /** Run the mechanical check for one guard obligation. `rev` null means the staged index. */
  async function guardCheckFor(ob, { packet, required, guardInfo, base, rev, cfg, known, onPass, seed }) {
    const { checks, sourceGlobs, from } = guardInputs(packet, required);
    const files = new Set(ob.files);
    const changes = (guardInfo.changes || []).filter((c) => files.has(c.path) || (c.oldPath && files.has(c.oldPath)));
    const res = await runGuardCheck({
      root,
      runObligation,
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
        throw new PocpError('clean mode refused: the working folder does not match what is staged. Stage or stash the changes, or use --mode snapshot.', { problems });
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
    // result (pass or fail) stands until the code changes or --force.
    async function proveGuard(packet, ob, pr) {
      const existing = P.currentProof(packet, ob, subject);
      if (existing && !force) {
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
          pr.runs.push({ obligation: ob.id, passed: res.passed, exit: res.exit, timed_out: res.timed_out, duration_ms: res.duration_ms, run_id: res.run_id });
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

  // -------------------------------------------------------------------- gate

  async function gate({ prove: doProve = false, mode, source = 'api' } = {}) {
    const allChanges = g.stagedChanges(root);
    const changes = mergeAware(allChanges);
    const files = g.changedPaths(changes);
    let subject = g.subjectHashIndex(root);
    const rulesObj = rules();
    const cfg = config();
    const result = { decision: 'pass', subject, files, required_files: [], reasons: [], uncovered: [], unpacketed: [], packets: [], problems: [], warnings: [] };

    const rulesProblems = validateRules(store.readRawRules() || {});
    const configProblems = validateConfig(cfg);
    if (rulesProblems.length || configProblems.length) {
      result.decision = 'error';
      result.problems.push(...rulesProblems.map((p) => ({ code: 'invalid_rules', detail: p })));
      result.problems.push(...configProblems.map((p) => ({ code: 'invalid_config', detail: p })));
      return finishGate(result, source);
    }
    if (files.length === 0 && !changes.some((c) => POLICY_FILES.includes(c.path) || POLICY_FILES.includes(c.oldPath))) {
      return finishGate(result, source);
    }
    for (const w of ruleWarnings(rulesObj, root)) result.warnings.push({ code: 'rule_glob', detail: w });
    if (changes.length !== allChanges.length) {
      result.merge = { heads: mergeFilter().heads, judged: files.length, taken: allChanges.length - changes.length };
      result.warnings.push({ code: 'merge', detail: `merge in progress: ${result.merge.taken} file(s) match the branch being merged and carry its proofs; only the ${files.length} file(s) changed while merging are checked here` });
    }

    const trig = evaluateTriggers(files, {
      rules: rulesObj,
      hostTriggers: await hostTriggers(files),
      hostRequirements: await hostRequirements(files),
      config: cfg,
      hostName,
    });
    const pc = policyChange(changes, rulesObj, readRulesAt('HEAD'));
    if (pc) {
      trig.required_files = [...new Set([...trig.required_files, ...pc.files])].sort();
      trig.reasons.push(pc.reason);
      // What verify will call a loosening (base policy vs this one): CI needs a maintainer for it.
      const basePolicy = g.hasHead(root) ? policyAt(g.resolveRev(root, 'HEAD')) : null;
      const weakened = basePolicy ? [...policyWeakening(basePolicy.hasRules ? basePolicy.rules : null, rulesObj), ...configWeakening(basePolicy.config, cfg)] : [];
      if (weakened.length) result.warnings.push({ code: 'awaiting_policy_approval', detail: `this loosens POCP policy (${weakened.slice(0, 3).join('; ')}${weakened.length > 3 ? '; …' : ''}); CI will ask a maintainer to approve it` });
    }
    const ciChanged = changedCiFiles(changes, cfg);
    if (ciChanged.length) {
      result.warnings.push({ code: 'awaiting_policy_approval', detail: `${protectedChangeText(ciChanged)}; CI will ask a maintainer to approve it` });
      trig.required_files = [...new Set([...trig.required_files, ...ciChanged])].sort();
      trig.reasons.push({ code: 'ci_config', detail: protectedChangeText(ciChanged), files: ciChanged });
    }
    const guard = stagedGuard();
    result.guard_mode = guard.mode;
    if (guard.files.length) {
      result.test_guard = guard;
      if (guard.mode !== 'warn') trig.required_files = [...new Set([...trig.required_files, ...guard.files])].sort();
      const weak = guard.signals.filter((x) => x.removed_asserts || x.added_skips);
      trig.reasons.push({
        code: 'test_change',
        detail: `existing tests or test setup changed (${guard.files.length} file(s))${weak.length ? `; possible weakening: ${weak.map((x) => `${x.file} -${x.removed_asserts} asserts +${x.added_skips} skips`).join(', ')}` : ''}${guard.mode === 'warn' ? '' : '; pocp prove checks mechanically that nothing was weakened'}`,
        files: guard.files,
      });
    }
    result.required_files = trig.required_files;
    result.reasons = trig.reasons;
    if (trig.required_files.length === 0) return finishGate(result, source);

    let active = activePackets();
    const covering = (list) => list.filter((p) => p.state !== 'draft' && trig.required_files.some((f) => P.covers(p, f)));

    if (doProve) {
      const targets = covering(active);
      if (targets.length) {
        try {
          await prove({ ids: targets.map((p) => p.id), mode });
        } catch (err) {
          result.problems.push({ code: 'prove_failed', detail: err.message, ...(err.details || {}) });
        }
        active = activePackets();
        subject = g.subjectHashIndex(root);
        result.subject = subject;
      }
    }

    const drafts = active.filter((p) => p.state === 'draft' && trig.required_files.some((f) => P.covers(p, f)));
    for (const d of drafts) result.warnings.push({ code: 'draft_packet', detail: `packet ${d.id} is a draft and covers nothing until "pocp ready ${d.id}"` });

    // Each required file needs at least one proven packet whose file is staged. A covering
    // packet with a failed check always blocks, so a failing check can't be routed around
    // with a weaker packet. Other unproven packets on the same files are only warnings.
    const cov = covering(active);
    const evaluated = [];
    for (const packet of cov) {
      const ev = await evaluate(packet, subject, rulesObj);
      const fileOk = store.kind !== 'fs' || g.isStagedClean(root, store.packetRelPath(packet.id));
      evaluated.push({ packet, ev, fileOk });
      result.packets.push({
        id: packet.id,
        intent: packet.intent,
        covers: trig.required_files.filter((f) => P.covers(packet, f)),
        evaluation: ev,
        packet_file_staged: fileOk,
      });
    }
    const good = evaluated.filter((e) => e.ev.ok && e.fileOk).map((e) => e.packet);
    result.unpacketed = trig.required_files.filter((f) => !cov.some((p) => P.covers(p, f)));
    result.uncovered = trig.required_files.filter((f) => !good.some((p) => P.covers(p, f)));
    for (const e of evaluated) {
      if (e.ev.ok && !e.fileOk) {
        result.problems.push({ code: 'packet_not_staged', detail: `stage ${store.packetRelPath(e.packet.id)} so its proofs ship with the commit`, packet: e.packet.id });
      } else if (e.ev.failed.length) {
        result.problems.push({ code: 'failed_proof', detail: `packet ${e.packet.id} has failing checks: ${e.ev.failed.join(', ')}`, packet: e.packet.id });
      } else if (!e.ev.ok && !result.uncovered.some((f) => P.covers(e.packet, f))) {
        result.warnings.push({ code: 'open_packet', detail: `packet ${e.packet.id} also covers these files and isn't proven for this code`, packet: e.packet.id });
      }
      for (const a of e.ev.awaiting_approval || []) {
        result.warnings.push({ code: 'awaiting_test_approval', detail: `${e.packet.id}: the test-change check did not pass (${a.detail || a.status}); the commit can go ahead, and CI will ask a maintainer to approve it`, packet: e.packet.id });
      }
    }
    const blocked = result.uncovered.length > 0 || result.problems.length > 0;
    result.decision = blocked ? 'blocked' : 'pass';
    if (result.unpacketed.length) result.suggestion = await suggestPacket(result.unpacketed, rulesObj);
    return finishGate(result, source);
  }

  // source: who asked for this evaluation, so the gate log can tell commit attempts (hook)
  // from manual checks (gate), pocp fix's rounds (fix) and library callers (api).
  function finishGate(result, source) {
    result.remedies = gateRemedies(result);
    result.pending_approvals = pendingApprovals(result);
    try {
      store.appendLog?.('gate', {
        at: nowFn(),
        source,
        decision: result.decision,
        subject: result.subject,
        required: result.required_files.length,
        uncovered: (result.unpacketed || []).length,
        packets: result.packets.map((p) => ({ id: p.id, ok: p.evaluation.ok, failed: p.evaluation.failed.length })),
      });
    } catch { /* logging is best effort */ }
    emit(result.decision === 'pass' ? 'gate.passed' : 'gate.blocked', { subject: result.subject, uncovered: result.uncovered });
    return result;
  }

  function readRulesAt(rev) {
    if (!g.hasHead(root) && rev === 'HEAD') return null;
    const raw = g.showFile(root, rev, '.proof/rules.json');
    if (raw === null) return null;
    try {
      return rulesWithDefaults(JSON.parse(raw));
    } catch {
      return null;
    }
  }

  /**
   * Changes to .proof/rules.json or .proof/config.json are policy changes: they need a
   * packet that covers the file, so weakening the rules is never silent.
   */
  function policyChange(changes, newRules, oldRules) {
    const touched = POLICY_FILES.filter((f) => changes.some((c) => c.path === f || c.oldPath === f));
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

  /** A suggested packet whose obligations come only from requirements. Never filler. */
  async function suggestPacket(files, rulesObj = rules()) {
    const req = requirementsFor(files, { rules: rulesObj, hostRequirements: await hostRequirements(files), hostName });
    const touches = files.slice(0, 50);
    const obligations = req.merged.map((r) => ({ from: r.id, ...r.obligation }));
    const quote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
    const cmd = ['pocp open --intent', quote('<what this change does>'), ...touches.map((t) => `--touch ${quote(t)}`)];
    return {
      touches,
      obligations,
      note: obligations.length
        ? 'Required checks for these files are added automatically when the packet opens.'
        : 'No rule requires a check for these files yet. Add at least one runnable obligation (--test, --command or --probe).',
      command: cmd.join(' ') + (obligations.length ? '' : ` --test ${quote('<command that proves it>')}`),
    };
  }

  /**
   * For pre-edit hooks: which of these files would need a packet if changed, and is
   * one already open? Uses glob triggers and requirements (not broad/cross-area,
   * which depend on the whole change).
   */
  async function checkEdit(files) {
    const rulesObj = rules();
    const norm = files.map((f) => String(f).replace(/^\.\//, ''));
    const trig = evaluateTriggers(norm, {
      rules: { ...rulesObj, triggers: { ...rulesObj.triggers, broad_files: undefined, cross_area: undefined } },
      hostTriggers: await hostTriggers(norm),
      hostRequirements: await hostRequirements(norm),
      config: config(),
      hostName,
    });
    for (const f of norm) if (POLICY_FILES.includes(f) && !trig.required_files.includes(f)) trig.required_files.push(f);
    const active = activePackets().filter((p) => p.state !== 'draft');
    const uncovered = trig.required_files.filter((f) => !active.some((p) => P.covers(p, f)));
    return {
      ok: uncovered.length === 0,
      protected: trig.required_files,
      uncovered,
      suggestion: uncovered.length ? await suggestPacket(uncovered, rulesObj) : null,
    };
  }

  // ----------------------------------------------------------- trailers/land

  /** Trailer lines for proven packets that cover staged files. */
  async function trailers({ amend = false } = {}) {
    const subject = g.subjectHashIndex(root);
    const staged = stagedForCoverage({ amend });
    const lines = [];
    for (const p of activePackets()) {
      if (p.state === 'draft' || !staged.some((f) => P.covers(p, f))) continue;
      const ev = await evaluate(p, subject);
      if (!ev.ok) continue;
      lines.push(formatTrailer({ id: p.id, subject, policy: p.policy, ...ev.counts, runnable: ev.counts.runnable, manual: ev.counts.manual }));
    }
    return lines;
  }

  /**
   * Add trailers to a commit message file (the prepare-commit-msg hook).
   * `source` is git's message source; on "commit" (an amend) existing Proof-Of-Change
   * trailers describe the old code, so they are dropped first. Hand-typed trailers in
   * other messages are left alone: verify is what judges them.
   */
  async function addTrailersToFile(messageFile, { source } = {}) {
    const lines = await trailers({ amend: source === 'commit' });
    if (source === 'commit') {
      const original = fs.readFileSync(messageFile, 'utf8');
      const stripped = original
        .split('\n')
        .filter((l) => !/^Proof-Of-Change:/i.test(l.trim()))
        .join('\n');
      if (stripped !== original) fs.writeFileSync(messageFile, stripped);
    }
    if (lines.length === 0) return [];
    const args = ['interpret-trailers', '--in-place', '--if-exists', 'addIfDifferent'];
    for (const l of lines) args.push('--trailer', `${TRAILER_KEY}: ${l}`);
    args.push(messageFile);
    g.git(root, args);
    return lines;
  }

  /**
   * After a commit: report which packets its trailers land. Nothing is written; landed state
   * is derived from git on every read (see withLanded), so the working copy stays clean.
   */
  function land({ rev = 'HEAD' } = {}) {
    const commit = g.resolveRev(root, rev);
    const subject = g.subjectHashRev(root, commit);
    const landed = [];
    const skipped = [];
    for (const t of parseTrailers(g.commitMessage(root, commit))) {
      const raw = store.readPacket(t.id);
      if (!raw) {
        skipped.push({ id: t.id, reason: 'no such packet here' });
        continue;
      }
      if (!digestMatches(subject, t.subject)) {
        skipped.push({ id: t.id, reason: 'trailer subject does not match the commit' });
        continue;
      }
      if (!P.isActive(raw)) {
        skipped.push({ id: t.id, reason: `packet is ${raw.state}` });
        continue;
      }
      emit('packet.landed', { id: t.id, commit });
      landed.push(t.id);
    }
    return { commit, landed, skipped };
  }

  // ------------------------------------------------------------------ verify

  /**
   * Rules and config as committed at `rev`, with every problem that makes them unusable:
   * unreadable JSON or values that don't validate. verify fails closed on any problem.
   */
  function policyAt(rev) {
    const problems = [];
    const rawRules = readJsonAt(rev, '.proof/rules.json');
    const rawCfg = readJsonAt(rev, '.proof/config.json');
    if (rawRules?.__invalid) problems.push(`.proof/rules.json at ${rev.slice(0, 12)} is not valid JSON`);
    if (rawCfg?.__invalid) problems.push(`.proof/config.json at ${rev.slice(0, 12)} is not valid JSON`);
    const rulesObj = rulesWithDefaults(rawRules && !rawRules.__invalid ? rawRules : {});
    const cfgObj = withDefaults(rawCfg && !rawCfg.__invalid ? rawCfg : {});
    if (rawRules && !rawRules.__invalid) for (const p of validateRules(rawRules)) problems.push(`rules at ${rev.slice(0, 12)}: ${p}`);
    if (rawCfg && !rawCfg.__invalid) for (const p of validateConfig(cfgObj)) problems.push(`config at ${rev.slice(0, 12)}: ${p}`);
    return { rules: rulesObj, config: cfgObj, hasRules: Boolean(rawRules && !rawRules.__invalid), problems };
  }

  function readJsonAt(rev, rel) {
    const raw = g.showFile(root, rev, rel);
    if (raw === null) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return { __invalid: true };
    }
  }

  /**
   * The policy that judges `commit`: the base's rules, config and signers, strictly combined
   * with the commit's (a change can't loosen what judges it), unless a loosening is accepted.
   * Which findings fail is the repo's choice (verify.fail_on) in that policy; an invalid
   * policy always fails.
   */
  function policyInForce(commit, baseRev, { acceptPolicyChange = false, allowedSignersFile } = {}) {
    const headPolicy = policyAt(commit);
    const headRules = headPolicy.rules;
    const basePolicy = baseRev ? policyAt(baseRev) : null;
    const baseRules = basePolicy?.hasRules ? basePolicy.rules : null;
    const policyProblems = [...headPolicy.problems, ...(basePolicy?.problems || [])];
    const weakened = [...policyWeakening(baseRules, headRules), ...(basePolicy ? configWeakening(basePolicy.config, headPolicy.config) : [])];
    const baseSigners = baseRev ? g.showFile(root, baseRev, '.proof/allowed_signers') : null;
    const headSigners = g.showFile(root, commit, '.proof/allowed_signers');
    if (baseRev && (headSigners || '').trim() !== (baseSigners || '').trim()) {
      const baseKeys = new Set((baseSigners || '').split('\n').map((l) => l.trim()).filter(Boolean));
      if ((headSigners || '').split('\n').map((l) => l.trim()).filter(Boolean).some((l) => !baseKeys.has(l))) weakened.push('allowed_signers gained a key');
    }
    // The exception list waives missing proof, so any change to it needs a maintainer.
    if (baseRev && (g.showFile(root, commit, EXCEPTIONS_FILE) || '').trim() !== (g.showFile(root, baseRev, EXCEPTIONS_FILE) || '').trim()) {
      weakened.push(`${EXCEPTIONS_FILE} changed (exceptions for commits with no proof record)`);
    }
    const accepted = Boolean(baseRev && weakened.length && acceptPolicyChange);
    let rulesAt = headRules;
    let cfgAt = headPolicy.config;
    let allowedSigners = headSigners;
    if (baseRev && !accepted) {
      rulesAt = strictUnion(baseRules, headRules);
      cfgAt = strictConfig(basePolicy.config, headPolicy.config);
      allowedSigners = baseSigners;
    }
    if (allowedSignersFile) allowedSigners = fs.readFileSync(allowedSignersFile, 'utf8');
    const failOn = new Set(cfgAt.verify?.fail_on || []);
    // test_inconclusive is a kind of test_change (a test change whose check didn't finish), and
    // ci_unfinished a kind of ci_failed (a required CI check whose re-run didn't finish): each
    // blocks exactly when its parent does, so a config listing fail_on codes from before they
    // existed can't turn them into warnings.
    const blocks = (code) => code === 'invalid_policy' || failOn.has({ test_inconclusive: 'test_change', ci_unfinished: 'ci_failed' }[code] || code);
    return { policyProblems, weakened, accepted, rulesAt, cfgAt, allowedSigners, failOn, blocks };
  }

  /** A finding recorder for a verify result: blocking findings fail it, the rest warn. */
  function findingSink(out, blocks) {
    return (code, detail) => {
      const blocking = blocks(code);
      out.findings.push({ code, detail, blocking });
      if (blocking) {
        out.ok = false;
        out.notes.push(detail);
      } else {
        out.warnings.push(detail);
      }
    };
  }

  /**
   * The exception list at `rev`: entries name one commit (full SHA) and exact files that
   * commit left without a packet, with a reason and a reviewer. Used only with an approval
   * for the head (acceptUncovered); an exception never turns missing proof into proof.
   */
  function readUncoveredExceptions(rev) {
    const raw = readJsonAt(rev, EXCEPTIONS_FILE);
    if (raw === null) return { entries: [], problems: [] };
    if (raw.__invalid || typeof raw !== 'object' || Array.isArray(raw)) return { entries: [], problems: [`${EXCEPTIONS_FILE} is not a valid JSON object`] };
    const list = raw.uncovered === undefined ? [] : raw.uncovered;
    if (!Array.isArray(list)) return { entries: [], problems: [`${EXCEPTIONS_FILE}: "uncovered" must be a list`] };
    const entries = [];
    const problems = [];
    list.forEach((e, i) => {
      const ok = e && typeof e === 'object' && /^[0-9a-f]{40}$/.test(e.commit || '')
        && Array.isArray(e.files) && e.files.length > 0 && e.files.every((f) => typeof f === 'string' && f.length > 0 && !/[*?[\]{}]/.test(f))
        && typeof e.reason === 'string' && e.reason.trim() !== '' && typeof e.reviewer === 'string' && e.reviewer.trim() !== '';
      if (ok) entries.push(e);
      else problems.push(`${EXCEPTIONS_FILE}: uncovered[${i}] needs "commit" (a full 40-character SHA), "files" (exact paths, no globs), "reason" and "reviewer"`);
    });
    return { entries, problems };
  }

  /** Split uncovered files into those an exception names for this commit and the rest. */
  function applyUncoveredExceptions(files, exceptions, matches) {
    const accepted = [];
    const rest = [];
    for (const f of files) {
      const e = exceptions ? exceptions.entries.find((x) => matches(x, f)) : null;
      if (e) accepted.push({ file: f, commit: e.commit, reason: e.reason, reviewer: e.reviewer });
      else rest.push(f);
    }
    return { accepted, rest };
  }

  const acceptedText = (a, head) => `UNPROVEN: ${a.file} has no packet in commit ${a.commit.slice(0, 12)}; accepted as a reviewed exception for head ${head.slice(0, 12)} by ${a.reviewer}: ${a.reason}`;

  function reportPolicy(finding, out, { baseRev, policyProblems, weakened, accepted }) {
    for (const p of policyProblems) finding('invalid_policy', `invalid policy: ${p}`);
    if (accepted) out.notes.push(`policy loosened and accepted: ${weakened.join('; ')}`);
    else if (baseRev && weakened.length) finding('policy_loosened', `policy loosened without approval: ${weakened.join('; ')} (re-run with --accept-policy-change once a maintainer approves)`);
  }

  /**
   * Check a commit without trusting its trailers. With `rerun`, run every runnable
   * obligation again in a clean checkout of that commit. With `requireCoverage`,
   * also require that files the commit changed are covered when the rules say so.
   */
  async function verify(rev = 'HEAD', { rerun = false, guardRerun, requireCoverage = false, useHost = Boolean(opts.policy), ciResults, policyFrom, acceptPolicyChange = false, acceptTestChange = false, acceptInconclusive = false, acceptUncovered = false, uncoveredExceptions, testGuardOnNet = false, allowedSignersFile, checkRequiredCiHere = true, guardSeed, memo = createRunMemo() } = {}) {
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
    const baseRev = policyFrom === undefined ? g.git(root, ['rev-parse', '--verify', '--quiet', `${commit}^1`], { allowFail: true }) : policyFrom ? g.resolveRev(root, policyFrom) : null;
    const { policyProblems, weakened, accepted, rulesAt, cfgAt, allowedSigners, failOn, blocks } = policyInForce(commit, baseRev, { acceptPolicyChange, allowedSignersFile });
    const commitFinding = findingSink(out, blocks);
    reportPolicy(commitFinding, out, { baseRev, policyProblems, weakened, accepted });
    if (!baseRev && policyFrom === undefined) out.notes.push('root commit: rules and signers come from the commit itself');

    const commitChangeList = g.commitChanges(root, commit);
    const commitFiles = g.changedPaths(commitChangeList);
    for (const f of POLICY_FILES) if (commitChangeList.some((c) => c.path === f || c.oldPath === f)) commitFiles.push(f);

    // CI definitions changed: they can switch POCP off, so they need the same approval.
    const ciFilesChanged = changedCiFiles(commitChangeList, cfgAt);
    if (ciFilesChanged.length && !acceptPolicyChange) {
      commitFinding('ci_config_changed', `${protectedChangeText(ciFilesChanged)}; re-run with --accept-policy-change once a maintainer approves`);
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
      for (const id of ev.failed) flag('failed_proof', `proof for ${id} failed`);
      for (const id of ev.unattested) flag('unattested', `no attestation for ${id} against this commit`);
      if (t.proven && t.proven.done !== ev.counts.proven) flag('trailer_mismatch', `trailer says ${t.proven.done} proven, packet shows ${ev.counts.proven}`);
      const signatures = { valid: 0, invalid: 0, unsigned: 0, untrusted: 0 };
      for (const ob of packet.obligations.filter((o) => isRunnable(o) || isGuard(o))) {
        const proof = P.currentProof(packet, ob, subject);
        if (!proof) continue;
        const st = verifyProofSignature(proof, allowedSigners);
        signatures[st]++;
        if (st === 'invalid') flag('invalid_signature', `proof for ${ob.id} has an invalid signature (edited after signing, or signer not allowed)`);
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
      const parent = g.git(root, ['rev-parse', '--verify', '--quiet', `${commit}^1`], { allowFail: true });
      const pc = policyChange(commitChangeList, rulesAt, parent ? readRulesAt(parent) : null);
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

    if (rerun && packetsAt.length) {
      const failures = await rerunAt(commit, packetsAt, { mode: rerun, ciResults: ciResults || [], subject, signed: sigOf, links: cfgAt.snapshot.link, into: out.reruns, memo });
      for (const f of failures) {
        const entry = out.packets.find((x) => x.id === f.packet);
        const blocking = blocks('rerun_failed');
        out.findings.push({ code: 'rerun_failed', detail: f.problem, blocking, packet: f.packet });
        if (entry) {
          if (blocking) {
            entry.ok = false;
            entry.problems.push(f.problem);
          } else entry.warnings.push(f.problem);
        }
      }
    }
    if (testGuardOnNet && commitGuard.files.length) {
      commitGuard.mechanical = [];
      out.notes.push(`test change (${commitGuard.files.join(', ')}) is judged once, on the pull request's net change`);
    } else await checkTestGuard({ commit, out, commitGuard, guardJobs, guardRerun, acceptTestChange, acceptInconclusive, cfgAt, commitFinding, blocks, signed: sigOf, memo, ciResults: ciResults || [], seed: guardSeed });

    // Required CI results (verify.require_ci). Fails closed: with no results supplied at all,
    // every required command counts as missing. A passing re-run by this verify also counts.
    if (checkRequiredCiHere && rerun) await rerunRequiredCi(commit, cfgAt, { mode: rerun, ciResults: ciResults || [], subject, into: out.reruns, memo });
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
  async function checkTestGuard({ commit, out, commitGuard, guardJobs, guardRerun, acceptTestChange, acceptInconclusive = false, cfgAt, commitFinding, blocks, signed, memo, ciResults, seed }) {
    if (!commitGuard.files.length) return;
    const base = g.git(root, ['rev-parse', '--verify', '--quiet', `${commit}^1`], { allowFail: true });
    const results = [];
    for (const job of guardJobs) {
      const entry = out.packets.find((e) => e.id === job.packet.id);
      const r = { packet: job.packet.id, obligation: job.ob.id, files: job.files };
      if (guardRerun && !(guardRerun === 'unsigned' && signed.get(obligationDigest(job.ob)) === 'valid' && job.proof?.passed)) {
        // The new code's baseline is the same run as a re-run or CI result for this commit, if one exists.
        const res = await guardCheckFor(job.ob, { packet: job.packet, required: job.required, guardInfo: commitGuard, base, rev: commit, cfg: cfgAt, seed, known: (ob) => memo.known(out.subject, ob, ciResults), onPass: (ob, r) => memo.record(out.subject, ob, r) });
        Object.assign(r, { evidence: 'rerun', passed: res.passed, verdict: res.verdict, summary: res.summary, checks_from: res.checks_from, unfinished: Boolean(res.unfinished), result: res });
        out.reruns.push({ run: `test guard (${job.ob.id}, ${job.ob.mutants} mutants${seed !== undefined ? `, seed ${seed}` : ''})`, kind: 'guard', packets: [job.packet.id], status: res.passed ? 'passed' : 'failed', verdict: res.verdict, summary: res.summary, duration_ms: res.duration_ms });
        if (entry?.evidence) {
          if (res.passed) entry.evidence[job.ob.id] = 'mechanical:rerun';
          else if (!job.attestation) entry.evidence[job.ob.id] = 'mechanical:rerun-failed';
        }
        // The packet claimed a mechanical pass and it doesn't hold here.
        if (!res.passed && job.proof?.passed && !job.attestation && entry) {
          const problem = `test guard re-run failed: ${res.summary}`;
          const blocking = blocks('rerun_failed');
          out.findings.push({ code: 'rerun_failed', detail: problem, blocking, packet: entry.id });
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
    commitGuard.mechanical = results;
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
      commitFinding('test_inconclusive', `existing tests or test setup changed (${notFinished.join(', ')}) and the check didn't finish: ${ran?.summary || 'a run timed out or was killed'}. Re-run verify, or re-run with --accept-inconclusive once a person approves`);
    }
    const toReview = missing.filter((f) => !unfinishedFor(f));
    if (!toReview.length || acceptTestChange) return;
    const failed = results.find((r) => r.verdict && r.verdict !== 'passed' && r.summary);
    const why = failed
      ? `the mechanical check did not pass: ${failed.summary}`
      : results.some((r) => r.passed && r.checks_from === 'packet')
        ? 'the mechanical check ran checks the packet chose, not ones a rule requires (add a requirement covering these tests)'
        : results.some((r) => r.passed)
        ? 'the mechanical check passed only locally (re-run verify with --rerun to check it here)'
        : 'no mechanical check covers them';
    commitFinding('test_change', `existing tests or test setup changed (${toReview.join(', ')}); ${why}. Re-run with --accept-test-change once a person approves`);
  }

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
    for (const [d, job] of jobs) {
      // A CI result can't stand in for a check that also matches output (`expect`).
      if (ran.has(`${job.ob.cwd || ''}\0${job.ob.run}`) && !job.ob.expect) into.push({ run: job.ob.run, digest: d, packets: job.packets, status: 'skipped: passing CI result for this code', evidence: 'ci-result' });
      else if (mode === 'unsigned' && signed.get(d) === 'valid') into.push({ run: job.ob.run, digest: d, packets: job.packets, status: 'skipped: signed by an allowed signer', evidence: 'signed' });
      else if (memo.ran(subj, job.ob)) into.push({ run: job.ob.run, cwd: job.ob.cwd || null, subject: subj, digest: d, packets: job.packets, status: 'passed', reused: 'already run on this commit by this verify', duration_ms: 0 });
      else todo.push(job);
    }
    // Each check gets its own fresh copy of the commit (no .git), so one check's code can't
    // change the files another check runs.
    for (const job of todo) {
      const co = createRevCheckout(root, commit, { links });
      let r;
      try {
        r = await runObligation(job.ob, co.dir);
      } finally {
        co.cleanup();
      }
      if (r.passed) memo.record(subj, job.ob, r);
      into.push({ run: job.ob.run, cwd: job.ob.cwd || null, subject: subj, digest: obligationDigest(job.ob), packets: job.packets, status: r.passed ? 'passed' : 'failed', exit: r.exit, timed_out: r.timed_out, duration_ms: r.duration_ms });
      // unfinished: it timed out, was killed or didn't start, so it says nothing about the code.
      if (!r.passed) for (const id of job.packets) failures.push({ packet: id, problem: `rerun of "${job.ob.run}" failed (exit ${r.exit}${r.timed_out ? ', timed out' : ''})`, unfinished: !ranAndFailed(r) });
    }
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

  /** CI definition files a change touched (ci.files globs). */
  function changedCiFiles(changes, cfg) {
    const globs = cfg.ci?.files || [];
    const touched = new Set();
    for (const c of changes) for (const p of [c.path, c.oldPath]) if (p && globs.some((gl) => matchGlob(p, gl))) touched.add(p);
    return [...touched].sort();
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
        if (failedRuns.every((r) => !ranAndFailed({ passed: false, exit: r.exit, timed_out: r.timed_out }))) {
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
    const netBase = baseRev ? g.git(root, ['merge-base', baseRev, tip], { allowFail: true }) || baseRev : null;
    // One plain commit on the base: its own check is the net change's check, so it isn't run twice.
    const single = merges.length === 0 && commits.length === 1 && tip === lastCommit && netBase
      && g.git(root, ['rev-parse', '--verify', '--quiet', `${lastCommit}^1`], { allowFail: true }) === netBase;
    const seed = netBase && pol ? rangeGuardSeed(guardBudget(pol.cfgAt).seed, netBase, tip) : undefined;

    // The net change's commit is written before any code under review runs: verify trusts the
    // object store as it was then (git.js watches it from the start of isolation).
    const synth = netBase && !single ? netChangeCommit(netBase, tip) : null;

    // Required CI results are checked once, at the tip (where CI ran), after the range's re-runs.
    const memo = createRunMemo();
    // Exceptions come from the code being merged, and count only with an approval for it.
    const uncoveredExceptions = options.acceptUncovered && tip ? { head: tip, ...readUncoveredExceptions(tip) } : null;
    for (const c of commits) {
      // With a net change, a test change is judged once, on the whole pull request (old tests
      // from the merge base, new code from the tip): that check alone decides, so running it
      // again on each commit only multiplied the cost (the slowest part of verify).
      results.push(await verify(c, { ...options, uncoveredExceptions, policyFrom, rerun: false, guardRerun: synth ? false : (options.rerun || false), testGuardOnNet: Boolean(synth), checkRequiredCiHere: false, guardSeed: single ? seed : undefined, memo }));
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

    const rerun = options.rerun === true ? 'all' : options.rerun;
    const headResult = tip === lastCommit ? results[results.length - 1] : null;
    if (rerun) {
      const packets = [];
      const seenIds = new Set();
      for (const r of [...results].reverse()) {
        for (const p of r.packetData || []) if (!seenIds.has(p.id)) { seenIds.add(p.id); packets.push(p); }
      }
      if (net?.obligations.length) packets.push({ id: 'net-change', obligations: net.obligations });
      // A signature covers the commit it was made on; when the tip is a merge, none covers the tip.
      const signed = headResult ? headResult.signedDigests : new Map();
      const failures = await rerunAt(tip, packets, { mode: rerun, ciResults: options.ciResults || [], signed, links: pol.cfgAt.snapshot.link, into: result.reruns, memo });
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
      result.net = await judgeNetChange(net, { results, merges, lastCommit, policyBase, options: { ...options, uncoveredExceptions }, memo, seed });
      result.ok = result.ok && result.net.ok;
    }
    // Required CI results belong to the tip's code: the last commit's result, or the net change's when the tip is a merge.
    const tipOut = headResult || result.net;
    if (tipOut) {
      const finding = headResult ? headResult.addFinding : findingSink(result.net, pol.blocks);
      const tipSubject = g.subjectHashRev(root, tip);
      // With --rerun, verify runs the required CI commands itself at the tip (no results file needed).
      if (rerun) await rerunRequiredCi(tip, pol.cfgAt, { mode: rerun, ciResults: options.ciResults || [], subject: tipSubject, into: result.reruns, memo });
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

  /** What the net change is, before the tip's re-runs: its changes, test guard and required checks. */
  async function prepareNetChange({ tip, netBase, synth, pol, options }) {
    const useHost = options.useHost ?? Boolean(opts.policy);
    const changes = g.commitChanges(root, synth);
    const paths = g.changedPaths(changes);
    const files = [...paths];
    for (const f of POLICY_FILES) if (changes.some((c) => c.path === f || c.oldPath === f)) files.push(f);
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
  async function judgeNetChange(net, { results, merges, lastCommit, policyBase, options, memo, seed }) {
    const { tip, netBase, synth, changes, paths, files, guard, required, pol, useHost } = net;
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
      finding('ci_config_changed', `${protectedChangeText(ciUnseen)} in a merge commit; re-run with --accept-policy-change once a maintainer approves`);
    }

    // Test guard on the net change: the old tests and test setup from the net base, the new code
    // and tests from the tip. Only this verify's own re-run can pass it.
    if (guard.files.length) {
      out.test_guard = guard;
      const results2 = [];
      const guardRerun = options.rerun === true ? 'all' : options.rerun;
      if (guard.mode !== 'warn' && guardRerun) {
        const ob = { id: 'net', kind: 'guard', files: guard.files, ...guardBudget(cfgAt) };
        const res = await guardCheckFor(ob, {
          packet: { id: 'net-change', touches: [], obligations: [] }, required, guardInfo: guard, base: netBase, rev: synth, cfg: cfgAt, seed,
          known: (o) => memo.known(subject, o, options.ciResults || []), onPass: (o, r) => memo.record(subject, o, r),
        });
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
      const netUnfinished = Boolean(guardRerun && r && !r.passed && r.result?.unfinished);
      if (guard.mode === 'block' && !independent && netUnfinished) {
        if (!options.acceptInconclusive) finding('test_inconclusive', `existing tests or test setup changed (${guard.files.join(', ')}) in the pull request's net change ${span} and the check didn't finish: ${r.summary}. Re-run verify, or re-run with --accept-inconclusive once a person approves`);
      } else if (guard.mode === 'block' && !independent && !options.acceptTestChange) finding('test_change', detail);
      else if (guard.mode === 'attest' && !independent && !options.acceptTestChange) {
        // Attest mode accepts a recorded sign-off on a test change; a check that ran here and
        // failed needs one for every changed file, from some packet in the range.
        const attested = (f) => results.some((x) => (x.packetData || []).some((p) => p.obligations.some((o) => (isGuard(o) || isLegacyGuardObligation(o)) && (o.files || x.test_guard?.files || []).includes(f) && P.currentAttestation(p, o, x.subject))));
        if (guardRerun && r && !guard.files.every(attested)) finding('test_change', detail);
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
      const pc = policyChange(changes, rulesAt, readRulesAt(netBase));
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

  // ------------------------------------------------------------- misses/blame

  function blame(file, { limit = 50 } = {}) {
    const out = [];
    for (const c of g.commitsTouching(root, file, limit)) {
      const ids = parseTrailers(c.message).map((t) => t.id);
      if (ids.length) out.push({ commit: c.commit, packets: ids });
    }
    return out;
  }

  function recordMiss({ description, stage, severity = 'medium', files = [], failing_check = null, packets, found_at, by = actor }) {
    if (!description || !String(description).trim()) throw new ValidationError('a miss needs a description');
    if (!STAGES.includes(stage)) throw new ValidationError(`stage must be one of ${STAGES.join(', ')}`);
    if (!SEVERITIES.includes(severity)) throw new ValidationError(`severity must be one of ${SEVERITIES.join(', ')}`);
    if (!Array.isArray(files) || files.length === 0) throw new ValidationError('a miss needs at least one file it involved');
    const now = nowFn();
    let linked = packets;
    if (!linked) {
      const set = new Set();
      for (const f of files) {
        const hit = blame(f, { limit: 50 })[0];
        if (hit) hit.packets.forEach((id) => set.add(id));
      }
      linked = [...set];
    }
    const miss = {
      pocp: 1,
      id: opts.newId?.('m') || randomId('m'),
      description: String(description).trim().slice(0, 1000),
      stage,
      found_at: found_at || now,
      severity,
      failing_check,
      files: [...new Set(files)].sort(),
      packets: linked,
      state: 'open',
      recorded_by: by,
      recorded_at: now,
    };
    store.writeMiss(miss);
    emit('miss.recorded', { id: miss.id, stage, severity });
    return miss;
  }

  function loadMiss(idOrPrefix) {
    const exact = store.readMiss(idOrPrefix);
    if (exact) return exact;
    const matches = store.readMisses().filter((m) => m.id.startsWith(idOrPrefix));
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) throw new PocpError(`miss id "${idOrPrefix}" is ambiguous`);
    throw new PocpError(`no miss "${idOrPrefix}"`);
  }

  /** The rules that can close a miss: source miss:<id>, matching its files, runnable. */
  function ratchetRules(miss, rulesObj = rules()) {
    return (rulesObj.requirements || []).filter(
      (r) => r.source === `miss:${miss.id}` && globsOf(r).some((gl) => miss.files.some((f) => matchGlob(f, gl))) && isRunnable(r.obligation),
    );
  }

  /**
   * Close a miss. The ratchet requires a runnable rule for its files. With `replay`
   * (the commit where the miss escaped), the rule must fail there and pass on the
   * current staged code, which upgrades the closure to "replay-confirmed".
   */
  async function closeMiss(id, args = {}) {
    return mutexAsync(() => closeMissUnlocked(id, args));
  }
  async function closeMissUnlocked(id, { fix, replay, by = actor } = {}) {
    const miss = loadMiss(id);
    if (miss.state === 'closed' && (miss.closed !== 'rule-added' || !replay)) {
      throw new PocpError(`miss ${miss.id} is already closed (${miss.closed})`);
    }
    const ruleList = ratchetRules(miss);
    if (ruleList.length === 0) {
      throw new PocpError(
        `ratchet: add a requirement to .proof/rules.json with "source": "miss:${miss.id}", a glob matching ${miss.files.join(', ')}, and a runnable obligation`,
        { files: miss.files },
      );
    }
    const now = nowFn();
    let closed = 'rule-added';
    let replayResult = null;
    if (replay) {
      replayResult = await replayRules(miss, ruleList, replay);
      if (!replayResult.confirmed) {
        throw new PocpError(`replay did not confirm the rule: ${replayResult.notes.join('; ')}`, { replay: replayResult });
      }
      closed = 'replay-confirmed';
    }
    miss.state = 'closed';
    miss.closed = closed;
    miss.closed_at = now;
    miss.closed_by = by;
    if (fix) miss.fix = String(fix).slice(0, 1000);
    miss.rules = ruleList.map((r) => r.id);
    if (replayResult) miss.replay = replayResult;
    store.writeMiss(miss);
    emit('miss.closed', { id: miss.id, closed });
    return miss;
  }

  /**
   * Replay: run the new rule's checks twice on a snapshot of the staged code.
   *   1. as staged (the fix): every check must pass;
   *   2. with only the miss's files rolled back to the escaped commit: some check must fail.
   * Rolling back only the miss's files keeps the new check itself (often a new test file)
   * present in both runs, so a failure means the check detects the old code, not that
   * the check was missing.
   */
  async function replayRules(miss, ruleList, escapedRev) {
    const escaped = g.resolveRev(root, escapedRev);
    const cfg = config();
    const obligations = ruleList.map((r) => ({ ...r.obligation, id: r.id }));
    const subject = g.subjectHashIndex(root);
    const snap = createIndexSnapshot(root, { links: cfg.snapshot.link, readOnly: false });
    const fixed = [];
    const at = [];
    const rolledBack = [];
    try {
      for (const ob of obligations) {
        const r = await runObligation(ob, snap.dir);
        fixed.push({ rule: ob.id, passed: r.passed, exit: r.exit, timed_out: r.timed_out });
      }
      for (const f of miss.files) {
        const old = g.showFileBuffer(root, escaped, f);
        const full = path.join(snap.dir, f);
        const current = fs.existsSync(full) ? fs.readFileSync(full) : null;
        if (old === null && current === null) continue;
        if (old !== null && current !== null && Buffer.compare(old, current) === 0) continue;
        if (old === null) fs.rmSync(full, { force: true });
        else {
          fs.mkdirSync(path.dirname(full), { recursive: true });
          fs.writeFileSync(full, old);
        }
        rolledBack.push(f);
      }
      if (rolledBack.length) {
        for (const ob of obligations) {
          const r = await runObligation(ob, snap.dir);
          at.push({ rule: ob.id, passed: r.passed, exit: r.exit, timed_out: r.timed_out });
        }
      }
    } finally {
      snap.cleanup();
    }
    const passesNow = fixed.every((r) => r.passed);
    const failsAtEscape = at.some((r) => !r.passed);
    const notes = [];
    if (!rolledBack.length) notes.push(`the miss's files are the same at ${escaped.slice(0, 12)} and now, so there is nothing to replay`);
    if (!passesNow) notes.push('the rule does not pass on the fixed code');
    if (rolledBack.length && !failsAtEscape) notes.push('the rule still passes with the old code, so it does not detect this miss');
    return {
      escaped_commit: escaped,
      fixed_subject: subject,
      rolled_back: rolledBack,
      at_fix: fixed,
      at_escape: at,
      confirmed: rolledBack.length > 0 && passesNow && failsAtEscape,
      notes,
      at: nowFn(),
    };
  }

  function isolatedVerify(fn) {
    return g.withGitIsolation(root, fn).catch((err) => {
      throw err instanceof g.GitTamperError ? new PocpError(err.message, { code: 'git_tampered' }) : err;
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

