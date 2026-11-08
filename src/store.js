import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { PROOF_DIR } from './git.js';
import { DEFAULT_GUARD_MODE, DEFAULT_GUARD_MUTANTS, DEFAULT_GUARD_SEED, effectiveGuardGlobs } from './guard.js';
import { globProblem } from './glob.js';
import { PocpBaseError } from './errors.js';

// Every finding verify can report. A repository chooses which ones fail verification
// (`verify.fail_on`); the rest are reported as warnings. `invalid_policy` always fails.
export const FINDING_CODES = Object.freeze([
  'policy_loosened', 'ci_config_changed', 'test_change', 'uncovered',
  'missing_packet', 'trailer_mismatch', 'policy_mismatch', 'missing_required',
  'unproven', 'failed_proof', 'unattested', 'invalid_signature', 'rerun_failed',
  'ci_missing', 'ci_failed',
]);

// CI definitions: a change to these can switch POCP off in CI, so it's treated like a
// policy change (needs a packet, and approval in CI).
export const DEFAULT_CI_FILES = Object.freeze([
  '.github/workflows/**', '.github/actions/**', 'action.yml', 'action.yaml',
  '.gitlab-ci.yml', '.gitlab/ci/**', '.circleci/**', 'Jenkinsfile', 'azure-pipelines.yml',
  'bitbucket-pipelines.yml', '.buildkite/**', '.drone.yml', '.woodpecker/**', '.woodpecker.yml',
]);

export const DEFAULT_CONFIG = Object.freeze({
  pocp: 1,
  packet_ttl_days: 14,
  area_depth: 2,
  proofs_kept_per_obligation: 5,
  run: {
    mode: 'clean',
    timeout_ms: 600_000,
    kill_grace_ms: 5_000,
    env: 'inherit',
    env_allow: [],
    log_cap_bytes: 10 * 1024 * 1024,
    lockfile: null,
  },
  snapshot: { link: ['node_modules'] },
  sign: { key: null, principal: null },
  guard: { tests: DEFAULT_GUARD_MODE, test_globs: null, runner_globs: null, mutants: DEFAULT_GUARD_MUTANTS, seed: DEFAULT_GUARD_SEED },
  verify: { fail_on: [...FINDING_CODES], require_ci: [] },
  ci: { files: [...DEFAULT_CI_FILES], branch: null, required_checks: [], require_pull_request: true, enforce_admins: true, require_up_to_date: true, workflow_approver: 'independent' },
});

// Calibrated on real history: counting only code and config, these thresholds asked for
// a packet on 6-30% of past commits (vs 31-48% when every file counted).
export const DEFAULT_COUNT_EXEMPT = Object.freeze([
  '**/*.md', '**/*.mdx', '**/*.txt', 'docs/**',
  'test/**', 'tests/**', '**/__tests__/**', '**/*.test.*', '**/*.spec.*',
  '**/package-lock.json', '**/pnpm-lock.yaml', '**/yarn.lock', '**/*.lock', '**/*.snap',
  '**/*.png', '**/*.jpg', '**/*.jpeg', '**/*.gif', '**/*.svg', '**/*.webp', '**/*.ico',
]);

export const DEFAULT_RULES = Object.freeze({
  pocp: 1,
  triggers: {
    broad_files: 10,
    cross_area: { areas: 4, min_files: 8 },
    globs: [],
  },
  count_exempt: DEFAULT_COUNT_EXEMPT,
  requirements: [],
});

function merge(base, over) {
  if (!over || typeof over !== 'object' || Array.isArray(over)) return over === undefined ? base : over;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) {
    out[k] = base && typeof base[k] === 'object' && !Array.isArray(base[k]) && v && typeof v === 'object' && !Array.isArray(v)
      ? merge(base[k], v)
      : v;
  }
  return out;
}

export function withDefaults(config) {
  return merge(structuredClone(DEFAULT_CONFIG), config || {});
}

