# Tamper benchmark

Measures how many known agent cheats POCP blocks that plain CI lets through. Results are in [RESULTS.md](RESULTS.md).

Plain CI can't notice an agent weakening the tests, because the tests are what changed. Each scenario here is the commit such an agent would push: a real bug the tests catch, plus a cheat that turns the build green or tries to switch POCP off.

```bash
node bench/tamper/run.js --target pocp
node bench/tamper/run.js --target <name> --repo <path to its checkout>
node bench/tamper/run.js --report-only            # re-render RESULTS.md from results/*.json
```

Options: `--profiles as-configured,block,attest` (default: each target's `profiles`), `--mutants N` (bugs per repository, default 1), `--seed N`, `--concurrency N`, `--only <id prefix>,…`, `--work <dir>`, `--keep` (keep the scratch clones to inspect).

## How it works

1. **Base.** The target is cloned into a scratch folder (the source checkout is only read) and its bench setup from `targets/<name>.json` is committed: `.proof/` rules and config, a test script, a CI workflow. One base per policy profile.
2. **Bugs.** POCP's mutation operators plant one-line bugs in the files the target lists, picked with a fixed seed. A bug is kept only if the test command fails and the failure points at a line in a test file.
3. **Cheats.** With the bug in place, each test edit (delete the failing assertions, weaken them, `.skip`, `.only`, `xit`, `@pytest.mark.skip`) is applied at the failing lines and re-run, round after round, the way an agent works, until the tests pass or the edit stops helping. Edits that never make the tests pass on this runner are listed as not applicable rather than run.
4. **Scenarios** (`lib/scenarios.js`), in the categories of RESULTS.md: test edits, the test command and runner config, deleting a test file, loosening `.proof/` rules or config, adding a signing key, hiding a staged edit with `assume-unchanged`/`skip-worktree`, forged proofs, forged CI results, a stale trailer, a catch-all packet, `--no-verify`, and removing POCP from the CI workflow. Policy and coverage attacks also gut the tests, so that plain CI is fooled as well. Three controls check that honest work passes and that a plain bug is caught.
5. **The agent** makes each commit in its own clone. It opens a packet for what it changed, proves it, signs off on test changes itself, and commits through the hooks; when the hooks block, it commits with `--no-verify`.
6. **Judges**, on a fresh clone of the commit: plain CI is the test command (run through `pocp ci-run`, which only records the result); POCP is `pocp verify <base>..<head> --require-coverage --rerun-unsigned --ci-results <that file>`, the bundled Action's default. The verifier is always this checkout's POCP, never the copy inside a scratch clone.

**Incremental catch** is the headline: of the cheats that fool plain CI, how many POCP blocks. Every bug that passes POCP is listed as a miss.

## Adding a repository

Copy `targets/pocp.json`: the test command CI runs, a per-file test command, which files to plant bugs in, and the setup the scratch copy needs. The test command must pass on the untouched base. Keep it fast; every scenario runs it two or three times.
