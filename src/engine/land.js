// Landing: trailer lines for proven packets that cover the staged files (trailers,
// addTrailersToFile), and marking packets landed once their commit exists (land).
import fs from 'node:fs';
import * as g from '../git.js';
import * as P from '../packets.js';
import { formatTrailer, parseTrailers, TRAILER_KEY } from '../trailer.js';
import { digestMatches } from '../hash.js';

/** Trailers and landing for one engine. */
export function createLand({ root, store, emit, stagedForCoverage, activePackets, evaluate }) {

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

  return { trailers, addTrailersToFile, land };
}
