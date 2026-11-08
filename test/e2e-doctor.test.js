// `pocp doctor`: the adoption pitfalls, checked before they block anyone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { git, pocp, sampleRepo, tmpRepo, write, writeConfig, writeRules } from './helpers.js';

const check = (r, id) => r.json.checks.filter((c) => c.id === id);

/** A fake gh that answers from a table of endpoint → { status, body }. */
function fakeGh(dir, table) {
  const file = path.join(dir, '..', `${path.basename(dir)}-gh.mjs`);
  fs.writeFileSync(file, `#!/usr/bin/env node
const table = ${JSON.stringify(table)};
const args = process.argv.slice(2);
const key = args[0] === 'repo' ? 'repo view' : args[1];
const hit = table[key];
if (!hit) { process.stderr.write('not found: ' + key); process.exit(1); }
process.stdout.write(JSON.stringify(hit.body));
process.exit(hit.status || 0);
`);
  fs.chmodSync(file, 0o755);
  return file;
}

const WORKFLOW = `name: pocp
on: pull_request
jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: acme/pocp@0123456789abcdef0123456789abcdef01234567
        with:
          accept-policy-change: \${{ contains(github.event.pull_request.labels.*.name, 'pocp-approve-policy') }}
          accept-test-change: \${{ contains(github.event.pull_request.labels.*.name, 'pocp-approve-tests') }}
`;

test('doctor finds missing hooks, a missing workflow, a self-calling check and an attest-mode guard', () => {
  const dir = sampleRepo({ rules: { requirements: [{ id: 'lint', glob: 'src/**', obligation: { kind: 'command', run: 'npx pocp rules check' }, source: 'author' }] } });
  writeConfig(dir, { guard: { tests: 'attest' } });
  const r = pocp(dir, ['doctor', '--offline', '--json']);
  assert.equal(r.code, 1);
  assert.equal(check(r, 'hooks')[0].status, 'problem');
  assert.equal(check(r, 'hooks')[0].fix, 'pocp hooks install');
  assert.equal(check(r, 'workflow')[0].status, 'problem');
  assert.equal(check(r, 'self-calling')[0].status, 'warning');
  assert.match(check(r, 'self-calling')[0].what, /lint/);
  assert.equal(check(r, 'guard-mode')[0].status, 'warning');
  assert.equal(check(r, 'required-checks')[0].status, 'problem');
  const human = pocp(dir, ['doctor', '--offline']);
  assert.match(human.stdout, /FIX  git hooks are not installed\n\s+why: .*\n\s+fix: pocp hooks install/);
});

