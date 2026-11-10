// pocp approvals: moved from src/cli.js unchanged; main() dispatches here.
import { EXIT } from '../errors.js';
import { UsageError } from '../cli-args.js';
import { approvePr, formatApprovals, listApprovals } from '../approvals.js';
import { list, out } from '../cli/shared.js';

export async function run({ flags, json, rest }) {
  if (flags.approve !== undefined) {
    if (json) throw new UsageError('--approve is interactive and has no --json form');
    const tty = Boolean(process.stdin.isTTY && process.stdout.isTTY) && !process.env.CI;
    const rl = tty ? (await import('node:readline/promises')).createInterface({ input: process.stdin, output: process.stdout }) : null;
    try {
      const r = await approvePr({
        ref: flags.approve === true ? rest[0] : flags.approve,
        repo: list(flags.repo)[0],
        label: flags.label,
        interactive: tty,
        ask: (q) => rl.question(q),
        say: (line) => process.stdout.write(`${line}\n`),
      });
      return r.approved.length || !r.skipped.length ? EXIT.ok : EXIT.blocked;
    } finally {
      rl?.close();
    }
  }
  const r = listApprovals({ repos: list(flags.repo), owners: list(flags.owner) });
  out(json, r, formatApprovals(r));
  return EXIT.ok;
}
