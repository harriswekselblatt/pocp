# POCP 1.2.3 counted campaign: preregistration (A/B frozen)

**Status: FROZEN for tracks A and B, 2026-11-10.** Drafted by Claude (claude-opus-5-5), continuing from Codex. This file's SHA-256 is recorded in `FREEZE-GATE-STATUS.md` and the file is committed **before** any counted cell. Track D is deferred to its own preregistration (see D1). [`STUDY-PROTOCOL-123.md`](STUDY-PROTOCOL-123.md) is the governing protocol, and this document fixes its open choices. Where they conflict, this document wins. Changes after freezing need a dated amendment appended at the end; the frozen text stays as it is.

## 1. Question and claim boundary

For changes to three pinned public libraries (p-map in JavaScript, boltons in Python, gjson in Go), how often does POCP 1.2.3's documented local flow plus fresh-clone CI verification:
- mechanically identify a known weakened check;
- route a change to a human;
- accept it;
- fail to decide?

And what review and execution burden does it add to legitimate changes?

Claims are limited to the three libraries, the stated policy regimes, and POCP's verifier in a fresh clone. No ecosystem catch rate, universal security percentage, or hosted-merge-prevention claim follows. The agent track (C) is not part of this campaign.

## 2. Product under test

| Item | Value |
|---|---|
| Package | `proof-of-change@1.2.3`, tarball `pins/proof-of-change-1.2.3.tgz`, SHA-256 `ccf6254a47228ba140c1f7060e2388fe8a35c4f70678150f3071072a244d9a62` |
| Evaluator | `vendor/npm-pocp-1.2.3/package/bin/pocp.js`; all 84 shipped `bin/` and `src/` files byte-match merged source `ebe6af8ad08574185f336fc4cadd2ba27db847c1` (`pins/release-123.json`) |
| Libraries | `pins/sources.json` (SHA-256 `2b3ae172…f883`): p-map `d61b6a33`, boltons `d31d821d`, gjson `4221a7d3` |
| Toolchains | Node v22.13.1; Go 1.23.6 (`vendor/go-runtime`); Python 3.13.1 (`.venv`, `pins/python-freeze.txt` SHA-256 `c74c5a4b…709e`); macOS 15.6.1 arm64 |

No other POCP version enters this campaign. A product fix found during the campaign is tested only in a new, separately named campaign.

## 3. Corpora

| Track | Content | Frozen artifact |
|---|---|---|
| **A harmful** | 48 designed weakenings: 4 contracts × 4 surfaces (assertions, helper, fixture, runner) × 3 libraries. 32 development, 16 exact-case holdout. | `corpus/challenge/cases.json` (`f3ec4b74…7770`), `contracts.json` (`d94f65e6…b6d4`), `split.json` (`2cc8ac5f…63f5`) |
| **B legitimate** | 108 blind-labeled legitimate changes, 36 per library; every category minimum met; 100 unique patch clusters. 72 development (64 already exposed to diagnostic POCP runs), 36 holdout drawn only from never-run cases. | `corpus/legitimate-selection-02.json` (`e51472ba…ae14`), `corpus/b-holdout-01.json` (`12327893…b77f`) |
| **A-control diagnostic** | The 24 legitimate challenge variants that are **not** in B (8 development, 16 holdout). They are tabulated only as an A diagnostic and never added to B. | Same challenge files |
| **D authority/boundary** | 8 families × 3 libraries, with explicit `unsupported` entries, plus four named historical regressions. Never in A or B denominators. | **Deferred** to a separate preregistration (D1); not part of this freeze |

**B composition, reported in every B table.** By cohort: original-sampled 40, paired-control 24 (16 unique patches), extension 23, gap-fill history 4, constructed 17. The holdout has 14 of its 36 cases constructed, against 17 of 108 overall, because constructed cases make up most of the never-run pool. Every B rate is reported (a) for all cases, (b) without constructed cases, (c) without paired controls, and (d) per patch cluster. Low-confidence or flagged cases get a further sensitivity row: original `6b6af2a`; extension `eaae8c6` (partial fix), plus the linked-commit pairs listed in `audit/EXTENSION-ADJUDICATION.md`.

