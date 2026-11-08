# Changelog

## Unreleased (1.1.0)

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

### Fixed

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

- Version `1.1.0-dev.0` on `main`; `init --github` pins the last released Action until 1.1.0 ships.
- `package.json` has repository, bugs and homepage; a tag-triggered release workflow publishes
  with npm provenance.
