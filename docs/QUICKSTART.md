# Quickstart: POCP in any repository

This walkthrough uses a tiny shell project, so nothing here depends on JavaScript.
POCP itself needs Node ≥ 20, git and a POSIX shell; your project can be anything.

## 1. Install and initialise

```bash
npm install -g proof-of-change
cd your-repo
pocp init --hooks
```

`.proof/` now holds `config.json`, `rules.json` and empty `packets/` and `misses/` folders.
`init` also prints the test layout it found; check it, and add any test folder it missed to
`guard.extra_test_globs` in `config.json`. Commit them.

## 2. Say what must be proven

`.proof/rules.json`:

```json
{
  "pocp": 1,
  "triggers": { "globs": [{ "glob": "bin/**", "require_packet": true }] },
  "requirements": [
    { "id": "shell-tests", "glob": "bin/**",
      "obligation": { "kind": "test", "run": "sh run.sh", "cwd": "tests" } }
  ]
}
```

Any command works as a check: `cargo test`, `pytest -q`, `go test ./...`, `make check`,
`./gradlew test`. Use `cwd` when it must run in a subfolder.

```bash
pocp rules check
```

## 3. Make a change

```bash
$EDITOR bin/greet
git add bin/greet
git commit -m "Default the name"          # blocked: says what is wrong, why, and what to run
pocp fix --intent "Default the name"      # opens the packet, runs "sh run.sh" in tests/ on the staged code
git commit -m "Default the name"          # passes; adds a Proof-Of-Change trailer
```

`pocp fix` is the same as `pocp open --intent … --touch bin/greet` then `pocp prove`. When
something needs a person (a test change POCP could not check, a policy loosening), it says
who and what, and never signs off itself.

## 4. Add CI

Verify every pull request. verify re-runs each required check itself, on the exact commit,
by the base branch's rules; your existing test step stays as it is:

```bash
pocp verify origin/main..HEAD --require-coverage --rerun
```

A faster mode runs your tests once, through `pocp ci-run`, and passes `--ci-results` to verify.
It trusts everything that ran earlier in the job: a new test file can write a passing result
for any check. See [the threat model](THREAT-MODEL.md) before choosing it.

### On GitHub

`pocp init --github` writes three workflows, with the POCP actions pinned to your POCP release:

```bash
pocp init --github        # .github/workflows/pocp.yml, pocp-status.yml, pocp-labels.yml
```

Pushing workflow files needs a GitHub login with the `workflow` permission (for the GitHub CLI: `gh auth refresh -s workflow`).

- **`pocp.yml`** runs verify on every pull request.
- **`pocp-status.yml`** is the trusted reporter: it sets one commit status, **`pocp`**. It's green when verified, yellow while waiting for a maintainer or when a check didn't finish, and red on a real failure. It never runs pull request code.
- **`pocp-labels.yml`** removes every approval label on each push, so an approval covers only the code reviewed.

Then:

1. **Create the approval labels.** `pocp doctor` lists any that are missing, with the `gh label create` commands. A maintainer approves a change by adding its label: `pocp-approve-tests`, `pocp-approve-policy`, `pocp-approve-inconclusive`, `pocp-approve-coverage` or `pocp-approve-workflow`. [docs/STATUS.md](STATUS.md) says what each covers.
2. **The `pocp` status is on from the start.** On a GitHub repository, `pocp init --github` sets the repository variable `POCP_STATUS_LIVE` through your `gh` login, so a pull request waiting for approval shows yellow, with no red ✗ and no failure email. (`--no-live` leaves it off.)
3. **Once the pull request with the workflows merges, require the status:** `pocp ci required --apply`. It sets branch protection from `.proof/config.json`: the `pocp` status (in place of the `verify` job, if that was required), pull requests only, admins included, and branches up to date before merging (so the merged code is the code that was verified; when `main` moves, a pull request needs "Update branch" before it merges). Each can be turned off in `ci`. On a free plan's private repository GitHub has no branch protection: the status is then a signal only, and the command says so.

   Do the two steps together: once the variable is on, `verify` passes on a wait, so requiring `verify` alone would let an unapproved pull request merge.

   To roll back, unset the variable and require `verify` again.

