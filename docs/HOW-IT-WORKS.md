# How POCP works

What POCP checks, how its two test-check modes differ, what it catches, and what it doesn't do. Setup is in [QUICKSTART.md](QUICKSTART.md); every option is in [REFERENCE.md](REFERENCE.md).


A rule in `.proof/rules.json` says which files need which checks:

```json
{
  "pocp": 1,
  "requirements": [
    { "id": "billing-tests", "globs": ["src/billing/**"],
      "obligation": { "kind": "test", "run": "node --test test/billing.test.js" } }
  ]
}
```

A check is any command, such as `npm test`, `pytest`, `cargo test`, `go test ./...` or `make check`.

Locally, a git hook blocks a commit that touches `src/billing/**` until a packet records that `node --test test/billing.test.js` passed on exactly the staged code. `pocp fix` runs the checks and writes the packet, and the commit gets a trailer that points to it:

```
Proof-Of-Change: p-2f007850 subject=sha256:2ad8c12023b7 policy=sha256:f21acbea749e proven=1/1 attested=0/0
```

In CI, `pocp verify origin/main..HEAD --require-coverage --rerun` (the base branch, then the pull request's head):

- re-runs every required check itself, instead of trusting the packets, which are only pointers;
- judges the pull request by the base branch's rules, so the pull request can't remove or loosen a rule or add its own signing key;
- when the pull request edits existing tests or test setup, runs the test check once, on the pull request's net change, so a weakening split across commits or placed in a merge commit is judged the same way. It has two modes (below);
- fails with a named reason, and says when only a maintainer can resolve it, for example by approving an intended test change with a label. On GitHub, a separate trusted workflow turns that into one commit status, **`pocp`**: green when verified, yellow while it waits for a maintainer or a check didn't finish, red on a real failure ([docs/STATUS.md](STATUS.md)).

## The test check: fast and deep

Both modes first run the old versions of the edited tests on the new code. If they run to the end and fail, but pass on the base, behavior changed, and a person approves it. If they don't finish (a timeout, for example, under load), the result is inconclusive rather than a behavior change, and it still needs a re-run or a person.

- **Fast** (`guard.mutants: 0`, what `pocp init` sets up). No test edit passes on its own: every change to tests or test setup goes to a person, including added lines and new test files. Text rules can't tell whether an edit still tests what it did (added lines alone can disable existing assertions), so fast mode doesn't pretend to. Its review lists what changed and flags added lines that match common risky patterns (skipping or focusing tests, exiting, early returns, patched assertions, mocking APIs, exit-code resets, test hooks, globals, empty `catch`) so the reviewer knows where to look first.
- **Deep** (`guard.mutants: 10`, `pocp init --deep`). The only mode where a test edit can pass without a person. POCP plants a sample of small bugs (flipped comparisons, swapped operators, changed constants) and checks that the new tests catch every sampled bug the old tests caught. New test files count too: they run with the old ones, so one that exits early or patches an assertion makes the suite miss bugs it caught. It samples: a weakening that matters only outside the sample passes, and only the bug types POCP can plant are tried. On POCP's own code, about 14% of StrykerJS's mutants are edits POCP's operators can make. It is much slower (below).

A project set up before fast mode existed, with no `guard.mutants` in its config, keeps deep mode: the built-in default is still 10, and upgrading POCP never rewrites a config. To switch such a project to fast mode, set `"guard": { "mutants": 0 }` in `.proof/config.json` in a pull request of its own. Lowering `guard.mutants` is a policy change, so CI fails it until a maintainer approves it with the `pocp-approve-policy` label.

Within the limits in [docs/THREAT-MODEL.md](THREAT-MODEL.md):

| Change | Plain CI | Fast mode | Deep mode |
|---|---|---|---|
| Deletes or weakens a failing assertion | passes | blocked if the old tests run to the end and fail on the new code; otherwise the edit goes to a person | blocked if the old tests run to the end and fail on the new code, or a sampled bug goes undetected |
| Marks tests skipped or `.only` | passes | goes to a person | blocked if a sampled bug goes undetected |
| Hollows out the test script, runner config, or an assertion helper the tests import | passes | goes to a person, for helpers POCP finds by following imports | blocked, for helpers POCP finds by following imports |
| Adds a test file, or lines to a test, that disable other tests | passes | goes to a person | blocked if a sampled bug goes undetected |
| Removes or loosens the rule that requires a check | n/a | blocked: the base branch's rules apply | same |
| Edits a packet so failing proofs read as passed | n/a | blocked: the checks are re-run | same |
| Edits or removes POCP's CI workflow | passes | with `pocp` required: stays yellow until a maintainer approves the workflow change (`pocp-approve-workflow`); see the limit below | same |
| Writes code that special-cases the test inputs | passes | not blocked | not blocked |

"Goes to a person" means the change waits until a maintainer approves it with a label. With the `pocp` status that's a yellow wait, not a red ✗. In fast mode every test edit is reviewed. In deep mode an edit passes without review only when the sampled bugs show no loss, which is evidence, not a proof that the tests are as strong as before.

## What it doesn't do

- It doesn't judge whether code is honest. Code written to pass the specific test inputs passes every mechanical check.
- It doesn't enforce merges. `verify` fails a check; whether a failing check blocks the merge is your Git host's setting (on GitHub, branch protection).
- It can't fully stop a pull request from faking its own check. A pull request runs its own copy of the workflow. With the `pocp` status required, a pull request that edits CI files stays yellow until a maintainer approves the edit, and pull requests from forks can't post a status at all. But a branch pushed to your repository by someone with write access, including an agent using your token, can edit its workflow to post its own `pocp` status. Read the diff of any such pull request that touches `.github/` ([docs/STATUS.md](STATUS.md#a-limit-of-the-pocp-status)). A dedicated GitHub App for the reporter, which would close this, is planned.
- It doesn't measure new tests. The test check compares a change with tests that already existed, so a weak test added in the same pull request isn't measured.
- It isn't hermetic. Checks can read the network, environment variables and installed packages, and the re-runs execute the pull request's code in your CI job.
- It adds CI time. `verify` re-runs your required checks, so each pull request costs about one extra test run, in parallel with your other jobs. On POCP's own pull requests in fast mode, `verify` took 3 to 4 minutes next to test jobs of 3 to 4 minutes, and 10 to 11 minutes when several commits edited tests, because the old tests ran as the whole suite. A rule's `changed_test_command` runs only the edited test files instead ([docs/REFERENCE.md](REFERENCE.md#faster-test-edits-changed_test_command)). It hasn't been measured on other projects yet.
- Deep mode is slow. It re-runs the required checks for each planted bug, so its cost grows with your suite's run time. On POCP's own repository it took up to about 17 minutes locally. One measured case: on 2026-11-02, a full `verify` of a 13-commit pull request to POCP that edited test helpers took about 25 minutes on a GitHub runner, of which the test check took about 16 ([run](https://github.com/harriswekselblatt/pocp/actions/runs/41524329250)).
- A process a check starts in a new session (`setsid`, a daemon) can outlive the check.
- Native Windows isn't supported. The hooks and checks need a POSIX shell: Linux, macOS, or Windows through WSL.

