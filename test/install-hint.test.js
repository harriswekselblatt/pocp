// Install commands people copy into a shell must run as written. An unquoted "#<commit>"
// placeholder is parsed by the shell as a redirection, so the copied command fails.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { INSTALL_HINT, hookBodies } from '../src/init.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = 'github:harriswekselblatt/pocp#COMMIT_SHA';

// Runs one line in sh with npm stubbed to print its arguments, one per line.
function npmArgs(line) {
  const r = spawnSync('sh', ['-c', `npm() { printf '%s\\n' "$@"; }\n${line}`], { encoding: 'utf8' });
  assert.equal(r.status, 0, `"${line}" failed in sh: ${r.stderr}`);
  return r.stdout.trim().split('\n');
}

function installLine(file) {
  const line = fs.readFileSync(path.join(ROOT, file), 'utf8').split('\n').find((l) => /^npm (i|install) /.test(l));
  assert.ok(line, `${file} has an npm install line`);
  return line;
}

test('the install hint pocp prints runs in a shell as copied', () => {
  assert.deepEqual(npmArgs(INSTALL_HINT), ['i', '-D', SOURCE]);
});

test("the install hint survives the hooks' echo unchanged", () => {
  const body = hookBodies(null)['pre-commit'];
  const echo = /pocp_missing\(\) \{ (echo "[^"]*") >&2/.exec(body);
  assert.ok(echo, 'pre-commit has the not-found message');
  const r = spawnSync('sh', ['-c', echo[1]], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes(INSTALL_HINT), r.stdout);
});

// The docs pin the release a reader should install (the hint above stays a commit placeholder).
const RELEASE = 'github:harriswekselblatt/pocp#v1.1.1';

test('the install commands in the README and QUICKSTART run in a shell as copied', () => {
  assert.deepEqual(npmArgs(installLine('README.md')), ['install', '--save-dev', RELEASE]);
  assert.deepEqual(npmArgs(installLine('docs/QUICKSTART.md')), ['install', '-g', RELEASE]);
});
