// Shared by the adapters.

/** Map a finished CLI process to a run status. */
export function statusOf(r, reportedError) {
  if (r.timedOut) return 'timeout';
  if (r.code !== 0 || reportedError) return 'agent-error';
  return 'completed';
}
