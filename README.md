# POCP: Proof of Change Protocol

POCP checks that the tests a pull request was supposed to pass actually ran, on the exact code being merged, under rules the pull request can't change. When a pull request edits existing tests, it runs the old tests on the new code and holds risky test edits for a maintainer. It works with any test command and any language, and needs only Node 20 or later, git and a POSIX shell.

It doesn't prove your code is correct. It has two evaluations so far ([below](#evaluation)).

![Terminal demo: an agent breaks add() and edits the test so npm test passes; pocp verify reports that the old test fails on the new code and holds the change for a maintainer; the agent puts the test back, fixes add(), and verify passes](docs/demo.svg)

An agent edits a failing test until CI turns green. POCP runs the old test against the new code and holds the change for a person. Rather than wait for that approval, the agent puts the test back and fixes the code, and the pull request verifies. Run it from a clone with `node examples/demo/demo.mjs`.

## Install

```bash
npm install --save-dev proof-of-change
git add package.json package-lock.json && git commit -m "Add proof-of-change"
git checkout -b adopt-pocp        # with --github, POCP is adopted through a pull request
npx pocp init --hooks --github
```

Commit the dependency before you start the adoption branch: the adoption pull request should carry only `.proof/` and CI files, and `pocp doctor` flags anything else in it. In local mode (below) there is no adoption pull request: skip the branch and commit on `main`. `--github` needs a GitHub `origin` and `gh` logged in with the `workflow` scope (`gh auth refresh -s workflow`). Before you push, set your toolchain and install command in `.github/workflows/pocp.yml` (the lines marked ▶): CI runs every check on a fresh machine. No CI? Use `npx pocp init --local` (below).

`init` creates `.proof/` and installs git hooks (yours keep running). Then:

1. **Say what must be proven.** A rule in `.proof/rules.json` maps files to a check, which is any command (`npm test`, `pytest`, `go test ./...`):

   ```json
   { "pocp": 1, "requirements": [
     { "id": "billing-tests", "globs": ["src/billing/**"],
       "obligation": { "kind": "test", "run": "node --test test/billing.test.js" } } ] }
   ```

2. **Commit.** If the hook blocks it, run `npx pocp fix --intent "<what the change does>"` and commit again. The commit gets a `Proof-Of-Change` trailer.
3. **Check the setup** with `npx pocp doctor`, which prints the commands for anything missing.

