// Claude runs on the owner's subscription through a token file; the token never reaches a record.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { claudeEnv, resolveAuth } from '../agents/claude.js';

function tokenFile(value = 'tok-' + 'x'.repeat(40)) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'e1-tok-'));
  const f = path.join(dir, 'claude-oauth-token');
  fs.writeFileSync(f, `${value}\n`, { mode: 0o600 });
  return { f, value, dir };
}

test('token-file auth sets the OAuth token from the file and drops the API key variables', () => {
  const { f, value, dir } = tokenFile();
  const env = claudeEnv({}, { auth: 'token-file', tokenFile: f, base: { PATH: '/bin', ANTHROPIC_API_KEY: 'k', ANTHROPIC_BASE_URL: 'u' } });
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, value);
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.ANTHROPIC_BASE_URL, undefined);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('auto picks token-file when the file exists, else inherit; a missing file for token-file fails loudly', () => {
  const { f, dir } = tokenFile();
  assert.equal(resolveAuth('auto', f), 'token-file');
  assert.equal(resolveAuth('auto', path.join(dir, 'none')), 'inherit');
  assert.throws(() => claudeEnv({}, { auth: 'token-file', tokenFile: path.join(dir, 'none'), base: {} }), /token file/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a token file readable by others is refused', () => {
  const { f, dir } = tokenFile();
  fs.chmodSync(f, 0o644);
  assert.throws(() => claudeEnv({}, { auth: 'token-file', tokenFile: f, base: {} }), /readable by others/);
  fs.rmSync(dir, { recursive: true, force: true });
});
