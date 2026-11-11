# POCP 1.2.3: evaluation results and status

*November 11, 2026 · POCP 1.2.3 · preregistered campaign `campaign-123-counted-01` · full tables in [REPORT.md](REPORT.md) · protocol in [PREREGISTRATION.md](PREREGISTRATION.md)*

## Summary

- **Zero harmful changes accepted.** POCP caught all 48 designed test-cheating changes in every mode. Plain CI accepted all 48.
- **Deep mode is usable.** It accepted 78–82% of honest changes. The remaining ~20% go to human review.
- **Fast mode is too strict.** It accepted 27% of honest changes. That is not shippable as a default, and fixing it is the next piece of work.
- **The sealed holdout reproduced the development results.** The results do not depend on cases the design was tuned against.

## What POCP is

POCP (proof-of-change) is a CI gate for changes that pass their tests but may have weakened the tests themselves. For each change it returns one of three decisions: **accept**, **review** (a human looks), or **reject**.

It runs in two modes:
- **Fast** applies static policy checks only.
- **Deep** also runs mutation guards. These try to prove whether the tested behavior actually changed.

## Method

| | |
|---|---|
| Libraries | p-map (JS), boltons (Python), gjson (Go) |
| Set A: harmful | 48 changes built to pass CI while weakening what the tests check |
| Set B: honest | 108 legitimate changes, 36 per library, judged in each library's native test suite |
| A-control | 24 legitimate edits of the same shape as set A (diagnostic only) |
| Modes | plain CI (baseline), POCP fast, POCP deep at 5 fixed seeds (11, 29, 47, 71, 101) |
| Total | 180 cases × 7 cells = **1,260 runs**, with 0 missing and 0 malformed |
| Split | 784 development runs and 476 holdout runs. The holdout stayed sealed until development was validated and the report script was hash-locked. |

The protocol was set before any counted run. The preregistration, runner, validator and report generator were frozen by SHA-256, along with the case labels, which were reviewed blind to outcomes. Every run writes an append-only record and an artifact hash inventory. A fail-closed validator checked every record against the frozen inventory before the holdout opened, and again after it closed. The run is fully local: no network and no LLM in the loop.

A detection is counted as **mechanical** only when a guard proves the behavior changed. A review triggered by policy alone is reported separately.

## Results

### Harmful changes (A, n = 48)

| | plain CI | POCP fast | POCP deep (each of 5 seeds) |
|---|---|---|---|
| Accepted (missed) | 48 | **0** | **0** |
| Caught mechanically | – | 48 | 48 |

Every harmful change that passed CI was stopped by POCP, with mechanical proof, at every seed. The development split (32) and the holdout (16) look the same. All three libraries are at 0 missed.

### Honest changes (B, n = 108): how much friction

| Accept rate | development (72) | holdout (36) | all (108) |
|---|---|---|---|
| plain CI | 100% | 100% | 100% |
| POCP fast | 21% | 39% | **27%** |
| POCP deep, per seed | 75–82% | 81–83% | **78–82%** |

Notes:
- **No honest change was wrongly rejected outright, except one.** Non-accepted changes went to *review*. The single rejection came from one deep seed on one case.
- **Fast-mode reviews are almost all policy-driven.** Of 79 fast-mode reviews, 71 came from policy rules and 8 from guards. In other words, fast mode flags the *shape* of a change, such as an edited test file, without evidence that behavior changed.
- **Deep mode depends on the seed.** The same honest change is accepted on at least one seed in 88% of cases, and on all five seeds in 70%. A change can therefore get a different outcome on a rerun.
- **The results hold up when cases are removed.** Removing constructed cases, paired controls, or low-confidence labels moves fast mode between 21% and 35%. Deep mode stays roughly where it was. Per library, fast mode ranges from 19% to 31%.

### A-control diagnostic (n = 24)

These are legitimate edits that look like set A. Deep mode accepts only 25–46% of them per seed, and fast mode accepts none. This is expected: these edits deliberately resemble cheating. But it shows where review burden will concentrate in practice.

### Reliability

1,254 of 1,260 runs produced a decision. The other 6 were harness errors, and none were POCP crashes or timeouts. All 6 came from one broken diagnostic case, `boltons-first-fixture-legitimate`. Its patch produced an empty commit, so its POCP runs had no candidate to judge. The defect is in the case, not in POCP. It is recorded as-is under the preregistration and falls outside the A and B headline numbers.

## Limitations

- Three libraries, and harmful changes that were *designed*. These results do not measure attacks found in the wild.
- Set A was judged with a focused check per case. Set B was judged in each library's native suite. The two regimes differ on purpose, and the rates should not be combined.
- Deep-mode variance across seeds is a property of the product, and it has to be addressed before deep mode can be the default gate.
- Timing results are in REPORT.md and are not summarized here.

## Status and next steps

1. **Fix fast-mode over-flagging.** Make the policy rules require stronger evidence before they force a review. This will be tested as a **new versioned campaign** with its own preregistration. The 1.2.3 results above stay as recorded.
2. **Reduce deep-mode seed variance**, or define how reruns are aggregated.
3. **Track D (authority/boundary grid)** is preregistered separately and will be reported on its own.
4. Replace the broken diagnostic case in the next corpus version.

## Files and reproducing

| File | What |
|---|---|
| [PREREGISTRATION.md](PREREGISTRATION.md) | The protocol, frozen before any counted run, including amendments 1–2 (made before the holdout opened) |
| [REPORT.md](REPORT.md) | Every table, generated by the frozen report script with no hand edits |
| [report.json](report.json) | The same tables as data |
| [SHA256SUMS](SHA256SUMS) | Fingerprints of the preregistration, runner, validator, report generator, corpus files, command manifest, the development-complete lock and the report |

The report generator (SHA-256 `e5dcc0b0…`) was locked in `DEV-COMPLETE.json` before the holdout opened. The lock also fingerprints all 784 development records (`82740a1f…`). The report header fingerprints all 1,260 records (`97673606…`).

The benchmark harness and raw run records (about 76 MB) are not in this repository yet. They will go to [pocp-eval](https://github.com/harriswekselblatt/pocp-eval) once local paths are redacted, as `eval/README.md` rule 9 requires, with a mapping from the original fingerprints to the redacted ones.
