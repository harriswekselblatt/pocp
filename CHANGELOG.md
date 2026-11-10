# Changelog

## Unreleased

### Changed

- **`pocp init --github` creates the approval labels** on GitHub through your `gh` login,
  leaving existing ones alone. Before, `pocp doctor` printed the commands to run by hand.
- **Fewer workflow runs.** The status and label workflows, and verify with the `pocp` status
  live, skip events that can't change the result: labels other than `pocp-approve-*`, and pull
  request edits that don't change the base. Skipped jobs use no Actions minutes. Update with
  `pocp init --github --force`.

## 1.2.0 (2026-11-09)

### Changed

- **`pocp help` shows six everyday commands** (`init`, `doctor`, `fix`, `status`, `verify`,
  `approve`) when run in a terminal; `pocp help advanced` (or `--all`) lists every command.
  When its output isn't a terminal, `pocp help` still prints the full list, so workflows that
  read it to detect verify options keep working. `pocp approve` is the everyday name for
  `pocp approvals`, and `pocp approve owner/repo#12` approves one pull request; `approvals`
  keeps working. Every command keeps working by name.
- **One answer approves everything a pull request is waiting for.** `pocp approvals --approve`
  now shows every listed approval together (each with its diff) and adds all of them after one
  confirmation, in a single label edit. It also finds pull requests waiting for approval when the
  `pocp` status is live, where the verify job passes on a wait.
- **A new install no longer shows a red failure while it waits for an approval.** On a GitHub
  repository, `pocp init --github` turns the `pocp` status on (`POCP_STATUS_LIVE`) through the
  user's `gh` login, and writes `pocp` as the required check. `pocp ci required --apply` then
  requires `pocp` in place of `verify` and turns the status on, in the safe order: the variable
  is never set while `verify` is required. On a free plan's private repository it says that
  nothing blocks a merge. `--no-live` keeps report-only mode.
- **Updating a pull request's branch no longer removes its approvals.** With the `pocp` status
  live, a push that only merges the base branch into an approved head keeps the tests, policy
  and coverage approval labels. The reporter counts them for the new head only when that merge
  changed nothing the pull request changes and no `.proof/` file; the new head is still verified
  again from scratch. Adopters pick this up by updating `pocp-labels.yml` and `pocp.yml`
  (`pocp init --github --force`). See docs/STATUS.md.

### Fixed

- **A bug fix that adds an assertion to the module's own test is no longer held as a test-setup
  change.** A module that a test named after it imports is now treated as the code under test.
- **An assertion helper with its own unit test stays test support,** so changing it still needs
  the guard's check or a maintainer's approval. Upgrading is recommended.

## 1.1.2 (2026-11-09)

### Packaging

- **Install from npm:** `npm install --save-dev proof-of-change` (the command is `pocp`). The
  README and QUICKSTART use it; `pocp init --github` pins v1.1.2. Published by the release
  workflow with npm provenance.

### Added

- **Warnings for unknown policy keys.** POCP ignores keys it doesn't know in
  `.proof/rules.json` and `.proof/config.json`, so a misspelled setting (`"fail_one"` for
  `"fail_on"`) was silently off. `rules check`, `doctor`, the gate and verify now warn about each
  one, with the key it probably meant. Nothing passes or blocks differently. Keys that start with
  `$` are comments and are never reported.

## 1.1.1 (2026-11-09)

### Packaging

- **The npm package is named `proof-of-change`.** npm refuses `pocp` as too close to existing
  package names. The command it installs is still `pocp`. 1.1.0 was released on GitHub only.

## 1.1.0 (2026-11-08)

Security and reliability fixes from an audit on 2026-11-07. Upgrade from 1.0.0: some changes
that verified before are now held for review, on purpose.

### Security

- **Fast mode no longer passes any test edit on its own.** Every change to tests or test setup,
  including added lines and new test files, goes to a person. Text rules couldn't show that an
  edit still tests what it did. Deep mode (`guard.mutants` above 0) is the automatic path.
- **New test files are guarded.** They run with the old tests and can change their outcome; deep
  mode now requires the suite with them to still catch every sampled bug.
- **Repository settings can't hide changes from POCP's diffs** (attributes that mark files as
  binary, submodule ignore settings, diff prefix settings).
- **`verify` refuses shallow clones** and ranges whose sides share no history, instead of
  guessing a base.
- **The `pocp` status needs complete data and a run tied to this pull request and base.** An
  incomplete file list, another open pull request on the same head, a newer unfinished run, or a
  moved head or base keeps it pending.
- **Green comes only from verify's exit status.** In `pocp.yml` the verify step's output now only
  chooses between waiting, inconclusive and failed. Update your `pocp.yml` (`pocp init --github
  --force`): the reporter needs its `pocp-run` and `verified` steps, and keeps a run from an older
  workflow pending.
