// pocp eval: moved from src/cli.js unchanged; main() dispatches here.
import fs from 'node:fs';
import { EXIT } from '../errors.js';
import { UsageError } from '../cli-args.js';
import { list, out } from '../cli/shared.js';
import { runMutantEval } from '../mutants.js';

export async function run({ engine, flags, json }) {
  let replay;
  if (flags.replay) {
    if (!fs.existsSync(flags.replay)) throw new UsageError(`no such eval file: ${flags.replay}`);
    const saved = JSON.parse(fs.readFileSync(flags.replay, 'utf8'));
    // --missed: the survivors, and the mutants that weren't measured (a check timed out or
    // couldn't run), by outcome, since older saves marked timeouts caught.
    replay = (saved.mutants || []).filter((m) => m.line_text !== undefined && (!flags.missed || m.caught === false || m.outcome === 'timeout' || m.outcome === 'error'));
  }
  let corpus;
  if (flags.corpus) {
    if (!fs.existsSync(flags.corpus)) throw new UsageError(`no such corpus file: ${flags.corpus}`);
    const saved = JSON.parse(fs.readFileSync(flags.corpus, 'utf8'));
    corpus = Array.isArray(saved) ? saved : saved.mutants;
    if (!Array.isArray(corpus) || !corpus.length) throw new UsageError(`corpus has no mutants: ${flags.corpus}`);
  }
  const n = flags.mutants === 'all' ? 'all' : Number(flags.mutants);
  if (!replay && !corpus && n !== 'all' && (!Number.isInteger(n) || n <= 0)) throw new UsageError('usage: pocp eval --mutants <n|all> [--seed <n>] [--jobs <n>] [--file <glob>]... [--missed] [--save <file>] | --replay <file> [--missed]');
  const r = await runMutantEval(engine, { count: n, seed: Number(flags.seed || 1), files: list(flags.file), jobs: flags.jobs ? Number(flags.jobs) : undefined, replay, corpus });
  if (flags.save && r.ok) fs.writeFileSync(flags.save, `${JSON.stringify(r, null, 2)}\n`);
  // Not-measured mutants are always listed: they are the gap in the score.
  const shown = r.ok ? r.mutants.filter((m) => m.outcome !== 'gone' && (!flags.missed || !m.caught)) : [];
  const unmeasured = r.ok && r.not_measured ? ` · ${r.not_measured} not measured (${[r.timeouts ? `${r.timeouts} timed out` : '', r.errors ? `${r.errors} couldn't run` : ''].filter(Boolean).join(', ')}), not scored` : '';
  const tag = (m) => (m.caught ? 'caught ' : m.caught === null ? 'NOT MEASURED' : 'MISSED ');
  out(json, r, r.ok
    ? [
        `mutation eval${r.replayed ? ' (replayed sample)' : r.corpus ? ' (corpus)' : ''}: caught ${r.caught}/${r.total} (${Math.round((r.catch_rate || 0) * 100)}%)${unmeasured}${r.replayed || r.corpus ? (r.gone ? ` · ${r.gone} no longer apply` : '') : ` of ${r.sites} sites`} · ${r.jobs} workers · ${Math.round(r.duration_ms / 1000)}s${flags.save ? ` · saved to ${flags.save}` : ''}`,
        ...shown.map((m) => `  ${tag(m)} ${m.file}:${m.line} ${m.operator}${m.caught_by ? ` by ${m.caught_by}` : m.not_measured ? `: ${m.not_measured.map((x) => `${x.check} ${x.reason}`).join(', ')}` : `\n      - ${m.before}\n      + ${m.after}`}`),
      ].join('\n')
    : `mutation eval: ${r.error}`);
  return r.ok ? EXIT.ok : EXIT.blocked;
}
