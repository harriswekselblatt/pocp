// The workflows behind the "pocp" status: the verify job reports what verify found through
// which steps run, the reporter never touches a pull request's code, and every approval
// label (the new ones included) is removed on push.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { APPROVAL_MARKERS } from '../src/status-report.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/** The lines of the step whose `name:` is `name` (a step starts at a `- ` line). */
function stepLines(yaml, name) {
  const lines = yaml.split('\n');
  const at = lines.findIndex((l) => l.trim() === `- name: ${name}` || l.trim() === `name: ${name}`);
  assert.ok(at >= 0, `no step ${name}`);
  let start = at;
  while (!/^\s*- /.test(lines[start])) start--;
  const ind = lines[start].match(/^\s*/)[0].length;
  let end = start + 1;
  while (end < lines.length && (!lines[end].trim() || lines[end].match(/^\s*/)[0].length > ind)) end++;
  return lines.slice(start, end);
}

/** The `run: |` block of the step named `name`, unindented. */
function stepRun(yaml, name) {
  const lines = stepLines(yaml, name);
  const at = lines.findIndex((l) => /run: \|\s*$/.test(l));
  assert.ok(at >= 0, `no run block in step ${name}`);
  const indent = lines[at + 1].match(/^\s*/)[0].length;
  const body = [];
  for (let i = at + 1; i < lines.length; i++) {
    if (lines[i].trim() && lines[i].match(/^\s*/)[0].length < indent) break;
    body.push(lines[i].slice(indent));
  }
  return body.join('\n');
}

/** A step's `if:` expression, or a one-line `run:`. */
function stepKey(yaml, name, key) {
  const line = stepLines(yaml, name).find((l) => l.trim().replace(/^- /, '').startsWith(`${key}:`));
  return line ? line.trim().replace(/^- /, '').slice(key.length + 1).trim() : null;
}
const stepIf = (yaml, name) => stepKey(yaml, name, 'if');

/** Run the verify step with a stand-in verifier that exits `exit` and lists `helpFlags`. */
function runVerify({ exit = 0, helpFlags = ['--exit-detail', '--accept-inconclusive', '--accept-uncovered'], env = {} } = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pocp-wfs-')));
  fs.mkdirSync(path.join(dir, 'verifier', 'bin'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'pr'));
  fs.writeFileSync(path.join(dir, 'verifier', 'bin', 'pocp.js'), [
    "const fs = require('fs');",
    "const [cmd, ...rest] = process.argv.slice(2);",
    `if (cmd === 'help') { console.log(${JSON.stringify(`verify ${helpFlags.join(' ')}`)}); process.exit(0); }`,
    "fs.writeFileSync(process.env.ARGS_FILE, JSON.stringify([cmd, ...rest]));",
    `process.exit(${exit});`,
  ].join('\n'));
  const out = path.join(dir, 'gh-output');
  fs.writeFileSync(out, '');
  const argsFile = path.join(dir, 'args.json');
  const r = spawnSync('bash', ['-e', '-c', stepRun(read('.github/workflows/pocp.yml'), 'verify')], {
    cwd: path.join(dir, 'pr'), encoding: 'utf8',
    env: { PATH: process.env.PATH, RANGE: 'b..h', APPROVE_POLICY: 'false', APPROVE_TESTS: 'false', APPROVE_COVERAGE: 'false', APPROVE_INCONCLUSIVE: 'false', ARGS_FILE: argsFile, GITHUB_OUTPUT: out, ...env },
  });
  const res = { code: r.status, out: r.stdout + r.stderr, output: fs.readFileSync(out, 'utf8'), args: fs.existsSync(argsFile) ? JSON.parse(fs.readFileSync(argsFile, 'utf8')) : null };
  fs.rmSync(dir, { recursive: true, force: true });
  return res;
}

test('the verify step records verify\'s exit code and itself always passes', () => {
  for (const exit of [0, 1, 2, 3, 4, 5]) {
    const r = runVerify({ exit });
    assert.equal(r.code, 0, r.out);
    assert.equal(r.output, `code=${exit}\n`);
    assert.ok(r.args.includes('--exit-detail'));
  }
});

