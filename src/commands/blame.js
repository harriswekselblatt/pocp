// pocp blame: moved from src/cli.js unchanged; main() dispatches here.
import { EXIT } from '../errors.js';
import { UsageError } from '../cli-args.js';
import { out } from '../cli/shared.js';

export async function run({ engine, json, rest }) {
  if (!rest[0]) throw new UsageError('usage: pocp blame <file>');
  const r = engine.blame(rest[0]);
  out(json, { file: rest[0], commits: r }, r.map((c) => `${c.commit.slice(0, 12)}  ${c.packets.join(', ')}`).join('\n') || 'no packets have changed this file');
  return EXIT.ok;
}
