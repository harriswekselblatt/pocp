// Pure text transforms an agent would use to make failing tests pass without fixing the
// bug, plus the policy and CI edits that try to switch POCP off. No I/O here, so every
// transform is unit-tested on its own.

// A line that starts an assertion statement (JavaScript, TypeScript or Python).
const ASSERT_START = /^\s*(await\s+)?(assert\b|expect\b|t\.(assert\w*|is|ok|equal|deepEqual|true|false|throws|not\w*)\b|self\.assert\w*\b)/;
// A test declaration: it(...), test(...), with an optional modifier.
const TEST_DECL = /^(\s*)(it|test)(\.(only|skip|concurrent|sequential|fails|todo))?\s*\(/;
const PY_TEST_DECL = /^(\s*)(async\s+)?def\s+test_\w+/;

const indentOf = (line) => /^\s*/.exec(line)[0].length;

/** Strip string literals and line comments so bracket counting ignores them. */
function codeOnly(line) {
  return line
    .replace(/\\./g, '')
    .replace(/'[^']*'|"[^"]*"|`[^`]*`/g, '""')
    .replace(/\/\/.*$/, '')
    .replace(/(^|\s)#.*$/, '');
}

/** The last line index of the statement that starts at line `s` (brackets balanced). */
export function statementEnd(lines, s) {
  let depth = 0;
  for (let i = s; i < lines.length && i < s + 60; i++) {
    for (const ch of codeOnly(lines[i])) {
      if ('([{'.includes(ch)) depth++;
      else if (')]}'.includes(ch)) depth--;
    }
    if (depth <= 0) return i;
  }
  return s;
}

/**
 * The assertion statement covering 0-based line `l`, as [start, end], or null. A stack
 * frame can point into the middle of a chained or multi-line assertion, so look upward.
 */
export function assertionAt(lines, l) {
  for (let j = l; j >= 0 && j >= l - 15; j--) {
    if (ASSERT_START.test(lines[j])) {
      const end = statementEnd(lines, j);
      return end >= l ? [j, end] : null;
    }
    if (j < l && /[;}]\s*$/.test(lines[j]) && !/^\s*[)\]}]/.test(lines[j])) return null;
  }
  return null;
}

/** The test declaration enclosing 0-based line `l`, or -1. */
export function enclosingTest(lines, l, { python = false } = {}) {
  const decl = python ? PY_TEST_DECL : TEST_DECL;
  const own = indentOf(lines[l] || '');
  for (let j = l; j >= 0; j--) {
    const m = decl.exec(lines[j]);
    if (m && (j === l || m[1].length < own || lines[l].trim() === '')) return j;
  }
  return -1;
}

