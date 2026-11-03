import { spawnSync } from 'node:child_process';
import path from 'node:path';
import * as g from './git.js';
import { matchGlob } from './glob.js';

// What decides what a test run means, beyond the test files themselves. A change to any of
// these can hollow out a check without touching its command, so the test guard treats them
// like test files. Three kinds:
//
// 1. Test settings inside files that also hold other things: package.json keys and
//    pyproject.toml / setup.cfg sections. Only the test part is compared and restored, so a
//    dependency bump in the same file isn't a test change.
// 2. Files a runner config names (setupFiles, globalSetup, require, ...): a setup file can
//    skip every test in one line.
// 3. Files a required check's command names (node --test test/a.test.js, bash
//    scripts/check.sh), and the files of the package scripts those commands run.
// 4. Test helpers: files the tests import, followed transitively (testHelperFiles), other
//    than the code the required checks guard. Hollowing an assertion helper hollows every
//    test that calls it.
// 5. Rust tests inside source files: the #[cfg(test)] items of a .rs file are its test part,
//    compared and restored like the test settings in kind 1.

// package.json keys that configure a test runner (scripts included: `npm test` runs one).
export const PACKAGE_TEST_KEYS = Object.freeze(['scripts', 'jest', 'mocha', 'ava', 'nyc', 'c8', 'tap']);

// Files whose test settings live in named sections.
const SECTION_FILES = [
  { glob: '**/pyproject.toml', section: /^tool\.(pytest|nose|ward|hatch\.envs\.(test|tests|default))(\.|$)/ },
  { glob: '**/setup.cfg', section: /^tool:pytest$/ },
];

const isPackageJson = (rel) => /(^|\/)package\.json$/.test(rel);
export const isRust = (rel) => /\.rs$/.test(rel);
const sectionRule = (rel) => SECTION_FILES.find((s) => matchGlob(rel, s.glob)) || null;

/** True for files whose test part is compared on its own (package.json, pyproject.toml, setup.cfg). */
export function hasTestSettings(rel) {
  return isPackageJson(rel) || Boolean(sectionRule(rel)) || isRust(rel);
}

/** The kind the guard reports for such a file. */
export function settingsKind(rel) {
  return isPackageJson(rel) ? 'package-scripts' : isRust(rel) ? 'inline-tests' : 'config-section';
}

