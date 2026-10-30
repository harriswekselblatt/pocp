// Existing hooks pocp can't safely append to: one that ends in `exec` (the pre-commit
// framework's style) never reached the gate, and one in node or python made pocp's sh block a
// syntax error, so no commit could be made at all. These are chained instead.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { HOOK_BEGIN, HOOK_END } from '../src/init.js';
import { BIN, git, pocp, read, sampleRepo, sh, write } from './helpers.js';

// A required check that can never pass: any commit touching src/ must be blocked.
const FAILING = { requirements: [{ id: 'never', glob: 'src/**', obligation: { kind: 'test', run: 'false' } }] };
const hook = (dir, name) => path.join(dir, '.git', 'hooks', name);
const writeHook = (dir, name, text) => {
  fs.mkdirSync(path.dirname(hook(dir, name)), { recursive: true });
  fs.writeFileSync(hook(dir, name), text);
  fs.chmodSync(hook(dir, name), 0o755);
};
const commitMsg = (dir, msg, args = []) => sh(dir, 'git', ['commit', ...args, '-m', msg], { allowFail: true });
const head = (dir) => git(dir, 'rev-parse', 'HEAD');

// What an older pocp wrote: its block appended to whatever was there.
const OLD_BLOCK = `${HOOK_BEGIN}\n# Installed by pocp. Edit outside these markers; "pocp hooks uninstall" removes this block.\npocp_run() { $POCP_BIN "$@"; }\nexport POCP_GATE_SOURCE=hook\npocp_run gate || exit $?\n${HOOK_END}\n`;
const EXEC_HOOK = '#!/bin/sh\n# like the pre-commit framework\necho original-ran >> .git/original.log\nexec true\n';
const NODE_HOOK = "#!/usr/bin/env node\nrequire('fs').appendFileSync('.git/original.log', 'node-hook-ran\\n');\n";

test('an existing hook that ends in exec: the original runs, then the gate, which now blocks', () => {
  const dir = sampleRepo({ rules: FAILING });
  writeHook(dir, 'pre-commit', EXEC_HOOK);
  const r = pocp(dir, ['hooks', 'install']);
  assert.equal(r.code, 0, r.stderr);

  write(dir, 'src/math.js', read(dir, 'src/math.js').replace('a + b', 'b + a'));
  git(dir, 'add', '-A');
  const before = head(dir);
  const c = commitMsg(dir, 'needs a check that fails');
  assert.notEqual(c.status, 0, 'the gate ran and blocked the commit');
  assert.equal(head(dir), before);
  assert.match(read(dir, '.git/original.log'), /original-ran/, 'the original hook ran first');
  assert.match(r.stdout, /pre-commit: chained/);
  assert.equal(read(dir, '.git/hooks/pre-commit.pre-pocp'), EXEC_HOOK, 'the original is kept as it was');

  // A failing original still blocks, before the gate.
  git(dir, 'reset', '-q', '--hard');
  fs.writeFileSync(hook(dir, 'pre-commit.pre-pocp'), '#!/bin/sh\necho original-says-no >&2\nexit 3\n');
  write(dir, 'README.md', '# docs only\n');
  git(dir, 'add', '-A');
  const f = commitMsg(dir, 'docs');
  assert.equal(f.status, 1);
  assert.match(f.stderr, /original-says-no/);
  assert.equal(head(dir), before);
});

test('existing node hooks: commits still work (with and without --no-verify), and the gate runs', () => {
  const dir = sampleRepo({ rules: FAILING });
  writeHook(dir, 'pre-commit', NODE_HOOK);
  writeHook(dir, 'prepare-commit-msg', "#!/usr/bin/env node\nconst fs = require('fs');\nfs.appendFileSync(process.argv[2], '\\nNode-Hook: yes\\n');\n");
  assert.equal(pocp(dir, ['hooks', 'install']).code, 0);

  write(dir, 'README.md', '# docs only\n');
  git(dir, 'add', '-A');
  const ok = commitMsg(dir, 'docs');
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(git(dir, 'log', '-1', '--format=%B'), /Node-Hook: yes/, 'the original prepare-commit-msg ran');
  assert.match(read(dir, '.git/original.log'), /node-hook-ran/);
  assert.match(read(dir, '.proof/runs/gate.jsonl'), /"source":"hook"/, 'the gate ran from the hook');

  write(dir, 'README.md', '# docs again\n');
  git(dir, 'add', '-A');
  assert.equal(commitMsg(dir, 'skip', ['--no-verify']).status, 0, '--no-verify still commits (prepare-commit-msg runs under it)');

  write(dir, 'src/math.js', read(dir, 'src/math.js').replace('a + b', 'b + a'));
  git(dir, 'add', '-A');
  const before = head(dir);
  assert.notEqual(commitMsg(dir, 'risky').status, 0, 'the gate blocks a change whose check fails');
  assert.equal(head(dir), before);
});

