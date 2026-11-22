# Quickstart: POCP in any repository

This walkthrough uses a tiny shell project, so nothing here depends on JavaScript.
POCP itself needs Node ≥ 20, git and a POSIX shell; your project can be anything.

## 1. The example project

In a git repository, two files:

`bin/greet`

```sh
#!/bin/sh
echo "Hello, $1"
```

`tests/run.sh`

```sh
out=$(sh "$(dirname "$0")/../bin/greet" Ada)
[ "$out" = "Hello, Ada" ] || { echo "FAIL: got '$out'"; exit 1; }
echo ok
```

```bash
git add -A && git commit -m "greet"
```

## 2. Install and choose where the checks run

```bash
npm install -g proof-of-change
pocp init --local            # no CI: the git hooks on your machine are the gate
```

or, for a GitHub repository whose `origin` exists and with `gh` logged in:

```bash
pocp init --hooks --github   # CI re-runs every check and can block merges
```

Section 5 says what each one trades. You can switch later with `pocp ci off` and `pocp ci on`.

`.proof/` now holds `config.json`, `rules.json` and empty `packets/` and `misses/` folders.
`init` also prints the test layout it found. For a shell project like this one it finds none,
which is fine: a file that a rule's check runs (`tests/run.sh` below) is guarded as test setup
anyway. For test folders it misses in a real project, add them to `guard.extra_test_globs` in
`config.json`.

The first time `init` runs at a terminal it asks one question, whether you'd like a README badge
(`uses POCP`). The default is no. A yes prints the markdown for you to paste; no file
is changed, and it isn't asked again. `pocp init --badge` prints it without asking.

## 3. Say what must be proven

In `.proof/rules.json`, replace `"requirements": []` with this rule, and keep the rest of the
file as `init` wrote it:

```json
  "requirements": [
    { "id": "shell-tests", "glob": "bin/**",
      "obligation": { "kind": "test", "run": "sh run.sh", "cwd": "tests" } }
  ]
```

Any command works as a check: `cargo test`, `pytest -q`, `go test ./...`, `make check`,
`./gradlew test`. Use `cwd` when it must run in a subfolder.

With `--github`, the adoption goes in through a pull request (step 1 of "On GitHub" below), so
first make a branch for it: `git checkout -b adopt-pocp`. In local mode, commit on `main`.

```bash
pocp rules check
git add -A && git commit -m "Adopt POCP"
```

If the hook blocks the adoption commit (with `--github` it adds CI files, which need a packet),
run `pocp fix --intent "Adopt POCP"` and commit again.

## 4. Make a change

Change `bin/greet` to default the name: `echo "Hello, ${1:-world}"`.

```bash
git checkout -b default-name      # on GitHub: from main, once the adoption pull request has merged and you've pulled it
git add bin/greet
git commit -m "Default the name"          # blocked: says what is wrong, why, and what to run
pocp fix --intent "Default the name"      # opens the packet, runs "sh run.sh" in tests/ on the staged code
git commit -m "Default the name"          # passes; adds a Proof-Of-Change trailer
```

`pocp fix` is the same as `pocp open --intent … --touch bin/greet` then `pocp prove`. When
something needs a person (a test change POCP could not check, a policy loosening), it says
who and what, and never signs off itself.

Editing only a test works the same way, and `pocp fix` runs the rule's check in `tests/`. In
fast mode (what `init` writes), every test edit then waits for a person: below, in local mode;
a maintainer's label on GitHub.

## 5. Where the checks run

| | GitHub CI | Local mode |
|---|---|---|
| Commits checked | hooks, then verify in CI | hooks only |
| Re-run on another machine | every pull request | none; `verify --require-coverage --rerun` on yours before merging |
| Unverified merges blocked | with branch protection | never |
| `git commit --no-verify` | caught by verify | caught only if you verify before merging |
| Test and policy approvals | a maintainer's label | you, through `--accept-*` |
| You trust | the runner and GitHub | your own machine |
| Costs | Actions minutes: about one extra test run per pull request | nothing |

### No CI (local mode)