If your repository has a second maintainer, keep the default `"ci": { "workflow_approver": "independent" }`: then the author of a CI change can't approve it themselves. See [docs/STATUS.md](STATUS.md) for that, and for the limits of the `pocp` status.

Then run `pocp doctor`. It checks the adoption pitfalls before they block anyone: hooks,
the workflow's approval labels and whether they exist, whether a reporter sets the `pocp` status, Actions access when the POCP action
is in a private repository, branch protection against the whole plan (required checks, pull requests only, admins, up-to-date branches), and that this
first pull request carries only `.proof/` and CI files (until it merges, CI judges with the
base branch's rules, so any other change would get two verdicts). It changes nothing.

When pull requests wait for a maintainer's approval, find and give them in one place:

```bash
pocp approvals                          # every open PR, across your repos, waiting only for a label
pocp approvals --approve owner/repo#12  # shows what the label approves, asks you, then adds it
```

`--approve` is for a person at a terminal: it asks you to type the PR number before adding the
label. Agents can list, never approve.

## 5. Measure

```bash
pocp history --test "sh tests/run.sh"     # how often would the gate have fired; do past fix tests catch their bugs?
pocp eval --mutants 50 --save eval.json   # how many planted bugs do the required checks catch?
pocp eval --replay eval.json --missed     # after adding tests: re-run the same survivors
```

## 6. When something escapes

```bash
pocp miss record --description "greet prints nothing without a name" --stage production --file bin/greet
# add a requirement with "source": "miss:<id>" that would catch it, then:
pocp miss close <id> --replay <commit where it escaped>
```

Next: [the threat model](THREAT-MODEL.md) explains what each record does and doesn't prove.

## Step by step on GitHub

POCP needs Node 20 or later, git and a POSIX shell. Your project can be in any language. In a git repository:

```bash
npm install --save-dev proof-of-change
npx pocp init --hooks --github
```

`init` creates `.proof/` and reports where it found your tests. `--hooks` installs the git hooks; hooks you already have keep running. `--github` writes three workflows to `.github/workflows/`, pinned to this release:

- `pocp.yml` runs verify;
- `pocp-status.yml` sets the `pocp` status;
- `pocp-labels.yml` removes approval labels on every push.

Then:

1. **Say what must be proven.** Add a rule to `.proof/rules.json` (section 2). Change a file it covers, and commit. If the commit is blocked, run `npx pocp fix --intent "<what the change does>"` and commit again. Anyone can skip the hook with `git commit --no-verify`; CI then flags the commit as made without its proof.
2. **Check the setup:** `npx pocp doctor`. It lists anything missing, with the commands to fix it, such as the approval labels to create on GitHub. Pushing the workflow files needs a GitHub login with the `workflow` permission.
3. **Merge the pull request with the workflows, then require the status:** `npx pocp ci required --apply`. `init --github` already turned the `pocp` status on (unless `--no-live`), so waits are yellow, not red. This step makes GitHub block merges until `pocp` is green: it requires `pocp` (replacing `verify` if that was required), pull requests only, admins included, and branches up to date before merging, so the code that merges is the code that was verified. Each can be turned off, and `pocp doctor` reports any gap. On a free plan's private repository GitHub has no branch protection, so the status is a signal only there. Merge queues (GitHub's, Graphite's) aren't supported yet ([docs/REFERENCE.md](REFERENCE.md)). To roll back, unset `POCP_STATUS_LIVE` and require `verify` again.

[docs/QUICKSTART.md](QUICKSTART.md) walks through this on a non-JavaScript project. [docs/STATUS.md](STATUS.md) covers the status, the approval labels, who may approve, and its limits.

This repository uses POCP on itself: every pull request needs the `pocp` status, plus the test suite on Ubuntu with Node 20, 22 and 24 and the eval tests. The test suite also runs on macOS (one Node version on each pull request, all three nightly), which is not required while GitHub's macOS runners are unreliable.