/** INI/TOML sections as [{ name, start, end }] (end exclusive). Lines before the first header are skipped. */
function sections(text) {
  const lines = text.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    // Headers start the line; an indented "[" is a value inside a multi-line array.
    const m = /^\[\[?\s*([\w.:"' -]+?)\s*\]\]?\s*([#;].*)?$/.exec(lines[i]);
    if (!m) continue;
    if (out.length) out[out.length - 1].end = i;
    out.push({ name: m[1].replace(/^"|"$/g, ''), start: i, end: lines.length });
  }
  return { lines, list: out };
}

/**
 * The test-relevant part of a file, as a comparable string, or null when the file can't be
 * read that way (invalid JSON). Files without test settings return their whole text.
 */
export function testSettings(rel, text) {
  if (text === null || text === undefined) return null;
  if (isPackageJson(rel)) {
    try {
      const pkg = JSON.parse(text);
      return JSON.stringify(PACKAGE_TEST_KEYS.map((k) => [k, pkg[k] ?? null]));
    } catch {
      return null;
    }
  }
  if (isRust(rel)) return rustTestParts(text).join('\n\f\n');
  const rule = sectionRule(rel);
  if (!rule) return text;
  const { lines, list } = sections(text);
  return list.filter((s) => rule.section.test(s.name)).map((s) => lines.slice(s.start, s.end).join('\n').trimEnd()).join('\n');
}

/**
 * `now` with its test part put back as it was in `before`. Everything else in `now` stays.
 * Returns null when that can't be done safely (unreadable JSON); restore the whole file then.
 */
export function restoreTestSettings(rel, before, now) {
  if (isPackageJson(rel)) {
    try {
      const old = before === null ? {} : JSON.parse(before);
      const cur = JSON.parse(now);
      for (const k of PACKAGE_TEST_KEYS) {
        if (old[k] === undefined) delete cur[k];
        else cur[k] = old[k];
      }
      return `${JSON.stringify(cur, null, 2)}\n`;
    } catch {
      return null;
    }
  }
  if (isRust(rel)) return restoreRustTests(before, now);
  const rule = sectionRule(rel);
  if (!rule) return before;
  const cur = sections(now);
  const kept = [];
  let i = 0;
  for (const s of cur.list.filter((x) => rule.section.test(x.name))) {
    kept.push(...cur.lines.slice(i, s.start));
    i = s.end;
  }
  kept.push(...cur.lines.slice(i));
  const old = before === null ? '' : testSettings(rel, before);
  const body = kept.join('\n').replace(/\s*$/, '\n');
  return old ? `${body}\n${old}\n` : body;
}

// Runner config keys whose values name files the runner loads before or around the tests.
const SETUP_KEYS = /\b(setupFiles(?:AfterEnv)?|setupFilesAfterEach|globalSetup|globalTeardown|setupFile|setup|require|import|loader|testSequencer|snapshotResolver|resolver|testEnvironment|environment|reporters?|testRunner|runner|preset|spec)\b["']?\s*[:=]\s*(\[[^\]]*\]|\{[^}]*\}|"[^"]*"|'[^']*'|`[^`]*`)/g;
const GUESS_EXT = ['', '.ts', '.js', '.mjs', '.cjs', '.tsx', '.jsx', '.mts', '.cts', '.py'];

function resolveRef(ref, dir, files) {
  const clean = ref.replace(/^<rootDir>\//, '').replace(/^\.\//, '');
  if (!clean || clean.startsWith('/') || /^[a-z][\w+.-]*:/i.test(clean) || clean.includes('*')) return null;
  for (const base of new Set([path.posix.normalize(path.posix.join(dir, clean)), path.posix.normalize(clean)])) {
    if (base.startsWith('..')) continue;
    for (const ext of GUESS_EXT) if (files.has(base + ext)) return base + ext;
  }
  return null;
}

/** Files a runner config names under its setup keys, resolved against tracked files. */
export function configReferences(rel, text, files) {
  const out = new Set();
  const dir = path.posix.dirname(rel) === '.' ? '' : path.posix.dirname(rel);
  for (const m of String(text || '').matchAll(SETUP_KEYS)) {
    for (const q of m[2].matchAll(/"([^"]+)"|'([^']+)'|`([^`]+)`/g)) {
      const hit = resolveRef(q[1] || q[2] || q[3], dir, files);
      if (hit) out.add(hit);
    }
  }
  return out;
}

/** Tracked files a shell command names (including `--flag=value` forms), relative to `cwd`. */
export function commandReferences(command, cwd, files) {
  const out = new Set();
  const dir = (cwd || '').replace(/^\.\/?/, '').replace(/\/$/, '');
  for (let tok of String(command || '').split(/\s+|&&|\|\||[;|()]/)) {
    tok = tok.replace(/^["']|["']$/g, '');
    if (tok.startsWith('-')) tok = tok.includes('=') ? tok.slice(tok.indexOf('=') + 1) : '';
    if (!tok || !/[./]/.test(tok)) continue;
    const clean = tok.replace(/^\.\//, '');
    if (clean.includes('*') || clean.startsWith('/') || clean.startsWith('..')) continue;
    const full = path.posix.normalize(dir ? path.posix.join(dir, clean) : clean);
    if (files.has(full)) out.add(full);
  }
  return out;
}

/** Package scripts a command runs: `npm test` → test (with pre/post), `npm run x` → x. */
export function scriptsRun(command) {
  const names = new Set();
  const c = String(command || '');
  for (const m of c.matchAll(/\b(?:npm|pnpm|yarn|bun)\s+(?:--?\S+\s+)*(test|t|run(?:-script)?\s+([\w:.-]+)|([\w:.-]+))/g)) {
    const name = m[2] || (m[1] === 't' || m[1] === 'test' ? 'test' : m[3]);
    if (!name || ['install', 'ci', 'add', 'exec', 'x', 'dlx'].includes(name)) continue;
    names.add(name);
    names.add(`pre${name}`);
    names.add(`post${name}`);
  }
  return names;
}

/**
 * Requirement commands from rules, as [{ run, cwd, globs }]. `globs` are the files the
 * requirement guards: a file its command names that it also guards is what the check
 * checks (`node --check src/a.js`), not test setup, unless the command executes it or it
 * matches a test pattern (referencedFiles).
 */
export function requirementCommands(rules) {
  const out = [];
  for (const r of rules?.requirements || []) {
    const o = r.obligation;
    if (!o || typeof o.run !== 'string') continue;
    out.push({ run: o.run, cwd: o.cwd || '', globs: r.globs || (r.glob ? [r.glob] : []) });
  }
  return out;
}

/**
 * Files the test setup at `rev` points to (null: the staged index): files runner configs
 * name, and files required check commands (and the package scripts they run) name. A file
 * the requirement itself guards is left out as the code under check (`node --check src/a.js`)
 * unless the command executes it (`node spec/math_spec.js`, `pytest checks/`) or it matches
 * one of `testGlobs`: then it is the test, wherever it lives.
 */
export function referencedFiles(root, rev, { runnerGlobs = [], commands = [], testGlobs = [] } = {}) {
  const entries = rev ? g.treeEntries(root, rev) : g.indexEntries(root).filter((e) => e.stage === 0);
  const files = new Set(entries.filter((e) => e.mode?.startsWith('100') || e.mode?.startsWith('120')).map((e) => e.path));
  const read = (rel) => (rev ? g.showFile(root, rev, rel) : g.git(root, ['show', `:${rel}`], { allowFail: true, trim: false }));
  const out = new Set();
  const add = (set) => { for (const f of set) out.add(f); };
  for (const rel of files) {
    if (runnerGlobs.some((gl) => matchGlob(rel, gl))) add(configReferences(rel, read(rel), files));
  }
  // Commands, and the package scripts they run (looked up in the package.json of their folder).
  const queue = commands.map((c) => ({ run: c.run, cwd: c.cwd || '', globs: c.globs || [] }));
  const seen = new Set();
  while (queue.length) {
    const { run, cwd, globs } = queue.shift();
    const key = `${cwd}\0${run}`;
    if (seen.has(key) || seen.size > 200) continue;
    seen.add(key);
    const executed = executedReferences(run, cwd, files);
    for (const f of commandReferences(run, cwd, files)) {
      const guardedByIt = globs.some((gl) => matchGlob(f, gl));
      if (!guardedByIt || executed.has(f) || testGlobs.some((gl) => matchGlob(f, gl))) out.add(f);
    }
    const names = scriptsRun(run);
    if (!names.size) continue;
    const pkgRel = cwd ? `${cwd.replace(/\/$/, '')}/package.json` : 'package.json';
    if (!files.has(pkgRel)) continue;
    let pkg;
    try {
      pkg = JSON.parse(read(pkgRel));
    } catch {
      continue;
    }
    for (const n of names) if (typeof pkg.scripts?.[n] === 'string') queue.push({ run: pkg.scripts[n], cwd, globs });
    for (const k of PACKAGE_TEST_KEYS.filter((x) => x !== 'scripts')) if (pkg[k]) add(configReferences(pkgRel, JSON.stringify({ [k]: pkg[k] }), files));
  }
  return out;
}

// ---------------------------------------------------------------------------------------
// Rust: tests inside source files.
//
// A `#[cfg(test)]` item at the top level of a .rs file (usually `mod tests { ... }`) is test
// code that lives next to the code it tests. Its text is the file's test part: changing it is
// a test change, and the guard's old-tests run puts the old items back while the rest of the
// file stays new. Limits: only top-level items count (one nested inside another module is
// treated as source); `#[test]` functions outside a `#[cfg(test)]` item are not seen.
// `#[cfg(test)] mod name;` points to a separate file, which is test code as a whole
// (rustTestModuleFile).

const RUST_TEST_ATTR = /^cfg\((?:all\()?test\b/;

/** Index just past the comment, string or char literal starting at i, or -1 if none starts there. */
function rustSkip(s, i) {
  const c = s[i];
  const d = s[i + 1];
  if (c === '/' && d === '/') {
    const nl = s.indexOf('\n', i);
    return nl === -1 ? s.length : nl + 1;
  }
  if (c === '/' && d === '*') {
    let depth = 1;
    let j = i + 2;
    while (j < s.length && depth) {
      if (s[j] === '/' && s[j + 1] === '*') { depth++; j += 2; } else if (s[j] === '*' && s[j + 1] === '/') { depth--; j += 2; } else j++;
    }
    return depth ? null : j;
  }
  // Raw strings: r"..", r#".."#, br#".."#.
  const raw = /^b?r(#*)"/.exec(s.slice(i, i + 260));
  if (raw && !/[\w]/.test(s[i - 1] || '')) {
    const close = `"${raw[1]}`;
    const end = s.indexOf(close, i + raw[0].length);
    return end === -1 ? null : end + close.length;
  }
  if (c === '"' || (c === 'b' && d === '"' && !/[\w]/.test(s[i - 1] || ''))) {
    let j = c === 'b' ? i + 2 : i + 1;
    while (j < s.length && s[j] !== '"') j += s[j] === '\\' ? 2 : 1;
    return j >= s.length ? null : j + 1;
  }
  if (c === "'") {
    // A char literal ('a', '\n', '\u{1F600}', a surrogate pair) or a lifetime ('a).
    if (d === '\\') {
      const end = s.indexOf("'", i + 3);
      return end === -1 ? null : end + 1;
    }
    if (s[i + 2] === "'") return i + 3;
    if (s[i + 3] === "'" && /[\ud800-\udbff]/.test(d || '')) return i + 4;
    return i + 1;
  }
  return -1;
}

/** Index just past the bracket matching the opener at i, skipping comments and literals, or null. */
function rustMatch(s, i) {
  const open = s[i];
  const close = { '{': '}', '[': ']', '(': ')' }[open];
  let depth = 0;
  for (let j = i; j < s.length;) {
    const k = rustSkip(s, j);
    if (k === null) return null;
    if (k !== -1) { j = k; continue; }
    if (s[j] === open) depth++;
    else if (s[j] === close && --depth === 0) return j + 1;
    j++;
  }
  return null;
}

/**
 * The top-level `#[cfg(test)]` items of a Rust file as [{ start, end, module }] (`module` is
 * the name of a `mod name;` declaration, whose body lives in another file). Null if the file
 * can't be read that way (unbalanced brackets, an unterminated string).
 */
export function rustTestItems(text) {
  const s = String(text ?? '');
  const out = [];
  let depth = 0;
  for (let i = 0; i < s.length;) {
    const k = rustSkip(s, i);
    if (k === null) return null;
    if (k !== -1) { i = k; continue; }
    const c = s[i];
    if (c === '{') { depth++; i++; continue; }
    if (c === '}') { depth--; i++; if (depth < 0) return null; continue; }
    if (depth === 0 && c === '#' && s[i + 1] === '[') {
      const attrEnd = rustMatch(s, i + 1);
      if (attrEnd === null) return null;
      const attr = s.slice(i + 2, attrEnd - 1).replace(/\s+/g, '');
      if (!RUST_TEST_ATTR.test(attr)) { i = attrEnd; continue; }
      // The item it applies to: more attributes and comments, then up to `;` or a braced body.
      let j = attrEnd;
      let end = null;
      while (j < s.length) {
        const kk = rustSkip(s, j);
        if (kk === null) return null;
        if (kk !== -1) { j = kk; continue; }
        if (s[j] === '#' && s[j + 1] === '[') {
          const e = rustMatch(s, j + 1);
          if (e === null) return null;
          j = e;
          continue;
        }
        if (s[j] === ';') { end = j + 1; break; }
        if (s[j] === '{' || s[j] === '(' || s[j] === '[') {
          const e = rustMatch(s, j);
          if (e === null) return null;
          if (s[j] === '{') { end = e; break; }
          j = e;
          continue;
        }
        j++;
      }
      if (end === null) return null;
      const item = s.slice(attrEnd, end);
      const mod = /^\s*(?:pub(?:\([^)]*\))?\s+)?mod\s+(r#)?(\w+)\s*;$/.exec(item.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\/|#\[[^\]]*\]/g, ''));
      out.push({ start: i, end, ...(mod ? { module: mod[2] } : {}) });
      i = end;
      continue;
    }
    i++;
  }
  return depth === 0 ? out : null;
}

/**
 * The test part of a Rust file: the text of its top-level #[cfg(test)] items. A file the
 * lexer can't read falls back to everything from the first "#[cfg(test)]" on.
 */
export function rustTestParts(text) {
  const s = String(text ?? '');
  const items = rustTestItems(s);
  if (items) return items.map((it) => s.slice(it.start, it.end));
  const at = s.search(/#\[\s*cfg\s*\(\s*(all\s*\(\s*)?test\b/);
  return at === -1 ? [] : [s.slice(at)];
}

/** `now` with its #[cfg(test)] items put back as they were in `before`, in order. */
export function restoreRustTests(before, now) {
  const old = before === null || before === undefined ? [] : rustTestParts(before);
  const items = rustTestItems(now);
  if (!items) {
    const at = now.search(/#\[\s*cfg\s*\(\s*(all\s*\(\s*)?test\b/);
    const head = at === -1 ? now : now.slice(0, at);
    return old.length ? `${head.replace(/\s*$/, '\n\n')}${old.join('\n\n')}\n` : head;
  }
  let text = '';
  let pos = 0;
  items.forEach((it, k) => {
    text += now.slice(pos, it.start) + (old[k] ?? '');
    pos = it.end;
  });
  text += now.slice(pos);
  const extra = old.slice(items.length);
  return extra.length ? `${text.replace(/\s*$/, '\n\n')}${extra.join('\n\n')}\n` : text;
}

/** Files a Rust module file `rel` could be declared from (`mod name;` in its parent). */
function rustParents(rel) {
  const m = /^(?:(.*)\/)?([^/]+)\.rs$/.exec(rel);
  if (!m) return { name: null, parents: [] };
  let dir = m[1] || '';
  let name = m[2];
  if (name === 'mod') {
    const up = /^(?:(.*)\/)?([^/]+)$/.exec(dir);
    if (!up) return { name: null, parents: [] };
    dir = up[1] || '';
    name = up[2];
  }
  const parents = [`${dir ? `${dir}/` : ''}lib.rs`, `${dir ? `${dir}/` : ''}main.rs`, `${dir ? `${dir}/` : ''}mod.rs`];
  if (dir) parents.push(`${dir}.rs`);
  return { name, parents };
}

/** True when `rel` is the body of a `#[cfg(test)] mod name;` declared in its parent at `rev`. */
export function rustTestModuleFile(root, rev, rel) {
  if (!isRust(rel)) return false;
  const { name, parents } = rustParents(rel);
  if (!name) return false;
  for (const p of parents) {
    const text = rev ? g.showFile(root, rev, p) : g.git(root, ['show', `:${p}`], { allowFail: true, trim: false });
    if (!text || !text.includes('cfg')) continue;
    if ((rustTestItems(text) || []).some((it) => it.module === name)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------------------
// Which files a required check's command executes, as opposed to files it only reads.
//
// `node --check src/a.js` and `tsc src/a.ts` read the code under check; `node checks/math.js`,
// `bash scripts/check.sh` and `pytest checks/` run the test itself. A file the requirement
// guards is test setup only when the command executes it (or it matches a test pattern), so a
// check whose tests live inside the guarded globs still has them guarded.

// Interpreters: the first file after them is the program; later files are its arguments.
const INTERPRETERS = /^(node|nodejs|deno|bun|tsx|ts-node|esno|python[\d.]*|py|pypy[\d.]*|ruby|perl|php|bash|sh|zsh|dash|ksh|Rscript|lua|elixir|julia)$/;
// Test runners: every file after them is a test.
const RUNNERS = /^(pytest|py\.test|jest|vitest|mocha|ava|tap|tape|uvu|rspec|phpunit|pest|jasmine|karma|cucumber(-js)?|behave|nose2|ward|playwright|cypress)$/;
// Words that run the next word as the command: env, npx, bundle exec, poetry run, ...
const WRAPPERS = /^(env|exec|time|nice|nohup|command|npx|bunx|pnpx|xvfb-run|cross-env|c8|nyc|coverage|dotenv)$/;
const WRAPPER_PAIRS = /^(bundle exec|poetry run|pipenv run|uv run|pdm run|hatch run|rye run|pnpm exec|yarn exec|npm exec|yarn dlx|pnpm dlx|python[\d.]* -m|py -m|deno run|deno test|bun run|bun test|go run|go test|cargo test|dotnet test|coverage run)$/;
// Flags after which an interpreter only reads the file (syntax checks), or runs no file.
const NON_EXEC = /^(--check|-c|-n|--syntax-check|-l|-e|--eval|-p|--print|-m)$/;
// Interpreter flags whose value (the next word) is a file loaded before the program.
const LOAD_FLAGS = /^(--import|--require|-r|--loader|--experimental-loader|--env-file|--preload)$/;
const READ_ONLY_MODULES = /^(py_compile|compileall|pyflakes|flake8|pylint|mypy|black|ruff|isort|pycodestyle)$/;

/**
 * Tracked files a command executes, relative to `cwd`: the program of each command segment
 * (a script path, or the first file after an interpreter), and every file after a test runner
 * or `node --test`. Folders handed to a runner are not expanded.
 */
export function executedReferences(command, cwd, files) {
  const out = new Set();
  const dir = (cwd || '').replace(/^\.\/?/, '').replace(/\/$/, '');
  const resolve = (tok) => {
    if (tok.startsWith('-') || !/[./]/.test(tok)) return [];
    const clean = tok.replace(/^\.\//, '').replace(/\/$/, '');
    if (!clean || clean.includes('*') || clean.startsWith('/') || clean.startsWith('..')) return [];
    const full = path.posix.normalize(dir ? path.posix.join(dir, clean) : clean);
    return files.has(full) ? [full] : [];
  };
  for (const segment of String(command || '').split(/&&|\|\||[;|()\n]/)) {
    const toks = segment.trim().split(/\s+/).map((t) => t.replace(/^["']|["']$/g, '')).filter(Boolean);
    let i = 0;
    // Leading VAR=value assignments and wrappers.
    for (;;) {
      if (i >= toks.length) break;
      if (/^[A-Za-z_]\w*=/.test(toks[i])) { i++; continue; }
      const pair = `${toks[i]} ${toks[i + 1] || ''}`;
      if (WRAPPER_PAIRS.test(pair)) {
        // `python -m pytest`: the module is the runner.
        if (/ -m$/.test(pair)) {
          const mod = toks[i + 2] || '';
          if (READ_ONLY_MODULES.test(mod) || !/^(pytest|unittest|nose2|ward|behave)$/.test(mod)) { i = toks.length; break; }
          toks.splice(i, 3, 'pytest');
          break;
        }
        if (/ test$/.test(pair)) { toks.splice(i, 2, 'pytest'); break; }
        i += 2;
        continue;
      }
      if (WRAPPERS.test(toks[i])) {
        i++;
        while (i < toks.length && (toks[i].startsWith('-') || /^\d+$/.test(toks[i]))) i++;
        continue;
      }
      if (toks[i] === 'timeout') { i += 2; continue; }
      break;
    }
    if (i >= toks.length) continue;
    const prog = toks[i];
    const name = path.posix.basename(prog);
    if (resolve(prog).length) { for (const f of resolve(prog)) out.add(f); continue; }
    const runner = RUNNERS.test(name);
    if (!runner && !INTERPRETERS.test(name)) continue;
    let allFiles = runner;
    for (let j = i + 1; j < toks.length; j++) {
      const t = toks[j];
      if (t.startsWith('-')) {
        if (!runner && t === '--test') { allFiles = true; continue; }
        if (!runner && NON_EXEC.test(t)) break;
        if (LOAD_FLAGS.test(t) && j + 1 < toks.length) for (const f of resolve(toks[++j])) out.add(f);
        continue;
      }
      const hit = resolve(t);
      if (!hit.length) continue;
      for (const f of hit) out.add(f);
      if (!allFiles) break;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------
// Test helpers: what the tests import.
//
// A test that asserts through `eq()` from lib/check.js is only as strong as `eq()`. Files the
// tests import, followed transitively, are test setup unless they are the code the required
// checks guard (and don't look like test support). Imports are read from the source, without
// running anything: relative JavaScript/TypeScript imports and requires, Python imports
// (relative and absolute, from the repository root, src/, and the test's folders), Ruby
// require/require_relative, Go imports of packages in the same module, Java/Kotlin/Scala
// imports of classes in the repository, PHP require/include, and shell `source`/`.`. Aliases
// resolved by a build tool (tsconfig paths, webpack aliases), C# namespaces and Rust `use`
// are not followed.

export const HELPER_LIMITS = Object.freeze({
  depth: 6, // import hops followed from a test file
  files: 5000, // files read per revision (tests included); beyond that the scan stops
  bytes: 1024 * 1024, // larger files are not scanned for imports
});

const JS_EXT = /\.(m?[jt]sx?|c[jt]s|vue|svelte)$/;
const CODE_EXT = /\.(m?[jt]sx?|c[jt]s|vue|svelte|py|rb|go|java|kt|kts|scala|groovy|php|sh|bash)$/;
const JS_IMPORT = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+|\b(?:jest|vi)\.(?:mock|requireActual|importActual)\s*\(\s*)(['"`])([^'"`\n]+)\1/gm;
const JS_RESOLVE = ['', '.ts', '.tsx', '.js', '.mjs', '.cjs', '.jsx', '.mts', '.cts', '.json', '/index.ts', '/index.tsx', '/index.js', '/index.mjs', '/index.cjs', '/index.jsx'];
const PY_FROM = /^[ \t]*from[ \t]+(\.*)([\w.]*)[ \t]+import[ \t]+\(?([^\n#]+)/gm;
const PY_IMPORT = /^[ \t]*import[ \t]+([\w.]+(?:[ \t]*,[ \t]*[\w.]+)*)/gm;
const RB_REQUIRE = /^[ \t]*require(_relative)?[ \t]*\(?[ \t]*['"]([^'"]+)['"]/gm;
const GO_IMPORT = /^import[ \t]*(?:\(([\s\S]*?)\)|(?:[\w.]+[ \t]+)?"([^"]+)")/gm;
const JVM_IMPORT = /^[ \t]*import[ \t]+(?:static[ \t]+)?([\w.]+)/gm;
const PHP_REQUIRE = /\b(?:require|include)(?:_once)?[ \t]*\(?[ \t]*(__DIR__[ \t]*\.[ \t]*)?['"]([^'"]+\.php)['"]/g;
const SH_SOURCE = /^[ \t]*(?:source|\.)[ \t]+["']?([^\s"';|&$`]+)/gm;

// Test-framework and assertion-library imports: a guarded file that pulls one in is test
// support, not code (a module the code under check imports stays code: notImportedByCode).
const TEST_FRAMEWORK = new RegExp([
  String.raw`['"](?:node:test|vitest|@jest/globals|chai|sinon|uvu|uvu/assert|ava|tap|tape|mocha|expect|power-assert|should|(?:node:)?assert(?:/strict)?|@testing-library/[^'"]+|@playwright/test)['"]`,
  String.raw`^[ \t]*(?:import|from)[ \t]+(?:pytest|unittest|hypothesis|nose2?)\b`,
  String.raw`^[ \t]*require[ \t]*\(?[ \t]*['"](?:rspec|minitest)`,
  String.raw`^[ \t]*import[ \t]*\(?[\s\S]{0,200}?"testing"`,
  String.raw`^[ \t]*import[ \t]+(?:static[ \t]+)?(?:org\.junit|org\.assertj|org\.hamcrest|org\.testng|kotlin\.test|io\.kotest|org\.scalatest)`,
  String.raw`\bPHPUnit\\`,
].join('|'), 'm');
const SUPPORT_PATH = /(^|\/)(test[-_]?utils?|test[-_]?helpers?|test[-_]?support|test[-_]?kit|testing|__mocks__|__fixtures__|mocks|fakes)(\/|\.|$)/i;

/** Does a file look like test support (by its path or its imports)? */
export function looksLikeTestSupport(rel, text) {
  return SUPPORT_PATH.test(rel) || TEST_FRAMEWORK.test(String(text || ''));
}

/** Tracked files at `rev` (null: the staged index) as Map(path → blob sha). */
export function trackedBlobs(root, rev) {
  const entries = rev ? g.treeEntries(root, rev) : g.indexEntries(root).filter((e) => e.stage === 0);
  const map = new Map();
  for (const e of entries) if (e.mode?.startsWith('100') && !g.isProofPath(e.path)) map.set(e.path, e.sha);
  return map;
}

/** Text of many blobs in one git call: Map(sha → text, or null when binary, too large or missing). */
export function readBlobs(root, shas, maxBytes = HELPER_LIMITS.bytes) {
  const out = new Map();
  const list = [...new Set(shas)].filter(Boolean);
  if (!list.length) return out;
  const r = spawnSync('git', ['cat-file', '--batch'], { cwd: root, input: `${list.join('\n')}\n`, maxBuffer: 1024 * 1024 * 1024 });
  if (r.status !== 0 || !r.stdout) return out;
  const buf = r.stdout;
  let pos = 0;
  for (const sha of list) {
    const nl = buf.indexOf(10, pos);
    if (nl === -1) break;
    const header = buf.subarray(pos, nl).toString('utf8');
    pos = nl + 1;
    const m = /^\S+ \S+ (\d+)$/.exec(header);
    if (!m) { out.set(sha, null); continue; }
    const size = Number(m[1]);
    const body = buf.subarray(pos, pos + size);
    pos += size + 1;
    out.set(sha, size > maxBytes || body.includes(0) ? null : body.toString('utf8'));
  }
  return out;
}

function makeResolver(root, files) {
  let byBase = null;
  let byDir = null;
  let goMods = null;
  const baseIndex = () => {
    if (!byBase) {
      byBase = new Map();
      for (const f of files.keys()) {
        const b = path.posix.basename(f);
        if (!byBase.has(b)) byBase.set(b, []);
        byBase.get(b).push(f);
      }
    }
    return byBase;
  };
  const dirIndex = () => {
    if (!byDir) {
      byDir = new Map();
      for (const f of files.keys()) {
        const d = path.posix.dirname(f);
        if (!byDir.has(d)) byDir.set(d, []);
        byDir.get(d).push(f);
      }
    }
    return byDir;
  };
  const modules = () => {
    if (!goMods) {
      goMods = [];
      const mods = [...files.keys()].filter((f) => /(^|\/)go\.mod$/.test(f));
      const texts = readBlobs(root, mods.map((f) => files.get(f)));
      for (const f of mods) {
        const m = /^module\s+(\S+)/m.exec(texts.get(files.get(f)) || '');
        if (m) goMods.push({ module: m[1], dir: path.posix.dirname(f) === '.' ? '' : path.posix.dirname(f) });
      }
    }
    return goMods;
  };
  const norm = (p) => {
    const n = path.posix.normalize(p);
    return n.startsWith('..') || n.startsWith('/') ? null : n.replace(/^\.\//, '');
  };
  const ancestors = (dir) => {
    const out = [];
    let d = dir === '.' ? '' : dir;
    for (;;) {
      out.push(d);
      if (!d) break;
      d = path.posix.dirname(d) === '.' ? '' : path.posix.dirname(d);
    }
    return out;
  };
  const join = (d, p) => (d ? `${d}/${p}` : p);

  return function importsOf(rel, text) {
    const out = new Set();
    if (!text) return out;
    const dir = path.posix.dirname(rel) === '.' ? '' : path.posix.dirname(rel);
    const tryAll = (cands) => {
      for (const c of cands) {
        const n = c && norm(c);
        if (n && files.has(n)) { out.add(n); return true; }
      }
      return false;
    };
    if (JS_EXT.test(rel)) {
      for (const m of text.matchAll(JS_IMPORT)) {
        const spec = m[2].split('?')[0];
        if (!spec.startsWith('.')) continue;
        const base = join(dir, spec);
        const cands = JS_RESOLVE.map((e) => base + e);
        // TypeScript imports "./x.js" for x.ts.
        if (/\.[mc]?jsx?$/.test(spec)) for (const e of ['.ts', '.tsx', '.mts', '.cts']) cands.push(base.replace(/\.[mc]?jsx?$/, e));
        tryAll(cands);
      }
    } else if (rel.endsWith('.py')) {
      const roots = [...new Set([...ancestors(dir), 'src'])];
      const module = (dots, mod, names) => {
        const modPath = mod.replace(/\./g, '/');
        const bases = dots ? [ancestors(dir)[dots - 1] ?? null].filter((x) => x !== null) : roots;
        for (const b of bases) {
          const p = modPath ? join(b, modPath) : b;
          if (modPath) tryAll([`${p}.py`, `${p}/__init__.py`]);
          for (const n of names) if (n && n !== '*') tryAll([`${join(p, n)}.py`, `${join(p, n)}/__init__.py`]);
        }
      };
      for (const m of text.matchAll(PY_FROM)) {
        const names = m[3].replace(/[()]/g, '').split(',').map((x) => x.trim().split(/\s+/)[0]);
        module(m[1].length, m[2], names);
      }
      for (const m of text.matchAll(PY_IMPORT)) for (const mod of m[1].split(',')) module(0, mod.trim(), []);
    } else if (rel.endsWith('.rb')) {
      for (const m of text.matchAll(RB_REQUIRE)) {
        const spec = m[2].endsWith('.rb') ? m[2] : `${m[2]}.rb`;
        if (m[1]) tryAll([join(dir, spec)]);
        else for (const b of [...ancestors(dir), 'lib', 'spec', 'test']) tryAll([join(b, spec)]);
      }
    } else if (rel.endsWith('.go')) {
      const specs = [];
      for (const m of text.matchAll(GO_IMPORT)) {
        if (m[2]) specs.push(m[2]);
        else for (const q of (m[1] || '').matchAll(/"([^"]+)"/g)) specs.push(q[1]);
      }
      for (const spec of specs) {
        for (const { module: mod, dir: modDir } of modules()) {
          if (spec !== mod && !spec.startsWith(`${mod}/`)) continue;
          const pkgDir = norm(join(modDir, spec.slice(mod.length + 1))) ?? '';
          for (const f of dirIndex().get(pkgDir || '.') || []) if (f.endsWith('.go') && !f.endsWith('_test.go')) out.add(f);
        }
      }
    } else if (/\.(java|kt|kts|scala|groovy)$/.test(rel)) {
      for (const m of text.matchAll(JVM_IMPORT)) {
        const parts = m[1].split('.');
        for (let k = parts.length; k >= 2; k--) {
          const suffix = parts.slice(0, k).join('/');
          let hit = false;
          for (const ext of ['.java', '.kt', '.scala', '.groovy']) {
            for (const f of baseIndex().get(`${parts[k - 1]}${ext}`) || []) {
              if (f === `${suffix}${ext}` || f.endsWith(`/${suffix}${ext}`)) { out.add(f); hit = true; }
            }
          }
          if (hit) break;
        }
      }
    } else if (rel.endsWith('.php')) {
      for (const m of text.matchAll(PHP_REQUIRE)) {
        const spec = m[2].replace(/^\//, '');
        tryAll(m[1] ? [join(dir, spec)] : [join(dir, spec), spec]);
      }
    }
    if (/\.(sh|bash)$/.test(rel) || /^#!.*\b(ba)?sh\b/.test(text.slice(0, 80))) {
      for (const m of text.matchAll(SH_SOURCE)) {
        const spec = m[1];
        tryAll([spec, join(dir, spec)]);
      }
    }
    out.delete(rel);
    return out;
  };
}

/**
 * Test helpers at `rev` (null: the staged index): files reached from the test files (those
 * matching `testGlobs`, plus `seeds`) by following imports, up to HELPER_LIMITS. A reached file
 * that `isCode(path)` says is the code under check, and that doesn't look like test support,
 * is not a helper and its own imports are not followed. Test files, package.json and the
 * like (their test settings are compared on their own) and `.proof/` are left out.
 * Returns { helpers: Set, truncated }.
 */
export function testHelperFiles(root, rev, { testGlobs = [], seeds = [], isCode = () => false, files = null } = {}) {
  const tracked = files || trackedBlobs(root, rev);
  const isTest = (p) => testGlobs.some((gl) => matchGlob(p, gl));
  const importsOf = makeResolver(root, tracked);
  const start = new Set(seeds.filter((p) => tracked.has(p)));
  for (const p of tracked.keys()) if (isTest(p)) start.add(p);
  const visited = new Set(start);
  const helpers = new Set();
  let frontier = [...start].filter((p) => CODE_EXT.test(p) || seeds.includes(p));
  let read = 0;
  let truncated = false;
  for (let depth = 0; frontier.length && depth <= HELPER_LIMITS.depth; depth++) {
    if (read + frontier.length > HELPER_LIMITS.files) {
      frontier = frontier.slice(0, Math.max(0, HELPER_LIMITS.files - read));
      truncated = true;
    }
    read += frontier.length;
    const texts = readBlobs(root, frontier.map((p) => tracked.get(p)));
    const next = [];
    for (const p of frontier) {
      const text = texts.get(tracked.get(p)) ?? null;
      if (depth > 0) {
        // Reached from a test: the code under check stops the walk, anything else is a helper.
        if (isCode(p) && !looksLikeTestSupport(p, text)) continue;
        helpers.add(p);
      }
      for (const dep of importsOf(p, text)) {
        if (visited.has(dep)) continue;
        visited.add(dep);
        if (isTest(dep) || hasTestSettings(dep) || g.isProofPath(dep)) continue;
        if (CODE_EXT.test(dep)) next.push(dep);
        else if (!isCode(dep)) helpers.add(dep); // data a test reads: fixtures, expected output
      }
    }
    frontier = next;
    if (depth === HELPER_LIMITS.depth && next.length) truncated = true;
  }
  return { helpers, truncated };
}

// "math" for test/math.test.js, tests/test_math.py, math_test.go, MathTest.java, math_spec.rb.
function testStem(rel) {
  const b = path.posix.basename(rel).replace(/\.[^.]*$/, '');
  return b.replace(/^tests?[-_]/i, '').replace(/([-_.](test|tests|spec|check))+$/i, '').replace(/(Test|Tests|Spec|IT)$/, '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

// "math" for src/math.js, src/math/index.ts, math/__init__.py.
function moduleStem(rel) {
  const b = path.posix.basename(rel).replace(/\.[^.]*$/, '');
  const name = /^(index|__init__|mod|main)$/.test(b) ? path.posix.basename(path.posix.dirname(rel)) : b;
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Of `candidates` (changed files under check that don't look like test support), the ones that
 * are test support by how they are used at `rev`: a test imports the file directly next to
 * other code under check, no test is named after it, it imports no code under check itself,
 * and no code under check imports it. A hand-written assertion helper (src/testkit.js with an
 * eq() the tests call) fits; the module a test exercises does not (it is named after the test,
 * or it is the only code the test imports). Only `rev` is asked (the base), so the change
 * being judged can't move a file in or out. Returns a Set.
 */
export function supportByUse(root, rev, candidates, { isCode, testGlobs = [], files = null } = {}) {
  const list = [...candidates].filter((p) => CODE_EXT.test(p));
  if (!list.length || !rev) return new Set();
  const tracked = files || trackedBlobs(root, rev);
  const isTest = (p) => testGlobs.some((gl) => matchGlob(p, gl));
  const tests = [...tracked.keys()].filter((p) => isTest(p) && CODE_EXT.test(p)).slice(0, HELPER_LIMITS.files);
  const stems = new Set(tests.map(testStem).filter(Boolean));
  const want = list.filter((p) => tracked.has(p) && !stems.has(moduleStem(p)));
  if (!want.length) return new Set();
  const importsOf = makeResolver(root, tracked);
  const texts = readBlobs(root, [...tests, ...want].map((p) => tracked.get(p)));
  const isGuarded = (p) => isCode(p) && CODE_EXT.test(p) && !isTest(p);
  const used = new Set();
  for (const t of tests) {
    const deps = [...importsOf(t, texts.get(tracked.get(t)) ?? null)].filter(isGuarded);
    if (deps.length < 2) continue;
    for (const d of deps) used.add(d);
  }
  const leaves = want.filter((p) => used.has(p) && ![...importsOf(p, texts.get(tracked.get(p)) ?? null)].some(isGuarded));
  return notImportedByCode(root, rev, leaves, { isCode, testGlobs, files: tracked });
}

/**
 * Of `candidates` (helpers by testHelperFiles), those no code under check imports at `rev`.
 * A module the code itself depends on is code, even when the tests import it too. Only `rev`
 * is asked, never the change being judged, so a change can't make a helper look like code by
 * adding an import of it.
 */
export function notImportedByCode(root, rev, candidates, { isCode, testGlobs = [], files = null } = {}) {
  const list = [...candidates];
  if (!list.length || !rev) return new Set(list);
  const tracked = files || trackedBlobs(root, rev);
  const importsOf = makeResolver(root, tracked);
  const stems = [...new Set(list.map((p) => path.posix.basename(p).replace(/\.[^.]*$/, '')).filter((s) => s.length > 1))];
  // git grep narrows the files to read: only those that mention a candidate's name.
  const args = ['grep', '-l', '-I', '-F', ...stems.flatMap((s) => ['-e', s]), rev, '--'];
  const hits = (g.git(root, args, { allowFail: true, trim: false }) || '').split('\n').filter(Boolean).map((l) => l.replace(`${rev}:`, ''));
  const readers = hits.filter((p) => tracked.has(p) && CODE_EXT.test(p) && isCode(p) && !testGlobs.some((gl) => matchGlob(p, gl))).slice(0, HELPER_LIMITS.files);
  const texts = readBlobs(root, readers.map((p) => tracked.get(p)));
  const used = new Set();
  for (const p of readers) {
    const text = texts.get(tracked.get(p)) ?? null;
    if (looksLikeTestSupport(p, text)) continue;
    for (const dep of importsOf(p, text)) used.add(dep);
  }
  return new Set(list.filter((p) => !used.has(p)));
}
