// `pocp ci required`: the branch protection plan and --apply, against a fake gh (split out of
// e2e-cli.test.js so the two files run side by side).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { git, packetId, pocp, sampleRepo, sh, write } from './helpers.js';
import { TWEAK_ADD } from './fixtures.js';

function fakeGh(dir, { existing, getStatus = 0, getStdout, rejectChecksOnly = false } = {}) {
  const base = path.join(dir, '..', `${path.basename(dir)}-gh`);
  const log = `${base}.log`;
  const fixture = `${base}.json`;
  if (existing) fs.writeFileSync(fixture, JSON.stringify(existing));
  const get = existing
    ? `cat ${fixture}; exit 0`
    : `echo '${getStdout || '{"message":"Branch not protected"}'}'; ${getStatus === 404 || !getStatus ? 'echo "gh: Branch not protected (HTTP 404)" >&2; exit 1' : `echo "gh: HTTP ${getStatus}" >&2; exit 1`}`;
  fs.writeFileSync(`${base}.sh`, `#!/bin/sh
echo "ARGS $*" >> ${log}
if [ "$1" = repo ]; then echo owner/name; exit 0; fi
if [ "$1" = api ] && [ "$2" = "-X" ]; then
  body=$(cat); echo "$body" >> ${log}
  ${rejectChecksOnly ? `case "$body" in *'"contexts"'*) ;; *) echo 'gh: Invalid request. No subschema in "anyOf" matched. (HTTP 422)' >&2; exit 1 ;; esac` : ':'}
  echo; exit 0
fi
if [ "$1" = api ]; then ${get}; fi
`);
  fs.chmodSync(`${base}.sh`, 0o755);
  return { bin: `${base}.sh`, log };
}

test('ci required: the plan comes from config', () => {
  const dir = sampleRepo();
  write(dir, '.proof/config.json', JSON.stringify({ pocp: 1, ci: { branch: 'main', required_checks: ['verify', 'test (ubuntu-latest, 22)'] } }));
  const plan = pocp(dir, ['ci', 'required', '--json']).json.plan;
  assert.deepEqual(plan.required_checks, ['verify', 'test (ubuntu-latest, 22)']);
  assert.deepEqual(plan.github.required_status_checks.checks, [{ context: 'verify' }, { context: 'test (ubuntu-latest, 22)' }]);
  assert.equal(plan.github.enforce_admins, true);
  assert.match(pocp(dir, ['ci', 'required']).stdout, /required checks: verify, test \(ubuntu-latest, 22\)/);
});

test('ci required --apply refuses an empty required-check list without calling GitHub', () => {
  const dir = sampleRepo();
  write(dir, '.proof/config.json', JSON.stringify({ pocp: 1 }));
  const fake = fakeGh(dir);
  const r = pocp(dir, ['ci', 'required', '--apply'], { env: { POCP_GH: fake.bin } });
  assert.equal(r.code, 2);
  assert.match(r.stdout, /refusing to set protection that requires nothing/);
  assert.equal(fs.existsSync(fake.log), false, 'gh was never called');
});

test('ci required --apply on an unprotected branch sets fresh protection', () => {
  const dir = sampleRepo();
  write(dir, '.proof/config.json', JSON.stringify({ pocp: 1, ci: { branch: 'main', required_checks: ['verify'] } }));
  const fake = fakeGh(dir);
  const r = pocp(dir, ['ci', 'required', '--apply', '--json'], { env: { POCP_GH: fake.bin } });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(r.json.result.was_protected, false);
  const log = fs.readFileSync(fake.log, 'utf8');
  assert.match(log, /ARGS api repos\/owner\/name\/branches\/main\/protection\n/, 'reads the current protection first');
  const sent = JSON.parse(log.split('\n').find((l) => l.startsWith('{')));
  // Up-to-date branches are part of the default plan (ci.require_up_to_date).
  assert.deepEqual(sent.required_status_checks, { strict: true, checks: [{ context: 'verify' }] });
  assert.deepEqual(sent.required_pull_request_reviews, { required_approving_review_count: 0 });
  assert.equal(sent.enforce_admins, true);
  assert.equal(sent.restrictions, null);
});

