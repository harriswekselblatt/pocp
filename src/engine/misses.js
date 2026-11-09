// Misses and the ratchet: recording a bug that escaped, linking it to the packets that let it
// through (blame), and closing it with a rule whose check, replayed, catches the bug where it
// escaped and passes at the fix.
import fs from 'node:fs';
import path from 'node:path';
import * as g from '../git.js';
import { createIndexSnapshot } from '../workspace.js';
import { randomId } from '../hash.js';
import { matchGlob } from '../glob.js';
import { isRunnable, ValidationError } from '../obligations.js';
import { globsOf } from '../rules.js';
import { parseTrailers } from '../trailer.js';
import { PocpError, SEVERITIES, STAGES } from './shared.js';

/**
 * The miss operations of one engine. `opts` is the engine's options object, passed whole so
 * calls like opts.newId?.() keep their receiver; config and rules are the live readers.
 */
export function createMisses({ opts, root, store, actor, nowFn, emit, mutexAsync, config, rules, runObligation }) {
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

  return { blame, recordMiss, loadMiss, ratchetRules, closeMiss };
}
