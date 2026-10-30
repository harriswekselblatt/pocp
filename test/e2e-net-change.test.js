// verify over a range judges the pull request's net change, merges included: splitting a test
// change and a code change across commits, or making them inside a merge commit, gives the
// same verdict as making them in one commit (SPEC §8.3).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { git, pocp, read, sh, tmpRepo, write, writeRules } from './helpers.js';

const noHooks = ['-c', 'core.hooksPath=/dev/null'];
const MATH = 'export const add = (a, b) => a + b;\nexport const lt = (a, b) => a < b;\n';
const BUGGY = 'export const add = (a, b) => Math.abs(a) + b;\nexport const lt = (a, b) => a < b;\n';
const TEST = [
  "import { add, lt } from '../src/math.js';",
  "import { check } from '../lib/check.js';",
  "check(add(2, 3) === 5, 'add');",
  "check(add(-1, 1) === 0, 'add negative');",
  "check(lt(1, 2) === true, 'lt');",
  "check(lt(2, 1) === false, 'lt reversed');",
  "console.log('ok');",
  '',
].join('\n');
const dropNegative = (text) => text.replace(/.*add\(-1, 1\).*\n/, '');

/** Base repo: src/math.js (add, lt), lib/check.js, test/math.test.js, one rule over all three. */
function baseRepo() {
  const dir = tmpRepo();
  write(dir, 'package.json', '{ "type": "module" }\n');
  write(dir, 'src/math.js', MATH);
  write(dir, 'lib/check.js', "export function check(ok, what) {\n  if (!ok) { console.error(`failed: ${what}`); process.exit(1); }\n}\n");
  write(dir, 'test/math.test.js', TEST);
  const init = pocp(dir, ['init', '--hooks']);
  assert.equal(init.code, 0, init.stderr);
  writeRules(dir, { requirements: [{ id: 'math', globs: ['src/**', 'test/**', 'lib/**'], obligation: { kind: 'test', run: 'node test/math.test.js' }, source: 'author' }] });
  git(dir, 'add', '-A');
  git(dir, ...noHooks, 'commit', '-q', '-m', 'base');
  return { dir, base: git(dir, 'rev-parse', 'HEAD') };
}

/** Commit the working change the way an agent would: pocp fix, then a commit through the hooks. */
function fixAndCommit(dir, intent) {
  git(dir, 'add', '-A');
  const f = pocp(dir, ['fix', '--intent', intent]);
  assert.equal(f.code, 0, `${f.stdout}\n${f.stderr}`);
  const c = sh(dir, 'git', ['commit', '-q', '-m', intent], { allowFail: true });
  assert.equal(c.status, 0, `the gate passed this commit on its own: ${c.stderr}`);
}

function verifyRange(dir, base, extra = []) {
  return pocp(dir, ['verify', `${base}..HEAD`, '--require-coverage', '--rerun', '--json', ...extra]);
}

test('split cheat: dropping an assertion in one commit and adding the bug in the next is blocked', () => {
  const { dir, base } = baseRepo();
  write(dir, 'test/math.test.js', dropNegative(read(dir, 'test/math.test.js')));
  fixAndCommit(dir, 'tidy the add test');
  write(dir, 'src/math.js', BUGGY);
  fixAndCommit(dir, 'speed up add');

  const v = verifyRange(dir, base);
  assert.equal(v.code, 1, `the split must not verify: ${v.stdout}`);
  // Each commit still verifies on its own; the net change is what fails.
  assert.ok(v.json.commits.every((c) => c.ok), JSON.stringify(v.json.commits.map((c) => c.notes)));
  const net = v.json.net;
  assert.equal(net.kind, 'net');
  assert.equal(net.base, base);
  assert.equal(net.ok, false);
  assert.deepEqual(net.test_guard.files, ['test/math.test.js']);
  assert.equal(net.test_guard.mechanical[0].verdict, 'behavior-changed', net.test_guard.mechanical[0].summary);
  assert.equal(net.test_guard.mechanical[0].evidence, 'rerun');
  assert.ok(net.findings.some((f) => f.code === 'test_change' && f.blocking && /net change/.test(f.detail)));
  // The approval path is the same as for a test change made in one commit.
  assert.ok(v.json.approval.needs.some((n) => n.kind === 'tests' && n.files.includes('test/math.test.js')), JSON.stringify(v.json.approval));
  assert.equal(verifyRange(dir, base, ['--accept-test-change']).code, 0, 'a person can still approve it');

  // The same edits in one commit are blocked too: the verdict doesn't depend on the split.
  git(dir, 'reset', '-q', '--soft', base);
  git(dir, ...noHooks, 'commit', '-q', '-m', 'both at once');
  assert.equal(verifyRange(dir, base).code, 1);
});

