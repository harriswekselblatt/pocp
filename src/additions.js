// Fast mode with guard.additions "accept": deciding whether a test edit only ADDS checks.
//
// Fast mode plants no bugs, so it can't measure whether a test edit still catches what the old
// tests caught. Before 2026-11 it accepted any edit that only added non-risky lines, and that rule
// was dropped: added lines alone can disable existing assertions (`if (false) {` … `}` around
// them, an opened comment, an early return, a redefined test, a def inserted mid-test that takes
// over the rest of its body, a shadowed constant, a patched module). This module accepts a much
// narrower shape and sends everything else to a person:
//
//   1. The base file's lines appear unchanged and in order in the new file (nothing edited or
//      removed), or the file is new.
//   2. Each block of added lines stands on its own: brackets, strings and comments that open in
//      it close in it, so it can't wrap or swallow existing code.
//   3. Each block's top-level lines are whole declarations only: tests, functions, imports,
//      constants with literal values. No statement runs where the block was inserted. In Python,
//      the block can't sit above lines indented deeper than it (they would become its body).
//   4. No declared name already appears in the base file (no shadowing or redefinition), except
//      re-importing the same name from the same module.
//      (So an early return can't sit in an existing test; inside an added function it ends only
//      that function, which is allowed.)
//   5. No added line does something that can reach other tests: risky patterns (skips, exits,
//      hooks, mocks, patched assertions), assignments to anything not created in the added code,
//      setattr/Reflect/Object.assign, eval, global, Go init/TestMain.
//   6. The language is one this module parses (JavaScript/TypeScript, Python, Go).
//
// It stays a heuristic. An added test can still change shared state through a function call
// (`registry.register(fake)`), which no text rule can judge; deep mode (planted bugs) is the
// mechanical check. The old tests must also pass on the new code before this runs (guard-check.js).

const LANGS = [
  [/\.(?:[cm]?[jt]sx?)$/, 'js'],
  [/\.py$/, 'py'],
  [/\.go$/, 'go'],
];

export function languageOf(path) {
  for (const [re, lang] of LANGS) if (re.test(path)) return lang;
  return null;
}

/**
 * Align base inside next: base's lines must appear in order. Returns the added blocks as
 * { start, end } line ranges of next (end exclusive) and, for each, the index in next of the
 * existing line right after it (or null at the end), or null if base isn't a subsequence.
 * Any alignment is a true decomposition of next into base plus insertions, so checking the
 * blocks of this one is enough.
 */
export function alignAdditions(baseLines, nextLines) {
  const kept = new Array(nextLines.length).fill(false);
  let j = 0;
  for (let i = 0; i < nextLines.length && j < baseLines.length; i++) {
    if (nextLines[i] === baseLines[j]) {
      kept[i] = true;
      j++;
    }
  }
  if (j < baseLines.length) return null;
  const blocks = [];
  for (let i = 0; i < nextLines.length; i++) {
    if (kept[i]) continue;
    const start = i;
    while (i < nextLines.length && !kept[i]) i++;
    blocks.push({ start, end: i, after: i < nextLines.length ? i : null });
  }
  return blocks;
}

// --- Tokenizing: bracket depth per line, with strings and comments skipped -----------------------

/**
 * Scan source text, tracking (), [] and {} depth outside strings and comments. Returns, per
 * line, the depth at its start and whether it starts inside a string or comment; and `ok`
 * false when a bracket closes below zero or anything is still open at the end.
 */