test('reinstalling is idempotent and uninstall puts the original hooks back', () => {
  const dir = sampleRepo();
  writeHook(dir, 'pre-commit', EXEC_HOOK);
  writeHook(dir, 'post-commit', NODE_HOOK);
  fs.chmodSync(hook(dir, 'post-commit'), 0o750);
  writeHook(dir, 'prepare-commit-msg', '#!/bin/sh\necho plain >/dev/null\n');
  assert.equal(pocp(dir, ['hooks', 'install']).code, 0);
  const once = fs.readFileSync(hook(dir, 'pre-commit'), 'utf8');
  assert.equal(pocp(dir, ['hooks', 'install']).code, 0);
  assert.equal(fs.readFileSync(hook(dir, 'pre-commit'), 'utf8'), once, 'a second install changes nothing');
  assert.equal(read(dir, '.git/hooks/pre-commit.pre-pocp'), EXEC_HOOK, 'and keeps the original');
  assert.match(read(dir, '.git/hooks/prepare-commit-msg'), /echo plain[\s\S]*>>> pocp >>>/, 'a plain sh hook is still appended to');
  assert.equal(pocp(dir, ['hooks', 'status']).code, 0);

  assert.equal(pocp(dir, ['hooks', 'uninstall']).code, 0);
  assert.equal(read(dir, '.git/hooks/pre-commit'), EXEC_HOOK);
  assert.equal(read(dir, '.git/hooks/post-commit'), NODE_HOOK);
  assert.equal(fs.statSync(hook(dir, 'post-commit')).mode & 0o777, 0o750, 'with its mode');
  assert.equal(read(dir, '.git/hooks/prepare-commit-msg'), '#!/bin/sh\necho plain >/dev/null\n');
  assert.ok(!fs.existsSync(hook(dir, 'pre-commit.pre-pocp')));
  assert.ok(!fs.existsSync(hook(dir, 'post-commit.pre-pocp')));
});

test('doctor flags hooks an older pocp appended to a node hook or after exec; install repairs them', () => {
  const dir = sampleRepo();
  pocp(dir, ['hooks', 'install']);
  writeHook(dir, 'pre-commit', `${EXEC_HOOK}${OLD_BLOCK}`);
  writeHook(dir, 'prepare-commit-msg', `${NODE_HOOK}${OLD_BLOCK}`);
  const d = pocp(dir, ['doctor', '--offline', '--json']);
  const hooks = d.json.checks.find((c) => c.id === 'hooks');
  assert.equal(hooks.status, 'problem', JSON.stringify(hooks));
  assert.match(hooks.what, /pre-commit: the existing hook ends by running "exec true" before pocp's block, so pocp never runs/);
  assert.match(hooks.what, /prepare-commit-msg: pocp's sh block was appended to a node hook, so the hook fails/);
  assert.match(hooks.fix, /pocp hooks install/);
  const status = pocp(dir, ['hooks', 'status', '--json']).json;
  assert.equal(status.hooks['pre-commit'], 'never runs');
  assert.equal(status.hooks['prepare-commit-msg'], 'broken');

  assert.equal(pocp(dir, ['hooks', 'install']).code, 0);
  assert.equal(read(dir, '.git/hooks/pre-commit.pre-pocp'), EXEC_HOOK, 'the old block is gone from the original');
  assert.equal(read(dir, '.git/hooks/prepare-commit-msg.pre-pocp'), NODE_HOOK);
  assert.equal(pocp(dir, ['doctor', '--offline', '--json']).json.checks.find((c) => c.id === 'hooks').status, 'ok');
  // The git sample hook's `exec 1>&2` only redirects output: not flagged.
  writeHook(dir, 'post-commit', `#!/bin/sh\nexec 1>&2\n${OLD_BLOCK}`);
  assert.equal(pocp(dir, ['hooks', 'status', '--json']).json.hooks['post-commit'], 'ok');
});

test("the hooks prefer the project's own pocp over one on PATH, and the not-found hint pins a commit", () => {
  const dir = sampleRepo({ hooks: true });
  const fake = path.join(dir, '..', `${path.basename(dir)}-bin`);
  fs.mkdirSync(fake);
  fs.writeFileSync(path.join(fake, 'pocp'), '#!/bin/sh\necho global-pocp-used >&2\nexit 1\n');
  fs.chmodSync(path.join(fake, 'pocp'), 0o755);
  write(dir, 'node_modules/.bin/pocp', `#!/bin/sh\nexec "${process.execPath}" "${BIN}" "$@"\n`);
  fs.chmodSync(path.join(dir, 'node_modules/.bin/pocp'), 0o755);
  write(dir, '.gitignore', 'node_modules/\n');
  write(dir, 'README.md', '# docs only\n');
  git(dir, 'add', '-A');
  const env = { POCP_BIN: '', PATH: `${fake}:${process.env.PATH}` };
  const r = sh(dir, 'git', ['commit', '-m', 'docs'], { env, allowFail: true });
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stderr, /global-pocp-used/);

  const text = read(dir, '.git/hooks/pre-commit');
  assert.match(text, /github:harriswekselblatt\/pocp#<commit>/);
  assert.doesNotMatch(text, /npm i -D pocp\b/);
});
