# Working in a repo that uses POCP

Paste this into your agent's instructions file (for example `CLAUDE.md` or `AGENTS.md`).

---

This repository uses POCP (Proof of Change Protocol). Risky changes need a *packet*: what
the change is for, which files it touches, and the checks that prove it works. POCP runs
the checks itself and ties each result to the exact staged code.

**Before editing**

- Run `pocp check-edit <file>`. If it says a packet is needed, open one first:
  `pocp open --intent "<what and why, one sentence>" --touch <path> [--touch <path>…]`
- Required checks are added automatically from `.proof/rules.json`. Add your own with
  `pocp add <packet> --test "<command>"` when the change needs more than the rules ask for.
- Keep `--touch` to what you will change. If the change grows, `pocp widen <packet> --touch <path>`.

**Before committing**

- Stage the change, then `pocp fix --intent "<what and why, one sentence>"`. It opens or widens
  the packet, adds the checks the rules require, proves the exact staged code, and stages the
  packet. Then `git commit`. Run it again after every change; it never re-runs a check that
  already passed (or failed) on the same code.
- If a check fails, fix the code, not the tests, and run `pocp fix` again.
- Every block says what is wrong, why, and the next command. `pocp gate` shows it without
  committing.
- `pocp attest <packet> <obligation> --by <name>` records a manual sign-off. Only attest what
  was actually reviewed, by the person who reviewed it. Attestations are named and visible in
  the commit. `pocp fix` never attests.

**When a block needs a person**

Some blocks are not yours to clear: a test change the mechanical check could not pass, or a
loosening of `.proof/` rules or CI. `pocp fix` and CI print the one action needed, usually
"a maintainer adds the `pocp-approve-tests` (or `pocp-approve-policy`) label". Push the commit
as it is, say what changed and why, and ask for that (the maintainer sees it in
`pocp approvals`). Never add these labels or run `pocp approvals --approve` yourself. Do not squash, force-push, rewrite
history or commit with `--no-verify` to get past it: none of these clears an approval, and
rewriting proven commits invalidates their proofs. To bring in the base branch, merge it
rather than rebasing: during a merge only the conflict resolutions need proof.

**Never**

- Edit files in `.proof/packets/` or `.proof/runs/` by hand. Proofs are hashed and can be signed;
  edited records fail verification in CI.
- Weaken a check to get it passing: removing assertions, adding `.skip`/`.only`, or changing
  the test script. `pocp prove` checks changes to existing tests mechanically: the old tests
  must pass on the new code, and the new tests must catch the bugs the old ones caught. If
  that check fails, don't attest it yourself: say what changed and why, and leave the
  sign-off to a person.
- Loosen `.proof/rules.json` or add keys to `.proof/allowed_signers`. CI judges every change by
  the base branch's rules and fails any loosening a maintainer hasn't approved.
- Commit with `--no-verify` to skip the gate. CI's `pocp verify --require-coverage` catches it.

**When something escapes**

- Record it: `pocp miss record --description "…" --stage <gate|commit|ci|review|production> --file <path>`.
- Close it by adding a runnable rule to `.proof/rules.json` with `"source": "miss:<id>"`, then
  `pocp miss close <id> --replay <commit where it escaped>` to show the rule catches it.
