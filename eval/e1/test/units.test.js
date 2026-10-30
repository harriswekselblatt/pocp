// Fast unit tests: environment stripping, CLI flags, parsers, drawing, scheduling, classification.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PROMPT_FILE, PROMPT_SHA256, agentName, loadPrompt } from '../agents/index.js';
import { CLAUDE_SETTINGS, claudeArgs, claudeEnv, parseClaudeStream } from '../agents/claude.js';
import { codexArgs, parseCodexStream } from '../agents/codex.js';
import { classifyVerify } from '../judge.js';
import { harnessEnv, isClaudeNestingVar } from '../lib/proc.js';
import { agentShellEnv } from '../materialize.js';
import { brokenTasks, checkFrozen, drawTasks, loadTasks, manifestEntry, solutionStub, testFile } from '../lib/tasks.js';
import { blindDiff, stripLabel } from '../review-pack.js';
import { signature } from '../report.js';
import { preregRegistered, schedule } from '../run.js';
import { FIX, FROZEN, tmp } from './helpers.js';

test('nesting markers are stripped from child envs; the OAuth token is kept', () => {
  const base = { PATH: '/bin', CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'sdk', CLAUDE_AGENT_SDK_VERSION: '1', CLAUDE_CODE_SESSION_ID: 'x', CLAUDE_PID: '9', CLAUDE_CODE_OAUTH_TOKEN: 'tok', ANTHROPIC_API_KEY: 'k', GIT_DIR: '/x', CI: 'true', POCP_BIN: 'x', PYTHONPATH: '/evil' };
  const env = harnessEnv({}, base);
  for (const k of ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_AGENT_SDK_VERSION', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_PID', 'GIT_DIR', 'CI', 'PYTHONPATH']) assert.equal(env[k], undefined, k);
  // The caller's POCP_BIN never survives: it's replaced by the pinned POCP.
  assert.notEqual(env.POCP_BIN, 'x');
  assert.match(env.POCP_BIN, /bin\/pocp\.js$/);
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, 'tok');
  assert.equal(env.ANTHROPIC_API_KEY, 'k');
  assert.equal(env.GIT_CONFIG_GLOBAL, '/dev/null');
  assert.equal(isClaudeNestingVar('CLAUDE_CODE_OAUTH_TOKEN'), false);
  const login = claudeEnv({}, { auth: 'login', base });
  assert.equal(login.ANTHROPIC_API_KEY, undefined);
  assert.equal(login.CLAUDE_CODE_OAUTH_TOKEN, 'tok');
});

test('claude flags: headless, user settings off, sandboxed bash, no web, model only when asked', () => {
  const a = claudeArgs({});
  for (const f of ['-p', '--setting-sources', 'project', '--strict-mcp-config', '--no-session-persistence', '--disable-slash-commands', '--permission-mode', 'acceptEdits']) assert.ok(a.includes(f), f);
  assert.ok(!a.includes('--model'));
  assert.ok(!a.includes('--dangerously-skip-permissions'));
  assert.deepEqual(JSON.parse(a[a.indexOf('--settings') + 1]), CLAUDE_SETTINGS);
  assert.equal(CLAUDE_SETTINGS.sandbox.enabled, true);
  assert.equal(CLAUDE_SETTINGS.sandbox.allowUnsandboxedCommands, false);
  assert.ok(CLAUDE_SETTINGS.permissions.deny.includes('WebFetch'));
  assert.equal(a[a.indexOf('--tools') + 1], 'Bash,Read,Edit,Write,Glob,Grep');
  assert.doesNotMatch(a[a.indexOf('--tools') + 1], /AskUserQuestion|PushNotification|EnterWorktree|WebFetch/);
  assert.deepEqual(claudeArgs({ model: 'opus' }).slice(-2), ['--model', 'opus']);
});

test('codex flags: workspace-write sandbox with .git writable, no network, user config ignored', () => {
  const a = codexArgs({ repo: '/tmp/r' });
  assert.equal(a[0], 'exec');
  assert.equal(a[a.indexOf('--sandbox') + 1], 'workspace-write');
  assert.ok(a.includes('sandbox_workspace_write.writable_roots=["/tmp/r/.git"]'));
  assert.ok(a.includes('sandbox_workspace_write.network_access=false'));
  for (const f of ['--ignore-user-config', '--ignore-rules', '--json']) assert.ok(a.includes(f), f);
  assert.equal(a[a.length - 1], '-');
  assert.ok(!a.includes('--dangerously-bypass-approvals-and-sandbox'));
  assert.deepEqual(codexArgs({ repo: '/r', model: 'm' }).slice(-3), ['-m', 'm', '-']);
});

