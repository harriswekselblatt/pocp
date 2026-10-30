// Regression: the harness's own git commits in a POCP repo must use the pinned POCP, not
// whatever `pocp` is on PATH. prepare-commit-msg and post-commit run even with --no-verify;
// in CI there's no pocp on PATH, so these commits failed there and passed locally only
// because ~/.local/bin/pocp happened to exist (outside the pins).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { git, harnessEnv, pocp, TRUSTED_BIN } from '../lib/proc.js';

test('harness git commits in a POCP repo work with no pocp on PATH, through the pinned POCP', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'e1-pocpbin-'));
  try {
    const bare = { PATH: '/usr/bin:/bin' };
    await git(dir, ['init', '-q'], { env: harnessEnv(bare) });
    const init = await pocp(dir, ['init', '--hooks'], { env: harnessEnv(bare) });
    assert.equal(init.code, 0, init.err);
    fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n');
    await git(dir, ['add', '-A'], { env: harnessEnv(bare) });
    await git(dir, ['commit', '-q', '--no-verify', '-m', 'base'], { env: harnessEnv(bare) });
    assert.equal(harnessEnv(bare).POCP_BIN, `${process.execPath} ${TRUSTED_BIN}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an agent environment keeps its own pinned copy of POCP', () => {
  assert.equal(harnessEnv({ POCP_BIN: '/x/agent-pocp/bin/pocp' }).POCP_BIN, '/x/agent-pocp/bin/pocp');
});
