// Turning the pocp status on (POCP_STATUS_LIVE) from `pocp init --github` and
// `pocp ci required --apply`, against a fake gh. The variable must never be on while the verify
// job is still required: a pull request waiting for approval would then pass its required check.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { git, pocp, sampleRepo, write } from './helpers.js';

/**
 * A fake gh: `required` is the branch's required checks (null: not protected; 'plan': a free
 * private repository), `reporter` whether pocp-status.yml is on the branch. Logs every call.
 */
function fakeGh(dir, { required = null, reporter = true, variableExists = false } = {}) {
  const base = path.join(dir, '..', `${path.basename(dir)}-gh`);
  const log = `${base}.log`;
  const protection = required === null || required === 'plan' ? null : JSON.stringify({ required_status_checks: { strict: true, contexts: required, checks: required.map((context) => ({ context })) }, enforce_admins: { enabled: true }, required_pull_request_reviews: { required_approving_review_count: 0 } });
  const get = required === 'plan'
    ? `echo '{"message":"Upgrade to GitHub Pro or make this repository public to enable this feature."}'; echo 'gh: Upgrade to GitHub Pro or make this repository public to enable this feature. (HTTP 403)' >&2; exit 1`
    : protection ? `echo '${protection}'; exit 0` : `echo '{"message":"Branch not protected"}'; echo 'gh: Branch not protected (HTTP 404)' >&2; exit 1`;
  fs.writeFileSync(`${base}.sh`, `#!/bin/sh
echo "ARGS $*" >> ${log}
if [ "$1" = repo ]; then echo owner/name; exit 0; fi
case "$*" in
  *contents/.github/workflows/pocp-status.yml*) ${reporter ? 'echo .github/workflows/pocp-status.yml; exit 0' : 'echo "gh: Not Found (HTTP 404)" >&2; exit 1'} ;;
  *"-X PATCH"*variables/POCP_STATUS_LIVE*) ${variableExists ? 'exit 0' : 'echo "gh: Not Found (HTTP 404)" >&2; exit 1'} ;;
  *"-X POST"*variables*) exit 0 ;;
  *"-X PUT"*protection*) body=$(cat); echo "BODY $body" >> ${log}; echo '{}'; exit 0 ;;
  *protection*) ${get} ;;
esac
echo "unexpected" >&2; exit 1
`);
  fs.chmodSync(`${base}.sh`, 0o755);
  return { bin: `${base}.sh`, log: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '') };
}

const setsVariable = (log) => /ARGS api -X (PATCH|POST) repos\/owner\/name\/actions\/variables/.test(log);
const withPlan = (dir, checks) => write(dir, '.proof/config.json', JSON.stringify({ pocp: 1, ci: { branch: 'main', required_checks: checks } }));

test('ci required --apply swaps verify for pocp, then turns the status on', () => {
  const dir = sampleRepo();
  withPlan(dir, ['pocp', 'test']);
  const gh = fakeGh(dir, { required: ['verify', 'test'] });
  const r = pocp(dir, ['ci', 'required', '--apply', '--json'], { env: { POCP_GH: gh.bin } });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(r.json.result.live, true);
  assert.equal(r.json.result.removed_verify, true);
  const log = gh.log();
  const body = JSON.parse(log.split('BODY ')[1].split('\n')[0]);
  const contexts = (body.required_status_checks.checks || body.required_status_checks.contexts.map((context) => ({ context }))).map((c) => c.context);
  assert.deepEqual(contexts.sort(), ['pocp', 'test']);
  // Protection changes before the variable: in between, waits are red, never mergeable.
  assert.ok(log.indexOf('-X PUT') < log.search(/-X (PATCH|POST) repos\/owner\/name\/actions\/variables/), log);
});

test('the status is never required before its workflow is on the branch, and verify then stays, so the variable stays off', () => {
  const dir = sampleRepo();
  withPlan(dir, ['pocp']);
  const gh = fakeGh(dir, { required: ['verify'], reporter: false });
  const r = pocp(dir, ['ci', 'required', '--apply', '--json'], { env: { POCP_GH: gh.bin } });
  assert.notEqual(r.code, 0);
  assert.equal(r.json.result.live, false);
  assert.doesNotMatch(gh.log(), /-X PUT/, 'nothing to require yet');
  assert.equal(setsVariable(gh.log()), false);
  assert.match(r.stdout, /verify.* is a required check/);
});

