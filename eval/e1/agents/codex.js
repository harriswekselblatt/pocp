// Codex CLI, headless (`codex exec`), in the task repo.
//
//   - --sandbox workspace-write: an OS sandbox (macOS seatbelt). Commands write only inside the
//     repo (and temp folders) and get no network. Codex keeps .git read-only by default, which
//     would stop the agent committing at all, so the repo's .git is added as a writable root.
//   - --ignore-user-config, --ignore-rules: the user's config.toml and execpolicy rules don't
//     apply (auth still comes from CODEX_HOME). approval_policy "never": nothing waits on a person.
//   - Not --ephemeral: the session file is the only place Codex records the model it used, so
//     the harness finds it by thread id and copies it into the run folder.
// Codex reports token usage but no dollar cost.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { harnessEnv, run } from '../lib/proc.js';
import { statusOf } from './common.js';

export const APP_BIN = '/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex';

export function codexBin(env = process.env) {
  if (env.E1_CODEX_BIN) return env.E1_CODEX_BIN;
  return fs.existsSync(APP_BIN) ? APP_BIN : 'codex';
}

export function codexArgs({ repo, model }) {
  const args = ['exec', '--json',
    '--sandbox', 'workspace-write',
    '-c', `sandbox_workspace_write.writable_roots=${JSON.stringify([path.join(repo, '.git')])}`,
    '-c', 'sandbox_workspace_write.network_access=false',
    '-c', 'approval_policy="never"',
    '--skip-git-repo-check', '--ignore-user-config', '--ignore-rules',
    '--color', 'never',
    '-C', repo];
  if (model) args.push('-m', model);
  args.push('-'); // the prompt comes on stdin
  return args;
}

/** Read the --json event stream: thread id, usage, failures, commands run. */
export function parseCodexStream(text = '') {
  let threadId = null;
  let error = null;
  let lastMessage = null;
  const usage = { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0 };
  let sawUsage = false;
  let commands = 0;
  let model = null;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (o.type === 'thread.started') threadId = o.thread_id || threadId;
    else if (o.type === 'turn.completed' && o.usage) {
      sawUsage = true;
      for (const k of Object.keys(usage)) usage[k] += Number(o.usage[k] || 0);
    } else if (o.type === 'turn.failed') error = o.error?.message || 'turn failed';
    else if (o.type === 'error') error = o.message || 'codex error';
    else if (o.type === 'item.completed' && o.item?.type === 'agent_message') lastMessage = o.item.text;
    else if (o.type === 'item.completed' && o.item?.type === 'command_execution') commands++;
    if (o.model && !model) model = o.model;
  }
  return { thread_id: threadId, error, usage: sawUsage ? usage : null, final_text: lastMessage ? String(lastMessage).slice(0, 4000) : null, commands, model };
}

/** The session file Codex wrote for this thread (searched newest-first, bounded). */
export function findSession(threadId, home = process.env.CODEX_HOME || path.join(os.homedir(), '.codex')) {
  if (!threadId) return null;
  const root = path.join(home, 'sessions');
  if (!fs.existsSync(root)) return null;
  const dirs = (p) => (fs.existsSync(p) ? fs.readdirSync(p).sort().reverse() : []);
  let looked = 0;
  for (const y of dirs(root)) for (const m of dirs(path.join(root, y))) for (const d of dirs(path.join(root, y, m))) {
    if (++looked > 5) return null; // only the last few days
    const dir = path.join(root, y, m, d);
    const hit = dirs(dir).find((f) => f.includes(threadId));
    if (hit) return path.join(dir, hit);
  }
  return null;
}

/** The model (and effort) from a session file's turn context. */
export function sessionModel(file) {
  if (!file || !fs.existsSync(file)) return { model: null, effort: null };
  let model = null;
  let effort = null;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.includes('model')) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    const p = o.payload || o;
    if (p.model && !model) model = p.model;
    if ((p.effort || p.reasoning_effort) && !effort) effort = p.effort || p.reasoning_effort;
    if (model && effort) break;
  }
  return { model, effort };
}

export function codexAgent({ bin = codexBin() } = {}) {
  return {
    name: 'codex',
    async describe() {
      const v = await run(bin, ['--version'], { env: harnessEnv(), timeoutMs: 30_000 });
      return { agent: 'codex', cli: 'codex', bin, version: v.code === 0 ? v.out.trim() : null };
    },
    async run({ repo, prompt, runDir, timeoutMs, model, extraEnv = {} }) {
      const env = harnessEnv(extraEnv);
      const args = codexArgs({ repo, model });
      const files = { transcript: 'agent.stdout.jsonl', stderr: 'agent.stderr.txt' };
      const r = await run(bin, args, { cwd: repo, env, input: prompt, timeoutMs, stdoutFile: path.join(runDir, files.transcript), stderrFile: path.join(runDir, files.stderr) });
      const out = fs.existsSync(path.join(runDir, files.transcript)) ? fs.readFileSync(path.join(runDir, files.transcript), 'utf8') : '';
      const parsed = parseCodexStream(out);
      const session = findSession(parsed.thread_id);
      if (session) {
        files.session = 'agent.session.jsonl';
        fs.copyFileSync(session, path.join(runDir, files.session));
      }
      const sm = sessionModel(session);
      return {
        status: statusOf(r, parsed.error),
        exit: r.code,
        signal: r.signal,
        duration_s: r.ms / 1000,
        model_requested: model || null,
        model_used: sm.model || parsed.model || null,
        reasoning_effort: sm.effort,
        usage: parsed.usage,
        cost_usd: null,
        turns: null,
        commands_run: parsed.commands,
        thread_id: parsed.thread_id,
        settings: {
          argv: args,
          sandbox: 'workspace-write (+ .git writable), network off for commands',
          network: 'commands have no network (Codex sandbox); the CLI itself reaches the model API',
        },
        error: parsed.error || (r.code !== 0 ? (r.err || '').slice(-1000) : null),
        final_text: parsed.final_text,
        files,
      };
    },
  };
}
