// TEMPORARY diagnostic (removed before merge): run this repo's test suite the way
// `pocp verify --isolate` runs a check, and print what failed.
//
// It uses the real isolated runner (src/isolate.js): the preflight probe, a fresh worker user,
// setpriv --no-new-privs, RLIMIT_NPROC, workerEnv's allowlisted environment and the worker's own
// HOME/TMPDIR, in a private copy of a no-.git export of HEAD (as verify's per-check checkout).
//
// usage: node .github/diag-isolated-suite.mjs [parallel runs, default 1] [command]
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createIsolatedRunner } from '../src/isolate.js';
import { buildEnv } from '../src/runner.js';

const parallel = Number(process.argv[2] || 1);
const command = process.argv[3] || 'npm test --silent';
const root = process.cwd();

const snap = fs.mkdtempSync(path.join(os.tmpdir(), 'diag-snap-'));
execFileSync('/bin/sh', ['-c', `git archive HEAD | tar -x -C "${snap}"`], { cwd: root, stdio: 'inherit' });

const runner = createIsolatedRunner();
await runner.prepare({ root });
console.log('prepared: probe passed');

const env = buildEnv({ mode: 'inherit', extra: { POCP: '1', POCP_OBLIGATION: 'diag' } });
const about = await runner.run('id; ulimit -a; echo; env | sort; echo; ls -ld "$HOME" "$TMPDIR" /tmp .; git config --global --list 2>&1 | head -5; node --version; npm --version', { root: snap, cwd: snap, env, timeoutMs: 60_000 });
console.log(`::group::worker environment\n${about.output}\n::endgroup::`);

const started = Date.now();
const results = await Promise.all(Array.from({ length: parallel }, () => runner.run(command, { root: snap, cwd: snap, env, timeoutMs: 600_000, killGraceMs: 5_000 })));
let failed = 0;
results.forEach((r, i) => {
  const ok = r.exit === 0 && !r.timed_out && !r.error;
  if (!ok) failed++;
  console.log(`\n=== run ${i + 1}/${parallel}: ${ok ? 'PASSED' : 'FAILED'} exit=${r.exit} signal=${r.signal} timed_out=${r.timed_out} error=${r.error || ''} ${r.duration_ms}ms (${Date.now() - started}ms wall)`);
  const lines = (r.output || '').split('\n');
  // Each failing test with the lines after it (TAP "not ok" or the spec reporter's ✖).
  const shown = new Set();
  lines.forEach((l, n) => {
    if (/^\s*not ok\b|✖/.test(l)) for (let k = n; k < Math.min(lines.length, n + 40); k++) shown.add(k);
  });
  if (shown.size) {
    console.log(`::group::run ${i + 1}: failing tests`);
    let last = -2;
    for (const k of [...shown].sort((a, b) => a - b)) {
      if (k !== last + 1) console.log('---');
      console.log(lines[k]);
      last = k;
    }
    console.log('::endgroup::');
  }
  console.log(`::group::run ${i + 1}: last 150 lines`);
  console.log(lines.slice(-150).join('\n'));
  console.log('::endgroup::');
});
spawnSync('rm', ['-rf', snap]);
process.exit(failed ? 1 : 0);
