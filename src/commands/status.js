// pocp status: moved from src/cli.js unchanged; main() dispatches here.
import { EXIT } from '../errors.js';
import { evalLine, out } from '../cli/shared.js';
import { hooksHealth } from '../init.js';
import { shortDigest } from '../hash.js';

export async function run({ engine, json }) {
  const s = await engine.status();
  s.hooks = hooksHealth(process.cwd());
  const human = [
    ...s.hooks.problems.map((p) => `warning: ${p}`),
    `subject ${shortDigest(s.subject)} · ${s.staged.length} staged file(s)`,
    ...s.packets.map((p) => `${p.id} ${p.state}: ${p.intent}\n  ${evalLine(p.evaluation)}`),
    s.packets.length ? null : 'no active packets',
    ...s.rules_problems.map((p) => `rules: ${p}`),
  ].filter(Boolean).join('\n');
  out(json, s, human);
  return EXIT.ok;
}
