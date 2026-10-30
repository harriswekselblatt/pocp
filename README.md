# POCP: Proof of Change Protocol

**Your coding agent can't fake green CI by weakening the tests.**

Plain CI runs whatever tests the pull request contains. An agent stuck on a failing test can delete the assertion, mark the test skipped, point the runner somewhere else, or weaken the check, and CI turns green. POCP closes that gap:

- **It runs the checks itself** and ties every result to a hash of the exact code it tested. "Tests pass" stops being a sentence someone typed.
- **It judges each pull request by the base branch's rules**, so a change can't delete a requirement, loosen a threshold or add its own signing key and still pass.
- **It checks test changes mechanically.** The old tests must still pass on the new code, and the new tests must catch the planted bugs the old ones caught. Adding tests is free; quietly weakening them isn't.

It works the same whoever writes the code: a person, a coding agent, a bot. Zero dependencies.

```
$ git commit -m "Fix rounding at half-cents"
pocp: commit blocked
  why: 1 file(s) have required checks
  not covered by any packet: src/billing/round.js
  …
      next: pocp fix --intent "<what this change does>"

$ pocp fix --intent "Fix rounding at half-cents"
pocp fix: ready to commit (git commit)
  did: opened p-2f007850 for 1 file(s) with checks o1 (rule:billing-tests)
  did: proved p-2f007850 (1 check(s) run, 0s)

$ git commit -m "Fix rounding at half-cents"
pocp: gate passed (1 packet(s) proven for sha256:2ad8c12023b7)
```

The commit ends with a trailer:

```
Proof-Of-Change: p-2f007850 subject=sha256:2ad8c12023b7 policy=sha256:f21acbea749e proven=1/1 attested=0/0
```

It's only a pointer. CI recomputes everything from the commit and re-runs whatever no trusted signer or CI result already covers.

## What it does and doesn't catch

