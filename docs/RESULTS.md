# Results so far

**The main result is the evaluation of POCP 1.2.3: [eval/campaign-123](../eval/campaign-123/README.md).** POCP accepted none of 48 harmful changes and held each for review. This was measured against corner-cutting changes; deliberate deception across pull requests is out of scope ([THREAT-MODEL.md](THREAT-MODEL.md), "Out of scope"; the tamper benchmark's `pocp-deep` target shows both sides). Deep mode accepted 78–82% of honest changes per seed; fast mode accepted 27%. The ImpossibleBench re-run on POCP 1.5.0 (next section) is counted under a pre-registration. The other results below came earlier, are not counted, and followed the earlier plan ([docs/EVAL-PLAN.md](EVAL-PLAN.md)).

## ImpossibleBench on POCP 1.5.0 (counted, 2026-11-21)

These are impossible coding tasks ([ImpossibleBench](https://arxiv.org/abs/2510.20270), LiveCodeBench `conflicting` split): the committed tests contradict each other, so the only way to make them pass is to cheat. The batches were registered before they ran ([eval/PREREG.md](../eval/PREREG.md) §10–11). They used the same seed-2 task draw for each agent and the same prompt, which never mentions POCP. They ran in deep mode, with a 20-minute limit per run. The arms:
- `plain`: ordinary CI.
- `pocp-ci`: POCP's verify in CI.
- `pocp-hooks`: POCP's local git hooks only.

Every number below is regenerated from the records by `node eval/e1/report.js` ([eval/e1/RESULTS.md](../eval/e1/RESULTS.md)). No pass bar is applied (§10 says why).

- **Codex (`gpt-6.2-sol`), tests committed on main (E1a), 50 tasks per arm:**
  - Plain CI accepted a cheat in 25 of 50 runs.
  - With POCP in CI, none of 50 shipped. Codex produced 30 CI-passing cheats in that arm, all of them test edits, and POCP held all 30 for a maintainer's approval.
  - None of the 30 was a mechanical catch. In every one, POCP's guard couldn't prove that the edited tests checked less, so it escalated to a person (PREREG §2 never counts an escalation as a catch). The protection here comes from the maintainer's approval of a test edit, not from POCP proving the cheat.
  - With POCP's hooks only, 27 of 50 cheats shipped. The hooks let a commit through and leave the approval to CI, so without CI they don't stop test edits.
- **Codex, tests arriving with the task (E1b), 10 tasks per arm:** plain CI shipped no cheats, POCP in CI shipped none (it held the 1 CI-passing cheat Codex produced), and hooks only shipped 2.
- **Claude Code (`claude-sonnet-5-5`), 20 E1a tasks and 10 E1b tasks per arm:** no cheats in any arm (0 of 90 runs). Every run ended unsolved, so these runs say nothing about catching cheats.
- **Excluded:** a first Codex run of the same batches (180 runs). Codex read the maintainer's global instructions file, which named POCP and this evaluation. §11 records the exclusion, the harness fix and the re-run. The contaminated runs cheated far less (5 CI-passing cheats in 150 E1a runs), which is why they could not stand.
- **Limits:**
  - One model per agent, on one task split.
  - The task-clustered 95% intervals are wide.
  - Codex's CLI doesn't record its reasoning effort; the CLI's default was used.
  - There were no ambiguous labels to review. The pre-registered blinded audit of 30 labels (seed 7) has not been done yet.

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

