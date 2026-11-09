# POCP: Proof of Change Protocol

POCP checks that the tests a pull request was supposed to pass actually ran, on the exact code being merged, under rules the pull request can't change. When a pull request edits existing tests, it runs the old tests on the new code and holds risky test edits for a maintainer. It works with any test command and any language, and needs only Node 20 or later, git and a POSIX shell.

It doesn't prove your code is correct, and it's early: no counted evaluation exists yet ([results so far](docs/RESULTS.md)).

![Terminal demo: an agent breaks add() and edits the test so npm test passes; pocp verify reports that the old test fails on the new code and waits for a maintainer](docs/demo.svg)

An agent edits a failing test until CI turns green. POCP runs the old test against the new code and routes the change to a person. Run it from a clone with `node examples/demo/demo.mjs`.

## Install

```bash
npm install --save-dev proof-of-change
npx pocp init --hooks --github
```

`init` creates `.proof/`, installs git hooks (yours keep running) and, with `--github`, writes the workflows. Then:

1. **Say what must be proven.** A rule in `.proof/rules.json` maps files to a check, which is any command (`npm test`, `pytest`, `go test ./...`):

   ```json
   { "pocp": 1, "requirements": [
     { "id": "billing-tests", "globs": ["src/billing/**"],
       "obligation": { "kind": "test", "run": "node --test test/billing.test.js" } } ] }
   ```

2. **Commit.** If the hook blocks it, run `npx pocp fix --intent "<what the change does>"` and commit again. The commit gets a `Proof-Of-Change` trailer.
3. **Check the setup** with `npx pocp doctor`, which prints the commands for anything missing.
4. **Turn on the `pocp` status** on GitHub: green when verified, yellow while waiting for a maintainer's approval label, red on a real failure ([docs/STATUS.md](docs/STATUS.md)).

**On another CI** (GitLab, Jenkins, plain shell). In CI: keep your existing test step, and add:

```bash
npx pocp verify origin/main..HEAD --require-coverage --rerun
```

[docs/QUICKSTART.md](docs/QUICKSTART.md) walks through all of this on a non-JavaScript project.

## Documentation

- [How it works](docs/HOW-IT-WORKS.md): what it catches, fast and deep modes, and what it doesn't do.
- [Results so far](docs/RESULTS.md): benchmarks and pilots, with their limits.
- [Reference](docs/REFERENCE.md): rules, checks, CI options, approvals, signed proofs.
- [Threat model](docs/THREAT-MODEL.md): what each record does and doesn't prove.
- [SPEC.md](SPEC.md): the protocol. [Reviewing POCP](docs/REVIEWING.md): a guide for reviewers.

## Why this exists

I build with AI coding agents and can't read their code at the scale they write it. POCP records proof instead of trusting a sentence like "tests pass": the checks that ran, on the exact code committed, under rules the change can't loosen, checked again in CI.

## License

MIT. See [LICENSE](LICENSE).
