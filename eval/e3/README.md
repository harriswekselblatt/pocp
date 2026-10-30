# E3: an outside mutation tool's mutants, replayed through POCP

POCP's test guard and `pocp eval` plant mutants with POCP's own 16 regex operators (`src/mutants.js`). So when POCP grades how good a project's tests are, it grades them with its own generator and its own runner. E3 checks both against an outside tool, [StrykerJS](https://stryker-mutator.io/), on POCP's own code.

Two measurements, kept apart ([EVAL-PLAN](../../docs/EVAL-PLAN.md) E3):

1. **Shared corpus (paired).** A seeded sample of Stryker's mutants is run twice: by Stryker's own runner, and by POCP's runner (`pocp eval --corpus`), mutant by mutant, on the same commit with the same checks. Same mutants, two runners. The result is agreement, with every disagreement listed.
2. **POCP's own operators (separate).** `pocp eval --mutants N` on the same commit and checks. Its score is reported on its own, with its denominators. It is **not** agreement with Stryker: the generators differ, so the numbers aren't comparable. Next to it: which Stryker mutator kinds POCP's operators can't produce at all (its blind spots), and the reverse.

Mutation scores are the share of planted mutants a test command detects. They are not probabilities that code is correct.

**Python (mutmut) is out of scope here:** POCP has no Python source. The plan's mutmut runs belong with E4's outside repos.

## What runs

| Thing | Value |
|---|---|
| Code mutated | `src/**/*.js` at one commit (everything `.proof/rules.json` guards that's source; tests are never mutated) |
| Checks | The three POCP requires for `src/**`: `node --test test/unit.test.js test/unit-more.test.js test/git.test.js`, `node --test test/engine.test.js`, `npm test --silent` |
| Stryker | `@stryker-mutator/core@9.6.1`, pinned, installed in a scratch folder outside the repo (POCP stays zero-dependency). Command test runner (Stryker has no `node:test` runner) with the three checks joined by `&&`, `coverageAnalysis: off`, `disableTypeChecks: false` so no file gets a `// @ts-nocheck` line |
| POCP | `pocp eval --corpus` on the same mutants: each mutant in a fresh snapshot, the three checks fastest first, stop at the first failure |
| Where | A scratch `git clone` of the commit, so the working tree is never touched. Same worker count on both paths. By default Stryker and POCP run one after the other; with `PARALLEL=1` (used for pilot-02, on a machine shared with other agents) they run at the same time so both see the same load |

### The sample

The full suite takes about 2.5 minutes, and Stryker makes about 12,000 mutants in `src/`, so E3 samples.

1. `enumerate.js` lists every mutant Stryker would make, using Stryker's own instrumenter from the pinned install (the population is Stryker's, not ours).
2. It draws a simple random sample without replacement: the population sorted by key (`file:line:col-line:col:mutator:replacement`), shuffled with `mulberry32(seed)` (`eval/lib/stats.js`), first N. Seed `20261028` (the date the run was set up), chosen before any mutant was looked at.
3. `run-stryker.js` gives Stryker only the sampled ranges (`mutate: ["src/x.js:L:C-L:C", …]`) plus an ignore-plugin (`stryker-sample-ignorer.js`) that marks mutants nested inside a sampled range as Ignored. That still leaves other mutators on the same node (about as many again as the sample), so `run-stryker.js` predicts Stryker's mutant ids with the same instrumenter and Stryker's command runner calls `stryker-gate.sh`, which runs the real checks only for sampled ids and exits 0 for the rest. The extras are dropped from the report by exact key. The gate appends `<id> <exit> <seconds>` for every real run to `stryker-report.json.marks`; `report.js` counts a sampled mutant's Stryker result only if its id is in the marks (a timed-out run leaves no mark and stays `Timeout`). The marks also make a stopped run readable, since Stryker writes its report only at the end.

### Timeouts

The two runners don't share a timeout model, and this is reported, not hidden:

- **Stryker:** one limit per mutant for the whole command: net dry-run time × 1.5 + 360 s (about 10 minutes here).
- **POCP:** 600 s per check (`.proof/config.json` `run.timeout_ms`), so up to 30 minutes for the three.

