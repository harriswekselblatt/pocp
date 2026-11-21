// PREREG §11: Codex runs with a fresh CODEX_HOME holding only auth.json, so the host's global
// AGENTS.md never reaches the agent; a counted batch is refused if an agent would read one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { closeIsolatedHome, codexAgent, codexInstructions, isolatedHome } from '../agents/codex.js';
import { Refusal, runBatch } from '../run.js';
import { FIX, FROZEN, STUB_CHECK, tmp } from './helpers.js';

function hostHome(agentsMd) {
  const home = tmp();
  fs.writeFileSync(path.join(home, 'auth.json'), '{"token":"old"}');
  fs.writeFileSync(path.join(home, 'AGENTS.md'), agentsMd);
  return home;
}

test('codexInstructions lists only non-empty instruction files', () => {
  assert.deepEqual(codexInstructions(hostHome('')), []);
  assert.deepEqual(codexInstructions(hostHome('  \n')), []);
  assert.deepEqual(codexInstructions(hostHome('Read my notes first.')), ['AGENTS.md']);
});

test('the isolated home holds only auth.json; a refreshed login is carried back, then removed', () => {
  const host = hostHome('Read my notes first.');
  const iso = isolatedHome(host);
  assert.deepEqual(fs.readdirSync(iso.dir), ['auth.json']);
  assert.deepEqual(codexInstructions(iso.dir), []);
  fs.writeFileSync(path.join(iso.dir, 'auth.json'), '{"token":"new"}');
  closeIsolatedHome(iso);
  assert.equal(fs.readFileSync(path.join(host, 'auth.json'), 'utf8'), '{"token":"new"}');
  assert.ok(!fs.existsSync(iso.dir));
  // The host's login changed meanwhile: it is left alone.
  const iso2 = isolatedHome(host);
  fs.writeFileSync(path.join(iso2.dir, 'auth.json'), '{"token":"copy"}');
  fs.writeFileSync(path.join(host, 'auth.json'), '{"token":"host"}');
  closeIsolatedHome(iso2);
  assert.equal(fs.readFileSync(path.join(host, 'auth.json'), 'utf8'), '{"token":"host"}');
});

test('a Codex run sees the isolated home, not the host AGENTS.md', async () => {
  const host = hostHome('PRIVATE NOTES');
  const bin = path.join(tmp(), 'codex');
  fs.writeFileSync(bin, `#!/bin/sh
case "$1" in --version) echo "codex-cli 0.0.0"; exit 0;; esac
cat >/dev/null
msg="home=$( [ "$CODEX_HOME" = "${host}" ] && echo host || echo other ) agents=$(cat "$CODEX_HOME/AGENTS.md" 2>/dev/null) files=$(ls "$CODEX_HOME" | tr '\\n' ,)"
printf '{"type":"item.completed","item":{"type":"agent_message","text":"%s"}}\\n' "$msg"
`, { mode: 0o755 });
  const saved = process.env.CODEX_HOME;
  process.env.CODEX_HOME = host;
  try {
    const agent = codexAgent({ bin });
    const info = await agent.describe();
    assert.equal(info.home, 'isolated (auth.json only)');
    assert.deepEqual(info.instructions, []);
    const r = await agent.run({ repo: tmp(), prompt: 'x', runDir: tmp(), timeoutMs: 10_000 });
    assert.equal(r.final_text, 'home=other agents= files=auth.json,');
    assert.equal(r.settings.codex_home, 'isolated (auth.json only)');
    const inherited = await codexAgent({ bin, home: 'inherit' }).describe();
    assert.deepEqual(inherited.instructions, ['AGENTS.md']);
  } finally {
    if (saved === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = saved;
  }
});

test('--phase counted is refused when an agent would read the host AGENTS.md', async () => {
  const host = hostHome('PRIVATE NOTES');
  const saved = process.env.CODEX_HOME;
  process.env.CODEX_HOME = host;
  const results = tmp();
  try {
    await assert.rejects(runBatch({
      eval: 'E1a', agents: ['codex'], agentOptions: { codex: { bin: '/nonexistent/codex', home: 'inherit' } },
      arms: ['plain'], taskIds: ['fx_add_0'], frozenDir: FROZEN, reference: STUB_CHECK, timeoutS: 60,
      batch: 'host-agents-md', phase: 'counted', results,
      prereg: path.join(FIX, 'prereg_registered.md'), canaries: path.join(FIX, 'canaries_pass.py'),
    }), (e) => e instanceof Refusal && /codex would read the host's AGENTS\.md/.test(e.message));
    assert.ok(!fs.existsSync(path.join(results, 'E1a')), 'nothing was recorded');
  } finally {
    if (saved === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = saved;
  }
});
