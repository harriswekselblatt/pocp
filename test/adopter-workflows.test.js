// What a project adopting POCP copies (examples/github, action.yml, status/action.yml) gives it
// the same "pocp" status POCP itself runs: the verify job reports through which steps run, a
// trusted reporter sets the status, and every approval label is removed on push.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanWorkflows } from '../src/doctor.js';
import { GITHUB_WORKFLOWS, releaseRef, writeGithubWorkflows } from '../src/init.js';
import { APPROVAL_MARKERS, gather } from '../src/status-report.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pocp-adopt-')));

/** The lines of the step whose `name:` is `name`. */
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
const stepKey = (yaml, name, key) => {
  const l = stepLines(yaml, name).find((x) => x.trim().replace(/^- /, '').startsWith(`${key}:`));
  return l ? l.trim().replace(/^- /, '').slice(key.length + 1).trim() : null;
};
const envLine = (yaml, name) => yaml.split('\n').find((l) => l.trim().startsWith(`${name}:`))?.trim();

test('the example verify job has the step layout the reporter reads, like POCP\'s own', () => {
  const ex = read('examples/github/pocp.yml');
  const own = read('.github/workflows/pocp.yml');
  // The action step is the "verify" step, reports a code, and doesn't fail on a wait.
  const verify = stepLines(ex, 'verify').join('\n');
  assert.match(verify, /uses: harriswekselblatt\/pocp@POCP_REF/);
  assert.match(verify, /id: verify/);
  assert.match(verify, /exit-detail: true/);
  // Same conditions as POCP's own workflow for every result step and approval marker.
  assert.match(verify, /continue-on-error: true/);
  for (const name of ['verified', 'waiting', 'inconclusive', 'failed', ...Object.keys(APPROVAL_MARKERS)]) {
    assert.equal(stepKey(ex, name, 'if'), stepKey(own, name, 'if'), name);
  }
  for (const env of ['APPROVE_POLICY', 'APPROVE_TESTS', 'APPROVE_INCONCLUSIVE', 'APPROVE_COVERAGE', 'WAIT_EXIT']) assert.equal(envLine(ex, env), envLine(own, env), env);
  for (const key of ['if', 'group']) {
    const pick = (y) => y.split('\n').find((l) => l.trim().startsWith(`${key}: `) && /POCP_STATUS_LIVE/.test(l))?.trim();
    assert.ok(pick(ex), key);
    assert.equal(pick(ex), pick(own), key);
  }
  // Every approval reaches verify through the action's inputs.
  for (const [input, env] of [['accept-policy-change', 'APPROVE_POLICY'], ['accept-test-change', 'APPROVE_TESTS'], ['accept-inconclusive', 'APPROVE_INCONCLUSIVE'], ['accept-uncovered', 'APPROVE_COVERAGE']]) {
    assert.match(verify, new RegExp(`${input}: \\$\\{\\{ env\\.${env} \\}\\}`), input);
  }
});

