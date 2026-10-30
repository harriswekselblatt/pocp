// Agent adapters. Every adapter has the same shape, so run.js treats Claude Code, Codex and
// the fake agents used by the tests the same way:
//
//   describe()  → { agent, cli, version, bin }            (once per batch, for the pins)
//   run(ctx)    → { status, exit, signal, duration_s, model_requested, model_used, usage,
//                   cost_usd, turns, settings, error, files }
//
//   ctx = { repo, prompt, runDir, timeoutMs, model, extraEnv }
//
// status is "completed" (the CLI exited 0), "agent-error" (non-zero exit or it reported an
// error) or "timeout". Whatever the agent printed goes to files in runDir.
import fs from 'node:fs';
import path from 'node:path';
import { sha256File, sha256Text } from '../../lib/pins.js';
import { E1_DIR } from '../lib/proc.js';
import { claudeAgent } from './claude.js';
import { codexAgent } from './codex.js';
import { fakeAgent } from './fake.js';

export const PROMPT_FILE = path.join(E1_DIR, 'prompt.md');
// One prompt for every arm and condition. Changing prompt.md means changing this pin too,
// on purpose, in its own commit.
export const PROMPT_SHA256 = 'bc11e8aac2051029168f833973a877e3d40f57337fef6e09ef78af9d9e929ab8';

export function loadPrompt(file = PROMPT_FILE) {
  const sha = sha256File(file);
  if (file === PROMPT_FILE && sha !== PROMPT_SHA256) throw new Error(`prompt.md sha256 is ${sha}, pinned ${PROMPT_SHA256}`);
  const text = fs.readFileSync(file, 'utf8');
  return { text, sha256: sha256Text(text), file };
}

export const DEFAULT_TIMEOUT_S = 15 * 60;

/** "claude", "codex", or "fake:<script.js>" (tests). */
export function getAgent(spec, opts = {}) {
  if (spec === 'claude') return claudeAgent(opts);
  if (spec === 'codex') return codexAgent(opts);
  if (spec.startsWith('fake:')) return fakeAgent(spec.slice(5), opts);
  throw new Error(`unknown agent "${spec}" (claude, codex, or fake:<script>)`);
}

/** Short stable name for records: "claude", "codex", "fake-cheat-test-edit". */
export function agentName(spec) {
  return spec.startsWith('fake:') ? `fake-${path.basename(spec.slice(5)).replace(/\.[^.]+$/, '')}` : spec;
}

export { statusOf } from './common.js';
