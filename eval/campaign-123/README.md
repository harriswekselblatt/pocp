# POCP 1.2.3 evaluation

*Preregistered benchmark, run November 10–11, 2026. Full tables: [REPORT.md](REPORT.md). Protocol: [PREREGISTRATION.md](PREREGISTRATION.md). Raw records and harness: [pocp-eval/results/campaign-123](https://github.com/harriswekselblatt/pocp-eval/tree/87c8cddaba9322255184800ea344eca78362f656/results/campaign-123).*

## Summary

POCP is a CI gate for pull requests that edit tests. This evaluation asks two questions. Does POCP hold back changes that make the test suite pass by weakening it? And how often does it hold back honest changes?

- **Harmful changes:** 48 test-weakening changes were built so that each one passes the project's own checks. Plain CI accepted all 48. POCP accepted none. In both of its modes, it held all 48 for review. For each one it also ran the old tests against the new code, and they failed, which shows the tested behavior had changed. POCP blocks the merge, and a maintainer makes the final decision.
- **Honest changes:** in deep mode, POCP accepted 78–82% of 108 legitimate changes on each of five random seeds. Leaving out the 24 hardest cases, honest changes written to look like the harmful ones, it accepted 86–88%. Fast mode, the default, accepted 27%, because by design it sends every test edit to a maintainer.
- **Holdout:** 68 of the 180 cases were sealed until development results were validated and the scoring script was locked. The sealed cases showed the same pattern.

## How POCP decides

For each pull request POCP returns **accept**, **review** (a maintainer must approve) or **reject**. When a change edits existing tests, both modes first run the *old* tests against the *new* code. If those tests pass on the base and fail on the change, the tested behavior changed, and the change goes to review.

- **Fast mode** (`guard.mutants: 0`, the default) also sends every other test edit to review.
- **Deep mode** (`guard.mutants: 10`) plants a seeded sample of ten small bugs instead. A test edit is accepted without review only if the new tests catch every sampled bug the old tests caught.

## Method

**Projects.** Three open-source libraries, pinned to fixed commits: p-map (JavaScript), boltons (Python) and gjson (Go).

**Harmful changes (48).** Each one weakens what the tests check while keeping them green. They cover four parts of a test suite (assertions, shared test helpers, fixtures, and runner configuration), with 12 each, spread over four behavioral contracts and the three libraries. Each is judged against a focused check: the specific test command the change was meant to slip past.

**Honest changes (108, 36 per library).** Each is judged against the library's full native test suite:
- 67 commits drawn from the libraries' histories;
- 17 constructed changes, built to fill gaps in that sample, mainly test-only edits;
- 24 *paired controls*: legitimate edits to the same four parts of the suite, each written to resemble one of the harmful changes.

The changes break down as: 31 add tests, 26 edit tests or setup without changing what they check, 24 touch source code only, 20 change behavior together with its tests, and 7 are other changes.

**Provenance.** The cases were built and labeled by AI coding agents (Claude and Codex) under my direction. Labels were assigned without access to POCP's output. Three further independent reviewers labeled all 48 harmful cases and a seeded sample of 27 honest cases, with identifiers removed. Their labels agreed with the originals on 75 of 75. The 17 constructed cases were built after earlier diagnostic runs had been seen, so they are tagged and can be excluded (see Sensitivity).

**Diagnostic set (24).** The remaining paired controls, of the same kind as the 24 above but judged against the focused check. They are reported separately and are not part of the headline numbers.

**Runs.** Each of the 180 cases ran under plain CI, POCP fast, and POCP deep at five fixed seeds (11, 29, 47, 71, 101). That makes 1,260 runs. All ran locally on one machine, sequentially, with no network access and no language model involved.

**Controls against tuning.** Several measures kept results from shaping the analysis:
- The protocol, case labels, runner, validator and scoring script were frozen by SHA-256 before any counted run. Two amendments, both recorded in the preregistration, were made before any counted result was read.
- 68 cases (476 runs) were held out. They stayed unrun until all development runs passed validation and the scoring script was locked by hash. 64 of the 72 honest development cases had been through earlier diagnostic runs of POCP. The 36 honest holdout cases were drawn only from changes POCP had never run on.
- Every run writes an append-only record with hashes of its artifacts. A validator rejects missing, duplicate or altered records, and any record whose outcome contradicts its own evidence.
- Before the holdout, harness canaries confirmed the runner classifies known passing, failing, skipped, crashing and timed-out checks correctly, and that the validator catches tampered records.

## Results

### Harmful changes (n = 48)

| | Plain CI | POCP fast | POCP deep (each of 5 seeds) |
|---|---|---|---|
| Accepted | 48 | **0** | **0** |
| Held for review, behavior change shown | 0 | 48 | 48 |

The result is the same in the development set (32) and the holdout (16), and in each library.

### Honest changes (n = 108)

| Accepted | Development (72) | Holdout (36) | All (108) |
|---|---|---|---|
| Plain CI | 100% | 100% | 100% |
| POCP fast | 21% | 39% | **27%** |
| POCP deep, per seed | 75–82% | 81–83% | **78–82%** |
| POCP deep, per seed, excluding paired controls | 88–92% (48) | 81–83% (36) | **86–88%** (84) |

The two splits differ in composition. All paired controls are in development, and 14 of the 36 honest holdout cases are constructed, against 17 of 108 overall. This accounts for much of the fast-mode gap between development (21%) and holdout (39%): without paired controls, development is 31%.

- **Changes not accepted almost always went to review.** One run rejected an honest change outright: one case, on one deep-mode seed.
- **Fast mode's reviews come mostly from its design.** Of 79 fast-mode reviews, 71 were triggered by the rule that every test edit is reviewed. The other 8 were honest changes whose old tests fail on the new code: the tested behavior did change, and a maintainer is meant to see that.
- **Deep mode depends on the seed.** 88% of honest changes were accepted on at least one seed, and 70% on all five. Re-running the same change with a different seed can change the outcome.
- **Sensitivity.** Excluding constructed cases, paired controls, or cases with flagged or low-confidence labels gives 21–35% for fast mode and 76–88% per seed for deep mode. By library, fast mode ranges from 19% to 31%.

### Diagnostic set (n = 24)

Legitimate edits written to resemble the harmful changes, judged against the focused check. Fast mode accepted none of them. Deep mode accepted 25–46% per seed. These are the cases where review effort concentrates: an honest edit to an assertion, helper, fixture or runner config looks much like a harmful one.

### Reliability

1,254 of 1,260 runs completed with a decision. POCP did not crash or time out. The other 6 were harness errors, all from one diagnostic case whose patch applied as an empty commit, which left nothing to evaluate. The preregistration requires errors to be recorded rather than retried, so they are reported as-is. None affects the harmful or honest-change results.

## Limitations

- **Designed attacks.** The harmful changes were built by hand and do not measure attacks found in the wild. Only three libraries were tested.
- **Holdout scope.** It sealed individual cases, not new libraries or new attack types. It shows the results hold on unseen cases of the same kinds.
- **Two judging setups.** Harmful changes were judged against a focused check, honest changes against each library's full suite. This matches how each kind of change is usually checked, but the two rates are not directly comparable.
- **Seed variance.** As noted above, deep-mode outcomes can vary from one seed to another.
- **Timing.** Run times are reported in [REPORT.md](REPORT.md) and not summarized here. They were measured on one laptop and are indicative only.

## Next

1. **Reduce review load in fast mode.** Fast mode is the default, and a 27% acceptance rate on honest changes is too much friction. The aim is to let a test edit pass without review when there is evidence it does not weaken the suite, instead of reviewing every test edit. The change will be evaluated as a new version, under its own preregistration and on new holdout cases. The results above stand as recorded.
2. **Make deep mode deterministic in practice,** either by sampling bugs independently of the seed or by defining how multiple runs combine into one decision.
3. **Evaluate POCP's approval and trust boundaries:** whether a change can approve itself, loosen the rules that judge it, or make a verification pass that should fail. That study is being preregistered now and will be published separately.

## Verify these results

The raw records, the frozen harness and the corpus are published in [pocp-eval](https://github.com/harriswekselblatt/pocp-eval/tree/87c8cddaba9322255184800ea344eca78362f656/results/campaign-123). With Python 3 alone, its validator checks all 1,260 records, and its scoring script regenerates [REPORT.md](REPORT.md) and [report.json](report.json) byte for byte. Local file paths in the records were redacted. Every redacted file is listed with its hash before and after, and no file the scores are computed from was changed.

[SHA256SUMS](SHA256SUMS) gives the original hashes of the protocol, harness, corpus and report. The scoring script (`e5dcc0b0…`) was locked before the holdout opened, together with the 784 development records (`82740a1f…`). The report header gives the hash over all 1,260 records (`97673606…`).
