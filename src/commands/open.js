// pocp open: moved from src/cli.js unchanged; main() dispatches here.
import { EXIT } from '../errors.js';
import { UsageError } from '../cli-args.js';
import { describeObligation } from '../obligations.js';
import { list, out } from '../cli/shared.js';

export async function run({ engine, flags, json, obligations }) {
  if (!flags.intent) throw new UsageError('pocp open needs --intent');
  const touches = list(flags.touch);
  if (!touches.length) throw new UsageError('pocp open needs at least one --touch');
  const r = await engine.open({ intent: flags.intent, touches, obligations, draft: Boolean(flags.draft), by: flags.by });
  out(json, { packet: r.packet, required_added: r.required_added.map((o) => o.id) }, [
    `opened ${r.packet.id}: ${r.packet.intent}`,
    ...r.packet.obligations.map((o) => `  ${o.id} [${o.source}] ${describeObligation(o)}`),
    r.packet.obligations.length ? `next: pocp prove ${r.packet.id}` : `next: add a check, e.g. pocp add ${r.packet.id} --test "<command>"`,
  ].join('\n'));
  return EXIT.ok;
}