test('merge cheat: weakening a test and adding the bug inside a merge commit is blocked', () => {
  const { dir, base } = baseRepo();
  git(dir, 'checkout', '-q', '-b', 'side');
  write(dir, 'src/extra.js', 'export const two = () => 2;\n');
  fixAndCommit(dir, 'add extra');
  git(dir, 'checkout', '-q', '-b', 'feature', base);
  write(dir, 'README.md', '# sample\n');
  fixAndCommit(dir, 'readme');
  sh(dir, 'git', ['merge', '--no-ff', '--no-commit', 'side']);
  write(dir, 'test/math.test.js', dropNegative(read(dir, 'test/math.test.js')));
  write(dir, 'src/math.js', BUGGY);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '--no-verify', '-m', 'merge side');

  const v = verifyRange(dir, base);
  assert.equal(v.code, 1, `content added in a merge must not escape: ${v.stdout}`);
  assert.ok(v.json.commits.every((c) => c.ok), 'the non-merge commits are honest');
  assert.equal(v.json.net.merges, 1);
  assert.deepEqual(v.json.net.test_guard.files, ['test/math.test.js']);
  assert.equal(v.json.net.test_guard.mechanical[0].verdict, 'behavior-changed');
  // The tip's re-run ran on the merge commit itself, not on the last non-merge commit.
  const tip = git(dir, 'rev-parse', 'HEAD');
  assert.equal(v.json.net.commit, tip);
  assert.ok(v.json.reruns.some((r) => r.status === 'passed' && r.subject === v.json.net.subject));
});

test('a merge commit that adds code no packet covers is reported by --require-coverage', () => {
  const { dir, base } = baseRepo();
  git(dir, 'checkout', '-q', '-b', 'side');
  write(dir, 'README.md', '# side\n');
  git(dir, 'add', '-A');
  git(dir, ...noHooks, 'commit', '-q', '-m', 'readme');
  git(dir, 'checkout', '-q', '-b', 'feature', base);
  write(dir, 'notes.txt', 'x\n');
  git(dir, 'add', '-A');
  git(dir, ...noHooks, 'commit', '-q', '-m', 'notes');
  sh(dir, 'git', ['merge', '--no-ff', '--no-commit', 'side']);
  write(dir, 'src/math.js', BUGGY);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '--no-verify', '-m', 'merge side');
  const v = pocp(dir, ['verify', `${base}..HEAD`, '--require-coverage', '--json']);
  assert.equal(v.code, 1, v.stdout);
  assert.ok(v.json.net.coverage.uncovered.includes('src/math.js'), JSON.stringify(v.json.net.coverage));
});

test('an honest multi-commit pull request that changes code and adds tests still verifies', () => {
  const { dir, base } = baseRepo();
  write(dir, 'src/math.js', `${MATH}export const sub = (a, b) => a - b;\n`);
  write(dir, 'test/math.test.js', read(dir, 'test/math.test.js').replace("import { add, lt }", "import { add, lt, sub }").replace("console.log('ok');", "check(sub(5, 3) === 2, 'sub');\nconsole.log('ok');"));
  fixAndCommit(dir, 'add sub');
  write(dir, 'test/math.test.js', read(dir, 'test/math.test.js').replace("console.log('ok');", "check(add(0, 0) === 0, 'add zero');\nconsole.log('ok');"));
  fixAndCommit(dir, 'one more add test');
  write(dir, 'src/math.js', read(dir, 'src/math.js').replace('a - b', '-(b - a)'));
  fixAndCommit(dir, 'rewrite sub');

  const v = verifyRange(dir, base);
  assert.equal(v.code, 0, v.stdout);
  assert.equal(v.json.net.ok, true);
  const m = v.json.net.test_guard.mechanical[0];
  assert.equal(m.verdict, 'passed', m.summary);
  // The seed is derived from the range, recorded, and the same on every run of this verify.
  assert.equal(typeof v.json.net.seed, 'number');
  assert.equal(m.result.detection.seed, v.json.net.seed);
  assert.equal(verifyRange(dir, base).json.net.seed, v.json.net.seed);
});

test('in block mode a multi-commit test change needs this verify\'s own re-run (fails closed without it)', () => {
  const { dir, base } = baseRepo();
  write(dir, 'test/math.test.js', read(dir, 'test/math.test.js').replace("console.log('ok');", "check(add(0, 0) === 0, 'add zero');\nconsole.log('ok');"));
  fixAndCommit(dir, 'more tests');
  write(dir, 'src/math.js', `${MATH}export const one = 1;\n`);
  fixAndCommit(dir, 'a constant');
  const v = pocp(dir, ['verify', `${base}..HEAD`, '--require-coverage', '--json']);
  assert.equal(v.code, 1);
  assert.ok(v.json.net.findings.some((f) => f.code === 'test_change' && /not re-checked here/.test(f.detail)));
  assert.equal(verifyRange(dir, base).code, 0, 'with --rerun the honest change passes');
});

