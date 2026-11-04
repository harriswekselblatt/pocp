import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as g from './git.js';
import { matchGlob } from './glob.js';
import { applySite, DEFAULT_EVAL_EXCLUDE, mutationSites, prng, SOURCE_EXT } from './mutants.js';
import { structuralReview } from './guard.js';
import { ranAndFailed, unfinishedReason } from './run-result.js';
import { restoreTestSettings } from './test-setup.js';
import { copySnapshot, createTreeSnapshot } from './workspace.js';

export { ranAndFailed, unfinishedReason };

/** A mutant run that didn't finish is retried once with this many times its limit. */
export const RETRY_FACTOR = 3;

/**
 * The test guard's mechanical check (SPEC §6.2). A change modified or deleted existing tests
 * or test setup; did it weaken anything? Two parts, both run by POCP, no sign-off involved:
 *
 * 1. Old tests on the new code. In a copy of the new code, the changed test files and runner
 *    config are put back as they were at `base`, and the checks run. A failure means the
 *    change altered behavior the old tests pinned down: that needs a person.
 * 2. Detection can't drop. Small seeded mutants are planted in guarded source (lines this
 *    change touched and files the changed tests import come first). Every mutant the old
 *    tests catch, the new tests must catch too. Only a check that ran to the end and failed
 *    catches a mutant; one that timed out or didn't finish normally leaves it not measured
 *    (see `killedIn` and the verdict below).
 *
 * `rev` is the commit being judged, or null for the staged index. Each run gets its own fresh
 * copy, so nothing a check leaves behind affects another.
 */
