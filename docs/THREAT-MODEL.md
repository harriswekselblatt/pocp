# POCP threat model

POCP records which declared checks ran against which code, under which rules, and lets
anyone check that record later. It does **not** prove code correct: a passing check means
the command exited the way the rules required, against the recorded code, in the recorded
environment.

## What POCP protects

| Asset | Protected by |
|---|---|
| "These checks passed on this code" | Subject hash (staged tree), obligation digest, policy digest on every proof (SPEC §5) |
| The set of required checks | Rules re-derived on every gate and verify; requirements matched against the changed files a packet covers (§6, §7) |
| The rules themselves | Policy files need a packet; CI judges each commit by the **base** branch's rules and fails any loosening without approval (§7.2) |
| The trust root for signatures | `allowed_signers` read from the base (or a pinned file), never from the commit under review (§7.2) |
| Existing tests and test setup | Test guard: changes need a packet; the old tests must pass on the new code. Fast mode (`guard.mutants: 0`): every test change, new test files included, goes to a person. Deep mode: the new tests must catch every sampled mutant the old ones caught. Otherwise a sign-off, or approval in block mode (§6.2). In CI the whole pull request is also judged as one change, merges included (§7.2) |
| Lessons from escapes | Misses close only through a runnable rule; replay shows it catches the old code (§8) |

## Who it defends against

**A hurried or careless agent or person** (the common case). Can't commit a risky change
without a packet; can't skip a required check; can't "prove" against unstaged edits; can't
reuse a stale proof after the code, command or rules change. *Fully covered.*

**An agent optimising for a green gate.** Tries to delete or narrow a requirement, open a
catch-all packet, gut an assertion, add `.skip`, change the test script to `echo ok`, replace
the test guard's globs, or attest its own work. *Covered in CI:* base-branch rules (a narrowed
glob or a replaced guard glob is a loosening), requirement matching on covered files, and the
test guard's mechanical check: gutting a test while breaking the code fails the old tests on
the new code; weakening an assertion loses mutants the old tests caught. The check's commands
come from the rules in force, and its budget and seed from the base, so the change can't pick
an easier check or a friendlier sample. `verify base..head` also runs the guard on the pull
request's net change (old tests from the merge base, new code from the head, merges included),
computed by verify itself, so splitting "drop an assertion" and "add the bug it caught" into
separate commits, or making either inside a merge commit, is judged as if it were one commit. *Partly covered:* when the mechanical check fails, a
sign-off stands in. In `block` mode (the default) that isn't enough for CI: only an
independent mechanical pass (`verify --rerun`, or a trusted signature) or a maintainer's
`--accept-test-change` lets it through. In `attest` mode the sign-off is a free-text name, so
an agent can sign off its own test change; `verify` labels it `attested:<who>` and reports what
the check found. The guard follows the test setup: a setup file a runner config names, a
script a required check runs, `.npmrc`, and the test settings in `package.json`,
`pyproject.toml` and `setup.cfg` are guarded like tests. The tamper benchmark
(`bench/tamper`) measures these attacks. Locally the
gate can be bypassed with `--no-verify`; `verify --require-coverage` in CI catches that.

**A contributor who edits records by hand.** Edits a packet file to turn a failed proof
into a pass, pastes a trailer from another commit, plants a forged proof for reuse, or commits
a forged CI results file. *Covered:* `verify` recomputes digests from the commit;
`--rerun` / `--rerun-unsigned` re-runs anything not signed by a trusted key; signed proofs
fail verification if edited; proof reuse never re-signs an unsigned record; a committed CI
results file is refused, and inside a CI run only that run's records count. *Not covered:*
plain `verify` without a re-run accepts unsigned proofs (labelled `local`), and a results file
written in the job (`--ci-results`, the faster mode) can be written by the pull request's own
tests: see below.

**A malicious pull request from a fork.** Obligations are shell commands from the repo, so
`verify --rerun` runs the PR's code. *Covered, on Linux runners with `verify --isolate` (the
default in the example workflow and the action):* each check runs as a separate unprivileged
user that can't reach the verifier, the job's files and tokens or verify's processes; see "The
isolated worker" below for exactly what that covers. *Not covered:* without `--isolate` (local
use, macOS, a runner without passwordless sudo) your CI's isolation is the boundary: run POCP
where you would already run that PR's tests, with no secrets and read-only permissions.

