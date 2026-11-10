// pocp status-report: moved from src/cli.js unchanged; main() dispatches here.
import fs from 'node:fs';
import path from 'node:path';
import { EXIT } from '../errors.js';
import { STATUS_CONTEXT, githubClient, reportStatus } from '../status-report.js';
import { UsageError } from '../cli-args.js';
import { out } from '../cli/shared.js';
import { withDefaults } from '../store.js';

export async function run({ flags, json }) {
  // The trusted reporter (docs/STATUS.md): run from the default branch in a privileged
  // workflow, never on a pull request's code. Reads .proof/config.json here for ci.files.
  const repository = flags.repo || process.env.GITHUB_REPOSITORY;
  const sha = flags.sha || process.env.HEAD_SHA || null;
  const prNumber = Number(flags.pr || process.env.PR_NUMBER) || null;
  if (!repository || (!sha && !prNumber)) throw new UsageError('usage: pocp status-report --repo <owner/name> (--sha <head> | --pr <n>) [--workflow <path>] [--dry-run] [--json]');
  const cfgFile = path.join(process.cwd(), '.proof', 'config.json');
  const baseConfig = fs.existsSync(cfgFile) ? withDefaults(JSON.parse(fs.readFileSync(cfgFile, 'utf8'))) : null;
  const gh = githubClient({ token: process.env.GH_TOKEN || process.env.GITHUB_TOKEN });
  const r = await reportStatus(gh, { repository, sha, prNumber, baseConfig, workflowPath: flags.workflow || undefined, dryRun: Boolean(flags['dry-run']) });
  const d = r.decision;
  out(json, r, d.write ? `${r.written ? 'set' : 'would set'} ${STATUS_CONTEXT} on ${d.sha.slice(0, 12)}: ${d.state} (${d.description}); ${d.reason}` : `nothing written: ${d.reason}`);
  return EXIT.ok;
}