`pocp init --local` sets `ci.mode: "local"` in `.proof/config.json` and installs the hooks. On a
repository that already has POCP's workflows, `pocp ci off` disables them on GitHub (`pocp.yml`,
`pocp-status.yml`) and sets the mode; `pocp ci on` enables them again and
removes it. Neither touches the workflow files, so there is nothing to commit under
`.github/`; commit the change to `.proof/config.json`. Switching to local mode is a policy
loosening, so verify asks for `--accept-policy-change` on that commit. `ci off` also finds your
other workflows that fail because GitHub won't start their jobs for billing, and asks before
disabling them (`gh workflow enable <file>` turns each back on). The test guard's fast
or deep mode is a separate setting and works the same under the hooks.

Before merging a branch, run what CI would have run. `<base>..HEAD` is the branch's commits:
`main..HEAD` for a local branch, `origin/main..HEAD` for one you pushed.

```bash
pocp verify --require-coverage --rerun main..HEAD
```

It re-runs each commit's checks from a clean checkout, by the base branch's rules, and
`--require-coverage` fails a commit made without its proof (`git commit --no-verify`). When it
waits for a person (a test change the check couldn't pass, a policy loosening), read the change,
then approve it for that exact head:

```bash
pocp verify --require-coverage --rerun main..HEAD --accept-test-change=$(git rev-parse HEAD)
```

(or `--accept-policy-change`). verify then prints `verified`. It doesn't say an approval was
used, so the record of what you approved is the command you ran.

**A local approval is a flag, not a person.** Anything that can run commands on your machine,
an agent included, can pass `--accept-*` itself, just as it can run `git commit --no-verify`. It
is the same trade as the rest of local mode: you trust your own machine. Where you need a test
change or a policy loosening to wait for a person, use CI, where only a maintainer's label
approves it.

`pocp doctor` reports local mode, POCP workflows still running in it, and Actions jobs that
GitHub doesn't start for billing reasons.

### On GitHub

Before `pocp init --github`: the repository exists on GitHub, `origin` points at it, and `gh` is
logged in with the `workflow` permission (`gh auth refresh -s workflow`), which pushing workflow
files needs. `init --github` writes two workflows, with the POCP actions pinned to your POCP
release:

- **`pocp.yml`** runs verify on every pull request.
- **`pocp-status.yml`** is the trusted reporter: it sets one commit status, **`pocp`**. It's green when verified, yellow while waiting for a maintainer or when a check didn't finish, and red on a real failure. It never runs pull request code.

Through your `gh` login it also creates the approval labels and turns the `pocp` status on
(the repository variable `POCP_STATUS_LIVE`), so a pull request waiting for approval shows
yellow, with no red ✗ and no failure email (`--no-live` leaves it off). Without `origin` it can
do neither and says so: `pocp doctor` then lists the labels to create, and step 3 below turns
the status on.

Before pushing, set your toolchain and install command in `pocp.yml` (the lines marked ▶):
verify runs every check on a fresh runner, so a check like `npm test` or `pytest` needs them.

1. **Push `adopt-pocp` and open the adoption pull request** with `.proof/` and the workflows. It changes CI files, so its verify waits for `pocp-approve-policy`: read the diff and add the label (`pocp approve owner/repo#<number>`). The reporter only runs once it is on the default branch, so this pull request shows no yellow `pocp` status: its `verify` check is green, and its job summary's heading names the label it waits for. Nothing is required yet, and no other label is needed. Keep this pull request to `.proof/` and CI files (`pocp doctor` checks): until it merges, CI judges with the base branch's rules.
2. **A maintainer approves a change by adding its label:** `pocp-approve-tests`, `pocp-approve-policy`, `pocp-approve-inconclusive`, `pocp-approve-coverage` or `pocp-approve-workflow`. [STATUS.md](STATUS.md) says what each covers.
3. **Once the adoption pull request merges, require the status:** `pocp ci required --apply`. It sets branch protection from `.proof/config.json`: the `pocp` status (in place of the `verify` job, if that was required), pull requests only, admins included, and branches up to date before merging (so the merged code is the code that was verified; when `main` moves, a pull request needs "Update branch" before it merges). Each can be turned off in `ci`. It also turns the `pocp` status on if `init` couldn't. On a free plan's private repository GitHub has no branch protection: the status is then a signal only, and the command says so. Merge queues aren't supported yet ([REFERENCE.md](REFERENCE.md)).

   Do the two together: once the status is on, `verify` passes on a wait, so requiring `verify` alone would let an unapproved pull request merge. To roll back, unset `POCP_STATUS_LIVE` and require `verify` again.

If your repository has a second maintainer, keep the default `"ci": { "workflow_approver": "independent" }`: then the author of a CI change can't approve it themselves. See [STATUS.md](STATUS.md) for that, and for the limits of the `pocp` status.

An approval covers only the code reviewed: a label added before the latest push doesn't count,
and the reporter removes it, so add it again after reviewing the new commits. Neither workflow
uses `pull_request_target` (which GitHub blocks by default in public repositories from
December 2, 2026). To upgrade, see [REFERENCE.md, Upgrading](REFERENCE.md#upgrading); `pocp doctor` says when
the workflows are out of date.

**If agents push branches with your token,** a workflow on such a branch can post its own
`pocp: success`. Give the reporter its own GitHub App and require `pocp` from it:
[STATUS.md, "Give the reporter its own identity"](STATUS.md#give-the-reporter-its-own-identity).
It takes a public repository, or GitHub Pro or Team for a private one.

Then run `pocp doctor`. It checks the adoption pitfalls before they block anyone: hooks,
the workflow's approval labels and whether they exist, whether a reporter sets the `pocp` status, Actions access when the POCP action
is in a private repository, branch protection against the whole plan (required checks, pull requests only, admins, up-to-date branches), and that the
adoption pull request carries only `.proof/` and CI files. It changes nothing.

When pull requests wait for a maintainer's approval, find and give them in one place:

```bash
pocp approve                            # every open PR, across your repos, waiting only for a label
pocp approve owner/repo#12              # shows every approval it waits for, asks you once, then adds them
```

It asks you to type the pull request's number before adding a label, so a person at a terminal
approves. Agents can list, never approve.

### Another CI

Verify every pull request. verify re-runs each required check itself, on the exact commit,
by the base branch's rules; your existing test step stays as it is:

```bash
npm install --prefix "$HOME/.pocp" --no-save --ignore-scripts proof-of-change@1.5.0
node "$HOME/.pocp/node_modules/proof-of-change/bin/pocp.js" verify origin/main..HEAD --require-coverage --rerun
```

Install the verifier outside the checkout and run it with `node`, as the GitHub workflow does.
Not `npx pocp` from inside it: the pull request controls the checkout's `package.json`, `.npmrc`
and `node_modules`, so npx would run whatever `pocp` the pull request ships.

A faster mode runs your tests once, through `pocp ci-run`, and passes `--ci-results` to verify.
It trusts everything that ran earlier in the job: a new test file can write a passing result
for any check. See [the threat model](THREAT-MODEL.md) before choosing it.

## 6. Measure

```bash
pocp history --test "sh tests/run.sh"     # how often would the gate have fired; do past fix tests catch their bugs?
pocp eval --mutants 50 --save eval.json   # how many planted bugs do the required checks catch?
pocp eval --replay eval.json --missed     # after adding tests: re-run the same survivors
```

`pocp eval` plants bugs only in source files whose extension it knows: `.js`, `.mjs`, `.cjs`,
`.ts`, `.tsx`, `.jsx`, `.py`, `.rb`, `.go`, `.java`, `.rs`, `.c`, `.cc`, `.cpp`, `.h`, `.cs`,
`.php`, `.swift` and `.kt`. This shell example has none, so here it reports "no source files
are guarded by requirements" and `--replay` has no `eval.json` to read. Run it on a project in
one of those languages.

## 7. When something escapes

```bash
pocp miss record --description "greet prints nothing without a name" --stage production --file bin/greet
# add a requirement with "source": "miss:<id>" that would catch it, then:
pocp miss close <id> --replay <commit where it escaped>
```

Next: [the threat model](THREAT-MODEL.md) explains what each record does and doesn't prove.