## 4. Policy regimes (unchanged from development)

- **Focused-check regime.** Applies to A harmful, A-control, and the 24 paired-control B cases.
  - Code: `scripts/challenge.py`. One requirement `behavior-contract` runs `sh .bench/check.sh` on `**`.
  - Guard settings: `extra_test_globs` = the bench test and fixture; `extra_runner_globs` = `.bench/check.sh`; `run.timeout_ms` = 60000.
  - Independent oracle: base green; the regression fails pristine checks (harmful only); candidate checks green; and candidate source with pristine assets fails if harmful, passes if legitimate.
- **Native-suite regime.** Applies to every other B case: upstream, extension, gap-fill and constructed.
  - Code: `scripts/replay-history.py`. One requirement `runtime-suite` runs `sh .bench/check.sh`, which wraps p-map `node_modules/.bin/ava test.js`, boltons `pytest tests -q` and gjson `go test -count=1 ./...`.
  - p-map adds `extra_test_globs` `test*.js` and `test/**/*.js`. `run.timeout_ms` = 120000.
  - Upstream and extension cases replay the frozen parent→head patch. Constructed cases apply `corpus/constructed-0{1,2}/patches/<id>.patch` to the pinned base. Before `git apply --index`, the harness runs `git update-index --really-refresh` (a racy-index fix proven in development).
  - Independent oracle: candidate native suite green, plus the stored constructed-case oracle records.

## 5. Schedule

Each case gets **7 cells**:
- **plain:** required checks only, no POCP; accepted if green;
- **fast:** POCP with 0 mutants;
- **deep:** POCP with 10 mutants, at configured seeds **11, 29, 47, 71 and 101**.

| Set | Cases | Cells |
|---|---:|---:|
| A harmful | 48 | 336 |
| B legitimate | 108 | 756 |
| A-control diagnostic | 24 | 168 |
| **Total A/B** | **180** | **1,260** |

Track D is not scheduled here (deferred; D1).

**Order.**
1. All development cells, in this order: A harmful, B, then A-control.
2. Record and validate them, and freeze the report generator by hash.
3. Then run all holdout cells.

Execution is sequential, one cell at a time, with no concurrent test load. Each cell is run once.

**Per-cell procedure** (protocol §Run matrix):
1. Verify input hashes.
2. Create a fresh disposable repository.
3. Run the independent preflight.
4. Exercise the documented `gate` → `fix` → commit flow, with no semantic edits and no human approval.
5. Judge the exact committed subject with `pocp verify <base>..<head> --rerun --require-coverage --json` in a separate fresh clone.
6. Rerun the independent oracle on that subject.

Each cell's record holds: `argv`, stdout and stderr, exit or signal, timestamps, configured **and effective** seed, selected mutants, findings, approval needs, and every local attempt. Records are append-only with a SHA-256 inventory.

**Paired overhead subset** (`corpus/timing-subset-01.json`, `2bdb2ef4…c33b`): 6 development B cases per library. Each gets three sequential idle-machine repeats of plain, fast, and deep seed 11, with setup timed separately. These timing cells are extra to the schedule and are not scored.

## 6. Scoring

Use the four axes in the protocol: truth/applicability, execution, disposition and protection. Primary outcomes, each reported with numerator and denominator per library, regime, family/category, mode and seed:
1. **Harmful unsafe acceptance:** accepted applicable A-harmful cases / all applicable A-harmful cases. Review, rejection and errors are shown alongside. POCP's incremental effect is computed only over attacks that plain checks accepted.
2. **Relevant mechanical detection** and **authorized-review routing**, as separate shares. For deep mode, report whether **any** seed accepted each case and its five-seed trajectory.
3. **Legitimate burden:** B automatic acceptance, review requests, unresolved rejection after the documented flow, and no-decision, each over all applicable B cases. B intentional-behavior cases may legitimately need review, so report them separately and never count their reviews as errors.
4. **Execution reliability:** completed decisions over scheduled cells, split into product and harness failures.

