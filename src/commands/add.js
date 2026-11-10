// pocp add: moved from src/cli.js unchanged; main() dispatches here.
import { EXIT } from '../errors.js';
import { UsageError } from '../cli-args.js';
import { describeObligation } from '../obligations.js';
import { out } from '../cli/shared.js';

export async function run({ engine, flags, json, obligations, rest }) {
  if (!rest[0] || !obligations.length) throw new UsageError('usage: pocp add <packet> --test <cmd> | --command <cmd> | --probe <cmd> | --manual <text>');
  const added = [];
  let packet;
  for (const spec of obligations) {
    const r = await engine.addObligation(rest[0], spec, { by: flags.by });
    added.push(r.obligation);
    packet = r.packet;
  }
  out(json, { packet, added }, added.map((o) => `added ${o.id} to ${packet.id}: ${describeObligation(o)}`).join('\n'));
  return EXIT.ok;
}
