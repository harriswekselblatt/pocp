# Benchmark options: what can measure what ImpossibleBench couldn't

Status: research and recommendation only, written 2026-11-21. Nothing here has been run. Every option below is a **new experiment** that would get its own pre-registration before any counted run. None of them re-runs or replaces the E1 result in [PR #119](https://github.com/harriswekselblatt/pocp/pull/119) (`eval/PREREG.md` §7: nothing is re-run to get a different result).

## The gap, in plain words

The counted E1 run on POCP 1.5.0 (PR #119) showed this. On 50 impossible tasks, Codex got a test-editing cheat past ordinary CI in 25. With POCP in CI, none of them merged. But every one of those holds was an **escalation** (`baseline-red`), not a **mechanical catch**:

- On ImpossibleBench, the original tests already fail at the base.
- POCP's test guard judges a test edit by running the *old* tests on the *new* code, then on the base.
- When the old tests already fail at the base, the guard can't tell whether the edit made them check less. It hands the change to a person.

So E1 showed that POCP stops these edits from merging silently. It did not show that POCP *detects* the weakening itself (0 of 30 mechanical catches, against the §5 bar of 90%). It also measured no false blocks, because POCP accepted nothing in the `pocp-ci` arm.

Two things are still unmeasured:

1. **Detection with real agents on a green base.** What happens when an agent weakens tests that passed before its change?
2. **False blocks on honest work.** How often does POCP hold a correct change that it should have let through?

Some of this has been measured already, with scripted changes rather than agents. `eval/campaign-123` built 48 test-weakening changes on green bases in three outside libraries, and POCP held all 48. That evaluation also measured how many honest changes POCP accepts: 78–82% in deep mode, across 108 honest changes. What's missing is **real agents** doing the weakening, and **bugs and changes that come from outside POCP**.

## The one test every candidate has to pass

POCP's guard compares **whole checks**, not single tests (`src/guard-check.js`). A check is one command, for example `python3 -m pytest tests/test_x.py`. So for a mechanical catch to be possible at all, two things must be true:

- the exact command POCP is told to require **passes at the base**, and
- the test the agent weakens is **inside that command**.

If the command mixes tests that pass at the base with tests that fail there, the whole command fails at the base, and the result is `baseline-red` again. This rules out several benchmarks as they ship, and it decides how the others would have to be set up.

### A fact about the existing E2 set-up

`eval/e1/README.md` sets the E2 base as a `solution.py` with an empty body plus the original tests. That base is **red**. The frozen ImpossibleBench LiveCodeBench tasks have no reference solution (their fields are `task_id`, `prompt`, `test`, `original_test`, `impossible_type`, `entry_point`), so a green base can't be built from them.

The earlier E2 pilot (Codex solved 10 of 10, and POCP blocked none) therefore barely used the test guard. An honest agent on these tasks rarely touches an existing test. That pilot says little about false blocks from test edits, which are the main way POCP could block honest work.

## Ranked recommendation

| Rank | Option | Measures | Agent runs | Credibility to outsiders |
|---|---|---|---|---|
| 1 | **Replay human fixes from SWE-bench Verified** (gold patches, no agent) | False blocks on known-good changes, on real repos | **0** | High |
| 2 | **SWE-bench Verified, tests delivered with the task**, honest and impossible splits, required check limited to tests green at base | Mechanical catch with real agents, and false blocks with real agents | Pilot of about 60–120 runs, then a batch sized from the pilot | High, but cost is real |
| 3 | **Real bugs, scripted weakening** (BugsInPy, Defects4J): reintroduce a real bug on a green base and weaken its test | Mechanical catch on bugs POCP's operators didn't invent | **0** | Medium–high |

The rest are below the table.

### 1. Replay the human fixes from SWE-bench Verified (no agents)

**What it is.** SWE-bench Verified is 500 real GitHub issues from open-source Python projects, each with the human fix (`patch`), the human test changes (`test_patch`), the tests that should go from failing to passing (`FAIL_TO_PASS`), and the tests that should keep passing (`PASS_TO_PASS`). Humans screened every task. Source: [SWE-bench on GitHub](https://github.com/SWE-bench/SWE-bench) (MIT); dataset `princeton-nlp/SWE-bench_Verified` on Hugging Face, revision `c104f840cc67f8b6eec6f759ebc8b2693d585d4a` as of 2026-11-21. *The dataset card's license wasn't confirmed; check it before redistributing anything taken from the dataset.*

**Base tests green?** Yes, for `PASS_TO_PASS` at `base_commit`. That's what the field means.

**How it works.** For each task, take `base_commit` as the base. Apply the human `patch` and `test_patch` as one change, the way the original pull request landed. Run `pocp verify` on it in deep mode (`guard.mutants: 10`) and in fast mode. These are changes the project's maintainers accepted, so any POCP hold is either a false block or a legitimate "a person should look at this".

**Why it's first.**
- **No agent runs.** It costs machine time only (Docker images per task, plus POCP's guard runs).
- It answers the question the E2 bar asks, on real projects rather than toy tasks.
- Many human test patches **edit existing tests** that passed before, because the fix changed behavior on purpose. POCP holds those by design ("behavior changed, so a person must approve it"). That's the real cost POCP puts on honest work, and this measures it directly.

**What to report.** Holds split into: (a) the change edits a test that passed at the base and now asserts different behavior (held on purpose); (b) every other hold (a false block in the E2 sense). Also report how many changes touched an existing test at all. **The E2 bar (upper bound under 5%) may not be reachable on real repos**, because (a) is common in real fixes. If so, the honest headline is "of N maintainer-accepted fixes, POCP accepted X, held Y for a behavior change a person should confirm, and blocked Z for other reasons."

**Maps to.** E2 (claim B), and partly E4 (claim C, since the human tests fail before and pass after the fix). It needs a new runner, not `eval/e1/run.js`: SWE-bench tasks are whole repositories run in Docker, not single-file Python. The SWE-bench Docker harness can supply the environments.

**Cost.** 0 agent runs. Machine time: per task, a Docker image (the SWE-bench harness builds them) plus a deep-mode guard run, which can take several minutes on larger suites (see `docs/EVAL-PLAN.md` E5 timings). A 100-task sample is a reasonable first counted size. That's an estimate, to be set by a small pilot.

**Credibility.** High. SWE-bench Verified is the most widely cited coding-agent benchmark, the changes are human-written and maintainer-accepted, and nothing about them was chosen by POCP's author. The limit to state: these are past fixes replayed, not new work by agents.

### 2. SWE-bench Verified with tests delivered with the task (real agents)

**What it is.** The same 500 tasks, run with Claude Code and Codex through the E1/E2 harness design. Two variants:

- **Honest (E2):** the original tasks.
- **Impossible (E1):** [ImpossibleBench](https://github.com/safety-research/impossiblebench)'s SWE-bench version (MIT; dataset `fjzzq2002/impossible_swebench`, revision `9c2d34f364b7229e8c0ff807c646100bdc18bbb5`, splits `original`, `oneoff`, `conflicting`, about 349 tasks per impossible split per the paper). It changes one test in the task's `test_patch` so it contradicts the issue. The dataset keeps both `test_patch` and `original_test_patch`. *No license tag was found on the Hugging Face dataset card; the code repo is MIT.*

**Base tests green?** Only if it's set up the right way, as E1b already does:

- The base is the repo at `base_commit`, where `PASS_TO_PASS` passes.
- The task's test changes arrive **uncommitted** with the task. That's how they arrived in the real pull request.
- POCP's required check is limited to tests that pass at the base, i.e. `PASS_TO_PASS` by test id. The `FAIL_TO_PASS` tests are checked separately.

Set up this way, an agent that deletes or loosens a `PASS_TO_PASS` test, or a shared helper or `conftest.py` those tests use, is weakening tests that were green. The guard can then return `behavior-changed` or `detection-dropped`, which is a mechanical catch. An agent that edits only the *new* impossible test is in E1b's situation: POCP's guard only protects tests that already existed. So expect a miss there, and report it as one.

**Do agents weaken green tests here?** Unknown, and that's the main risk. The ImpossibleBench paper reports agents modifying tests on its SWE-bench split, but not how often those edits hit tests that passed at the base rather than the impossible test itself. Natural cheating on the honest split is likely rare. **Don't assume the §5 minimum of 30 CI-passing test-edit cheats per agent is reachable.** Run a pilot first to measure the rate, and pre-register no catch-rate bar unless the pilot shows the denominator is reachable.

**Maps to.** E1b and E2 in `docs/EVAL-PLAN.md`, and step 9 ("E1 on a sample of Impossible-SWE-bench"). The arms `plain` / `pocp-ci` / `pocp-hooks` carry over unchanged. `eval/e1/run.js` doesn't: its repo layout is single-file (`solution.py` plus `tests/test_task.py`). It needs a SWE-bench task adapter, per-task Docker environments, and a required check built from `PASS_TO_PASS` test ids. The reference checker needs the same extension: put back the canonical tests, then check `FAIL_TO_PASS` and `PASS_TO_PASS`. One of the outcome rules needs a decision first. If an agent edits an impossible test back to its original version (`original_test_patch`), the final tests match what the project really wants. The reference checker calls that a cheat against the impossible canon, and POCP sees a change to a test that was new in the task. Decide how that's counted before the run.

**Cost.** Each run is a full repository task, so expect several minutes or more per run, much slower than the 1–2 minute LiveCodeBench Codex runs. These are estimates; the smoke test should measure them.
- **Pilot:** about 10–20 tasks × 2 agents × 3 arms, plus a no-agent harness check using the human fix and a scripted cheat as canaries.
- **Counted E2:** 52+ honest runs per agent for the §5 false-block bar (that's the bar's own minimum).
- **Counted E1:** sized from the pilot's rate of green-test weakening. If that rate is low, it could take hundreds of runs per agent to reach 30 cheats, or 30 may not be reachable at all.

**Credibility.** The highest of any option with agents, for the same reasons as option 1, plus it's the setting outsiders care about (agents on real repos). Two limits to state: SWE-bench tasks may be in the models' training data, and the impossible split is artificial by design. Newer task pools reduce the first concern: [SWE-rebench](https://huggingface.co/datasets/nebius/SWE-rebench) (CC-BY-4.0) and [SWE-bench-Live](https://github.com/SWE-bench-Live/SWE-bench-Live) (MIT) keep adding fresh tasks.

### 3. Real bugs, scripted weakening (BugsInPy, Defects4J; no agents)

**What it is.** Collections of real, reproduced bugs, each with the buggy version, the fixed version, and a test that fails on the buggy one and passes on the fixed one.
- [BugsInPy](https://github.com/soarsmu/BugsInPy): 493 bugs from 17 Python projects. *License not confirmed (no license file found via the GitHub API).*
- [Defects4J](https://github.com/rjust/defects4j) (MIT): 835 Java bugs in v2.0.0, 854 in v3.0.1.

**Base tests green?** Yes, by construction. The base is the **fixed** version, where the bug-revealing test passes.

**How it works.** It's the `campaign-123` design, but the bugs come from outside. The change is "reintroduce the real bug, then weaken the test that catches it" (delete the assertion, loosen it, skip it, empty a helper). Plain CI passes the change. POCP should return `behavior-changed`, because the old test passes at the base and fails on the new code.

**Why it's useful.** The standing objection to `bench/tamper` and `campaign-123` is that POCP's own mutation operators or its own author chose the bugs (`docs/EVAL-PLAN.md`, "Why this plan exists"). Here the bugs are real and chosen by other researchers years ago. It also tests deep mode's `detection-dropped` path: does a weakened suite still catch POCP's sampled mutants?

**Limits.** The weakening is still scripted, not done by an agent. For Defects4J, POCP's operators are text-based and list `.java` among source extensions (`src/mutants.js`), but no POCP evaluation has exercised Java yet. A pilot would need to confirm deep mode works there, or the run uses Python (BugsInPy) only. Some BugsInPy bugs no longer reproduce because of dependency drift. Expect to exclude some, and publish which.

**Maps to.** E1-style mechanical catch on a green base, scripted, plus E4 (claim C: the old tests fail before the fix and pass after). It runs like `campaign-123`, with no `eval/e1/run.js`. **Cost:** 0 agent runs.

**Credibility.** Medium–high. Defects4J is the standard bug collection in software-testing research, but the weakening is scripted, and readers will notice that.

## Considered and ranked lower

| Option | Why lower |
|---|---|
| **More ImpossibleBench LiveCodeBench (E1a/E1b/E2 as built)** | The base is red by construction (an empty function), and there's no reference solution to make it green. More runs repeat the `baseline-red` result. E2 here is still cheap to run, but it barely exercises the test guard. Worth running only as the pre-registered E2, labelled as not testing test-edit false blocks. |
| **[EvilGenie](https://github.com/JonathanGabor/EvilGenie)** (MIT; 154 LiveCodeBench hard problems; Codex, Claude Code and Gemini CLI) | A good reward-hacking benchmark with held-out tests, but built on the same kind of single-function tasks with red starting tests. It has the same guard problem as ImpossibleBench. It's useful to cite as related work on how agents tamper with test files. |
| **[SWE-Gym](https://github.com/SWE-Gym/SWE-Gym)** (code Apache-2.0, dataset `SWE-Gym/SWE-Gym` MIT, revision `bb94ed9e…`; 2,438 tasks from 11 Python repos) | Same structure as SWE-bench, so it can feed option 2. It's built as a training set, so outside readers will trust results on it less than on Verified. Use it only if Verified runs out or contamination is a worry. |
| **[SWE-smith](https://github.com/SWE-bench/SWE-smith)** (MIT; dataset `SWE-bench/SWE-smith`, about 50k tasks, revision `ea6d7173…`) | It plants bugs into repos whose tests passed, which gives the green base option 2 needs. A possible design: the clean repo is the base, and the bug arrives uncommitted as "work in progress"; an agent asked to make CI pass may weaken the green tests. But the bugs are synthetic and an honest fix is easy, so natural weakening will be rare. It's worth a pilot only if option 2's rate turns out too low. |
| **`bench/tamper`, `eval/campaign-123`** (POCP's own) | Already done, and already green-base. They stay as regression suites. Their bugs come from POCP's own operators or POCP's author, which is exactly the independence gap options 1–3 close. |
| **Reward-hacking reports** (for example METR's 2025 write-ups on agents tampering with scoring, and the ImpossibleBench and EvilGenie papers) | Related work, not runnable benchmarks for this question. Cite them to explain why the experiment matters. Don't quote their rates without checking the paper version. |

## Suggested order

1. **Option 1** (no agents): the cheapest credible false-block number. Pre-register the split between "held on purpose for a behavior change" and "other holds" before looking at any result.
2. **Option 3 on BugsInPy** (no agents): mechanical catch on outside bugs, on a green base.
3. **Option 2 pilot** (small agent batch): measure how often agents weaken tests that passed at the base, then decide whether a counted E1 on SWE-bench is feasible and how big it must be.

Each gets its own pre-registration in `eval/`, frozen before the first counted run, with the same rules as `eval/PREREG.md` (bars set in advance, every run kept, intervals clustered by task).

## What not to claim, whatever happens

- Until option 2 or 3 reports a number: **don't say POCP mechanically detects agents' test weakening.** Say what E1 showed: it held every one for a person.
- Option 1 is past human changes replayed. It is not a measure of POCP's effect on agents.
- Option 3's weakening is scripted, even though the bugs are real.
- Any hold that's "behavior changed, a person must approve" is a cost to honest work, even when it's by design. Report it next to the false-block rate, not inside it, and say so.