A fast-mode review request is never counted as mechanical detection. A crash, timeout or failed check is never credited as a relevant catch. Report the designed challenge descriptively, with no binomial interval. Any interval for the original 42-commit frame states its narrow frame and clusters by library.

## 7. Errors, retries and exclusions

- No retry for a product miss, seed-dependent acceptance, product timeout or crash, or flaky upstream test. Each of these is data.
- A demonstrated harness defect allows one corrected replay. The original record is kept and the replay links to it with `supersedes`. A systematic harness defect invalidates its batch and requires a dated amendment.
- No case is replaced after its outcome is seen. Ambiguous and harmful upstream commits stay in their frames and are never scored as false blocks.
- Per-command timeouts: native suites 180 s; `fix` and `verify` 480 s; focused checks 60 s. A timeout is recorded as `product timeout` or `harness timeout` according to which process exceeded its limit.

## 8. Reviewers

- **B labels.**
  - Claude labeled the original 42, the 24 controls and the 49 extension commits blind, before reading any outcome.
  - Fresh reviewer subagents labeled the gap-fill history and constructed cases; each saw only the packet, the patches and the pinned source.
  - Codex adjudicated flagged cases with independent probes.
  - Claude read diagnostic outcomes before constructing cases, so constructed cases carry their own cohort tags.
- **Second-review audit (blocker R1).** A second blind reviewer labels all 48 A-harmful cases and a seeded 25% of B (27 cases), with no access to POCP output. Disagreements and adjudications are recorded before any counted cell runs.

## 9. Resource budget

The development pilot measured about 10 hours of core commands for 1,092 cells on this machine. Planning budget: **≤ 30 hours of wall-clock compute** for the 1,260 A/B cells. If the budget is exceeded, the campaign pauses; any schedule change needs a dated amendment and cannot depend on outcomes. Network access is limited to what the pinned toolchains need, and no package installs happen during cells.

## Freeze blockers

All closed or deferred as recorded below:

| ID | Blocker |
|---|---|
| ~~H1~~ | **Closed 2026-11-10.** `scripts/campaign-123.py` (SHA-256 `cc66f7b06da528ada3f0db6420bb17207287af25b01bae835eb10ba5bfc72e35`) implements §4–§5 for all 180 cases and 1,260 cells: plain, fast, deep 11/29/47/71/101; constructed-patch application; patch-hash checks against the corpus; resume after an interruption, with the interrupted directory kept and linked; no rerun of a recorded cell; holdout refusal without `DEV-COMPLETE.json`; and refusal to open the other split by case ID. A diagnostic smoke run (`pilot/campaign-123-smoke-01/`, not counted) covered one focused A case, one upstream B case and one constructed B case across plain, fast and deep-11, plus a resume test; all 10 cells completed and validate cleanly. That run exposed the development case `pmap-k06` to POCP for the first time. |
| ~~H2~~ | **Closed 2026-11-10.** `scripts/campaign-canaries-123.py` → `pilot/campaign-123-canaries-01/summary.json` (`a0f70cbb…590b`), all OK:<br>• passing and skipped are accepted; failing, zero-test, crash (exit −11), timeout and missing-command (127) are rejected; baseline-red is a harness_error and never scored;<br>• a corrupted expected answer is refused as a harness_error;<br>• under POCP, a failing candidate is rejected and the validator marks its independent oracle failure as unscorable;<br>• the validator (`scripts/validate-campaign-123.py`) rejects a flipped truth, a flipped disposition, an edited artifact, a changed evaluator hash and a deleted record. |
| ~~R1~~ | **Closed 2026-11-10.** `audit/ADJUDICATION-R1.md`: three fresh blind reviewers labeled all 48 A-harmful cases and a seeded 27 B cases (anonymized and shuffled). Labels agree **75/75** (48/48 harmful, 27/27 legitimate). B categories agree 16/27; all 11 differences are the fix-plus-regression-test boundary (`added_test` vs `intentional_behavior_and_test`), traced to a gap in the R1 instructions. The original categories are kept, with a sensitivity row in the report. |
| ~~D1~~ | **Deferred 2026-11-10 by user decision.** Track D (24-environment authority/boundary grid plus named regressions) gets its own preregistration, with frozen histories, predicates and schedule, before any counted D cell. The completed D diagnostics (policy-loosening pair, regression probes) stay labeled as diagnostics. Deferring D changes no A/B case, schedule or denominator. |
| ~~P1~~ | **Closed 2026-11-10** (refresh at P2 if the runner changes). `COMMAND-MANIFEST-123.json` was generated from the runner's own constants. It pins runner, validator, canary and evaluator hashes; per-regime steps and argv; seeds, mutants and timeouts; and the environment allowlist. |
| ~~P2~~ | **Closed 2026-11-10.** All hashes refreshed. This file's SHA-256 is recorded in `FREEZE-GATE-STATUS.md` and the freeze is committed with a timestamp in this study's own git repository (first commit). |

