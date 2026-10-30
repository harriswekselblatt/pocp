#!/usr/bin/env node
// Example agent hook (Claude Code PreToolUse). Two checks:
//   - before a file edit: does this file need an open packet first?  (pocp check-edit)
//   - before `git commit`: would the gate pass?                       (pocp gate)
// Exit code 2 blocks the tool call and shows stderr to the agent.
import { spawnSync } from 'node:child_process';

let input = '';
for await (const chunk of process.stdin) input += chunk;
const event = JSON.parse(input || '{}');
const tool = event.tool_name;
const args = event.tool_input || {};

function pocp(cmd) {
  const r = spawnSync('pocp', cmd, { encoding: 'utf8', cwd: event.cwd || process.cwd() });
  return { code: r.status, text: `${r.stdout || ''}${r.stderr || ''}`.trim() };
}

if (['Edit', 'Write', 'MultiEdit'].includes(tool) && args.file_path) {
  const root = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).stdout.trim();
  const rel = args.file_path.startsWith(`${root}/`) ? args.file_path.slice(root.length + 1) : args.file_path;
  const r = pocp(['check-edit', rel]);
  if (r.code === 1) {
    process.stderr.write(`${r.text}\nOpen a packet that states the intent and how you'll prove it, then edit.\n`);
    process.exit(2);
  }
}

if (tool === 'Bash' && /\bgit\s+commit\b/.test(args.command || '') && !/--no-verify/.test(args.command || '')) {
  const r = pocp(['gate']);
  if (r.code !== 0) {
    process.stderr.write(`${r.text}\n`);
    process.exit(2);
  }
}
