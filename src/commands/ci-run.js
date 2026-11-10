// pocp ci-run: moved from src/cli.js unchanged; main() dispatches here.
import fs from 'node:fs';
import path from 'node:path';
import { EXIT } from '../errors.js';
import { UsageError } from '../cli-args.js';
import { out, shellJoin } from '../cli/shared.js';

export async function run({ engine, flags, json, rest }) {
  const command = shellJoin(rest).trim();
  if (!command) throw new UsageError('usage: pocp ci-run [--results <file>] -- <command…>');
  const rec = await engine.ciRun(command, { cwd: flags.dir });
  const file = flags.results || path.join(engine.store.runsDir?.() || '.proof/runs', 'ci-results.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(rec)}\n`);
  out(json, { result: rec, file }, `ci-run: ${rec.passed ? 'passed' : 'FAILED'} (exit ${rec.exit}) for ${rec.commit.slice(0, 12)} · recorded in ${file}`);
  return rec.passed ? EXIT.ok : (Number.isInteger(rec.exit) && rec.exit > 0 ? rec.exit : EXIT.blocked);
}
