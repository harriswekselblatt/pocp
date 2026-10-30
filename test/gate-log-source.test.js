// Every gate log line says where it came from, so commit attempts (hook) can be told apart
// from manual gate runs, pocp fix's rounds and library calls.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { git, pocp, sampleRepo, sh, write, writeRules } from './helpers.js';
import { createPocp } from '../src/engine.js';
import { computeMetrics } from '../src/metrics.js';

const logOf = (dir) => {
  const f = path.join(dir, '.proof', 'runs', 'gate.jsonl');
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
};
const sources = (dir) => logOf(dir).map((e) => e.source);
const touchMath = (dir) => {
  write(dir, 'src/math.js', 'export function add(a, b) {\n  return b + a;\n}\n\nexport function isPositive(n) {\n  return n > 0;\n}\n');
  git(dir, 'add', '-A');
};

test('pocp gate run by hand logs source "gate"', () => {
  const dir = sampleRepo();
  touchMath(dir);
  assert.equal(pocp(dir, ['gate']).code, 1);
  assert.deepEqual(sources(dir), ['gate']);
});

test('the pre-commit hook logs source "hook", once per commit attempt', () => {
  const dir = sampleRepo({ hooks: true });
  touchMath(dir);
  assert.notEqual(sh(dir, 'git', ['commit', '-m', 'blocked'], { allowFail: true }).status, 0);
  assert.notEqual(sh(dir, 'git', ['commit', '-m', 'blocked again'], { allowFail: true }).status, 0);
  assert.deepEqual(sources(dir), ['hook', 'hook']);
  assert.deepEqual(logOf(dir).map((e) => e.decision), ['blocked', 'blocked']);
});

test('pocp fix logs source "fix" for each of its gate rounds', () => {
  const dir = sampleRepo();
  touchMath(dir);
  const r = pocp(dir, ['fix', '--intent', 'swap add operands']);
  assert.equal(r.code, 0, r.stderr);
  const s = sources(dir);
  assert.ok(s.length >= 2, `fix evaluates the gate before and after (${s})`);
  assert.deepEqual([...new Set(s)], ['fix']);
});

test('a library caller of engine.gate() logs source "api", or what it passes', async () => {
  const dir = sampleRepo();
  touchMath(dir);
  const engine = createPocp({ cwd: dir });
  await engine.gate();
  await engine.gate({ source: 'my-tool' });
  assert.deepEqual(sources(dir), ['api', 'my-tool']);
});

test('POCP_GATE_SOURCE reaches pocp gate but not the checks it runs', () => {
  const dir = sampleRepo();
  writeRules(dir, {
    triggers: { broad_files: 6, cross_area: { areas: 3, min_files: 4 }, globs: [] },
    requirements: [{ id: 'env', glob: 'src/**', obligation: { kind: 'test', run: 'test -z "$POCP_GATE_SOURCE"' }, source: 'author' }],
  });
  git(dir, '-c', 'core.hooksPath=/dev/null', 'commit', '-qam', 'env rule');
  touchMath(dir);
  assert.equal(pocp(dir, ['open', '--intent', 'swap', '--touch', 'src/math.js']).code, 0);
  git(dir, 'add', '-A');
  const g = pocp(dir, ['gate', '--prove'], { env: { POCP_GATE_SOURCE: 'hook' } });
  assert.equal(g.code, 0, g.stdout + g.stderr);
  assert.deepEqual(sources(dir), ['hook']);
});

test('metrics split the gate log by source; old lines without one are unknown', () => {
  const at = '2026-10-01T00:00:00Z';
  const m = computeMetrics({
    gateLog: [
      { at, subject: 'a', decision: 'blocked', uncovered: 1 },
      { at, source: 'hook', subject: 'a', decision: 'blocked', uncovered: 1 },
      { at, source: 'hook', subject: 'b', decision: 'pass' },
      { at, source: 'fix', subject: 'a', decision: 'blocked', uncovered: 1 },
    ],
  });
  assert.deepEqual(m.gate.by_source, {
    unknown: { evaluations: 1, blocks: 1 },
    hook: { evaluations: 2, blocks: 1 },
    fix: { evaluations: 1, blocks: 1 },
  });
  assert.equal(m.gate.evaluations, 4);
});
