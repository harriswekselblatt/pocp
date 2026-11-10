// pocp history: moved from src/cli.js unchanged; main() dispatches here.
import { EXIT } from '../errors.js';
import { out } from '../cli/shared.js';
import { replayFixes, simulateGate } from '../history.js';

export async function run({ engine, flags, json, obligations }) {
  const limit = Number(flags.commits || 200);
  const sim = simulateGate(engine, { range: flags.range, limit });
  let fixes = null;
  const testCmd = obligations.find((o) => o.kind === 'test')?.run;
  if (testCmd) {
    fixes = await replayFixes(engine, { range: flags.range, limit: Number(flags.scan || 1000), maxFixes: Number(flags.fixes || 30), test: testCmd, jobs: flags.jobs ? Number(flags.jobs) : undefined });
  }
  const pct = (x) => (x === null ? 'n/a' : `${Math.round(x * 100)}%`);
  const human = [
    `gate replay: ${sim.would_need_packet} of the last ${sim.commits} commits would have needed a packet (${pct(sim.share)})`,
    `  reasons: ${Object.entries(sim.reasons).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}`,
    ...(fixes
      ? [
          `fix replay: ${fixes.fixes} past fix commits came with tests`,
          `  confirmed ${fixes.confirmed} (their test fails on the old code and passes on the fix)`,
          `  does not detect ${fixes.does_not_detect} · fails on the fix itself ${fixes.fails_on_fix} · errors ${fixes.errors}`,
          ...fixes.results.map((r) => `  ${r.verdict.padEnd(15)} ${r.commit.slice(0, 10)} ${r.subject.slice(0, 70)}`),
        ]
      : ['fix replay: skipped (pass --test "<command>", with {tests} for the fix\'s test files)']),
  ].join('\n');
  out(json, { gate: sim, fixes }, human);
  return EXIT.ok;
}
