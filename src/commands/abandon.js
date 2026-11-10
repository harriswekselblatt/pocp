// pocp abandon: moved from src/cli.js unchanged; main() dispatches here.
import { EXIT } from '../errors.js';
import { UsageError } from '../cli-args.js';
import { out } from '../cli/shared.js';

export async function run({ engine, flags, json, rest }) {
  if (!rest[0] || !flags.reason) throw new UsageError('usage: pocp abandon <packet> --reason <text>');
  const p = engine.abandon(rest[0], flags.reason, { by: flags.by });
  out(json, { packet: p }, `${p.id} abandoned`);
  return EXIT.ok;
}
