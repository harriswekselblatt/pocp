// The README's demo: an agent breaks add() and edits the test so it passes; POCP must still
// report that the old test fails on the new code. If POCP's verdict or wording changes, the
// demo (and docs/demo.svg) must be updated with it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

test('the demo: plain tests pass after the test edit, and verify blocks it on the old test', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pocp-demo-test-'));
  const cast = path.join(tmp, 'demo.cast');
  const env = { ...process.env };
  delete env.POCP_BIN;
  const r = spawnSync(process.execPath, [path.join(ROOT, 'examples/demo/demo.mjs'), '--cast', cast], { encoding: 'utf8', env });
  assert.equal(r.status, 0, `the demo expects POCP to block the change:\n${r.stdout}\n${r.stderr}`);
  const out = r.stdout.replace(/\x1b\[[0-9;]*m/g, '');
  assert.match(out, /✗ 1 test failed: 2 !== 0/);
  assert.match(out, /✓ 1 test passed/);
  assert.match(out, /pocp fix: committable now; CI requires human approval of the test change/);
  assert.match(out, /NOT verified: 1 commit/);
  assert.match(out, /rerun passed {3}npm test --silent/);
  assert.match(out, /BAD: the old tests fail on the new code/);
  assert.match(out, /pocp-approve-tests/);

  const svg = path.join(tmp, 'demo.svg');
  const s = spawnSync(process.execPath, [path.join(ROOT, 'examples/demo/render-svg.mjs'), cast, svg], { encoding: 'utf8' });
  assert.equal(s.status, 0, s.stderr);
  const body = fs.readFileSync(svg, 'utf8');
  assert.match(body, /^<svg [^>]*viewBox=/);
  assert.match(body, /the old tests fail on the new code/);
  assert.doesNotMatch(body, /\x1b/);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('the README shows the demo that is checked in', () => {
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  assert.match(readme, /\]\(docs\/demo\.svg\)/);
  assert.match(fs.readFileSync(path.join(ROOT, 'docs/demo.svg'), 'utf8'), /the old tests fail on the new code/);
});
