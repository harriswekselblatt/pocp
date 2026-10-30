import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { git, packetId, pocp, read, sampleRepo, sh, write, writeConfig, writeRules } from './helpers.js';
import { BREAK_ADD, TWEAK_ADD, commit, makeKey } from './fixtures.js';

test('misses: linked by blame, closed only through the ratchet, replay confirms the rule', () => {
  const dir = sampleRepo({ hooks: true });
  // Land a change through POCP so blame can find its packet.
  write(dir, 'src/math.js', TWEAK_ADD.replace('return n > 0;', 'return n >= 0;')); // bug: zero counts as positive
  git(dir, 'add', 'src/math.js');
  const id = packetId(pocp(dir, ['open', '--intent', 'tweak', '--touch', 'src/math.js']).stdout);
  assert.equal(pocp(dir, ['prove', id]).code, 0, 'the existing check misses the zero case');
  commit(dir, 'tweak');
  const escaped = git(dir, 'rev-parse', 'HEAD');

  const rec = pocp(dir, ['miss', 'record', '--description', 'isPositive(0) is true', '--stage', 'production', '--severity', 'high', '--file', 'src/math.js', '--json']);
  assert.equal(rec.code, 0, rec.stderr);
  const miss = rec.json.miss;
  assert.deepEqual(miss.packets, [id], 'linked through the commit trailer');
  assert.equal(miss.stage, 'production');
  assert.match(miss.found_at, /^\d{4}-/);

  const noRule = pocp(dir, ['miss', 'close', miss.id]);
  assert.equal(noRule.code, 1);
  assert.match(noRule.stderr, /ratchet/);

  // The regression check and the rule that requires it.
  write(dir, 'test/zero.check.mjs', "import { isPositive } from '../src/math.js';\nif (isPositive(0)) { console.error('zero is not positive'); process.exit(1); }\n");
  writeRules(dir, {
    requirements: [
      { id: 'math-tests', glob: 'src/**', obligation: { kind: 'test', run: 'node test/math.check.mjs' } },
      { id: 'zero-regression', glob: 'src/math.js', obligation: { kind: 'test', run: 'node test/zero.check.mjs' }, source: `miss:${miss.id}` },
    ],
  });
  // Fix the bug and stage everything.
  write(dir, 'src/math.js', TWEAK_ADD);
  git(dir, 'add', '-A');

  // Replay against a commit where the check would pass must not confirm.
  const notConfirmed = pocp(dir, ['miss', 'close', miss.id, '--replay', 'HEAD~1']);
  assert.equal(notConfirmed.code, 1);
  assert.match(notConfirmed.stderr, /replay did not confirm/);

  const closed = pocp(dir, ['miss', 'close', miss.id, '--fix', 'use > 0', '--replay', escaped, '--json']);
  assert.equal(closed.code, 0, closed.stdout + closed.stderr);
  assert.equal(closed.json.miss.closed, 'replay-confirmed');
  assert.equal(closed.json.miss.replay.at_escape[0].passed, false);
  assert.equal(closed.json.miss.replay.at_fix[0].passed, true);

  const m = pocp(dir, ['metrics', '--json']);
  assert.equal(m.json.ratchet.misses_closed_replay_confirmed, 1);
  assert.equal(m.json.escaped, 1);
});

test('a miss can close as rule-added without replay, and upgrade later', () => {
  const dir = sampleRepo();
  const rec = pocp(dir, ['miss', 'record', '--description', 'x', '--stage', 'ci', '--file', 'src/math.js', '--json']);
  const id = rec.json.miss.id;
  writeRules(dir, { requirements: [{ id: 'r1', glob: 'src/**', obligation: { kind: 'manual', text: 'look' }, source: `miss:${id}` }] });
  assert.equal(pocp(dir, ['miss', 'close', id]).code, 1, 'manual rules do not satisfy the ratchet');
  writeRules(dir, { requirements: [{ id: 'r1', glob: 'src/**', obligation: { kind: 'test', run: 'node test/math.check.mjs' }, source: `miss:${id}` }] });
  const c = pocp(dir, ['miss', 'close', id, '--json']);
  assert.equal(c.json.miss.closed, 'rule-added');
  assert.equal(pocp(dir, ['miss', 'close', id]).code, 1, 'already closed');
});

test('mutation eval measures how many planted bugs the required checks catch', () => {
  const dir = sampleRepo();
  const r = pocp(dir, ['eval', '--mutants', '6', '--seed', '3', '--json']);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.ok(r.json.total >= 3 && r.json.total <= 6, `planted ${r.json.total}`);
  assert.ok(r.json.caught >= 2, 'add() and isPositive() mutants are caught');
  assert.ok(r.json.mutants.some((m) => m.operator === 'plus' && m.caught));
  assert.ok(r.json.mutants.every((m) => m.file === 'src/math.js'));
  assert.equal(read(dir, 'src/math.js').includes('a + b'), true, 'working folder untouched');
});

test('mutation eval refuses when the baseline check fails', () => {
  const dir = sampleRepo();
  write(dir, 'src/math.js', BREAK_ADD);
  git(dir, 'add', 'src/math.js');
  const r = pocp(dir, ['eval', '--mutants', '2', '--json']);
  assert.equal(r.code, 1);
  assert.match(r.json.error, /baseline failed/);
});

test('mutation eval never mutates test files', () => {
  const dir = sampleRepo({ rules: { requirements: [{ id: 'all', glob: '**/*.mjs', obligation: { kind: 'test', run: 'node test/math.check.mjs' } }, { id: 'src', glob: 'src/**', obligation: { kind: 'test', run: 'node test/math.check.mjs' } }] } });
  const r = pocp(dir, ['eval', '--mutants', '8', '--json']);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.ok(r.json.mutants.every((m) => !m.file.startsWith('test/')));
});

test('history: gate friction and fix replay from past commits', () => {
  const dir = sampleRepo();
  // A bug lands without a test.
  write(dir, 'src/math.js', TWEAK_ADD.replace('return n > 0;', 'return n >= 0;'));
  git(dir, 'add', '-A');
  git(dir, '-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', 'Tweak isPositive');
  // The fix lands with a regression test that catches it.
  write(dir, 'src/math.js', TWEAK_ADD);
  write(dir, 'test/zero.test.mjs', "import { isPositive } from '../src/math.js';\nif (isPositive(0)) process.exit(1);\n");
  git(dir, 'add', '-A');
  git(dir, '-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', 'Fix isPositive(0) bug');
  // A "fix" whose test does not detect anything.
  write(dir, 'src/math.js', `${TWEAK_ADD}// tidy\n`);
  write(dir, 'test/noop.test.mjs', "import { add } from '../src/math.js';\nif (add(2, 3) !== 5) process.exit(1);\n");
  git(dir, 'add', '-A');
  git(dir, '-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', 'fix typo');

  const r = pocp(dir, ['history', '--commits', '10', '--test', 'for t in {tests}; do node "$t" || exit 1; done', '--json']);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(r.json.gate.commits, 4);
  assert.ok(r.json.gate.would_need_packet >= 3, 'every src change needs a packet under these rules');
  const verdicts = Object.fromEntries(r.json.fixes.results.map((x) => [x.subject, x.verdict]));
  assert.equal(verdicts['Fix isPositive(0) bug'], 'confirmed');
  assert.equal(verdicts['fix typo'], 'does-not-detect');
  assert.equal(r.json.fixes.confirmed, 1);
  assert.equal(git(dir, 'worktree', 'list').split('\n').length, 1, 'temporary checkouts are cleaned up');
});
