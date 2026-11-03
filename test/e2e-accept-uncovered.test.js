// Accepting missing proof: a maintainer may list exact commits and files that have no packet in
// .proof/exceptions.json. They count only with --accept-uncovered for the head being verified,
// stay visible as UNPROVEN warnings, and never clear any other finding. Changing the list is
// a policy loosening, so it needs --accept-policy-change too.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { git, pocp, tmpRepo, write, writeConfig, writeRules } from './helpers.js';

const noHooks = ['-c', 'core.hooksPath=/dev/null'];
const commit = (dir, msg) => { git(dir, 'add', '-A'); git(dir, ...noHooks, 'commit', '-q', '-m', msg); return git(dir, 'rev-parse', 'HEAD'); };
const CHECK = "import { add } from '../src/math.js';\nif (add(2, 3) !== 5) process.exit(1);\n";

function repo(config) {
  const dir = tmpRepo();
  write(dir, 'package.json', '{ "type": "module" }\n');
  write(dir, 'src/math.js', 'export const add = (a, b) => a + b;\n');
  write(dir, 'test/math.check.mjs', CHECK);
  pocp(dir, ['init']);
  writeRules(dir, { requirements: [{ id: 'unit', globs: ['src/**', 'test/**'], obligation: { kind: 'test', run: 'node test/math.check.mjs' }, source: 'author' }] });
  if (config) writeConfig(dir, config);
  const base = commit(dir, 'base');
  return { dir, base };
}
/** Write the exception list and commit it the way a maintainer would: through a packet. */
function listExceptions(dir, entries) {
  write(dir, '.proof/exceptions.json', `${JSON.stringify({ pocp: 1, uncovered: entries }, null, 2)}\n`);
  git(dir, 'add', '-A');
  const f = pocp(dir, ['fix', '--intent', 'list reviewed exceptions']);
  assert.equal(f.code, 0, f.stdout + f.stderr);
  git(dir, 'add', '-A');
  const trailers = pocp(dir, ['trailer']).stdout.trim();
  git(dir, ...noHooks, 'commit', '-q', '-m', `list reviewed exceptions\n\n${trailers}`);
  return git(dir, 'rev-parse', 'HEAD');
}
const entry = (c, files, extra = {}) => ({ commit: c, files, reason: 'committed before the hooks were installed; reviewed', reviewer: 'maintainer', ...extra });
const findings = (v) => [...(v.json?.commits || []).flatMap((c) => (c.findings || []).map((f) => ({ ...f, at: c.commit }))), ...(v.json?.net?.findings || []).map((f) => ({ ...f, at: 'net' })), ...(v.json?.findings || []).map((f) => ({ ...f, at: 'range' }))];
const blocking = (v, code) => findings(v).filter((f) => f.blocking && (!code || f.code === code));

function verify(dir, base, approvals = []) {
  return pocp(dir, ['verify', `${base}..HEAD`, '--require-coverage', '--json', ...approvals]);
}

test('a listed exception, with both approvals for this head, leaves the gap visible but not blocking', () => {
  const { dir, base } = repo();
  write(dir, 'src/math.js', 'export const add = (a, b) => a + b; // tidy\n');
  const c1 = commit(dir, 'no packet');
  const head = listExceptions(dir, [entry(c1, ['src/math.js'])]);

  const none = verify(dir, base);
  assert.equal(none.code, 1);
  assert.ok(blocking(none, 'uncovered').some((f) => f.at === c1), 'without approval: uncovered blocks');
  assert.ok(blocking(none, 'policy_loosened').length, 'changing the exception list is a loosening');

  const onlyPolicy = verify(dir, base, [`--accept-policy-change=${head}`]);
  assert.ok(blocking(onlyPolicy, 'uncovered').length, 'the list alone waives nothing');

  const both = verify(dir, base, [`--accept-policy-change=${head}`, `--accept-uncovered=${head}`]);
  assert.equal(both.code, 0, JSON.stringify(blocking(both)));
  const acc = findings(both).find((f) => f.code === 'uncovered_accepted' && f.at === c1);
  assert.ok(acc && !acc.blocking, 'shown as a warning');
  assert.match(acc.detail, /^UNPROVEN: src\/math\.js has no packet in commit [0-9a-f]{12}; accepted as a reviewed exception for head [0-9a-f]{12} by maintainer: /);
  assert.deepEqual(both.json.commits.find((c) => c.commit === c1).coverage.accepted.map((a) => a.file), ['src/math.js']);
  assert.match(both.stdout, /UNPROVEN/);
});

