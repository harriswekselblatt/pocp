// pocp hooks: moved from src/cli.js unchanged; main() dispatches here.
import { EXIT } from '../errors.js';
import { UsageError } from '../cli-args.js';
import { hooksHealth, installHooks, uninstallHooks } from '../init.js';
import { out } from '../cli/shared.js';

export async function run({ flags, json, rest }) {
  const sub = rest[0];
  if (sub === 'install') {
    const r = installHooks(process.cwd(), { force: flags.force });
    out(json, r, r.refused ? `hooks not installed: ${r.refused}` : [`hooks installed in ${r.dir}`, ...(r.chained || []).map((n) => `${n}: chained (the existing hook is now ${n}.pre-pocp and runs first)`), ...r.warnings.map((w) => `warning: ${w}`)].join('\n'));
    return r.refused ? EXIT.usage : EXIT.ok;
  }
  if (sub === 'status') {
    const h = hooksHealth(process.cwd());
    out(json, h, [...Object.entries(h.hooks).map(([k, v]) => `${k}: ${v}`), ...h.problems.map((p) => `warning: ${p}`)].join('\n'));
    return h.problems.length ? EXIT.blocked : EXIT.ok;
  }
  if (sub === 'uninstall') {
    const r = uninstallHooks(process.cwd());
    out(json, r, r.removed.length ? `removed pocp from ${r.removed.length} hook(s)` : 'no pocp hooks found');
    return EXIT.ok;
  }
  throw new UsageError('usage: pocp hooks install|uninstall|status');
}