export function rulesWithDefaults(rules) {
  const r = merge(structuredClone(DEFAULT_RULES), rules || {});
  r.triggers.globs = Array.isArray(r.triggers.globs) ? r.triggers.globs : [];
  r.requirements = Array.isArray(r.requirements) ? r.requirements : [];
  r.count_exempt = Array.isArray(r.count_exempt) ? r.count_exempt : [...DEFAULT_COUNT_EXEMPT];
  return r;
}

export class StoreError extends PocpBaseError {}

// The record format this version reads and writes (`"pocp": 1` in every file).
export const FORMAT = 1;

/** A problem when a record was written for a newer format than this version understands. */
export function formatProblem(value) {
  const v = value && typeof value === 'object' ? value.pocp : undefined;
  if (v === undefined || v === FORMAT) return null;
  return Number.isInteger(v) && v > FORMAT
    ? `written for POCP format ${v}; this version reads format ${FORMAT} (upgrade pocp)`
    : `unknown POCP format ${JSON.stringify(v)} (expected ${FORMAT})`;
}

function readJson(file, { checkFormat = false } = {}) {
  const raw = fs.readFileSync(file, 'utf8');
  let value;
  try {
    value = JSON.parse(raw);
  } catch (err) {
    throw new StoreError(`invalid JSON in ${file}: ${err.message}`);
  }
  const problem = checkFormat ? formatProblem(value) : null;
  if (problem) throw new StoreError(`${file}: ${problem}`);
  return value;
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

const SLEEP = new Int32Array(new SharedArrayBuffer(4));

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

// A lock whose owner can't be read (empty, garbage: written by an older pocp between creating
// the file and writing its pid, or left by a crash in that moment) is treated as held, unless
// it is older than this. Conservative: no pocp writes its pid more than an instant after
// creating the file, and stealing a live lock is far worse than waiting.
export const UNKNOWN_OWNER_STALE_MS = 60_000;

/**
 * A lock file holds "<pid> <token>": the owner's pid, and a random token for this one
 * acquisition (a pid alone can be reused). Older versions wrote the pid only.
 */
function lockOwner(text) {
  const m = /^(\d+)(?: ([0-9a-f]+))?$/.exec(String(text ?? '').trim());
  if (!m) return null;
  const pid = Number(m[1]);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

/** Is the file at `file` older than `ms`? */
function olderThan(file, ms) {
  try {
    return Date.now() - fs.statSync(file).mtimeMs > ms;
  } catch {
    return false;
  }
}

/** Create `file` holding `content`, only if it doesn't exist: never visible empty. */
function publishExclusive(file, content) {
  const tmp = `${file}.new-${process.pid}-${randomBytes(6).toString('hex')}`;
  fs.writeFileSync(tmp, content, { flag: 'wx' });
  try {
    fs.linkSync(tmp, file);
    return true;
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
    return false;
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

/** A lock's content is abandoned: its owner is gone, or none can be read and the file is old. */
function abandoned(lockFile, text, unknownOwnerStaleMs) {
  const holder = lockOwner(text);
  return holder === null ? olderThan(lockFile, unknownOwnerStaleMs) : !pidAlive(holder);
}

/**
 * Take the lock if it is free; returns this acquisition's content (for release), or null. The
 * lock file appears with its owner already in it (publishExclusive), so no other process can
 * see an empty lock of ours and take it for a dead one.
 */
function tryAcquire(lockFile, { unknownOwnerStaleMs = UNKNOWN_OWNER_STALE_MS } = {}) {
  const mine = `${process.pid} ${randomBytes(8).toString('hex')}`;
  if (publishExclusive(lockFile, mine)) return mine;
  let text;
  try {
    text = fs.readFileSync(lockFile, 'utf8');
  } catch {
    return null; // vanished: try again
  }
  if (abandoned(lockFile, text, unknownOwnerStaleMs)) breakStaleLock(lockFile, text, { unknownOwnerStaleMs });
  return null;
}

/**
 * Remove an abandoned lock whose content was `observed`. Removing it must never free the slot
 * while someone holds it, so breaking is serialized on a second lock (`<lock>.break`, held for
 * a few system calls): inside it, the lock is removed only if it still has exactly the content
 * seen and is still abandoned. Nobody else can replace an abandoned lock meanwhile: taking the
 * slot needs it free, freeing it needs the break lock, and its owner is gone. The lock file is
 * never moved aside, so there is no moment when a live owner's lock is missing.
 *
 * A break lock left by a crash in those few calls is not reclaimed automatically (which would
 * reopen the race this prevents): withLock's error names it, for removal once no pocp runs.
 * `hooks.inside` runs while the break lock is held (tests use it as a barrier).
 */
export function breakStaleLock(lockFile, observed, { unknownOwnerStaleMs = UNKNOWN_OWNER_STALE_MS, hooks = {} } = {}) {
  const breaker = `${lockFile}.break`;
  const mine = `${process.pid} ${randomBytes(8).toString('hex')}`;
  if (!publishExclusive(breaker, mine)) return false; // someone else is breaking it
  try {
    let text;
    try {
      text = fs.readFileSync(lockFile, 'utf8');
    } catch {
      return false; // already gone
    }
    if (text !== observed || !abandoned(lockFile, text, unknownOwnerStaleMs)) return false;
    hooks.inside?.();
    fs.rmSync(lockFile, { force: true });
    return true;
  } finally {
    try {
      if (fs.readFileSync(breaker, 'utf8') === mine) fs.rmSync(breaker, { force: true });
    } catch { /* gone */ }
  }
}

/** Release only this acquisition's lock (its token), never a lock someone else now holds. */
function release(lockFile, mine) {
  try {
    if (fs.readFileSync(lockFile, 'utf8') === mine) fs.rmSync(lockFile, { force: true });
  } catch { /* already gone */ }
}

function heldError(lockFile) {
  const breaker = `${lockFile}.break`;
  const stuck = fs.existsSync(breaker) && olderThan(breaker, 60_000);
  return new StoreError(`another pocp process holds ${lockFile}${stuck ? ` (and ${breaker} was left by a crash: remove it once no pocp process is running)` : ''}`);
}

/** Run `fn` while holding an exclusive lock file (sync). Locks held by dead processes are broken. */
export function withLock(lockFile, fn, { waitMs = 10_000, unknownOwnerStaleMs } = {}) {
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  const deadline = Date.now() + waitMs;
  let mine;
  while (!(mine = tryAcquire(lockFile, { unknownOwnerStaleMs }))) {
    if (Date.now() > deadline) throw heldError(lockFile);
    Atomics.wait(SLEEP, 0, 0, 25);
  }
  try {
    return fn();
  } finally {
    release(lockFile, mine);
  }
}

/** Async version for long operations such as proving. */
export async function withLockAsync(lockFile, fn, { waitMs = 15 * 60_000, unknownOwnerStaleMs } = {}) {
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  const deadline = Date.now() + waitMs;
  let mine;
  while (!(mine = tryAcquire(lockFile, { unknownOwnerStaleMs }))) {
    if (Date.now() > deadline) throw heldError(lockFile);
    await new Promise((r) => setTimeout(r, 100));
  }
  try {
    return await fn();
  } finally {
    release(lockFile, mine);
  }
}

/**
 * Default Store: the `.proof/` folder in the repository.
 *   config.json, rules.json, packets/<id>.json, misses/<id>.json, runs/ (git-ignored)
 */
export function createFsStore(root) {
  const dir = path.join(root, PROOF_DIR);
  const p = (...parts) => path.join(dir, ...parts);

  function readDirJson(sub) {
    const d = p(sub);
    if (!fs.existsSync(d)) return [];
    return fs
      .readdirSync(d)
      .filter((f) => f.endsWith('.json'))
      .sort()
      .map((f) => readJson(path.join(d, f), { checkFormat: true }));
  }

  return {
    kind: 'fs',
    root,
    dir,
    exists: () => fs.existsSync(dir),
    readConfig: () => withDefaults(fs.existsSync(p('config.json')) ? readJson(p('config.json')) : {}),
    readRawRules: () => (fs.existsSync(p('rules.json')) ? readJson(p('rules.json')) : null),
    readRules: () => rulesWithDefaults(fs.existsSync(p('rules.json')) ? readJson(p('rules.json')) : {}),
    writeRules: (rules) => writeJsonAtomic(p('rules.json'), rules),
    writeConfig: (config) => writeJsonAtomic(p('config.json'), config),
    readPackets: () => readDirJson('packets'),
    readPacket: (id) => (fs.existsSync(p('packets', `${id}.json`)) ? readJson(p('packets', `${id}.json`), { checkFormat: true }) : null),
    writePacket: (packet) => writeJsonAtomic(p('packets', `${packet.id}.json`), packet),
    packetRelPath: (id) => `${PROOF_DIR}/packets/${id}.json`,
    readMisses: () => readDirJson('misses'),
    readMiss: (id) => (fs.existsSync(p('misses', `${id}.json`)) ? readJson(p('misses', `${id}.json`), { checkFormat: true }) : null),
    writeMiss: (miss) => writeJsonAtomic(p('misses', `${miss.id}.json`), miss),
    missRelPath: (id) => `${PROOF_DIR}/misses/${id}.json`,
    runsDir: () => {
      fs.mkdirSync(p('runs'), { recursive: true });
      return p('runs');
    },
    appendLog: (name, entry) => {
      fs.mkdirSync(p('runs'), { recursive: true });
      fs.appendFileSync(p('runs', `${name}.jsonl`), `${JSON.stringify(entry)}\n`);
    },
    readLog: (name) => {
      const f = p('runs', `${name}.jsonl`);
      if (!fs.existsSync(f)) return [];
      return fs
        .readFileSync(f, 'utf8')
        .split('\n')
        .filter(Boolean)
        .flatMap((line) => {
          try {
            return [JSON.parse(line)];
          } catch {
            return [];
          }
        });
    },
    lock: (name, fn) => withLock(p('runs', `${name}.lock`), fn),
    lockAsync: (name, fn) => withLockAsync(p('runs', `${name}.lock`), fn),
  };
}

const isPosInt = (n) => Number.isInteger(n) && n > 0;
const isStrArray = (a) => Array.isArray(a) && a.every((x) => typeof x === 'string');

/** Validate .proof/config.json (after defaults). Returns a list of problems. */
export function validateConfig(config) {
  const problems = [];
  const c = config || {};
  if (formatProblem(c)) problems.push(formatProblem(c));
  if (!(Number.isFinite(c.packet_ttl_days) && c.packet_ttl_days >= 0)) problems.push('packet_ttl_days must be a number ≥ 0');
  if (!isPosInt(c.area_depth)) problems.push('area_depth must be a positive integer');
  if (!isPosInt(c.proofs_kept_per_obligation)) problems.push('proofs_kept_per_obligation must be a positive integer');
  const run = c.run || {};
  if (!['clean', 'snapshot'].includes(run.mode)) problems.push('run.mode must be "clean" or "snapshot"');
  if (!['inherit', 'minimal'].includes(run.env)) problems.push('run.env must be "inherit" or "minimal"');
  if (!isPosInt(run.timeout_ms)) problems.push('run.timeout_ms must be a positive integer');
  if (!isPosInt(run.kill_grace_ms)) problems.push('run.kill_grace_ms must be a positive integer');
  if (!isPosInt(run.log_cap_bytes)) problems.push('run.log_cap_bytes must be a positive integer');
  if (!isStrArray(run.env_allow)) problems.push('run.env_allow must be an array of names');
  if (run.lockfile !== null && typeof run.lockfile !== 'string') problems.push('run.lockfile must be a path or null');
  if (!isStrArray(c.snapshot?.link)) problems.push('snapshot.link must be an array of paths');
  const sign = c.sign || {};
  if (sign.key !== null && typeof sign.key !== 'string') problems.push('sign.key must be a string or null');
  if (sign.principal !== null && typeof sign.principal !== 'string') problems.push('sign.principal must be a string or null');
  const guard = c.guard || {};
  if (!['attest', 'block', 'warn', 'off'].includes(guard.tests)) problems.push('guard.tests must be "attest", "block", "warn" or "off"');
  for (const k of ['extra_test_globs', 'extra_runner_globs']) {
    if (guard[k] !== undefined && !isStrArray(guard[k])) problems.push(`guard.${k} must be an array of globs`);
  }
  for (const k of ['test_globs', 'runner_globs']) {
    if (guard[k] !== null && !isStrArray(guard[k])) problems.push(`guard.${k} must be an array of globs or null`);
  }
  if (!Number.isInteger(guard.mutants) || guard.mutants < 0 || guard.mutants > 1000) problems.push('guard.mutants must be a whole number from 0 to 1000');
  if (!Number.isInteger(guard.seed)) problems.push('guard.seed must be a whole number');
  if (c.eval?.exclude !== undefined && !isStrArray(c.eval.exclude)) problems.push('eval.exclude must be an array of globs');
  const v = c.verify || {};
  if (!isStrArray(v.fail_on)) problems.push('verify.fail_on must be an array of finding codes');
  else for (const code of v.fail_on) if (!FINDING_CODES.includes(code)) problems.push(`verify.fail_on: unknown finding "${code}" (known: ${FINDING_CODES.join(', ')})`);
  if (!isStrArray(v.require_ci)) problems.push('verify.require_ci must be an array of commands');
  const ci = c.ci || {};
  if (!isStrArray(ci.files)) problems.push('ci.files must be an array of globs');
  if (ci.branch !== null && typeof ci.branch !== 'string') problems.push('ci.branch must be a branch name or null');
  if (!isStrArray(ci.required_checks)) problems.push('ci.required_checks must be an array of check names');
  for (const k of ['require_pull_request', 'enforce_admins']) if (typeof ci[k] !== 'boolean') problems.push(`ci.${k} must be true or false`);
  if (ci.require_up_to_date !== undefined && typeof ci.require_up_to_date !== 'boolean') problems.push('ci.require_up_to_date must be true or false');
  if (!['independent', 'any-writer'].includes(ci.workflow_approver)) problems.push('ci.workflow_approver must be "independent" or "any-writer"');
  const globLists = { 'guard.test_globs': guard.test_globs, 'guard.runner_globs': guard.runner_globs, 'guard.extra_test_globs': guard.extra_test_globs, 'guard.extra_runner_globs': guard.extra_runner_globs, 'ci.files': ci.files, 'eval.exclude': c.eval?.exclude };
  for (const [k, list] of Object.entries(globLists)) {
    if (!isStrArray(list)) continue;
    for (const gl of list) if (globProblem(gl)) problems.push(`${k}: ${globProblem(gl)}`);
  }
  return problems;
}

const GUARD_STRENGTH = { off: 0, warn: 1, attest: 2, block: 3 };

/** Ways the head config is looser than the base config (what fails, what's guarded). */
export function configWeakening(base, head) {
  if (!base) return [];
  const out = [];
  const bf = new Set(base.verify?.fail_on || []);
  const hf = new Set(head.verify?.fail_on || []);
  for (const code of bf) if (!hf.has(code)) out.push(`verify.fail_on no longer includes "${code}"`);
  for (const cmd of base.verify?.require_ci || []) if (!(head.verify?.require_ci || []).includes(cmd)) out.push(`verify.require_ci no longer requires "${cmd}"`);
  if ((GUARD_STRENGTH[head.guard?.tests] ?? 0) < (GUARD_STRENGTH[base.guard?.tests] ?? 0)) out.push(`guard.tests lowered from "${base.guard.tests}" to "${head.guard?.tests}"`);
  // A smaller sample catches less; a different seed lets a change pick a sample it passes.
  if (Number.isInteger(base.guard?.mutants) && !(head.guard?.mutants >= base.guard.mutants)) out.push(`guard.mutants lowered from ${base.guard.mutants}`);
  if (Number.isInteger(base.guard?.seed) && head.guard?.seed !== base.guard.seed) out.push(`guard.seed changed from ${base.guard.seed}`);
  for (const gl of base.ci?.files || []) if (!(head.ci?.files || []).includes(gl)) out.push(`ci.files no longer protects "${gl}"`);
  for (const check of base.ci?.required_checks || []) {
    if (!(head.ci?.required_checks || []).includes(check)) out.push(`ci.required_checks no longer requires "${check}"`);
  }
  if (base.ci?.require_pull_request === true && head.ci?.require_pull_request !== true) out.push('ci.require_pull_request turned off');
  if (base.ci?.enforce_admins === true && head.ci?.enforce_admins !== true) out.push('ci.enforce_admins turned off');
  if (base.ci?.require_up_to_date !== false && head.ci?.require_up_to_date === false) out.push('ci.require_up_to_date turned off');
  if ((base.ci?.workflow_approver ?? 'independent') === 'independent' && (head.ci?.workflow_approver ?? 'independent') !== 'independent') out.push('ci.workflow_approver no longer requires an approver other than the author');
  if (base.ci?.branch && head.ci?.branch !== base.ci.branch) out.push(`ci.branch changed from "${base.ci.branch}"`);
  // What the test guard watches: replacing or trimming its globs can hide a gutted test.
  const bg = effectiveGuardGlobs(base);
  const hg = effectiveGuardGlobs(head);
  for (const kind of ['test', 'runner']) {
    for (const gl of bg[kind]) if (!hg[kind].includes(gl)) out.push(`guard no longer treats "${gl}" as ${kind === 'test' ? 'a test file' : 'test setup'}`);
  }
  // Fewer folder levels means fewer areas, so the cross-area trigger fires less often.
  if (Number.isInteger(base.area_depth) && !(Number.isInteger(head.area_depth) && head.area_depth >= base.area_depth)) out.push(`area_depth lowered from ${base.area_depth}`);
  // Checks (and CI re-runs) would see the whole environment, including secrets.
  if (base.run?.env === 'minimal') {
    if (head.run?.env !== 'minimal') out.push('run.env changed from "minimal" to "inherit"');
    else for (const name of head.run?.env_allow || []) if (!(base.run.env_allow || []).includes(name)) out.push(`run.env_allow gained "${name}"`);
  }
  return out;
}

/** The stricter of two configs for verification settings (union of what fails or is required). */
export function strictConfig(base, head) {
  if (!base) return head;
  const out = structuredClone(head);
  out.verify.fail_on = [...new Set([...(base.verify?.fail_on || []), ...(head.verify?.fail_on || [])])];
  out.verify.require_ci = [...new Set([...(base.verify?.require_ci || []), ...(head.verify?.require_ci || [])])];
  if ((GUARD_STRENGTH[base.guard?.tests] ?? 0) > (GUARD_STRENGTH[head.guard?.tests] ?? 0)) out.guard.tests = base.guard.tests;
  if (Number.isInteger(base.guard?.mutants) && !(out.guard.mutants >= base.guard.mutants)) out.guard.mutants = base.guard.mutants;
  if (Number.isInteger(base.guard?.seed)) out.guard.seed = base.guard.seed;
  out.ci.files = [...new Set([...(base.ci?.files || []), ...(head.ci?.files || [])])];
  out.ci.required_checks = [...new Set([...(base.ci?.required_checks || []), ...(head.ci?.required_checks || [])])];
  out.ci.require_pull_request = base.ci?.require_pull_request === true || head.ci?.require_pull_request === true;
  out.ci.enforce_admins = base.ci?.enforce_admins === true || head.ci?.enforce_admins === true;
  out.ci.workflow_approver = [base.ci?.workflow_approver, head.ci?.workflow_approver].includes('independent') || !base.ci?.workflow_approver || !head.ci?.workflow_approver ? 'independent' : 'any-writer';
  if (base.ci?.branch) out.ci.branch = base.ci.branch;
  const bg = effectiveGuardGlobs(base);
  const hg = effectiveGuardGlobs(head);
  out.guard.test_globs = [...new Set([...bg.test, ...hg.test])];
  out.guard.runner_globs = [...new Set([...bg.runner, ...hg.runner])];
  out.guard.extra_test_globs = [];
  out.guard.extra_runner_globs = [];
  if (Number.isInteger(base.area_depth) && !(out.area_depth >= base.area_depth)) out.area_depth = base.area_depth;
  if (base.run?.env === 'minimal') {
    out.run.env = 'minimal';
    out.run.env_allow = (out.run.env_allow || []).filter((n) => (base.run.env_allow || []).includes(n));
  }
  return out;
}
