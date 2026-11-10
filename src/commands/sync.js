// pocp sync: moved from src/cli.js unchanged; main() dispatches here.
import { EXIT } from '../errors.js';
import { out } from '../cli/shared.js';

export async function run({ engine, json, rest }) {
  const r = await engine.sync(rest);
  out(json, { packets: r }, r.map((x) => `${x.id}: ${x.added.length ? `added ${x.added.join(', ')}` : 'up to date'}`).join('\n') || 'no active packets');
  return EXIT.ok;
}