## Trust labels

`verify` labels what establishes each check, weakest to strongest:

| Label | Meaning |
|---|---|
| `attested:<who>` | A named person or agent says a manual check was done. A statement, not proof. |
| `local` | Run by POCP on someone's machine, unsigned. Evidence; trust it as much as that machine. |
| `signed:<principal>` | As `local`, plus a signature from a key in `allowed_signers`: who ran it, and the record wasn't edited since. |
| `ci-result` | Recorded by `pocp ci-run` in this CI job for this exact commit and command. As trustworthy as everything that ran in the job before verify, which includes the pull request's tests. |
| `rerun` | Run again by this `verify`, in a fresh copy of the commit. The most independent result POCP gives; see below for its limits. |

The test guard's obligation uses the same ladder with a `mechanical:` prefix
(`mechanical:local`, `mechanical:signed:<principal>`, `mechanical:rerun`): POCP ran the
two-part check (§6.2) rather than someone vouching for the change. `attested:<who>` on it
means the mechanical check did not pass and someone signed off instead.

## Pull-request code in the verifying job

`verify --rerun` runs the pull request's code: that is what a re-run is. The test guard runs it
too, and so does installing its dependencies. On GitHub-hosted runners the job's user has
passwordless sudo, so code that runs as that user can reach anything on the machine, the
verifier included. `verify --isolate` keeps that code away from the verifier; without it, the
limits under "The cooperative runner" below apply.

What POCP does in every mode:

- The verifier is loaded before any pull-request code runs: the action at a pinned commit, or
  the base branch's copy checked out in its own folder (as POCP's own workflow does).
- Each re-run gets its own fresh copy of the commit's files, with no `.git`, so one check can't
  edit another check's files and nothing in the copy leads back to the repository.
- Every git call verify makes turns off what lets config run commands (`core.fsmonitor`, hooks,
  external diff and textconv drivers), ignores global and system config and replace refs, and
  doesn't inherit `GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE` or config-injecting variables.
- Before each git call, verify compares the repository's config (and the files it includes),
  hooks, `info/attributes`, grafts, `shallow` and alternates with what they were when it
  started, and compares refs at the end. Any change fails the verify, even if the code put
  things back.
- The object store is watched the same way. Git doesn't check an object's content against its
  id when it reads it, so code that rewrites a loose object or a pack could otherwise change
  what verify reads as the base or the head. Verify records every file under `.git/objects`
  (and alternate object directories) by inode, size and change time when it starts; a process
  can't set a file's change time, so a file rewritten, replaced or put back no longer matches.
  The only new files accepted are loose objects whose content hashes to their name. The net
  change's commit is written before any pull-request code runs, and one already stored under
  its id must hold exactly the expected content.
- The example workflows check out with `persist-credentials: false`, so no token is left in
  `.git/config`, and run with read-only permissions and no secrets.
- "Verified" comes only from verify's exit status, never from a step output (see "How the job
  reports the verdict").

### The isolated worker (`verify --isolate`, the hosted secure profile)

verify is the trusted controller: it reads the base's rules, builds every snapshot, starts each
check, and reads back only what the kernel reports (exit status, signal, whether the time limit
hit) and the bytes the check wrote to stdout and stderr. Nothing a check writes to a file is
read as a result. Each check runs like this (`src/isolate.js`):

- **A fresh user per run.** verify creates a Linux user for that one run (`useradd`, a random
  uid never reused within the verify), with no sudo rights, and starts the check as that user
  through `setpriv` with `no_new_privs`, no supplementary groups and no capabilities. Set-id
  programs, sudo among them, give it nothing.
- **Its own copy and its own folders.** The check runs in a private copy of the snapshot, owned
  by its user, with its own `HOME` and `TMPDIR`. verify's own snapshot and every other check's
  copy are out of its reach.