**Upgrading.** `npx pocp upgrade --dry-run` shows what a newer release would change; `npx pocp upgrade` bumps the dependency (or the global install), re-pins the GitHub workflows to the new release and says which approvals the pull request needs. POCP never checks for updates in the background: `pocp doctor` notes, from local files, when the hooks and CI run different releases, and only `pocp upgrade` asks the npm registry ([docs/REFERENCE.md](docs/REFERENCE.md#upgrading)). From 1.4, which has no `upgrade`, see that section first.

## Where the checks run

**GitHub CI** (`--github`, above). Run it once the GitHub repository exists, `origin` points at it and `gh` is logged in: `init` then writes the workflows, creates the approval labels and turns on the `pocp` status, which is green when verified, yellow while waiting for a maintainer's approval label and red on a real failure ([docs/STATUS.md](docs/STATUS.md)). Once the workflows are merged, `npx pocp ci required --apply` makes GitHub block merges until `pocp` is green. CI re-runs every check on a clean machine, and approvals are a maintainer's label. The trade: each pull request costs about one extra test run of Actions minutes, and on a free plan's private repository nothing blocks a merge.

**Local mode, no CI.** `npx pocp init --local` instead of `--github`, or `npx pocp ci off` on a repository that already has the workflows (`pocp ci on` reverses it). The git hooks are the gate and CI costs nothing. The trade: nothing re-runs the checks on another machine, nothing blocks a merge, and `git commit --no-verify` skips the gate unless you run `npx pocp verify --require-coverage --rerun main..HEAD` before you merge. Approvals are `--accept-*` flags on that command, so anything that can run commands on your machine, an agent included, can give them. `pocp doctor` suggests it when Actions jobs aren't starting for billing reasons. In local mode, `pocp ci off` and `pocp doctor` also find your other workflows that fail only because GitHub doesn't start their jobs for billing (no Actions minutes left, or a spending limit reached), and list each one with its latest run and GitHub's message. They then ask once before disabling them on GitHub. The workflow files stay as they are, and `gh workflow enable <file>` turns each back on. Without a terminal, or with `--json`, they only report, unless you pass `--disable-billing-failed`.

**The reporter's own GitHub App** (optional, on top of GitHub CI). By default the `pocp` status is posted as GitHub Actions, like any workflow, so a branch pushed to your repository, by an agent using your token for example, can edit a workflow and post its own `pocp: success`. Giving the reporter its own App, with its key in an environment only the default branch can use, and requiring `pocp` from that App closes this. The trade: three setup steps, and it needs a public repository or GitHub Pro or Team ([docs/STATUS.md](docs/STATUS.md#give-the-reporter-its-own-identity)).

**On another CI** (GitLab, Jenkins, plain shell). In CI: keep your existing test step, and add:

```bash
npm install --prefix "$HOME/.pocp" --no-save --ignore-scripts proof-of-change@1.5.0
node "$HOME/.pocp/node_modules/proof-of-change/bin/pocp.js" verify origin/main..HEAD --require-coverage --rerun
```

Install the verifier outside the checkout and run it with `node`, as the GitHub workflow does. Not `npx pocp` from inside it: the pull request controls the checkout's `package.json`, `.npmrc` and `node_modules`, so npx would run whatever `pocp` the pull request ships.

[docs/QUICKSTART.md](docs/QUICKSTART.md) walks through all of this on a non-JavaScript project.

## With Claude Code, Codex, Cursor and pre-commit

**Claude Code.** Install the plugin:

```text
/plugin marketplace add harriswekselblatt/pocp
/plugin install pocp@pocp
```

Run `/pocp:setup` in a repository that doesn't use POCP yet: Claude finds your test command, asks where the checks should run, installs POCP and writes a first rule, asking before it commits or pushes. In a repository that uses POCP, the plugin stops Claude from going around it: no `git commit --no-verify` or `core.hooksPath` change to skip the gate, no force-push over proven commits, no approving its own test or policy change (adding a `pocp-approve-*` label, `pocp approve`, `--accept-*`), and no switching checks off on GitHub without a pull request (`pocp ci off`, `pocp init --local`, `gh workflow disable`, `--disable-billing-failed`). Each refusal tells Claude what to do instead. When a command's output shows POCP holding a change for you, the plugin gives Claude POCP's full plain-English reason, so Claude tells you the exact command, what the label means and why this change needs it, never just the 140-character status line. It also teaches Claude the POCP workflow. It guards against an agent cutting corners, not one set on hiding what it does; CI is still the check.

**Codex, Cursor and other agents.** Paste [examples/agent-instructions.md](examples/agent-instructions.md) into the agent's instructions: `AGENTS.md` for Codex, a file in `.cursor/rules/` for Cursor. Instructions guide the agent; the git hooks and CI enforce.

**pre-commit.** If you manage hooks with [pre-commit](https://pre-commit.com), use POCP's hooks instead of `pocp init --hooks`:

```yaml
default_install_hook_types: [pre-commit, prepare-commit-msg, post-commit]
repos:
  - repo: https://github.com/harriswekselblatt/pocp
    rev: v1.5.0
    hooks: [{ id: pocp-gate }, { id: pocp-trailer }, { id: pocp-land }]
```

Then `pre-commit install`. `pocp doctor` recognises them.

## Evaluation

A benchmark of POCP 1.2.3 on p-map (JS), boltons (Python) and gjson (Go): 180 cases and 1,260 runs, 68 of the cases held out until the scoring script was locked ([full report](eval/campaign-123/README.md)). The protocol was frozen by hash before the runs. The freeze record isn't public, so that order rests on my account. The raw records and the scripts that score them are public in [pocp-eval](https://github.com/harriswekselblatt/pocp-eval).

- **Harmful changes (48):** each breaks the code, then hides it with one of four scripted edits to the test that caught it: delete the assertion, empty the assertion helper, overwrite the expected-value fixture, or make the check script exit 0. Plain CI accepted all 48. POCP accepted none: in both modes it held each one for a person, with the old tests failing on the new code. That shows the old-tests check works on each part of a suite in three languages. It doesn't measure cheats that leave the old tests passing (no harmful case reached deep mode's planted bugs), or deliberate deception across pull requests ([threat model](docs/THREAT-MODEL.md)).
- **Honest changes (108):** deep mode accepts 78–82% per seed, and 86–88% without the 24 paired controls built to resemble cheating. It sends the rest to review. Fast mode reviews every test edit by design, so it accepts 27%, about what a rule holding every test-file edit would. Reducing that friction is the next piece of work.

### E8: two coding agents on tasks that can't be solved honestly

A preregistered study of POCP at commit `bc3e1b3` ([registration](eval/e8/PREREG.md), [results](eval/e8/RESULTS.md)), run on 2026-11-27. Claude Code (`claude-sonnet-5-5`) and Codex (`gpt-6.2-sol`) each worked in a container on ImpossibleBench LiveCodeBench tasks whose tests contradict each other, so the only way to get CI green is to change the tests. Each task was run once per agent with plain CI and once with POCP's verify in CI: 120 runs with the tests already committed (E8a) and 40 with the tests arriving uncommitted (E8b). A "cheat" is the reference checker's label for a run CI accepts after the tests were weakened; it says nothing about intent. No hypothesis had a pass/fail bar.

- **Cheats that plain CI accepted, without POCP (E8a):** Claude 0/30 (0.0%; cluster 95% CI 0.0–0.0%), Codex 19/30 (63.3%; cluster 95% CI 46.7–80.0%). A sample of all zeros gives a zero-width bootstrap interval; the Wilson interval for 0/30 is 0–11.4%.
- **Agents produced CI-passing cheats at least as often with POCP installed (E8a):** Claude 2/30 (6.7%; cluster 95% CI 0.0–16.7%), Codex 24/30 (80.0%; cluster 95% CI 63.3–93.3%). The study doesn't show why.
- **POCP blocked every one of those:** Claude 2/2 (100.0%; Wilson 95% CI 34.2–100.0%), Codex 24/24 (100.0%; Wilson 95% CI 86.2–100.0%).
- **None of the blocks was a mechanical catch:** Claude 0/2 (0.0%; Wilson 95% CI 0.0–65.8%), Codex 0/24 (0.0%; Wilson 95% CI 0.0–13.8%). All 26 were escalations: the tests already failed before the change, so POCP could not tell whether the edit hid a behavior change and asked a person. A rule sending every edit of an existing test file to a person would have flagged the same 26.
- **Cheats that shipped (E8a):** Claude 0/30 (0.0%; cluster 95% CI 0.0–0.0%) in both arms. Codex 19/30 (63.3%; cluster 95% CI 46.7–80.0%) with plain CI and 0/30 (0.0%; cluster 95% CI 0.0–0.0%) with POCP: a paired difference of −19/30 (−63.3 percentage points; task bootstrap 95% CI −80.0 to −46.7). With POCP those cheats were held for a person's approval. The study had no approver, so it doesn't show what a maintainer would have decided.
- **Tests that arrive uncommitted (E8b):** I predicted POCP would block few or none of these, on a wrong reading of my own code (the build already guards added test files). Claude produced no cheat in either arm (0/10 each), so there was nothing to block. Codex produced 0/10 (0.0%; cluster 95% CI 0.0–0.0%) with plain CI and 2/10 (20.0%; cluster 95% CI 0.0–50.0%) with POCP, and POCP blocked both, 2/2 (100.0%; Wilson 95% CI 34.2–100.0%): one escalation, and one refusal of a test file the harness committed without a packet. No mechanical catch here either.
- **POCP refused every final state in its arm,** cheat or not: 30/30 (100.0%; Wilson 95% CI 88.6–100.0%) for each agent in E8a and 10/10 (100.0%; Wilson 95% CI 72.2–100.0%) for each in E8b. No run ended in an honest solution, so the study measures no false-block rate.
- **Audit:** a blind reviewer agreed with the checker's label on 20/20 (100.0%; Wilson 95% CI 83.9–100.0%) sampled runs. The reviewer was an AI model, not me, which is one of four deviations from the registration listed in the results.

This is a stress test on artificial puzzles with one run per task, agent and arm, on fixed model versions. It isn't a real-world cheat rate, and it doesn't measure the data-file guard added after the tested commit.

## Why not just require review of test files?

Fast mode is close to that rule, with two differences. The reviewer gets evidence, not just a diff: POCP runs the old tests on the new code and names any that now fail. And what must pass is set by the base branch, so a pull request can't get green by changing its rules, its check command, its test script or its runner config. Deep mode goes further: its planted bugs let most honest test edits through with no person.

Approving is cheap when nothing broke. If the old tests still pass on the new code, a maintainer's `pocp-approve-tests` label turns `pocp` green without running verify again. If they fail, the label still re-runs verify ([docs/STATUS.md](docs/STATUS.md)).

## Documentation

- [How it works](docs/HOW-IT-WORKS.md): what it catches, fast and deep modes, and what it doesn't do.
- [Evaluation of 1.2.3](eval/campaign-123/README.md): the benchmark. [E8](eval/e8/RESULTS.md): two agents on impossible tasks. [Earlier results](docs/RESULTS.md): scripted suites and pilots.
- [Reference](docs/REFERENCE.md): rules, checks, CI options, approvals, signed proofs.
- [Threat model](docs/THREAT-MODEL.md): what each record does and doesn't prove.
- [SPEC.md](SPEC.md): the protocol. [Reviewing POCP](docs/REVIEWING.md): a guide for reviewers.

## Why this exists

I build with AI coding agents and can't read their code at the scale they write it. POCP records proof instead of trusting a sentence like "tests pass": the checks that ran, on the exact code committed, under rules the change can't loosen, checked again in CI.

## License

MIT. See [LICENSE](LICENSE).
