// pocp doctor: moved from src/cli.js unchanged; main() dispatches here.
import { EXIT } from '../errors.js';
import { formatDoctor, runDoctor } from '../doctor.js';
import { out } from '../cli/shared.js';

export async function run({ engine, flags, json }) {
  const r = await runDoctor(engine, { base: flags.base, offline: Boolean(flags.offline) });
  out(json, r, formatDoctor(r));
  return r.ok ? EXIT.ok : EXIT.blocked;
}
