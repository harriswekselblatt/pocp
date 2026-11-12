// Fast mode with guard.additions "accept": a test edit that only adds whole new declarations can
// pass without a person. Every way an addition could hollow out the existing tests must still go
// to review. These cases are the attacks that ended the earlier add-only rule (2026-11), plus the
// ways around a naive fix. judgeAdditions is pure: it reads only the two texts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { judgeAdditions } from '../src/additions.js';

const accept = (path, base, next) => {
  const r = judgeAdditions({ path, base, next });
  assert.equal(r.ok, true, `expected accept, got: ${r.why}`);
};
const review = (path, base, next, why) => {
  const r = judgeAdditions({ path, base, next });
  assert.equal(r.ok, false, 'expected review, got accept');
  if (why) assert.match(r.why, why);
};

// --- JavaScript -------------------------------------------------------------------------------

const JS = [
  "import test from 'ava';",
  "import { add } from '../src/math.js';",
  '',
  'const EXPECTED = 5;',
  '',
  "test('adds', (t) => {",
  '  t.is(add(2, 3), EXPECTED);',
  '});',
  '',
].join('\n');

test('js: a new test appended at the end is accepted', () => {
  accept('test/math.test.js', JS, `${JS}test('adds zero', (t) => {\n  const result = add(0, 0);\n  t.is(result, 0);\n});\n`);
});

test('js: a new test inserted between tests, a helper, a literal constant and an import are accepted', () => {
  const next = JS.replace("test('adds'", [
    "import { sub } from '../src/sub.js';",
    'const ZERO = 0;',
    'function twice(x) {',
    '  return add(x, x);',
    '}',
    '',
    "test('twice', (t) => {",
    '  t.is(twice(2), 4);',
    '});',
    '',
    "test('adds'",
  ].join('\n'));
  accept('test/math.test.js', JS, next);
});

test('js: a new it() inside an existing describe is accepted', () => {
  const base = "import { add } from '../src/math.js';\ndescribe('add', () => {\n  it('adds', () => {\n    expect(add(2, 3)).toBe(5);\n  });\n});\n";
  const next = base.replace('  });\n});', "  });\n\n  it('adds negatives', () => {\n    expect(add(-1, -1)).toBe(-2);\n  });\n});");
  accept('test/math.spec.ts', base, next);
});

test('js: a whole new test file of plain declarations is accepted', () => {
  accept('test/sub.test.mjs', null, "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { sub } from '../src/sub.js';\n\ntest('subtracts', () => {\n  assert.equal(sub(3, 1), 2);\n});\n");
});

const JS_ATTACKS = [
  ['wrapping existing assertions in if (false)', JS.replace('  t.is(add(2, 3), EXPECTED);', '  if (false) {\n  t.is(add(2, 3), EXPECTED);\n  }'), /bracket|declaration/],
  ['opening a block comment around existing code', JS.replace("test('adds'", "/*\ntest('adds'").replace('});\n', '});\n*/\n'), /comment|bracket/],
  ['an early return inside an existing test', JS.replace('  t.is(add(2, 3), EXPECTED);', '  return t.pass();\n  t.is(add(2, 3), EXPECTED);'), /declaration/],
  ['a bare return inside an existing test', JS.replace('  t.is(add(2, 3), EXPECTED);', '  return;\n  t.is(add(2, 3), EXPECTED);'), /returns early|declaration/],
  ['shadowing a constant the existing test reads', JS.replace("test('adds'", "{\n}\ntest('adds'").replace('const EXPECTED = 5;', 'const EXPECTED = 5;\nconst EXPECTED2 = 1;'), null],
  ['redeclaring the test function (hoisted)', `${JS}function test() {}\n`, /already/],
  ['redeclaring a constant used by existing tests', JS.replace("test('adds'", "test('x', (t) => { t.pass(); });\nconst EXPECTED = 6;\ntest('adds'"), /already/],
  ['patching an assertion through an alias', `${JS}test('setup', (t) => {\n  const a = t;\n  a.is = () => {};\n});\n`, /assigns|attribute/],
  ['mutating an imported module', `${JS}import * as math from '../src/math.js';\ntest('x', () => {\n  math.add = () => 5;\n});\n`, /assigns|attribute/],
  ['assigning through a subscript', `${JS}test('x', (t) => {\n  const a = t;\n  a['is'] = () => {};\n});\n`, /assigns|attribute/],
  ['Object.assign on an alias', `${JS}test('x', (t) => {\n  const a = t;\n  Object.assign(a, { is() {} });\n});\n`, /patches|Object/],
  ['Reflect.set', `${JS}test('x', (t) => {\n  Reflect.set(t, 'is', () => {});\n});\n`, /Reflect/],
  ['deleting a property', `${JS}test('x', (t) => {\n  delete t.is;\n});\n`, /delete/],
  ['a top-level call with side effects', `${JS}setup();\n`, /declaration/],
  ['a top-level constant computed by a call', `${JS}const patched = install();\n`, /declaration/],
  ['a bare side-effect import', `${JS}import '../src/polyfill.js';\n`, /declaration/],
  ['test.failing inverts a test', `${JS}test.failing('x', (t) => { t.fail(); });\n`, /skips|failing/],
  ['assigning a file-level variable from a test', `${JS}let ready = false;\ntest('x', () => {\n  counter = 0;\n});\n`, /assigns/],
  ['eval', `${JS}test('x', () => {\n  eval('t.is = () => {}');\n});\n`, /eval/],
  ['a new Proxy over an assertion object', `${JS}test('x', (t) => {\n  const p = new Proxy(t, {});\n  p.is = () => {};\n});\n`, /assigns|attribute/],
  ['adding a mocha skip', `${JS}it('x', function () {\n  this.skip();\n});\n`, /skip/],
  ['exiting the process', `${JS}test('x', () => {\n  process.exit(0);\n});\n`, /exits/],
  ['an added test hook', `${JS}test.beforeEach(() => {});\n`, /hook|declaration/],
];

