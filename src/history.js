import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as g from './git.js';
import { matchGlob } from './glob.js';
import { evaluateTriggers } from './rules.js';
import { createRevCheckout } from './workspace.js';
import { DEFAULT_EVAL_EXCLUDE } from './mutants.js';

export const FIX_PATTERN = /\b(fix(e[sd])?|bug|regression|regress|hotfix|broke|broken|crash)\b/i;
const DOC_EXT = new Set(['.md', '.mdx', '.txt', '.rst']);

const isTestFile = (p, globs = DEFAULT_EVAL_EXCLUDE) => globs.some((gl) => matchGlob(p, gl));
const shellQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

function commitList(root, { range, limit }) {
  const args = ['rev-list', '--no-merges'];
  if (limit) args.push(`--max-count=${limit}`);
  args.push(range || 'HEAD');
  const out = g.git(root, args, { allowFail: true });
  return out ? out.split('\n').filter(Boolean) : [];
}

function subjectLine(root, sha) {
  return g.git(root, ['log', '-1', '--format=%s', sha]);
}

/**
 * Friction simulation: for each past commit, would the current rules have asked for a packet?
 * Pure git, no commands run.
 */
export function simulateGate(engine, { range, limit = 200 } = {}) {
  const root = engine.root;
  const rules = engine.rules();
  const config = engine.config();
  const commits = commitList(root, { range, limit });
  const reasons = {};
  const rows = [];
  for (const sha of commits) {
    const files = g.changedPaths(g.commitChanges(root, sha));
    if (!files.length) continue;
    const trig = evaluateTriggers(files, { rules, config });
    const needs = trig.required_files.length > 0;
    for (const r of trig.reasons) reasons[r.code] = (reasons[r.code] || 0) + 1;
    rows.push({ commit: sha, subject: subjectLine(root, sha), files: files.length, needs_packet: needs, reasons: trig.reasons.map((r) => r.code) });
  }
  const gated = rows.filter((r) => r.needs_packet).length;
  return {
    commits: rows.length,
    would_need_packet: gated,
    share: rows.length ? Math.round((gated / rows.length) * 1000) / 1000 : null,
    reasons,
    rows,
  };
}

/**
 * Fix replay: past commits that look like bug fixes and changed both tests and code.
 * For each, run the fix's own tests twice in a checkout of the fix commit:
 *   1. as committed: they should pass;
 *   2. with only the fix's code changes rolled back to the parent: they should fail.
 * "confirmed" means the test that came with the fix catches the bug it fixed, which is
 * exactly what a replay-confirmed miss is in POCP.
 *
 * `test` is a command; "{tests}" in it is replaced with the fix's test files.
 */
export async function replayFixes(engine, { range, limit = 500, maxFixes = 30, test, jobs, testGlobs = DEFAULT_EVAL_EXCLUDE, links } = {}) {
  if (!test) throw new Error('replayFixes needs a test command (use {tests} for the fix\'s test files)');
  const root = engine.root;
  const cfg = engine.config();
  const candidates = [];
  for (const sha of commitList(root, { range, limit })) {
    if (candidates.length >= maxFixes) break;
    const subject = subjectLine(root, sha);
    if (!FIX_PATTERN.test(subject)) continue;
    const parent = g.git(root, ['rev-parse', '--verify', '--quiet', `${sha}^1`], { allowFail: true });
    if (!parent) continue;
    const changes = g.commitChanges(root, sha);
    const tests = changes.filter((c) => c.status !== 'D' && isTestFile(c.path, testGlobs)).map((c) => c.path);
    const code = changes
      .filter((c) => !isTestFile(c.path, testGlobs) && !g.isProofPath(c.path) && !DOC_EXT.has(path.extname(c.path)))
      .flatMap((c) => (c.status === 'R' ? [c.oldPath, c.path] : [c.path]));
    if (!tests.length || !code.length) continue;
    candidates.push({ commit: sha, parent, subject, tests, code: [...new Set(code)] });
  }

  const workers = Math.max(1, Math.min(Number(jobs) || Math.max(1, os.cpus().length - 1), candidates.length || 1));
  const results = new Array(candidates.length);
  let next = 0;
  const linkList = links || cfg.snapshot.link;

  const work = async (w) => {
    for (;;) {
      const i = next++;
      if (i >= candidates.length) return;
      const c = candidates[i];
      const cmd = test.includes('{tests}') ? test.replaceAll('{tests}', c.tests.map(shellQuote).join(' ')) : test;
      const ob = { id: `fix-${c.commit.slice(0, 8)}`, kind: 'test', run: cmd };
      let co = null;
      const row = { commit: c.commit, subject: c.subject, tests: c.tests, code: c.code, run: cmd };
      try {
        co = createRevCheckout(root, c.commit, { links: linkList });
        const atFix = await engine.runObligation(ob, co.dir, { logName: `history-w${w}-${i}-fix` });
        row.at_fix = { passed: atFix.passed, exit: atFix.exit, timed_out: atFix.timed_out, ms: atFix.duration_ms };
        for (const f of c.code) {
          const old = g.showFileBuffer(root, c.parent, f);
          const full = path.join(co.dir, f);
          if (old === null) fs.rmSync(full, { force: true });
          else {
            fs.mkdirSync(path.dirname(full), { recursive: true });
            fs.writeFileSync(full, old);
          }
        }
        const atOld = await engine.runObligation(ob, co.dir, { logName: `history-w${w}-${i}-old` });
        row.at_old = { passed: atOld.passed, exit: atOld.exit, timed_out: atOld.timed_out, ms: atOld.duration_ms };
        row.verdict = !atFix.passed ? 'fails-on-fix' : atOld.passed ? 'does-not-detect' : 'confirmed';
      } catch (err) {
        row.verdict = 'error';
        row.error = err.message.slice(0, 300);
      } finally {
        co?.cleanup();
      }
      results[i] = row;
    }
  };
  await Promise.all(Array.from({ length: workers }, (_, w) => work(w)));

  const count = (v) => results.filter((r) => r.verdict === v).length;
  return {
    fixes: results.length,
    confirmed: count('confirmed'),
    does_not_detect: count('does-not-detect'),
    fails_on_fix: count('fails-on-fix'),
    errors: count('error'),
    jobs: workers,
    results,
  };
}
