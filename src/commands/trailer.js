// pocp trailer: moved from src/cli.js unchanged; main() dispatches here.
import fs from 'node:fs';
import { EXIT } from '../errors.js';
import { UsageError } from '../cli-args.js';
import { out } from '../cli/shared.js';

export async function run({ engine, json, rest }) {
  if (rest[0]) {
    if (!fs.existsSync(rest[0])) throw new UsageError(`no such message file: ${rest[0]}`);
    const lines = await engine.addTrailersToFile(rest[0], { source: rest[1] });
    out(json, { trailers: lines }, null);
  } else {
    const lines = await engine.trailers();
    out(json, { trailers: lines }, lines.map((l) => `Proof-Of-Change: ${l}`).join('\n'));
  }
  return EXIT.ok;
}
