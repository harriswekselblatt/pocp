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

// package.json keys that configure a test runner (scripts included: `npm test` runs one).
export const PACKAGE_TEST_KEYS = Object.freeze(['scripts', 'jest', 'mocha', 'ava', 'nyc', 'c8', 'tap']);

// Files whose test settings live in named sections.
const SECTION_FILES = [
  { glob: '**/pyproject.toml', section: /^tool\.(pytest|nose|ward|hatch\.envs\.(test|tests|default))(\.|$)/ },
  { glob: '**/setup.cfg', section: /^tool:pytest$/ },
];

const isPackageJson = (rel) => /(^|\/)package\.json$/.test(rel);
const sectionRule = (rel) => SECTION_FILES.find((s) => matchGlob(rel, s.glob)) || null;

/** True for files whose test part is compared on its own (package.json, pyproject.toml, setup.cfg). */
export function hasTestSettings(rel) {
  return isPackageJson(rel) || Boolean(sectionRule(rel));
}

/** The kind the guard reports for such a file. */
export function settingsKind(rel) {
  return isPackageJson(rel) ? 'package-scripts' : 'config-section';
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
 * checks (`node --check src/a.js`), not test setup.
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
 * name, and files required check commands (and the package scripts they run) name, other
 * than the files that requirement guards.
 */
export function referencedFiles(root, rev, { runnerGlobs = [], commands = [] } = {}) {
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
    for (const f of commandReferences(run, cwd, files)) if (!globs.some((gl) => matchGlob(f, gl))) out.add(f);
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
