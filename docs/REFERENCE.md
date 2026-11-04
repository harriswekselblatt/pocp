# POCP reference

The details behind [the README](../README.md): rules, obligations, how proof is tied to code, CI, signed proofs, agents, misses and measuring. The protocol itself is in [SPEC.md](../SPEC.md).

## Rules

`.proof/rules.json` says when a change needs a packet and which checks it must include:

```json
{
  "pocp": 1,
  "triggers": {
    "broad_files": 10,
    "cross_area": { "areas": 4, "min_files": 8 },
    "globs": [
      { "glob": "src/auth/**", "require_packet": true },
      { "glob": "docs/**", "require_packet": false }
    ]
  },
  "requirements": [
    { "id": "billing-tests", "glob": "src/billing/**",
      "obligation": { "kind": "test", "run": "node --test test/billing.test.js" } }
  ]
}
```

- A change needs a packet when it touches a protected glob, touches a file a requirement guards, changes 10+ files, or changes 8+ files across 4+ folders.
- Docs, tests, lockfiles and images don't count toward those sizes (`count_exempt`), nor do globs with `require_packet: false`. Run `pocp history` on your repository to see how often the defaults would ask for a packet, and tune them from there.
- **Globs:** `**` crosses folders; `*` and `?` stay within one folder. A path with no wildcard matches only that exact file, so write `src/auth/**` for a folder (`rules check` warns about this). Braces (`{js,ts}`), `[ ]` classes and a leading `./` aren't supported and are rejected as errors; list patterns separately with `"globs": [...]`.
- When a packet opens, the requirements matching its files are added to it automatically. Nobody can remove them.
- Changing `.proof/rules.json`, `.proof/config.json` or `.proof/allowed_signers` is itself a change that needs a packet, so weakening the rules is never silent.
- **Test guard:** modifying an existing test or the test setup (runner config, `.npmrc`, the test settings in `package.json` / `pyproject.toml` / `setup.cfg`, and any file a runner config or a required check's command points to, such as a setup file) needs a packet, and `pocp prove` checks mechanically that nothing was weakened. (1) The old versions of the changed tests are run against the new code: if they run to the end and fail, and pass on the base, behavior changed; if they don't finish (a timeout, a signal, a spawn error), the result is inconclusive, not a behavior change. (2) In deep mode (`guard.mutants` above 0: the built-in default of 10, and what `pocp init --deep` writes), a seeded sample of small bugs is planted in the source those tests guard, starting with lines the change touched: every bug the old tests catch, the new tests must catch too. Only a check that runs to the end and fails catches a bug: a timeout (as under load), a kill or a command that can't start says nothing. A *mutant* run like that is retried once, with 3× the time limit if it timed out; if it still doesn't finish, on either side, the check can't pass (it is inconclusive and needs a person, or a re-run that finishes). Baseline runs (the checks on the new code, the old tests on the new code, the base) aren't retried: one that doesn't finish blocks as `inconclusive`, including when the old tests time out on the new code but pass on the base (a timeout says nothing about behavior); on an overloaded machine, re-run with `--force`. Worst case, every sampled mutant hangs every check: up to 4× each check's time limit per mutant on the old side (the run plus a 3× retry), divided across the parallel jobs. With the defaults (10 mutants, a 10-minute limit, one check, 4 jobs) that's about 100 minutes of wall time before the result is `inconclusive`. In fast mode (`guard.mutants: 0`, what a plain `pocp init` writes), (2) is replaced by a structural review: the edit passes only if it adds lines to existing test files and none of them matches the risky text patterns listed in the README (skips, exits, early returns, patched assertions, the common mocking APIs, exit-code resets, test hooks, `globalThis` assignments, empty `catch`); anything else is `needs-review` and goes to a person (SPEC §6.2). A config without `guard.mutants` keeps the built-in 10, so upgrading never turns deep mode off. To switch an existing project to fast mode, set `guard.mutants: 0` in `.proof/config.json`; that is a policy change a maintainer approves (`pocp-approve-policy`). A pass is recorded as a proof; no sign-off is needed. Adding tests is free, and renaming or moving tests between files passes when the required check finds the tests by itself (`npm test`, `node --test test/`, `pytest tests/`). When a rule's `run` names the test file (`node test/math.test.js`), an honest rename is blocked: the rule has to change with it (a policy change a maintainer approves), and the base's command, which CI judges by, no longer finds the file, so the test guard can't pass either (`--accept-test-change` and the policy label get it through). Point rule commands at a test directory or the test runner rather than at single files. Only when the check fails does the packet need `pocp attest`, which is weaker and labelled as such. By default (`guard.tests: block`), CI fails a test change unless the check passes when `verify --rerun` runs it again, or a maintainer passes `--accept-test-change` (meant for intended behavior changes). `attest` mode accepts the sign-off instead, which the author can give themselves. In block mode the author never signs off: `pocp fix` records that the failed check is handed to CI (a *deferral*, not an approval), so the commit can go ahead and the maintainer's label decides. The check never runs twice for the same code: its new-code baseline reuses the packet's own passing proof, results are cached locally by everything that decides them, and in CI it reuses the job's re-runs and `ci-run` results for the same commit. The gate also shows removed assertions and added `.skip`/`.only`. For a pull request, `verify base..head --rerun` also runs the check once on the whole pull request as one change (old tests from the merge base, new code from the head, merges included), so dropping an assertion in one commit and adding the bug it caught in the next, or doing either inside a merge commit, fails the same way as doing both in one commit. That check's mutant sample uses a seed derived from `guard.seed`, the merge base and the head: different from the one `prove` used locally, the same on every re-run of that verify, and printed with the result. Defaults recognise the common test layouts and harness files of JavaScript/TypeScript, Python, Ruby, Go, Rust, Java/Kotlin, C# and PHP; `pocp init` writes test folders it finds declared elsewhere to `guard.extra_test_globs`; add your own with `guard.extra_runner_globs` / `guard.extra_test_globs` (a Makefile target, a custom script). Files the tests import (assertion helpers, fixtures), followed transitively, count as test setup unless they are the code the required checks guard, and the `#[cfg(test)]` items of a Rust file are its test part (SPEC §6.2 has the limits).

## Obligations

| Kind | Example | Passes when |
|---|---|---|
| `test` | `--test "npm test"` | exit 0 |
| `command` | `--command "npm run lint" --expect "0 problems"` | exit 0 and output matches |
| `probe` | `--probe "curl -fsS localhost:3000/health" --target localhost` | exit 0 |
| `manual` | `--manual "Invoice PDF checked by eye"` | someone runs `pocp attest … --by <who>` |

Modifiers after any obligation: `--timeout <ms>`, `--input <glob>` (files the check reads, checked for consistency), `--cwd <folder>` (run it in a subfolder).

POCP doesn't discover or understand your test framework: a check is any command you declare. `npm test`, `cargo test`, `pytest`, `go test ./...`, `make check` all work the same way. See [docs/QUICKSTART.md](QUICKSTART.md) for a walkthrough on a non-JavaScript repo.

A packet with no obligations never passes.

## How proof is tied to code

- **Subject hash:** SHA-256 of the staged file list (`mode sha path`), `.proof/` excluded. The same value is computed from the commit later, so CI can compare.
- **Obligation digest:** hash of the check's command, `expect`, inputs and timeout.
- **Policy digest:** hash of the requirements that apply to the packet. The gate re-derives requirements from the current rules every time; it never trusts the packet's own list.

**Run modes**

- `clean` (default): refuses to run if tracked files differ from what's staged (including files hidden from `git diff` by `assume-unchanged` or `skip-worktree`), and checks again after the run. A formatter that rewrites files voids the proof. Untracked files outside the packet's `touches` and `inputs`, and git-ignored files, are not checked.
- `snapshot` (`--mode snapshot`): exports the staged files to a read-only temp folder, links `node_modules` (configurable), runs there, and hashes the export before and after. Lets you keep unrelated unstaged work, and works in sparse checkouts. Root ignores the read-only bit; the before/after hash still catches edits.

Proofs are not hermetic. A check can read the network, environment variables and installed packages. Runner details (Node version, platform, lockfile hash) are recorded so results can be interpreted, and `verify --rerun` in CI gives an independent result.

Raw output never goes in the packet file, which gets committed. It's written to `.proof/runs/` (git-ignored); the packet keeps only hashes.

## CI

POCP adds to CI; it doesn't duplicate it.

```bash
pocp verify origin/main..HEAD --require-coverage --rerun     # re-runs every required check itself
```

- **Judged by the base branch's rules.** A pull request can't delete a requirement, raise a threshold, or add its own signing key and pass. Every loosening is named, and fails unless a maintainer approves (`--accept-policy-change`). Stricter rules apply immediately.
- **Re-runs.** `--rerun` runs every check once per pull request, at the head, not once per commit, each in a fresh copy of the commit with no `.git` (so one check can't change another's files, and none can reach the repository's git config). It also runs the checks the rules require for the pull request's net change, and the `verify.require_ci` commands no packet check covered. `--rerun-unsigned` skips proofs signed by someone in `.proof/allowed_signers`.
- **The whole pull request is judged, not just each commit.** Besides each commit, verify judges the net change from where the branch started to its head, merges included, so splitting a test change from the bug across commits, or hiding it in a merge, doesn't change the verdict. The test guard runs per commit that changed tests, and once on the net change; in block mode a net test change fails without `--rerun`/`--rerun-unsigned`, since no proof made on one commit can stand in for a check of the whole pull request.
- **Git state is watched.** While verify runs, its git calls ignore global and system config, `core.fsmonitor`, hooks, external diff and textconv drivers, replace refs and `GIT_DIR`-style environment variables. If the repository's git config, its included files, hooks, `info/attributes`, grafts, `shallow`, alternates, refs or object store change while verify runs, verify fails (new loose objects are accepted only when their content matches their id). Because global config is ignored, a filter such as Git LFS must be configured in the repository itself (`git lfs install --local`) for re-runs to see the real files.
- **Faster, trusting mode: CI results.** `pocp ci-run` wraps your existing test step (same exit code) and records the result against the commit's code and the exact command; with `--ci-results`, verify skips a check that has a passing record. That trusts everything that ran in the job before verify: the tests run as the same user and can write the file, so a new test file can append a passing result for any other check. Filtering by CI run id doesn't help (the tests can read it). A committed results file is refused, the latest record for a command decides, and records from another CI run are ignored. Use it only where you accept that trust; see the threat model.
- **Separate approvals.** Loosening the rules (`--accept-policy-change`), changing existing tests (`--accept-test-change`), a test change whose check didn't finish (`--accept-inconclusive`: a timeout or a kill isn't covered by a test approval) and accepting commits that have no packet (`--accept-uncovered`) are approved independently, e.g. with maintainer-only labels. `--accept-uncovered=<sha>` applies only the exceptions listed in `.proof/exceptions.json` (`{ "pocp": 1, "uncovered": [{ "commit": "<full sha>", "files": ["<exact path>"], "reason": "…", "reviewer": "…" }] }`); accepted gaps are reported as `uncovered_accepted` warnings marked UNPROVEN, and changing the list is a policy change. See docs/THREAT-MODEL.md, "Accepting missing proof".
- **Fast when nothing needs running:** digest, coverage, policy and signature checks are git reads, typically well under a second per commit. The commit hooks cache each old tree's subject hash locally, so they stay fast as history grows (see [`bench/friction/`](../bench/friction/)).
- **Merges:** during a merge the gate judges only files that differ from both sides (conflict resolutions); files taken unchanged from the merged branch carry that branch's proofs. Verify doesn't check merge commits one by one (they carry no trailers), but what a merge adds is part of the pull request's net change: the test guard and `--require-coverage` judge it, and the head re-run runs on the head itself, merge or not. Merging main into a branch doesn't make main's changes the branch's: the net change starts at the merge base.
- **Fails closed:** a `rules.json` or `config.json` that doesn't parse or validate, in the commit or its base, fails verification.
- **Says what each check rests on:** every check is labelled `rerun`, `ci-result`, `signed:<who>`, `local`, or `attested:<who>` (see [the threat model](THREAT-MODEL.md)).
- **Readable:** on GitHub Actions it writes a results table to the job summary and error annotations on failing commits.

A ready-made workflow is in [`examples/github/pocp.yml`](../examples/github/pocp.yml), and there's a composite action in [`action.yml`](../action.yml). The action runs the copy of POCP bundled at the action's own ref, so pinning `uses: harriswekselblatt/pocp@<commit>` pins the verifier.

## Choose what blocks a merge

Every repository decides for itself, in `.proof/config.json` (a policy file, so loosening it needs approval):

```json
{
  "verify": {
    "fail_on": ["missing_packet", "unproven", "failed_proof", "missing_required", "uncovered", "policy_loosened", "ci_config_changed"],
    "require_ci": ["make test"]
  },
  "ci": {
    "branch": "main",
    "required_checks": ["verify", "tests"],
    "require_pull_request": true
  }
}
```

- **`verify.fail_on`**: which findings fail `verify`. Everything else is still reported, as a warning. The default is all of them; a repo adopting POCP gradually can start narrower. `invalid_policy` always fails.
- **`verify.require_ci`**: CI commands that must pass on the exact code being merged, either as a `pocp ci-run` result or as a re-run by `verify` itself. Any CI system can produce those results. With neither, verification fails.
- **`ci.required_checks`**: which CI checks must pass to merge. `pocp ci required` prints the plan; `pocp ci required --apply` adds them to GitHub branch protection, keeping every existing protection and never loosening one (it refuses an empty list). *Status: the request is validated against GitHub's published API schema in tests, but has not yet been run against the live API; treat it as optional.* On other hosts, configure the same checks in their branch or merge-request settings. Dropping a required check, or turning off required pull requests or admin enforcement, is a policy loosening that needs approval.
- **CI definitions are protected.** Changing `.github/workflows/`, `.gitlab-ci.yml`, a `Jenkinsfile` and similar (`ci.files`) needs a packet and, in CI, the same approval as loosening the rules, since an edited workflow could switch POCP off. `ci.files` can protect any other path the same way, such as an evaluation's datasets, graders and results; verify reports those as "protected files changed". Setting `ci.files` replaces the default list, so include the defaults you want to keep (dropping one is reported as a loosening).
- **Loosening includes narrowing.** Dropping a glob from a requirement (keeping its command), replacing the test guard's globs, lowering `area_depth`, or widening the environment checks see are loosenings too; until approved, the base's values stay in force.

Nothing here assumes GitHub Actions or a test matrix. [`examples/`](../examples/) has GitHub, GitLab and plain-shell versions.

**POCP never changes merge settings on its own.** Its job is to report proof status and fail its CI check according to the repository's policy. Changing the host's branch protection happens only when someone runs `pocp ci required --apply` explicitly; no other command, hook or the GitHub Action ever does. The hosting platform stays in charge of whether a red check blocks a merge.

**Verification vs. merge enforcement.** POCP verification works on any plan and any host: `pocp verify` runs in CI and fails its check on a bad change. Whether a failing check *blocks the merge button* is up to the hosting platform. On GitHub, branch protection needs a public repository or a paid plan for private ones. If `--apply` can't set it, POCP says the branch is unchanged and lists the checks to require by hand; verification keeps working either way.

## Signed proofs

```json
{ "sign": { "key": "~/.ssh/id_ed25519", "principal": "you@example.com" } }
```

Proofs are signed with `ssh-keygen` (the same mechanism git uses for SSH commit signing; a `.pub` key signs through ssh-agent). Put trusted keys in `.proof/allowed_signers`. A signed proof says who ran the check and that the record hasn't been edited since; CI can trust it instead of re-running. Agent runs usually aren't signed, so CI re-runs those.

## Coding agents

Anything that can run a command can use POCP. Two useful places:

- **Before editing:** `pocp check-edit <file>` exits 1 if the file needs an open packet first.
- **Before committing:** `pocp fix --intent "<what the change does>"` takes every mechanical step a blocked commit needs (open or widen a packet, add required checks, prove the staged code, stage the packet) and says what is left and who must do it. `pocp gate --json` gives the same reasons as data: each block has `remedies` with what is wrong, why, and the next command.
- **When a person is needed** (a test change the mechanical check could not pass, a policy or CI loosening), `pocp fix` and verify print the one action, e.g. "a maintainer adds the `pocp-approve-tests` label", and say plainly not to squash, force-push or use `--no-verify`. `pocp fix` never signs off for anyone.
- **Giving those approvals:** `pocp approvals` lists every open PR across your repositories whose verify fails only for a maintainer's label, with what each label approves (the reason and the test or CI/policy files, with line counts). `pocp approvals --approve owner/repo#12` shows that diff and adds the label only after you type the PR's number; it refuses to run without a person at a terminal, has no flag that skips the question, and adds nothing if the PR got new commits while you read it. An agent may list what is waiting; it never approves.
- **Adopting:** `pocp doctor` checks hooks, policy, the CI workflow and its approval labels, Actions access to a private POCP action, branch protection against `ci.required_checks`, and that the first adoption PR carries only `.proof/` and CI files. It only reads.

[`examples/claude-code/`](../examples/claude-code/) has a working PreToolUse hook. The same two calls work from any harness. [`examples/agent-instructions.md`](../examples/agent-instructions.md) is a block to paste into your agent's instructions file so it works with POCP instead of around it.

## Misses and the ratchet

```bash
pocp miss record --description "isPositive(0) returns true" --stage production --severity high --file src/math.js
# → linked automatically to the packet that last changed src/math.js (via commit trailers)

# add a rule that guards those files, with "source": "miss:<id>" in .proof/rules.json, then:
pocp miss close m-91c2c0de --fix "use > 0" --replay <escaped-commit>
```

Closing requires a runnable rule with `source: "miss:<id>"` whose glob matches the miss's files. That alone records `closed: rule-added`. With `--replay`, POCP runs the rule on the staged code (it must pass), then rolls back only the miss's files to the escaped commit (it must fail). Only then is the miss `replay-confirmed`.

## Measuring

```bash
pocp history --test "npx vitest run {tests}"   # day one: numbers from your git history
pocp metrics                                    # catch rate, escapes, proven share, friction, cost, ratchet
pocp eval --mutants all --missed                # how many planted bugs your required checks catch
```

- **`history`** needs no setup. It replays your last commits through the gate (how often would it have asked for a packet?) and replays past bug fixes: does the test that came with each fix fail on the old code and pass on the fix?
- **`eval --save`** writes the exact sample and outcomes; **`eval --replay <file>`** re-runs that same sample (or `--missed` for only its survivors) on the current code, so a catch rate can be reproduced and audited.
- **`eval --corpus <file>`** runs mutants made by another tool through the same checks, so POCP's verdicts can be compared with that tool's mutant by mutant. Each entry is `{ id, file, start: { line, column }, end: { line, column }, replacement, original? }`: 1-based lines and columns with an exclusive end, as in StrykerJS's JSON report. If `original` doesn't match the text at that range, the mutant is reported as no longer applying. Each mutant's `outcome` is `caught`, `missed`, `timeout` or `error`. `eval/e3/` uses this to replay StrykerJS mutants.
- **`eval`** plants small bugs (flipped comparisons, swapped operators, changed constants), one at a time, in snapshots of files guarded by requirements, in parallel, running the fastest checks first. It refuses to run if the checks don't pass on the unmodified code, never mutates test files, and `--missed` shows each surviving mutant's line before and after.
- **Timeouts aren't catches.** A mutant is caught only when a check runs to the end and fails. If a check times out, is killed, or can't start (exit 126/127), the remaining checks still run; if none fails normally, the mutant is *not measured* (`outcome` `timeout` or `error`, `caught: null`). The catch rate is caught ÷ (caught + missed), and the not-measured count is shown beside it (`caught 8/9 (89%) · 1 not measured (1 timed out), not scored`) and saved as `not_measured`, `timeouts` and `errors`. `--replay --missed` re-runs the not-measured mutants along with the survivors. Under load a full suite can hit the check timeout whether or not it would catch the mutant, so counting it either way would let the machine's load set the score.

## Host modules

Set `POCP_HOST=./my-host.mjs` to add rules from your own tooling and receive events, without committing anything. Host rules can only make the gate stricter. See [`examples/host.mjs`](../examples/host.mjs).

## Library

```js
import { createPocp } from 'pocp';
const pocp = createPocp({ cwd, policy, events, store, runner });
await pocp.gate();
```

Four interfaces, all optional: **Store** (default: `.proof/`), **Runner** (default: child processes in their own process group; processes that leave the group aren't tracked), **Policy** (extra rules), **Events** (lifecycle notifications).