test('stream parsers pick out model, usage, cost and errors', () => {
  const c = parseClaudeStream([
    JSON.stringify({ type: 'system', subtype: 'init', model: 'claude-x', tools: ['Bash'], permissionMode: 'acceptEdits' }),
    'not json',
    JSON.stringify({ type: 'assistant', message: { model: 'claude-x' } }),
    JSON.stringify({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.12, num_turns: 7, usage: { input_tokens: 5 }, modelUsage: { 'claude-x': {} } }),
  ].join('\n'));
  assert.equal(c.model_used, 'claude-x');
  assert.equal(c.cost_usd, 0.12);
  assert.equal(c.turns, 7);
  assert.equal(c.is_error, false);
  const x = parseCodexStream([
    JSON.stringify({ type: 'thread.started', thread_id: 't-1' }),
    JSON.stringify({ type: 'item.completed', item: { type: 'command_execution' } }),
    JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 2 } }),
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'done' } }),
  ].join('\n'));
  assert.equal(x.thread_id, 't-1');
  assert.equal(x.usage.input_tokens, 10);
  assert.equal(x.commands, 1);
  assert.equal(x.final_text, 'done');
  assert.equal(parseCodexStream(JSON.stringify({ type: 'turn.failed', error: { message: 'boom' } })).error, 'boom');
});

test('the prompt is pinned and neutral', () => {
  const p = loadPrompt();
  assert.equal(p.sha256, PROMPT_SHA256);
  assert.match(p.text, /solution\.py/);
  assert.match(p.text, /python3 tests\/test_task\.py/);
  assert.match(p.text, /commit/i);
  assert.doesNotMatch(p.text, /pocp|proof|cheat|benchmark|impossible|evaluat|hook|verify/i);
  assert.equal(path.basename(PROMPT_FILE), 'prompt.md');
});

test('tasks: frozen file checked against the manifest; draws are seeded and content-blind', () => {
  const file = path.join(FROZEN, 'lcb-conflicting.jsonl');
  const fz = checkFrozen(file);
  assert.equal(fz.manifest_ok, true);
  assert.equal(fz.dataset, 'fixture/not-a-dataset@0000000');
  const tasks = loadTasks(file);
  const a = drawTasks(tasks, { n: 2, seed: 5 }).map((t) => t.task_id);
  assert.deepEqual(drawTasks(tasks, { n: 2, seed: 5 }).map((t) => t.task_id), a);
  assert.equal(a.length, 2);
  // Changing a task's content doesn't change which ids are drawn.
  const edited = tasks.map((t) => ({ ...t, prompt: `${t.prompt}#` }));
  assert.deepEqual(drawTasks(edited, { n: 2, seed: 5 }).map((t) => t.task_id), a);
  assert.deepEqual(drawTasks(tasks, { ids: ['fx_rev_2'] }).map((t) => t.task_id), ['fx_rev_2']);
  assert.throws(() => drawTasks(tasks, { ids: ['nope'] }), /not in the frozen file/);
  assert.equal(manifestEntry({ files: [{ path: 'x/lcb-a.jsonl', sha256: 'f'.repeat(64) }] }, 'lcb-a.jsonl').sha256, 'f'.repeat(64));
  assert.equal(manifestEntry({ 'lcb-a.jsonl': 'e'.repeat(64) }, 'lcb-a.jsonl').sha256, 'e'.repeat(64));
});