A mutant that times out on either side is **not measured** (below), so the different limits can only move mutants out of the agreement denominator, never flip an agreement.

## Classification: one rule set, both paths

Defined before the first counted mutant ran, in `lib.js` (`classifyStryker`, `classifyPocp`, `pairCategory`) and tested in `test/e3.test.js`.

Each side's raw result maps to a shared class:

| Shared class | Stryker status | POCP `outcome` |
|---|---|---|
| detected | `Killed` | `caught` (a check failed) |
| undetected | `Survived`, `NoCoverage` | `missed` (every check passed) |
| timeout | `Timeout` | `timeout` (the first failing check timed out) |
| invalid | `CompileError` | — |
| error | `RuntimeError` | `error` (a check couldn't start) |
| not-run | `Ignored`, missing | `gone` (the mutant couldn't be applied) |

Each mutant then gets one category, first match wins:

1. **invalid**: the mutated file fails `node --check` (decided once by E3, outside both tools, the same for both), or Stryker says `CompileError`. Excluded from every denominator.
2. **equivalent**: listed in `equivalent.json` with a reason, after manual review. Excluded from every denominator. Nothing is marked equivalent any other way.
3. **not-run**: either side didn't run it. Listed, excluded.
4. **error**: either side had a runner error. Listed, excluded.
5. **timeout**: either side timed out. "Not measured": listed, excluded.
6. **agree** / **disagree**: both sides detected it, or both missed it / one did and the other didn't.

**Agreement** = agree ÷ (agree + disagree). Each side's detection rate on those same mutants is reported too. Intervals: Wilson for the pooled rate and a cluster bootstrap with the **source file** as the cluster (PREREG §1), both from `eval/lib/stats.js`. There's no agreement bar (PREREG §5: report only).

**Disagreements** are each listed with the mutant's diff, both results, and a re-run of that mutant on both paths, once. The first run is the result (PREREG §3: no retries); the re-run only says whether the disagreement is stable or flaky. The cause of each disagreement goes in `notes.json` (keyed by mutant key) after looking at it, and shows in RESULTS.md.

POCP's own score in `pocp eval` leaves timeouts and errors out (not measured; earlier versions counted a timeout as caught, and the report says which it read). E3 reports POCP's own-operator run both ways: POCP's number, and with timeouts and errors excluded as above.

## Files

| File | What |
|---|---|
| `enumerate.js` | Stryker's mutant population and the seeded sample |
| `run-stryker.js` | Runs pinned Stryker on the sample in the scratch clone; saves the JSON report (mutation-testing-report-schema), its log and a meta file |
| `stryker-sample-ignorer.js` | The Stryker ignore-plugin that keeps the run to the sample |
| `run-pocp.js` | Turns the sample into a `pocp eval --corpus` file and runs it |
| `report.js` | Pairs and classifies, writes run records (once per batch), generates `RESULTS.md` |
| `lib.js` | Sampling, location helpers, the classification rules, blind-spot comparison |
| `run.sh` | All of it end to end, printing every command |
| `equivalent.json`, `notes.json` | Manual review: equivalent mutants (with reasons) and the cause of each disagreement |
| `RESULTS.md` | Generated. Don't edit |

Raw outputs go to `eval/results/E3/<batch>/`: `sample.json`, `stryker-report.json` (+ `.log`, `.meta.json`), `pocp-eval.json` and its corpus, `pocp-own.json`, re-runs, `blind-spots.json`, `meta.json`. The full population list is regenerated by `enumerate.js` (deterministic) rather than committed. Run records (`pocp-eval-run/1`, `eval: "E3"`, `phase: "pilot"`, one per sampled mutant, `cluster` = source file) go to `eval/results/E3/<batch>.jsonl`.

## Run it

```bash
STRYKER_DIR=$(mktemp -d) && (cd "$STRYKER_DIR" && npm init -y >/dev/null && npm i @stryker-mutator/core@9.6.1)
STRYKER_DIR="$STRYKER_DIR" N=100 SEED=20261028 JOBS=4 eval/e3/run.sh
node --test eval/e3/test/*.test.js
```
