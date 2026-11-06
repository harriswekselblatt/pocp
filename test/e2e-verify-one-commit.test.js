// A pull request's test edit gets the same verdict whether it arrives as one commit or several.
// A range of several commits checks test edits on its net change, from the base branch's
// rules; a one-commit range used to check them only through the commit's packet, so with no
// packet the edit always went to a person. Now a one-commit range checks test files no
// packet covers from the rules too. Packets, coverage and plain `verify <rev>` are unchanged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { git, pocp, tmpRepo, write, writeConfig, writeRules } from './helpers.js';

const T = "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add } from '../src/math.js';\ntest('adds', () => {\n  assert.equal(add(2, 3), 5);\n  assert.equal(add(-1, 1), 0);\n});\n";
const RULE = { id: 'tests', globs: ['src/**', 'test/**'], obligation: { kind: 'test', run: 'node --test test/*.test.js', changed_test_command: ['node', '--test', '{tests}'] } };

/** A project with no hooks (CI only), on branch "base". */
function project({ rules = [RULE], config } = {}) {
  const dir = tmpRepo();
  write(dir, 'package.json', '{ "type": "module" }\n');
  write(dir, 'src/math.js', 'export const add = (a, b) => a + b;\n');
  write(dir, 'test/add.test.js', T);
  assert.equal(pocp(dir, ['init']).code, 0);
  writeRules(dir, { requirements: rules });
  if (config) writeConfig(dir, config);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'start');
  git(dir, 'branch', 'base');
  return dir;
}