for (const [name, next, why] of JS_ATTACKS) {
  test(`js attack goes to review: ${name}`, () => review('test/math.test.js', JS, next, why));
}

test('js: a changed or removed existing line goes to review', () => {
  review('test/math.test.js', JS, JS.replace('EXPECTED = 5', 'EXPECTED = 6'), /changed or removed/);
  review('test/math.test.js', JS, JS.replace('  t.is(add(2, 3), EXPECTED);\n', ''), /changed or removed/);
});

test('js: an unparseable file goes to review', () => {
  review('test/math.test.js', JS, `${JS}test('x', () => {\n`, /bracket/);
});

// --- Python -----------------------------------------------------------------------------------

const PY = [
  'import pytest',
  'from mylib import add',
  '',
  'EXPECTED = 5',
  '',
  '',
  'def test_add():',
  '    result = add(2, 3)',
  '    assert result == EXPECTED',
  '',
  '',
  'class TestAdd:',
  '    def test_zero(self):',
  '        assert add(0, 0) == 0',
  '',
].join('\n');

test('py: a new test function appended is accepted', () => {
  accept('tests/test_math.py', PY, `${PY}\n\ndef test_negative():\n    assert add(-1, -1) == -2\n`);
});

test('py: a new method inside an existing test class is accepted', () => {
  accept('tests/test_math.py', PY, `${PY}\n    def test_one(self):\n        assert add(1, 0) == 1\n`);
});

test('py: a parametrized test, an import and a literal constant are accepted', () => {
  const next = PY.replace('def test_add():', [
    'from mylib import sub',
    'CASES = [(1, 2, 3), (2, 2, 4)]',
    '',
    '',
    "@pytest.mark.parametrize('a,b,c', CASES)",
    'def test_table(a, b, c):',
    '    assert add(a, b) == c',
    '',
    '',
    'def test_add():',
  ].join('\n'));
  accept('tests/test_math.py', PY, next);
});

test('py: a new test file is accepted', () => {
  accept('tests/test_sub.py', null, 'from mylib import sub\n\n\ndef test_sub():\n    assert sub(3, 1) == 2\n');
});

