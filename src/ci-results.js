// CI results written by `pocp ci-run`, as read by `pocp verify`.
//
// A results file is a statement by the CI job that wrote it, so verify only accepts files
// that job could have written: never a file committed in the repository (the change under
// review could plant one), and, inside a CI run, only records from that same run.
//
// That is a filter, not an authentication. The change's own tests run in the same job, as the
// same user, before verify: they can append any record to the file and read the run id. Records
// can't be made unforgeable from inside the job either (a key ci-run held would be readable by
// its child, and verify would need it later in the same job). So --ci-results is the faster,
// trusting mode; the default recipe is `verify --rerun` with no results file.
import fs from 'node:fs';
import path from 'node:path';
import { git } from './git.js';

// Environment variables that identify one CI run (and attempt). ci-run records them.
export const RUN_KEYS = Object.freeze(['GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT', 'CI_PIPELINE_ID', 'BUILDKITE_BUILD_ID']);

export class CiResultsError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CiResultsError';
  }
}

/** The CI run this process is part of: { KEY: value } for each RUN_KEYS variable that is set. */
export function currentRun(env = process.env) {
  const out = {};
  for (const k of RUN_KEYS) if (env[k]) out[k] = env[k];
  return out;
}

/** True when `file` is tracked by git in the repository at `root`. */
export function isTracked(root, file) {
  return git(root, ['ls-files', '--error-unmatch', '--', path.resolve(file)], { allowFail: true }) !== null;
}

/**
 * Read a results file. Refuses a tracked file; inside a CI run keeps only records from
 * that run. Returns { records, ignored } where `ignored` counts records from other runs.
 */
export function readCiResults(file, { root, env = process.env } = {}) {
  if (!fs.existsSync(file)) throw new CiResultsError(`no such CI results file: ${file}`);
  if (root && isTracked(root, file)) {
    throw new CiResultsError(`CI results file ${file} is tracked in the repository; results must be written by this CI job (pocp ci-run), not come from the commit`);
  }
  const all = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap((line) => {
    try {
      const r = JSON.parse(line);
      return r && r.kind === 'ci-result' && typeof r.run === 'string' && typeof r.subject === 'string' ? [r] : [];
    } catch {
      return [];
    }
  });
  const run = currentRun(env);
  const keys = Object.keys(run);
  if (!keys.length) return { records: all, ignored: 0 };
  const records = all.filter((r) => keys.every((k) => r.ci?.[k] === run[k]));
  return { records, ignored: all.length - records.length };
}
