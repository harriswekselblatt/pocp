// During a merge, the gate keeps only the conflict resolutions; that filtered guard info must
// still mark the tests' helpers as test setup, so no planted bug lands in a helper.
import test from 'node:test';
import assert from 'node:assert/strict';
import { git, packetId, pocp, read, sampleRepo, write, writeRules } from './helpers.js';

const noHooks = (dir, msg) => git(dir, '-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', msg);

test('a merge that resolves a test conflict plants no mutant in the tests\' helper', () => {
  const dir = sampleRepo({ hooks: true });
  writeRules(dir, { requirements: [{ id: 'math', globs: ['src/**', 'test/**'], obligation: { kind: 'test', run: 'node test/math.check.mjs' }, source: 'author' }] });
  write(dir, 'src/testing/check.js', "export function eq(a, b, what) {\n  if (a !== b) { console.error(`${what} broken`); process.exit(1); }\n  if (a === b && b !== a) process.exit(2);\n}\n");
  const t = (extra) => [
    "import { add, isPositive } from '../src/math.js';",
    "import { eq } from '../src/testing/check.js';",
    "eq(add(2, 3), 5, 'add');",
    "eq(isPositive(1), true, 'isPositive');",
    extra,
    "console.log('math ok');",
    '',
  ].join('\n');
  write(dir, 'test/math.check.mjs', t("eq(add(0, 0), 0, 'zero');"));
  git(dir, 'add', '-A');
  noHooks(dir, 'base with helper');
  git(dir, 'checkout', '-q', '-b', 'side');
  write(dir, 'test/math.check.mjs', t("eq(add(1, 1), 2, 'one');"));
  git(dir, 'add', '-A');
  noHooks(dir, 'side edits the test');
  git(dir, 'checkout', '-q', '-');
  write(dir, 'test/math.check.mjs', t("eq(add(2, 2), 4, 'two');"));
  git(dir, 'add', '-A');
  noHooks(dir, 'main edits the test');
  try { git(dir, '-c', 'core.hooksPath=/dev/null', 'merge', '--no-commit', 'side'); } catch { /* the conflict is the point */ }
  // Resolve the conflict by keeping both assertions, and touch the helper in the resolution.
  write(dir, 'test/math.check.mjs', t("eq(add(2, 2), 4, 'two');\neq(add(1, 1), 2, 'one');"));
  write(dir, 'src/testing/check.js', `// shared assertion helper\n${read(dir, 'src/testing/check.js')}`);
  git(dir, 'add', '-A');
  const id = packetId(pocp(dir, ['open', '--intent', 'resolve', '--touch', 'test/math.check.mjs', '--touch', 'src/testing/check.js']).stdout);
  pocp(dir, ['prove', id]);
  const p = JSON.parse(read(dir, `.proof/packets/${id}.json`));
  const guard = p.obligations.find((o) => o.source === 'guard:tests');
  assert.ok(guard, 'the resolution is a test change, so the guard runs');
  const proof = p.proofs.filter((x) => x.obligation === guard.id).pop();
  const files = (proof?.guard?.detection?.mutants || []).map((m) => m.file);
  assert.ok(files.length > 0, `mutants were planted: ${JSON.stringify(proof?.guard?.summary)}`);
  assert.ok(!files.includes('src/testing/check.js'), `no mutant in the helper, got: ${files.join(', ')}`);
});
