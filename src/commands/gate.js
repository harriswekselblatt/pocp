// pocp gate: moved from src/cli.js unchanged; main() dispatches here.
import { EXIT } from '../errors.js';
import { formatGate, localizeCommands, out } from '../cli/shared.js';

export async function run({ engine, flags, json }) {
  // The pre-commit hook sets POCP_GATE_SOURCE=hook. Drop it so checks don't inherit it.
  const source = process.env.POCP_GATE_SOURCE === 'hook' ? 'hook' : 'gate';
  delete process.env.POCP_GATE_SOURCE;
  const r = await engine.gate({ prove: Boolean(flags.prove), mode: flags.mode, source });
  if (json) out(true, r);
  else process[r.decision === 'pass' ? 'stdout' : 'stderr'].write(`${localizeCommands(formatGate(r))}\n`);
  return r.decision === 'pass' ? EXIT.ok : r.decision === 'error' ? EXIT.usage : EXIT.blocked;
}
