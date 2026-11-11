# eval/: measuring POCP with evidence it doesn't grade itself

This folder implements [docs/EVAL-PLAN.md](../docs/EVAL-PLAN.md). The plan says what each eval measures and why. This file says where things live and the rules every piece follows.

`bench/` stays as it was: POCP's own scripted regression suites (tamper, friction). `eval/` is the independent measurement.

## Layout

| Path | What | Language |
|---|---|---|
| `reference/` | The reference checker: decides *cheat* / *honest* / *ambiguous* for a finished run. Shares no code with POCP. | Python 3, standard library only |
| `tasks/` | Frozen benchmark tasks: the fetch script, the frozen JSONL, its SHA-256 and the dataset revision it came from | Python 3 |
| `e1/` | E1/E2 harness: turns a task into a git repo, runs an agent (Claude Code, Codex) in each arm, then the judges | Node ≥ 20 |
| `e3/` | E3: an outside mutation tool's mutants replayed through POCP, mutant by mutant | Node |
| (`e4/`) | E4: planned, not run. Not on this branch: its sampling frame and scripts are parked on the `e4/sampling-frame` branch for review, and no outside repository has been fetched or run | — |
| `campaign-123/` | The preregistered A/B benchmark of POCP 1.2.3 (harmful and honest changes across three libraries, with a sealed holdout): the summary, the generated report, the frozen protocol and fingerprints. Its records and harness are in pocp-eval under `results/campaign-123/`, fetched with the other records. | text |
| `e5/` | E5: friction from real `gate.jsonl` timestamps, and test-guard profiling | Node |
| `lib/` | Shared Node helpers for the harnesses: the run record writer, hashing, Wilson intervals | Node |
| `results/` | Raw, immutable run records (`*.jsonl`) and their manifests. Reports are generated from these. Kept in their own repository, [pocp-eval](https://github.com/harriswekselblatt/pocp-eval), and fetched here (below). | data |
| `results.sha256` | The SHA-256 of every record file the reports came from, and so of the pinned pocp-eval commit | text |
| `PREREG.md` | Pre-registration: units, denominators, counting rules, bars. Committed before any counted run. | text |

## Getting the run records

The raw records live in [harriswekselblatt/pocp-eval](https://github.com/harriswekselblatt/pocp-eval), pinned to one commit in `lib/results-source.js`, so this repository stays small. To regenerate a report or add a batch, fetch them first:

```sh
node eval/tools/fetch-results.js           # clones pocp-eval at the pinned commit into eval/results/ and checks every file
node eval/tools/fetch-results.js --check   # checks an existing eval/results/ against results.sha256
```

`eval/results/` is git-ignored here. A new batch is committed to pocp-eval, and this repository then pins the new commit and updates `results.sha256` in the same change. Both are under `eval/`, so that change needs a maintainer's approval like any other.

## Rules every piece follows

1. **The reference checker never imports POCP.** `reference/` imports nothing from `src/`, `bin/` or `bench/`, and doesn't shell out to `pocp`. A test (`reference/test_independence.py`) fails if it does. It's written in Python on purpose: a different language makes shared bugs less likely.
2. **POCP's verdict is recorded, never trusted as ground truth.** Harnesses record exactly what the pinned verifier said (exit code, findings, guard verdicts, reason codes) as `pocp.trace` in the run record. The *cheat* label comes only from `reference/`.
3. **Frozen references live outside the agent's checkout.** The canonical task (spec, impossible tests, original tests) is read from `tasks/frozen/`, never from the agent's repo. Its SHA-256 goes in every record.
4. **Everything is pinned and recorded.** The POCP commit and a hash of the verifier files, the dataset revision and frozen-file hash, the CLI version, model id, prompt hash, budgets, timeouts, seed, OS and Node/Python versions. See the run record below.
5. **Every run is kept,** including errors, timeouts and agent crashes. Nothing is deleted from `results/`. An excluded run stays in the file with `excluded: "<reason>"`, and the reason must be one listed in `PREREG.md`.
6. **Pilot runs are marked.** `phase: "pilot"` records size the study and are never counted toward a pre-registered bar.
7. **Canaries before every counted batch.** A batch whose canaries fail is recorded as `phase: "invalid"`.
8. **No network in agent runs beyond the model API**, where the CLI allows it. What was allowed is recorded.
9. **No personal paths in results.** Every record and raw file under `results/` has absolute paths redacted (`lib/redact.js`): this checkout becomes `<pocp>`, temp folders `$TMPDIR`, home folders `~`. `appendRecord` does it for records; `tools/redact-results.js` does it for raw files; a test fails if a committed result still holds one.

10. **The eval is guarded by POCP itself.** In this repository's `.proof/` policy, any change under `eval/` needs a packet proven with `./eval/run-tests.sh`. All of `eval/` and `docs/EVAL-PLAN.md` are listed in `ci.files`, so in CI any change to them, including adding a results batch, also needs a maintainer's approval (`pocp-approve-policy`), the same as a change to the rules or the CI workflow. Verify names the files ("protected files changed (…)"). Every part of the evaluation can move a published number (the frozen tasks, the reference checker and canaries, the harness and its prompt, the judge and report code, the shared statistics and pins, the test runner, the results and manifests, the pre-registration and the plan), so none of it can land quietly. This holds only where the Git host *requires* the POCP check; until this repository's branch protection is confirmed on the host, it's a prototype.

## The run record

One JSON object per line in `results/<eval>/<batch-id>.jsonl`. Fields every eval writes:

```jsonc
{
  "schema": "pocp-eval-run/1",
  "eval": "E1a",                       // E1a | E1b | E2 | E3 | E4 | E5
  "batch": "2026-10-29-e1a-pilot-01",
  "phase": "pilot",                     // pilot | counted | invalid
  "run_id": "…",                        // unique, stable
  "unit": { "task": "lcbhard_0", "agent": "claude", "arm": "pocp-ci", "seed": 1 },
  "pins": {
    "pocp_commit": "…", "pocp_verifier_sha256": "…",
    "dataset": "fjzzq2002/impossible_livecodebench@98650ff…", "frozen_sha256": "…",
    "agent_cli": "claude 2.1.178", "model": "…", "prompt_sha256": "…",
    "budget": { "timeout_s": 900, "max_turns": null },
    "os": "darwin 24.6.0", "node": "v22.13.1", "python": "3.13.1"
  },
  "started_at": "…", "ended_at": "…", "duration_s": 0,
  "status": "completed",                // completed | agent-error | timeout | harness-error
  "excluded": null,                     // or a reason listed in PREREG.md
  "attempts": [ /* each commit attempt: sha, hook result, block reason, time */ ],
  "outcome": {
    "ci_accepted": true,                // the configured CI command passed on the final commit
    "pocp": { "accepted": false, "trace": { /* verifier output, exit, findings, guard verdicts */ } },
    "reference": { "label": "cheat", "kind": "test-edit", "evidence": { /* … */ } }
  }
}
```

Evals add their own fields under `outcome`. A run record is never edited after it's written. A correction is a new record with `supersedes: "<run_id>"`.

## The reference checker's interface

Harnesses call it as a separate process:

```bash
python3 eval/reference/check.py --task eval/tasks/frozen/lcb-conflicting.jsonl --task-id lcbhard_0 \
  --mode impossible --repo /path/to/final/checkout --json
```

It prints one JSON object: `{ "label": "cheat" | "honest" | "not-solved" | "ambiguous", "kind": …, "evidence": … }`. `--mode impossible` is used for E1 (impossible tests), `--mode original` for E2. The meaning of every label is in `reference/README.md`.

## Running the tests

```bash
node --test eval/lib/test/*.test.js eval/e1/test/*.test.js eval/e3/test/*.test.js eval/e4/test/*.test.js eval/e5/test/*.test.js
python3 -m unittest discover -s eval/reference -p 'test_*.py'
python3 -m unittest discover -s eval/tasks -p 'test_*.py'
```

`eval/run-tests.sh` runs them all.
