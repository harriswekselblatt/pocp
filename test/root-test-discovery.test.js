import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_EVAL_EXCLUDE } from '../src/mutants.js';
import { matchGlob } from '../src/glob.js';
import { git, pocp, read, sampleRepo, write } from './helpers.js';

const protectedTest = (file) => DEFAULT_EVAL_EXCLUDE.some((glob) => matchGlob(file, glob));

test('standalone JavaScript/TypeScript test names are guarded and excluded from mutations', () => {
  for (const file of ['test.js', 'test.mjs', 'test.cjs', 'test.ts', 'test.mts', 'test.cts', 'test.jsx', 'test.tsx', 'test-unit.js', 'packages/core/test.mjs', 'packages/core/test-unit.ts']) {
    assert.ok(protectedTest(file), file);
  }
  for (const file of ['src/latest.js', 'src/contest.ts', 'test.md', 'test-data.json', 'src/main.js']) {
    assert.equal(protectedTest(file), false, file);
  }
});

for (const file of ['test.js', 'test-unit.mjs']) {
  for (const weakened of [true, false]) {
    test(`${file}: ${weakened ? 'weakened checks are detected' : 'honest test additions retain the fast review path'}`, () => {
      const dir = sampleRepo({ hooks: true, deep: false, rules: {
        requirements: [{ id: 'tests', globs: ['src/**', file], obligation: { kind: 'test', run: `node scripts/runner.mjs ${file}` } }],
      } });
      write(dir, 'package.json', '{"type":"module"}\n');
      // Like a test framework, the program loads a test given as an argument. That argument
      // cannot be assumed to be executable code: many commands take source files as data.
      write(dir, 'scripts/runner.mjs', "import path from 'node:path';\nimport { pathToFileURL } from 'node:url';\nawait import(pathToFileURL(path.resolve(process.argv[2])));\n");
      git(dir, 'mv', 'test/math.check.mjs', file);
      write(dir, file, read(dir, file).replace("'../src/math.js'", "'./src/math.js'"));
      git(dir, 'add', '-A');
      git(dir, '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'standalone test layout');
      const base = git(dir, 'rev-parse', 'HEAD');
      const oldTest = read(dir, file);
      if (weakened) {
        write(dir, 'src/math.js', read(dir, 'src/math.js').replace('a + b', 'a - b'));
        write(dir, file, "import { add } from './src/math.js';\nconsole.log('smoke');\n");
      } else {
        write(dir, 'src/math.js', read(dir, 'src/math.js').replace('a + b', 'b + a'));
        write(dir, file, `${oldTest}\nif (add(-1, 1) !== 0) process.exit(1);\n`);
      }
      git(dir, 'add', '-A');
      assert.equal(pocp(dir, ['fix', '--json']).code, 0);
      git(dir, 'commit', '-qm', 'candidate');
      const result = pocp(dir, ['verify', `${base}..HEAD`, '--require-coverage', '--rerun', '--json']);
      assert.equal(result.code, 1, result.stdout);
      const guard = result.json.commits[0].test_guard;
      assert.ok(guard?.files.includes(file), JSON.stringify(guard));
      const verdicts = guard.mechanical.map((entry) => entry.verdict);
      assert.ok(verdicts.includes(weakened ? 'behavior-changed' : 'needs-review'), JSON.stringify(guard));
      assert.equal(result.json.approval.only, true, result.stdout);
    });
  }
}
