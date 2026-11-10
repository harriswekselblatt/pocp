// pocp show: moved from src/cli.js unchanged; main() dispatches here.
import { EXIT } from '../errors.js';
import { UsageError } from '../cli-args.js';
import { out } from '../cli/shared.js';

export async function run({ engine, json, rest }) {
  if (!rest[0]) throw new UsageError('usage: pocp show <packet>');
  const p = engine.loadPacket(rest[0]);
  out(json, { packet: p }, JSON.stringify(p, null, 2));
  return EXIT.ok;
}