const PY_ATTACKS = [
  ['redefining an existing test (the later def wins)', `${PY}\n\ndef test_add():\n    pass\n`, /already/],
  ['a def inserted mid-test swallows the rest of its body', PY.replace('    assert result == EXPECTED', 'def helper():\n    pass\n    assert result == EXPECTED'), /indent|inside/],
  ['an early return inside an existing test', PY.replace('    assert result == EXPECTED', '    return\n    assert result == EXPECTED'), /declaration|returns/],
  ['an opened triple-quoted string', PY.replace('def test_add():', '"""\ndef test_add():').replace('class TestAdd:', '"""\nclass TestAdd:'), /string|declaration/],
  ['rebinding an imported name', `${PY}\n\nfrom fake import add\n`, /already/],
  ['shadowing a constant', PY.replace('def test_add():', 'EXPECTED = 6\n\n\ndef test_add():'), /already/],
  ['a module-level side effect', `${PY}\nimport mylib\nmylib.add = lambda a, b: 5\n`, /declaration|assigns/],
  ['monkeypatching a module from a test', `${PY}\n\ndef test_x():\n    import mylib\n    mylib.add = lambda a, b: 5\n`, /assigns|attribute/],
  ['setattr', `${PY}\n\ndef test_x():\n    import mylib\n    setattr(mylib, 'add', lambda a, b: 5)\n`, /setattr/],
  ['global', `${PY}\n\ndef test_x():\n    global EXPECTED\n    EXPECTED = 0\n`, /global/],
  ['pytest.skip in a module-level call', `${PY}\npytest.skip('later', allow_module_level=True)\n`, /skip|declaration/],
  ['a fixture (runs around other tests)', `${PY}\n\n@pytest.fixture(autouse=True)\ndef patch():\n    yield\n`, /fixture|hook/],
  ['pytest_plugins', `${PY}\npytest_plugins = ['evil']\n`, /declaration/],
  ['a class body that runs code', `${PY}\n\nclass TestMore:\n    import mylib\n    mylib.add = None\n`, /declaration|assigns/],
  ['sys.modules', `${PY}\n\ndef test_x():\n    import sys\n    sys.modules['mylib'] = None\n`, /sys\.modules|assigns/],
  ['exiting', `${PY}\n\ndef test_x():\n    raise SystemExit(0)\n`, /exit/],
  ['xfail', `${PY}\n\n@pytest.mark.xfail\ndef test_x():\n    assert False\n`, /skip/],
];

for (const [name, next, why] of PY_ATTACKS) {
  test(`py attack goes to review: ${name}`, () => review('tests/test_math.py', PY, next, why));
}

// --- Go ---------------------------------------------------------------------------------------

const GO = [
  'package mathx',
  '',
  'import "testing"',
  '',
  'func TestAdd(t *testing.T) {',
  '\tif Add(2, 3) != 5 {',
  '\t\tt.Fatal("add")',
  '\t}',
  '}',
  '',
].join('\n');

test('go: a new test function is accepted', () => {
  accept('mathx_test.go', GO, `${GO}\nfunc TestAddZero(t *testing.T) {\n\tgot := Add(0, 0)\n\tif got != 0 {\n\t\tt.Fatalf("got %d", got)\n\t}\n}\n`);
});

test('go: a table-driven test with a local struct is accepted', () => {
  accept('mathx_test.go', GO, `${GO}\nfunc TestTable(t *testing.T) {\n\tcases := []struct{ a, b, want int }{{1, 2, 3}, {2, 2, 4}}\n\tfor _, c := range cases {\n\t\tif got := Add(c.a, c.b); got != c.want {\n\t\t\tt.Errorf("got %d", got)\n\t\t}\n\t}\n}\n`);
});

const GO_ATTACKS = [
  ['an init function', `${GO}\nfunc init() {\n\tdefaultMode = 0\n}\n`, /init|hook/],
  ['TestMain', `${GO}\nfunc TestMain(m *testing.M) {\n}\n`, /TestMain|hook/],
  ['assigning a package variable', `${GO}\nfunc TestX(t *testing.T) {\n\tdefaultMode = 0\n}\n`, /assigns/],
  ['t.Skip', `${GO}\nfunc TestX(t *testing.T) {\n\tt.Skip("later")\n}\n`, /skip/],
  ['a package-level var with a func call', `${GO}\nvar _ = setup()\n`, /declaration/],
  ['an early return in an existing test', GO.replace('\tif Add(2, 3) != 5 {', '\treturn\n\tif Add(2, 3) != 5 {'), /declaration|returns/],
  ['os.Exit', `${GO}\nfunc TestX(t *testing.T) {\n\tos.Exit(0)\n}\n`, /exit/],
  ['writing through a pointer', `${GO}\nfunc TestX(t *testing.T) {\n\tp := &defaultMode\n\t*p = 0\n}\n`, /assigns|pointer/],
];

for (const [name, next, why] of GO_ATTACKS) {
  test(`go attack goes to review: ${name}`, () => review('mathx_test.go', GO, next, why));
}

// --- Other languages --------------------------------------------------------------------------

test('a language the analysis does not cover goes to review', () => {
  review('spec/math_spec.rb', "describe 'add' do\nend\n", "describe 'add' do\nend\ndescribe 'sub' do\nend\n", /language/);
});

// Regression (dev-set preview, boltons): a backslash-newline inside a string skipped the line
// count, and the analysis crashed instead of judging the file.
test('py: a string with an escaped newline is judged, not crashed on', () => {
  const base = 'def test_a():\n    s = "one \\\ntwo"\n    assert s\n';
  accept('tests/test_s.py', base, `${base}\n\ndef test_b():\n    t = "x \\\ny"\n    assert t\n`);
});