test('an honest merge from main still verifies, and only the branch\'s own changes are judged', () => {
  const { dir, base } = baseRepo();
  git(dir, 'checkout', '-q', '-b', 'feature');
  write(dir, 'src/math.js', `${MATH}export const sub = (a, b) => a - b;\n`);
  write(dir, 'test/math.test.js', read(dir, 'test/math.test.js').replace("import { add, lt }", "import { add, lt, sub }").replace("console.log('ok');", "check(sub(5, 3) === 2, 'sub');\nconsole.log('ok');"));
  fixAndCommit(dir, 'add sub');
  git(dir, 'checkout', '-q', 'main');
  // Main changes its own tests meanwhile; merging that in is not the branch's test change.
  write(dir, 'lib/check.js', `${read(dir, 'lib/check.js')}export const VERSION = 2;\n`);
  write(dir, 'test/math.test.js', read(dir, 'test/math.test.js').replace("check(lt(1, 2)", "check(add(1, 1) === 2, 'add one');\ncheck(lt(1, 2)"));
  fixAndCommit(dir, 'main: more tests');
  const mainTip = git(dir, 'rev-parse', 'HEAD');
  git(dir, 'checkout', '-q', 'feature');
  const m = sh(dir, 'git', ['merge', '--no-ff', '-m', 'merge main', 'main'], { allowFail: true });
  assert.equal(m.status, 0, `${m.stdout}\n${m.stderr}`);

  const v = verifyRange(dir, mainTip);
  assert.equal(v.code, 0, v.stdout);
  assert.equal(v.json.net.base, mainTip, 'the net change starts at the merge base');
  assert.equal(v.json.net.merges, 1);
  assert.ok(v.json.net.ok);
  // main moved on after the merge: the base is still where the branch last took main.
  git(dir, 'checkout', '-q', 'main');
  write(dir, 'README.md', '# later\n');
  git(dir, 'add', '-A');
  git(dir, ...noHooks, 'commit', '-q', '-m', 'later');
  const later = git(dir, 'rev-parse', 'HEAD');
  git(dir, 'checkout', '-q', 'feature');
  const v2 = pocp(dir, ['verify', `${later}..feature`, '--require-coverage', '--rerun', '--json']);
  assert.equal(v2.code, 0, v2.stdout);
  assert.equal(v2.json.net.base, mainTip);
});

test('a single commit on the base is judged once, with the range-derived seed', () => {
  const { dir, base } = baseRepo();
  write(dir, 'test/math.test.js', read(dir, 'test/math.test.js').replace("console.log('ok');", "check(add(0, 0) === 0, 'add zero');\nconsole.log('ok');"));
  fixAndCommit(dir, 'more tests');
  const v = verifyRange(dir, base);
  assert.equal(v.code, 0, v.stdout);
  assert.equal(v.json.net, undefined, 'no separate net check for one plain commit');
  const guard = v.json.commits[0].reruns.find((r) => r.kind === 'guard');
  assert.ok(guard, JSON.stringify(v.json.commits[0].reruns));
  assert.match(guard.run, /seed \d+/);
  assert.equal(guard.status, 'passed', guard.summary);
});

test('a merge at the head that edits CI definitions or loosens policy is reported', () => {
  const { dir, base } = baseRepo();
  git(dir, 'checkout', '-q', '-b', 'side');
  write(dir, 'README.md', '# side\n');
  git(dir, 'add', '-A');
  git(dir, ...noHooks, 'commit', '-q', '-m', 'readme');
  git(dir, 'checkout', '-q', '-b', 'feature', base);
  write(dir, 'notes.txt', 'x\n');
  git(dir, 'add', '-A');
  git(dir, ...noHooks, 'commit', '-q', '-m', 'notes');
  sh(dir, 'git', ['merge', '--no-ff', '--no-commit', 'side']);
  write(dir, '.github/workflows/ci.yml', 'on: push\njobs: {}\n');
  writeRules(dir, { requirements: [] });
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '--no-verify', '-m', 'merge side');
  const v = pocp(dir, ['verify', `${base}..HEAD`, '--json']);
  assert.equal(v.code, 1, v.stdout);
  const codes = v.json.net.findings.map((f) => f.code);
  assert.ok(codes.includes('ci_config_changed'), JSON.stringify(v.json.net.findings));
  assert.ok(codes.includes('policy_loosened'), JSON.stringify(v.json.net.findings));
});
