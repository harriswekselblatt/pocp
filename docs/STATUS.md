# The `pocp` status

POCP reports its result on a pull request as one commit status, **`pocp`**, on the pull request's head:

| `pocp` | Means | What clears it |
|---|---|---|
| ✅ success | verified: the required checks passed on this exact code | nothing; it's done |
| 🟡 pending: waiting for a maintainer | only an approval is missing (a test change, a policy loosening, commits without proof) | a maintainer reviews and adds the label the verify run names |
| 🟡 pending: inconclusive | a check didn't finish: it timed out, was killed or didn't start | re-run the job; or fix the hang or the time limit; or, for a test change, a maintainer adds `pocp-approve-inconclusive` |
| 🟡 pending: CI workflow changed | the pull request changes a CI file, so its own run can't be trusted | a maintainer reviews the workflow change and adds `pocp-approve-workflow` |
| 🟡 pending: waiting for verify | no finished run for this pull request, its base and its head yet, or a newer run or re-run is still going | wait; after the base branch moves, re-run |
| 🟡 pending: data incomplete | GitHub's answers about the pull request were incomplete or didn't add up (for example, more files than GitHub lists, or an API error) | re-run the reporter; split a very large pull request |
| 🟡 pending: shared head | another open pull request has the same head commit | close all but one |
| ❌ failure | a required check failed, behavior changed without approval, proof is missing, or anything unexpected | fix the code in a new commit |

A pending status blocks merging just like a failure, once `pocp` is a required check. Only success allows a merge.

## Approvals

Each label covers one thing, only on the head it was added to. Every push removes all of them (`pocp-labels.yml`).

| Label | Covers |
|---|---|
| `pocp-approve-tests` | a change to existing tests or test setup whose check ran to the end |
| `pocp-approve-policy` | loosening `.proof/` rules, signers or CI files |
| `pocp-approve-coverage` | commits listed in `.proof/exceptions.json` that have no proof |
| `pocp-approve-inconclusive` | a test change whose check **didn't finish**. A test approval doesn't cover this: the person approving the test change hasn't seen whether the code hangs. |
| `pocp-approve-workflow` | a change to a CI file, which makes the pull request's own run untrustworthy. It counts only if added after the head's first run by someone with write access who **isn't the pull request's author** (see below). It approves the workflow change only: the run is then judged like any other, so anything else it waits for still needs its own approval. |

A plain re-run that didn't finish is never cleared by a label, only by a re-run that finishes, or a fix.

### Who can approve a workflow change

By default (`"ci": { "workflow_approver": "independent" }`), `pocp-approve-workflow` must come from a writer other than the pull request's author. On a team, that means a second person reviews any change to CI.

A solo maintainer can set `"workflow_approver": "any-writer"` in the base branch's `.proof/config.json`. That's a policy loosening, so it needs `pocp-approve-policy`. Be clear about what it means: **GitHub sees an agent using your token as you.** So with `any-writer`, the author can approve their own workflow change, and so can a coding agent working with the author's token. Its own CI change then turns green on the label it added itself. Choose it only when no second person exists to review CI changes. `independent` stays the default for every other project.

POCP's own repository uses `any-writer`, because it has one maintainer.

The same holds for every approval label. A label shows that an account with write access added it; it can't show that a different person was involved. For approvals from someone other than the author on every change, also require pull request reviews from code owners in branch protection.

## How it's decided

Two workflows:

