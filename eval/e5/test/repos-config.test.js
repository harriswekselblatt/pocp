// Privacy: E5 names no repos of its own beyond this checkout, and anything it's told about is
// private unless explicitly marked public.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_REPOS, reposFromArgs } from '../friction.js';

const none = path.join(os.tmpdir(), 'no-such-e5-config.json');

test('the default is this checkout only, public', () => {
  assert.equal(DEFAULT_REPOS.length, 1);
  assert.equal(DEFAULT_REPOS[0].private, false);
  assert.deepEqual(reposFromArgs([], { configFile: none }), DEFAULT_REPOS);
});

test('--repo entries are private unless marked :public', () => {
  const r = reposFromArgs(['--repo', 'a=/tmp/a', '--repo', 'b=/tmp/b:public'], { configFile: none });
  assert.deepEqual(r.map((x) => [x.alias, x.private]), [['a', true], ['b', false]]);
});

test('a local config file is read, and entries default to private', () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'e5cfg-')), 'repos.local.json');
  fs.writeFileSync(f, JSON.stringify([{ alias: 'x', path: '/tmp/x' }, { alias: 'y', path: '/tmp/y', private: false }]));
  assert.deepEqual(reposFromArgs([], { configFile: f }).map((x) => [x.alias, x.private]), [['x', true], ['y', false]]);
  fs.rmSync(path.dirname(f), { recursive: true, force: true });
});

test('the source has no home folder, and names only this checkout as a default', () => {
  const src = fs.readFileSync(new URL('../friction.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /\/Users\/|\/home\//);
  assert.deepEqual(DEFAULT_REPOS.map((r) => r.alias), ['pocp']);
});
