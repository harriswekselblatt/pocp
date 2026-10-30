// Claude Code, headless (`claude -p`), in the task repo.
//
// Isolation, in layers (what each one does and doesn't do is in eval/e1/README.md):
//   - --setting-sources project: the user's ~/.claude settings and hooks don't load (the task
//     repo has no .claude/ folder, so nothing loads). --strict-mcp-config with no config: no
//     MCP servers. --disable-slash-commands: no skills.
//   - --tools: only Bash, Read, Edit, Write, Glob, Grep. Headless runs otherwise also get
//     AskUserQuestion (answered by nobody), PushNotification (reaches the user's devices),
//     EnterWorktree (moves work out of the repo), cron/wakeup, Workflow and subagent tools.
//   - --settings: Claude Code's sandbox on for Bash (macOS seatbelt), no unsandboxed escape,
//     no network allow-list (so commands get no network), file edits auto-accepted only inside
//     the working directory, web tools denied, Claude Code hooks off, auto-memory off.
//   - the environment: nesting markers stripped (else the child refuses to start), the OAuth
//     token kept (else "Not logged in"); git identity and config fixed by the harness.
// The model API traffic comes from the claude process itself, which isn't sandboxed.
import fs from 'node:fs';
import path from 'node:path';
import { harnessEnv, run } from '../lib/proc.js';
import { statusOf } from './common.js';

export const CLAUDE_TOOLS = ['Bash', 'Read', 'Edit', 'Write', 'Glob', 'Grep'];

export const CLAUDE_SETTINGS = {
  permissions: {
    defaultMode: 'acceptEdits',
    allow: CLAUDE_TOOLS,
    deny: ['WebFetch', 'WebSearch'],
  },
  sandbox: {
    enabled: true,
    autoAllowBashIfSandboxed: true,
    allowUnsandboxedCommands: false,
    network: { allowedDomains: [] },
  },
  disableAllHooks: true,
  autoMemoryEnabled: false,
  includeCoAuthoredBy: false,
};

const AUTH_VARS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_OAUTH_TOKEN'];

export function claudeArgs({ model, settings = CLAUDE_SETTINGS, maxBudgetUsd } = {}) {
  const args = ['-p', '--output-format', 'stream-json', '--verbose',
    '--setting-sources', 'project', '--strict-mcp-config', '--no-session-persistence', '--disable-slash-commands',
    '--permission-mode', 'acceptEdits', '--tools', CLAUDE_TOOLS.join(','), '--settings', JSON.stringify(settings),
    '--disallowedTools', 'WebFetch', 'WebSearch'];
  if (model) args.push('--model', model);
  if (maxBudgetUsd) args.push('--max-budget-usd', String(maxBudgetUsd));
  return args;
}

/**
 * The child's environment. `auth: "inherit"` keeps ANTHROPIC_* as the harness has them;
 * `auth: "login"` drops them so the CLI uses the stored login. Only variable names are
 * recorded, never values.
 */
export function claudeEnv(extra = {}, { auth = 'inherit', base = process.env } = {}) {
  const env = harnessEnv(extra, base);
  if (auth === 'login') for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL']) delete env[k];
  return env;
}

/** Read the stream-json transcript: init (model, tools), final result (usage, cost). */
export function parseClaudeStream(text = '') {
  let init = null;
  let result = null;
  const models = new Set();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (o.type === 'system' && o.subtype === 'init') init = o;
    else if (o.type === 'result') result = o;
    else if (o.type === 'assistant' && o.message?.model) models.add(o.message.model);
  }
  const modelUsage = result?.modelUsage || null;
  return {
    model_used: init?.model || [...models][0] || (modelUsage ? Object.keys(modelUsage)[0] : null),
    models_seen: [...new Set([...(init?.model ? [init.model] : []), ...models, ...Object.keys(modelUsage || {})])],
    tools: init?.tools || null,
    permission_mode: init?.permissionMode || null,
    cli_version: init?.claude_code_version || null,
    api_key_source: init?.apiKeySource || null,
    usage: result?.usage || null,
    model_usage: modelUsage,
    cost_usd: result?.total_cost_usd ?? null,
    turns: result?.num_turns ?? null,
    is_error: Boolean(result?.is_error),
    result_subtype: result?.subtype || null,
    final_text: typeof result?.result === 'string' ? result.result.slice(0, 4000) : null,
  };
}

export function redact(text, env) {
  let out = String(text || '');
  for (const k of AUTH_VARS) if (env?.[k] && env[k].length > 8) out = out.split(env[k]).join('[redacted]');
  return out;
}

export function claudeAgent({ bin = process.env.E1_CLAUDE_BIN || 'claude', auth = process.env.E1_CLAUDE_AUTH || 'inherit', maxBudgetUsd = null } = {}) {
  return {
    name: 'claude',
    async describe() {
      const v = await run(bin, ['--version'], { env: claudeEnv({}, { auth }), timeoutMs: 30_000 });
      return { agent: 'claude', cli: 'claude', bin, version: v.code === 0 ? v.out.trim() : null };
    },
    async run({ repo, prompt, runDir, timeoutMs, model, extraEnv = {} }) {
      const env = claudeEnv(extraEnv, { auth });
      const args = claudeArgs({ model, maxBudgetUsd });
      const files = { transcript: 'agent.stdout.jsonl', stderr: 'agent.stderr.txt' };
      const r = await run(bin, args, { cwd: repo, env, input: prompt, timeoutMs, stdoutFile: path.join(runDir, files.transcript), stderrFile: path.join(runDir, files.stderr) });
      // The token could only reach the files through an error message; scrub them anyway.
      for (const f of Object.values(files)) {
        const p = path.join(runDir, f);
        if (fs.existsSync(p)) {
          const t = fs.readFileSync(p, 'utf8');
          const s = redact(t, env);
          if (s !== t) fs.writeFileSync(p, s);
        }
      }
      const parsed = parseClaudeStream(fs.existsSync(path.join(runDir, files.transcript)) ? fs.readFileSync(path.join(runDir, files.transcript), 'utf8') : '');
      return {
        status: statusOf(r, parsed.is_error),
        exit: r.code,
        signal: r.signal,
        duration_s: r.ms / 1000,
        model_requested: model || null,
        model_used: parsed.model_used,
        models_seen: parsed.models_seen,
        usage: parsed.usage,
        model_usage: parsed.model_usage,
        cost_usd: parsed.cost_usd,
        turns: parsed.turns,
        settings: {
          argv: args.map((a) => (a.startsWith('{') ? '<settings json>' : a)),
          settings: CLAUDE_SETTINGS,
          auth,
          auth_env_present: AUTH_VARS.filter((k) => env[k]),
          api_key_source: parsed.api_key_source,
          tools: parsed.tools,
          permission_mode: parsed.permission_mode,
          network: 'Bash sandboxed with an empty network allow-list; WebFetch/WebSearch denied; the CLI itself reaches the model API',
        },
        error: parsed.is_error ? redact(parsed.final_text || parsed.result_subtype, env) : r.code !== 0 ? redact((r.err || '').slice(-1000), env) : null,
        final_text: parsed.final_text,
        files,
      };
    },
  };
}
