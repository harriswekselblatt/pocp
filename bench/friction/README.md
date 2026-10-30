# Friction benchmark

Measures what POCP costs honest work: how often a real commit is blocked, how many commands it
takes to get past the block, how long the hooks, `pocp prove` and CI's `pocp verify` take, and
how often CI needs a person. Results are in [RESULTS.md](RESULTS.md).

```bash
node bench/friction/run.js --target pocp --label after
node bench/friction/run.js --target <name> --repo <path to its checkout> --label after
node bench/friction/run.js --target pocp --pocp <another pocp checkout> --label before   # compare versions
node bench/friction/run.js --report-only            # re-render RESULTS.md from results/*.json
```

Options: `--commits N` (how many recent non-merge commits, default from the target), `--full K`
(how many of the newest go through the whole flow: prove, commit, CI; the older ones stop at the
first commit attempt), `--protocol fix|manual` (default: `fix` when the POCP under test has it),
`--work <dir>`, `--keep`.

## How it works

1. **Policy.** The target's `.proof/rules.json` and `config.json` at `policyRev`, with the
   target's overlays (`guard.tests: block` for both targets, so the test guard is on). The same
   policy judges every replayed commit, as if it had been adopted before them.
2. **Replay.** In a scratch clone (the source checkout is only read), for each commit: check out
   its parent, commit the policy (hooks off), then stage exactly the commit's change, minus
   `.proof/`. The hooks are installed with the POCP under test, wrapped to time each one.
3. **The honest agent** commits with the commit's own message, through the hooks. If they
   block, it follows the documented flow for that version:
   - `manual` (before `pocp fix`): run the suggested `pocp open`, `pocp prove`, sign off on
     anything left (`pocp attest --by bench-agent`, what agents did), commit again.
   - `fix`: `pocp fix --intent "<message>"`, commit again.
   Then `pocp prove` once more on the same code, which must not run anything.
4. **CI**, in a fresh clone of the commit: the test command through `pocp ci-run`, then
   `pocp verify <base>..HEAD --rerun-unsigned --require-coverage --ci-results <file>`, the
   bundled Action's default.

`pocp history` replays only the trigger rules; this replays the test guard too, and runs every
check for real. Times are wall clock on one machine and include Node start-up.

## Adding a repository

Copy `targets/pocp.json`: the commit to replay up to (`head`), where the policy comes
from (`policyRev`), the test command CI runs, folders to link from the source checkout
(`node_modules`), and any policy overlay. `replaceRun` swaps a rule's command (for example to run
a faster suite) without touching the replayed code.
