// pocp prove: moved from src/cli.js unchanged; main() dispatches here.
import { EXIT } from '../errors.js';
import { evalLine, guardLines, list, out } from '../cli/shared.js';
import { shortDigest } from '../hash.js';

export async function run({ engine, flags, json, rest }) {
  const r = await engine.prove({ ids: rest, mode: flags.mode, force: Boolean(flags.force), only: list(flags.only), stage: !flags['no-stage'] });
  // Exit 1 only when a check failed or a run was thrown away; pending sign-offs are not failures.
  const anyFail = r.packets.some((p) => p.evaluation.failed.length || p.runs.some((x) => x.discarded));
  const human = r.packets.length === 0
    ? 'nothing to prove: no active packets cover the staged files'
    : [
        `subject ${shortDigest(r.subject)} (${r.mode} mode)`,
        ...r.packets.flatMap((p) => [
          `${p.id}: ${p.state} · ${evalLine(p.evaluation)}`,
          ...p.runs.map((x) => `  ${x.obligation}: ${x.skipped ? `skipped (${x.skipped})` : x.discarded ? `DISCARDED (${x.discarded.join('; ')})` : x.guard ? `test guard ${x.passed ? 'pass' : x.guard} (${x.duration_ms}ms): ${x.summary}` : x.passed ? `pass (${x.duration_ms}ms)` : `FAIL exit=${x.exit}${x.timed_out ? ' timed out' : ''} · log .proof/runs/${x.run_id}.log`}`),
          ...(() => {
            const guardIds = (p.evaluation.guard || []).map((x) => x.id);
            const plain = p.evaluation.unattested.filter((x) => !guardIds.includes(x));
            return [
              ...(plain.length ? [`  needs sign-off: ${plain.join(', ')}  →  pocp attest ${p.id} <obligation> --by <you>`] : []),
              ...guardLines(p.evaluation, p.id, '  needs sign-off: '),
            ];
          })(),
        ]),
      ].join('\n');
  out(json, r, anyFail ? `${human}\n  next: fix the code (not the tests), stage it, and run "pocp fix" (it won't re-run a check that already failed on the same code)` : human);
  return anyFail ? EXIT.blocked : EXIT.ok;
}
