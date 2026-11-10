// pocp check-edit: moved from src/cli.js unchanged; main() dispatches here.
import { EXIT } from '../errors.js';
import { UsageError } from '../cli-args.js';
import { errWrite, out } from '../cli/shared.js';

export async function run({ engine, json, rest }) {
  if (!rest.length) throw new UsageError('usage: pocp check-edit <file>...');
  const r = await engine.checkEdit(rest);
  if (json) out(true, r);
  else if (r.ok) out(false, r, r.protected.length ? `ok: covered by an open packet (${r.protected.join(', ')})` : 'ok: not protected');
  else errWrite(`pocp: open a packet before editing ${r.uncovered.join(', ')}\n  why: the rules protect these files, so a change to them must say what it is for and carry its proof\n  next: ${r.suggestion.command}\n  (or edit, stage, and run "pocp fix --intent <what the change does>" before committing)\n`);
  return r.ok ? EXIT.ok : EXIT.blocked;
}
