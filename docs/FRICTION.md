# Friction: design

POCP is only worth adopting if honest work barely notices it. On two repositories it was
disruptive: merges were blocked, agents stopped to ask whether to squash or force-push, and
commits got much slower. This is the design for making it fast and non-disruptive without
weakening anything the tamper benchmark (`bench/tamper/`) measures. (It was written up after
a first build and revised with it; the measurements below decided what changed.)

The one rule that doesn't bend: POCP can do routine steps for an agent, but an agent never
approves its own test change or policy loosening.

## 1. What is measured (`bench/friction/`)

Replay each target's last 16 real, non-merge commits under its adopted policy with the test
guard on (`guard.tests: block`). `pocp history` can't do this: it replays only the trigger
rules, not the test guard, and runs nothing. Per commit:

| Measure | How |
|---|---|
| Blocked at commit | first `git commit` through the hooks fails |
| Commands to get past a block | pocp commands the documented flow needs (before: `open`, `prove`, `attest`; after: `fix`) |
| Stuck | still blocked after that flow |
| Explained | the block carries what / why / next |
| Hook time | pre-commit, prepare-commit-msg, post-commit, each timed inside the hook |
| Prove time, and prove again on the same code | must run nothing the second time |
| Verify time in CI | fresh clone, `ci-run` then `verify --rerun-unsigned --require-coverage` |
| CI needs a person | verify fails only for an approval (test change, policy loosening) |

Target: POCP itself (its own rules: three test requirements, about 60s per suite run). "Before" is POCP as
adopted (main) and PR #8; "after" is this branch. Results: `bench/friction/RESULTS.md`.

## 2. Speed targets

- **Hooks well under a second** on ordinary commits, and flat as history grows. Measured:
  the gate ran about 40 git commands on POCP, 14 of them listing old commits' trees again to
  decide which packets had landed. A tree's subject hash never changes, so it is cached by
  tree in `.proof/runs/` (local, never committed), and HEAD is resolved once per listing.
- **Expensive work only when tests or test setup change**, which the guard already ensured.
- **Never twice for the same code:**
  - prove runs plain checks before the guard; the guard's "new tests on the new code"
    baseline reuses that passing proof instead of running the suite again;
  - guard results are cached in `.proof/runs/guard-cache/` by everything that decides them
    (subject, base, guarded changes, checks, source globs, budget, seed), so a new or widened
    packet over the same change reuses it; `--force` reruns;
  - with signing on, only runs from this prove or validly signed proofs are reused, so an
    edited file never becomes a signed result;
  - in CI, verify never reads local caches. Within one verify, a check that passed on a
    commit (a re-run, the guard's baseline, or a `ci-run` result for the same subject and
    command) isn't run again.
  - A local prove followed by CI's re-run is expected: that independence is the point.

## 3. Block messages

Every block, at the gate, in `pocp fix`, and in `verify`, says three things:

```
what: 1 staged file(s) are not covered by any packet: src/math.js
  why: a rule requires checks for them. A packet records what the change is and the checks that prove it.
  next: pocp fix --intent "<what this change does>"
```

As data (`--json`), the gate carries `remedies: [{ code, what, why, next, by }]`, where `by`
is `pocp fix` (mechanical), `agent` (change code or files), or `person` (an approval).
A passing gate carries `pending_approvals`: what CI will still need a person for.

## 4. `pocp fix`: the routine steps it takes

Loop until the gate passes or nothing more is mechanical:

1. Files no packet covers: widen the author's own active packet that already covers part of
   the staged change, otherwise open one (`--intent`, or a placeholder it asks you to replace).
   Required checks come from the rules. If no rule names a check: `--test`, else the repo's
   `verify.require_ci`, else its most-required test command, else it asks.
2. Rules changed since the packet opened: sync required checks.
3. Prove. If the working folder differs from what is staged, prove a snapshot of exactly the
   staged code. A check that already failed on this exact code is not run again.
4. Stage packet files.
5. Block mode only: a test change the mechanical check could not pass is handed to CI as a
   recorded deferral, never an attestation (section 5).

It never attests anything, never edits tests, never touches git history.

## 5. What goes to a person, and how

| Situation | Who | The one action |
|---|---|---|
| Test change the check could not pass, `block` mode | maintainer, in CI | add the `pocp-approve-tests` label |
| Same, `attest` mode | a person who reviewed it | `pocp attest <packet> <obligation> --by <name>` |
| Policy or CI loosened | maintainer, in CI | add the `pocp-approve-policy` label |
| Manual obligation | whoever did the check | `pocp attest … --by <name>` |
| A pushed commit made without its proof, or rebased after proving | maintainer | decide how to repair the branch |

Every such message ends with: do not squash, force-push, rewrite history or commit with
`--no-verify` to get past this; push the commit as it is and ask for the approval.

In block mode a sign-off from the author settles nothing in CI, so asking for one was pure
ceremony and taught agents to approve their own test changes. `pocp fix` records a
**deferral** instead (`packet.deferrals[]`, bound to the subject, `to: "ci-approval"`). With
it, the gate lets the commit through and lists the pending approval, and verify's block-mode
check alone decides: an independent re-run pass or the label. Without a deferral, behavior
is as before. Deferrals are ignored outside block mode.

Merges: while a merge is in progress the gate judges only files that differ from both sides
(conflict resolutions). Files taken unchanged from the merged branch carry its proofs; in CI,
what a merge adds is judged as part of the pull request's net change. To update a branch, merge
rather than rebase: rebasing invalidates proofs.

## 6. `pocp doctor`

Read-only checks for adoption, each with what / why / fix:

- POCP set up, rules and config valid;
- hooks installed, executable, and able to find `pocp` (and a note that hooks are shared by
  every worktree);
- `guard.tests` mode (warns on `attest`);
- requirements that call `pocp` itself (CI can't run them unless it installs pocp);
- a workflow runs verify and wires both approval labels;
- the first adoption PR carries only `.proof/` and CI files (until it merges, CI judges with
  the base's rules, so anything else gets two verdicts), and needs `pocp-approve-policy`;
- `ci.required_checks` includes the verify job;
- on GitHub, via `gh`: a private POCP action shares its Actions (`access_level`), both labels
  exist, branch protection requires `ci.required_checks` (a free private repo has none, so
  verify is advisory). `--offline` skips these.

## 7. Security doesn't move

- The tamper benchmark must still block 32 of 32 cheats on POCP.
- verify never reads `.proof/runs` caches; deferrals are not approvals; fix never attests.
- Reuse with signing on requires a valid signature.