test('without its workflow on the branch, other checks are required and the status is turned on (nothing requires verify)', () => {
  const dir = sampleRepo();
  withPlan(dir, ['pocp', 'test']);
  const gh = fakeGh(dir, { reporter: false });
  const r = pocp(dir, ['ci', 'required', '--apply', '--json'], { env: { POCP_GH: gh.bin } });
  assert.equal(r.code, 0, r.stdout);
  assert.doesNotMatch(gh.log().split('BODY ')[1], /"pocp"/);
  assert.equal(r.json.result.merges_blocked, false);
  assert.match(r.stdout, /not on main/);
});

test('a free private repository: the variable is set and the output says merges are not blocked', () => {
  const dir = sampleRepo();
  withPlan(dir, ['pocp']);
  const gh = fakeGh(dir, { required: 'plan' });
  const r = pocp(dir, ['ci', 'required', '--apply', '--json'], { env: { POCP_GH: gh.bin } });
  assert.equal(r.code, 0, r.stdout);
  assert.equal(r.json.result.live, true);
  assert.equal(r.json.result.merges_blocked, false);
  assert.match(r.stdout, /nothing blocks a merge/);
  assert.doesNotMatch(gh.log(), /-X PUT/);
});

test('an existing variable is updated in place', () => {
  const dir = sampleRepo();
  withPlan(dir, ['pocp']);
  const gh = fakeGh(dir, { required: ['pocp'], variableExists: true });
  const r = pocp(dir, ['ci', 'required', '--apply', '--json'], { env: { POCP_GH: gh.bin } });
  assert.equal(r.code, 0, r.stdout);
  assert.doesNotMatch(gh.log(), /-X POST/);
});

test('init --github on a GitHub repository turns the status on and requires pocp in the new config', () => {
  const dir = sampleRepo();
  fs.rmSync(path.join(dir, '.proof'), { recursive: true, force: true });
  git(dir, 'remote', 'add', 'origin', 'https://github.com/owner/name.git');
  const gh = fakeGh(dir, { reporter: false });
  const r = pocp(dir, ['init', '--github', '--json'], { env: { POCP_GH: gh.bin } });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(r.json.live.live, true);
  assert.equal(setsVariable(gh.log()), true);
  assert.doesNotMatch(gh.log(), /-X PUT/, 'init never changes branch protection');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, '.proof/config.json'), 'utf8')).ci.required_checks, ['pocp']);
});

test('init --github leaves GitHub alone with --no-live, without a GitHub remote, and refuses while verify is required', () => {
  const plain = sampleRepo();
  fs.rmSync(path.join(plain, '.proof'), { recursive: true, force: true });
  const gh1 = fakeGh(plain);
  assert.equal(pocp(plain, ['init', '--github'], { env: { POCP_GH: gh1.bin } }).code, 0);
  assert.equal(gh1.log(), '', 'no GitHub remote: gh never called');

  const opted = sampleRepo();
  fs.rmSync(path.join(opted, '.proof'), { recursive: true, force: true });
  git(opted, 'remote', 'add', 'origin', 'git@github.com:owner/name.git');
  const gh2 = fakeGh(opted);
  assert.equal(pocp(opted, ['init', '--github', '--no-live'], { env: { POCP_GH: gh2.bin } }).code, 0);
  assert.equal(gh2.log(), '');

  const verify = sampleRepo();
  fs.rmSync(path.join(verify, '.proof'), { recursive: true, force: true });
  git(verify, 'remote', 'add', 'origin', 'https://github.com/owner/name.git');
  const gh3 = fakeGh(verify, { required: ['verify'] });
  const r = pocp(verify, ['init', '--github'], { env: { POCP_GH: gh3.bin } });
  assert.equal(r.code, 0, 'never fatal for init');
  assert.equal(setsVariable(gh3.log()), false);
  assert.match(r.stdout, /POCP_STATUS_LIVE not set/);
});

test('doctor accepts the pocp status in place of the verify job when the reporter workflow is there', async () => {
  const dir = sampleRepo();
  fs.rmSync(path.join(dir, '.proof'), { recursive: true, force: true });
  assert.equal(pocp(dir, ['init', '--github', '--no-live']).code, 0);
  const checks = pocp(dir, ['doctor', '--offline', '--json']).json.checks;
  const req = checks.find((c) => c.id === 'required-checks');
  assert.equal(req.status, 'ok', JSON.stringify(req));
});
