// Definitions the engine's modules share, kept in one leaf so no module imports the facade
// (engine.js), which re-exports them under the same names.
import { PocpBaseError } from '../errors.js';

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