test('an approval for another head, another commit or another file waives nothing', () => {
  const { dir, base } = repo();
  write(dir, 'src/math.js', 'export const add = (a, b) => a + b; // tidy\n');
  write(dir, 'src/other.js', 'export const x = 1;\n');
  const c1 = commit(dir, 'no packet');
  const head = listExceptions(dir, [entry(c1, ['src/math.js']), entry(base, ['src/other.js'])]);
  const stale = verify(dir, base, [`--accept-policy-change=${head}`, `--accept-uncovered=${base}`]);
  assert.match(stale.stderr, /approval for .* does not cover/);
  assert.ok(blocking(stale, 'uncovered').length, 'an approval for another head is ignored');
  const v = verify(dir, base, [`--accept-policy-change=${head}`, `--accept-uncovered=${head}`]);
  const u = blocking(v, 'uncovered').find((f) => f.at === c1);
  assert.ok(u, 'src/other.js is listed under the wrong commit, so it still blocks');
  assert.match(u.detail, /src\/other\.js/);
  assert.doesNotMatch(u.detail, /src\/math\.js/, 'the listed file is accepted');
});

test('exceptions name a full commit and exact files, with a reason and a reviewer', () => {
  const { dir, base } = repo();
  write(dir, 'src/math.js', 'export const add = (a, b) => a + b; // tidy\n');
  const c1 = commit(dir, 'no packet');
  const head = listExceptions(dir, [entry(c1.slice(0, 12), ['src/math.js']), entry(c1, ['src/*.js']), entry(c1, ['src/math.js'], { reviewer: '' })]);
  const v = verify(dir, base, [`--accept-policy-change=${head}`, `--accept-uncovered=${head}`]);
  assert.equal(v.code, 1);
  assert.equal(blocking(v, 'invalid_policy').length, 3, JSON.stringify(blocking(v)));
  assert.ok(blocking(v, 'uncovered').length, 'nothing is accepted from an invalid entry');
});

test('accepting missing proof never clears another finding', () => {
  const { dir, base } = repo();
  // No packet, and an existing test is weakened: test_change must still block.
  write(dir, 'test/math.check.mjs', "import { add } from '../src/math.js';\nadd(2, 3);\n");
  const c1 = commit(dir, 'weaken a test with no packet');
  const head = listExceptions(dir, [entry(c1, ['test/math.check.mjs'])]);
  const v = verify(dir, base, [`--accept-policy-change=${head}`, `--accept-uncovered=${head}`]);
  assert.equal(v.code, 1);
  assert.ok(findings(v).some((f) => f.code === 'uncovered_accepted'), 'the missing packet is accepted');
  assert.ok(blocking(v, 'test_change').length, 'the test change still needs its own approval');
});

test('in the net change, an exception counts only for a commit in the range that changed the file', () => {
  // Each commit alone is small; together they cross the broad-change threshold, so the net
  // change needs every file covered.
  const { dir, base } = repo({ triggers: undefined });
  writeRules(dir, { triggers: { broad_files: 4, cross_area: { areas: 9, min_files: 99 }, globs: [] }, requirements: [{ id: 'unit', globs: ['src/**'], obligation: { kind: 'test', run: 'node test/math.check.mjs' }, source: 'author' }] });
  const base2 = commit(dir, 'rules');
  for (const f of ['a', 'b']) write(dir, `lib/${f}.js`, `export const ${f} = 1;\n`);
  const c1 = commit(dir, 'two files');
  for (const f of ['c', 'd', 'e']) write(dir, `lib/${f}.js`, `export const ${f} = 1;\n`);
  const c2 = commit(dir, 'three files');
  const head = listExceptions(dir, [entry(c1, ['lib/a.js', 'lib/b.js']), entry(c2, ['lib/c.js', 'lib/d.js']), entry(c1, ['lib/e.js'])]);
  const v = verify(dir, base2, [`--accept-policy-change=${head}`, `--accept-uncovered=${head}`]);
  const net = v.json.net;
  assert.ok(net, 'a net change was judged');
  const still = blocking(v, 'uncovered').filter((f) => f.at === 'net');
  assert.equal(still.length, 1, JSON.stringify(findings(v)));
  assert.match(still[0].detail, /lib\/e\.js/, 'listed under a commit that did not change it');
  assert.deepEqual((net.coverage.accepted || []).map((a) => a.file).sort(), ['lib/a.js', 'lib/b.js', 'lib/c.js', 'lib/d.js']);
  void base;
});

test('an approval flag this pocp does not know is an error, not silently ignored', () => {
  const { dir, base } = repo();
  const r = pocp(dir, ['verify', `${base}..HEAD`, '--accept-something=abc']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /unknown approval --accept-something: this pocp supports --accept-test-change, --accept-policy-change, --accept-uncovered/);
});