export function scan(text, lang) {
  const lines = [];
  let depth = 0;
  let ok = true;
  let i = 0;
  let lineStart = true;
  let state = null; // null | 'block' | { q: quote, triple: bool } | 'template'
  const templateDepths = []; // JS: the depth at which each ${ … } in a template returns
  let prevSignificant = '';
  const n = text.length;
  const startLine = () => {
    lines.push({ depth, inString: state !== null });
    lineStart = false;
  };
  while (i < n) {
    if (lineStart) startLine();
    const ch = text[i];
    const next = text[i + 1];
    if (ch === '\n') {
      if (state && state !== 'block' && state !== 'template' && !state.triple && !state.raw) {
        // An unterminated single-line string: unparseable as far as we're concerned.
        ok = false;
        state = null;
      }
      i++;
      lineStart = true;
      continue;
    }
    if (state === 'block') {
      if (ch === '*' && next === '/') {
        state = null;
        i += 2;
      } else i++;
      continue;
    }
    if (state === 'template') {
      if (ch === '\\') { if (text[i + 1] === '\n') { i += 2; lineStart = true; } else i += 2; continue; }
      if (ch === '`') { state = null; i++; prevSignificant = '`'; continue; }
      if (ch === '$' && next === '{') { templateDepths.push(depth); depth++; state = null; i += 2; prevSignificant = '{'; continue; }
      i++;
      continue;
    }
    if (state && typeof state === 'object' && state.raw) {
      // Go raw string: no escapes, spans lines, ends at the next backtick.
      if (ch === '`') { state = null; prevSignificant = 'x'; }
      i++;
      continue;
    }
    if (state && typeof state === 'object') {
      // An escaped newline still ends the line for counting.
      if (ch === '\\' && !(lang === 'go' && state.q === '`')) {
        // Escaped newline: the string continues, and the next line still counts.
        if (text[i + 1] === '\n') lineStart = true;
        i += 2;
        continue;
      }
      if (state.triple) {
        if (text.startsWith(state.q.repeat(3), i)) { state = null; i += 3; prevSignificant = 'x'; continue; }
        i++;
        continue;
      }
      if (ch === state.q) { state = null; i++; prevSignificant = 'x'; continue; }
      i++;
      continue;
    }
    // Code.
    if (ch === ' ' || ch === '\t' || ch === '\r') { i++; continue; }
    if (lang === 'py' && ch === '#') { while (i < n && text[i] !== '\n') i++; continue; }
    if (lang !== 'py' && ch === '/' && next === '/') { while (i < n && text[i] !== '\n') i++; continue; }
    if (lang !== 'py' && ch === '/' && next === '*') { state = 'block'; i += 2; continue; }
    if (lang === 'py' && (ch === '"' || ch === "'")) {
      const triple = text.startsWith(ch.repeat(3), i);
      state = { q: ch, triple };
      i += triple ? 3 : 1;
      continue;
    }
    if (lang === 'js' && ch === '`') { state = 'template'; i++; continue; }
    if (lang === 'go' && ch === '`') { state = { q: '`', raw: true }; i++; continue; }
    if (ch === '"' || ch === "'") { state = { q: ch, triple: false }; i++; continue; }
    if (lang === 'js' && ch === '/' && regexAllowedAfter(prevSignificant)) {
      // A regex literal: skip to its closing slash (classes may contain '/').
      let k = i + 1;
      let inClass = false;
      while (k < n && text[k] !== '\n') {
        if (text[k] === '\\') { k += text[k + 1] === '\n' ? 1 : 2; continue; }
        if (text[k] === '[') inClass = true;
        else if (text[k] === ']') inClass = false;
        else if (text[k] === '/' && !inClass) break;
        k++;
      }
      if (k >= n || text[k] !== '/') { ok = false; i++; continue; }
      i = k + 1;
      while (i < n && /[a-z]/i.test(text[i])) i++;
      prevSignificant = 'x';
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') {
      if (lang === 'js' && ch === '}' && templateDepths.length && templateDepths.at(-1) === depth - 1) {
        depth--;
        templateDepths.pop();
        state = 'template';
        i++;
        continue;
      }
      depth--;
      if (depth < 0) { ok = false; depth = 0; }
    }
    prevSignificant = /[\w$]/.test(ch) ? 'w' : ch;
    // Track a keyword before a regex: `return /x/`.
    if (/[\w$]/.test(ch)) {
      let k = i;
      while (k < n && /[\w$]/.test(text[k])) k++;
      const word = text.slice(i, k);
      prevSignificant = /^(return|typeof|case|in|of|void|yield|await|delete|throw|new)$/.test(word) ? '(' : 'w';
      i = k;
      continue;
    }
    i++;
  }
  if (lineStart && text.length && text.endsWith('\n')) { /* trailing newline: no extra line */ }
  if (depth !== 0 || state !== null) ok = false;
  return { ok, lines };
}

