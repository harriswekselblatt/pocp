// pocp init looks for the repository's tests and writes any folder the default test patterns
// miss into guard.extra_test_globs, so the guard knows where the tests are from the start.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectTestLayout } from '../src/init.js';
import { pocp, read, tmpRepo, write } from './helpers.js';

const langs = (layout) => Object.fromEntries(layout.ecosystems.map((e) => [e.lang, e.globs.map((g) => g.glob)]));

test('JavaScript: jest roots outside the defaults are written to the config, with a note', () => {
  const dir = tmpRepo();
  write(dir, 'package.json', JSON.stringify({ name: 'x', jest: { roots: ['<rootDir>/checks', '<rootDir>/src'] } }));
  write(dir, 'src/a.js', 'export const a = 1;\n');
  write(dir, 'checks/a.check.js', "import { a } from '../src/a.js';\n");
  write(dir, 'spec/b.spec.js', '');
  write(dir, 'tools/math-tests.js', '');
  const r = pocp(dir, ['init', '--json']);
  assert.equal(r.code, 0, r.stderr);
  const layout = r.json.test_layout;
  assert.deepEqual(layout.extra, ['checks/**'], 'src/ holds code, and is not a test folder');
  assert.ok(langs(layout)['JavaScript/TypeScript'].includes('checks/**'));
  assert.ok(langs(layout)['JavaScript/TypeScript'].includes('spec/**'));
  assert.deepEqual(layout.uncovered, ['tools/math-tests.js'], 'named like a test, covered by nothing: listed for a person');
  const cfg = JSON.parse(read(dir, '.proof/config.json'));
  assert.deepEqual(cfg.guard.extra_test_globs, ['checks/**']);
  assert.match(cfg.guard._note, /checks\/ from package\.json jest\.roots/);
  assert.equal(pocp(dir, ['rules', 'check']).code, 0, 'the written config is valid');

  const human = pocp(dir, ['init']);
  assert.match(human.stdout, /test layout: JavaScript\/TypeScript: /);
  assert.match(human.stdout, /not covered by the defaults; add to guard\.extra_test_globs/, 'an existing config is left alone, with the advice printed');
});

test('Python: pytest testpaths', () => {
  const dir = tmpRepo();
  write(dir, 'pyproject.toml', '[project]\nname = "x"\n\n[tool.pytest.ini_options]\ntestpaths = ["qa", "tests"]\n');
  write(dir, 'app/core.py', '');
  write(dir, 'qa/check_core.py', '');
  write(dir, 'tests/test_core.py', '');
  const layout = detectTestLayout(dir);
  assert.deepEqual(layout.extra, ['qa/**'], 'tests/ is already a default');
  assert.deepEqual(langs(layout).Python.sort(), ['qa/**', 'tests/**']);
});

test('Ruby: rspec default path and minitest', () => {
  const dir = tmpRepo();
  write(dir, 'Gemfile', "source 'https://rubygems.org'\n");
  write(dir, '.rspec', '--require spec_helper\n--default-path behaviour\n');
  write(dir, 'lib/x.rb', '');
  write(dir, 'behaviour/x_behaviour.rb', '');
  write(dir, 'test/x_test.rb', '');
  write(dir, 'lib/y_spec.rb', '');
  const layout = detectTestLayout(dir);
  assert.deepEqual(layout.extra, ['behaviour/**']);
  assert.deepEqual(langs(layout).Ruby.sort(), ['**/*_spec.*', 'behaviour/**', 'test/**']);
});

test('Java/Kotlin: Maven and Gradle source sets, and a custom testSourceDirectory', () => {
  const dir = tmpRepo();
  write(dir, 'pom.xml', '<project><build><testSourceDirectory>${project.basedir}/qa/java</testSourceDirectory></build></project>\n');
  write(dir, 'src/main/java/com/x/Calc.java', '');
  write(dir, 'qa/java/com/x/CalcCheck.java', '');
  write(dir, 'app/build.gradle.kts', '');
  write(dir, 'app/src/main/kotlin/App.kt', '');
  write(dir, 'app/src/test/kotlin/AppTest.kt', '');
  write(dir, 'app/src/androidTest/kotlin/AppUi.kt', '');
  const layout = detectTestLayout(dir);
  assert.deepEqual(layout.extra, ['qa/java/**']);
  const globs = langs(layout)['Java/Kotlin'];
  assert.ok(globs.includes('**/test/**'), JSON.stringify(globs));
  assert.ok(globs.includes('**/src/*Test/**'), JSON.stringify(globs));
  assert.ok(globs.includes('qa/java/**'));
});

test('a repository the defaults already cover gets no extra globs, and the config stays as before', () => {
  const dir = tmpRepo();
  write(dir, 'go.mod', 'module example.com/m\n');
  write(dir, 'a.go', 'package m\n');
  write(dir, 'a_test.go', 'package m\n');
  const r = pocp(dir, ['init', '--json']);
  assert.deepEqual(r.json.test_layout.extra, []);
  assert.deepEqual(langs(r.json.test_layout), { Go: ['**/*_test.*'] });
  assert.deepEqual(JSON.parse(read(dir, '.proof/config.json')).guard, { mutants: 0, additions: 'accept' }, 'only the fast test guard');
});