test('the first adoption PR should carry only .proof/ and CI files', () => {
  const dir = tmpRepo();
  write(dir, 'src/a.js', 'export const a = 1;\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'before POCP');
  git(dir, 'branch', 'base');
  pocp(dir, ['init', '--hooks']);
  write(dir, '.github/workflows/pocp.yml', WORKFLOW);
  git(dir, 'add', '-A');
  git(dir, '-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', 'adopt');
  const clean = pocp(dir, ['doctor', '--offline', '--base', 'base', '--json']);
  assert.equal(check(clean, 'adoption-scope')[0].status, 'ok');
  assert.match(check(clean, 'adoption-approval')[0].fix, /pocp-approve-policy/);

  write(dir, 'src/a.js', 'export const a = 2;\n');
  git(dir, 'add', '-A');
  git(dir, '-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', 'and a feature');
  const mixed = pocp(dir, ['doctor', '--offline', '--base', 'base', '--json']);
  const c = check(mixed, 'adoption-scope')[0];
  assert.equal(c.status, 'problem');
  assert.match(c.what, /src\/a\.js/);
  assert.match(c.fix, /only \.proof\/ and CI files/);
});

test('doctor checks Action access, labels and branch protection on GitHub (read-only)', () => {
  const dir = sampleRepo({ hooks: true });
  write(dir, '.github/workflows/pocp.yml', WORKFLOW);
  writeConfig(dir, { guard: { tests: 'block' }, ci: { branch: 'main', required_checks: ['verify', 'test'] } });
  git(dir, 'add', '-A');
  git(dir, '-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', 'ci');
  git(dir, 'remote', 'add', 'origin', 'https://github.com/me/site.git');
  const gh = fakeGh(dir, {
    'repo view': { body: { nameWithOwner: 'me/site', isPrivate: true } },
    'repos/acme/pocp': { body: { private: true } },
    'repos/acme/pocp/actions/permissions/access': { body: { access_level: 'none' } },
    'repos/me/site/labels?per_page=100': { body: [{ name: 'pocp-approve-policy' }] },
    'repos/me/site/branches/main/protection': { body: { required_status_checks: { contexts: ['test'] } } },
  });
  const r = pocp(dir, ['doctor', '--json'], { env: { POCP_GH: gh } });
  assert.equal(r.code, 1);
  const access = check(r, 'action-access')[0];
  assert.equal(access.status, 'problem');
  assert.match(access.why, /repository not found/);
  assert.equal(access.fix, 'gh api -X PUT repos/acme/pocp/actions/permissions/access -f access_level=organization');
  const labels = check(r, 'labels')[0];
  assert.equal(labels.status, 'problem');
  assert.match(labels.what, /pocp-approve-tests/);
  assert.match(labels.fix, /gh label create pocp-approve-tests --repo me\/site/);
  const prot = check(r, 'branch-protection')[0];
  assert.equal(prot.status, 'problem');
  assert.match(prot.what, /check "verify" is not required/);
  // Everything else the plan asks of the branch is reported too, not just the check names.
  assert.match(prot.what, /admins can merge past the required checks/);
  assert.match(prot.what, /without being up to date/);
  assert.match(prot.what, /pushed without a pull request/);
  assert.equal(prot.fix, 'pocp ci required --apply');
  assert.equal(check(r, 'required-checks')[0].status, 'ok');
  assert.equal(check(r, 'guard-mode')[0].status, 'ok');
});

test('doctor: required checks must include the verify job; free private repos are advisory', () => {
  const dir = sampleRepo({ hooks: true });
  write(dir, '.github/workflows/pocp.yml', WORKFLOW);
  writeConfig(dir, { ci: { branch: 'main', required_checks: ['test'] } });
  writeRules(dir, { requirements: [] });
  git(dir, 'add', '-A');
  git(dir, '-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', 'ci');
  git(dir, 'remote', 'add', 'origin', 'git@github.com:me/site.git');
  const gh = fakeGh(dir, {
    'repo view': { body: { nameWithOwner: 'me/site', isPrivate: true } },
    'repos/acme/pocp': { body: { private: false } },
    'repos/me/site/labels?per_page=100': { body: [{ name: 'pocp-approve-policy' }, { name: 'pocp-approve-tests' }] },
    'repos/me/site/branches/main/protection': { status: 1, body: { message: 'Upgrade to GitHub Pro or make this repository public to enable this feature.' } },
  });
  const r = pocp(dir, ['doctor', '--json'], { env: { POCP_GH: gh } });
  const req = check(r, 'required-checks')[0];
  assert.equal(req.status, 'problem');
  assert.match(req.what, /does not include the verify job \(verify\)/);
  assert.equal(check(r, 'branch-protection')[0].status, 'warning');
  assert.match(check(r, 'branch-protection')[0].why, /advisory/);
  assert.equal(check(r, 'labels')[0].status, 'ok');
  assert.equal(check(r, 'action-access')[0].status, 'ok');
});

test('doctor: a branch that enforces the whole plan is ok; opting out of up-to-date branches is a warning', () => {
  const full = { required_status_checks: { strict: true, contexts: ['verify', 'test'] }, required_pull_request_reviews: {}, enforce_admins: { enabled: true } };
  for (const [config, expectWarning] of [[{}, false], [{ require_up_to_date: false }, true]]) {
    const dir = sampleRepo({ hooks: true });
    write(dir, '.github/workflows/pocp.yml', WORKFLOW);
    writeConfig(dir, { ci: { branch: 'main', required_checks: ['verify', 'test'], ...config } });
    git(dir, 'add', '-A');
    git(dir, '-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', 'ci');
    git(dir, 'remote', 'add', 'origin', 'https://github.com/me/site.git');
    const gh = fakeGh(dir, {
      'repo view': { body: { nameWithOwner: 'me/site', isPrivate: false } },
      'repos/acme/pocp': { body: { private: false } },
      'repos/me/site/labels?per_page=100': { body: [{ name: 'pocp-approve-policy' }, { name: 'pocp-approve-tests' }] },
      'repos/me/site/branches/main/protection': { body: { ...full, required_status_checks: { ...full.required_status_checks, strict: !expectWarning } } },
    });
    const r = pocp(dir, ['doctor', '--json'], { env: { POCP_GH: gh } });
    assert.equal(check(r, 'branch-protection')[0].status, 'ok', JSON.stringify(check(r, 'branch-protection')));
    const warn = check(r, 'up-to-date');
    assert.equal(warn.length, expectWarning ? 1 : 0, JSON.stringify(warn));
    if (expectWarning) assert.match(warn[0].why, /not the code that was verified/);
  }
});
