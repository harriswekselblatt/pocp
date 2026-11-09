// Definitions the engine's modules share, kept in one leaf so no module imports the facade
// (engine.js), which re-exports them under the same names.
import { PocpBaseError } from '../errors.js';
import { DEFAULT_CI_FILES } from '../store.js';
import { matchGlob } from '../glob.js';
import { defaultJobs, semaphore } from '../guard-check.js';

export const STAGES = Object.freeze(['gate', 'commit', 'ci', 'review', 'production']);
export const SEVERITIES = Object.freeze(['low', 'medium', 'high', 'critical']);

/** POCP refused or blocked something (exit 1). `details` goes into --json output as is. */
export class PocpError extends PocpBaseError {
  static category = 'blocked';

  constructor(message, details = {}, { code = null } = {}) {
    super(message, { code });
    this.details = details;
  }
}

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

/**
 * The files an approval for a protected change lists: the CI files, or the other protected files
 * when no CI file changed (the first group protectedChangeText names).
 */
function protectedApprovalFiles(files) {
  const isCi = (f) => DEFAULT_CI_FILES.some((gl) => matchGlob(f, gl));
  const ci = files.filter(isCi);
  return ci.length ? ci : files.filter((f) => !isCi(f));
}

const ciKey = (r) => `${r.cwd || ''}\0${r.run}`;
/** The last record per (subject, cwd, command), in file order. */
export function latestCiResults(records = []) {
  const m = new Map();
  for (const r of records) m.set(`${r.subject}\0${ciKey(r)}`, r);
  return [...m.values()];
}

/**
 * The checks one verify runs: a check that already passed on a commit's exact code in this
 * verify (a re-run, or the test guard's baseline) is not run again, by (subject, cwd, command).
 * Checks that match output (`expect`) are never shared. CI results count only for the guard's
 * baseline (rerunAt applies its own rule for them).
 *
 * verify starts its re-runs and its test guard together, so a check can be asked for while
 * the same check on the same code is still running: `share` then waits for that run and
 * reuses it if it passed. Only a pass is ever shared. A run that failed, timed out or didn't
 * start is not, so the one asking runs the check itself, as it would have before. `limit`
 * caps how many checks run at once across the whole verify.
 */
export function createRunMemo({ jobs } = {}) {
  const seen = new Map();
  const running = new Map(); // key -> promise of the run in progress
  const limitN = Math.max(1, Number(jobs) || defaultJobs());
  const slots = semaphore(limitN);
  const key = (subject, ob) => `${subject}\0${ob.cwd || ''}\0${ob.run}`;
  const known = (subject, ob, ciResults = []) => {
    if (ob.expect || !ob.run) return null;
    const hit = seen.get(key(subject, ob));
    if (hit) return hit;
    const last = latestCiResults(ciResults.filter((r) => r.subject === subject && r.run === ob.run && (r.cwd || '') === (ob.cwd || ''))).pop();
    return last?.passed ? { duration_ms: last.duration_ms } : null;
  };
  const record = (subject, ob, r) => {
    if (!ob.expect && ob.run) seen.set(key(subject, ob), { duration_ms: r.duration_ms });
  };
  return {
    /** How many checks this verify runs at once (the test guard uses the same number). */
    jobs: limitN,
    record,
    known,
    ran(subject, ob) {
      return !ob.expect && seen.has(key(subject, ob));
    },
    /**
     * `run()` once per check and code: { reused: { duration_ms } } for a pass seen here (or, with
     * `ciResults`, recorded by CI), else { result } of running it. Deciding to run and marking
     * the run as in progress happen with no await in between, so two callers can't both start it.
     */
    async share(subject, ob, run, ciResults = []) {
      if (ob.expect || !ob.run) return { result: await run() };
      const k = key(subject, ob);
      for (;;) {
        const hit = known(subject, ob, ciResults);
        if (hit) return { reused: hit };
        const pending = running.get(k);
        if (!pending) break;
        await pending.then(() => {}, () => {});
      }
      const p = run();
      running.set(k, p);
      try {
        const result = await p;
        if (result.passed) record(subject, ob, result);
        return { result };
      } finally {
        if (running.get(k) === p) running.delete(k);
      }
    },
    /** Run `fn` when one of this verify's check slots is free. */
    async limit(fn) {
      await slots.acquire();
      try {
        return await fn();
      } finally {
        slots.release();
      }
    },
  };
}

export { ciKey, protectedApprovalFiles };
