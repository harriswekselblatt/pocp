// pocp attest: moved from src/cli.js unchanged; main() dispatches here.
import { EXIT } from '../errors.js';
import { UsageError } from '../cli-args.js';
import { out } from '../cli/shared.js';
import { shortDigest } from '../hash.js';

export async function run({ engine, flags, json, rest }) {
  if (!rest[0] || !rest[1]) throw new UsageError('usage: pocp attest <packet> <obligation> --by <who> [--note <text>]');
  if (!flags.by) throw new UsageError('pocp attest needs --by (who is attesting)');
  const r = engine.attest(rest[0], rest[1], { by: flags.by, note: flags.note });
  out(json, r, `${r.attestation.obligation} attested by ${r.attestation.by} for ${shortDigest(r.attestation.subject)}`);
  return EXIT.ok;
}