function regexAllowedAfter(prev) {
  return prev === '' || /[(,=:[!&|?{};+\-*%<>~^]/.test(prev);
}

// --- Declarations -----------------------------------------------------------------------------

const JS_LITERAL = String.raw`(?:-?\d[\w.]*|'[^']*'|"[^"]*"|\x60[^\x60$]*\x60|true|false|null|undefined|\[|\{|\(?\s*\(?[\w\s,{}[\]=.]*\)?\s*=>|async\s*(?:\(|\w+\s*=>)|function\b)`;
const JS_DECL = [
  // import with bindings (a bare `import 'x'` runs a module for its side effects)
  [new RegExp(String.raw`^import\s+(?:type\s+)?(?:[\w$]+\s*,?\s*)?(?:\*\s+as\s+[\w$]+|\{[^}]*\})?\s*from\s*['"]([^'"]+)['"]`), 'import'],
  [new RegExp(String.raw`^import\s+([\w$]+)\s+from\s*['"]([^'"]+)['"]`), 'import'],
  [new RegExp(String.raw`^(?:const|let|var)\s+(?:[\w$]+|\{[^}]*\})\s*=\s*require\(\s*['"]([^'"]+)['"]\s*\)\s*;?\s*$`), 'require'],
  [new RegExp(String.raw`^(?:export\s+)?(?:const|let|var)\s+([\w$]+)\s*(?::\s*[\w$<>[\], |]+)?\s*=\s*${JS_LITERAL}`), 'const'],
  [/^(?:export\s+)?(?:async\s+)?function\s*\*?\s*([\w$]+)\s*\(/, 'function'],
  [/^(?:test|it|describe|suite|context|bench)(?:\.(?:each|concurrent|serial|sequential|cb))*\s*[(`]/, 'test'],
  [/^(?:test|it|describe)\.each\s*\(/, 'test'],
  [/^(?:export\s+)?(?:type|interface)\s+([\w$]+)/, 'type'],
];
const GO_DECL = [
  [/^import\s/, 'import'],
  [/^func\s+(?:\(\s*\w+\s+\*?[\w.[\]]+\s*\)\s*)?(\w+)\s*(?:\[[^\]]*\])?\s*\(/, 'function'],
  [/^type\s+(\w+)\s/, 'type'],
  [/^const\s+(\w+)\b/, 'const'],
  [/^const\s*\(/, 'const'],
  [/^var\s+(\w+)\s+[\w.*[\]]+\s*$/, 'var'],
  [/^var\s+(\w+)\s*(?:[\w.*[\]]+\s*)?=\s*(?:-?\d[\w.]*|"[^"]*"|`[^`]*`|true|false|nil)\s*$/, 'var'],
];
const PY_LITERAL = String.raw`(?:-?\d[\w.]*|[rbuf]*'[^']*'|[rbuf]*"[^"]*"|True|False|None|\[|\{|\(|lambda\b|frozenset\(|set\(|dict\(|list\(|tuple\()`;
const PY_DECL = [
  [/^(?:async\s+)?def\s+(\w+)\s*\(/, 'function'],
  [/^class\s+(\w+)\b/, 'class'],
  [/^@[\w.]+/, 'decorator'],
  [/^import\s+([\w.]+(?:\s+as\s+\w+)?(?:\s*,\s*[\w.]+(?:\s+as\s+\w+)?)*)\s*$/, 'import'],
  [/^from\s+([\w.]+)\s+import\s+/, 'import'],
  [new RegExp(String.raw`^(\w+)\s*(?::\s*[\w.[\], |]+)?\s*=\s*${PY_LITERAL}`), 'const'],
  [/^pass\s*$/, 'pass'],
];

const isCommentOrBlank = (line, lang) => {
  const t = line.trim();
  if (!t) return true;
  if (lang === 'py') return t.startsWith('#');
  return t.startsWith('//') || (t.startsWith('/*') && t.endsWith('*/'));
};

// Names a declaration line binds, for the shadowing check.
function declaredNames(line, lang) {
  const t = line.trim();
  const names = [];
  if (lang === 'js') {
    let m = t.match(/^import\s+(?:type\s+)?([\w$]+)?\s*,?\s*(?:\*\s+as\s+([\w$]+)|\{([^}]*)\})?\s*from/);
    if (m) {
      if (m[1]) names.push(m[1]);
      if (m[2]) names.push(m[2]);
      if (m[3]) names.push(...m[3].split(',').map((s) => s.trim().split(/\s+as\s+/).at(-1).trim()).filter(Boolean));
      return names;
    }
    m = t.match(/^(?:export\s+)?(?:const|let|var)\s+(?:([\w$]+)|\{([^}]*)\})/);
    if (m) {
      if (m[1]) names.push(m[1]);
      if (m[2]) names.push(...m[2].split(',').map((s) => s.trim().split(/\s*:\s*/).at(-1).trim()).filter(Boolean));
      return names;
    }
    m = t.match(/^(?:export\s+)?(?:async\s+)?function\s*\*?\s*([\w$]+)/) || t.match(/^(?:export\s+)?(?:type|interface)\s+([\w$]+)/);
    if (m) names.push(m[1]);
    return names;
  }
  if (lang === 'py') {
    let m = t.match(/^(?:async\s+)?def\s+(\w+)/) || t.match(/^class\s+(\w+)/);
    if (m) return [m[1]];
    m = t.match(/^import\s+(.+)$/);
    if (m) return m[1].split(',').map((s) => s.trim().split(/\s+as\s+/).at(-1).split('.')[0].trim());
    m = t.match(/^from\s+[\w.]+\s+import\s+\(?([^)#]*)/);
    if (m) return m[1].split(',').map((s) => s.trim().split(/\s+as\s+/).at(-1).trim()).filter(Boolean);
    m = t.match(/^(\w+)\s*(?::[^=]+)?=/);
    if (m) return [m[1]];
    return [];
  }
  let m = t.match(/^func\s+(?:\(\s*\w+\s+\*?[\w.[\]]+\s*\)\s*)?(\w+)/) || t.match(/^(?:type|const|var)\s+(\w+)/);
  if (m) {
    // A method's name lives on its type; only free functions share the package namespace.
    if (/^func\s+\(/.test(t)) return [];
    return [m[1]];
  }
  return [];
}

function importSource(line, lang) {
  const t = line.trim();
  if (lang === 'js') return t.match(/from\s*['"]([^'"]+)['"]/)?.[1] || t.match(/require\(\s*['"]([^'"]+)['"]/)?.[1] || null;
  if (lang === 'py') return t.match(/^from\s+([\w.]+)\s+import/)?.[1] || (t.match(/^import\s+([\w.]+)/)?.[1] ?? null);
  return null;
}

// --- Risky added code ---------------------------------------------------------------------------

const RISKY = {
  all: [
    [/\beval\s*\(/, 'calls eval'],
  ],
  js: [
    [/\b(?:test|it|describe)\.(?:skip|only|todo|failing)\b|\bx(?:it|describe|test)\s*\(|\bt\.(?:skip|todo)\b|\bthis\.skip\s*\(|\{\s*(?:skip|only|todo)\s*:\s*true/, 'skips, focuses or inverts tests (failing)'],
    [/\bprocess\.(?:exit|abort|kill|reallyExit)\s*\(|\bprocess\.exitCode\b|\bprocess\.on\s*\(/, 'exits the process or handles its exit'],
    [/\b(?:before|after|beforeEach|afterEach|beforeAll|afterAll|setup|teardown)\s*\(|\b(?:test|t)\.(?:before|after|beforeEach|afterEach)\b/, 'adds a test hook'],
    [/\b(?:jest|vi)\.(?:mock|doMock|spyOn|stubGlobal|stubEnv)\s*\(|\bmock\.(?:module|method|fn|timers)\b|\bsinon\.|\bnock\s*\(/, 'mocks or stubs a module or function'],
    [/\bObject\.(?:assign|defineProperty|defineProperties|setPrototypeOf)\s*\(\s*(?!\{)/, 'patches an object (Object.assign/defineProperty)'],
    [/\bReflect\.(?:set|defineProperty|deleteProperty|setPrototypeOf)\b/, 'patches an object (Reflect)'],
    [/\bdelete\s+[\w$]+\s*[.[]/, 'deletes a property (delete)'],
    [/\bnew\s+Function\s*\(|\bFunction\s*\(\s*['"`]/, 'builds code from a string (eval)'],
    [/__(?:define|lookup)(?:Getter|Setter)__|\b__proto__\b|\.prototype\b/, 'patches a prototype'],
    [/\bglobalThis\b|\bglobal\.\w|\bwindow\.\w/, 'changes a global'],
    [/\brequire\.cache\b|\bmodule\.(?:constructor|exports)\b|\bexports\.\w/, 'changes the module system'],
    [/\bcatch\s*(?:\([^)]*\))?\s*\{\s*\}/, 'swallows errors'],
  ],
  py: [
    [/\bpytest\.(?:skip|exit|xfail|importorskip)\b|@pytest\.mark\.(?:skip|skipif|xfail)\b|\bunittest\.skip|\bskipTest\s*\(|\bexpectedFailure\b|\bSkipTest\b/, 'skips or inverts tests (skip)'],
    [/\bsys\.exit\s*\(|\bos\._exit\s*\(|\bSystemExit\b|\bos\.kill\s*\(/, 'exits the process'],
    [/@pytest\.fixture\b|\bdef\s+(?:setUp|tearDown|setUpClass|tearDownClass|setup_method|teardown_method|setup_module|teardown_module|setup_function|teardown_function)\b|\baddCleanup\s*\(/, 'adds a test hook or fixture'],
    [/\bmonkeypatch\b|\bmock\.patch\b|\bpatch\s*\(|\bpatch\.object\b|\bMagicMock\b/, 'mocks or stubs a module or function'],
    [/\bsetattr\s*\(|\bdelattr\s*\(|\b(?:globals|locals|vars)\s*\(\s*\)|__dict__|__builtins__|\bbuiltins\b|\bimportlib\b|__import__/, 'patches a module or object (setattr, globals, builtins)'],
    [/\bsys\.modules\b|\bsys\.path\b|\bsys\.(?:settrace|setprofile)\b/, 'changes the import system (sys.modules)'],
    [/\bglobal\s+\w|\bnonlocal\s+\w/, 'assigns a global or nonlocal name (global)'],
    [/\bexec\s*\(|\bcompile\s*\(/, 'builds code from a string (exec)'],
    [/\bexcept\b[^:]*:\s*pass\b/, 'swallows errors'],
    [/^\s*del\s+\w+\s*[.[]/, 'deletes a module attribute (del)'],
  ],
  go: [
    [/\bt\.(?:Skip|SkipNow|Skipf)\b|\btesting\.Short\s*\(/, 'skips tests (Skip)'],
    [/\bos\.Exit\s*\(|\bruntime\.Goexit\s*\(|\bsyscall\.(?:Exit|Kill)\b/, 'exits the process'],
    [/\bfunc\s+init\s*\(|\bfunc\s+TestMain\s*\(/, 'adds a test hook (init or TestMain)'],
    [/\bunsafe\.|go:linkname|\breflect\.\w+\([^)]*\)\.(?:Set|Elem)\b/, 'writes memory directly (unsafe, linkname, reflect)'],
    [/^\s*\*+\s*\(?\s*[\w.]+\s*\)?\s*(?:=|\+=|-=)(?!=)/, 'writes through a pointer (assigns)'],
    [/\bos\.(?:Setenv|Unsetenv|Chdir|Clearenv)\s*\(/, 'changes the process environment'],
  ],
};

// Names the added code creates itself: assigning to their attributes can't reach other tests.
function freshLocals(text, lang) {
  const out = new Set(['this', 'self', 'cls', '_']);
  const add = (re) => { for (const m of text.matchAll(re)) for (const n of m[1].split(',')) if (n.trim()) out.add(n.trim()); };
  if (lang === 'js') {
    add(/\b(?:const|let|var)\s+([\w$]+)\s*(?::[^=]+)?=\s*(?:\{|\[|-?\d|'|"|`|true\b|false\b|null\b|new\s+(?!Proxy\b)[A-Z][\w$]*\s*\()/g);
  } else if (lang === 'py') {
    add(/^\s*(\w+)\s*=\s*(?:\{|\[|\(|-?\d|'|"|[A-Z]\w*\(|dict\(|list\(|set\()/gm);
  } else {
    add(/\b(\w+)\s*:=\s*(?:&?[\w.]*\{|\[\]|make\(|new\(|-?\d|"|`)/g);
    add(/\bvar\s+(\w+)\s+[\w.*[\]]+/g);
  }
  return out;
}

// Every name the added code declares anywhere (locals, parameters, loop variables): bare
// assignments to anything else reach state outside the added code (Go/JS package or file scope).
function declaredAnywhere(text, lang) {
  const out = new Set(['_']);
  const add = (s) => { for (const n of s.split(',')) { const v = n.trim().replace(/^\.\.\./, '').split(/[\s:=]/)[0]; if (v) out.add(v); } };
  if (lang === 'js') {
    for (const m of text.matchAll(/\b(?:const|let|var)\s+([\w$]+)/g)) out.add(m[1]);
    for (const m of text.matchAll(/\b(?:const|let|var)\s+\{([^}]*)\}/g)) add(m[1]);
    for (const m of text.matchAll(/\b(?:const|let|var)\s+\[([^\]]*)\]/g)) add(m[1]);
    for (const m of text.matchAll(/\bfunction\s*\*?\s*[\w$]*\s*\(([^)]*)\)/g)) add(m[1]);
    for (const m of text.matchAll(/\(([^()]*)\)\s*=>/g)) add(m[1]);
    for (const m of text.matchAll(/\b([\w$]+)\s*=>/g)) out.add(m[1]);
    for (const m of text.matchAll(/\bfor\s*\(\s*(?:const|let|var)\s+([\w$]+)/g)) out.add(m[1]);
  } else if (lang === 'go') {
    for (const m of text.matchAll(/([\w, ]+):=/g)) add(m[1]);
    for (const m of text.matchAll(/\bvar\s+(\w+)/g)) out.add(m[1]);
    for (const m of text.matchAll(/\bfunc\s*(?:\([^)]*\)\s*)?\w*\s*\(([^)]*)\)/g)) for (const p of m[1].split(',')) { const v = p.trim().split(/\s+/)[0]; if (v) out.add(v); }
    for (const m of text.matchAll(/\bfor\s+([\w, ]+)\s*:=/g)) add(m[1]);
  }
  return out;
}

function riskyLine(line, lang, locals, declared) {
  for (const [re, why] of [...RISKY.all, ...RISKY[lang]]) if (re.test(line)) return why;
  // Attribute or subscript assignment: allowed only on objects the added code created.
  const code = lang === 'py' ? line.replace(/#.*$/, '') : line.replace(/\/\/.*$/, '');
  const assign = /(^|[^\w$.\]])([A-Za-z_$][\w$]*)((?:\s*\.\s*[A-Za-z_$][\w$]*|\s*\[[^\]]*\])+)\s*(?:[-+*/%&|^]|\*\*|<<|>>|>>>|&&|\|\||\?\?)?=(?![=>])/g;
  for (const m of code.matchAll(assign)) {
    if (!locals.has(m[2])) return `assigns to an attribute of ${m[2]}, which the added code did not create`;
  }
  // Bare assignment to a name the added code never declared (Go package or JS file scope).
  if (lang !== 'py') {
    const bare = code.match(/^\s*([A-Za-z_$][\w$]*(?:\s*,\s*[A-Za-z_$][\w$]*)*)\s*(?:[-+*/%&|^]|<<|>>|&&|\|\||\?\?)?=(?![=>])/);
    if (bare) {
      for (const n of bare[1].split(',').map((s) => s.trim())) if (!declared.has(n)) return `assigns ${n}, which the added code did not declare`;
    }
    const step = code.match(/^\s*([A-Za-z_$][\w$]*)\s*(?:\+\+|--)/);
    if (step && !declared.has(step[1])) return `assigns ${step[1]}, which the added code did not declare`;
  }
  return null;
}

// --- The judgment -------------------------------------------------------------------------------

const indentOf = (line) => line.match(/^[ \t]*/)[0].replace(/\t/g, '    ').length;

/**
 * Decide whether next only adds declarations to base. `base` null means a new file.
 * Returns { ok: true } or { ok: false, why }.
 */
export function judgeAdditions({ path, base, next }) {
  const lang = languageOf(path);
  if (!lang) return { ok: false, why: 'lines were added to a test in a language POCP does not parse for fast-mode additions' };
  const nextLines = next.split('\n');
  const baseLines = base === null || base === undefined ? [] : base.split('\n');
  if (base !== null && base !== undefined && base.endsWith('\n') && !next.endsWith('\n')) {
    return { ok: false, why: 'existing test lines were changed or removed' };
  }
  const blocks = alignAdditions(baseLines, nextLines);
  if (!blocks) return { ok: false, why: 'existing test lines were changed or removed' };
  if (!blocks.length) return { ok: true };
  // The new file must parse as a whole (balanced), so depths and indentation mean something.
  if (!scan(next, lang).ok) return { ok: false, why: 'the new file has unbalanced brackets, strings or comments' };
  const baseText = baseLines.join('\n');
  const baseWords = new Set(baseText.match(/[A-Za-z_$][\w$]*/g) || []);

  for (const { start, end, after } of blocks) {
    const blockLines = nextLines.slice(start, end);
    const text = blockLines.join('\n');
    const s = scan(`${text}\n`, lang);
    if (!s.ok) return { ok: false, why: `added lines ${start + 1}-${end} open a bracket, string or comment they don't close` };
    const where = `added lines ${start + 1}-${end}`;

    // Top-level lines of the block: whole declarations only.
    const nonBlank = blockLines.map((l, k) => ({ l, k })).filter(({ l }) => l.trim());
    if (!nonBlank.length) continue;
    let topIndent = 0;
    if (lang === 'py') {
      const codeLines = nonBlank.filter(({ k }) => s.lines[k].depth === 0 && !s.lines[k].inString && !blockLines[k].trim().startsWith('#'));
      topIndent = codeLines.length ? Math.min(...codeLines.map(({ l }) => indentOf(l))) : 0;
      if (codeLines.length && indentOf(codeLines[0].l) !== topIndent) return { ok: false, why: `${where} start inside an indented block` };
      if (after !== null) {
        const following = nextLines.slice(after).find((l) => l.trim() && !l.trim().startsWith('#'));
        if (following !== undefined && indentOf(following) > topIndent) {
          return { ok: false, why: `${where} sit above lines indented deeper than them, which would become their body (inside an existing block)` };
        }
      }
    }
    const declaredHere = [];
    let pyClassIndent = null;
    for (const { l, k } of nonBlank) {
      if (s.lines[k].inString || s.lines[k].depth !== 0) continue;
      if (isCommentOrBlank(l, lang)) continue;
      if (lang === 'py') {
        const ind = indentOf(l);
        // Inside an added class: its body runs when the class is defined, so it must be
        // declarations too. Inside an added def: runs only when called.
        if (ind > topIndent) {
          if (pyClassIndent !== null && ind > pyClassIndent.indent && (pyClassIndent.body === null || ind === pyClassIndent.body)) {
            if (pyClassIndent.body === null) pyClassIndent.body = ind;
            if (!matchesDecl(l.trim(), PY_DECL) && !/^(?:[rbuf]*'''|[rbuf]*"""|[rbuf]*'|[rbuf]*")/.test(l.trim())) {
              return { ok: false, why: `${where}: a class body line runs code when the class is defined, not a declaration ("${l.trim().slice(0, 60)}")` };
            }
          }
          continue;
        }
        pyClassIndent = /^class\s/.test(l.trim()) ? { indent: ind, body: null } : null;
      }
      const decl = matchesDecl(l.trim(), lang === 'js' ? JS_DECL : lang === 'go' ? GO_DECL : PY_DECL);
      if (!decl) return { ok: false, why: `${where}: a top-level line is not a whole declaration (a test, function, import or literal constant): "${l.trim().slice(0, 60)}"` };
      if (lang === 'py' && /^(?:pytest_plugins|__\w+__)\s*=/.test(l.trim())) return { ok: false, why: `${where}: a top-level line is not a whole declaration ("${l.trim().slice(0, 60)}")` };
      for (const name of declaredNames(l, lang)) declaredHere.push({ name, line: l });
    }

    // No shadowing or redefinition of anything the base file mentions.
    for (const { name, line } of declaredHere) {
      if (!baseWords.has(name)) continue;
      const src = importSource(line, lang);
      if (src && sameImportInBase(baseLines, src, name, lang)) continue;
      return { ok: false, why: `${where} declare ${name}, which the file already uses (it would shadow or redefine it)` };
    }

    // Risky lines anywhere in the block, including nested bodies.
    const locals = freshLocals(text, lang);
    const declared = declaredAnywhere(text, lang);
    for (const name of declaredHere.map((d) => d.name)) declared.add(name);
    for (const { l, k } of nonBlank) {
      if (s.lines[k].inString) continue;
      const why = riskyLine(l, lang, locals, declared);
      if (why) return { ok: false, why: `an added line ${why} (line ${start + k + 1})` };
    }
    // Joined, so a call split over lines still matches the patterns.
    const joined = blockLines.map((l) => l.trim()).join(' ').replace(/\s*\.\s*/g, '.');
    for (const [re, why] of [...RISKY.all, ...RISKY[lang]]) {
      if (re.source.startsWith('^')) continue;
      if (re.test(joined)) return { ok: false, why: `an added line ${why}` };
    }
  }
  return { ok: true };
}

function matchesDecl(trimmed, table) {
  for (const [re, kind] of table) if (re.test(trimmed)) return kind;
  return null;
}

function sameImportInBase(baseLines, src, name, lang) {
  return baseLines.some((b) => importSource(b, lang) === src && new RegExp(`\\b${name.replace(/[$]/g, '\\$')}\\b`).test(b));
}
