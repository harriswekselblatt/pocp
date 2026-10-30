// One rule for rules-based coverage, per commit and in the net change: a file is judged where it
// changed, by the policy in force at that commit. A rule added inside the range applies from its
// own commit on; files no per-commit check saw (merge content) are judged by the tip's policy.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { git, pocp, tmpRepo, write, writeRules } from './helpers.js';

const noHooks = ['-c', 'core.hooksPath=/dev/null'];
const commit = (dir, msg) => { git(dir, 'add', '-A'); git(dir, ...noHooks, 'commit', '-q', '-m', msg); };
const unit = { id: 'unit', globs: ['src/**'], obligation: { kind: 'test', run: 'node -e 0' }, source: 'author' };
const docs = { id: 'docs', globs: ['docs/**'], obligation: { kind: 'test', run: 'node -e 0' }, source: 'author' };

test('a rule added inside a range is not applied back to files changed before it, in the net change too', () => {
  const dir = tmpRepo();
  write(dir, 'src/a.js', 'export const a = 1;\n');
  pocp(dir, ['init']);
  writeRules(dir, { requirements: [unit] });
  commit(dir, 'base');
  const base = git(dir, 'rev-parse', 'HEAD');

  write(dir, 'docs/early.js', 'export const early = 1;\n');
  commit(dir, 'docs before any rule covers them');
  writeRules(dir, { requirements: [unit, docs] });
  commit(dir, 'add a rule for docs/');
  write(dir, 'docs/late.js', 'export const late = 1;\n');
  commit(dir, 'docs after the rule, with no packet');
  // A merge whose own commit adds a file: no per-commit check sees merge content.
  git(dir, 'checkout', '-q', '-b', 'side');
  write(dir, 'src/side.txt', 'side\n');
  commit(dir, 'side');
  git(dir, 'checkout', '-q', 'main');
  git(dir, ...noHooks, 'merge', '-q', '--no-ff', '--no-commit', 'side');
  write(dir, 'docs/merged.js', 'export const merged = 1;\n');
  commit(dir, 'merge with an extra file');

  const v = pocp(dir, ['verify', `${base}..HEAD`, '--require-coverage', '--json']);
  const perCommit = (v.json.commits || []).flatMap((c) => c.coverage?.uncovered || []);
  const net = v.json.net?.coverage?.uncovered || [];
  assert.ok(perCommit.includes('docs/late.js'), `changed after the rule: required where it changed (${perCommit})`);
  assert.ok(!perCommit.includes('docs/early.js'), 'changed before the rule: not required where it changed');
  assert.ok(!net.includes('docs/early.js'), `and not required in the net change either (${net})`);
  assert.ok(net.includes('docs/merged.js'), `merge content is still judged by the tip's policy (${net})`);
  assert.ok((v.json.net?.notes || []).some((n) => /policy added inside the range.*docs\/early\.js/.test(n)), 'the net change says why');
});

test("the base's rules still apply in the net change: a range can't drop them", () => {
  const dir = tmpRepo();
  write(dir, 'src/a.js', 'export const a = 1;\n');
  pocp(dir, ['init']);
  writeRules(dir, { requirements: [unit, docs] });
  commit(dir, 'base');
  const base = git(dir, 'rev-parse', 'HEAD');
  writeRules(dir, { requirements: [unit] });
  write(dir, 'docs/x.js', 'export const x = 1;\n');
  commit(dir, 'drop the docs rule and change docs/ in the same commit');
  const v = pocp(dir, ['verify', `${base}..HEAD`, '--require-coverage', '--json']);
  const all = [...(v.json.commits || []).flatMap((c) => c.coverage?.uncovered || []), ...(v.json.net?.coverage?.uncovered || [])];
  assert.ok(all.includes('docs/x.js'), `the base's rule still requires it (${JSON.stringify(all)})`);
});
