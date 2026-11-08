// A check never inherits variables that point git at another repository, index or config.
// Git sets GIT_INDEX_FILE for the commit hooks, so a check run from a hook that makes its own
// temporary repository and runs `git add` would otherwise write into the committer's index.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildEnv, createProcessRunner, isGitRedirectVar } from '../src/runner.js';

const REDIRECT = {
  GIT_DIR: '/elsewhere/.git', GIT_INDEX_FILE: '/elsewhere/.git/index', GIT_WORK_TREE: '/elsewhere',
  GIT_OBJECT_DIRECTORY: '/elsewhere/objects', GIT_ALTERNATE_OBJECT_DIRECTORIES: '/elsewhere/alt',
  GIT_COMMON_DIR: '/elsewhere/.git', GIT_NAMESPACE: 'ns', GIT_PREFIX: 'sub/', GIT_CONFIG: '/elsewhere/config',
  GIT_CONFIG_PARAMETERS: "'core.hooksPath'='/x'", GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'a.b', GIT_CONFIG_VALUE_0: 'c',
  GIT_CONFIG_GLOBAL: '/elsewhere/gitconfig',
};

const saved = {};
function setEnv(vars) {
  for (const [k, v] of Object.entries(vars)) {
    if (!(k in saved)) saved[k] = process.env[k];
    process.env[k] = v;
  }
}
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  for (const k of Object.keys(saved)) delete saved[k];
});

test('inherited git redirection variables are stripped', () => {
  setEnv(REDIRECT);
  const env = buildEnv();
  for (const k of Object.keys(REDIRECT)) assert.equal(env[k], undefined, k);
  assert.ok(env.PATH, 'ordinary variables stay');
});

test('they are stripped after allow and extra too (the final boundary)', () => {
  setEnv(REDIRECT);
  const minimal = buildEnv({ mode: 'minimal', allow: Object.keys(REDIRECT) });
  for (const k of Object.keys(REDIRECT)) assert.equal(minimal[k], undefined, k);
  const extra = buildEnv({ extra: { GIT_DIR: '/x', GIT_INDEX_FILE: '/y', GIT_CONFIG_COUNT: '2', POCP: '1' } });
  assert.equal(extra.GIT_DIR, undefined);
  assert.equal(extra.GIT_INDEX_FILE, undefined);
  assert.equal(extra.GIT_CONFIG_COUNT, undefined);
  assert.equal(extra.POCP, '1');
});

test('non-redirecting git variables are kept', () => {
  assert.equal(isGitRedirectVar('GIT_AUTHOR_NAME'), false);
  assert.equal(isGitRedirectVar('GIT_TERMINAL_PROMPT'), false);
  assert.equal(isGitRedirectVar('GIT_CONFIG_NOSYSTEM'), true);
});

test("a check that runs git in its own temporary repo leaves the committer's index alone", async () => {
  const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pocp-gitenv-')));
  try {
    const outer = path.join(work, 'outer');
    fs.mkdirSync(outer);
    const g = (cwd, ...args) => execFileSync('git', args, { cwd, stdio: 'pipe' });
    g(outer, 'init', '-q');
    fs.writeFileSync(path.join(outer, 'a.txt'), 'a\n');
    g(outer, 'add', 'a.txt');
    const index = path.join(outer, '.git', 'index');
    const before = fs.readFileSync(index);
    // As in a pre-commit hook.
    setEnv({ GIT_INDEX_FILE: index, GIT_DIR: path.join(outer, '.git') });
    const inner = path.join(work, 'inner');
    fs.mkdirSync(inner);
    const r = await createProcessRunner().run('git init -q && echo x > b.txt && git add b.txt && git ls-files', { cwd: inner, env: buildEnv({ extra: { POCP: '1' } }), timeoutMs: 30_000 });
    assert.equal(r.exit, 0, r.output);
    assert.match(r.output, /b\.txt/);
    assert.ok(fs.existsSync(path.join(inner, '.git', 'index')), 'the check used its own index');
    assert.deepEqual(fs.readFileSync(index), before, "the committer's index is unchanged");
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
});