test('the verify step passes --exit-detail and --accept-inconclusive only to a verifier that has them', () => {
  const old = runVerify({ helpFlags: [] });
  assert.equal(old.code, 0, old.out);
  assert.ok(!old.args.includes('--exit-detail'));
  const withApproval = runVerify({ env: { APPROVE_INCONCLUSIVE: 'abc123' } });
  assert.ok(withApproval.args.includes('--accept-inconclusive=abc123'));
  const unsupported = runVerify({ helpFlags: ['--exit-detail'], env: { APPROVE_INCONCLUSIVE: 'abc123' } });
  assert.equal(unsupported.code, 1, 'an approval is never dropped silently');
  assert.equal(unsupported.args, null);
  assert.match(unsupported.out, /pocp-approve-inconclusive is set, but the base branch's verifier does not support --accept-inconclusive/);
});

test('exactly one of waiting / inconclusive / failed runs for each code, and a missing code is a failure', () => {
  const wf = read('.github/workflows/pocp.yml');
  // Evaluate each step's `if` the way Actions would for steps.verify.outputs.code.
  const runs = (code) => ['waiting', 'inconclusive', 'failed'].filter((name) => {
    const expr = stepIf(wf, name).replace(/steps\.verify\.outputs\.code/g, JSON.stringify(code)).replace(/==/g, '===').replace(/!=/g, '!==');
    return Function(`return (${expr});`)();
  });
  assert.deepEqual(runs('0'), []);
  assert.deepEqual(runs('4'), ['waiting']);
  assert.deepEqual(runs('5'), ['inconclusive']);
  for (const code of ['1', '2', '3', '', '137']) assert.deepEqual(runs(code), ['failed'], `code ${JSON.stringify(code)}`);
  assert.equal(stepKey(wf, 'failed', 'run'), 'exit 1');
  // Waiting and inconclusive fail the job until POCP_STATUS_LIVE is on (verify is still required).
  assert.match(wf, /WAIT_EXIT: \$\{\{ \(vars\.POCP_STATUS_LIVE == 'true' \|\| github\.base_ref == 'gate-test'\) && '0' \|\| '1' \}\}/);
  for (const name of ['waiting', 'inconclusive']) assert.match(stepRun(wf, name), /exit "\$WAIT_EXIT"/);
});

test('each approval marker step runs exactly when that approval reaches verify', () => {
  const wf = read('.github/workflows/pocp.yml');
  const envFor = { 'approval-tests': 'APPROVE_TESTS', 'approval-policy': 'APPROVE_POLICY', 'approval-inconclusive': 'APPROVE_INCONCLUSIVE', 'approval-coverage': 'APPROVE_COVERAGE' };
  assert.deepEqual(Object.keys(envFor).sort(), Object.keys(APPROVAL_MARKERS).sort());
  for (const [step, env] of Object.entries(envFor)) {
    assert.equal(stepIf(wf, step), `env.${env} != 'false'`, step);
    const label = APPROVAL_MARKERS[step];
    const line = wf.split('\n').find((l) => l.trim().startsWith(`${env}:`));
    assert.ok(line.includes(`'${label}'`) && line.includes("github.event.action == 'labeled'"), line);
  }
});

test('label events are filtered only once the pocp status is live (a skipped required check counts as passing)', () => {
  const wf = read('.github/workflows/pocp.yml');
  const jobIf = wf.split('\n').find((l) => l.trim().startsWith('if: (vars.POCP_STATUS_LIVE'));
  assert.ok(jobIf, 'the job-level filter depends on POCP_STATUS_LIVE');
  assert.match(jobIf, /\(vars\.POCP_STATUS_LIVE != 'true' && github\.base_ref != 'gate-test'\) \|\|/);
  assert.match(jobIf, /startsWith\(github\.event\.label\.name, 'pocp-approve-'\)/);
  assert.match(wf, /format\('pocp-ignored-\{0\}', github\.run_id\)/);
  assert.match(wf, /cancel-in-progress: true/);
});

test('the reporter never checks out or runs pull request code', () => {
  const wf = read('.github/workflows/pocp-status.yml');
  assert.match(wf, /workflow_run:\s*\n\s*workflows: \[pocp\]\s*\n\s*types: \[completed\]/);
  assert.match(wf, /pull_request_target:/);
  const checkouts = wf.split('\n').filter((l) => l.includes('actions/checkout'));
  assert.equal(checkouts.length, 1);
  assert.match(wf, /ref: \$\{\{ github\.event\.repository\.default_branch \}\}/);
  assert.doesNotMatch(wf, /head\.ref|head_branch|pull_request\.head\.sha \}\}\s*\n\s*path|download-artifact|github\.event\.workflow_run\.head_repository/);
  assert.match(wf, /run: node bin\/pocp\.js status-report/);
  // Event data reaches the script only through env, never interpolated into the command.
  assert.doesNotMatch(stepRunLine(wf), /\$\{\{/);
  assert.match(wf, /statuses: write/);
  assert.doesNotMatch(wf, /contents: write|pull-requests: write|issues: write/);
});

function stepRunLine(wf) {
  return wf.split('\n').find((l) => l.trim().startsWith('run: node bin/pocp.js status-report'));
}

test('every push removes the new approval labels too', () => {
  const wf = read('.github/workflows/pocp-labels.yml');
  for (const label of ['pocp-approve-tests', 'pocp-approve-policy', 'pocp-approve-coverage', 'pocp-approve-inconclusive', 'pocp-approve-workflow']) assert.ok(wf.includes(label), label);
});
