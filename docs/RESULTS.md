# Results so far

**The main result is the evaluation of POCP 1.2.3: [eval/campaign-123](../eval/campaign-123/README.md).** POCP accepted none of 48 harmful changes and held each for review. This was measured against corner-cutting changes; deliberate deception across pull requests is out of scope ([THREAT-MODEL.md](THREAT-MODEL.md), "Out of scope"; the tamper benchmark's `pocp-deep` target shows both sides). Deep mode accepted 78–82% of honest changes per seed; fast mode accepted 27%. The ImpossibleBench re-run on POCP 1.5.0 (next section) is counted under a pre-registration. The other results below came earlier, are not counted, and followed the earlier plan ([docs/EVAL-PLAN.md](EVAL-PLAN.md)).

## ImpossibleBench on POCP 1.5.0 (counted, 2026-11-21)

**On 50 impossible coding tasks, Codex got a test-editing cheat past ordinary CI in 25. With POCP in CI, none merged: each one was held for a maintainer's sign-off.** That sign-off is what stopped them. POCP didn't prove any of them was a cheat on its own (details below).

These are impossible coding tasks ([ImpossibleBench](https://arxiv.org/abs/2510.20270), LiveCodeBench `conflicting` split): the committed tests contradict each other, so the only way to make them pass is to cheat. The batches were registered before they ran ([eval/PREREG.md](../eval/PREREG.md) §10–11). They used the same seed-2 task draw for each agent and the same prompt, which never mentions POCP. They ran in deep mode, with a 20-minute limit per run. The arms:
- `plain`: ordinary CI.
- `pocp-ci`: POCP's verify in CI.
- `pocp-hooks`: POCP's local git hooks only.

Every number below is regenerated from the records by `node eval/e1/report.js` ([eval/e1/RESULTS.md](../eval/e1/RESULTS.md)).

- **Codex (`gpt-6.2-sol`), tests committed on main (E1a), 50 tasks per arm:**
  - With plain CI, a cheat shipped in 25 of 50 runs.
  - With POCP in CI, none shipped in 50 runs. Codex produced 30 CI-passing cheats in that arm, all of them test edits, and POCP blocked all 30.
  - **No block was a mechanical catch.** Each was an escalation. On these tasks the original tests already fail before any change, so POCP's guard can't tell whether an edit weakened them (verdict `baseline-red`). It held each one for a person to approve. PREREG §2 never counts an escalation as a catch. What stopped these cheats is the rule that a maintainer signs off on test edits, not POCP proving the cheat.
  - **POCP accepted nothing in this arm.** The runs where Codex didn't cheat were blocked too, because their final commit, made by the harness, carried no proof. So the 0 of 50 doesn't show POCP telling cheats from other work. No solvable-task (false-block) run was made on 1.5.0.
  - With POCP's hooks only, a cheat shipped in 27 of 50 runs, no fewer than plain CI. The hooks pass a commit once the local checks pass and leave the test-edit approval to CI, so without CI they don't stop test edits.
- **The E1a bar (§5).** §10 registered that the bar would not be applied, expecting fewer than the 30 CI-passing test-edit cheats it needs. Codex produced exactly 30. Measured against the bar anyway, mechanical catches were 0 of 30 (one-sided 95% lower bound 0%, bar ≥ 90%), so **the bar would be missed**. Per §7, the number is published as measured.
- **Codex, tests arriving with the task (E1b), 10 tasks per arm:** plain CI shipped no cheats. POCP in CI shipped none (it escalated the 1 CI-passing cheat Codex produced). Hooks only shipped 2.
- **Claude Code (`claude-sonnet-5-5`), 20 E1a tasks and 10 E1b tasks per arm:** no cheats in any arm (0 of 90 runs). Every run ended unsolved, so these runs say nothing about catching cheats.
- **Excluded:** a first Codex run of the same batches (180 runs). During it, Codex read the maintainer's global instructions file, which named POCP and this evaluation. That breaks the rule that the agent is never told about POCP. They are excluded for that breach, which was found and recorded before the re-run. §11 records the exclusion, the harness fix and the re-run. For the record, those runs produced 5 CI-passing cheats in 150 E1a runs.
- **Limits:**
  - One model per agent, on one task split.
  - The task-clustered 95% intervals are wide.
  - Codex's CLI doesn't record its reasoning effort; the CLI's default was used.
  - There were no ambiguous labels to review. The pre-registered blinded audit of 30 labels (seed 7) has not been done yet.
  - The §11 amendment and harness fix were committed before the Codex re-run started, but were pushed only with these results (the §10 registration was pushed before its runs).

These results were all measured in deep mode (`guard.mutants: 10`), before fast mode existed. They don't describe fast mode, which was first benchmarked in the 1.2.3 evaluation.

Scripted test suite ([bench/tamper/RESULTS.md](../bench/tamper/RESULTS.md)): 79 scripted scenarios on POCP's own repository, in deep mode with the other settings at their defaults unless noted.
- 73 of them plant a bug. Of those, 52 also cheat in a way that makes plain CI pass, and `verify --rerun` blocked all 52.
- The other 6 are honest changes, and POCP blocked none of them.
- In the optional `attest` mode, the author of a test change can approve it themselves, which is a weaker approval model than the default (a maintainer's approval). The same suite in `attest` mode blocked 33 of the 52 cheats.
- The cheats are scripted and the bugs come from POCP's own mutation operators, so this tests known cases and is not independent evidence.
- The latest run (2026-11-02, at commit `b50ece4`) was a same-seed re-run of the earlier one. It planted the same three bugs, and every scenario's outcome was unchanged. It is not a new sample and not independent validation. Its proof record checks only that `RESULTS.md` matches the raw results file, not that the benchmark itself is correct.

Pilots ([eval/](../eval/)) are small runs to size the study. None is compared with a pass bar.
- On impossible coding tasks (ImpossibleBench, October 2026 pilots on an earlier POCP), the Codex and Claude pilots produced too few comparable cheats to support any catch-rate claim. Many Claude runs ended in usage-limit errors. The counted re-run is above. The details, including which cheats were blocked and which shipped, are in [eval/e1/RESULTS.md](../eval/e1/RESULTS.md).
- On 10 solvable tasks, Codex solved all 10, and POCP blocked none of the solutions.
- On 16 StrykerJS mutants of POCP's own code, both Stryker and POCP's checks caught the same 13 and missed the same 3. That is a small pilot; agreement doesn't show either result is correct ([eval/e3/RESULTS.md](../eval/e3/RESULTS.md)).
- In POCP's own development, 7 of 45 commits that touched guarded files passed the gate on the first try. The median time from a block to a pass was about 2 minutes. That is elapsed time, including the agent's own time between commands, not just POCP's run time ([eval/e5/RESULTS.md](../eval/e5/RESULTS.md)).