export async function runGuardCheck({
  root,
  runObligation,
  base,
  rev = null,
  changes,
  checks,
  sourceGlobs = [],
  mutants = 10,
  seed = 1,
  links = [],
  exclude = DEFAULT_EVAL_EXCLUDE,
  guardGlobs = { test: [], runner: [] },
  jobs,
  logPrefix = 'guard',
  known,
  onPass,
}) {
  const started = Date.now();
  const result = {
    pocp: 1,
    verdict: 'inconclusive',
    passed: false,
    summary: '',
    base,
    checks: checks.map((c) => ({ id: c.id, run: c.run, ...(c.cwd ? { cwd: c.cwd } : {}) })),
    old_tests: { result: 'not-run', restored: [], runs: [] },
    new_tests: { result: 'not-run', runs: [] },
    baseline: { result: 'not-run', runs: [] },
    detection: { result: 'not-run', budget: mutants, seed },
  };
  const finish = (verdict, summary) => {
    result.verdict = verdict;
    result.passed = verdict === 'passed';
    result.summary = summary;
    result.duration_ms = Date.now() - started;
    return result;
  };
  // Inconclusive because a run didn't finish (a timeout, a signal, a spawn error), not because
  // of what the tests did. A test approval doesn't cover this (--accept-inconclusive does): a
  // person approving a test change hasn't seen whether the code hangs.
  const finishUnfinished = (summary) => {
    result.unfinished = true;
    return finish('inconclusive', summary);
  };
  if (!base) return finish('inconclusive', 'no base revision to compare the tests with');
  if (!checks.length) return finish('inconclusive', 'no check runs these tests; add a test obligation that does (pocp add <packet> --test "<command>")');

  const newTpl = createTreeSnapshot(root, rev, { links });
  let oldTpl = null;
  try {
    oldTpl = copySnapshot(newTpl.dir);
    result.old_tests.restored = restoreOldTests(root, base, changes, oldTpl.dir);
    // Tests the change adds aren't old tests: they stay out of the old-tests run, or a new test
    // of changed test support would run against the old support and read as a behavior change.
    // One a check's command names by path stays (removing it would only break the command).
    const added = addedTestFiles(root, base, rev, guardGlobs.test?.length ? guardGlobs.test : exclude)
      .filter((f) => !checks.some((c) => String(c.run || '').includes(f)));
    for (const f of added) fs.rmSync(path.join(oldTpl.dir, f), { force: true });
    if (added.length) result.old_tests.left_out = added;

    // Baselines: the checks on the new code with the new tests (as proven), then with the old.
    const speed = new Map();
    // Set when the mutants' results can no longer count (see part 2 below).
    let abandon = false;
    // `known(check)` reports a pass already seen for this exact new code (the plain proof of
    // the same check), so the new-code baseline isn't run twice; `onPass` shares new passes.
    const runAll = async (tplDir, label, into, only = checks) => {
      let copy = null;
      try {
        for (const ob of only) {
          const seen = label === 'new' && typeof known === 'function' ? known(ob) : null;
          if (seen) {
            into.push({ check: ob.id, passed: true, reused: true, duration_ms: 0 });
            speed.set(ob, seen.duration_ms ?? 0);
            continue;
          }
          copy = copy || copySnapshot(tplDir);
          const r = await runObligation(ob, copy.dir, { logName: `${logPrefix}-${label}-${ob.id}` });
          const names = r.passed ? [] : failingTests(r.output);
          into.push({ check: ob.id, passed: r.passed, exit: r.exit, timed_out: r.timed_out || undefined, signal: r.signal || undefined, error: r.error || undefined, duration_ms: r.duration_ms, ...(names.length ? { failed_tests: names } : {}) });
          speed.set(ob, r.duration_ms);
          if (label === 'old' && !r.passed) abandon = true;
          if (label === 'new' && r.passed && typeof onPass === 'function') onPass(ob, r);
        }
      } finally {
        copy?.cleanup();
      }
      return into.every((x) => x.passed) ? 'pass' : 'fail';
    };
    result.new_tests.result = await runAll(newTpl.dir, 'new', result.new_tests.runs);

    // The mutants (part 2) start alongside the old-tests baseline instead of after it: the
    // baseline is one check at a time, so the other job slots sat idle (E5 profiling). Their
    // results count only if both baselines pass; from the first old-tests failure on, every
    // mutant stops before its next check and is discarded, so the result is what it was when
    // they ran afterwards.
    let plan = null;
    let planError = null;
    if (result.new_tests.result === 'pass' && mutants !== 0) {
      try {
        plan = mutationPlan({ root, base, rev, dir: newTpl.dir, changes, sourceGlobs, exclude, guardGlobs, mutants, seed });
      } catch (err) {
        planError = err;
      }
    }
    const ordered = [...checks].sort((a, b) => (speed.get(a) ?? 0) - (speed.get(b) ?? 0));
    const slots = semaphore(Math.max(1, Number(jobs) || Math.min(4, Math.max(1, os.cpus().length - 1))));
    // One side's verdict on a mutant: `by` is the check that caught it, `unfinished` the checks
    // that didn't end normally, `retried` the retries made. Caught means a check ran to the end
    // and failed (`ranAndFailed`, the rule base runs use). A timeout, a signal, a spawn error or
    // exit 126/127 is not a catch: under load a full suite hits the timeout whether or not it
    // would catch the mutant, so it says nothing either way.
    // Such a run is retried once, in a fresh copy with the mutant, with RETRY_FACTOR times the
    // limit it hit (a check that didn't time out keeps its limit). A retry that ends normally
    // counts as the run. POCP has no ceiling on check timeouts (`run.timeout_ms` is only the
    // default a check's own `timeout_ms` overrides), so the retry limit isn't capped; the retry
    // happens at most once per check and mutant, and only after a run that didn't finish.
    // After a run that still didn't finish, the remaining checks still run, and a later one
    // that fails normally still catches the mutant. Only when none fails normally and at least
    // one didn't finish is the mutant `not-measured`. When every check ends normally there are
    // no retries and this is exactly the old loop: stop at the first failure.
    // `first`: on the new side, the check that caught this mutant on the old side runs first.
    // Caught means any check fails normally, so the order changes only how soon that is known,
    // never the answer (the speed order above already varies with measured times).
    const killedIn = async (tplDir, m, label, first = null) => {
      const copy = copySnapshot(tplDir);
      const unfinished = [];
      const retried = [];
      const fresh = () => {
        const c = copySnapshot(tplDir);
        fs.writeFileSync(path.join(c.dir, m.file), m.mutatedText);
        return c;
      };
      try {
        fs.writeFileSync(path.join(copy.dir, m.file), m.mutatedText);
        const order = first ? [...ordered.filter((ob) => ob.id === first), ...ordered.filter((ob) => ob.id !== first)] : ordered;
        for (const ob of order) {
          if (abandon) return { by: null, unfinished, retried };
          let r = await runObligation(ob, copy.dir, { logName: `${logPrefix}-${label}-${ob.id}` });
          if (!r.passed && !ranAndFailed(r) && !abandon) {
            const firstReason = unfinishedReason(r);
            // The limit the run hit: its own, or (when it uses the config's default, which
            // the guard isn't given) how long it ran before it was stopped, which is at least
            // that limit.
            const limit = r.timed_out ? Math.max(1, Number(ob.timeout_ms) || Number(r.duration_ms) || 0) : null;
            const again = limit ? { ...ob, timeout_ms: limit * RETRY_FACTOR } : ob;
            const rc = fresh();
            try {
              r = await runObligation(again, rc.dir, { logName: `${logPrefix}-${label}-${ob.id}-retry` });
            } finally {
              rc.cleanup();
            }
            retried.push({ check: ob.id, first: firstReason, ...(limit ? { timeout_ms: limit * RETRY_FACTOR } : {}), retry: r.passed ? 'passed' : ranAndFailed(r) ? 'failed' : unfinishedReason(r) });
          }
          if (r.passed) continue;
          if (ranAndFailed(r)) return { by: ob.id, unfinished, retried };
          unfinished.push({ check: ob.id, reason: unfinishedReason(r) });
        }
        return { by: null, unfinished, retried };
      } finally {
        copy.cleanup();
      }
    };
    const sideResult = (k) => (k.by ? 'caught' : k.unfinished.length ? 'not-measured' : 'missed');
    const outcomes = new Array(plan?.picked.length || 0);
    // The baseline takes a slot first; the mutants queue for the rest in index order.
    const oldDone = (async () => {
      await slots.acquire();
      try {
        return await runAll(oldTpl.dir, 'old', result.old_tests.runs);
      } finally {
        slots.release();
      }
    })().then((r) => ({ r }), (err) => ({ err }));
    const pool = Promise.all((plan?.picked || []).map(async (m, i) => {
      await slots.acquire();
      try {
        if (abandon) return;
        const byOld = await killedIn(oldTpl.dir, m, `m${i}-old`);
        const old = sideResult(byOld);
        // Only mutants the old tests catch can be lost, so only those run against the new tests.
        // One the old tests couldn't be measured on is left out of the sample (not run here).
        const byNew = old === 'caught' && !abandon ? await killedIn(newTpl.dir, m, `m${i}-new`, byOld.by) : null;
        const now = old === 'caught' ? (byNew ? sideResult(byNew) : 'missed') : 'not-run';
        outcomes[i] = {
          file: m.file,
          line: m.line,
          operator: m.operator,
          before: m.before,
          after: m.after,
          focus: m.focus,
          old,
          new: now,
          // Present only when a side couldn't be measured, so results with no unfinished run
          // are exactly what they were before this field existed.
          ...(old === 'not-measured' ? { not_measured: { side: 'old', checks: byOld.unfinished } } : {}),
          ...(now === 'not-measured' ? { not_measured: { side: 'new', checks: byNew.unfinished } } : {}),
          ...(byOld.retried.length || byNew?.retried.length ? { retried: [...byOld.retried.map((x) => ({ side: 'old', ...x })), ...(byNew?.retried || []).map((x) => ({ side: 'new', ...x }))] } : {}),
        };
      } finally {
        slots.release();
      }
    })).then(() => null, (err) => err);
    const old = await oldDone;
    if (old.err || old.r !== 'pass') abandon = true;
    const poolError = await pool;
    if (old.err) throw old.err;
    result.old_tests.result = old.r;
    if (result.new_tests.result === 'fail') {
      const failedNew = result.new_tests.runs.filter((r) => !r.passed);
      const done = failedNew.length && failedNew.every((r) => !ranAndFailed(r)) ? finishUnfinished : (sum) => finish('inconclusive', sum);
      return done(`the checks fail on the new code (${failedList(result.new_tests.runs, checks)}), so there is nothing to compare`);
    }
    if (result.old_tests.result === 'fail') {
      // Were these checks already failing before the change? Run the ones that failed on the
      // base itself. If they all fail there too, the failure says nothing about this change.
      const failing = checks.filter((ob) => result.old_tests.runs.some((r) => r.check === ob.id && !r.passed));
      const baseTpl = createTreeSnapshot(root, base, { links });
      try {
        result.baseline.result = await runAll(baseTpl.dir, 'base', result.baseline.runs, failing);
      } finally {
        baseTpl.cleanup();
      }
      // A check that passes at the base but fails on the new code: the change did that, but
      // only if the failing runs on the new code ran to the end. A timeout, a signal or a spawn
      // error there says nothing about behavior: under load (deep mode's planted-bug runs
      // compete with this one) an honest change was blocked as "behavior changed" this way.
      const unfinishedOld = result.old_tests.runs.filter((r) => !r.passed && !ranAndFailed(r));
      if (result.baseline.runs.some((r) => r.passed) && unfinishedOld.length) {
        return finishUnfinished(`the old tests didn't finish on the new code (${failedList(unfinishedOld, checks)}), though they pass on the base: a run that times out or is killed says nothing about behavior, so this can't be read as a behavior change. Re-run with less load (pocp prove --force), or a person must approve it`);
      }
      if (result.baseline.runs.some((r) => r.passed)) {
        const names = testNames(result.old_tests.runs);
        return finish('behavior-changed', `the old tests fail on the new code (${failedList(result.old_tests.runs, checks)})${names.length ? `; failing: ${names.join('; ')}` : ''}: behavior changed, so a person must approve it`);
      }
      // Already red only if every base run ended normally with a failing result. A timeout,
      // a signal, a spawn error or "command not found" says nothing about the tests.
      if (result.baseline.runs.every(ranAndFailed)) {
        // The guard compares whole checks, not single tests. When the output names the failing
        // tests, say which fail on each side: if they differ, the base's failure says nothing
        // about the ones that fail on the new code, and a person has to look at those.
        const onNew = testNames(result.old_tests.runs);
        const atBase = testNames(result.baseline.runs);
        const onlyNew = onNew.filter((t) => !atBase.includes(t));
        let detail = '';
        if (onNew.length && atBase.length) {
          result.adjudication = { automatic: false, reason: 'baseline-red', failing_on_new_code: onNew, failing_at_base: atBase, same_tests: onlyNew.length === 0 };
          detail = onlyNew.length === 0
            ? `. The same tests fail on both sides (${atBase.join('; ')})`
            : `. Different tests fail: at the base ${atBase.join('; ')}, but on the new code with the old tests ${onlyNew.join('; ')}, which the base's failure doesn't explain. The guard compares whole checks, not single tests, so it can't decide this automatically: a person must review the tests that fail only on the new code`;
        }
        return finish('baseline-red', `the old tests already fail at the base (${failedList(result.baseline.runs, checks)}), so the guard can't tell whether this change altered behavior: a person must approve it${detail}`);
      }
      return finishUnfinished(`the old tests fail on the new code, and on the base the same checks didn't finish normally (${failedList(result.baseline.runs.filter((r) => !ranAndFailed(r)), checks)}), so it can't be told whether they were already failing: a person must approve it`);
    }
    if (mutants === 0) {
      // Fast mode: no planted bugs. Only a change that adds lines to existing tests, none of
      // them risky, passes on its own; anything else goes to a person (guard.js).
      result.detection = { result: 'off', budget: 0, seed };
      const reasons = structuralReview(root, { base, rev, changes });
      result.structural = { result: reasons.length ? 'needs-review' : 'passed', reasons };
      if (reasons.length) {
        const shown = reasons.slice(0, 3).map((r) => `${r.file}: ${r.why}`).join('; ') + (reasons.length > 3 ? `; and ${reasons.length - 3} more` : '');
        return finish('needs-review', `the old tests pass on the new code, but the change does more than add lines to existing tests (${shown}); without planted bugs (guard.mutants is 0) POCP can't check it, so a person must review it`);
      }
      return finish('passed', 'the old tests pass on the new code, and the change only adds lines to existing tests, none of which matches the risky patterns (skips, exits, early returns, patched assertions, mocks, exit-code resets, test hooks, globals, empty catch); guard.mutants is 0: no planted bugs');
    }

    // Part 2: the same seeded sample was planted on both sides (above).
    if (planError) throw planError;
    Object.assign(result.detection, { sites: plan.sites, focus_sites: plan.focusSites, files: plan.files.length });
    if (!plan.picked.length) {
      result.detection.result = 'inconclusive';
      return finish('inconclusive', 'no guarded source to plant mutants in, so a drop in detection can\'t be measured');
    }
    if (poolError) throw poolError;
    const baseKilled = outcomes.filter((o) => o.old === 'caught').length;
    const lost = outcomes.filter((o) => o.old === 'caught' && o.new === 'missed');
    const oldUnmeasured = outcomes.filter((o) => o.old === 'not-measured');
    const newUnmeasured = outcomes.filter((o) => o.new === 'not-measured');
    const unmeasured = [...oldUnmeasured, ...newUnmeasured];
    const brief = ({ file, line, operator, before, after }) => ({ file, line, operator, before, after });
    Object.assign(result.detection, {
      sampled: outcomes.length,
      old_caught: baseKilled,
      new_caught: outcomes.filter((o) => o.new === 'caught').length,
      lost: lost.map(brief),
      // Only when some run didn't finish, so other results are unchanged.
      ...(unmeasured.length ? {
        old_not_measured: oldUnmeasured.length,
        new_not_measured: newUnmeasured.length,
        not_measured: unmeasured.map((o) => ({ ...brief(o), side: o.not_measured.side, checks: o.not_measured.checks })),
      } : {}),
      mutants: outcomes,
    });
    const example = (o) => {
      const c = o.not_measured.checks[0];
      return `${o.file}:${o.line} \`${o.before}\` → \`${o.after}\`: "${checks.find((x) => x.id === c.check)?.run || c.check}" ${c.reason}`;
    };
    // The verdict, when some mutant couldn't be measured (its run didn't finish, and neither
    // did the retry with RETRY_FACTOR times the limit):
    // - A pass must rest on evidence for every sampled mutant: each one the old tests catch,
    //   the new tests catch too. A mutant the old tests didn't finish on may be one they catch
    //   by hanging (a real infinite loop the mutant causes) or one the machine was too loaded
    //   to run; the guard can't tell which, so it can't say the new tests still catch it. A
    //   mutant the old tests caught and the new tests didn't finish on is the same gap on the
    //   other side. Either way the result is `inconclusive` (a person decides), never `passed`.
    //   Treating an old-side hang as "not caught" and passing would let a change delete the
    //   only test that hangs on a mutant; treating it as caught would let load raise the bar.
    // - An old-side mutant that didn't finish isn't run on the new side: the verdict is already
    //   not `passed`, and its old outcome is unknown either way.
    // - A mutant the new tests measurably miss is a drop on its own, so `detection-dropped`
    //   takes precedence: it is the stronger finding and both block.
    // - If no measured mutant is caught by the old tests, a drop can't be measured at all:
    //   inconclusive, as for any such sample.
    const gaps = () => [
      oldUnmeasured.length ? `the old tests didn't finish on ${oldUnmeasured.length} of the ${outcomes.length} sampled mutants, even on a retry with ${RETRY_FACTOR}× the time limit (e.g. ${example(oldUnmeasured[0])}): they may hang on it (a real infinite loop) or the machine may be overloaded, so it can't be told whether the new tests still catch it` : '',
      newUnmeasured.length ? `the new tests didn't finish on ${newUnmeasured.length} of the ${baseKilled} mutants the old tests caught, even on a retry with ${RETRY_FACTOR}× the time limit (e.g. ${example(newUnmeasured[0])}), so it can't be told whether detection dropped` : '',
    ].filter(Boolean).join('; ');
    if (baseKilled === 0) {
      result.detection.result = 'inconclusive';
      if (oldUnmeasured.length === outcomes.length) {
        return finishUnfinished(`none of the ${outcomes.length} sampled mutants could be measured on the old tests (e.g. ${example(oldUnmeasured[0])}, also on a retry with ${RETRY_FACTOR}× the time limit), so a drop in detection can't be measured: a person must decide`);
      }
      const measured = outcomes.length - oldUnmeasured.length;
      return finish('inconclusive', `the old tests caught none of ${measured} sampled mutants${oldUnmeasured.length ? ` that could be measured (${oldUnmeasured.length} more couldn't be: e.g. ${example(oldUnmeasured[0])}, also on a retry)` : ''}, so a drop in detection can't be measured`);
    }
    if (lost.length) {
      result.detection.result = 'dropped';
      const ex = lost[0];
      return finish('detection-dropped', `the new tests miss ${lost.length} of ${baseKilled} mutants the old tests caught (e.g. ${ex.file}:${ex.line} \`${ex.before}\` → \`${ex.after}\`)${unmeasured.length ? `; also, ${gaps()}` : ''}`);
    }
    if (unmeasured.length) {
      result.detection.result = 'inconclusive';
      return finishUnfinished(`${gaps()}: a person must decide, or prove again with --force once the checks can finish`);
    }
    result.detection.result = 'kept';
    return finish('passed', `the old tests pass on the new code, and the new tests catch all ${baseKilled} of the ${outcomes.length} sampled mutants the old tests caught (seed ${seed})`);
  } finally {
    oldTpl?.cleanup();
    newTpl.cleanup();
  }
}

/** A counting semaphore: at most `n` holders at once, waiters served in order. */
function semaphore(n) {
  let free = n;
  const waiting = [];
  return {
    acquire: () => (free > 0 ? (free--, Promise.resolve()) : new Promise((resolve) => waiting.push(resolve))),
    release: () => {
      const next = waiting.shift();
      if (next) next();
      else free++;
    },
  };
}

/** Failing test names in a check's output: TAP ("not ok N - name"), node --test's spec reporter ("✖ name"), pytest ("FAILED a::b"), Jest/Vitest ("FAIL path"). At most 10. */
export function failingTests(output) {
  const names = [];
  for (const line of String(output || '').split('\n')) {
    if (/^\s*not ok \d+ .*#\s*(TODO|SKIP)\b/i.test(line)) continue; // a TODO/SKIP directive isn't a failure
    const m = /^\s*not ok \d+ - (.+?)(?:\s+#\s.*)?$/.exec(line) || /^\s*\u2716 (.+?)(?: \([\d.]+m?s\))?$/.exec(line) || /^FAILED (\S+)/.exec(line) || /^\s*FAIL\s+(\S+)/.exec(line);
    if (m && /^failing tests:?$/.test(m[1].trim())) continue; // the spec reporter's summary header
    if (m && !names.includes(m[1].trim())) names.push(m[1].trim());
    if (names.length >= 10) break;
  }
  return names;
}

const testNames = (runs) => [...new Set(runs.filter((r) => !r.passed).flatMap((r) => r.failed_tests || []))];

/** Test files added between `base` and `rev` (null: the staged index). Renames count as added. */
export function addedTestFiles(root, base, rev, testGlobs) {
  const args = rev ? ['diff', '--name-status', '--no-renames', '-z', base, rev] : ['diff', '--cached', '--name-status', '--no-renames', '-z', base];
  const parts = (g.git(root, args, { allowFail: true, trim: false }) || '').split('\0');
  const out = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    if (parts[i] === 'A' && testGlobs.some((gl) => matchGlob(parts[i + 1], gl))) out.push(parts[i + 1]);
  }
  return out;
}

function failedList(runs, checks) {
  return runs.filter((r) => !r.passed).map((r) => {
    const ob = checks.find((c) => c.id === r.check);
    return `"${ob?.run || r.check}" exit ${r.exit}${r.timed_out ? ', timed out' : ''}`;
  }).join(', ');
}

/**
 * Put the base versions of changed tests and runner config back into `dir`. A renamed test
 * counts as the old file deleted and the new one added: the old one comes back, the new one
 * stays (added tests are free). For package.json, pyproject.toml and setup.cfg only the
 * test settings go back (test-setup.js), so dependency changes in the same file stay.
 */
export function restoreOldTests(root, base, changes, dir) {
  const restored = [];
  const put = (rel) => {
    const data = g.showFileBuffer(root, base, rel);
    const full = path.join(dir, rel);
    if (data === null) return;
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.rmSync(full, { force: true });
    fs.writeFileSync(full, data);
    restored.push(rel);
  };
  const drop = (rel) => {
    fs.rmSync(path.join(dir, rel), { force: true });
    restored.push(`-${rel}`);
  };
  for (const c of changes) {
    // package.json, pyproject.toml, setup.cfg: only the test settings go back, so other
    // changes in the same file (dependencies, build settings) stay.
    if (c.kind === 'package-scripts' || c.kind === 'config-section') {
      const full = path.join(dir, c.path);
      const before = g.showFile(root, base, c.oldPath || c.path);
      const now = fs.existsSync(full) ? fs.readFileSync(full, 'utf8') : null;
      const merged = now === null ? null : restoreTestSettings(c.path, before, now);
      if (merged === null) put(c.oldPath || c.path);
      else {
        fs.writeFileSync(full, merged);
        restored.push(`${c.path} (test settings)`);
      }
      continue;
    }
    if (c.status === 'A') drop(c.path);
    else if (c.status === 'R') {
      put(c.oldPath);
      if (c.kind === 'runner-config') drop(c.path);
    } else put(c.path);
  }
  return restored;
}

function treeFiles(root, rev) {
  if (rev) return g.treeEntries(root, rev).filter((e) => e.mode?.startsWith('100')).map((e) => e.path);
  return g.indexEntries(root).filter((e) => e.stage === 0 && e.mode.startsWith('100')).map((e) => e.path);
}

const IMPORT_RE = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)['"]([^'"]+)['"]/gm;
const PY_IMPORT_RE = /^\s*(?:from\s+([\w.]+)\s+import|import\s+([\w.]+))/gm;
const JS_EXT = ['', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '/index.js', '/index.ts'];

/** Source files a test file imports (relative JS/TS imports, Python module paths). */
export function importedFiles(testPath, text, known) {
  const out = new Set();
  const dir = path.posix.dirname(testPath);
  for (const m of String(text || '').matchAll(IMPORT_RE)) {
    const spec = m[1];
    if (!spec.startsWith('.')) continue;
    const baseRel = path.posix.normalize(path.posix.join(dir, spec));
    for (const ext of JS_EXT) {
      const cand = baseRel + ext;
      if (known.has(cand)) {
        out.add(cand);
        break;
      }
    }
  }
  if (testPath.endsWith('.py')) {
    for (const m of String(text).matchAll(PY_IMPORT_RE)) {
      const mod = (m[1] || m[2]).replace(/\./g, '/');
      for (const cand of [`${mod}.py`, `${mod}/__init__.py`, `src/${mod}.py`, path.posix.join(dir, `${mod}.py`)]) {
        if (known.has(cand)) out.add(cand);
      }
    }
  }
  return out;
}

/**
 * The seeded sample, both sides use it. Sites on lines this change touched in guarded
 * source, and in files the changed tests import, come first; the rest tops up the budget.
 */
export function mutationPlan({ root, base, rev, dir, changes, sourceGlobs, exclude, guardGlobs, mutants, seed }) {
  const all = treeFiles(root, rev).filter((p) => !g.isProofPath(p));
  const known = new Set(all);
  const notSource = [...exclude, ...(guardGlobs.test || []), ...(guardGlobs.runner || [])];
  const files = all
    .filter((p) => SOURCE_EXT.has(path.extname(p)))
    .filter((p) => sourceGlobs.some((gl) => matchGlob(p, gl)))
    .filter((p) => !notSource.some((gl) => matchGlob(p, gl)))
    .sort();
  const touched = g.changedLines(root, base, rev, files);
  const imported = new Set();
  for (const c of changes.filter((x) => x.kind === 'test')) {
    for (const p of new Set([c.path, c.oldPath].filter(Boolean))) {
      const local = path.join(dir, p);
      const texts = [g.showFile(root, base, p), fs.existsSync(local) ? fs.readFileSync(local, 'utf8') : null];
      for (const t of texts) for (const f of importedFiles(p, t, known)) imported.add(f);
    }
  }
  const focus = [];
  const rest = [];
  for (const file of files) {
    let text;
    try {
      text = fs.readFileSync(path.join(dir, file), 'utf8');
    } catch {
      continue;
    }
    for (const site of mutationSites(text)) {
      const isFocus = imported.has(file) || Boolean(touched.get(file)?.has(site.line));
      (isFocus ? focus : rest).push({ file, site, text, focus: isFocus });
    }
  }
  const shuffle = (arr, rand) => {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  };
  shuffle(focus, prng(seed));
  shuffle(rest, prng(seed + 1));
  const picked = [...focus, ...rest].slice(0, mutants).map(({ file, site, text, focus: isFocus }) => {
    const mutatedText = applySite(text, site);
    return {
      file,
      line: site.line,
      operator: site.op,
      before: text.split('\n')[site.line - 1].trim().slice(0, 160),
      after: mutatedText.split('\n')[site.line - 1].trim().slice(0, 160),
      focus: isFocus,
      mutatedText,
    };
  });
  return { files, sites: focus.length + rest.length, focusSites: focus.length, picked };
}
