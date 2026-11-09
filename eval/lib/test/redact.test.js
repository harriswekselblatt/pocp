// README rule 9: no personal paths in eval results.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { POCP_ROOT } from '../pins.js';
import { personalPaths, redactText } from '../redact.js';

const opts = { root: '/Users/alice/code/pocp', home: '/Users/alice', tmp: '/var/folders/ab/cd12/T' };

test('this checkout, temp, scratch and home paths are replaced', () => {
  const t = [
    '/Users/alice/code/pocp/eval/tasks/frozen/x.jsonl',
    '/private/var/folders/ab/cd12/T/pocp-e1-xyz/repo',
    '/var/folders/zz/yy99/T/other',
    '/private/tmp/claude-501/-Users-alice-Desktop-claude/0123abcd-0123-4567-89ab-0123456789ab/scratchpad/e3',
    '/Users/alice/.codex/AGENTS.md',
    '/Users/bob/elsewhere',
    '/home/carol/project',
    'C:-Users-dave-x',
  ].join('\n');
  const out = redactText(t, opts);
  assert.deepEqual(personalPaths(out), []);
  assert.match(out, /^<pocp>\/eval\/tasks\/frozen\/x\.jsonl$/m);
  assert.match(out, /^\$TMPDIR\/pocp-e1-xyz\/repo$/m);
  assert.match(out, /^\$SCRATCH\/scratchpad\/e3$/m);
  assert.match(out, /^~\/\.codex\/AGENTS\.md$/m);
});

test('text without paths is left alone', () => {
  const t = 'assert candidate(10, 20, 3) == 2\nUsers can run it on /usr/bin/python3';
  assert.equal(redactText(t, opts), t);
});

test('no eval result holds a personal path', (t) => {
  // The records live in their own repository, pinned by checksum (eval/results.sha256); this
  // checks the local copy in eval/results/ when one has been fetched.
  if (!fs.existsSync(path.join(POCP_ROOT, 'eval', 'results'))) return t.skip('eval/results/ not fetched (node eval/tools/fetch-results.js)');
  const walk = (d) => fs.readdirSync(path.join(POCP_ROOT, d), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  const files = walk('eval/results');
  const bad = [];
  for (const f of files) {
    const full = path.join(POCP_ROOT, f);
    if (!fs.existsSync(full)) continue;
    const found = personalPaths(fs.readFileSync(full, 'utf8'));
    if (found.length) bad.push(`${f}: ${found.slice(0, 3).join(', ')}`);
  }
  assert.deepEqual(bad, []);
});