test('the example reporter never checks out or runs pull request code', () => {
  const wf = read('examples/github/pocp-status.yml');
  assert.match(wf, /workflow_run:\s*\n\s*workflows: \[pocp\]\s*\n\s*types: \[completed\]/);
  assert.match(wf, /pull_request_target:/);
  assert.equal(wf.split('\n').filter((l) => l.includes('actions/checkout')).length, 1);
  assert.match(wf, /ref: \$\{\{ github\.event\.repository\.default_branch \}\}/);
  assert.doesNotMatch(wf, /head\.ref|head_branch|download-artifact|head_repository/);
  assert.match(wf, /uses: harriswekselblatt\/pocp\/status@POCP_REF/);
  assert.match(wf, /statuses: write/);
  assert.doesNotMatch(wf, /contents: write|pull-requests: write|issues: write/);
  // The reporter action passes event data only through env.
  const action = read('status/action.yml');
  const run = action.split('\n').find((l) => l.trim().startsWith('run:'));
  assert.doesNotMatch(run, /\$\{\{/);
  assert.match(run, /status-report --workflow "\$WORKFLOW"/);
});

test('the example labels workflow removes every approval label on push', () => {
  const wf = read('examples/github/pocp-labels.yml');
  for (const l of ['pocp-approve-tests', 'pocp-approve-policy', 'pocp-approve-coverage', 'pocp-approve-inconclusive', 'pocp-approve-workflow']) assert.ok(wf.includes(l), l);
  assert.doesNotMatch(wf, /actions\/checkout/);
});

/** Run the action's Verify step with POCP_CMD standing in for pocp; it exits `exit`. */
function runAction({ exit, exitDetail, env = {} }) {
  const dir = tmp();
  const argsFile = path.join(dir, 'args.json');
  const fake = path.join(dir, 'fake-pocp.sh');
  fs.writeFileSync(fake, `#!/bin/sh\nnode -e 'require("fs").writeFileSync(process.argv[1], JSON.stringify(process.argv.slice(2)))' "${argsFile}" "$@"\nexit ${exit}\n`, { mode: 0o755 });
  const out = path.join(dir, 'gh-output');
  fs.writeFileSync(out, '');
  const action = read('action.yml');
  const lines = action.split('\n');
  const start = lines.findIndex((l) => /run: \|\s*$/.test(l));
  const indent = lines[start + 1].match(/^\s*/)[0].length;
  const body = [];
  for (let i = start + 1; i < lines.length && (!lines[i].trim() || lines[i].match(/^\s*/)[0].length >= indent); i++) body.push(lines[i].slice(indent));
  const r = spawnSync('bash', ['-e', '-c', body.join('\n')], {
    encoding: 'utf8', cwd: dir,
    env: { PATH: process.env.PATH, RANGE_INPUT: '', PR_BASE: 'b', PR_HEAD: 'h', EVENT_NAME: 'pull_request', RERUN: 'all', CI_RESULTS: '', ACCEPT_POLICY: 'false', ACCEPT_TESTS: 'false', ACCEPT_INCONCLUSIVE: 'false', ACCEPT_UNCOVERED: 'false', EXIT_DETAIL: exitDetail ? 'true' : 'false', COVERAGE: 'true', POCP_CMD: fake, GITHUB_OUTPUT: out, ...env },
  });
  const res = { code: r.status, output: fs.readFileSync(out, 'utf8'), args: fs.existsSync(argsFile) ? JSON.parse(fs.readFileSync(argsFile, 'utf8')) : null, err: r.stderr, out: r.stdout };
  fs.rmSync(dir, { recursive: true, force: true });
  return res;
}

test('action.yml: with exit-detail it records verify\'s code and exits with it; without, it behaves as before', () => {
  for (const exit of [0, 1, 4, 5]) {
    const r = runAction({ exit, exitDetail: true });
    assert.equal(r.code, exit, r.err);
    assert.equal(r.output, `code=${exit}\n`);
    assert.ok(r.args.includes('--exit-detail'));
    assert.deepEqual(r.args.slice(0, 2), ['verify', 'b..h']);
  }
  const old = runAction({ exit: 1, exitDetail: false });
  assert.equal(old.code, 1, 'without exit-detail the step still fails');
  assert.equal(old.output, '');
  assert.ok(!old.args.includes('--exit-detail'));
  const approved = runAction({ exit: 0, exitDetail: true, env: { ACCEPT_INCONCLUSIVE: 'abc123', ACCEPT_UNCOVERED: 'abc123' } });
  assert.ok(approved.args.includes('--accept-inconclusive=abc123') && approved.args.includes('--accept-uncovered=abc123'));
});

test('action.yml: an explicit range wins; with no pull request and no range it fails clearly instead of verifying ".."', () => {
  const pushed = runAction({ exit: 0, exitDetail: false, env: { RANGE_INPUT: 'aaa..bbb', PR_BASE: '', PR_HEAD: '', EVENT_NAME: 'push' } });
  assert.equal(pushed.code, 0, pushed.err);
  assert.deepEqual(pushed.args.slice(0, 2), ['verify', 'aaa..bbb']);
  const none = runAction({ exit: 0, exitDetail: false, env: { PR_BASE: '', PR_HEAD: '', EVENT_NAME: 'push' } });
  assert.equal(none.code, 2);
  assert.equal(none.args, null, 'verify never ran');
  assert.match(none.out, /::error title=POCP verify::no commit range: this push event isn't a pull request/);
});

test('action.yml: pocp-command is split into words without glob or variable expansion', () => {
  const dir = tmp();
  const argsFile = path.join(dir, 'args.json');
  const fake = path.join(dir, 'fake.sh');
  fs.writeFileSync(fake, `#!/bin/sh\nnode -e 'require("fs").writeFileSync(process.argv[1], JSON.stringify(process.argv.slice(2)))' "${argsFile}" "$@"\n`, { mode: 0o755 });
  const r = runAction({ exit: 0, exitDetail: false, env: { POCP_CMD: `${fake} *.sh $HOME`  /* the action's working folder holds a .sh file */ } });
  assert.equal(r.code, 0, r.err);
  assert.equal(r.args, null, 'runAction\'s own stand-in did not run');
  const args = JSON.parse(fs.readFileSync(argsFile, 'utf8'));
  assert.deepEqual(args.slice(0, 3), ['*.sh', '$HOME', 'verify']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('pocp init --github writes the three workflows, pinned, and keeps existing ones', () => {
  const dir = tmp();
  const r = writeGithubWorkflows(dir);
  assert.deepEqual(r.written.map((f) => path.basename(f)), GITHUB_WORKFLOWS);
  assert.equal(r.ref, releaseRef());
  const wf = fs.readFileSync(path.join(dir, '.github/workflows/pocp.yml'), 'utf8');
  assert.match(wf, new RegExp(`uses: harriswekselblatt/pocp@${releaseRef().replace(/\./g, '\\.')}`));
  assert.doesNotMatch(wf + fs.readFileSync(path.join(dir, '.github/workflows/pocp-status.yml'), 'utf8'), /POCP_REF/);
  fs.writeFileSync(path.join(dir, '.github/workflows/pocp.yml'), 'mine\n');
  const again = writeGithubWorkflows(dir, { ref: 'abc1234' });
  assert.deepEqual(again.skipped.map((f) => path.basename(f)), GITHUB_WORKFLOWS);
  assert.equal(fs.readFileSync(path.join(dir, '.github/workflows/pocp.yml'), 'utf8'), 'mine\n');
  writeGithubWorkflows(dir, { ref: 'abc1234', force: true });
  assert.match(fs.readFileSync(path.join(dir, '.github/workflows/pocp-status.yml'), 'utf8'), /pocp\/status@abc1234/);
  assert.throws(() => writeGithubWorkflows(dir, { ref: 'x; rm -rf /', force: true }), /not a usable ref/);
});

test('doctor finds the verify workflow by its code, and sees the reporter', () => {
  const dir = tmp();
  writeGithubWorkflows(dir, { ref: 'v9.9.9' });
  const wfs = scanWorkflows(dir);
  const byFile = Object.fromEntries(wfs.map((w) => [path.basename(w.file), w]));
  assert.equal(byFile['pocp.yml'].runs_verify, true);
  assert.equal(byFile['pocp-status.yml'].runs_verify, false, 'a comment mentioning verify is not a verify job');
  assert.equal(byFile['pocp-status.yml'].reporter, true);
  assert.equal(byFile['pocp.yml'].exit_detail, true);
  assert.ok(byFile['pocp.yml'].mentions.includes('pocp-approve-inconclusive'));
});

test('status-report --workflow: a missing or different workflow path is an error, not a silent fallback', async () => {
  const gh = {
    get: async (url) => (url.includes('/actions/workflows/') ? { id: 1, path: '.github/workflows/pocp.yml' } : { number: 7, state: 'open', head: { sha: 'a'.repeat(40) }, labels: [], user: { login: 'x' } }),
    all: async () => [],
  };
  await assert.rejects(gather(gh, { repository: 'o/r', sha: 'a'.repeat(40), prNumber: 7, baseConfig: null, workflowPath: 'ci/pocp.yml' }), /was not found/);
  const ok = await gather(gh, { repository: 'o/r', sha: 'a'.repeat(40), prNumber: 7, baseConfig: null });
  assert.equal(ok.workflow.path, '.github/workflows/pocp.yml');
});
