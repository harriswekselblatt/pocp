// The end of a failed check's output, for verify to print. verify keeps only hashes of a
// check's output in what it reports as proof; without this, a check that fails in CI says
// only "failed (exit 1)" and nobody can see why.
//
// The text is the check's (the pull request's) own output, so it is made inert before it is
// printed: terminal escapes and control characters are removed, and every line is prefixed, so
// nothing in it can start a line that a CI runner would read as a command (GitHub's "::...").

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f]/g;

export const TAIL_LINES = 60;
export const TAIL_BYTES = 8 * 1024;
// At most this many failed checks' output in one verify; the full logs are in .proof/runs.
export const TAIL_CHECKS = 4;

/** The last `maxLines` lines of `text` (at most `maxBytes` bytes), cleaned. '' when empty. */
export function outputTail(text, { maxLines = TAIL_LINES, maxBytes = TAIL_BYTES } = {}) {
  const clean = String(text || '').replace(/\r\n?/g, '\n').replace(ANSI, '').replace(CONTROL, '').replace(/\s+$/, '');
  if (!clean) return '';
  const lines = clean.split('\n').slice(-maxLines);
  let bytes = lines.reduce((n, l) => n + Buffer.byteLength(l) + 1, 0);
  while (lines.length > 1 && bytes > maxBytes) bytes -= Buffer.byteLength(lines.shift()) + 1;
  if (Buffer.byteLength(lines[0]) > maxBytes) {
    // One very long line: keep its end, starting on a whole character.
    lines[0] = `…${Buffer.from(lines[0]).subarray(-maxBytes).toString('utf8').replace(/^�+/, '')}`;
  }
  return lines.join('\n');
}

/** Lines for verify's report: each failed re-run's output tail, prefixed so it stays inert. */
export function failedOutputLines(reruns, { maxChecks = TAIL_CHECKS } = {}) {
  const failed = reruns.filter((x) => x && x.status === 'failed' && x.output_tail);
  if (!failed.length) return [];
  const out = [];
  for (const x of failed.slice(0, maxChecks)) {
    const how = [x.timed_out ? 'timed out' : `exit ${x.exit}`, ...(x.signal ? [x.signal] : []), ...(x.packets?.length ? [x.packets.join(', ')] : [])].join(', ');
    out.push('', `  output of failed check "${x.run}" (${how}), last ${TAIL_LINES} lines at most${x.output_truncated ? '; the output was longer than the log cap, so this is the end of what was kept' : ''}:`);
    out.push(...x.output_tail.split('\n').map((l) => `    | ${l}`));
  }
  if (failed.length > maxChecks) out.push('', `  (${failed.length - maxChecks} more failed check(s); full output in .proof/runs/*.log)`);
  return out;
}
