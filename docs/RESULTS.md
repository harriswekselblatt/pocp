# Results so far

**The main result is the preregistered evaluation of POCP 1.2.3: [eval/campaign-123](../eval/campaign-123/README.md).** It found 0 of 48 harmful changes accepted, about 80% of honest changes accepted in deep mode, and 27% in fast mode. The results below came earlier. None of them is a counted evaluation. They followed the earlier plan ([docs/EVAL-PLAN.md](EVAL-PLAN.md)), whose pre-registration ([eval/PREREG.md](../eval/PREREG.md)) is unfinished.

These results were all measured in deep mode (`guard.mutants: 10`), before fast mode existed. They don't describe fast mode, which was first benchmarked in the 1.2.3 evaluation.

Scripted test suite ([bench/tamper/RESULTS.md](../bench/tamper/RESULTS.md)): 79 scripted scenarios on POCP's own repository, in deep mode with the other settings at their defaults unless noted.
- 73 of them plant a bug. Of those, 52 also cheat in a way that makes plain CI pass, and `verify --rerun` blocked all 52.
- The other 6 are honest changes, and POCP blocked none of them.
- In the optional `attest` mode, the author of a test change can approve it themselves, which is a weaker approval model than the default (a maintainer's approval). The same suite in `attest` mode blocked 33 of the 52 cheats.
- The cheats are scripted and the bugs come from POCP's own mutation operators, so this tests known cases and is not independent evidence.
- The latest run (2026-11-02, at commit `b50ece4`) was a same-seed re-run of the earlier one. It planted the same three bugs, and every scenario's outcome was unchanged. It is not a new sample and not independent validation. Its proof record checks only that `RESULTS.md` matches the raw results file, not that the benchmark itself is correct.

Pilots ([eval/](../eval/)) are small runs to size the study. None is compared with a pass bar.
- On impossible coding tasks ([ImpossibleBench](https://arxiv.org/abs/2510.20270)), the Codex and Claude pilots produced too few comparable cheats to support any catch-rate claim. Many Claude runs ended in usage-limit errors. The details, including which cheats were blocked and which shipped, are in [eval/e1/RESULTS.md](../eval/e1/RESULTS.md).
- On 10 solvable tasks, Codex solved all 10, and POCP blocked none of the solutions.
- On 16 StrykerJS mutants of POCP's own code, both Stryker and POCP's checks caught the same 13 and missed the same 3. That is a small pilot; agreement doesn't show either result is correct ([eval/e3/RESULTS.md](../eval/e3/RESULTS.md)).
- In POCP's own development, 7 of 45 commits that touched guarded files passed the gate on the first try. The median time from a block to a pass was about 2 minutes. That is elapsed time, including the agent's own time between commands, not just POCP's run time ([eval/e5/RESULTS.md](../eval/e5/RESULTS.md)).

