// Fake agents for the tests: a Node script run in the task repo with the same environment
// a real agent gets (pocp on PATH in POCP arms). It reads the prompt on stdin. No model calls.
import path from 'node:path';
import { sha256File } from '../../lib/pins.js';
import { harnessEnv, run } from '../lib/proc.js';
import { statusOf } from './common.js';

export function fakeAgent(script, { modelName = 'fake-model' } = {}) {
  const file = path.resolve(script);
  return {
    name: `fake-${path.basename(file).replace(/\.[^.]+$/, '')}`,
    async describe() {
      return { agent: this.name, cli: 'fake', bin: file, version: sha256File(file).slice(0, 12) };
    },
    async run({ repo, prompt, runDir, timeoutMs, model, extraEnv = {} }) {
      const env = harnessEnv(extraEnv);
      const files = { transcript: 'agent.stdout.jsonl', stderr: 'agent.stderr.txt' };
      const r = await run(process.execPath, [file], { cwd: repo, env, input: prompt, timeoutMs, stdoutFile: path.join(runDir, files.transcript), stderrFile: path.join(runDir, files.stderr) });
      return {
        status: statusOf(r, false),
        exit: r.code,
        signal: r.signal,
        duration_s: r.ms / 1000,
        model_requested: model || null,
        model_used: model || modelName,
        usage: null,
        cost_usd: null,
        turns: null,
        settings: { argv: [file] },
        error: r.code !== 0 ? (r.err || '').slice(-500) : null,
        files,
      };
    },
  };
}