## Amendments

**Amendment 1 — 2026-11-11T01:57:00Z. Validator: an oracle failure on the judged subject is data, not a structural defect.** The frozen validator (`31815409…` replaces `1c8c2b96…`) previously listed `oracle_subject_valid = false` as a validation problem. For native-regime cases, that oracle is the library's own suite rerun on the judged subject, so one flaky upstream test would have blocked `DEV-COMPLETE` permanently. §7 forbids retries, so there would have been no compliant way to continue. Such a cell is now recorded and reported as `invalid_oracle`: shown in every table, excluded from completed decisions, never scored as accepted or caught. The validator still requires the field to be present and boolean. The defect was found while writing the report's hand-computed test. The change was made before any counted record was validated, and without inspecting whether any counted cell has this state. The runner (`cc66f7b0…`) is unchanged. The canary expectation was updated to match (`campaign-canaries-123.py` `ec0b41ad…`). The canaries are rerun as `pilot/campaign-123-canaries-02/` **after** the development run finishes, so they add no load to counted cells, and before `DEV-COMPLETE`. `COMMAND-MANIFEST-123.json` keeps its original hashes; this amendment supersedes its validator and canary entries.

**Amendment 2 — 2026-11-11T01:57:00Z. Report generator frozen before counted results were read.** `scripts/report-123.py` (SHA-256 `e5dcc0b068c5c553139c111d9e6ab66b3ef7c13648832b6581cf044f3854b2de`) implements §6. Its docstring fixes the cell-outcome and protection definitions:
- **Mechanical detection** requires a completed guard reporting `behavior-changed` on a non-accepted cell. A review request alone never counts, in fast or deep mode.
- **Other block:** a rejection without such a guard. It is not credited as a relevant catch.
- **Deep mode:** reported per seed, and also per case as "any seed accepted" and "every seed accepted".

Tables T1–T5 cover execution, harmful changes by library and surface, the incremental effect over plain checks, legitimate burden (all; without constructed; without paired controls; strict without flagged or low-confidence; without linked history; cluster-weighted; by library, cohort and category; R1-reclassified categories), and the A-control diagnostic. A case appendix lists every harmful acceptance. The generator refuses to write tables while the validator reports problems, unless explicitly run as INTERIM.

The generator is verified by `scripts/test-report-123.py` (`563667d7…`), a synthetic campaign with hand-computed expected tables; all checks pass. It was written while the counted development run was in progress. The author had seen only the first few counted progress lines and none of the 1.2.3 tables. **This generator hash is the one passed to `--mark-dev-complete`.** Any change before then needs a further amendment.
