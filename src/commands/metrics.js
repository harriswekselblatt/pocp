// pocp metrics: moved from src/cli.js unchanged; main() dispatches here.
import { EXIT } from '../errors.js';
import { computeMetrics } from '../metrics.js';
import { out } from '../cli/shared.js';

export async function run({ engine, json }) {
  const m = computeMetrics({
    packets: engine.allPackets(),
    misses: engine.store.readMisses(),
    rules: engine.rules(),
    gateLog: engine.store.readLog?.('gate') || [],
  });
  const pct = (x) => (x === null ? 'n/a' : `${Math.round(x * 100)}%`);
  out(json, m, [
    `packets: ${m.packets.total} (${Object.entries(m.packets.by_state).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'})`,
    `catch rate: ${pct(m.catch_rate)} · escaped: ${m.escaped} · escapes per 100 landed: ${m.escape_rate_per_100 ?? 'n/a'}`,
    `proven share: ${pct(m.proven_share)} · friction: ${pct(m.friction)} · median proof cost: ${m.cost_ms_median ?? 'n/a'}ms`,
    `ratchet: ${m.ratchet.rules_from_misses} rule(s) from misses · closed ${m.ratchet.misses_closed_rule_added} rule-added, ${m.ratchet.misses_closed_replay_confirmed} replay-confirmed · open ${m.ratchet.misses_open}`,
  ].join('\n'));
  return EXIT.ok;
}