- **`pocp.yml`** runs `verify` on the pull request, as before. Its first step, `pocp-run pr-<number> base-<base sha>`, names the pull request and base the run evaluated. It records verify's result in which step runs: exactly one of `verified`, `waiting`, `inconclusive` or `failed`, plus an `approval-*` step for each approval passed to verify. `verified` runs only when the verify step itself exited 0, which GitHub takes from the process's exit status. The step's `code` output, which picks between `waiting`, `inconclusive` and `failed`, is weaker: the checks verify runs are the pull request's code, running as the same user on the same machine, and could write to the file GitHub reads outputs from. So the most a forged output can do is turn a failure into a wait (yellow) or the reverse; it can't make a run green. That still isn't full independence (see docs/THREAT-MODEL.md, "Pull-request code in the verifying job").
- **`pocp-status.yml`** is the trusted reporter. It runs from the default branch, on `workflow_run` and `pull_request_target`, and never checks out or runs anything from a pull request. On every event it recomputes from GitHub's API:
  1. Which open pull request has this head, and whether it's still the head. If not, nothing is written.
  2. **Whether the data is complete.** Every list it reads (open pull requests, the pull request's files, runs, jobs) must be read to the end, and the file list must match the pull request's changed-file count and stay under GitHub's 3000-file limit. Anything cut short, missing or inconsistent, or an API error or rate limit, is pending, whatever labels are on.
  3. **Whether the head is shared.** A commit status belongs to the commit, so every pull request with that head shows it. If more than one open pull request has this head, the status stays pending.
  4. **Whether the run can be trusted.** On GitHub, a pull request runs its own copy of `pocp.yml`, so a pull request that edits a CI file could make its run report anything. If the diff touches any CI file (`ci.files` in the base's `.proof/config.json`, with the defaults always included), the run's steps are ignored and the status stays pending until `pocp-approve-workflow`.
  5. Only runs of the trusted workflow (by id and path), for this repository's `pull_request` event on this head, whose `pocp-run` step names this pull request and its current base. A run or re-run attempt still queued or running means pending. Otherwise the newest finished one decides (skipped runs aside), so the order things finish in doesn't matter; if that one was cancelled, it's pending.
  6. If that run relied on an approval, the label must still be on the pull request now, and it must have been applied last by someone with write access, after this head's first run (GitHub lets roles without write access manage labels). The same holds for `pocp-approve-workflow`, which also has to come from someone other than the author.
  7. The run must have every step this reporter reads (`verified`, `waiting`, `inconclusive`, `failed`). A run from an older `pocp.yml` stays pending with "update pocp.yml", never green. A newer run that doesn't name a pull request and base (it stopped before its first step, or comes from an older workflow) holds the status at pending: an older green is never revived past it.
  8. Right before writing, it reads the pull request again. If the head moved, it writes nothing for the old head. If the base, the labels, or the set of open pull requests on that head changed, it writes pending instead, so an older green can't stand on evidence that is no longer current; the event that changed it runs the reporter again. Retargeting a pull request (`edited`) re-runs verify and the reporter.

If your `pocp.yml` was written before the `pocp-run` step existed, add it (`pocp init --github --force` rewrites the example): without it no run counts, and the status stays pending.

The status text is generic. What the run asks for is in the run's summary, which the status links to.

## A limit of the `pocp` status

GitHub matches a required check by its name and the app that set it. The reporter and every workflow in the repository post as the same app, GitHub Actions. A pull request from a **fork** gets a read-only token and can't post a status. But a branch pushed to **this** repository by someone with write access (including an agent using a maintainer's token) can edit its workflow to give itself `statuses: write` and post its own `pocp: success`. The reporter's own status may then be overwritten.

That's no worse than requiring `verify`, which such a branch can fake just as easily (docs/THREAT-MODEL.md, "Verification vs. merge enforcement"). Until the reporter has its own GitHub App identity, with the required check pinned to that app, read the diff of any same-repository pull request that touches CI files before merging.

## Turning it on

The reporter starts in **report-only** mode: it sets `pocp`, but `verify` stays the required check and still fails on a wait, as before.

When every live case in the validation checklist has passed (including a fork pull request, a pull request that edits the workflow, races, and branch protection blocking every non-green case), an admin, in the same sitting:

1. sets the repository variable `POCP_STATUS_LIVE` to `true`. Waits then pass the `verify` job (no red, no failure email), and label events other than `pocp-approve-*` are ignored;
2. changes branch protection to require `pocp` instead of `verify`.

**Do them together.** With the variable on and `verify` still required, a waiting pull request would show a passing `verify`. And with label filtering on, an ignored label event makes a skipped `verify` check, which GitHub counts as passing.
