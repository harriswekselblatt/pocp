// Found by the release check, acting as a new user: a project-local install (the README's way)
// was told to run "pocp fix", which isn't on its PATH; init said "hooks not installed" when they
// were; doctor suggested requiring "verify" even when a reporter sets the "pocp" status.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { localizeCommands } from '../src/cli.js';
import { git, pocp, write } from './helpers.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

test('commands read "npx pocp …" for a project-local install, and nothing else changes', () => {
  assert.equal(localizeCommands('next: pocp fix --intent "x"', true), 'next: npx pocp fix --intent "x"');
  assert.equal(localizeCommands('run "pocp hooks install"', true), 'run "npx pocp hooks install"');
  for (const keep of ['pocp: commit blocked', 'node bin/pocp.js verify', 'add pocp-approve-tests', 'npx pocp fix', 'see POCP docs']) {
    assert.equal(localizeCommands(keep, true), keep, keep);
  }
  assert.equal(localizeCommands('next: pocp fix', false), 'next: pocp fix');
});

test('a blocked commit in a project with POCP in node_modules says "npx pocp fix"', () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pocp-local-')));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 't@example.invalid');
  git(dir, 'config', 'user.name', 't');
  // A project-local install: the package's files under node_modules/pocp.
  const pkg = path.join(dir, 'node_modules', 'pocp');
  for (const sub of ['bin', 'src', 'examples']) fs.cpSync(path.join(ROOT, sub), path.join(pkg, sub), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(pkg, 'package.json'));
  const bin = path.join(pkg, 'bin', 'pocp.js');
  // npm links node_modules/.bin/pocp to the package's bin, which the hooks run first.
  fs.mkdirSync(path.join(dir, 'node_modules', '.bin'));
  fs.symlinkSync('../pocp/bin/pocp.js', path.join(dir, 'node_modules', '.bin', 'pocp'));
  fs.chmodSync(bin, 0o755);
  write(dir, 'src/a.js', 'export const a = 1;\n');
  write(dir, '.gitignore', 'node_modules/\n');
  const init = spawnSync(process.execPath, [bin, 'init', '--hooks'], { cwd: dir, encoding: 'utf8' });
  assert.equal(init.status, 0, init.stderr);
  write(dir, '.proof/rules.json', JSON.stringify({ pocp: 1, requirements: [{ id: 'checks', globs: ['src/**'], obligation: { kind: 'test', run: 'true' } }] }, null, 2));
  git(dir, 'add', '-A');
  git(dir, '-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', 'adopt');
  write(dir, 'src/a.js', 'export const a = 2;\n');
  git(dir, 'add', '-A');
  // As a user's shell would: no POCP_BIN (the test helpers set one for the repo's own pocp).
  const env = { ...process.env };
  delete env.POCP_BIN;
  const c = spawnSync('git', ['commit', '-m', 'change'], { cwd: dir, encoding: 'utf8', env });
  assert.notEqual(c.status, 0, 'the commit is blocked');
  assert.match(c.stderr, /npx pocp fix --intent/);
  assert.doesNotMatch(c.stderr.replace(/npx pocp /g, ''), /(^|\s)pocp fix/m);
  // init again without --hooks: the hooks are there, so it says so.
  const again = spawnSync(process.execPath, [bin, 'init'], { cwd: dir, encoding: 'utf8', env });
  assert.match(again.stdout, /hooks: already installed/);
});

test('doctor suggests requiring "pocp" when a reporter sets the status', () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pocp-doc-')));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 't@example.invalid');
  git(dir, 'config', 'user.name', 't');
  assert.equal(pocp(dir, ['init', '--github', '--pocp-ref', 'v9.9.9']).code, 0);
  git(dir, 'add', '-A');
  git(dir, '-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', 'adopt');
  const r = pocp(dir, ['doctor', '--offline']);
  assert.match(r.stdout, /list "pocp" \(the status the reporter sets\)/);
});
