// A test file that uses the helpers leaves nothing behind in TMPDIR (or wherever else it made
// a temporary folder) once its process exits, without any cleanup code of its own.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const HELPERS = path.join(here, 'helpers.js');

test('a helper-using test leaves its TMPDIR empty', () => {
  // Made with the real os.tmpdir() of this process, removed below.
  const box = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pocp-cleanup-check-')));
  try {
    const tmp = path.join(box, 'tmp');
    const other = path.join(box, 'elsewhere'); // stands in for a folder like /tmp
    fs.mkdirSync(tmp);
    fs.mkdirSync(other);
    const file = path.join(box, 'leaky.test.mjs');
    fs.writeFileSync(file, [
      "import { test } from 'node:test';",
      "import fs from 'node:fs';",
      "import os from 'node:os';",
      "import path from 'node:path';",
      `import { tmpRepo, sampleRepo, pocp, write, git } from ${JSON.stringify(HELPERS)};`,
      "test('makes temp folders and never cleans up', () => {",
      '  tmpRepo();',
      '  const dir = sampleRepo();',
      "  write(dir, 'src/math.js', 'export const add = (a, b) => b + a;\\nexport const isPositive = (n) => n > 0;\\n');",
      "  git(dir, 'add', '-A');",
      "  if (pocp(dir, ['fix', '--intent', 'x']).code !== 0) throw new Error('fix failed');", // snapshots, packets, runs
      "  const ro = fs.mkdtempSync(path.join(os.tmpdir(), 'pocp-unit-'));",
      "  fs.mkdirSync(path.join(ro, 'locked')); fs.writeFileSync(path.join(ro, 'locked', 'f'), 'x'); fs.chmodSync(path.join(ro, 'locked'), 0o555);",
      `  fs.mkdtempSync(path.join(${JSON.stringify(other)}, 'pocp-norepo-'));`,
      '});',
      '',
    ].join('\n'));
    const { NODE_TEST_CONTEXT, ...env } = process.env;
    const r = spawnSync(process.execPath, ['--test', '--test-reporter=tap', file], { cwd: box, encoding: 'utf8', env: { ...env, TMPDIR: tmp } });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /# pass 1/);
    assert.deepEqual(fs.readdirSync(tmp), [], 'TMPDIR is empty after the test file finished');
    assert.deepEqual(fs.readdirSync(other), [], 'folders made outside TMPDIR are removed too');
  } finally {
    spawnSync('chmod', ['-R', 'u+w', box]); // in case the child left its read-only folder behind
    fs.rmSync(box, { recursive: true, force: true });
  }
});
