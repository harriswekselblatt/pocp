// pocp land: moved from src/cli.js unchanged; main() dispatches here.
import { EXIT } from '../errors.js';
import { out } from '../cli/shared.js';

export async function run({ engine, flags, json }) {
  const r = engine.land({ rev: flags.rev || 'HEAD' });
  if (!flags.quiet || json) out(json, r, r.landed.length ? `landed ${r.landed.join(', ')} in ${r.commit.slice(0, 12)}` : 'no packets landed in this commit');
  return EXIT.ok;
}