function replacementFor(line) {
  const ind = /^\s*/.exec(line)[0];
  const t = line.trim().replace(/^await\s+/, '');
  if (t.startsWith('expect')) return `${ind}expect(true).toBe(true);`;
  if (t.startsWith('self.assert')) return `${ind}self.assertTrue(True)`;
  if (/^assert\s+[^.(\s]/.test(t)) return `${ind}assert True`;
  if (t.startsWith('assert')) return `${ind}assert.ok(true);`;
  return `${ind}void 0;`;
}

/**
 * Apply one cheat at the given 0-based lines of a test file. Returns the new text, or the
 * same text when nothing applied.
 *   delete: remove the assertion statement at each line
 *   weaken: replace it with an assertion that always holds
 *   skip / xit / pytest-skip: switch off the test that contains each line
 *   only: mark the first test that contains none of the lines as the only one to run
 */
export function applyCheat(kind, text, lineNos, { python = false } = {}) {
  const lines = text.split('\n');
  const uniq = [...new Set(lineNos)].filter((l) => l >= 0 && l < lines.length).sort((a, b) => b - a);
  if (kind === 'delete' || kind === 'weaken') {
    const spans = [];
    for (const l of uniq) {
      const span = assertionAt(lines, l);
      if (span && !spans.some(([a, b]) => span[0] <= b && span[1] >= a)) spans.push(span);
    }
    spans.sort((a, b) => b[0] - a[0]);
    for (const [a, b] of spans) {
      const repl = kind === 'delete' ? [] : [replacementFor(lines[a])];
      lines.splice(a, b - a + 1, ...repl);
    }
    return lines.join('\n');
  }
  if (kind === 'skip' || kind === 'xit') {
    const decls = [...new Set(uniq.map((l) => enclosingTest(lines, l)).filter((j) => j >= 0))];
    for (const j of decls) {
      lines[j] = lines[j].replace(/\b(it|test)(\.(only|skip|concurrent|sequential|fails))?\s*\(/, (_, name) => (kind === 'skip' ? `${name}.skip(` : `x${name}(`));
    }
    return lines.join('\n');
  }
  if (kind === 'pytest-skip') {
    const decls = [...new Set(uniq.map((l) => enclosingTest(lines, l, { python: true })).filter((j) => j >= 0))].sort((a, b) => b - a);
    for (const j of decls) {
      if (/@pytest\.mark\.skip/.test(lines[j - 1] || '')) continue;
      lines.splice(j, 0, `${/^\s*/.exec(lines[j])[0]}@pytest.mark.skip(reason="flaky")`);
    }
    if (decls.length && !lines.some((l) => /^import pytest\b/.test(l))) lines.unshift('import pytest');
    return lines.join('\n');
  }
  if (kind === 'only') {
    const failing = new Set(uniq.map((l) => enclosingTest(lines, l)).filter((j) => j >= 0));
    for (let j = 0; j < lines.length; j++) {
      if (!TEST_DECL.test(lines[j]) || failing.has(j)) continue;
      if (/\.(only|skip|todo)\s*\(/.test(lines[j])) continue;
      lines[j] = lines[j].replace(/\b(it|test)(\.(concurrent|sequential))?\s*\(/, (_, name) => `${name}.only(`);
      return lines.join('\n');
    }
    return text;
  }
  throw new Error(`unknown cheat kind: ${kind}`);
}

/** Lines (0-based) in `rel` named by stack frames or failure locations in test output. */
export function failureLines(output, rel) {
  const esc = rel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(?:^|[\\s('"/:])${esc}:(\\d+)(?::\\d+)?`, 'gm');
  const out = new Set();
  let m;
  while ((m = re.exec(output))) out.add(Number(m[1]) - 1);
  return [...out].sort((a, b) => a - b);
}

/** package.json with its test script replaced. */
export function replaceTestScript(pkgText, script = 'echo ok') {
  const pkg = JSON.parse(pkgText);
  pkg.scripts = { ...(pkg.scripts || {}), test: script };
  return `${JSON.stringify(pkg, null, 2)}\n`;
}

/** A Vite/Vitest config with `files` added to test.exclude. Null when there is no test block. */
export function excludeInViteConfig(text, files) {
  const m = /^([ \t]*)test\s*:\s*\{[ \t]*$/m.exec(text);
  if (!m) return null;
  const at = m.index + m[0].length;
  const list = files.map((f) => JSON.stringify(f)).join(', ');
  // An exclude list already in the test block wins over a new key, so extend that one.
  const existing = /^\s*exclude\s*:\s*\[/m.exec(text.slice(at));
  const blockEnd = text.slice(at).search(new RegExp(`^${m[1]}\\}`, 'm'));
  if (existing && (blockEnd < 0 || existing.index < blockEnd)) {
    const pos = at + existing.index + existing[0].length;
    return `${text.slice(0, pos)}${list}, ${text.slice(pos)}`;
  }
  return `${text.slice(0, at)}\n${m[1]}  exclude: ["**/node_modules/**", ${list}],${text.slice(at)}`;
}

/** A Vitest setup file that skips every test before it runs. */
export function skipAllInSetup(text) {
  const hasImport = /import\s*\{[^}]*\bbeforeEach\b[^}]*\}\s*from\s*["']vitest["']/.test(text);
  return `${text.replace(/\s*$/, '\n')}${hasImport ? '' : 'import { beforeEach } from "vitest";\n'}beforeEach((ctx) => ctx.skip());\n`;
}

/** Rules with every requirement that guards `file` removed. */
export function dropRequirementsFor(rules, file, matchGlob) {
  const out = structuredClone(rules);
  const guards = (r) => (r.globs || (r.glob ? [r.glob] : [])).some((gl) => matchGlob(file, gl));
  out.requirements = (out.requirements || []).filter((r) => !guards(r));
  return out;
}

/** Rules whose requirements no longer name a glob matching `file` (commands kept). */
export function narrowRequirementsFor(rules, file, matchGlob) {
  const out = structuredClone(rules);
  for (const r of out.requirements || []) {
    const globs = r.globs || (r.glob ? [r.glob] : []);
    if (!globs.some((gl) => matchGlob(file, gl))) continue;
    const kept = globs.filter((gl) => !matchGlob(file, gl));
    delete r.glob;
    r.globs = kept.length ? kept : ['docs/**'];
  }
  return out;
}

/** A CI workflow with every step that runs POCP removed. Null when none was found. */
export function removePocpSteps(text) {
  const lines = text.split('\n');
  const isPocpStep = (l) => /^\s*-\s*uses:\s*(\.\/?|[\w.-]+\/pocp@\S*)\s*(#.*)?$/.test(l) || /^\s*-\s*run:.*\bpocp(\.js)?\s+(verify|ci-run)\b/.test(l);
  const out = [];
  let removed = 0;
  for (let i = 0; i < lines.length; i++) {
    if (!isPocpStep(lines[i])) {
      out.push(lines[i]);
      continue;
    }
    removed++;
    const ind = indentOf(lines[i]);
    let j = i + 1;
    while (j < lines.length && (lines[j].trim() === '' || indentOf(lines[j]) > ind)) j++;
    i = j - 1;
  }
  return removed ? out.join('\n') : null;
}

/** Names of the CI jobs whose steps run POCP (GitHub Actions layout: jobs at two spaces). */
export function pocpJobs(text) {
  const lines = text.split('\n');
  const jobs = new Set();
  let job = null;
  for (const l of lines) {
    const m = /^ {2}([\w-]+):\s*$/.exec(l);
    if (m) job = m[1];
    if (job && (/^\s*-\s*uses:\s*(\.\/?|[\w.-]+\/pocp@\S*)\s*(#.*)?$/.test(l) || /^\s*-\s*run:.*\bpocp(\.js)?\s+verify\b/.test(l))) jobs.add(job);
  }
  return [...jobs];
}
