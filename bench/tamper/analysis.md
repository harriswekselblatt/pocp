## What the misses mean

**With the test guard in `block` mode (POCP's default), every test cheat that ran on this repository was caught:** deleted or weakened assertions, `.skip`, deleted test files, and changes to what the test command runs (a hollow test script, an `.npmrc` that swaps the shell, and the others in category 3). `pocp prove` runs the old tests against the new code and plants mutants; when that check fails, CI needs a maintainer's approval.

**Not run on this repository**, because node:test has no such setting or the edit doesn't make its tests pass: `.only`, a runner config that excludes the failing file, a setup file that skips everything, and the pytest and `xit` variants. The guard's handling of those is covered by regression tests (`test/e2e-test-setup.test.js`), not by this benchmark. The full list is under "Not run" below.

**Controls:** the 9 control scenarios are 6 honest changes, none blocked, and 3 changes that add a bug with no cheat. Plain CI and POCP both block those 3, which is the "0/3 fool plain CI, 3/3 blocked" row.

**Found by an outside review, now scenarios:** a cheat split across two commits (`split-commits`), a cheat inside a merge commit (`merge-commit`), a hollowed assertion helper outside the test folders (`helper-hollow`, on a small fixture added to the bench base), and a test that writes forged passing CI-result lines while CI runs it (`forge-ci-in-run`). With the default recipe all four are blocked: the split and the merge are judged on the pull request's net change (`test_change`; the merge also leaves its files `uncovered`), and the helper is found through the test's import. `forge-ci-in-run` is also judged in the faster `--ci-results` mode, which trusts what ran in the job; there too the deleted assertions are caught first (`test_change`), so this benchmark doesn't isolate a forged result on its own.

**In `attest` mode, the author's own sign-off is accepted.** Every test cheat then passes, with a warning naming what the mechanical check found. POCP's own repository uses the default and blocks all 52 cheats that fool plain CI. With `attest`, POCP's own repository catches 33 of the same 52 (the split and merge cheats are still blocked there), because a sign-off the author gives themselves stands in for the mechanical check. Choosing `attest` over the default is reported as a policy loosening.

**The remaining miss is outside POCP's reach: CI that doesn't require it.** `ci-skip-verify` removes the POCP step from the pull request's workflow. On GitHub the pull request's own workflow runs, so verify never reports, and only a required check that never reports blocks the merge. POCP lists `verify` in `ci.required_checks`, so the merge stays blocked. A repository that doesn't list it lets the bug ship. Fix: add the job to `ci.required_checks`, run `pocp ci required --apply`, and confirm with `pocp ci required --check`, which reads the branch protection and exits 1 on any gap.

**Closed since the first run** (each with a regression test in `test/e2e-test-setup.test.js`):

1. `vite.config.*` is runner config. Vitest reads its `test` block there when there's no `vitest.config.*`.
2. The guard follows what the test setup points to: files a runner config names under a setup key (`setupFiles`, `globalSetup`, `require`, …), and files a required check's command names, through the package scripts it runs. A file the requirement itself guards is what it checks, not setup.
3. `.npmrc` (and `.yarnrc*`) is runner config. One line, `node-options=--test-skip-pattern=…` or `script-shell=/usr/bin/true`, makes a failing `npm test` pass.
4. The test settings inside shared files count, and only they do: the `scripts`, `jest`, `mocha`, `ava`, `nyc`, `c8` and `tap` keys of `package.json`, `[tool.pytest…]` in `pyproject.toml` and `[tool:pytest]` in `setup.cfg`. A dependency bump in the same file is not a test change, and only the test part is restored for the old-tests run.
5. `guard.tests` defaults to `block`, so a self-given sign-off no longer gets a failed test check through CI.

**Caught, with a caveat:** the local hooks accept hand-edited packets (`forge-proof`, `signer-add`, `forge-ci-result` all get past them). The local gate trusts its own machine by design, and CI catches all three by re-running the checks (`rerun_failed`); the default recipe doesn't read a results file at all, and the `--ci-results` mode refuses one that is committed (`ci_results_refused`).

**Out of scope:** a cheat that leaves the tests alone and changes the code to special-case their inputs fools both judges. POCP checks that the declared checks ran on the exact code. It doesn't judge whether the checks are good.
