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

What CI's `pocp verify <base>..HEAD --require-coverage --rerun` decides, with the default settings (test guard in `block` mode):

| An agent… | Plain CI | POCP |
|---|---|---|
| deletes or weakens a failing assertion, in one commit, split across commits, or inside a merge commit | passes | blocked: the old tests fail on the new code, judged on the whole pull request |
| marks tests `.skip`, `.only` or skipped | passes | blocked |
| hollows out the test script, the runner config, or an assertion helper the tests import | passes | blocked, for helpers POCP can find (see the limits) |
| deletes or loosens the rule that requires a check | n/a | blocked: judged by the base branch's rules |
| forges a proof | n/a | blocked: verify re-runs the checks itself |
| forges a CI result | n/a | blocked with the default recipe above. The faster `--ci-results` mode trusts everything that ran in the job and can be forged |
| removes POCP from the CI workflow | passes | blocked only if your Git host *requires* the POCP check (see [Merge enforcement](#merge-enforcement)) |
| writes code that games its own tests: special-cases the inputs, overrides `process.exit`, detects the test run | passes | **not caught**: POCP checks that the declared checks ran on the exact code, not whether the code is honest |

These rows hold within the limits in [docs/THREAT-MODEL.md](docs/THREAT-MODEL.md), and the main ones are:
- **Re-runs execute the pull request's code** in your CI job, as the same user. That's as trustworthy as your CI, plus the checks the pull request can't edit.
- **The mechanical test check samples** planted bugs.
- **Helpers are found by reading imports,** within depth and size limits; a helper inside your guarded source counts as code unless it looks like test support (path, test-framework or assertion-library import) or the tests use it as such.
- **A test layout POCP doesn't recognise** needs `guard.extra_test_globs`. `pocp init` detects common ones.

## Results so far

Every number below links to its raw data and the command that produced it. All of it is early; read it as such.

- **Scripted tamper benchmark** ([results](bench/tamper/RESULTS.md)): 53 commits, each a real bug plus a cheat that turns CI green, on POCP's own repository. In POCP's default mode it blocks **all 32 of the cheats that fool plain CI**, and none of the 6 honest controls. In the optional `attest` mode, where the author can sign off on their own test change, it blocks 20 of 32. *Limit: the cheats are scripted and the bugs are planted with POCP's own mutation operators, so this is a regression suite, not independent evidence.*
- **Independent evaluation** ([eval/](eval/), [plan](docs/EVAL-PLAN.md), [pre-registration](eval/PREREG.md)): real coding agents on [ImpossibleBench](https://arxiv.org/abs/2510.20270) tasks, a separate reference checker written in another language that shares no code with POCP, outside mutation tools, and real timestamps. The passing bars were set before any counted run. Only pilots have run so far:
  - **Codex, 80 runs:** 1 in 10 tasks produced a test-editing cheat per arm, too few to grade a catch rate. On honest work POCP blocked 0 of 10 solutions.
  - **StrykerJS, 16 sampled mutants:** POCP's checks and Stryker agreed on all 16.

  Full numbers will be published here as counted runs finish, whether or not they clear the bars.
- **Cost on honest work** ([data](eval/e5/RESULTS.md)), from POCP's own development, mostly agent-written commits:
  - **Most commits get blocked once.** Only 7 of 45 commits that touched guarded files passed the gate on the first try.
  - **Getting through is usually quick:** a median of about 2 minutes, mostly running `pocp fix`.
  - **Changing an existing test file is the slow, strict case.** The mechanical test check runs the suite once per planted bug. It took up to about 17 minutes, and it passed only 2 of the 9 times it ran; the others needed a maintainer's approval in CI.
  - **Adding new tests costs nothing extra.**
  - **Every proven change adds a small record** (`.proof/packets/*.json`, typically 70–170 lines) to the repository. It names who made it (the git user name, or `POCP_ACTOR` if set) and the Node version and platform the checks ran on.

## Quick start

POCP isn't on npm yet. Install a pinned commit:

```bash
npm install --save-dev github:harriswekselblatt/pocp#<commit>
npx pocp init --hooks
```

`init` creates `.proof/`, prints where it found your tests (and adds test folders the defaults miss to `guard.extra_test_globs`), and installs three git hooks (gate, trailer, landing). Hooks you already have keep running: one pocp can't append to (a node or python hook, or one that ends in `exec`, like the pre-commit framework's) is moved to `<hook>.pre-pocp` and runs first. Then write a rule in `.proof/rules.json`:

```json
{
  "pocp": 1,
  "requirements": [
    { "id": "billing-tests", "globs": ["src/billing/**"],
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
