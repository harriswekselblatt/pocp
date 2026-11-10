// pocp packets: moved from src/cli.js unchanged; main() dispatches here.
import { EXIT } from '../errors.js';
import { out } from '../cli/shared.js';

export async function run({ engine, flags, json }) {
  const ps = flags.all ? engine.allPackets() : engine.activePackets();
  out(json, { packets: ps.map((p) => ({ id: p.id, state: p.state, intent: p.intent, opened_at: p.opened_at })) },
    ps.map((p) => `${p.id}  ${p.state.padEnd(9)} ${p.intent}`).join('\n') || 'no packets');
  return EXIT.ok;
}