- **No access to the job.** Before any pull-request code runs, verify makes `$HOME` and
  `RUNNER_TEMP` private (mode 0700). A worker therefore can't write the verifier's checkout or
  the action's files, the pull request's checkout or its `.proof` run records, `.git`, or the
  step's file-command files (`GITHUB_OUTPUT`, `GITHUB_ENV`, `GITHUB_PATH`, `GITHUB_STATE`,
  `GITHUB_STEP_SUMMARY`), and can't read them, `~/.git-credentials`, `~/.npmrc`, the runner's
  own files or the scripts of earlier steps.
- **No tokens.** Its environment is an allowlist (`PATH`, locale, `CI`, `GITHUB_ACTIONS`,
  `NODE_ENV`, POCP's own variables and the names in `run.env_allow`), and `ACTIONS_*`,
  `RUNNER_*`, `GITHUB_TOKEN`, the step-file variables, `POCP_SIGN_*` and `SSH_AUTH_SOCK` are
  dropped even if `run.env_allow` lists them. A different user can't read another process's
  environment through `/proc`, so the runner's tokens (`ACTIONS_RUNTIME_TOKEN` and the like)
  stay out of reach.
- **No signals.** A different, unprivileged user can't signal, trace or inspect verify or the
  runner.
- **Nothing survives it.** Every process the check starts runs as its user, so when the check
  ends or times out, verify kills every process of that user (including a child that left the
  process group with `setsid`) and checks none is left before it deletes the user and its
  folders. If pocp itself dies, a watchdog in the worker does the same. RLIMIT_NPROC bounds how
  many processes and threads it can have (4096 by default; `POCP_ISOLATE_NPROC`), and the
  check's time limit (`run.timeout_ms`) bounds how long it runs.
- **Dependencies too.** `verify --install "<command>"` (the action's `install` input) runs the
  install the same way, in a copy of the head. The folders `snapshot.link` names
  (`node_modules` by default) are then moved out, stripped of set-id bits, owned by root and
  made read-only, and every check's snapshot links to them: a check can use them but can't
  change them for the next check. An install that fails fails the verify.
- **No check can plant a program for a later one.** On GitHub's runners `/opt` is writable by
  every user, and the tool cache under it (first on `PATH`, unpacked by the setup actions
  writable by everyone) holds the `node`, `npm` and `python` every check runs. Left that way,
  one run whose own result decides nothing (the install, a mutant run) could plant a `node`
  that always exits 0 and pass every later check. So before any pull-request code runs, verify
  (as root) takes other-write off everything under each `PATH` folder and the tool cache, and
  off the folders above them (sticky ones like `/tmp` aside). verify and the checks then use
  only the `PATH` folders that are, along with every folder above them, owned by root or the
  job's user and not writable by others, and the probe must find nothing in them a worker can
  write. verify finds `git`, `sudo` and `ssh-keygen` there too.
- **It fails closed.** Before running any pull-request code, verify runs a probe as a worker
  that must find it can't write the verifier, the repository, `.proof`, `.git` or `node`, can't
  read or write `$HOME`, `RUNNER_TEMP`, the step files or the Docker socket, can't read the
  environment of or signal any process of the job's user, and can't use sudo. If it can do any
  of that, or a worker can't be created, started or cleaned up at any point, verify fails
  (exit 1: red, never waiting or inconclusive). It never falls back to running checks as the
  job's user.

What the isolated worker doesn't cover:

- **The network.** A check can reach the network, including services on the runner and the
  cloud provider's metadata endpoint. Nothing secret is in its reach on a GitHub-hosted runner
  with the example workflow, but a self-hosted runner on a private network is a different
  matter.
- **The kernel.** Separate users are only as strong as the kernel that separates them; a local
  privilege-escalation exploit would get through. A container or VM per check would add
  namespaces on top. POCP doesn't do that yet.
- **Memory, disk and CPU.** Only time and the number of processes are bounded. A check can
  exhaust the runner; that can make the job fail or time out, never verify.
- **Programs outside `PATH` and the tool cache.** A check can still write shared places such as
  `/tmp` (below). A later check runs a program from there only if its own code chooses to,
  which is the pull request's code at work in that check anyway.
- **Shared scratch places.** `/tmp`, `/var/tmp` and `/dev/shm` are shared by every user. A check
  can leave a file there that a later check of the same pull request reads, if it makes it
  readable to all. verify's own temporary folders there are private, with random names.
- **Process listings.** `/proc` shows every process's command line to every user. verify's own
  holds nothing secret; don't put secrets on command lines in this job.
- **Steps before verify.** A dependency install, `pocp ci-run` or anything else that runs the
  pull request's code in an earlier step runs as the job's user, outside the boundary. Use
  `--install`, and leave `--ci-results` off.
- **Tests inside one check.** New tests can still sabotage the other tests of the same check
  (for example by rewriting their files before they run), as in any test run.
- **What a passing check means.** A check that exits 0 passed. The boundary keeps the pull
  request's code from changing the verdict on its other checks; which checks run, and whether a
  test change needs a person, is decided by the base's rules and the test guard.
- **Other hosts.** It needs Linux with passwordless sudo, `useradd`, `setpriv` and `prlimit`
  (GitHub's Ubuntu runners have all four). On macOS, or a runner without them, `--isolate`
  fails. On a self-hosted runner, the probe checks the paths above; credentials kept elsewhere
  on the machine aren't probed. Toolchains installed under `$HOME` (rustup, pipx) can't be
  used by workers: install them outside it, as the `setup-*` actions do.
- **Live proof.** The attack tests (`test/isolation.test.js`) run on GitHub's Ubuntu runners in
  this repository's test workflow. A full fork-PR exercise against a live `pocp` status is
  still outstanding.

### The cooperative runner (without `--isolate`)

Locally, and wherever `--isolate` isn't used, checks run as the same user as verify. verify
says so in its output (`checks: cooperative: … not the hosted secure profile`), in its JSON
(`"isolation": { "mode": "cooperative", "secure": false }`) and in the job summary. That is
fine on a developer's machine, but it is not a security boundary: with `ptrace` or sudo the
code can tamper with the verifier's process, the `node` binary or anything else on the machine;
a process it starts in a new session can outlive its check and interfere with later re-runs;
and it can write to the step's file-command files. The verdict is then as trustworthy as
running the pull request's tests in CI, plus the checks the pull request can't edit: base-branch
rules, coverage, digests, signatures, the test guard.

**How the job reports the verdict.** Removing `GITHUB_OUTPUT` and the other step-file variables
from a check's environment doesn't hide the files: they sit in the runner's temp directory.
Under isolation a check can't reach them; without it, it can. Either way, the example workflows
and POCP's own never take "verified" from a step output. The verify step exits with verify's
exit code, and a `verified` step runs only when that step succeeded; the `code` output only
chooses between waiting, inconclusive and failed.

**Faster, trusting mode.** Running the tests first with `pocp ci-run` and passing
`--ci-results` to verify skips the re-run of any check with a passing record. The tests run
before verify, as the same user, and can write that file: a new test file (new tests are free)
can append a passing record for any other required check, and the run id verify filters on is
readable by the tests. POCP doesn't try to sign these records: a key held by `ci-run` would be
readable by its child (same user; `/proc`, `ptrace`, sudo), and it would have to be handed to
verify later in the same job, where the code that ran earlier can reach it too. Use this mode
only where you accept that trust; it is not the default anywhere POCP documents.

**The strongest practical setup.** A fresh, ephemeral GitHub-hosted Linux runner; a verifier
pinned and loaded before any pull-request code (the action at a pinned commit, or the base
branch's copy); `verify --rerun --isolate`, with dependencies installed through `--install` and
no `--ci-results`; no secrets, a read-only token, `persist-credentials: false`; and that job
required for merging.

A job that runs no pull-request code at all can't be tampered with, and you might want verify
to be that job, consuming results from a separate job that runs the checks. Today that
doesn't give a stronger verdict: the test guard and `verify.require_ci` need re-runs, so a
verify without them fails on those, and results handed over from a job that ran the pull
request's code are only as trustworthy as that job (the forgery above). Running each required
check in its own job, and accepting each check's result only from that check's job, would limit
a forged result to the check that wrote it, which is no worse than that check's tests choosing
to exit 0. POCP doesn't implement that split yet.

## Self-hosted verifier

POCP's own repository verifies pull requests with the POCP from the base commit, checked out
in a separate folder: a change to `src/` is judged by the verifier it would replace, not by its
own code. The re-runs still run the pull request's code: isolated (above) once the base branch's
verifier supports `--isolate`, and as the job's user before that.

## Approvals

`--accept-policy-change` and `--accept-test-change` are flags; CI decides when to pass them,
typically from a label. A label is not tied to a commit: it stays on through later pushes, so
anything pushed after approval would be approved too. One policy approval also accepts every
loosening in the change at once, including new signing keys.

Bind approvals to the reviewed code. `--accept-test-change=<sha>` and
`--accept-policy-change=<sha>` approve only when the head being verified is that commit. The
GitHub example honours the labels only on label events, passing the head at that moment, and
`examples/github/pocp-labels.yml` removes both labels on every push, so a new approval is a
decision about the new code. (A label added in the seconds between a push and that removal
still applies to the new head; whoever adds it is looking at the pull request as it is then.)
On GitLab, a maintainer runs a pipeline with `POCP_ACCEPT_*` set to the reviewed head's sha;
a project-wide CI/CD variable would approve every merge request.

**Accepting missing proof.** A commit that landed without a packet (hooks not installed,
`--no-verify`) is `uncovered`, and no proof can be added to it without rewriting history.
`.proof/exceptions.json` lets a maintainer list such gaps one by one: a full commit SHA, the
exact files (no globs), a reason and a reviewer. An entry counts only when verify is given
`--accept-uncovered=<sha>` for the head being verified (in this repository, the
`pocp-approve-coverage` label), and only for those files in that commit; in the net change, only
if that commit is in the range and changed the file. Accepted gaps stay in the output as
`uncovered_accepted` warnings that start with "UNPROVEN". An exception accepts that proof is
missing; it never counts as proof. It clears nothing else: a failing re-run, a test change, a
policy or CI change, a trailer mismatch or a forged proof still blocks. Any change to the list
is a policy loosening, so it also needs `--accept-policy-change`: adding an exception takes
two maintainer decisions. A verifier that predates `--accept-uncovered` rejects the flag (from
this version on, any unknown `--accept-*` flag is an error), and this repository's workflow
fails with a message rather than pass the approval to a verifier that can't apply it.

## Verification vs. merge enforcement

POCP decides whether a change is proven; the hosting platform decides whether a failed check
stops a merge. Without branch protection (on GitHub: unavailable for private repositories on
free plans), POCP's check still fails on a bad change, but someone with merge rights can merge
anyway. `pocp ci required --apply` sets enforcement where the platform allows it, and reports
plainly when it can't.

This matters most for the CI definition itself. On GitHub a pull request runs its own version
of the workflow, so a pull request that deletes the POCP step never reports a failure: there
is no failing check to stop the merge, only a missing one. `verify` flags the edited workflow
(`ci_config_changed`), but only if it runs. What stops it is the host requiring the job that
runs `pocp verify` (`ci.required_checks`): a required check that never reports blocks the
merge. `pocp ci required --check` reads the branch's protection and exits 1 if any configured
check isn't required, pull requests aren't required, or admins can merge past the checks.

**A required check doesn't stop a faked one.** A pull request can also *edit* the workflow so
that a job with the required check's name reports success without running `pocp verify`, for
example a `verify` job that only runs `exit 0`. Branch protection matches a required check by
its name and, at most, by the app that reported it, which is GitHub Actions for both, so it
accepts the fake, and `verify`, which would flag the edited workflow, never runs.

Since v1.0.0 the required check can instead be the `pocp` status, set by a separate, trusted
workflow (`pocp-status.yml`, [docs/STATUS.md](STATUS.md)). That workflow runs from the default
branch, never runs pull request code, and doesn't trust a run whose workflow files the pull
request changed: such a pull request stays yellow until a maintainer adds
`pocp-approve-workflow` (by default someone other than its author). A pull request from a fork
gets a read-only token and can't post a status at all.

By default the reporter and every workflow in the repository post as the same app, GitHub
Actions, so a branch pushed to **this** repository by someone with write access (including an
agent using a maintainer's token) can edit its workflow to post its own `pocp: success`. Give
the reporter its own GitHub App, keep the app's key in an environment limited to the default
branch, and pin the required check to that app ([docs/STATUS.md](STATUS.md), "Give the reporter
its own identity"). A branch then can't read the key, and a status it posts as GitHub Actions
doesn't count. Without the app, read the diff of any same-repository pull request that touches
`.github/` (or the files your workflow runs before `verify`) before merging; a `CODEOWNERS`
entry for `.github/` with "Require review from Code Owners" makes that a rule, when someone
other than the author can review.

Neither stops a repository **admin**. An admin can loosen the environment, the branch
protection or the app, so an agent holding an admin token can undo the setup. Agents should
use a token without the *Administration* permission.

## Out of scope

- **Hermetic builds.** A check can read the network, environment variables, caches and
  installed dependencies. POCP records the runner (Node version, platform, lockfile hash)
  so results can be interpreted; it doesn't sandbox them.
- **Weak tests.** A brand-new test that asserts nothing passes. Mutation evaluation
  (`pocp eval`) is how weak checks show up; replay shows whether a miss's rule bites.
- **Compromised CI or stolen keys.** A CI job that lies, or a stolen allowed key, can produce
  records that verify. Protect them as you would release credentials.
- **Heuristic signals.** The test guard's "assertions removed / skips added" counts are
  hints for the reviewer, not a parser of every test framework.
- **Limits of fast mode** (`guard.mutants: 0`). No test edit passes on its own: every
  guarded change, new test files and lines added to existing tests included, goes to a
  person. (Earlier versions passed edits that only added lines matching none of a list of
  risky patterns; added lines can disable existing assertions in ways no text rule sees, so
  that path was removed.) The risky-pattern matches are now only hints for the reviewer. Fast
  mode is therefore as strong as the review it asks for, and trades the planted-bug check for
  more reviews.
- **Limits of `changed_test_command`** (docs/REFERENCE.md). When a rule sets it, fast mode
  runs only the old versions of the edited test files (and, when they fail, the same files on
  the base, which can only send the change to a person). A test that passes alone but fails
  when the whole suite runs (order or shared state) passes the shortcut. The command is
  trusted as the rule's author wrote it: one that ignores the files it's given makes the
  old-tests check meaningless, which is why it's part of the rule, judged by the base
  branch's rules and approved like any rule change. Node's runner reports a file that ran no
  test as one passing test; the shortcut doesn't count those.
- **Limits of the mechanical test check (deep mode).** It samples: with the default 10 mutants, a
  weakening that only matters on lines outside the sample can pass. Raise `guard.mutants`
  for more confidence. It needs the old tests to catch something in the sample, or it can't
  measure a drop (it then asks for a sign-off). A change can still alter the code until a
  sample happens to pass; the seed is fixed by policy (in CI, derived from it and the range),
  but the sites move with the code, so this is a matter of budget. Mutants are the simple operators of §11.2, so a test that only
  guards behavior those operators can't break is not measured. Test changes that need other
  files changed in step (a shared fixture, a helper outside the test globs) can make the old
  tests fail for reasons other than behavior; the result is then `behavior-changed` and needs
  a person. When the checks already fail at the base, the result is `baseline-red`: the guard
  can't judge the change, and a person must. The base is checked per required check, so a
  check that was already red hides any behavior change it would otherwise have caught.
  Only a check that runs to the end and fails catches a mutant; a timeout, a kill, a spawn
  error or exit 126/127 is retried once (3× the time limit for a timeout) and, if it still
  doesn't finish, leaves the mutant not measured. Any not-measured mutant, on either side,
  makes the result `inconclusive` (a person decides), never a pass. So a mutant the old tests
  hang on for real (an infinite loop) can't be used to slip a weakened test through, but a
  slow or overloaded machine, or a suite near its timeout, costs friction: more inconclusive
  results that need a person or a re-run with `--force`. The retry limit isn't capped (POCP
  has no timeout ceiling), so on a suite with a 10-minute limit a hung mutant costs up to 40
  minutes of check time. A test runner that dies by a signal on a mutant (a native crash)
  counts as not measured, not caught, so it too is inconclusive. Only mutant runs are
  retried: a baseline run that doesn't finish blocks without a retry. If the old tests
  don't finish on the new code (a timeout, a signal, a spawn error) but pass on the base,
  the result is `inconclusive`, not `behavior-changed`: a run that didn't finish says
  nothing about behavior. It still blocks; a re-run with `--force` on a quiet machine, or a
  person, decides.
- **Processes that leave the check's process group.** POCP kills every process that stays
  in the check's group, including when POCP itself is killed. A check that starts a new
  session (`setsid`), detaches a daemon, or starts a service elsewhere can leave it running.
  That is a cleanup limit, not a way around a proof: the check's own result is still what
  counts. Raising the check's
  `timeout_ms` makes fewer runs unfinished.
- **Harnesses it doesn't know.** The guard knows the common test layouts and harness files
  of JavaScript/TypeScript, Python, Ruby, Go, Rust, Java/Kotlin, C# and PHP, follows files
  that setup and the required checks' commands name or run, and follows what the tests
  import. A `Makefile` target, a build file or a script reached some other way (a `Makefile`
  calling a script, a config that imports a helper) is unguarded until listed in
  `guard.extra_runner_globs`; a test layout outside the defaults that `pocp init` didn't find
  is unguarded until listed in `guard.extra_test_globs`.
- **Test helpers it can't see.** Helpers are found by reading imports, not by running
  anything, and within limits (6 imports deep, 5,000 files per revision). A helper reached
  through a build-tool alias (tsconfig `paths`, a webpack alias), a C# namespace, a Rust
  `use`, dynamic loading, or past those limits is not guarded. Neither is a helper inside the
  globs a required check guards that doesn't look like test support (no `testing/`,
  `test-utils/`, `testkit`, `mocks/` path, no test-framework or assertion-library import) and
  isn't used as it (a test imports it next to other guarded code, no test is named after it,
  it imports no guarded code), or one the code under check itself imports: that is treated as
  code. Keep assertion helpers outside the guarded source or under a test folder. The other
  way round, a module under test that only tests import, next to other code, under a name no
  test has, is read as test support: changing it runs the mechanical check (its mutants are
  still planted there), which costs time and can need a person when the old tests catch none.
- **Rust inline tests.** Only top-level `#[cfg(test)]` items count as test code. One nested
  inside another module, and `#[test]` functions outside a `#[cfg(test)]` item, are treated
  as source. Adding inline tests changes the file's test part, so it runs the mechanical
  check (which passes when nothing was weakened) where adding a test file is free.
- **Merge commits.** `verify base..head` doesn't verify merge commits as commits (they carry
  no trailers). What a merge adds beyond its parents is part of the range's net change (§7.2):
  the test guard judges test changes made in it against the merge base's tests, with
  `--require-coverage` every file it changes must be covered by some packet in the range, and
  the head re-run runs on the head itself, merge or not, including the checks the rules require
  for the net change. When the head is a merge, the final policy and CI files are checked too.
  Not covered: a merge's code change in a file some packet in the range covers needs no proof
  of its own; it is checked only by the head re-run (and the net test guard if tests changed).
  A merge can't weaken a test unnoticed, but it can add code no test exercises, as any covered
  commit can. Without `--rerun`, nothing runs on the merge's code; in block mode a net test
  change then fails (`test_change`), so the guard part fails closed, but a code-only merge is
  judged by coverage alone.
- **The net change starts at the merge base.** Changes the branch took from main by merging
  it are main's and aren't judged again. A range without a base (`verify <rev>`) has no net
  change. The net test guard needs `--rerun` (in block mode it fails without one), and a
  maintainer's `--accept-test-change` covers it like any test change, unless its check didn't
  finish (`test_inconclusive`), which only a re-run or `--accept-inconclusive` clears.
- **The mutant sample is not secret.** In CI the guard's seed is derived from `guard.seed`, the
  merge base and the head, so it differs from the one `prove` uses and changes with every head,
  but it is a pure function of the range (verify must be reproducible). An author who knows the
  base can compute it for a candidate head and try heads until the sample misses what the
  change weakened, at the cost of a full guard run per try. Part 1 (old tests on the new code)
  doesn't depend on the sample, and is what catches a weakened test followed by the bug it
  pinned down.
- **History before POCP.** Commits are judged by the rules in force at their base; commits
  made before a protection existed may not satisfy it.