| An agent… | Plain CI | POCP |
|---|---|---|
| deletes or weakens the failing assertion | passes | blocked: the old tests fail on the new code |
| marks the test `.skip`, `.only` or skipped | passes | blocked |
| hollows out the test script or runner config | passes | blocked |
| deletes the requirement from the rules | n/a | blocked: judged by the base branch's rules |
| forges a proof or a CI result | n/a | blocked: CI re-runs it |
| removes POCP from the CI workflow | passes | blocked only if your Git host *requires* the POCP check (see [Merge enforcement](#merge-enforcement)) |
| special-cases the test inputs in the code | passes | **not caught**: POCP checks that the declared checks ran on the exact code, not whether the code is honest |

## Results so far

Every number below links to its raw data and the command that produced it. All of it is early; read it as such.

- **Scripted tamper benchmark** ([results](bench/tamper/RESULTS.md)): 53 commits, each a real bug plus a cheat that turns CI green, on POCP's own repository. In POCP's default mode it blocks **all 32 of the cheats that fool plain CI**, and none of the 6 honest controls. In the optional `attest` mode, where the author can sign off on their own test change, it blocks 20 of 32. *Limit: the cheats are scripted and the bugs are planted with POCP's own mutation operators, so this is a regression suite, not independent evidence.*
- **Independent evaluation** ([eval/](eval/), [plan](docs/EVAL-PLAN.md), [pre-registration](eval/PREREG.md)): real coding agents on [ImpossibleBench](https://arxiv.org/abs/2510.20270) tasks, a separate reference checker written in another language that shares no code with POCP, outside mutation tools, and real timestamps. The passing bars were set before any counted run. Only pilots have run so far:
  - **Codex, 80 runs:** 1 in 10 tasks produced a test-editing cheat per arm, too few to grade a catch rate. On honest work POCP blocked 0 of 10 solutions.
  - **StrykerJS, 16 sampled mutants:** POCP's checks and Stryker agreed on all 16.

  Full numbers will be published here as counted runs finish, whether or not they clear the bars.
- **Cost on honest work:** in POCP's own development (mostly agent-written commits), a blocked commit took a median of about 2 minutes to get through ([data](eval/e5/RESULTS.md)). Changing an *existing* test file is the slow case: the mechanical test check can take several minutes because it runs the suite once per planted bug. Adding new tests costs nothing extra.

## Quick start

POCP isn't on npm yet. Install a pinned commit:

```bash
npm install --save-dev github:harriswekselblatt/pocp#<commit>
npx pocp init --hooks
```

`init` creates `.proof/` and installs three git hooks (gate, trailer, landing). Then write a rule in `.proof/rules.json`:

```json
{
  "pocp": 1,
  "requirements": [
    { "id": "billing-tests", "glob": "src/billing/**",
      "obligation": { "kind": "test", "run": "node --test test/billing.test.js" } }
  ]
}
```

A check is any command: `npm test`, `pytest`, `cargo test`, `go test ./...`, `make check`. Your project can be in any language. A walkthrough on a non-JavaScript repo is in [docs/QUICKSTART.md](docs/QUICKSTART.md).

In CI:

```bash
# Re-runs every required check on the exact code, by the base branch's rules.
# Keep your existing test step as it is.
pocp verify origin/main..HEAD --require-coverage --rerun
```

Ready-made workflows for GitHub, GitLab and plain shell are in [`examples/`](examples/). There's also a GitHub Action ([`action.yml`](action.yml)) that runs the copy of POCP bundled at its own ref, so `uses: harriswekselblatt/pocp@<commit>` pins the verifier.

## Platforms

- **Runs on** Linux, macOS, and Windows through WSL. Native Windows isn't supported, because the hooks and checks need a POSIX shell.
- **Needs** Node ≥ 20 and git.
- **Tested** on every change in CI on Ubuntu and macOS, with Node 20, 22 and 24.

## Merge enforcement

POCP verification works on any CI and any host: `pocp verify` fails its check on a bad change. Whether a failing check actually *blocks the merge* is up to your Git host's settings. On GitHub that's branch protection (free for public repositories; a paid plan for private ones). `pocp ci required --check` reports any gap, and `pocp ci required --apply` sets the checks. POCP never changes merge settings unless you run that command.

## Using it with coding agents

- `pocp fix --intent "<what the change does>"` takes every mechanical step a blocked commit needs and says what's left and who must do it.
- `pocp check-edit <file>` tells an agent, before it edits, whether a file needs a packet first.
- When a person is needed (a test change that can't be shown safe, a loosened rule), POCP names the one action, such as "a maintainer adds the `pocp-approve-tests` label", and tells the agent not to squash, force-push or bypass the hooks. It never signs off for anyone.

A ready Claude Code hook and an instructions block for any agent are in [`examples/`](examples/).

## Limitations

- **It doesn't judge whether code is honest.** Code written to pass the specific test inputs gets past any mechanical check.
- **Proofs aren't hermetic.** A check can read the network, environment variables and installed packages. Runner details are recorded, and `verify --rerun` in CI gives an independent result.
- **The mutation check samples.** By default it plants 10 small bugs. A weakening that only matters outside the sample can pass. Raise `guard.mutants` for more confidence.
- **The planted bugs are simple.** POCP's 16 operators make small edits: flipped comparisons, swapped operators, changed constants. On POCP's own code, about 14% of StrykerJS's mutants are exactly an edit POCP's operators can make (whitespace aside), so many kinds of change are never planted. A test that guards only behaviour those operators can't break isn't measured.
- **The test check can be slow, and fails closed.** A run that times out is retried once with 3× the limit, then the result is inconclusive and a person decides. In the worst case, a mutant that hangs every check, that's about 100 minutes with the defaults. Details in [docs/REFERENCE.md](docs/REFERENCE.md).
- **Process cleanup covers the check's process group.** A process a check starts in a new session (`setsid`, a detached daemon) can outlive it.
- **Squash merges rewrite commit messages.** Verify the pull request's commits, not the squash commit.

## Documentation

- [docs/REFERENCE.md](docs/REFERENCE.md): rules, obligations, run modes, CI options, signed proofs, misses, measuring, the library.
- [SPEC.md](SPEC.md): the protocol. [test/vectors.json](test/vectors.json) has the exact hashes any implementation must produce.
- [docs/THREAT-MODEL.md](docs/THREAT-MODEL.md): what each record does and doesn't prove.

## License

MIT. See [LICENSE](LICENSE).
