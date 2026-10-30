// How a check run ended, for the runs whose result is evidence about tests: the test guard's
// base and mutant runs (SPEC §6.2) and mutation eval (§11.2).

/** The check ran to the end and reported failure (not a timeout, signal, spawn error or missing command). */
export function ranAndFailed(r) {
  return !r.passed && !r.timed_out && !r.signal && !r.error && Number.isInteger(r.exit) && r.exit !== 126 && r.exit !== 127;
}

/** Why a run that didn't pass also didn't finish normally (for a run `ranAndFailed` rejects). */
export function unfinishedReason(r) {
  if (r.timed_out) return 'timed out';
  if (r.error) return `could not start (${r.error})`;
  if (r.signal) return `killed by ${r.signal}`;
  if (r.exit === 127) return 'exit 127 (command not found)';
  if (r.exit === 126) return 'exit 126 (command not executable)';
  return 'ended without an exit code';
}
