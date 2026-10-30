# Quickstart: POCP in any repository

This walkthrough uses a tiny shell project, so nothing here depends on JavaScript.
POCP itself needs Node ≥ 20, git and a POSIX shell; your project can be anything.

## 1. Install and initialise

```bash
npm install -g github:harriswekselblatt/pocp#<commit>   # not on npm yet; pin a commit
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

Wrap your test step so its result is recorded against the exact commit, then verify:

```bash
pocp ci-run --results ci.jsonl --dir tests -- sh run.sh
pocp verify origin/main..HEAD --require-coverage --rerun-unsigned --ci-results ci.jsonl
```

See `examples/github/pocp.yml` for a complete GitHub Actions workflow, including
maintainer approvals for rule changes and test changes.

Then run `pocp doctor`. It checks the adoption pitfalls before they block anyone: hooks,
the workflow's approval labels and whether they exist, Actions access when the POCP action
is in a private repository, branch protection against `ci.required_checks`, and that this
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
