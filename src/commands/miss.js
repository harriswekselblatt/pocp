// pocp miss: moved from src/cli.js unchanged; main() dispatches here.
import { EXIT } from '../errors.js';
import { UsageError } from '../cli-args.js';
import { list, out } from '../cli/shared.js';

export async function run({ engine, flags, json, rest }) {
  const sub = rest[0];
  if (sub === 'record') {
    const m = engine.recordMiss({
      description: flags.description,
      stage: flags.stage,
      severity: flags.severity || 'medium',
      files: list(flags.file),
      failing_check: flags.check || null,
      packets: flags.packet ? list(flags.packet) : undefined,
      by: flags.by,
    });
    out(json, { miss: m }, `recorded ${m.id}${m.packets.length ? ` (linked to ${m.packets.join(', ')})` : ''}\nnext: add a rule with "source": "miss:${m.id}" to .proof/rules.json, then pocp miss close ${m.id}`);
    return EXIT.ok;
  }
  if (sub === 'close') {
    if (!rest[1]) throw new UsageError('usage: pocp miss close <id> [--fix <text>] [--replay <rev>]');
    const m = await engine.closeMiss(rest[1], { fix: flags.fix, replay: flags.replay, by: flags.by });
    out(json, { miss: m }, `${m.id} closed (${m.closed}) by rule(s) ${m.rules.join(', ')}`);
    return EXIT.ok;
  }
  if (sub === 'list') {
    const ms = engine.store.readMisses();
    out(json, { misses: ms }, ms.map((m) => `${m.id}  ${m.state.padEnd(6)} ${m.stage.padEnd(10)} ${m.description}`).join('\n') || 'no misses');
    return EXIT.ok;
  }
  throw new UsageError('usage: pocp miss record|close|list');
}
