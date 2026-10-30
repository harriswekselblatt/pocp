// CI results are statements by the CI job that wrote them: verify accepts only results that
// job could have written, and the latest result for a command decides.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { git, packetId, pocp, sampleRepo, write, writeConfig } from './helpers.js';
import { TWEAK_ADD, commit } from './fixtures.js';
import { readCiResults, currentRun } from '../src/ci-results.js';

const CHECK = 'node test/math.check.mjs';

// A proven change on top of a config that requires CI to run the math check.
function provenChange() {
  const dir = sampleRepo({ hooks: true });
  writeConfig(dir, { verify: { require_ci: [CHECK] } });
  git(dir, 'add', '-A');
  git(dir, '-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', 'require ci');
  const base = git(dir, 'rev-parse', 'HEAD');
  write(dir, 'src/math.js', TWEAK_ADD);
  git(dir, 'add', '-A');
  const id = packetId(pocp(dir, ['open', '--intent', 'tweak', '--touch', 'src/math.js']).stdout);
  assert.equal(pocp(dir, ['prove', id]).code, 0);
  assert.equal(commit(dir, 'tweak').status, 0);
  return { dir, base };
}

test('a results file committed in the repository is refused', () => {
  const { dir, base } = provenChange();
  const results = path.join(dir, '.proof', 'runs', 'ci-results.jsonl');
  assert.equal(pocp(dir, ['ci-run', '--', CHECK]).code, 0);
  // Plant it in the commit (it sits under .proof/, which the subject hash ignores).
  git(dir, 'add', '-f', results);
  git(dir, 'commit', '-q', '--no-verify', '-m', 'plant results');
  const v = pocp(dir, ['verify', `${base}..HEAD`, '--ci-results', results]);
  assert.equal(v.code, 2);
  assert.match(v.stderr, /tracked in the repository/);
});

test('the latest result for a command decides', () => {
  const { dir, base } = provenChange();
  const results = path.join(dir, '..', `${path.basename(dir)}-ci.jsonl`);
  assert.equal(pocp(dir, ['ci-run', '--results', results, '--', CHECK]).code, 0);
  // The same command fails later in the job (a retry, or a second step).
  const [first] = fs.readFileSync(results, 'utf8').trim().split('\n');
  fs.appendFileSync(results, `${JSON.stringify({ ...JSON.parse(first), passed: false, exit: 1 })}\n`);
  const v = pocp(dir, ['verify', `${base}..HEAD`, '--ci-results', results, '--json']);
  assert.equal(v.code, 1);
  assert.match(JSON.stringify(v.json.commits.at(-1).findings), /ci_failed/);
});

test('inside a CI run, results from another run are ignored', () => {
  const { dir, base } = provenChange();
  const results = path.join(dir, '..', `${path.basename(dir)}-ci.jsonl`);
  assert.equal(pocp(dir, ['ci-run', '--results', results, '--', CHECK], { env: { GITHUB_RUN_ID: '100', GITHUB_RUN_ATTEMPT: '1' } }).code, 0);
  const same = pocp(dir, ['verify', `${base}..HEAD`, '--ci-results', results], { env: { GITHUB_RUN_ID: '100', GITHUB_RUN_ATTEMPT: '1' } });
  assert.equal(same.code, 0, same.stdout + same.stderr);
  const other = pocp(dir, ['verify', `${base}..HEAD`, '--ci-results', results, '--json'], { env: { GITHUB_RUN_ID: '101', GITHUB_RUN_ATTEMPT: '1' } });
  assert.equal(other.code, 1);
  assert.match(other.stderr, /ignored 1 CI result\(s\) recorded by a different CI run/);
  assert.match(JSON.stringify(other.json.commits.at(-1).findings), /ci_missing/);
});

test('a passing re-run by verify satisfies require_ci, so verify can run with no CI results', () => {
  const { dir, base } = provenChange();
  const range = pocp(dir, ['verify', `${base}..HEAD`, '--rerun', '--json']);
  assert.equal(range.code, 0, JSON.stringify(range.json?.commits?.at(-1)?.findings));
  assert.match(range.json.commits.at(-1).notes.join(' '), /passed when re-run by this verify/);
  const single = pocp(dir, ['verify', 'HEAD', '--rerun', '--json']);
  assert.equal(single.code, 0);
  // Without a re-run and without results it still fails closed.
  assert.equal(pocp(dir, ['verify', `${base}..HEAD`]).code, 1);
});

test('readCiResults: run identity and malformed lines', () => {
  const dir = sampleRepo();
  const f = path.join(dir, '..', `${path.basename(dir)}-r.jsonl`);
  fs.writeFileSync(f, [
    JSON.stringify({ kind: 'ci-result', run: 'a', subject: 's', ci: { CI_PIPELINE_ID: '7' } }),
    'not json',
    JSON.stringify({ kind: 'other', run: 'a', subject: 's' }),
    JSON.stringify({ kind: 'ci-result', run: 'b', subject: 's' }),
  ].join('\n'));
  assert.deepEqual(currentRun({ CI_PIPELINE_ID: '7', OTHER: 'x' }), { CI_PIPELINE_ID: '7' });
  assert.equal(readCiResults(f, { root: dir, env: {} }).records.length, 2, 'outside CI every well-formed record counts');
  const inCi = readCiResults(f, { root: dir, env: { CI_PIPELINE_ID: '7' } });
  assert.deepEqual(inCi.records.map((r) => r.run), ['a']);
  assert.equal(inCi.ignored, 1);
  assert.throws(() => readCiResults(path.join(dir, 'missing.jsonl')), /no such CI results file/);
});