- **Isolated checks: `verify --isolate`.** On Linux runners with passwordless sudo, every check
  verify runs (re-runs, the test guard's runs, and `--install`'s dependency install) runs as a
  fresh unprivileged user that can't reach the verifier, the job's files and tokens, or verify's
  processes, and everything it starts is killed when it ends. If isolation can't be set up,
  verify fails. The action's new `isolate` input defaults to `true`, and the example workflow
  asks for it; install dependencies with the new `install` input instead of an earlier step.
  Without it, verify says its checks ran with the cooperative runner, which isn't the secure
  profile. docs/THREAT-MODEL.md lists what this does and doesn't cover.
- **Approval labels count only when a writer applied them**, last, after the head's first run.
- **The reporter never leaves or revives a stale green.** A newer run that doesn't say which pull
  request it checked holds the status; a base, label or shared-head change seen right before
  writing writes pending over any older green; retargeting re-runs verify.
- `ci.require_up_to_date` asks for GitHub's "up to date before merging", so the merged code is
  the code that was verified; `pocp ci required --check` reports it when missing.
- `**` globs match paths containing a newline.
- Checks no longer inherit git's repository variables (`GIT_DIR`, `GIT_INDEX_FILE`, …) from hooks.
- Workflows pin actions by commit SHA, set job timeouts, and drop checkout credentials.

- **Branch protection covers the whole plan by default.** `ci.require_up_to_date` (GitHub's
  "require branches to be up to date") is on unless a repository turns it off, and `pocp init`
  writes it. `pocp doctor` now reports every gap `pocp ci required --check` does (admins exempt,
  branches not up to date, pushes without a pull request), not only missing check names. Merge
  queues aren't supported yet, and on a free plan's private repository POCP is advisory; both
  are documented.

### Changed

- **`verify` is faster.** Its re-runs and the test guard run side by side, and repeated git calls
  are gone: POCP's own verify went from about 15 to about 8.5 minutes.
- **A failed check shows why.** `verify` prints the end of a failed check's output in the CI
  log (size-capped; never stored in proof records).

### Added

- **`decideVerify(result)` in the library.** It says what a `verify` or `verifyRange` result
  that isn't verified is waiting for (failed, inconclusive, or the approvals it needs), the
  same decision the CLI reports as `approval` in `--json` and through `--exit-detail`. The CLI
  now uses it too, and the decision reads only typed facts about each finding, never its text
  or the remedy's wording. CLI output is unchanged.

### Fixed

- **A malformed packet is reported, not a crash.** A packet file that is valid JSON but not the
  shape POCP needs (missing obligations or touches, an obligation without an id or kind, an
  `id` that differs from its file name) made `verify` stop with a JavaScript error (exit 3).
  Verify now reports it as a blocking `missing_packet` finding ("… is malformed: …"), and
  `status`, `show` and other local commands give a clear error naming the file and the field
  (exit 2), as they already did for invalid JSON. A packet whose `id` doesn't match its file
  name no longer verifies.
- **The pull request that adopts POCP verifies in CI.** Committing what `pocp init --hooks`
  creates passed the gate, but `verify --require-coverage` (the shipped CI invocation) then
  failed it: the new `.proof/config.json` and `.proof/rules.json` counted as an uncovered policy
  change. Creating the first policy is now adoption in verify too, as it already was in the gate,
  but only when neither the commit's parent nor the policy that judges it has any policy file.
  Removing, corrupting or editing an existing policy, CI file changes, and the rest of an adoption
  commit are checked as before.
- Adding several approval labels at once no longer leaves the `pocp` status stuck on "Waiting
  for verify." Each label starts a run and all but one are cancelled while queued; the reporter
  took the newest of those step-less runs as the latest word. A run cancelled before its verify
  job ran any POCP step now says nothing, like a skipped run. One cancelled after it started
  evaluating still holds an older success at pending.
- Committing the files `pocp init` creates no longer fails as a policy loosening.
- `pocp --version`, `-v`, `-h`, `pocp help <command>`; unknown options are reported instead of
  taking the next argument as their value.
- A check that exits in time is never recorded as timed out, and a leftover background process
  can't hold a run open.
- A check that didn't finish (timeout, signal, can't start) is reported as unfinished, not as
  "fails on this code"; unfinished test-guard results are not cached.
- A missing or failing `ssh-keygen` is reported as unavailable, not as an edited record.
- The store lock can no longer be taken by two processes at once, including while an abandoned
  lock is being broken; each acquisition has its own token.

### Packaging

- `init --github` and the docs pin v1.1.0.
- `package.json` has repository, bugs and homepage; a tag-triggered release workflow publishes
  with npm provenance.
