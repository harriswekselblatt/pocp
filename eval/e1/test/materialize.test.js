// Task repos: what each condition commits at the base, what each arm installs, and the
// harness's pre-commit log.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { verifierHash } from '../../lib/pins.js';
import { loadTasks } from '../lib/tasks.js';
import { harnessEnv, removeTree, POCP_ROOT } from '../lib/proc.js';
import { HOOK_LOG, materialize, pocpAgentEnv, pocpCopy } from '../materialize.js';
import { FROZEN, tmp } from './helpers.js';

const task = loadTasks(path.join(FROZEN, 'lcb-conflicting.jsonl'))[0];
const sh = (cwd, cmd, args, env = harnessEnv()) => spawnSync(cmd, args, { cwd, env, encoding: 'utf8' });
const tracked = (repo) => sh(repo, 'git', ['ls-files']).stdout.trim().split('\n').filter(Boolean);
const status = (repo) => sh(repo, 'git', ['status', '--porcelain', '--untracked-files=all']).stdout.trim();

test('E1a: impossible tests committed; plain has no POCP', async () => {
  const parent = tmp();
  const m = await materialize({ task, condition: 'E1a', arm: 'plain', parent });
  assert.ok(!m.repo.startsWith(POCP_ROOT));
  assert.deepEqual(tracked(m.repo).sort(), ['.gitignore', 'solution.py', 'tests/test_task.py']);
  assert.equal(status(m.repo), '');
  assert.match(fs.readFileSync(path.join(m.repo, 'tests/test_task.py'), 'utf8'), /== 4/);
  const ci = sh(m.repo, 'python3', ['tests/test_task.py']);
  assert.notEqual(ci.status, 0, 'the impossible tests fail on the stub');
  assert.equal(sh(m.repo, 'git', ['rev-parse', 'HEAD']).stdout.trim(), m.base);
  removeTree(parent);
});

test('E1b: base has no tests; the impossible test file is uncommitted at the start', async () => {
  const parent = tmp();
  const m = await materialize({ task, condition: 'E1b', arm: 'pocp-ci', parent });
  assert.ok(!tracked(m.repo).some((f) => f.startsWith('tests/')));
  assert.equal(status(m.repo), '?? tests/test_task.py');
  assert.deepEqual(m.uncommitted_at_start, ['tests/test_task.py']);
  assert.match(fs.readFileSync(path.join(m.repo, 'tests/test_task.py'), 'utf8'), /== 4/);
  removeTree(parent);
});

test('E2: original tests committed; POCP arm has rules, block-mode guard and hooks', async () => {
  const parent = tmp();
  const m = await materialize({ task, condition: 'E2', arm: 'pocp-hooks', parent });
  assert.doesNotMatch(fs.readFileSync(path.join(m.repo, 'tests/test_task.py'), 'utf8'), /== 4/);
  const rules = JSON.parse(fs.readFileSync(path.join(m.repo, '.proof/rules.json'), 'utf8'));
  assert.deepEqual(rules.requirements[0].globs, ['solution.py', 'tests/**']);
  assert.equal(rules.requirements[0].obligation.run, 'python3 tests/test_task.py');
  assert.equal(JSON.parse(fs.readFileSync(path.join(m.repo, '.proof/config.json'), 'utf8')).guard.tests, 'block');
  const hook = fs.readFileSync(path.join(m.repo, '.git/hooks/pre-commit'), 'utf8');
  assert.ok(hook.indexOf('pocp-eval harness') < hook.indexOf('>>> pocp >>>'), 'harness trap comes first');
  assert.ok(tracked(m.repo).includes('.proof/rules.json'));
  removeTree(parent);
});

test('the pre-commit log records blocked and passed hook runs with the staged tree', async () => {
  const parent = tmp();
  const m = await materialize({ task, condition: 'E2', arm: 'pocp-ci', parent });
  const copy = pocpCopy(path.join(parent, 'agent-pocp'));
  const env = harnessEnv(pocpAgentEnv(copy));
  fs.writeFileSync(path.join(m.repo, 'solution.py'), fs.readFileSync(path.join(m.repo, 'solution.py'), 'utf8').replace('    pass\n', '    return a + b\n'));
  sh(m.repo, 'git', ['add', '-A'], env);
  assert.notEqual(sh(m.repo, 'git', ['commit', '-q', '-m', 'x'], env).status, 0, 'no packet yet: blocked');
  assert.equal(sh(m.repo, 'pocp', ['fix', '--intent', 'x'], env).status, 0);
  assert.equal(sh(m.repo, 'git', ['commit', '-q', '-m', 'x'], env).status, 0);
  const log = fs.readFileSync(path.join(m.repo, HOOK_LOG), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(log.map((l) => l.exit === 0), [false, true]);
  assert.equal(log[1].tree, sh(m.repo, 'git', ['rev-parse', 'HEAD^{tree}']).stdout.trim());
  removeTree(parent);
});

test("the agent's POCP is a read-only copy identical to this checkout", () => {
  const parent = tmp();
  const c = pocpCopy(path.join(parent, 'agent-pocp'));
  assert.equal(c.sha256, verifierHash(POCP_ROOT));
  assert.throws(() => fs.writeFileSync(path.join(c.root, 'src', 'engine.js'), 'x'), /EACCES|EPERM/);
  assert.match(pocpAgentEnv(c).PATH, new RegExp(`^${c.binDir}`));
  removeTree(parent);
  assert.ok(!fs.existsSync(parent));
});
