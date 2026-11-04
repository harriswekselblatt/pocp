// A check is the pull request's code. In GitHub Actions it must not get the step files or
// runner tokens, or it could set the verify step's outputs and fake what the job reports.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildEnv, CI_STEP_VARS } from '../src/runner.js';
import { git, pocp, sampleRepo, write } from './helpers.js';

const CI_VARS = { GITHUB_OUTPUT: '/tmp/out', GITHUB_ENV: '/tmp/env', GITHUB_PATH: '/tmp/path', GITHUB_STATE: '/tmp/state', GITHUB_STEP_SUMMARY: '/tmp/summary', ACTIONS_RUNTIME_TOKEN: 'secret', ACTIONS_ID_TOKEN_REQUEST_URL: 'https://x', GITHUB_SHA: 'abc' };

function withEnv(vars, fn) {
  const before = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(before)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test('checks get no GitHub step files or ACTIONS_ tokens, not even when allowed by name', () => {
  withEnv(CI_VARS, () => {
    for (const env of [buildEnv({}), buildEnv({ mode: 'minimal', allow: Object.keys(CI_VARS) })]) {
      for (const k of [...CI_STEP_VARS, 'ACTIONS_RUNTIME_TOKEN', 'ACTIONS_ID_TOKEN_REQUEST_URL']) assert.equal(env[k], undefined, k);
    }
    // Plain context, such as the commit, is still there.
    assert.equal(buildEnv({}).GITHUB_SHA, 'abc');
    // ci-run wraps the repository's own test step, which may write its summary.
    assert.equal(buildEnv({ keepCiFiles: true }).GITHUB_STEP_SUMMARY, '/tmp/summary');
  });
});

test("a re-run check in verify can't write the verify step's GITHUB_OUTPUT", () => {
  const dir = sampleRepo({ deep: false, hooks: true });
  const base = git(dir, 'rev-parse', 'HEAD');
  // The check tries to append code=0 to the step output, as a pull request's test could.
  write(dir, 'test/math.check.mjs', `import fs from 'node:fs';\nif (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, 'code=0\\n');\n${fs.readFileSync(path.join(dir, 'test/math.check.mjs'), 'utf8')}`);
  write(dir, 'src/math.js', `${fs.readFileSync(path.join(dir, 'src/math.js'), 'utf8')}\n`);
  git(dir, 'add', '-A');
  // A proof record, so verify has a check to re-run (as in real use).
  const fix = pocp(dir, ['fix', '--intent', 'change']);
  assert.equal(fix.code, 0, fix.stdout + fix.stderr);
  const c = spawnSync('git', ['commit', '-q', '-m', 'change'], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  assert.equal(c.status, 0, c.stderr);
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pocp-ghout-')), 'output');
  fs.writeFileSync(out, '');
  const r = pocp(dir, ['verify', `${base}..HEAD`, '--rerun', '--accept-test-change'], { env: { GITHUB_ACTIONS: 'true', GITHUB_OUTPUT: out } });
  assert.match(r.stdout, /rerun passed +node test\/math\.check\.mjs/, r.stdout + r.stderr);
  assert.equal(fs.readFileSync(out, 'utf8'), '', 'nothing the check ran wrote to the step output');
});
