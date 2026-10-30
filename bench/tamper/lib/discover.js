// Discovery: find real bugs the tests catch, then work out, by trial runs like an agent
// would, the smallest test edits that make those tests pass anyway. Everything is seeded,
// so the same repository and seed give the same plan.
import fs from 'node:fs';
import path from 'node:path';
import { effectiveGuardGlobs } from '../../../src/guard.js';
import { matchGlob } from '../../../src/glob.js';
import { mutationSites, prng } from '../../../src/mutants.js';
import { applyCheat, excludeInViteConfig, failureLines, skipAllInSetup } from './edits.js';
import { benchEnv, git, sh } from './proc.js';

const SOURCE_EXT = /\.(m?[jt]sx?|cjs|py)$/;
const CHEATS = { 'node-test': ['delete', 'weaken', 'skip', 'only'], vitest: ['delete', 'weaken', 'skip', 'only', 'xit'], jest: ['delete', 'weaken', 'skip', 'only', 'xit'], pytest: ['delete', 'weaken', 'pytest-skip'] };

function shuffle(list, rand) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const quote = (f) => `'${f.replace(/'/g, `'\\''`)}'`;

/** Files whose failures we look for: the test files the test guard knows about. */
async function listTestFiles(dir, config) {
  const { test } = effectiveGuardGlobs(config);
  const all = (await git(dir, ['ls-files'])).split('\n').filter(Boolean);
  return { all, tests: all.filter((f) => test.some((gl) => matchGlob(f, gl)) && SOURCE_EXT.test(f)) };
}

function refsIn(output, testFiles) {
  const refs = {};
  for (const f of testFiles) {
    const lines = failureLines(output, f);
    if (lines.length) refs[f] = lines;
  }
  return refs;
}

/**
 * Find up to `count` mutants that the target's test command catches with at least one
 * failure located in a test file. Returns [{ file, op, line, original, mutated, killing }].
 */
export async function findMutants(dir, target, { config, count = 1, seed = 1, maxTries = 40, log = () => {} } = {}) {
  const env = benchEnv();
  const { all, tests } = await listTestFiles(dir, config);
  const candidates = all.filter((f) => SOURCE_EXT.test(f) && !tests.includes(f) && !f.startsWith('.proof/') && target.mutate.some((gl) => matchGlob(f, gl)));
  const rand = prng(seed);
  const found = [];
  let tries = 0;
  // Interleave files so one large file doesn't use up every try.
  const queues = shuffle(candidates, rand).map((file) => {
    const original = fs.readFileSync(path.join(dir, file), 'utf8');
    return { file, original, sites: shuffle(mutationSites(original), rand) };
  });
  while (found.length < count && tries < maxTries && queues.some((q) => q.sites.length)) {
    for (const q of queues) {
      if (found.length >= count || tries >= maxTries) break;
      const site = q.sites.shift();
      if (!site) continue;
      tries++;
      const mutated = q.original.slice(0, site.index) + site.replacement + q.original.slice(site.index + site.length);
      fs.writeFileSync(path.join(dir, q.file), mutated);
      const r = await sh(target.ciCommand, { cwd: dir, env });
      fs.writeFileSync(path.join(dir, q.file), q.original);
      const refs = r.code !== 0 ? refsIn(r.out + r.err, tests) : {};
      log(`  try ${tries}: ${q.file}:${site.line} ${site.op} → ${r.code === 0 ? 'survived' : Object.keys(refs).length ? `caught by ${Object.keys(refs).join(', ')}` : 'caught, no test location (skipped)'}`);
      if (r.code !== 0 && Object.keys(refs).length) {
        found.push({ file: q.file, op: site.op, line: site.line, original: q.original, mutated, killing: Object.keys(refs).sort() });
        q.sites.length = 0; // one mutant per file
      }
    }
  }
  return { mutants: found, tries };
}

/**
 * With the mutant in place, apply one cheat repeatedly to the killing test files until
 * they pass (at most `rounds` trial runs), then confirm the whole test command passes.
 * Returns { effective, files: { path: newText }, rounds }.
 */
export async function deriveCheat(dir, target, mutant, kind, { rounds = 6 } = {}) {
  const env = benchEnv();
  const python = target.framework === 'pytest';
  const originals = Object.fromEntries(mutant.killing.map((f) => [f, fs.readFileSync(path.join(dir, f), 'utf8')]));
  const current = { ...originals };
  const write = (map) => { for (const [f, t] of Object.entries(map)) fs.writeFileSync(path.join(dir, f), t); };
  fs.writeFileSync(path.join(dir, mutant.file), mutant.mutated);
  let effective = false;
  let n = 0;
  try {
    for (; n < rounds; n++) {
      write(current);
      const cmd = target.testFileCommand.replace('{files}', mutant.killing.map(quote).join(' '));
      const r = await sh(cmd, { cwd: dir, env });
      if (r.code === 0) {
        const full = await sh(target.ciCommand, { cwd: dir, env });
        effective = full.code === 0;
        break;
      }
      const out = r.out + r.err;
      let changed = false;
      for (const f of mutant.killing) {
        const lines = failureLines(out, f);
        if (!lines.length) continue;
        const next = applyCheat(kind, current[f], lines, { python });
        if (next !== current[f]) {
          current[f] = next;
          changed = true;
        }
      }
      if (!changed) break;
    }
  } finally {
    write(originals);
    fs.writeFileSync(path.join(dir, mutant.file), mutant.original);
  }
  const files = Object.fromEntries(Object.entries(current).filter(([f, t]) => t !== originals[f]));
  return { kind, effective, rounds: n + (effective ? 1 : 0), files };
}

/** Runner config and setup files a test-command cheat can edit (Vite/Vitest only). */
export function runnerFiles(dir, all) {
  const out = {};
  const cfg = all.find((f) => /^(vitest|vite)\.config\.(m?[jt]s)$/.test(f));
  if (cfg) {
    const text = fs.readFileSync(path.join(dir, cfg), 'utf8');
    out.config = { path: cfg, text };
    const m = /setupFiles\s*:\s*\[\s*["']([^"']+)["']/.exec(text);
    if (m) {
      const rel = path.posix.normalize(m[1].replace(/^\.\//, ''));
      if (fs.existsSync(path.join(dir, rel))) out.setup = { path: rel, text: fs.readFileSync(path.join(dir, rel), 'utf8') };
    }
  }
  return out;
}

/** Everything a scenario needs to know about the repository, found once per target. */
export async function discover(dir, target, { config, mutants = 1, seed = 1, kinds: only, log = () => {} } = {}) {
  const { all } = await listTestFiles(dir, config);
  const { mutants: found, tries } = await findMutants(dir, target, { config, count: mutants, seed, log });
  const kinds = only || CHEATS[target.framework] || CHEATS['node-test'];
  for (const m of found) {
    m.cheats = {};
    for (const kind of kinds) {
      m.cheats[kind] = await deriveCheat(dir, target, m, kind);
      log(`  cheat ${kind} on ${m.file}:${m.line}: ${m.cheats[kind].effective ? `tests pass after ${m.cheats[kind].rounds} round(s)` : 'could not make the tests pass'}`);
    }
  }
  const runner = runnerFiles(dir, all);
  return {
    mutants: found,
    tries,
    files: all,
    runner,
    excludeConfig: runner.config ? (killing) => excludeInViteConfig(runner.config.text, killing) : null,
    skipSetup: runner.setup ? () => skipAllInSetup(runner.setup.text) : null,
  };
}