test('js: a template literal with an escaped newline is judged', () => {
  const base = "import test from 'ava';\ntest('a', (t) => {\n  t.is(`a\\\nb`, 'ab');\n});\n";
  accept('test/a.test.js', base, base + "test('b', (t) => {\n  t.is(`c\\\nd`, 'cd');\n});\n");
});

// Regression (dev-set preview, gjson): Go raw strings end at one backtick and span lines.
test('go: raw strings, including multi-line ones, are judged', () => {
  const base = 'package g\n\nimport "testing"\n\nfunc TestA(t *testing.T) {\n\tjson := `{"a":\n1}`\n\tif json == "" {\n\t\tt.Fatal("x")\n\t}\n}\n';
  accept('g_test.go', base, `${base}\nfunc TestB(t *testing.T) {\n\tjson := \`{"b": [1, 2]}\`\n\tif json == "" {\n\t\tt.Fatal("y")\n\t}\n}\n`);
});

// Regression (Codex review of PR #81): a top-level line was judged by how it STARTS, so code
// after a declaration, or inside a constant's value, ran at load time and was accepted.
const JS_TRAILING = [
  ['a statement after a test on the same line', "test('new', () => {}); disableAssertions();"],
  ['a comma expression after a test', "test('new', () => {}), disableAssertions();"],
  ['a call inside an array constant', 'const setup = [disableAssertions()];'],
  ['a call inside an object constant', 'const o = { a: disableAssertions() };'],
  ['an immediately invoked function', 'const f = (() => disableAssertions())();'],
  ['a second declarator with a call', 'const a = 1, b = disableAssertions();'],
  ['an arrow constant followed by a call', 'const f = () => 1; disableAssertions();'],
  ['a function declaration followed by a call', 'function helper() {}\ndisableAssertions();'],
  ['a function declaration with a call after its body', 'function helper() {} disableAssertions();'],
  ['a computed test title', 'test(disableAssertions(), () => {});'],
  ['an interpolated test title', 'test(`x ${disableAssertions()}`, () => {});'],
  ['an interpolated template constant', 'const s = `${disableAssertions()}`;'],
  ['a tagged template constant', 'const s = tag`x`;'],
  ['a constant read through a getter', 'const v = lib.patched;'],
  ['test.each with a computed table', 'test.each([[disableAssertions()]])("x", () => {});'],
  ['a multi-line test followed by a call', "test('new', () => {\n  t.pass();\n}); disableAssertions();"],
];
for (const [name, line] of JS_TRAILING) {
  test(`js: code that runs at load is not accepted: ${name}`, () => {
    review('test/math.test.js', JS, `${JS}${line}\n`);
  });
}

const PY_IMPORT_TIME = [
  ['a call in a list constant', 'X = [disable()]'],
  ['a call in a tuple constant', 'X = (disable(), 1)'],
  ['a call in a dict constant', 'Y = {1: disable()}'],
  ['a call in an f-string constant', "S = f'{disable()}'"],
  ['a statement after a constant', 'X = 1; disable()'],
  ['a call in a default argument', 'def test_b(a=disable()):\n    assert a'],
  ['a call in an annotation', 'def test_b(a: disable()):\n    assert a'],
  ['a call in decorator arguments', "@pytest.mark.parametrize('a', [disable()])\ndef test_b(a):\n    assert a"],
  ['a call in class bases', 'class TestB(make_base()):\n    def test_x(self):\n        assert True'],
  ['a call in a class attribute', 'class TestB:\n    X = [disable()]\n\n    def test_x(self):\n        assert True'],
  ['a decorated method with a computed argument', "class TestB:\n    @pytest.mark.parametrize('a', [disable()])\n    def test_x(self, a):\n        assert a"],
  ['a constant read through an attribute', 'X = lib.patched'],
];
for (const [name, code] of PY_IMPORT_TIME) {
  test(`py: code that runs at import is not accepted: ${name}`, () => {
    review('tests/test_math.py', PY, `${PY}\n\n${code}\n`);
  });
}

test('js and py: inert constants, plain tests and helpers are still accepted', () => {
  accept('test/math.test.js', JS, `${JS}const CASES = [[1, 2, 3], [2, 2, 4]];\nconst OPTS = { timeout: 5, name: 'x' };\nconst neg = (x) => -x;\ntest('neg', (t) => {\n  t.is(neg(1), -1);\n});\n`);
  accept('tests/test_math.py', PY, `${PY}\n\nCASES = [(1, 2, 3), (2, 2, 4)]\n\n\n@pytest.mark.parametrize('a,b,c', CASES)\ndef test_table(a, b, c=0):\n    assert add(a, b) == c\n`);
});
