// pocp widen: moved from src/cli.js unchanged; main() dispatches here.
import { EXIT } from '../errors.js';
import { UsageError } from '../cli-args.js';
import { list, out } from '../cli/shared.js';

export async function run({ engine, flags, json, rest }) {
  if (!rest[0] || !list(flags.touch).length) throw new UsageError('usage: pocp widen <packet> --touch <path>...');
  const r = await engine.widen(rest[0], list(flags.touch), { by: flags.by });
  out(json, { packet: r.packet, added: r.added, required_added: r.required_added.map((o) => o.id) },
    `${r.packet.id} now covers ${r.packet.touches.length} path(s)${r.required_added.length ? `; required checks added: ${r.required_added.map((o) => o.id).join(', ')}` : ''}`);
  return EXIT.ok;
}
