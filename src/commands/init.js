// pocp init: moved from src/cli.js unchanged; main() dispatches here.
import fs from 'node:fs';
import path from 'node:path';
import { EXIT } from '../errors.js';
import { LIVE_VARIABLE, STATUS_CHECK, createApprovalLabels, goLive, requiredChecksPlan } from '../ci-github.js';
import { APPROVAL_LABELS } from '../doctor.js';
import { formatLayout, hooksHealth, initProofDir, installHooks, writeGithubWorkflows } from '../init.js';
import { git } from '../git.js';
import { out } from '../cli/shared.js';

export async function run({ flags, json }) {
  const r = initProofDir(process.cwd(), { deep: Boolean(flags.deep), github: Boolean(flags.github) });
  let hooks = null;
  if (flags.hooks) hooks = installHooks(process.cwd(), { force: flags.force });
  const github = flags.github ? writeGithubWorkflows(process.cwd(), { ref: flags['pocp-ref'] || undefined, force: flags.force }) : null;
  // Turn the pocp status on now, so the first pull request that waits for an approval is
  // yellow, not a red failure. Only for a repository on GitHub, through the user's gh login;
  // anything that doesn't work is a next step, never an error.
  let live = null;
  let labels = null;
  const onGithub = Boolean(github) && /github\.com[:/]/.test(git(process.cwd(), ['remote', 'get-url', 'origin'], { allowFail: true }) || '');
  // The labels a maintainer approves changes with: without them there is nothing to approve with.
  if (onGithub) labels = createApprovalLabels(APPROVAL_LABELS);
  if (onGithub && !flags['no-live']) {
    live = goLive(process.cwd(), requiredChecksPlan(process.cwd(), JSON.parse(fs.readFileSync(path.join(process.cwd(), '.proof', 'config.json'), 'utf8'))), { protect: false });
  }
  out(json, { created: r.created, hooks, test_layout: r.layout, ...(github ? { github } : {}), ...(labels ? { labels } : {}), ...(live ? { live } : {}) }, [
    r.created.length ? `created ${r.created.join(', ')}` : '.proof/ already set up',
    ...(r.config_created ? [flags.deep
      ? 'test guard: deep (guard.mutants 10): test edits are also checked with 10 planted bugs; slower'
      : 'test guard: fast (guard.mutants 0): a test edit that only adds whole new tests passes (guard.additions "accept"); every other test edit goes to a person. "pocp init --deep" or guard.mutants 10 adds planted bugs, which can pass other test edits without one'] : []),
    // The layout on a first init, or when it needs something done; quiet otherwise.
    ...(r.config_created || r.layout.extra.length || r.layout.uncovered.length ? formatLayout(r.layout, { written: r.layout_written }) : []),
    hooks?.refused ? `hooks not installed: ${hooks.refused}` : hooks ? `hooks installed in ${hooks.dir}` : Object.values(hooksHealth(process.cwd()).hooks).some((v) => v === 'ok') ? 'hooks: already installed' : 'hooks not installed (run "pocp hooks install")',
    ...(hooks?.chained || []).map((n) => `${n}: chained (the existing hook is now ${n}.pre-pocp and runs first)`),
    ...(hooks?.warnings || []).map((w) => `warning: ${w}`),
    ...(github ? [
      github.written.length ? `wrote ${github.written.join(', ')} (POCP actions pinned to ${github.ref})` : 'GitHub workflows already present',
      ...github.skipped.map((f) => `kept ${f} (exists; --force replaces it)`),
      ...(labels?.ok ? [labels.created.length ? `created the approval labels on ${labels.repo}: ${labels.created.join(', ')}` : `approval labels already on ${labels.repo}`]
        : labels ? [`approval labels not created: ${labels.error} (pocp doctor prints the commands)`] : []),
      ...(live?.ok ? [`${LIVE_VARIABLE} set on ${live.repo}: a pull request waiting for approval shows a yellow "${STATUS_CHECK}" status, not a red failure`, ...live.notes.map((n) => `  ${n}`)]
        : live ? [`${LIVE_VARIABLE} not set: ${live.error}`] : []),
      `next: commit them in a pull request${labels?.ok ? '' : ', create the labels (pocp doctor lists them)'}, and once it merges run "pocp ci required --apply" to require the "${STATUS_CHECK}" status${live?.ok ? '' : ' and turn it on'}`,
    ] : []),
  ].join('\n'));
  return hooks?.refused ? EXIT.usage : EXIT.ok;
}
