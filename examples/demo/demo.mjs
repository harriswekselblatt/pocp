#!/usr/bin/env node
// The 60-second demo: an agent breaks the code, then edits the test so it passes again. Plain
// CI goes green. In CI, `pocp verify` runs the old test on the new code and flags it.
//
//   node examples/demo/demo.mjs            # run it in a scratch folder, printing as it goes
//   node examples/demo/demo.mjs --keep     # keep the scratch repository afterwards
//   node examples/demo/demo.mjs --cast f   # also write the session as an asciicast (v2) file
//
// It uses the POCP in this checkout (or POCP_BIN), and needs only Node and git.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN = process.env.POCP_BIN || `node ${path.resolve(HERE, '../../bin/pocp.js')}`;
const args = process.argv.slice(2);
const keep = args.includes('--keep');
const castAt = args.indexOf('--cast');
const castFile = castAt >= 0 ? args[castAt + 1] : null;

const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pocp-demo-')));
const events = [];
let clock = 0;
const emit = (text, pause = 0) => {
  process.stdout.write(text);
  events.push([Number(clock.toFixed(2)), 'o', text.replace(/\n/g, '\r\n')]);
  clock += pause;
};

// Every `pocp` in the demo, typed or run by the hooks, is this checkout's (or POCP_BIN).
const shim = fs.mkdtempSync(path.join(os.tmpdir(), 'pocp-demo-bin-'));
fs.writeFileSync(path.join(shim, 'pocp'), `#!/bin/sh\nexec ${BIN} "$@"\n`, { mode: 0o755 });
const env = { ...process.env, PATH: `${shim}${path.delimiter}${process.env.PATH}`, POCP_BIN: BIN, GIT_AUTHOR_NAME: 'agent', GIT_AUTHOR_EMAIL: 'agent@example.invalid', GIT_COMMITTER_NAME: 'agent', GIT_COMMITTER_EMAIL: 'agent@example.invalid', NO_COLOR: '1' };
delete env.NODE_TEST_CONTEXT; // when run under node --test, let the demo's own tests report normally
function sh(cmd) {
  return spawnSync('sh', ['-c', cmd], { cwd: dir, env, encoding: 'utf8' });
}
const write = (rel, body) => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), body);
};

// What the viewer sees typed, and what actually runs (the `pocp` the viewer sees is this checkout's).
function step(shown, { run = shown, filter = (s) => s, after = 1.2 } = {}) {
  emit('\x1b[1;32m$\x1b[0m ', 0.15);
  for (const ch of shown) emit(ch, 0.035);
  emit('\n', 0.3);
  const r = sh(run);
  const out = filter(`${r.stdout}${r.stderr}`).replace(/\s+$/, '');
  // A \u0000 line is a pause: the line before it gets time to sink in.
  for (const [i, chunk] of out.split('\n\u0000\n').entries()) {
    if (i) clock += 2.2;
    if (chunk) emit(`${chunk}\n`, 0.2);
  }
  clock += after;
  return r;
}
const say = (text, after = 1.0) => { emit(`\x1b[2m# ${text}\x1b[0m\n`, after); };

// A tiny project, already set up with POCP: one function, one test file, one rule.
write('package.json', '{ "type": "module", "scripts": { "test": "node --test" } }\n');
write('src/math.js', 'export const add = (a, b) => a + b;\n');
write('test/math.test.js', [
  "import { test } from 'node:test';",
  "import assert from 'node:assert/strict';",
  "import { add } from '../src/math.js';",
  '',
  "test('adds', () => {",
  '  assert.equal(add(2, 3), 5);',
  '  assert.equal(add(-1, 1), 0);',
  '});',
  '',
].join('\n'));
for (const c of ['git init -q -b main', `${BIN} init --hooks >/dev/null`]) sh(c);
write('.proof/rules.json', `${JSON.stringify({ pocp: 1, requirements: [{ id: 'tests', globs: ['src/**', 'test/**'], obligation: { kind: 'test', run: 'npm test --silent' } }] }, null, 2)}\n`);
sh('git add -A && git commit -qm "start" --no-verify && git switch -qc agent-change');

const quietTest = (s) => {
  const fail = /# fail [1-9]/.test(s);
  const line = s.split('\n').find((l) => /!==/.test(l));
  return fail ? `✗ 1 test failed${line ? `: ${line.trim()}` : ''}` : '✓ 1 test passed';
};

say('An agent rewrites add() and breaks it for negative numbers.', 0.6);
write('src/math.js', 'export const add = (a, b) => Math.abs(a) + b;\n');
step('npm test', { filter: quietTest });
say('The test fails. So the agent edits the test until it passes:', 0.6);
const t = path.join(dir, 'test/math.test.js');
fs.writeFileSync(t, fs.readFileSync(t, 'utf8').replace('add(-1, 1), 0)', 'add(-1, 1), 2)'));
step('git diff test/', { filter: (s) => s.split('\n').filter((l) => /^[-+]\s/.test(l)).join('\n') });
step('npm test', { filter: quietTest });
say('Plain CI runs the current tests on the current code: green.', 0.8);
say('POCP blocks the commit until the change has evidence. The agent runs pocp fix:', 0.6);
step('git add -A && pocp fix --intent "Rewrite add()"', { filter: (s) => s.split('\n')[0] });
step('git commit -qm "Rewrite add()"', { filter: () => '' , after: 0.6 });
say('In CI, POCP re-runs the checks, and runs the OLD test on the NEW code:', 0.6);
const v = step('pocp verify main..HEAD --rerun', {
  filter: (s) => {
    const lines = s.split('\n');
    const head = lines[0];
    const bad = lines.find((l) => /^\s*BAD /.test(l)) || '';
    const why = /the old tests fail on the new code[^;]*/.exec(bad)?.[0] || bad.trim();
    const rerun = lines.find((l) => /rerun passed/.test(l))?.replace(/\s*\(\d+ms\)/, '').trim();
    const next = /next: (.*?)\s+\(needs a person\)/.exec(s)?.[1];
    return [head, '\u0000', rerun && `  ${rerun}   <- the edited test passes`, `  BAD: ${why}`, '       behavior changed, so a person must approve it', next && `  next: ${next}`].filter(Boolean).join('\n');
  },
  after: 3,
});
emit(`\x1b[2m# Merging waits for a maintainer. Exit code ${v.status}.\x1b[0m\n`, 3);

if (castFile) {
  const header = { version: 2, width: 100, height: 30, title: 'POCP: an agent edits a test to pass; POCP flags it' };
  fs.writeFileSync(castFile, `${[JSON.stringify(header), ...events.map((e) => JSON.stringify(e))].join('\n')}\n`);
}
if (keep) console.log(`\n(the repository is at ${dir})`);
else fs.rmSync(dir, { recursive: true, force: true });
fs.rmSync(shim, { recursive: true, force: true });
process.exitCode = v.status === 0 ? 1 : 0; // the demo "passes" when POCP blocks the change
