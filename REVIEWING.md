# Reviewing POCP

A guide for an engineer reviewing POCP: what to try, which code matters most, and the questions we most want answered. It takes about one to two hours. You don't need to read everything: about 7,400 lines of code, zero dependencies.

**How it was built:** with AI coding agents (Claude Code and Codex). Codex reviewed it several times.

## 1. What it is, in one minute

POCP gates git commits on proof that the required checks ran on the exact code being committed, and re-verifies in CI. Its claim, stated in the README: a coding agent's test edits can't pass CI on their own unless POCP can vouch for them. In fast mode (the default for new projects) that means the edit only adds non-risky lines to existing tests; in deep mode, planted bugs show the new tests still catch what the old ones caught. Everything else, such as loosened assertions, skipped tests, rewired test setup, a deleted rule or a forged proof, is blocked or goes to a maintainer. It doesn't judge whether the code is honest (special-casing test inputs), and it relies on the Git host to make its CI check required. Read [README.md](README.md) first; it's short.

## 2. Try it (about 10 minutes)

You need Node ≥ 20, git and a POSIX shell (Linux, macOS, or WSL). Linux is especially useful, since the author develops on a Mac.

```bash
git clone <this repo> pocp && cd pocp
npm test                      # zero dependencies; about 3–5 minutes
```

Then use it on a throwaway repo:

```bash
rm -rf /tmp/pocp-try && mkdir /tmp/pocp-try && cd /tmp/pocp-try && git init -q
mkdir -p src test
printf 'export const add = (a, b) => a + b;\n' > src/math.js
printf "import { add } from '../src/math.js';\nif (add(2, 3) !== 5) process.exit(1);\nif (add(-1, 1) !== 0) process.exit(1);\nconsole.log('ok');\n" > test/math.test.js
printf '{"type":"module"}\n' > package.json
PO=<path to the pocp clone>
pocp() { node "$PO/bin/pocp.js" "$@"; }   # works in bash and zsh
export POCP_BIN="node $PO/bin/pocp.js"     # what the git hooks run
pocp init --hooks
cat > .proof/rules.json <<'EOF'
{ "pocp": 1, "requirements": [ { "id": "math", "globs": ["src/**", "test/**"],
  "obligation": { "kind": "test", "run": "node test/math.test.js" } } ] }
EOF
git add -A && git commit -qm "start" --no-verify     # the first commit sets the rules
```

Now try three things:

1. **An honest change.** Edit `src/math.js` without changing behaviour (add a comment), then `git add -A && git commit -m x`. It's blocked. Run `pocp fix --intent "comment"`, then commit again: it passes, and the commit carries a `Proof-Of-Change` trailer.
2. **A cheat.** Break the code (`a - b`) and "fix" the test by deleting its assertions. Then run `git add -A && pocp fix --intent "cheat"`. The test guard's check fails, because the old tests fail on the new code. In the default mode the local commit may go ahead, but the decision is handed to CI, where only a maintainer can approve it. Commit it (`git commit -m cheat`).
3. **CI's view.** `pocp verify HEAD~1..HEAD --require-coverage --rerun` re-runs the checks from the commit, the way CI would. It should exit 1 with `test_change`, naming the old tests that fail on the new code. That's the block the README's table promises.

Tell us where it confused you, where the messages were unclear, and anything that behaved differently from what the README led you to expect.

## 3. The code that matters most

These are the parts that run commands, touch users' repositories, or decide whether CI passes. In rough priority:

| File | What it does | What to look for |
|---|---|---|
| `src/init.js` | Installs the git hooks into the user's repo | It must add a marked block and keep existing hooks. Without pocp installed, only pre-commit should block. Any way a hook could run something unexpected? |
| `src/runner.js` | Runs each check with `/bin/sh` in its own process group, with a watchdog that kills the group if pocp dies | Shell quoting, process-group handling, timeouts, signal handling. Can a check outlive pocp while staying in its group? (Processes that leave the group via `setsid` are a documented limit.) |
| `action.yml`, `examples/github/pocp.yml` | The GitHub Action and the recommended workflow | Triggered by `pull_request` (not `pull_request_target`), with read-only permissions. Labels are used as maintainer approvals. What runs before `verify` is PR code. Is anything here unsafe for forks? |
| `src/engine.js` (verify) | Judges a PR by the **base** branch's rules; re-runs checks; reads CI results | Can a PR loosen the rules, add its own signing key, or feed in a forged CI result and still pass? The threat model lists the intended answers. |
| `src/guard-check.js` | The test guard: old tests on new code, plus planted bugs on both sides | Fail-closed behaviour: a timeout never counts as a catch; an unmeasured mutant never yields `passed`. Does any path turn a should-block into a pass? |
| `src/sign.js` | Signs proofs with `ssh-keygen` | Use of `ssh-keygen -Y sign/verify`; the allowed-signers file. |

[docs/THREAT-MODEL.md](docs/THREAT-MODEL.md) says what each record does and doesn't prove, and [SPEC.md](SPEC.md) is the full protocol. Both are long; skim the parts that relate to what you're reading.

## 4. The questions we most want answered

1. **Would you trust it in a real repo?** If not, what would have to change?
2. **Does the README overclaim anywhere?** Especially the "what it catches" table and the "Results so far" section.
3. **Is anything unsafe:** for the user's machine (hooks, runner), for CI (the action, forks), or for the user's repo?
4. **Did the quick start work for you,** and on what OS?
5. **Is the test guard sound?** Can you weaken a test so that it passes?
6. **What's missing** before strangers should use it?
7. **Anything confusing** in the messages POCP prints when it blocks?

## 5. Giving feedback

Comments on the pull request, issues, or a note, whatever's easiest. "This part is fine" is useful too: it tells us where not to spend more time.
