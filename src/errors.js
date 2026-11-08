// One base for every error POCP raises on purpose, and one table from errors to exit codes.
//
// Each error class says what kind of failure it is (its `category`), and an error can carry a
// stable `code` for callers to branch on. Nothing decides by reading an error's message.

/** CLI exit codes (SPEC: 0 pass, 1 blocked, 2 usage or config error, 3 internal error). */
export const EXIT = Object.freeze({ ok: 0, blocked: 1, usage: 2, internal: 3 });

/** What each category of error exits with. */
const EXIT_FOR_CATEGORY = Object.freeze({ blocked: EXIT.blocked, usage: EXIT.usage });

export class PocpBaseError extends Error {
  /** The kind of failure: 'usage' (a usage or config error) or 'blocked'. Subclasses override. */
  static category = 'usage';

  /** @param {string} message @param {{ code?: string | null }} [options] */
  constructor(message, { code = null } = {}) {
    super(message);
    this.name = new.target.name;
    if (code !== null) this.code = code;
  }

  get category() {
    return this.constructor.category;
  }
}

/** The exit code for an error: its category's, or internal for anything POCP didn't raise. */
export function exitCodeFor(err) {
  return err instanceof PocpBaseError ? EXIT_FOR_CATEGORY[err.category] : EXIT.internal;
}

/** Whether POCP raised this error on purpose (so it is reported without a stack trace). */
export function isKnownError(err) {
  return err instanceof PocpBaseError;
}
