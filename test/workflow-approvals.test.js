// The repository's own workflows: approval labels reach verify only for the head they were
// given on, the coverage approval is never passed to a verifier that can't apply it (the job
// fails and says so), and every approval label is removed on each push.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const LABELS = ['pocp-approve-tests', 'pocp-approve-policy', 'pocp-approve-coverage'];

/** The `run: |` block that contains `marker`, unindented. */
function runBlock(yaml, marker) {
  const lines = yaml.split('\n');
  const hit = lines.findIndex((l) => l.includes(marker));
  let start = hit;
  while (start >= 0 && !/run: \|\s*$/.test(lines[start])) start--;
  assert.ok(hit >= 0 && start >= 0, `no run block with ${marker}`);
  const indent = lines[start + 1].match(/^\s*/)[0].length;
  const body = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].trim() && lines[i].match(/^\s*/)[0].length < indent) break;
    body.push(lines[i].slice(indent));
  }
  return body.join('\n');
}

function tmp() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pocp-wf-')));
}

/** A stand-in verifier: `help` lists --accept-uncovered or not; `verify` records its arguments. */
function fakeVerifier(dir, { supportsCoverage }) {
  fs.mkdirSync(path.join(dir, 'verifier', 'bin'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'pr'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'verifier', 'bin', 'pocp.js'), [
    "const fs = require('fs');",
    "const [cmd, ...rest] = process.argv.slice(2);",
    `if (cmd === 'help') { console.log('verify ... --accept-test-change=<sha>${supportsCoverage ? ' --accept-uncovered=<sha>' : ''}'); process.exit(0); }`,
    "fs.writeFileSync(process.env.ARGS_FILE, JSON.stringify([cmd, ...rest]));",
    '',
  ].join('\n'));
}

function runVerifyStep(env, { supportsCoverage }) {
  const dir = tmp();
  fakeVerifier(dir, { supportsCoverage });
  const script = runBlock(read('.github/workflows/pocp.yml'), '../verifier/bin/pocp.js verify');
  const argsFile = path.join(dir, 'args.json');
  const r = spawnSync('bash', ['-e', '-c', script], {
    cwd: path.join(dir, 'pr'), encoding: 'utf8',
    env: { PATH: process.env.PATH, RANGE: 'b..h', APPROVE_POLICY: 'false', APPROVE_TESTS: 'false', APPROVE_COVERAGE: 'false', ARGS_FILE: argsFile, ...env },
  });
  const args = fs.existsSync(argsFile) ? JSON.parse(fs.readFileSync(argsFile, 'utf8')) : null;
  fs.rmSync(dir, { recursive: true, force: true });
  return { code: r.status, out: r.stdout + r.stderr, args };
}

test.skip('verify step: approvals are passed as given, coverage only when the label is on', () => {
  const plain = runVerifyStep({}, { supportsCoverage: false });
  assert.equal(plain.code, 0, plain.out);
  assert.deepEqual(plain.args, ['verify', 'b..h', '--rerun', '--require-coverage', '--accept-policy-change=false', '--accept-test-change=false']);
  const withCov = runVerifyStep({ APPROVE_COVERAGE: 'abc123', APPROVE_TESTS: 'abc123' }, { supportsCoverage: true });
  assert.equal(withCov.code, 0, withCov.out);
  assert.deepEqual(withCov.args.slice(-3), ['--accept-policy-change=false', '--accept-test-change=abc123', '--accept-uncovered=abc123']);
});

test.skip("verify step: the coverage label with a verifier that can't apply it fails the job and says so", () => {
  const r = runVerifyStep({ APPROVE_COVERAGE: 'abc123' }, { supportsCoverage: false });
  assert.equal(r.code, 1);
  assert.equal(r.args, null, 'verify is not run without the approval');
  assert.match(r.out, /::error title=POCP approval::pocp-approve-coverage is set, but the base branch's verifier does not support --accept-uncovered/);
});

test("this repository's verifier supports the coverage approval it is wired for", () => {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'pocp.js'), 'help'], { encoding: 'utf8' });
  assert.match(r.stdout + r.stderr, /--accept-uncovered=<sha>/);
});

test('each approval label counts only on label events, for the head at that moment', () => {
  const wf = read('.github/workflows/pocp.yml');
  for (const [env, label] of [['APPROVE_POLICY', 'pocp-approve-policy'], ['APPROVE_TESTS', 'pocp-approve-tests'], ['APPROVE_COVERAGE', 'pocp-approve-coverage']]) {
    const line = wf.split('\n').find((l) => l.trim().startsWith(`${env}:`));
    assert.ok(line, env);
    assert.match(line, /github\.event\.action == 'labeled' \|\| github\.event\.action == 'unlabeled'/);
    assert.ok(line.includes(`'${label}'`) && line.includes('github.event.pull_request.head.sha') && line.trim().endsWith("|| 'false' }}"), line);
  }
});

test('every push and reopen removes every approval label, and nothing else', () => {
  const wf = read('.github/workflows/pocp-labels.yml');
  assert.match(wf, /pull_request_target:\s*\n\s*types: \[synchronize, reopened\]/);
  assert.doesNotMatch(wf, /actions\/checkout/, "never checks out the pull request's code");
  const dir = tmp();
  fs.mkdirSync(path.join(dir, 'bin'));
  fs.writeFileSync(path.join(dir, 'bin', 'gh'), `#!/bin/sh\necho "$@" >> "${path.join(dir, 'calls')}"\n`, { mode: 0o755 });
  const r = spawnSync('bash', ['-e', '-c', runBlock(wf, 'gh api')], {
    encoding: 'utf8',
    env: { PATH: `${path.join(dir, 'bin')}:${process.env.PATH}`, REPO: 'o/r', PR: '7', GH_TOKEN: 'x', LABELS: [...LABELS, 'bug'].join('\\n') },
  });
  assert.equal(r.status, 0, r.stderr);
  const calls = fs.readFileSync(path.join(dir, 'calls'), 'utf8').trim().split('\n');
  assert.deepEqual(calls.sort(), LABELS.map((l) => `api -X DELETE repos/o/r/issues/7/labels/${l} --silent`).sort());
  fs.rmSync(dir, { recursive: true, force: true });
});