test('ci required --apply keeps existing protections and never loosens them', () => {
  const dir = sampleRepo();
  write(dir, '.proof/config.json', JSON.stringify({ pocp: 1, ci: { branch: 'main', required_checks: ['verify', 'tests'], require_pull_request: false, enforce_admins: false } }));
  const existing = {
    required_status_checks: { strict: true, contexts: ['lint', 'tests'], checks: [{ context: 'lint', app_id: 15368 }, { context: 'tests', app_id: null }] },
    enforce_admins: { enabled: true },
    required_pull_request_reviews: {
      dismiss_stale_reviews: true, require_code_owner_reviews: true, required_approving_review_count: 2, require_last_push_approval: false,
      dismissal_restrictions: { users: [{ login: 'alice' }], teams: [{ slug: 'core' }], apps: [] },
    },
    restrictions: { users: [{ login: 'bob' }], teams: [], apps: [{ slug: 'deploy-bot' }] },
    required_linear_history: { enabled: true },
    allow_force_pushes: { enabled: false },
    allow_deletions: { enabled: false },
    required_conversation_resolution: { enabled: true },
    lock_branch: { enabled: false },
  };
  const fake = fakeGh(dir, { existing });
  const r = pocp(dir, ['ci', 'required', '--apply'], { env: { POCP_GH: fake.bin } });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /existing protection kept/);
  assert.match(r.stdout, /added required checks: verify/);
  assert.match(r.stdout, /also still required \(set elsewhere\): lint/);
  const sent = JSON.parse(fs.readFileSync(fake.log, 'utf8').split('\n').find((l) => l.startsWith('{')));
  assert.deepEqual(sent.required_status_checks, { strict: true, checks: [{ context: 'lint', app_id: 15368 }, { context: 'tests' }, { context: 'verify' }] });
  assert.equal(sent.enforce_admins, true, 'config saying false does not turn existing enforcement off');
  assert.equal(sent.required_pull_request_reviews.required_approving_review_count, 2, 'existing review requirements are kept');
  assert.equal(sent.required_pull_request_reviews.require_code_owner_reviews, true);
  assert.deepEqual(sent.required_pull_request_reviews.dismissal_restrictions, { users: ['alice'], teams: ['core'], apps: [] });
  assert.deepEqual(sent.restrictions, { users: ['bob'], teams: [], apps: ['deploy-bot'] });
  assert.equal(sent.required_linear_history, true);
  assert.equal(sent.required_conversation_resolution, true);
});

test('ci required --apply stops if the current protection cannot be read', () => {
  const dir = sampleRepo();
  write(dir, '.proof/config.json', JSON.stringify({ pocp: 1, ci: { branch: 'main', required_checks: ['verify'] } }));
  const fake = fakeGh(dir, { getStatus: 403, getStdout: '{"message":"Upgrade to GitHub Pro or make this repository public to enable this feature."}' });
  const r = pocp(dir, ['ci', 'required', '--apply'], { env: { POCP_GH: fake.bin } });
  assert.equal(r.code, 1);
  assert.match(r.stdout, /could not set branch protection on owner\/name@main: Upgrade to GitHub Pro/);
  assert.match(r.stdout, /owner\/name@main is unchanged: GitHub will not block merges/);
  assert.match(r.stdout, /private repositories with a paid plan/);
  assert.match(r.stdout, /POCP verification is unaffected/);
  assert.match(r.stdout, /require these checks[^\n]*:\n    - verify/);
  assert.match(r.stdout, /require a pull request before merging/);
  assert.doesNotMatch(fs.readFileSync(fake.log, 'utf8'), /-X PUT/, 'nothing was written');
});

test('only "ci required --apply" ever contacts the host: every other command leaves merge settings alone', () => {
  const dir = sampleRepo({ hooks: true });
  write(dir, '.proof/config.json', JSON.stringify({ pocp: 1, ci: { branch: 'main', required_checks: ['verify'] } }));
  git(dir, 'add', '-A');
  git(dir, '-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', 'config');
  const tripwire = path.join(dir, '..', `${path.basename(dir)}-tripwire`);
  fs.writeFileSync(`${tripwire}.sh`, `#!/bin/sh\necho "$@" >> ${tripwire}.log\nexit 1\n`);
  fs.chmodSync(`${tripwire}.sh`, 0o755);
  const env = { POCP_GH: `${tripwire}.sh`, GITHUB_ACTIONS: 'true', GITHUB_STEP_SUMMARY: `${tripwire}.md` };
  write(dir, 'src/math.js', TWEAK_ADD);
  git(dir, 'add', 'src/math.js');
  const id = packetId(pocp(dir, ['open', '--intent', 'x', '--touch', 'src/math.js'], { env }).stdout);
  for (const args of [['status'], ['gate'], ['prove', id], ['gate'], ['trailer'], ['rules', 'check'], ['ci', 'required'], ['ci', 'required', '--json'], ['metrics'], ['hooks', 'status'], ['history', '--commits', '3']]) {
    pocp(dir, args, { env });
  }
  sh(dir, 'git', ['commit', '-m', 'x'], { env });
  pocp(dir, ['verify', 'HEAD', '--require-coverage', '--rerun'], { env });
  pocp(dir, ['ci-run', '--results', `${tripwire}.jsonl`, '--', 'true'], { env });
  pocp(dir, ['verify', 'HEAD~1..HEAD', '--ci-results', `${tripwire}.jsonl`], { env });
  assert.equal(fs.existsSync(`${tripwire}.log`), false, 'no command except "ci required --apply" called gh');
  pocp(dir, ['ci', 'required', '--apply'], { env });
  assert.equal(fs.existsSync(`${tripwire}.log`), true, 'the explicit --apply does');
});

test('ci required --apply falls back to contexts when GitHub rejects checks alone', () => {
  // GitHub has changed which forms it accepts; found live when it rejected contexts + checks together.
  const dir = sampleRepo();
  write(dir, '.proof/config.json', JSON.stringify({ pocp: 1, ci: { branch: 'main', required_checks: ['verify'] } }));
  const fake = fakeGh(dir, { rejectChecksOnly: true });
  const r = pocp(dir, ['ci', 'required', '--apply', '--json'], { env: { POCP_GH: fake.bin } });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const bodies = fs.readFileSync(fake.log, 'utf8').split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l).required_status_checks);
  assert.deepEqual(bodies, [{ strict: true, checks: [{ context: 'verify' }] }, { strict: true, contexts: ['verify'] }]);
  assert.deepEqual(r.json.result.payload.required_status_checks, { strict: true, contexts: ['verify'] });
});
