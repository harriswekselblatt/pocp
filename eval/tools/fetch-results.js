#!/usr/bin/env node
// Fetch the raw run records into eval/results/ and check them against eval/results.sha256.
// They live in their own repository (lib/results-source.js), pinned to one commit, so the
// reports can be regenerated from exactly the files they came from.
//
//   node eval/tools/fetch-results.js           # fetch (if missing) and check
//   node eval/tools/fetch-results.js --check   # only check an existing eval/results/
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { POCP_ROOT } from '../lib/pins.js';
import { checkResults, readManifest, RESULTS_COMMIT, RESULTS_REPO } from '../lib/results-source.js';

const EVAL = path.join(POCP_ROOT, 'eval');
const manifest = readManifest(fs.readFileSync(path.join(EVAL, 'results.sha256'), 'utf8'));
const git = (args, cwd) => {
  const r = spawnSync('git', args, { cwd, stdio: ['ignore', 'inherit', 'inherit'] });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed`);
};

if (!process.argv.includes('--check') && !fs.existsSync(path.join(EVAL, 'results'))) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pocp-eval-'));
  try {
    git(['clone', '--quiet', '--no-checkout', RESULTS_REPO, tmp]);
    git(['-c', 'advice.detachedHead=false', 'checkout', '--quiet', RESULTS_COMMIT], tmp);
    fs.cpSync(path.join(tmp, 'results'), path.join(EVAL, 'results'), { recursive: true });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

const r = checkResults(EVAL, manifest);
for (const [label, files] of [['changed', r.changed], ['missing', r.missing], ['not listed', r.extra]]) {
  for (const f of files) console.error(`${label}: eval/${f}`);
}
if (!r.ok) {
  console.error('eval/results/ does not match eval/results.sha256');
  process.exit(1);
}
console.log(`eval/results/: ${manifest.length} files match eval/results.sha256 (${RESULTS_REPO} at ${RESULTS_COMMIT.slice(0, 12)})`);
