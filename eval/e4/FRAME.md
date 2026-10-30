# E4 sampling frame

Status: **frozen before any candidate was fetched.** This file is committed before the candidate list is downloaded, and everything below is applied mechanically by `eval/e4/` scripts. The commit timestamp proves the order. Nothing here may change once the candidate list exists; a mistake found later is reported, not fixed.

E4 asks one question about outside code (claim C in [docs/EVAL-PLAN.md](../../docs/EVAL-PLAN.md)): when a real project fixed a bug and added or changed a test with the fix, does that test fail before the fix and pass after it? The reference evidence is decided by `eval/e4/replay.py`, which imports nothing from POCP. `pocp history` runs on the same commits alongside, and its agreement is reported.

## 1. Population (repositories)

Public GitHub repositories that, at the moment the list is fetched, are:

- primary language **JavaScript**, **TypeScript** or **Python** (GitHub's `language:` field);
- **1,000 to 5,000 stars** (inclusive);
- **pushed within the last 365 days** (on or after 2025-10-30);
- **not archived, not a fork**.

## 2. Candidate list (frozen)

- Fetched once with the GitHub search API (`/search/repositories`), one query per language:
  `language:<L> stars:1000..5000 pushed:>=2025-10-30 archived:false fork:false`, `sort=stars`, `order=desc`, `per_page=100`, pages 1 to 3.
- So the list is **the first 300 results per language** in that order, 900 in all. This is not a uniform sample of the population: it favours the upper end of the star band. That bias is stated with every result.
- The list is saved as `eval/e4/frozen/candidates.jsonl` (full name, language, stars, pushed date, default branch, the query, the fetch time) with its SHA-256, and committed before any candidate is cloned or inspected.

## 3. Repository sample

- **Seed: `20261030`.** Recorded here, before the list exists.
- Candidates are sorted by full name (lower-cased). A `random.Random(20261030)` generator draws one `random()` value per candidate, in that order. Within each language, the **5 candidates with the smallest values** are sampled: **15 repositories**.
- Repositories are processed in order of their drawn value (smallest first, languages interleaved by value).
- The repository sample is committed before any repository is cloned.

## 4. Fix commit per repository

A commit is **eligible** when all of these hold, checked from git metadata only (no code is run or read to choose):

1. It is on the default branch's first-parent history, is not a merge, and its committer date is between 2025-10-30 and 2026-10-30.
2. Its subject line matches `\b(fix|fixes|fixed|bug|regression)\b` (case-insensitive).
3. It changes **at least one test file** (added or modified, not deleted) and **at least one non-test source file**.
   - A test file is a path with a directory named `test`, `tests`, `__tests__` or `spec`, or a file named `test_*.py`, `*_test.py`, `*.test.<ext>` or `*.spec.<ext>` (`<ext>` one of js, jsx, ts, tsx, mjs, cjs, mts, cts).
   - A source file is a `.py`, `.js`, `.jsx`, `.ts`, `.tsx`, `.mjs`, `.cjs`, `.mts` or `.cts` file that is not a test file.
4. It changes **at most 20 files**.
5. It changes **no dependency manifest or lockfile** (`package.json`, `package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`, `bun.lockb`, `pyproject.toml`, `setup.py`, `setup.cfg`, `requirements*.txt`, `poetry.lock`, `uv.lock`, `Pipfile*`), so one install serves both sides.

Eligible commits are sorted by (committer time, SHA). A `random.Random(20261030 + i)` generator, where `i` is the repository's position in the sample (0-based), draws one `random()` value per eligible commit, and **the commit with the smallest value is the one fix for that repository**. There is no second pick: if it can't be run, the repository is an exclusion.

The selection (repository, commit, parent, test files) is committed before any replay.

## 5. Replay (reference evidence)

For each selected fix, in a fresh clone, with dependencies installed once at the fix commit:

- **At the fix:** the fix's test files, as the fix committed them, are run at the fix commit. They should **pass**.
- **At the parent:** the parent commit is checked out, and only the fix's test files are put back as the fix committed them. They should **fail**.
- **Verdict:** `confirmed` (fail at the parent, pass at the fix), `does-not-detect` (pass at both), `fails-on-fix` (fail at the fix), or an exclusion.

The test command is chosen by a fixed rule, never by hand:

- **Python:** a fresh `venv`; `pip install -e ".[<extra>]"` with the first extra the project declares among `test`, `tests`, `testing`, `dev`, otherwise `pip install -e .`; then every file matching `requirements*test*.txt`, `requirements-dev*.txt`, `test-requirements*.txt`, `dev-requirements*.txt` or `requirements/{test,tests,dev}*.txt`; then `pytest`. Command: `python -m pytest -q -p no:cacheprovider <test files>`.
- **JavaScript/TypeScript:** the package manager from the lockfile (`package-lock.json` → `npm ci`, `pnpm-lock.yaml` → `pnpm install --frozen-lockfile`, `yarn.lock` → `yarn install --frozen-lockfile` or `yarn install --immutable` for Yarn 2+, through corepack; none → `npm install`). The runner is the first of `vitest`, `jest`, `mocha` found in the dependencies of the nearest `package.json` above the test files, else that of the repository root. Command, run from that `package.json`'s folder: `npx --no-install vitest run <files>`, `npx --no-install jest <files>`, or `npx --no-install mocha <files>`. No supported runner → exclusion.
- Test files that sit under different `package.json` folders → exclusion.

Limits: **15 minutes** for the install, **5 minutes** per test run. Network is allowed for the install only as far as the sandbox allows.

## 6. Exclusions

Every sampled repository ends with a verdict or one of these exclusions, published with its detail:

- `fetch-failed`: the repository couldn't be cloned.
- `no-eligible-fix`: no commit meets section 4.
- `unsupported-runner`: section 5's rule finds no runner, or the tests span packages.
- `install-failed`: the install exits non-zero or takes over 15 minutes.
- `test-timeout`: a test run takes over 5 minutes.
- `time-cap`: the whole E4 run is capped at about **2 hours** of wall time; repositories not reached by then are listed with this reason.

`fails-on-fix` is a verdict, not an exclusion: it is reported as measured, and it usually means the sandbox lacks something the project's CI has (a service, a browser, a platform). No repository is ever swapped for another.

## 7. pocp history, alongside

On the same clone, after the reference replay: `pocp history --range <parent>..<fix> --fixes 1 --test "<the same command, with {tests} for the test files>"`. POCP's verdict (`confirmed`, `does-not-detect`, `fails-on-fix`, `error`, or "not a candidate" when its own rules don't treat the commit as a fix with tests) is recorded next to the reference verdict, and agreement is reported as a count. POCP's verdict is never used as ground truth.

## 8. What the result says, and doesn't

- Per repository and pooled: how many selected fixes have a test that catches the bug it fixed.
- One commit per repository; 15 repositories at most. A small, descriptive sample (PREREG section 5: report only).
- The friction replay in EVAL-PLAN (what POCP would have asked for) is not part of this run.