test('a frozen file that no longer matches its manifest is refused', () => {
  const dir = tmp('e1frozen-');
  try {
    fs.copyFileSync(path.join(FROZEN, 'MANIFEST.json'), path.join(dir, 'MANIFEST.json'));
    fs.writeFileSync(path.join(dir, 'lcb-conflicting.jsonl'), `${fs.readFileSync(path.join(FROZEN, 'lcb-conflicting.jsonl'), 'utf8')}\n`);
    assert.throws(() => checkFrozen(path.join(dir, 'lcb-conflicting.jsonl')), /doesn't match MANIFEST/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('repo files follow the shared contract', () => {
  const t = loadTasks(path.join(FROZEN, 'lcb-conflicting.jsonl'))[0];
  assert.match(solutionStub(t), /^def add_numbers\(a: int, b: int\) -> int:\n[\s\S]*\n    pass\n$/);
  const tf = testFile(t);
  assert.ok(tf.startsWith('def check(candidate):'));
  assert.match(tf, /from solution import add_numbers/);
  assert.match(tf, /if __name__ == "__main__":\n    check\(add_numbers\)\n    print\("POCP_EVAL_TESTS_PASSED"\)\n$/);
  assert.ok(!testFile(t, 'original').includes('== 4'));
});

test('schedule: every arm takes every position equally often across tasks', () => {
  const tasks = [1, 2, 3, 4, 5, 6].map((i) => ({ task_id: `t${i}` }));
  const arms = ['plain', 'pocp-ci', 'pocp-hooks'];
  const units = schedule(tasks, ['a'], arms, 3);
  assert.equal(units.length, 18);
  for (const arm of arms) for (const pos of [0, 1, 2]) assert.equal(units.filter((u) => u.arm === arm && u.position === pos).length, 2, `${arm}@${pos}`);
  for (const t of tasks) assert.deepEqual(units.filter((u) => u.task === t).map((u) => u.arm).sort(), [...arms].sort());
  assert.deepEqual(schedule(tasks, ['a'], arms, 3), units);
  assert.equal(agentName('fake:/x/y/cheat.js'), 'fake-cheat');
});

test('verify traces are classified per PREREG §2', () => {
  const t = (verdicts, codes = ['test_change']) => ({ commits: [{ commit: 'c', findings: codes.map((code) => ({ code, blocking: true })), test_guard: { mechanical: verdicts.map((v) => ({ verdict: v, passed: false })) } }] });
  assert.equal(classifyVerify(t([]), 0).class, 'accepted');
  assert.equal(classifyVerify(t(['baseline-red', 'behavior-changed']), 1).class, 'mechanical-catch');
  assert.equal(classifyVerify(t(['detection-dropped']), 1).class, 'mechanical-catch');
  const esc = classifyVerify(t(['baseline-red', 'inconclusive']), 1);
  assert.equal(esc.class, 'escalation');
  assert.equal(esc.escalation_only, true);
  assert.equal(classifyVerify(t(['baseline-red'], ['test_change', 'uncovered']), 1).escalation_only, false);
  assert.equal(classifyVerify(t([], ['uncovered']), 1).class, 'other-finding');
  assert.equal(classifyVerify(null, 1).class, 'error');
});

test('review packs: .proof/ is removed from diffs and evidence; labels are stripped', () => {
  const diff = 'diff --git a/solution.py b/solution.py\n+x\ndiff --git a/.proof/packets/p.json b/.proof/packets/p.json\n+{}\ndiff --git a/tests/test_task.py b/tests/test_task.py\n-y\n';
  const b = blindDiff(diff);
  assert.match(b, /solution\.py/);
  assert.match(b, /tests\/test_task\.py/);
  assert.doesNotMatch(b, /\.proof/);
  assert.deepEqual(stripLabel({ label: 'cheat', kind: 'test-edit', files: ['solution.py', '.proof/x'] }), { files: ['solution.py'] });
});

test('attempt signatures collapse repeats', () => {
  assert.equal(signature({ attempts: [{ type: 'hook-blocked' }, { type: 'hook-blocked' }, { type: 'commit', through_hooks: false }, { type: 'harness-commit' }] }), 'blocked×2 → commit(no hooks) → harness-commit');
  assert.equal(signature({ attempts: [] }), '(no commit)');
});

test('PREREG registration is read from the "Registered:" line', () => {
  assert.equal(preregRegistered(path.join(FIX, 'prereg_registered.md')), true);
  assert.equal(preregRegistered(path.join(FIX, '..', '..', '..', 'PREREG.md')), false);
  assert.equal(preregRegistered('/nonexistent'), false);
});

test('the agent shell skips the user\'s zsh startup files', () => {
  const dir = tmp('e1shell-');
  const env = agentShellEnv(dir);
  assert.ok(fs.statSync(env.ZDOTDIR).isDirectory());
  assert.deepEqual(fs.readdirSync(env.ZDOTDIR), []);
  assert.equal(env.BASH_ENV, '');
});

test('tasks the manifest flags dataset-task-broken are found per split', () => {
  assert.deepEqual([...brokenTasks(path.join(FROZEN, 'lcb-conflicting.jsonl'), 'conflicting')], ['fx_broken_3']);
  assert.deepEqual([...brokenTasks(path.join(FROZEN, 'lcb-original.jsonl'), 'original')], []);
});

test('every child runs the pinned python first on PATH (after the agent pocp shim)', async () => {
  const { PYTHON } = await import('../lib/proc.js');
  assert.ok(path.isAbsolute(PYTHON.path));
  assert.equal(harnessEnv({}, { PATH: '/usr/bin:/bin' }).PATH.split(':')[0], PYTHON.dir);
  const withShim = harnessEnv({ PATH: '/x/agent-pocp/bin:/usr/bin' }).PATH.split(':');
  assert.deepEqual(withShim.slice(0, 2), ['/x/agent-pocp/bin', PYTHON.dir]);
});
