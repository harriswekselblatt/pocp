import { isRunnable, obligationDigest } from './obligations.js';

function median(nums) {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

const ratio = (a, b) => (b > 0 ? Math.round((a / b) * 1000) / 1000 : null);

/**
 * Metrics from packets, misses, rules and the local gate log (SPEC §11.1).
 *
 * caught: landed packets that recorded at least one failed proof before landing,
 *         plus misses recorded at stage "gate".
 * escaped: misses recorded at any later stage.
 */
// Gate log entries by where they came from: hook (a commit attempt), gate (pocp gate run by
// hand), fix (pocp fix's own rounds), api (a library caller). Lines written before the field
// existed have no source and count as unknown.
function bySource(gateLog) {
  const out = {};
  for (const e of gateLog) {
    const k = typeof e.source === 'string' && e.source ? e.source : 'unknown';
    const o = (out[k] ||= { evaluations: 0, blocks: 0 });
    o.evaluations++;
    if (e.decision === 'blocked') o.blocks++;
  }
  return out;
}

export function computeMetrics({ packets = [], misses = [], rules = { requirements: [] }, gateLog = [] }) {
  const byState = {};
  for (const p of packets) byState[p.state] = (byState[p.state] || 0) + 1;
  const landed = packets.filter((p) => p.state === 'landed');

  const caughtPackets = landed.filter((p) => p.history.some((h) => h.event === 'proof_failed')).length;
  const gateMisses = misses.filter((m) => m.stage === 'gate').length;
  const escaped = misses.filter((m) => m.stage !== 'gate').length;
  const caught = caughtPackets + gateMisses;

  let runnable = 0;
  let total = 0;
  const costs = [];
  for (const p of landed) {
    total += p.obligations.length;
    runnable += p.obligations.filter(isRunnable).length;
    // Cost: the passing proofs that landed (latest passing proof per obligation).
    let ms = 0;
    for (const ob of p.obligations.filter(isRunnable)) {
      const d = obligationDigest(ob);
      const proof = [...p.proofs].reverse().find((x) => x.obligation === ob.id && x.obligation_digest === d && x.passed);
      if (proof) ms += proof.duration_ms || 0;
    }
    costs.push(ms);
  }

  // Friction: a block whose subject later passed the gate unchanged, with no failed proof in between.
  const blocks = gateLog.filter((e) => e.decision === 'blocked');
  let friction = 0;
  for (const [i, e] of gateLog.entries()) {
    if (e.decision !== 'blocked') continue;
    if (e.uncovered > 0) continue; // a missing packet is a real gap, not friction
    const later = gateLog.slice(i + 1);
    const pass = later.find((x) => x.subject === e.subject && x.decision === 'pass');
    if (!pass) continue;
    const failedBetween = later
      .slice(0, later.indexOf(pass))
      .some((x) => x.subject === e.subject && x.packets?.some((pp) => pp.failed > 0));
    if (!failedBetween && !e.packets?.some((pp) => pp.failed > 0)) friction++;
  }

  const ratchetRules = (rules.requirements || []).filter((r) => String(r.source || '').startsWith('miss:'));
  const closed = misses.filter((m) => m.state === 'closed');

  return {
    packets: { total: packets.length, by_state: byState },
    catch_rate: ratio(caught, caught + escaped),
    caught: { total: caught, packets_with_failed_proofs: caughtPackets, misses_at_gate: gateMisses },
    escaped,
    escape_rate_per_100: landed.length ? Math.round((escaped / landed.length) * 10000) / 100 : null,
    proven_share: ratio(runnable, total),
    friction: ratio(friction, blocks.length),
    gate: { evaluations: gateLog.length, blocks: blocks.length, friction_blocks: friction, by_source: bySource(gateLog) },
    cost_ms_median: median(costs),
    ratchet: {
      rules_from_misses: ratchetRules.length,
      misses_closed_rule_added: closed.filter((m) => m.closed === 'rule-added').length,
      misses_closed_replay_confirmed: closed.filter((m) => m.closed === 'replay-confirmed').length,
      misses_open: misses.filter((m) => m.state === 'open').length,
    },
    notes: [
      'expired and abandoned packets are never counted as completed',
      'merged packets reached the branch with code other than what was proven (squash or rebase merges); they are counted apart from landed',
    ],
  };
}
