// pocp ready: moved from src/cli.js unchanged; main() dispatches here.
import { EXIT } from '../errors.js';
import { UsageError } from '../cli-args.js';
import { out } from '../cli/shared.js';

export async function run({ engine, json, rest }) {
  if (!rest[0]) throw new UsageError('usage: pocp ready <packet>');
  const p = engine.ready(rest[0]);
  out(json, { packet: p }, `${p.id} is open`);
  return EXIT.ok;
}
