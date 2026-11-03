// Files listed in ci.files beyond CI definitions (e.g. an evaluation's judging code and data):
// the failure names them, a SHA-bound approval doesn't carry over to a later push, the commit
// that first adds a protection is already protected (stricter policy applies at once), and this repository's
// own policy covers its whole evaluation.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { git, pocp, sampleRepo, write, writeConfig } from './helpers.js';
import { matchGlob } from '../src/glob.js';
import { readAnnotations } from '../src/approvals.js';
import { DEFAULT_CI_FILES } from '../src/store.js';

const noHooks = (dir, msg) => git(dir, '-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', msg);
const DEFAULT_CI = [...DEFAULT_CI_FILES];

function protectedRepo() {
  const dir = sampleRepo();
  writeConfig(dir, { ci: { files: [...DEFAULT_CI, 'eval/**'] } });
  write(dir, 'eval/judge.js', 'export const label = (passed) => (passed ? "honest" : "cheat");\n');
  git(dir, 'add', '-A');
  noHooks(dir, 'adopt: protect eval/');
  return dir;
}

test('a change to a protected evaluation file is named as such, and needs a maintainer', () => {
  const dir = protectedRepo();
  const base = git(dir, 'rev-parse', 'HEAD');
  write(dir, 'eval/judge.js', 'export const label = () => "honest";\n');
  git(dir, 'add', '-A');
  noHooks(dir, 'tidy the judge');
  const v = pocp(dir, ['verify', `${base}..HEAD`, '--json']);
  assert.equal(v.code, 1);
  const f = v.json.commits[0].findings.find((x) => x.code === 'ci_config_changed');
  assert.ok(f, JSON.stringify(v.json.commits[0].findings));
  assert.match(f.detail, /^protected files changed \(eval\/judge\.js\)/);
  assert.doesNotMatch(f.detail, /CI configuration/);
  // `pocp approvals` reads older verify runs by their error text; the new wording must still
  // be recognised as the one thing a maintainer's policy label approves.
  const read = readAnnotations([{ annotation_level: 'failure', title: 'POCP', message: `0123456789ab ${f.detail}` }]);
  assert.equal(read.only, true, JSON.stringify(read));
});

test('a workflow change is still called CI configuration', () => {
  const dir = protectedRepo();
  const base = git(dir, 'rev-parse', 'HEAD');
  write(dir, '.github/workflows/ci.yml', 'name: ci\n');
  git(dir, 'add', '-A');
  noHooks(dir, 'workflow');
  const v = pocp(dir, ['verify', `${base}..HEAD`, '--json']);
  const f = v.json.commits[0].findings.find((x) => x.code === 'ci_config_changed');
  assert.match(f.detail, /^CI configuration changed \(\.github\/workflows\/ci\.yml\)/);
});

test('an approval bound to one head does not authorize a later push', () => {
  const dir = protectedRepo();
  const base = git(dir, 'rev-parse', 'HEAD');
  write(dir, 'eval/judge.js', 'export const label = (passed) => (passed ? "honest" : "cheat"); // reviewed\n');
  git(dir, 'add', '-A');
  noHooks(dir, 'reviewed change');
  const approved = git(dir, 'rev-parse', 'HEAD');
  assert.equal(pocp(dir, ['verify', `${base}..HEAD`, `--accept-policy-change=${approved}`]).code, 0, 'the approved head passes');
  write(dir, 'eval/judge.js', 'export const label = () => "honest";\n');
  git(dir, 'add', '-A');
  noHooks(dir, 'pushed after the approval');
  const v = pocp(dir, ['verify', `${base}..HEAD`, `--accept-policy-change=${approved}`, '--json']);
  assert.equal(v.code, 1, 'the old approval does not cover the new head');
  assert.ok(v.json.commits.some((c) => c.findings.some((x) => x.code === 'ci_config_changed')));
});

test('first adoption: a new protection applies to the commit that adds it, and to every later change', () => {
  const dir = sampleRepo();
  const base = git(dir, 'rev-parse', 'HEAD');
  writeConfig(dir, { ci: { files: [...DEFAULT_CI, 'eval/**'] } });
  write(dir, 'eval/judge.js', 'export const label = (passed) => (passed ? "honest" : "cheat");\n');
  git(dir, 'add', '-A');
  noHooks(dir, 'adopt');
  const adopt = pocp(dir, ['verify', `${base}..HEAD`, '--json']);
  const c0 = adopt.json.commits[0];
  // Stricter policy applies immediately: adopting the protection together with the protected
  // files is itself a protected change, so the adoption needs a maintainer once.
  assert.ok(c0.findings.some((x) => x.code === 'ci_config_changed'), JSON.stringify(c0.findings));
  assert.ok(!c0.findings.some((x) => x.code === 'policy_loosened'), 'adding a protection is stricter, not looser');
  const mid = git(dir, 'rev-parse', 'HEAD');
  write(dir, 'eval/judge.js', 'export const label = () => "honest";\n');
  git(dir, 'add', '-A');
  noHooks(dir, 'after adoption');
  const after = pocp(dir, ['verify', `${mid}..HEAD`, '--json']);
  assert.equal(after.code, 1);
  assert.ok(after.json.commits[0].findings.some((x) => x.code === 'ci_config_changed'));
});

test('this repository protects its whole evaluation and study plan', () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const cfg = JSON.parse(fs.readFileSync(`${root}/.proof/config.json`, 'utf8'));
  const prot = (p) => cfg.ci.files.some((gl) => matchGlob(p, gl));
  for (const p of ['eval/reference/check.py', 'eval/reference/canaries/x/canary.json', 'eval/tasks/freeze.py', 'eval/tasks/frozen/MANIFEST.json',
    'eval/lib/stats.js', 'eval/e1/judge.js', 'eval/e1/report.js', 'eval/e1/prompt.md', 'eval/run-tests.sh', 'eval/results/E1a/x.jsonl',
    'eval/results/REDACTIONS.md', 'eval/PREREG.md', 'docs/EVAL-PLAN.md']) assert.ok(prot(p), `${p} is protected`);
});
