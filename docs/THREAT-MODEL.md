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
| Existing tests and test setup | Test guard: changes need a packet; the old tests must pass on the new code and the new tests must catch every sampled mutant the old ones caught; otherwise a sign-off, or approval in block mode (§6.2). In CI the whole pull request is also judged as one change, merges included (§7.2) |
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
plain `verify` without a re-run accepts unsigned proofs (labelled `local`).

**A malicious pull request from a fork.** Obligations are shell commands from the repo, so
`verify --rerun` runs the PR's code. *Your CI's isolation is the boundary:* run POCP where you
would already run that PR's tests, with no secrets and read-only permissions.

## Trust labels

`verify` labels what establishes each check, weakest to strongest:

| Label | Meaning |
|---|---|
| `attested:<who>` | A named person or agent says a manual check was done. A statement, not proof. |
| `local` | Run by POCP on someone's machine, unsigned. Evidence; trust it as much as that machine. |
| `signed:<principal>` | As `local`, plus a signature from a key in `allowed_signers`: who ran it, and the record wasn't edited since. |
| `ci-result` | Run by `pocp ci-run` in this CI job against this exact commit and command. As trustworthy as the CI job. |
| `rerun` | Run again by this `verify`, in a clean checkout of the commit. The independent result. |

The test guard's obligation uses the same ladder with a `mechanical:` prefix
(`mechanical:local`, `mechanical:signed:<principal>`, `mechanical:rerun`): POCP ran the
two-part check (§6.2) rather than someone vouching for the change. `attested:<who>` on it
means the mechanical check did not pass and someone signed off instead.

## Running pull-request code before verify

A CI job that runs the pull request's tests (`pocp ci-run -- npm test`) and then `pocp verify`
in the same job gives the pull request's code a chance to act first: it runs as the same user
and can write the CI results file, or modify the verifier on disk (an `npx` cache, a checkout
of POCP). Ordinary CI has the same property for test results; POCP's extra checks (base-branch
rules, the test guard) are only as independent as the verifier.

For an independent verdict, run verify in a job that executes no pull-request code before it:
a fresh runner, a pinned verifier (the action at a pinned ref, or the base branch's copy), and
`verify --rerun` without `--ci-results`. A passing re-run satisfies `verify.require_ci`. Make
that job the required check. It costs one more run of the checks.

## Self-hosted verifier

POCP's own repository verifies pull requests with the POCP code in the pull request, so a
change to `src/` is judged by the changed code. That keeps the dogfooding honest about
usability but is not an independent check of changes to POCP itself.

## Approvals

`--accept-policy-change` and `--accept-test-change` are flags; CI decides when to pass them,
typically from a label. A label is not tied to a commit: it stays on through later pushes, so
anything pushed after approval is approved too. One policy approval also accepts every
loosening in the change at once, including new signing keys. Remove approval labels on new
pushes, or derive approval from something bound to the head commit.

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
- **Limits of the mechanical test check.** It samples: with the default 10 mutants, a
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
  retried: a baseline run that doesn't finish blocks without a retry, and if the old tests
  time out on the new code but pass on the base, the result reads `behavior-changed`, so
  load can be mistaken for a real change (it still blocks; a re-run with `--force` on a
  quiet machine tells them apart).
- **Processes that leave the check's process group.** POCP kills every process that stays
  in the check's group, including when POCP itself is killed. A check that starts a new
  session (`setsid`), detaches a daemon, or starts a service elsewhere can leave it running.
  That is a cleanup limit, not a way around a proof: the check's own result is still what
  counts. Raising the check's
  `timeout_ms` makes fewer runs unfinished.
- **Harnesses it doesn't know.** The guard knows common JavaScript, Python, Rust and PHP
  test setup, and follows files that setup and the required checks' commands name. A
  `Makefile` target, a build file or a script reached some other way (a `Makefile` calling a
  script, a config that imports a helper) is unguarded until listed in
  `guard.extra_runner_globs`.
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
  maintainer's `--accept-test-change` covers it like any test change.
- **The mutant sample is not secret.** In CI the guard's seed is derived from `guard.seed`, the
  merge base and the head, so it differs from the one `prove` uses and changes with every head,
  but it is a pure function of the range (verify must be reproducible). An author who knows the
  base can compute it for a candidate head and try heads until the sample misses what the
  change weakened, at the cost of a full guard run per try. Part 1 (old tests on the new code)
  doesn't depend on the sample, and is what catches a weakened test followed by the bug it
  pinned down.
- **History before POCP.** Commits are judged by the rules in force at their base; commits
  made before a protection existed may not satisfy it.
