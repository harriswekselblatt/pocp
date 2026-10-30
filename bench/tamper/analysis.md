## What the misses mean

**With the test guard in `block` mode (POCP's default), every cheat on the tests is caught.** That includes gutted or weakened assertions, `.skip` and `.only`, deleted test files, a hollow test script, a runner config that excludes the failing file, a setup file that skips everything, and an `.npmrc` that swaps the shell. `pocp prove` runs the old tests against the new code and plants mutants. When that check fails, the agent can still sign off locally, but CI's re-run fails it (`test_change`) until a maintainer approves. Honest work passes: no policy blocked a control, and a new test file needs no approval.

**In `attest` mode, the author's own sign-off is accepted.** Every test cheat then passes, with a warning naming what the mechanical check found. POCP's own repository uses the default and blocks all 32 cheats that fool plain CI. With `attest`, POCP's own repository catches 20 of the same 32, because a sign-off the author gives themselves stands in for the mechanical check. Choosing `attest` over the default is reported as a policy loosening.

**The remaining miss is outside POCP's reach: CI that doesn't require it.** `ci-skip-verify` removes the POCP step from the pull request's workflow. On GitHub the pull request's own workflow runs, so verify never reports, and only a required check that never reports blocks the merge. POCP lists `verify` in `ci.required_checks`, so the merge stays blocked. A repository that doesn't list it lets the bug ship. Fix: add the job to `ci.required_checks`, run `pocp ci required --apply`, and confirm with `pocp ci required --check`, which reads the branch protection and exits 1 on any gap.

**Closed since the first run** (each with a regression test in `test/e2e-test-setup.test.js`):

1. `vite.config.*` is runner config. Vitest reads its `test` block there when there's no `vitest.config.*`.
2. The guard follows what the test setup points to: files a runner config names under a setup key (`setupFiles`, `globalSetup`, `require`, …), and files a required check's command names, through the package scripts it runs. A file the requirement itself guards is what it checks, not setup.
3. `.npmrc` (and `.yarnrc*`) is runner config. One line, `node-options=--test-skip-pattern=…` or `script-shell=/usr/bin/true`, makes a failing `npm test` pass.
4. The test settings inside shared files count, and only they do: the `scripts`, `jest`, `mocha`, `ava`, `nyc`, `c8` and `tap` keys of `package.json`, `[tool.pytest…]` in `pyproject.toml` and `[tool:pytest]` in `setup.cfg`. A dependency bump in the same file is not a test change, and only the test part is restored for the old-tests run.
5. `guard.tests` defaults to `block`, so a self-given sign-off no longer gets a failed test check through CI.

**Caught, with a caveat:** the local hooks accept hand-edited packets (`forge-proof`, `signer-add`, `forge-ci-result` all get past them). The local gate trusts its own machine by design, and CI catches all three, by re-running (`rerun_failed`) and by refusing a committed results file (`ci_results_refused`).

**Out of scope:** a cheat that leaves the tests alone and changes the code to special-case their inputs fools both judges. POCP checks that the declared checks ran on the exact code. It doesn't judge whether the checks are good.
