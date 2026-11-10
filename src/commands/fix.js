// pocp fix: moved from src/cli.js unchanged; main() dispatches here.
import { EXIT } from '../errors.js';
import { formatFix, runFix } from '../fix.js';
import { localizeCommands, out } from '../cli/shared.js';

export async function run({ engine, flags, json, obligations }) {
  const r = await runFix(engine, { intent: flags.intent, test: obligations.find((o) => o.kind === 'test')?.run, mode: flags.mode, actor: engine.actor });
  if (json) out(true, { ...r, gate: { decision: r.gate.decision, subject: r.gate.subject } });
  else process[r.ok ? 'stdout' : 'stderr'].write(`${localizeCommands(formatFix(r))}\n`);
  return r.ok ? EXIT.ok : EXIT.blocked;
}
