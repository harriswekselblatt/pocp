# Architecture

How POCP's source is organized, and the rules that keep it that way. [SPEC.md](../SPEC.md) is
the protocol; this is the code.

## Layers

```
bin/pocp.js            the executable: runs src/cli.js and turns unexpected errors into exit 3
src/cli.js, cli-args   commands: parse arguments, call the engine, print text or --json
src/engine.js          createPocp(): the engine, one instance per repository
src/engine/            parts of the engine, each built by a factory createPocp calls
src/*.js               the domain and adapters the engine uses (below)
```

A layer uses only what's beneath it. Nothing in `src/` imports `cli.js`, and no module in
`src/engine/` imports `engine.js`.

## The engine

`createPocp(opts)` builds one engine for one repository: its store, runner, policy host and
caches. It returns the operations the CLI and library callers use: packets, proving, the gate,
trailers, verify, and misses.

Parts of the engine live in `src/engine/`, each made by a factory that receives exactly what it
uses:

| Module | What it does |
|---|---|
| `engine/misses.js` | `createMisses`: record a bug that escaped, link it to the packets that let it through (`blame`), close it with a rule whose check, replayed, catches it where it escaped |
| `engine/range.js` | `createRange`: verify a range of commits (a pull request): each commit judged by the policy at its base, then the net change as one change, with the test guard run on the whole pull request |
| `engine/shared.js` | Definitions several parts use (`PocpError`, `STAGES`, `SEVERITIES`, the run memo, CI-result and protected-file helpers), so none of them imports the facade |

The rest of the engine is still inside `createPocp`.

Rules for a part:
- **It gets its dependencies as arguments.** A factory's parameter list is exactly what it uses from the rest of the engine. Live readers (`config()`, `rules()`) are passed as functions, never as snapshots, and the options object is passed whole, so calls on it keep their receiver.
- **State stays with its owner.** Caches that live for one engine stay inside `createPocp` or the part that owns them, behind functions. They're never copied into another part.
- **Building a part does no work.** A factory only creates functions. It doesn't read policy, scan history or run checks. Only `createPocp` does work at construction (resolving the repository, reading the actor), as it always has.
- **The public surface is `createPocp`'s return value.** `engine.js` re-exports shared definitions under the same names and identities.

## Domain and adapters

| Module | Responsibility |
|---|---|
| `packets.js`, `obligations.js` | Packets and obligations: creating, widening, evaluating proofs against a subject |
| `rules.js`, `policy.js`, `schema.js` | Rules and triggers; the policy algebra (loosening, strict combination, blocking); known policy keys |
| `decision.js`, `finding.js`, `remedies.js` | What a verify result waits for, from typed findings; the words shown for each finding |
| `guard.js`, `guard-check.js`, `test-setup.js`, `mutants.js` | The test guard: which changes are test changes, and the mechanical check (old tests on new code, planted mutants) |
| `records.js`, `errors.js` | Shapes of records read back; one base error and the exit-code table |
| `git.js`, `store.js`, `workspace.js` | Git access, the `.proof/` store, snapshots and checkouts |
| `runner.js`, `isolate.js`, `run-result.js`, `output-tail.js`, `exit.js` | Running checks, isolated runs, how a run ended, cleanup |
| `sign.js`, `hash.js`, `trailer.js`, `glob.js` | Signatures, digests, commit trailers, globs |
| `status-report.js`, `approvals.js`, `ci-results.js`, `ci-github.js` | The trusted CI reporter, approval labels, recorded CI results, GitHub setup |
| `init.js`, `doctor.js`, `fix.js`, `history.js`, `metrics.js`, `host.js` | Setup, health checks, `pocp fix`, history replay, metrics, host policy modules |

## Tests that hold it in place

- `test/golden.test.js`: what POCP prints and returns on fixed scenarios. A restructuring leaves every golden identical.
- `test/security-invariants.test.js`: the properties POCP must keep (the base judges the head, evidence is bound to content, and so on), checked by outcome.