/** Apply `change` as one commit, or as an unrelated commit (a file no rule covers) followed by it. */
function pullRequest({ commits, change, hooks = false, after, ...opts }) {
  const dir = project(opts);
  if (hooks) assert.equal(pocp(dir, ['hooks', 'install']).code, 0);
  if (commits === 2) {
    write(dir, 'docs/notes.md', 'notes\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'unrelated');
  }
  change(dir);
  git(dir, 'add', '-A');
  if (hooks) assert.equal(pocp(dir, ['fix', '--intent', 'the change']).code, 0);
  git(dir, 'commit', '-q', '-m', 'the change');
  if (after) after(dir);
  return dir;
}

function collect(obj, key, out = []) {
  if (obj && typeof obj === 'object') {
    if (Array.isArray(obj[key])) out.push(...obj[key]);
    for (const v of Object.values(obj)) collect(v, key, out);
  }
  return out;
}

function verifyRange(dir, extra = []) {
  const v = pocp(dir, ['verify', 'base..HEAD', '--rerun', '--json', ...extra]);
  assert.ok(v.json, v.stdout + v.stderr);
  const codes = [...new Set(collect(v.json, 'findings').filter((f) => f.blocking !== false).map((f) => f.code))].sort();
  const guards = collect(v.json, 'reruns').filter((r) => r.kind === 'guard');
  return { ok: v.json.ok, code: v.code, codes, guards, json: v.json };
}

/** The same change as one commit and as two: same verdict and same blocking findings. */
function both(change, { extra = [], ...opts } = {}) {
  const one = verifyRange(pullRequest({ commits: 1, change, ...opts }), extra);
  const two = verifyRange(pullRequest({ commits: 2, change, ...opts }), extra);
  assert.equal(one.ok, two.ok, `one commit: ${JSON.stringify(one.codes)}; two: ${JSON.stringify(two.codes)}`);
  assert.deepEqual(one.codes, two.codes);
  return { one, two };
}

const addCase = (dir) => write(dir, 'test/add.test.js', T.replace('});\n', "});\ntest('zero', () => {\n  assert.equal(add(0, 0), 0);\n});\n"));
const weaken = (dir) => {
  write(dir, 'src/math.js', 'export const add = (a, b) => Math.abs(a) + b;\n');
  write(dir, 'test/add.test.js', T.replace('add(-1, 1), 0)', 'add(-1, 1), 2)'));
};

test('an added test case, no packet: verified as one commit and as two, the test check running once from the rules', () => {
  const { one, two } = both(addCase);
  assert.equal(one.ok, true, JSON.stringify(one.codes));
  assert.equal(one.guards.length, 1, 'one check, not two');
  assert.match(one.guards[0].run, /^test guard \(rules,/);
  assert.equal(one.guards[0].verdict, 'passed');
  assert.equal(two.guards.length, 1);
  assert.match(two.guards[0].run, /^test guard \(net change/);
});

test('a weakened test on broken code, no packet: a behavior change either way, and the approval accepts it either way', () => {
  const { one, two } = both(weaken);
  assert.deepEqual(one.codes, ['test_change']);
  assert.equal(one.guards[0].verdict, 'behavior-changed');
  assert.equal(two.guards[0].verdict, 'behavior-changed');
  const approved = both(weaken, { extra: ['--accept-test-change'] });
  assert.equal(approved.one.ok, true, JSON.stringify(approved.one.codes));
});

test('test edits with no rule covering the tests go to a person either way, with the same reason', () => {
  const rules = [{ id: 'src', globs: ['src/**'], obligation: { kind: 'test', run: 'node --test test/*.test.js' } }];
  const { one, two } = both(addCase, { rules });
  assert.deepEqual(one.codes, ['test_change']);
  const reason = (r) => collect(r.json, 'findings').find((f) => f.code === 'test_change').detail;
  assert.match(reason(one), /no rule requires a check covering these files/);
  assert.match(reason(two), /no rule requires a check covering these files/);
});

test('coverage still applies: no packet is uncovered either way, and the test check still runs', () => {
  const { one } = both(addCase, { extra: ['--require-coverage'] });
  assert.deepEqual(one.codes, ['uncovered']);
  assert.equal(one.guards[0].verdict, 'passed');
});

test('a commit linked to a malformed packet still blocks, either way, and the test check still runs from the rules', () => {
  // The commit carries its Proof-Of-Change trailer; then its packet file is broken.
  const corrupt = (dir) => {
    const id = /Proof-Of-Change: (p-[0-9a-f]+)/.exec(git(dir, 'log', '-1', '--format=%B'))?.[1];
    assert.ok(id, 'the commit carries a trailer');
    write(dir, `.proof/packets/${id}.json`, '{ not json');
    git(dir, 'add', '-A');
    git(dir, '-c', 'core.hooksPath=/dev/null', 'commit', '-q', '--amend', '--no-edit');
  };
  const { one, two } = both(addCase, { hooks: true, after: corrupt });
  assert.equal(one.ok, false);
  assert.ok(one.codes.length && !one.codes.includes('test_change'), `the bad packet blocks; the test edit itself passes: ${JSON.stringify(one.codes)}`);
  assert.equal(one.guards.at(-1).verdict, 'passed');
  assert.equal(two.guards.at(-1).verdict, 'passed');
});

test('attest mode, no packet: a test check that does not pass needs the approval either way', () => {
  const { one } = both(weaken, { config: { guard: { tests: 'attest', mutants: 0 } } });
  assert.deepEqual(one.codes, ['test_change']);
});

test('a commit with a valid packet keeps its own path: no extra rules check, same verdict as two commits', () => {
  const { one } = both(addCase, { hooks: true });
  assert.equal(one.ok, true, JSON.stringify(one.codes));
  assert.equal(one.guards.length, 1, JSON.stringify(one.guards.map((x) => x.run)));
  assert.doesNotMatch(one.guards[0].run, /\(rules,/, "the packet's guard, not the fallback");
});

test('plain verify of one commit (no range base) is unchanged: no packet means the test edit goes to a person', () => {
  const dir = pullRequest({ commits: 1, change: addCase });
  const v = pocp(dir, ['verify', 'HEAD', '--rerun', '--json']);
  const codes = collect(v.json, 'findings').map((f) => f.code);
  assert.ok(codes.includes('test_change'), JSON.stringify(codes));
  assert.match(collect(v.json, 'findings').find((f) => f.code === 'test_change').detail, /no mechanical check covers them/);
});
