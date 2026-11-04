# POCP: Proof of Change Protocol

**Status:** v0.1 · **Runtime:** Node ≥ 20, git, POSIX shell · **Dependencies:** none

POCP makes a risky code change carry proof. Before a broad or sensitive commit lands,
someone (an agent or a person) states what the change is for and how it will be shown
not to break anything. POCP then runs those checks itself, ties the results to the exact
code that was tested, and records them on the commit. When a bug slips through anyway,
closing it requires a new runnable rule for the code it got through, so the gate gets
stricter over time. A replay step can then show the new rule really does catch that bug.

It works the same whatever writes the code: a person at a terminal, a coding agent,
a CI bot. Anything that can run a command or a git hook can use it.

---

## 1. Principles

1. **Proof is run, not claimed.** A check passes because POCP ran it and saw it pass.
   A statement that something was checked is recorded as an *attestation* and is never
   shown as proof.
2. **Proof is tied to what it proves.** Every proof records a hash of the code it ran
   against and of the exact obligation it ran. Change either, or change the rules so
   different obligations are required, and the proof no longer counts.
3. **Every escape tightens the rules.** A bug that got past the gate can only be closed
   by adding a runnable rule for the affected files. Claiming that the rule *would have
   caught* the bug takes a separate step that shows it (replay, §8.2).
4. **States mean what they say.** A packet is never marked done unless its proof is done.
   Expired, abandoned and failed are their own states.
5. **The repo is the source of truth.** Packets and rules live in the repository, so
   they show up in review and CI can check them without anyone's machine.
6. **Zero dependencies.** Node and git only.
7. **Harness-agnostic.** A CLI with machine-readable output, plus a small library API.
   Hooks and integrations are thin wrappers around it.

## 2. Terms

| Term | Meaning |
|---|---|
| **Change** | The set of staged files about to be committed. |
| **Subject** | The code a proof is about: the staged contents of the repo, minus `.proof/`. |
| **Subject hash** | SHA-256 over the `mode sha\tpath` lines of the index (`git ls-files -s`), `.proof/` paths removed, sorted by path and joined with `\n`. Paths sort by UTF-16 code units (JavaScript string order), which differs from UTF-8 byte order only when paths mix characters above U+FFFF with U+E000–U+FFFF; `test/vectors.json` has a case. Deleted files drop out of the listing, so deletions change it too. |
| **Obligation digest** | SHA-256 over the canonical JSON of one obligation's runnable fields (`kind`, `run`, `expect`, `inputs`, `timeout_ms`, and `cwd` when set). Test vectors: `test/vectors.json`. |
| **Policy digest** | SHA-256 over the canonical JSON of the requirements that apply to a packet's files, after repo rules and host policy are merged (§6.1). |
| **Packet** | A declared change: intent, the files it touches, and the obligations it must meet. |
| **Obligation** | One thing that must be shown true for the packet, such as "the billing tests pass". |
| **Proof** | A record of POCP running an obligation against a subject hash. |
| **Attestation** | A named person's or agent's statement for an obligation that can't be run (`manual`). Bound to the subject hash and obligation digest like a proof, and always shown apart from proof. |
| **Rule** | Policy that decides when a packet is needed and what it must include. |
| **Gate** | The check at commit time: are all required files covered by packets proven against this subject? |
| **Miss** | A failure found after a change passed the gate. |
| **Ratchet** | The requirement that closing a miss adds or strengthens a rule. |

## 3. Storage layout

```
.proof/
  config.json          # thresholds, run mode, area depth
  rules.json           # triggers and required obligations (see §6)
  packets/<id>.json    # one file per packet (committed)
  misses/<id>.json     # one file per miss (committed)
  runs/                # raw stdout/stderr of proof runs (git-ignored)
```

One file per packet and per miss keeps parallel branches from conflicting.
Every record carries `"pocp": 1`, its format version. A reader refuses a record written for
a format it doesn't know rather than guessing (rules and config are then invalid policy).
The subject hash excludes `.proof/`, so a packet file can sit in the very commit it
proves without changing the hash it records. Rules and obligations are in `.proof/`
too, so they are bound separately, through the obligation and policy digests.

## 4. Packets

### 4.1 Shape

```json
{
  "pocp": 1,
  "id": "p-7f3a9c21",
  "intent": "Move invoice rounding into the billing module",
  "touches": ["src/billing/round.js", "src/invoice.js"],
  "obligations": [
    { "id": "o1", "kind": "test",    "run": "node --test test/billing.test.js", "source": "rule:billing-tests" },
    { "id": "o2", "kind": "command", "run": "npm run typecheck",                "source": "author" },
    { "id": "o3", "kind": "manual",  "text": "Invoice PDF checked by eye",      "source": "author" }
  ],
  "state": "open",
  "policy": "sha256:c71a…",
  "policy_repo": "sha256:08e2…",
  "opened_at": "2026-10-26T19:00:00Z",
  "opened_by": "agent:example",
  "proofs": [],
  "attestations": [],
  "history": []
}
```

### 4.2 Obligation kinds

| Kind | Runs? | Passes when |
|---|---|---|
| `test` | yes | the command exits 0 |
| `command` | yes | the command exits 0 and, if given, output matches `expect` (a regex) |
| `probe` | yes | the command exits 0 against a running target (an HTTP check, a smoke script). May declare `target` for reporting. |
| `manual` | no | a named actor attests it. Counted and shown separately. |

Optional fields on runnable obligations:

- `inputs`: globs of files the check reads beyond `touches`; clean mode checks them (§5.2).
- `timeout_ms`: defaults to `config.run.timeout_ms` (600000).
- `cwd`: a folder inside the repository to run the command in (for monorepos and harnesses
  that must start in a subfolder). Included in the obligation digest only when set.
- `expect`: a regex the output must match (`command` only).

Every obligation records its `source`: `author`, `rule:<id>`, or `host:<name>`.
Rules can require obligations; authors can add more; nobody can remove one a rule added.
The packet stores the policy digest it was last checked against: `policy` (repo rules
plus host policy) and `policy_repo` (repo rules alone, so CI without the host can check it).

### 4.3 States

```
draft ─► open ─► proven ─► landed
           │        │
           │        └─► open        (subject changed: proofs no longer match)
           ├─► failed ─► open       (a run failed; fix and re-run)
           ├─► expired              (open longer than config.packet_ttl_days)
           └─► abandoned            (closed by hand, with a reason)
```

- **proven**: the packet has at least one obligation; every obligation the current rules
  require is in it; every runnable obligation has a passing proof whose subject hash and
  obligation digest match now; and every manual obligation has an attestation for the
  current subject. A packet with no obligations proves nothing and is never proven.
- **draft**: opened with `--draft`; covers nothing at the gate until `pocp ready`.
- **landed**: a commit reachable from HEAD carries the packet's trailer with a matching subject. Derived from git on read (§7.1), never stored.
- **merged**: a commit reachable from HEAD names the packet in a `Proof-Of-Change` line anywhere in its message, but no such commit's code matches the proven subject (a squash or rebase merge onto a branch that has moved, or code changed after proving). Derived, never stored. Not active, and reported apart from landed.
- **expired**: no activity (the latest `history` entry) for longer than `config.packet_ttl_days`. Derived on read, never stored, so raising the TTL revives a packet.
- `expired`, `merged` and `abandoned` never count as completed in any metric.

## 5. Proofs

### 5.1 Record

```json
{
  "obligation": "o1",
  "obligation_digest": "sha256:9d0e…",
  "subject": "sha256:4be1…",
  "policy": "sha256:c71a…",
  "run": "node --test test/billing.test.js",
  "mode": "clean",
  "exit": 0,
  "signal": null,
  "timed_out": false,
  "passed": true,
  "started_at": "2026-10-26T19:04:11Z",
  "duration_ms": 8421,
  "stdout_sha256": "…",
  "stderr_sha256": "…",
  "runner": {
    "pocp": "0.1.0",
    "node": "22.11.0",
    "platform": "darwin-arm64",
    "ci": false,
    "lockfile_sha256": "…"
  }
}
```

Raw output is never committed: it goes to `.proof/runs/<run-id>.log`, which is git-ignored,
and the packet keeps only its hashes. Test output can print secrets, and packets are
meant to be pushed. `lockfile_sha256` is the hash of the first lockfile found
(`package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, or `config.run.lockfile`), or `null`.

### 5.2 Run modes: proving the staged code, not the working folder

Running checks in the working folder can pass on edits that aren't staged and so never
get committed. POCP has two modes:

- **`clean` (default): working-folder consistency.** Before the run, refuse if any tracked
  file differs between the working folder and the index, if any tracked file is marked
  `assume-unchanged` or `skip-worktree` (git would not report its edits), or if there are
  untracked files inside the packet's `touches` or the obligation's `inputs`. After the run, check the
  same thing again: if the command changed tracked files (a formatter, a code generator),
  the proof is thrown away. This is fast and keeps installed dependencies available.
- **`snapshot`.** Export the index to a temporary folder (`git checkout-index -a --prefix=…`),
  make the exported files read-only, link the paths in `config.snapshot.link`
  (for example `node_modules`), and run there. Entries `checkout-index` skips
  (`skip-worktree`, as in sparse checkouts) are written from their blobs. Hash the exported
  files before and after the run; if they differ, the proof is thrown away. Slower, but it
  allows unrelated unstaged work to sit in the working folder. File permissions don't bind
  root; the hash still does.

In both modes the subject hash is computed before the run and checked again after it.
If the index changed during the run, the proof is thrown away.

### 5.3 What a proof does and doesn't show

A proof shows: this command, run by POCP, exited this way, against code whose staged
contents hash to this value, with these runner details.

It does **not** show that the run was hermetic. A command can read files outside
`touches` and `inputs`, environment variables, network services, and installed
dependencies. Neither mode isolates any of those; the runner details and lockfile hash
are there so a result can be interpreted later, not to guarantee it repeats.
`verify --rerun` in a clean CI checkout (§7.2) is the way to get an independent result.

### 5.3a Proof reuse

If another packet already holds a passing proof for the same subject hash and the same
obligation digest, `prove` copies it (`reused_from`) instead of running the command again.

### 5.4 Execution limits

- **Timeout.** Each runnable obligation has a timeout (`timeout_ms`, default 10 minutes).
  On timeout POCP sends SIGTERM to the whole process group, then SIGKILL after 5 seconds,
  and records `timed_out: true` and a failed proof.
- **Process cleanup.** Commands run in their own process group. Every process that stays
  in that group is killed when the command times out, when POCP exits or is interrupted, and,
  through a small watchdog in the group, when POCP itself is killed outright. A process that
  leaves the group (a new session with `setsid`, a daemon that detaches, a service the
  command starts elsewhere) isn't tracked and can outlive the check. A snapshot folder can
  also be left behind when POCP is killed outright.
- **Working directory.** The repo root in clean mode, the snapshot root in snapshot mode.
  `run` cannot set its own working directory outside the repo.
- **Environment.** The command inherits the caller's environment (tests often need it).
  POCP never records environment values. Set `config.run.env: "minimal"` to pass only
  `PATH`, `HOME`, `LANG`, `TMPDIR`, `CI` and names listed in `config.run.env_allow`.
- **Output size.** Logs are capped at 10 MB per run; past that the stream is truncated,
  and both the log and the record note the truncation.
- **Concurrency.** Commands that change packets take a repo lock (`.proof/runs/pocp.lock`,
  holding the process id). Two agents proving at once wait for each other instead of
  overwriting each other's proofs. A lock held by a dead process is broken.
- **Shell.** Commands run with `/bin/sh -c`; POCP needs a POSIX system (macOS, Linux, WSL).
- **Interruption.** If pocp is interrupted (Ctrl-C, SIGTERM, SIGHUP), running checks' process
  groups are killed and temporary snapshots and checkouts are removed before it exits.

### 5.5 Signing

With `sign.key` in `.proof/config.json` (or `POCP_SIGN_KEY`), each proof is signed with
`ssh-keygen -Y sign` (namespace `pocp-proof`) over the canonical JSON of the proof without
its signature. A private key path signs directly; a `.pub` path or `key::<public key>`
signs through ssh-agent. The principal is `sign.principal`, `POCP_SIGN_PRINCIPAL`, or git
`user.email`. Trusted keys are listed in `.proof/allowed_signers` (git's allowed_signers
format). `verify` reports each proof as valid, invalid, unsigned or untrusted; an invalid
signature (the record was edited after signing, or the key isn't allowed) fails verify.
Signing proves who ran a check and that the record wasn't changed afterwards; it is only
as trustworthy as the people whose keys you allow.

## 6. Rules

`.proof/rules.json`:

```json
{
  "pocp": 1,
  "triggers": {
    "broad_files": 10,
    "cross_area": { "areas": 4, "min_files": 8 },
    "globs": [
      { "id": "auth", "glob": "src/auth/**", "require_packet": true }
    ]
  },
  "count_exempt": ["**/*.md", "docs/**", "test/**", "**/*.test.*", "**/package-lock.json", "**/*.png"],
  "requirements": [
    { "id": "billing-tests", "glob": "src/billing/**",
      "obligation": { "kind": "test", "run": "node --test test/billing.test.js" },
      "source": "author" },
    { "id": "m-91c2-rounding", "glob": "src/invoice.js",
      "obligation": { "kind": "test", "run": "node --test test/rounding-regression.test.js" },
      "source": "miss:m-91c2" }
  ]
}
```

- **Globs** (everywhere POCP takes one): `**` matches across folders (`**/` also matches no
  folder), `*` and `?` match within one path segment, a trailing `/` matches everything under
  it, and a pattern without wildcards matches that exact path only. Braces, `[ ]` classes, a
  leading `./`, absolute paths and `..` are invalid policy.
- **Triggers** decide whether a change needs a packet at all. A repo glob with
  `require_packet: false`, and any `count_exempt` glob, exempts matching files from the
  broad and cross-area counts only. The default `count_exempt` covers docs, tests,
  lockfiles, snapshots and images; the default thresholds (10 files, or 8 files across 4
  folders) were calibrated on real repository history, where they asked for a packet on
  6–30% of commits instead of 31–48% when every file counted.
- **Requirements** decide which obligations a packet must include for the files it touches.
  When a packet is opened or its `touches` grow, matching requirements are added automatically.
  A requirement applies when its glob matches one of the packet's literal `touches` **or one
  of the changed files the packet covers**, so a catch-all packet (`"**"`) still gets every
  requirement for the files it actually changes.
  A file that a requirement guards always needs a packet, so a rule can't be skipped by
  committing without one.
- **Policy files.** A change to `.proof/rules.json`, `.proof/config.json` or `.proof/allowed_signers` always needs a
  packet whose `touches` include that file, and the gate names any requirements the change
  removes. Weakening the rules is never silent.
- A host can provide extra rules through the Policy interface (§9), such as risk scores
  or a map from files to tests. Each obligation they add keeps a `source` that says where it came from.

### 6.1 Merging repo rules and host policy

Host policy can only make the gate stricter, never looser:

- **Triggers:** a file needs a packet if a repo rule **or** a host rule says so. A host
  rule's `require_packet: false` is ignored. The broad and cross-area thresholds use
  whichever is lower.
- **Requirements:** the union of both. Two requirements with the same obligation digest
  count once. A host can't remove, replace or relax a repo requirement.
- **Recorded origin:** host-added requirements carry `source: "host:<name>"`.
- **Policy digest:** computed over the merged requirements that apply to the packet's
  `touches`, sorted by obligation digest. Host policy is part of it, so if host rules
  change, packets are re-checked against them.

### 6.2 Test guard

A check can be hollowed out without touching its command: gut the assertions in an
existing test, add `.skip`, or change `"test": "…"` in `package.json` to `echo ok`. POCP
treats these changes as guarded:

- existing test files modified, deleted or renamed (added test files are fine). The default
  test patterns cover the common layouts of JavaScript/TypeScript (`test/`, `spec/`,
  `__tests__/`, `*.test.*`, `*.spec.*`, `*_spec.*`, snapshots, `__mocks__/`), Python
  (`tests/`, `test_*.py`, `*_test.py`), Ruby (`spec/`, `*_spec.rb`, `*_test.rb`), Go
  (`*_test.go`, `testdata/`), Rust (`tests/`), Java/Kotlin/Scala (`src/test/`,
  `src/androidTest/` and the other `src/*Test/` source sets, `*Test.java`, `*IT.java`), C#
  (`*Tests.cs`, `*.Tests/`) and PHP (`*Test.php`), at the root or inside a package. `pocp init`
  writes test folders it finds declared elsewhere (pytest `testpaths`, jest `roots`, rspec
  `--default-path`, phpunit test suites, Maven `testSourceDirectory`, Cargo `[[test]]`) to
  `guard.extra_test_globs`;
- the `#[cfg(test)]` items at the top level of a Rust file (usually `mod tests { … }`): only
  that part of the file is compared and, in the mechanical check, restored, so the code beside
  it stays new. A file declared as `#[cfg(test)] mod name;` is test code as a whole. Not seen:
  a `#[cfg(test)]` item nested inside another module, and `#[test]` functions outside one;
- test helpers: files the tests import, followed transitively (up to 6 imports deep and 5,000
  files read per revision), when they aren't the code the required checks guard. A helper
  whose assertion can't fail hollows every test that calls it, so changing one is a test
  change and the mechanical check runs the old helper with the old tests on the new code.
  Imports are read without running anything: relative JavaScript/TypeScript imports, Python
  imports, Ruby `require`/`require_relative`, Go imports within the module, Java/Kotlin/Scala
  imports, PHP `require`/`include` and shell `source`. A file a required check guards (by
  the rules in force or the base's rules) counts as code (not a helper) unless it looks like test support (a `testing/`, `test-utils/`,
  `testkit`, `mocks/` path, or a test-framework or assertion-library import such as `node:assert`,
  `chai`, `should`, `power-assert`, `uvu/assert`, `pytest`, `unittest`) or is used as it: at the
  base, a test imports it directly next to other guarded code, no test file is named after it,
  and it imports no guarded code. A file used as test support is restored like a helper but
  stays where mutants are planted, since that reading of the imports can mistake a module under
  test for one. A file the code under check imports at the base counts as code in every case.
  With no required check, only files that look like test support are helpers.
  Not followed: build-tool aliases (tsconfig `paths`), C# namespaces, Rust `use`;
- test-runner configuration (`jest.config.*`, `vitest.config.*`, `vite.config.*`, `.mocharc*`,
  `pytest.ini`, `conftest.py`, `.npmrc`, …);
- the test settings inside files that also hold other things: the `scripts`, `jest`, `mocha`,
  `ava`, `nyc`, `c8` and `tap` keys of `package.json`, the `[tool.pytest…]` sections of
  `pyproject.toml` and the `[tool:pytest]` section of `setup.cfg`. Other changes in those
  files (a dependency bump) are not test changes;
- files the test setup points to, at the base or after the change: files a runner config names
  under a setup key (`setupFiles`, `setupFilesAfterEnv`, `globalSetup`, `globalTeardown`,
  `require`, `testEnvironment`, `reporters`, …), and tracked files a required check's command
  names (`node --import ./setup.mjs`, `bash scripts/check.sh`), following the package scripts
  it runs (`npm test` → `scripts.test`, with `pretest`/`posttest`). A file the requirement
  itself guards is what the check checks (`node --check src/a.js`), not setup, unless the
  command executes it (the program of a command, the first file after an interpreter such as
  `node` or `python`, every file after a test runner such as `pytest`, `rspec` or
  `node --test`) or it matches a test pattern. A runner config's imports are not followed.

Defaults cover common JavaScript, Python, Ruby, Rust, PHP, JVM and .NET harness files. `guard.test_globs` and
`guard.runner_globs` replace the defaults; `guard.extra_test_globs` and
`guard.extra_runner_globs` add to them, for harnesses POCP can't know about (a Makefile
target, a Gradle task, a custom script). Added, modified, deleted and renamed runner files
are all guarded; for test files, only added ones are free.

Guarded files always need a packet. With `guard.tests` set to `"block"` (default) or
`"attest"`, a packet that covers them gains a `guard` obligation (`source: "guard:tests"`)
naming the guarded files, the mutant budget and the seed. Its digest covers those three, so a
different set of changed tests, a smaller budget or another seed is a different obligation.
When the change moves on, a stale guard obligation is replaced (required obligations from
rules are never removed). With `"warn"` the change is only reported. The gate and CI also
report heuristic signals per file: assertions removed and skips/onlys added.

**The mechanical check.** `pocp prove` runs the guard obligation itself; nothing is
attested. The checks it runs are the packet's required checks from the rules in force (so a
change can't pick its own); only when no rule requires one does it use the packet's own
runnable obligations. Every run below is in its own fresh copy of the code.

1. **Old tests on the new code.** In a copy of the staged code, the changed test files and
   runner config are put back as they were at the base (`HEAD`; in CI, the commit's parent)
   and the checks run. A renamed test counts as the old file deleted and the new one added:
   the old file comes back and the new one stays. An added runner file is removed. For
   `package.json`, only `scripts` goes back. The checks must also pass on the new code as is.
   If the old tests fail on the new code, the checks that failed are run once more on the
   base itself. If any of them passes there, and every old-test run that failed on the new
   code ran to the end, the change altered behavior the old tests pinned down
   (`behavior-changed`). If one of those runs on the new code didn't finish normally (a
   timeout, a signal, a spawn error, exit 126 or 127), the result is `inconclusive`
   instead: a run that didn't finish says nothing about behavior. If they all run to the end and fail there too, the
   tests were already failing before the change, so the failure says nothing about it
   (`baseline-red`). If a base run doesn't finish normally (a timeout, a signal, a spawn
   error, exit 126 or 127), the result is `inconclusive`. In every case, only a person can
   accept it.
2. **Detection can't drop.** Small mutants (§11.2's operators) are planted in source files
   guarded by those checks' requirements, never in tests or runner config. Sites on lines
   the change touched, and in files the changed tests import, come first; other guarded sites
   fill the rest of the budget (`guard.mutants`, default 10). The sample is drawn with
   `guard.seed` (default 1), so the same code always gets the same sample (in CI, a seed derived
   from it and the range; see *The seed in CI*). Each mutant runs
   with the old tests (checks fastest first, stopping at the first that catches it); each
   mutant the old tests catch then runs with the new tests. Every mutant the old tests catch,
   the new tests must catch too (which implies they catch at least as many). Otherwise the
   result is `detection-dropped`, with the lost mutants listed. With `guard.mutants: 0`
   (fast mode, which `pocp init` writes for new projects; `pocp init --deep` writes 10) this
   part is replaced by a structural review: the change passes only if every guarded change
   is an existing test file modified by adding lines, none of which matches a list of risky
   text patterns (skipping or focusing tests, exiting, a bare early return, reassigning or
   patching an assertion object or a prototype, the common mocking and stubbing APIs,
   exit-code resets and exit handlers, test hooks and fixtures, assignments to `globalThis`
   or `global`, an empty `catch`), matched on each added line and on the file's added lines
   joined. Anything else (changed or removed test lines, deleted or renamed tests, helpers,
   runner config, test settings) is `needs-review`: a person decides. The patterns are a
   heuristic; fast mode doesn't judge what an edit means. The built-in default stays 10, so a
   config without `guard.mutants` (any project set up before fast mode) keeps deep mode.

   **Only a normal failure catches a mutant.** A check catches a mutant only if it ran to
   the end and failed: the same rule as for base runs in part 1. A run that timed out, was
   killed by a signal, couldn't start, or exited 126 or 127 says nothing about whether the
   tests catch the mutant (under load, a full suite hits the timeout either way). Such a run
   is retried once, in a fresh copy with the mutant: with 3× the time limit it hit if it
   timed out, otherwise with the same limit. POCP has no ceiling on check timeouts
   (`run.timeout_ms` is the default a check's own `timeout_ms` overrides), so the retry
   limit isn't capped; it costs at most one extra run per unfinished check and mutant, and
   none when every run finishes. Worst case, every sampled mutant hangs every check: up to
   4× each check's limit per mutant on a side (the run plus the 3× retry), spread over the
   parallel jobs; with the defaults (10 mutants, a 10-minute limit, one check, 4 jobs) about
   100 minutes of wall time before the result is `inconclusive`. Only mutant runs are
   retried: the baselines in part 1 are not (a baseline that doesn't finish blocks the
   result). A retry that ends normally counts as the run. After a run
   that still didn't finish, the remaining checks still run. The mutant is caught if any
   check fails normally, missed if every check passes, and otherwise *not measured* on that
   side, recorded with each unfinished check and why (`not_measured: { side, checks: [{
   check, reason }] }`, `retried: [{ side, check, first, timeout_ms, retry }]`, and in
   `detection`: `old_not_measured`, `new_not_measured`, `not_measured`). When every run ends
   normally nothing is retried, this is the same as stopping at the first failure, and the
   result is unchanged.

   A mutant that isn't measured, on either side, means the result can't be `passed`: it is
   `inconclusive`, and the summary names the mutant, so a person decides (or the check is
   proved again with `--force` once it can finish). A pass rests on evidence that every
   sampled mutant the old tests catch, the new tests catch too.
   - *Old side:* the old tests may hang on the mutant for real (an infinite loop it causes,
     which is how they "catch" it) or the machine was too loaded; the guard can't tell which.
     Counting it as caught would let load raise the bar for the new tests; counting it as not
     caught would let a change delete the only test that hangs on it. The mutant doesn't run
     on the new side.
   - *New side:* the old tests caught the mutant normally and the new tests' run didn't
     finish, so whether detection dropped is unknown.
   - A mutant the new tests measurably miss is a drop on its own, so `detection-dropped`
     takes precedence; if no measured mutant is caught by the old tests, the result is the
     usual `inconclusive`.

   This only turns a timed-out "catch" into no evidence, and no evidence never passes, so no
   former block becomes a pass.

The result is `passed`, `behavior-changed`, `baseline-red`, `detection-dropped`, `needs-review` (fast
mode only: the edit does more than add non-risky lines) or `inconclusive` (the checks
fail on the new code, the old tests didn't finish on the new code, no check covers the tests, no guarded source to mutate, the old tests
caught none of the measured sample, so a drop can't be measured, or a sampled mutant couldn't
be measured on either side, even on a retry). It is recorded as a proof
(`kind: "guard"`) for the subject, with both parts: the checks run, each run's exit, the files
restored, the sample (file, line, operator, line before and after) and each mutant's outcome
on both sides. It is signed like any proof when signing is on. A recorded result stands for
its subject until the code changes or `prove --force`.

**When a person is needed.** A passing check is proof: no sign-off is needed. Anything else
leaves the obligation needing an attestation (`pocp attest`), which is weaker, labelled
`attested:<who>`, and reported by `verify` with what the check found. In `"block"` mode (the
default), `verify` also fails (`test_change`) unless each guarded file is covered by a passing
mechanical check that is independent of the author: re-run by this `verify`, or a proof signed
by a trusted key, using checks a rule requires (not ones the packet chose). A local, unsigned
pass isn't enough. `--accept-test-change` overrides it when the check ran to the end,
and is meant for a maintainer when behavior changed on purpose; a check that didn't finish
needs `--accept-inconclusive` (`test_inconclusive`) or a re-run. In `"attest"` mode the
sign-off is enough for `verify`; since anyone can give it, including the author, choosing
`"attest"` over the default is a policy loosening (§7.2).

**Handing it to CI (block mode).** Since in `"block"` mode no sign-off from the author can
settle a failed check, the author doesn't give one. `pocp fix` records a *deferral* in the
packet instead: `deferrals[]` entries `{ obligation, obligation_digest, subject, by, at,
to: "ci-approval", reason }`, bound to the subject like an attestation. With a current
deferral, the gate and `verify` don't wait on an attestation for that guard obligation (it
is listed under `awaiting_approval`); verify's block-mode check above alone decides. A
deferral is not an approval and is ignored outside block mode; a guard that never ran is
still unproven.

**Cost.** The check runs only when guarded files change, and never twice for the same code.
Its "new tests on the new code" baseline is the packet's own passing proof of the same check
for this subject when there is one. `prove` keeps results in `.proof/runs/guard-cache/`,
keyed by the subject, base, guarded changes, checks, source globs, budget and seed, so
another packet over the same change reuses it; `--force` runs it again. `verify` never reads
that cache: in CI, the baseline reuses a passing re-run by the same `verify` or a `ci-run`
result for the same commit, subject and command (never one with `expect`), and the range's
head re-run reuses the baseline the guard ran on the head commit. The net change's check (§7.2) reuses
the head re-run as its new-code baseline.

**In CI.** `verify --rerun` (and `--rerun-unsigned`, for unsigned guard proofs) runs the
check again from the commit and its parent alone, with the policy in force (§7.2), so its
budget and seed can't be loosened by the change. For a range, it runs per commit with a test
change, and once on the range's net change (§7.2): old tests and test setup from the merge
base, new code and tests from the head, merges included. Judging each commit alone would let
a change split "drop an assertion" (code unchanged, so the guard passes) from "add the bug the
assertion caught" (no test changed, so no guard), or hide either in a merge commit. A re-run
that fails where the packet claimed a pass is `rerun_failed`.

**The seed in CI.** For checks that judge a pull request (the net change, or the single
commit of a one-commit range), verify doesn't use `guard.seed` as is: it derives the seed
from `guard.seed`, the merge base and the head (the first 8 hex digits of
`sha256("pocp-guard-seed\0<seed>\0<base>\0<head>")`, masked to 31 bits). A sample fixed in advance (`guard.seed` alone) lets an agent looping locally
learn exactly which mutants it must keep catching; the derived seed is not the one `prove`
used, and it changes with every new head. It is still a pure function of the range, so a
verify re-run on the same range draws the same sample, and the seed is recorded (`net.seed`,
`detection.seed`, and in the re-run's name). It is not secret: an author who knows the base
can compute it for a candidate head, and could try heads until the sample misses what the
change weakened, paying a full guard run per try. Part 1 (old tests on the new code) doesn't
depend on the seed at all.

Packets made before this check carry a free-text `manual` sign-off instead. `verify` still
accepts it for those commits, as an attestation, and says so.

Lowering `guard.mutants` or changing `guard.seed` is a policy loosening (§7.2): a smaller
sample catches less, and a new seed would let a change pick a sample it passes.

## 7. The gate

`pocp gate` runs at commit time (pre-commit hook, agent hook, or by hand).

1. Read the staged changes (`git diff --cached --name-status -M` against `HEAD`, or the
   empty tree before the first commit) and compute the subject hash.
   - **Added and modified** files count by their path.
   - **Deleted** files count by their old path: deleting a protected file needs a packet too.
   - **Renamed** files count by **both** paths, so moving a file out of a protected folder
     can't skip its rules.
2. Apply the merged triggers (§6.1). If none fire, pass.
3. For each file that needs coverage, find the active packets whose `touches` include it.
   Files with no packet at all are reported, with a suggested packet.
4. For each covering packet, work out the required obligations **from the current rules**,
   not from what the packet file says. Any required obligation missing from the packet
   blocks the commit. Then each runnable obligation needs a passing proof whose subject
   hash is **this** one and whose obligation digest matches the obligation as written now.
   Each manual obligation needs an attestation.
5. Each covering packet's file must be staged and match the working copy, so its proofs
   ship in the commit. `pocp prove` and `pocp attest` stage it automatically.
6. Every file that needs coverage must have **at least one** covering packet that passes
   steps 4–5. A covering packet with a **failed** check always blocks, so a failing check
   can't be routed around with a weaker packet. Other covering packets that simply aren't
   proven yet (and drafts) are reported as notes, not blockers.
7. Pass, or fail with a list of reasons.

Invalid `rules.json` is a configuration error (exit 2), never a pass.

**Amends.** Git doesn't tell the pre-commit hook that a commit is an amend, so on
`--amend` the gate only sees changes since the commit being replaced. Trailers use the
right base (the parent), and `verify --require-coverage` checks the full change.

The gate never runs proofs on its own unless given `--prove`, so a commit is never
slowed down by surprise. `pocp gate --prove` runs whatever is missing, then decides.

**Gate log.** Every evaluation appends one JSON line to `.proof/runs/gate.jsonl`
(git-ignored): `{ at, source, decision, subject, required, uncovered, packets: [{ id, ok,
failed }] }`. `source` says who asked: `hook` (the pre-commit hook, which sets
`POCP_GATE_SOURCE=hook`; one line per commit attempt), `gate` (`pocp gate` run any other
way), `fix` (each round of `pocp fix`), or `api` (a library caller of `engine.gate()`).
Lines written before `source` existed have none; readers treat them as unknown. Hooks
installed by an older pocp don't set the variable, so their lines say `gate` until
`pocp hooks install` is run again.

**Existing hooks.** `pocp hooks install` keeps hooks that are already there. A plain sh hook
gets pocp's block appended. A hook pocp can't safely append to (one with a non-shell
shebang such as node or python, where the block would be a syntax error, or one that uses
`exec` or `exit`, where the block might never run) is chained: it moves to
`<hook>.pre-pocp` and pocp installs a hook that runs it first (so formatters see the commit
first; a failure still stops it), then pocp's step. Reinstalling changes nothing, and
`pocp hooks uninstall` moves the original back. Hooks an older pocp appended to such a hook
are reported by `pocp hooks status` and `pocp doctor`, and repaired by `pocp hooks install`.

**Hooks without pocp.** The hooks look for pocp in `POCP_BIN`, then the project's own
`node_modules/.bin/pocp`, then `PATH`, then the pocp that installed them (its absolute path is
written into the hook at install time). If none is found, pre-commit fails closed: it is the gate. prepare-commit-msg and
post-commit also run under `git commit --no-verify`; they print a warning and exit 0, since
they only add trailers and record landings. A commit made that way carries no proof
trailers, and `verify --require-coverage` in CI flags it if it needed coverage.

**Merges.** While a merge is in progress (`MERGE_HEAD`), a staged file that matches a
commit being merged in came from that branch and carries its proofs; the gate judges only
files that differ from `HEAD` and from every merged commit (conflict resolutions and edits
made while merging). Verify doesn't check merge commits one by one; it judges what a merge
adds as part of the range's net change (§7.2).

**Every block explains itself.** The result carries `remedies`, in order, each
`{ code, what, why, next, by }`: `by` is `pocp fix` (a mechanical step), `agent` (the author
changes code or files), or `person` (an approval only a person can give). A passing gate
carries `pending_approvals` for what CI will still need a person for (a block-mode test
change handed to CI, a policy or CI loosening). `pocp fix` takes every `pocp fix` step:
opens a packet for uncovered files (or widens the author's own active packet), syncs
required checks, proves (a snapshot of the staged code when the working folder differs),
stages packet files, and in block mode records a deferral (§6.2). It never attests and never
re-runs a check that already has a result for the same subject.

**Suggestions are never boilerplate.** When a packet is missing, the gate suggests one
whose obligations come only from matching requirements. If no requirement matches, it
says so and asks for at least one runnable obligation. It never invents filler text.

**Output:** readable text by default, `--json` for tools. Exit codes:
`0` pass, `1` blocked, `2` usage or config error, `3` internal error. With `--exit-detail`,
`verify` also tells a wait from a failure: `4` when only a maintainer's approval is missing,
`5` when something didn't finish (a test check or a re-run timed out, was killed or didn't
start), and `1` for anything else, including any mixture with a real failure. A required CI check
(`verify.require_ci`) whose re-run didn't finish is `ci_unfinished`, not `ci_failed`: it blocks
whenever `ci_failed` does, and only a re-run that finishes, or a fix, clears it.

### 7.1 Landing and the commit trailer

A `prepare-commit-msg` hook (or `pocp land`) adds a trailer for each proven packet:

```
Proof-Of-Change: p-7f3a9c21 subject=sha256:4be1c0de9a11 policy=sha256:c71a03be55e2 proven=2/2 attested=1/1
```

**Landed is derived, never written.** A packet is `landed` when a commit reachable from HEAD
carries its trailer and that trailer's subject matches the commit. POCP computes this from git
on every read, so committed packet files keep the state they were proven with, the working
copy stays clean after a commit, every clone agrees, and undoing a commit (reset, revert of
history) makes the packet active again. `pocp land` (run by the post-commit hook) only reports
which packets a commit lands; it writes nothing.

On an amend (message source `commit`), existing `Proof-Of-Change` trailers are removed
before current ones are added, since they describe the code being replaced. Trailers typed
into other messages are left alone; `verify` is what judges them.

The trailer is a pointer, not proof. Anyone can type one.

### 7.2 Verifying a commit (CI)

`pocp verify <rev>` checks a commit without trusting its trailer:

1. The packet each trailer names exists in that commit's `.proof/packets/`.
2. The subject hash recomputed from the commit's tree equals the trailer's and the proofs'.
3. Requirements recomputed from the commit's `rules.json` are all in the packet, and their
   digest equals the packet's `policy_repo`. With a host configured, the merged digest must
   also equal the packet's `policy`. The trailer's `policy` must match the packet's.
4. Every proof's obligation digest matches the obligation in the packet, and every
   runnable obligation has a passing proof for this commit's subject hash.

`pocp verify <base>..<head>` checks every non-merge commit in a range, and then the range
as a whole (below).

**The net change of a range.** A pull request is also judged as one change: its *net
change*, from the merge base of `<base>` and `<head>` to `<head>`, merges included. The test
guard (§6.2) and, with `--require-coverage`, coverage run on it, so splitting a test change
and a code change across commits, or making either inside a merge commit, gives the same
verdict as making them in one commit. The old tests and test setup come from the merge base,
the new code and tests from the head. Starting at the merge base (not `<base>` itself) means
changes the branch took from main by merging it are not the branch's; anything a merge commit
adds beyond its parents (a conflict resolution, an edit made while merging) is. The result is
reported as `net` (shaped like a commit's result, with `kind: "net"`, `base`, `merges`,
`seed`, `test_guard`, `coverage` and `findings`); its findings use the same codes and
`verify.fail_on` as a commit's, and it fails the range like a failing commit. Findings of the
range itself (a re-run at the head that fails, `rerun_failed`; required CI results that can't
be checked, `ci_missing`) are in the range's own `findings`, with `code`, `detail` and
`blocking` like a commit's; `rerun_failures` lists the failed re-runs the same way.

- *Test guard.* Computed by verify itself, like a re-run; nothing in it comes from the
  author, so no proof or signature can stand in for it. In block mode, a net test change
  passes only on this verify's own mechanical re-run (`--rerun` or `--rerun-unsigned`),
  using checks a rule requires for the net change; without a re-run, or when no rule requires
  a check covering the changed tests, it is `test_change` (fails closed).
  `--accept-test-change` accepts it, as for a commit. In attest mode, a re-run that doesn't
  pass needs a current sign-off on a guard obligation naming each changed file, from some
  packet in the range; without `--rerun` it is a warning (attest mode accepts local results).
  In warn mode it is only reported.
- *Coverage.* Files the net change makes required must be covered by some packet in the
  range. Files a commit already reported are not repeated.
- *Merge at the head.* When `<head>` is a merge commit, no per-commit result saw the final
  policy, so the net change is also checked for policy loosening (base against head) and for
  CI definition files that only a merge changed (`ci_config_changed`).
- *One plain commit on the merge base* is its own net change: it is checked once, as a commit,
  and `net` is absent.

verify writes one commit object (the head's tree with the merge base as its only parent) to
the object store to compute this; no ref points to it, and its identity and date are fixed,
so the same range always gives the same object. If that fails, verify fails.

**Policy comes from the base.** A commit is judged by its base's rules (by default its
parent; for a range, the range's base; or `--policy-from <rev>`), combined with the
commit's own rules so that stricter rules still apply immediately ("strict union":
requirements and protected globs unioned, every glob a check guarded in the base still
guarded by a requirement with the same check, lower thresholds, exemptions only if both
sides have them). If the commit loosens the policy (removes or changes a requirement,
drops a glob from a requirement, raises a threshold, removes a protected path, adds an
exemption, or adds a key to `allowed_signers`), verify fails and names each loosening, unless run with
`--accept-policy-change`, which CI should pass only when a maintainer has approved
(for example, a PR label). `--accept-policy-change=<commit>` (and likewise
`--accept-test-change=<commit>`) approves only when the head being verified is that commit. Trusted signers also come from the base, or from
`--allowed-signers <file>`, never from the commit being judged.

**Re-running.** With `--rerun`, every runnable obligation runs again, each in its own fresh
copy of the commit's files with no `.git`, and so does each `verify.require_ci` command that
no obligation covered.
With `--rerun-unsigned`, obligations whose current proof is validly signed by a trusted
signer (§5.5) are not re-run. With `--ci-results <file>`, a check is also skipped when the
file holds a passing `ci-result` record (written by `pocp ci-run`, §7.3) whose subject hash
equals the commit being re-run and whose command equals the obligation's `run`; checks
with `expect` are always re-run. Such a record is only as trustworthy as everything that ran
in the job before verify, including the change's own tests, which can write the file. For a
range, digests, coverage and signatures are checked per commit (nothing runs), and re-runs
happen **once**, at the head of the range (the range's right side, even when it is a merge
commit), for the union of checks across the range plus the checks the rules require for the
net change. When the head is a merge commit, no signature covers its code, so
`--rerun-unsigned` re-runs everything there. The test guard re-runs per commit with a test
change, and once more on the net change. Only a re-run, or a proof signed by someone you
trust, counts as an independent result.

**Fails closed.** If `rules.json` or `config.json` at the commit or at its base doesn't
parse, or doesn't validate (§6, `validateConfig`), verify fails and names each problem.
The gate does the same for the working copy (exit 2).

**Approvals are separate.** `--accept-policy-change` accepts loosened rules or signers;
`--accept-test-change` accepts changed existing tests in block mode when the mechanical check (§6.2) ran to the end and does not pass independently;
`--accept-inconclusive` accepts changed existing tests whose mechanical check didn't finish (a
run timed out, was killed or didn't start: finding `test_inconclusive`, which blocks whenever
`test_change` does). A person approving a test change hasn't seen whether the code hangs, so
`--accept-test-change` doesn't cover an unfinished check; a re-run that finishes, or a fix,
clears it too. A plain re-run that didn't finish is never cleared by a label, only by a re-run
or a fix. None of these implies another.

**Findings and what fails.** Every problem verify reports is a finding with a stable code:
`policy_loosened`, `ci_config_changed`, `test_change`, `uncovered`, `missing_packet`,
`trailer_mismatch`, `policy_mismatch`, `missing_required`, `unproven`, `failed_proof`,
`unattested`, `invalid_signature`, `rerun_failed`, `ci_missing`, `ci_failed`, and
`invalid_policy`. The repository's `verify.fail_on` (config) lists which codes fail
verification; the others are reported as warnings, never dropped. The default is every
code. `invalid_policy` always fails. `verify.fail_on` is read from the policy in force (the
base, strictly combined with the commit), so narrowing it is itself a loosening.

**Required CI results.** `verify.require_ci` lists commands that need a passing result for
the exact subject being verified: the latest `ci-result` (§7.3) for that command, or a passing
re-run of the same command by this verify. It fails closed: with neither, every required
command is `ci_missing`. For a range it is checked at the head only (for the head's subject, also
when the head is a merge commit), where CI ran, after the range's re-runs. A latest result that failed is `ci_failed`.

**CI definitions.** Files matching `ci.files` (default: GitHub workflows and actions, GitLab,
CircleCI, Jenkins, Azure, Bitbucket, Buildkite, Drone, Woodpecker) can switch POCP off in CI.
Changing them needs a packet at the gate and, in verify, is `ci_config_changed` unless run
with `--accept-policy-change`. Removing a glob from `ci.files` is a loosening.

**Loosening the config** (also a policy change): dropping codes from `verify.fail_on` or
commands from `verify.require_ci`, lowering `guard.tests` (block > attest > warn > off),
dropping any glob the test guard uses (whether set by `test_globs`/`runner_globs`, their
defaults, or `extra_*`), lowering `area_depth`, changing `run.env` from `minimal` or adding
names to `run.env_allow`, removing globs from `ci.files`, dropping checks from
`ci.required_checks`, turning off `ci.require_pull_request` or `ci.enforce_admins`, or
changing `ci.branch`, lowering `guard.mutants` or changing `guard.seed`. Until approved, the
base's stricter values stay in force.

**Evidence labels.** Each packet in the result lists, per obligation, what establishes it:
`rerun` (run again by this verify), `ci-result` (§7.3), `signed:<principal>`, `local`
(unsigned, not re-run) or `attested:<who>`. The test guard's obligation (§6.2) is
`mechanical:rerun`, `mechanical:signed:<principal>` or `mechanical:local` when its mechanical
check passed, `mechanical:rerun-failed` when this verify's re-run failed, and
`attested:<who>` when a sign-off stood in. See docs/THREAT-MODEL.md.

**Reporting.** On GitHub Actions, verify writes a results table to the job summary and
`::error` annotations for each failing commit.

**Untrusted changes.** Obligations are commands taken from the repo. Run `verify --rerun`
on a pull request only where you'd already run that pull request's own tests: no secrets,
limited permissions, the same isolation as your normal CI for outside contributors.

### 7.3 CI results

`pocp ci-run [--results <file>] -- <command…>` runs a command in CI against HEAD, refusing
if the working folder differs from HEAD (or files are flagged as in §5.2), and appends a
record to the results file (default `.proof/runs/ci-results.jsonl`). A single argument is
the command line as written; several are joined with shell quoting where needed, so
`-- sh -c "make test"` runs and records `sh -c 'make test'`.

```json
{ "pocp": 1, "kind": "ci-result", "commit": "…", "subject": "sha256:…", "run": "npm test",
  "exit": 0, "passed": true, "duration_ms": 41230, "stdout_sha256": "…", "runner": { … },
  "ci": { "GITHUB_RUN_ID": "…" } }
```

It exits with the command's exit code, so it can replace a CI test step. The record is a
statement by the CI job that ran it: it is as trustworthy as that job, and it only counts
for the exact subject and command it names. `verify` therefore refuses a results file that
is tracked in the repository, uses the latest record per command, and, when it runs inside a
CI run (`GITHUB_RUN_ID` and `GITHUB_RUN_ATTEMPT`, `CI_PIPELINE_ID`, `BUILDKITE_BUILD_ID`),
ignores records from another run.

### 7.4 Required checks for merging

Which CI checks must pass before a change can merge is part of the repository's versioned
config, not a setting someone clicks:

```json
"ci": { "branch": "main", "required_checks": ["verify", "tests"], "require_pull_request": true, "enforce_admins": true }
```

POCP never changes a host's merge settings on its own. Its normal job is to report proof
status and fail its check according to the repository's policy; `pocp ci required --apply`
is the only command that writes branch protection, and only when run explicitly. No other
command, hook or adapter (including the GitHub Action) contacts the host's settings.

`pocp ci required` prints the plan. `pocp ci required --apply` applies it as GitHub branch
protection through the `gh` CLI. It never loosens a branch:

- it refuses an empty `required_checks` list, before contacting GitHub;
- it reads the current protection first, and stops if it can't;
- required checks are added to those already required, never removed (checks set elsewhere
  are reported);
- protections POCP doesn't manage (review counts, code owners, dismissal and push
  restrictions, linear history, conversation resolution, force-push and deletion settings,
  locks) are written back unchanged;
- `enforce_admins` and required pull requests are only ever turned on.
- the payload sends both `contexts` (required by GitHub's published schema, though deprecated)
  and `checks` (which keeps app ids), naming the same checks. Tests validate payloads against
  that schema (`test/fixtures/github-branch-protection-put.schema.json`). The live write path
  has not yet been exercised against GitHub; private repositories on free plans can't use
  branch protection.

If protection can't be applied, `--apply` exits 1, says the branch is unchanged, and lists
the checks and pull-request requirement to configure by hand.

**Verification and merge enforcement are separate.** Verification (`pocp verify` in CI) works
on any plan and any host. Blocking the merge button on a failed check is the host's feature:
on GitHub it needs a public repository or a paid plan for private ones. Without it, POCP's
check still fails visibly; it just isn't enforced by the platform.

Other hosts configure the same list in their own settings. POCP doesn't require any
particular CI system or test matrix.

## 8. Misses and the ratchet

### 8.1 Recording a miss

```json
{
  "pocp": 1,
  "id": "m-91c2",
  "description": "Invoice totals off by one cent on mixed currencies",
  "stage": "production",
  "found_at": "2026-10-27T09:12:00Z",
  "severity": "high",
  "failing_check": "node --test test/rounding-regression.test.js",
  "files": ["src/invoice.js"],
  "packets": ["p-7f3a9c21"],
  "state": "open"
}
```

- `stage` is one of `gate`, `commit`, `ci`, `review`, `production`. It is never a timestamp;
  `severity` is one of `low`, `medium`, `high`, `critical`;
  `found_at` holds the time.
- `packets` is filled in automatically: POCP reads commit trailers in `git log` for the
  miss's `files` and links the packets that last changed them. `pocp blame <file>` shows the same link.

### 8.2 Closing a miss (the ratchet)

`pocp miss close <id>` succeeds only if:

1. `rules.json` now contains at least one requirement with `source: "miss:<id>"`;
2. its glob matches at least one of the miss's `files`; and
3. its obligation is runnable (not `manual`).

This shows a runnable rule now guards those files. It does **not** show the rule
detects the bug: a matching glob and a command that exits 0 can be useless.
A miss closed this way is recorded as `closed: "rule-added"`.

**Replay check.** `pocp miss close --replay <escaped-rev>` runs the new rule's checks on
a snapshot of the staged code twice:

1. as staged (the fix): every check must **pass**;
2. with only the miss's `files` rolled back to their contents at the escaped commit:
   some check must **fail**.

Rolling back only the miss's files keeps the new check (often a new test file) present
in both runs, so a failure means the check detects the old code, not that the check was
missing. If the miss's files are identical at both points, there's nothing to replay and
the miss can't be confirmed. Only then is the miss recorded as `closed: "replay-confirmed"`.
Only replay or mutation evaluation (§11.2) supports saying a rule "would have caught" a bug.

## 9. Library interfaces

The core is pure: packets, proofs, rules, the gate decision, misses, metrics. Four
interfaces connect it to the outside. Each has a default implementation, and a host can
replace any of them.

```js
// Store: where packets, misses and rules live. Default: the .proof/ folder.
{ kind, readConfig(), readRules(), readRawRules(), readPackets(), readPacket(id), writePacket(p),
  readMisses(), readMiss(id), writeMiss(m),
  // optional; the fs store has them all:
  packetRelPath(id), runsDir(), appendLog(name, entry), readLog(name), lock(name, fn), lockAsync(name, fn) }

// Runner: how a command runs. Default: /bin/sh -c in its own process group. Clean or
// snapshot mode decides `cwd`; the runner only executes.
{ run(command, { cwd, env, timeoutMs, killGraceMs, logFile, logCapBytes })
    → { exit, signal, timed_out, error, duration_ms, output, truncated, stdout_sha256, stderr_sha256 } }

// Policy: extra rules from the host. Default: none.
{ requirementsFor(files, ctx) → Requirement[], triggersFor(files, ctx) → Trigger[] }

// Events: lifecycle notifications. Default: none.
{ emit(type, payload) }   // packet.opened, proof.recorded, gate.blocked, packet.landed, miss.recorded, miss.closed…
```

The clock and ID generator are plain options (`now`, `newId`) so tests stay deterministic.

`verify` reads policy and packets for a commit from git directly, not through the Store, and a
Store whose `kind` isn't `fs` skips the gate's "packet file is staged" check.

**Host modules.** The CLI loads a host from `POCP_HOST=<module>` (or `--host`; `--no-host`
disables it). The module's default export may provide `name`, `requirementsFor`,
`triggersFor` and `emit`. Nothing about the host is written to the repo except the
`source: "host:<name>"` on obligations it added.

## 10. CLI

```
pocp init [--hooks]               create .proof/ (and install git hooks with --hooks)
pocp hooks install|uninstall|status  manage the git hooks; status reports a hook git would skip
                                  (missing or not executable). Refuses a shared core.hooksPath without --force
pocp rules check                  validate rules.json
pocp open --intent … --touch …    open a packet (adds required obligations; --draft)
pocp add <packet> --test "…"      add an obligation (also --command, --probe, --manual)
pocp widen <packet> --touch …     cover more files (re-applies requirements)
pocp ready <packet>               draft → open
pocp sync [<packet>…]             add obligations the current rules require
pocp abandon <packet> --reason …  close without landing
pocp show <packet> / pocp packets [--all]
pocp check-edit <file>…           for pre-edit hooks: does editing these need a packet first?
pocp trailer [<msg-file> [<src>]] add trailers (prepare-commit-msg); prints them with no file
pocp prove [<packet>]             run outstanding obligations for the current subject
                                  (exit 1 only if a check failed or a run was discarded)
pocp attest <packet> <obl> --by … record a manual attestation
pocp status [--json]              open packets, proof state, uncovered files
pocp gate [--prove] [--json]      the commit-time decision, with remedies (§7)
pocp fix [--intent …] [--test …]  take the gate's mechanical remedies; report what needs whom (§7)
pocp doctor [--base <rev>] [--offline]  read-only adoption checks (hooks, workflow, labels,
                                  Action access, branch protection, adoption PR scope)
pocp land                         report which packets a commit lands (writes nothing)
pocp miss record …                record a miss
pocp miss close <id> [--replay <rev>]  close a miss (ratchet enforced)
pocp blame <file>                 packets that changed a file
pocp ci-run [--results <file>] [--dir <folder>] -- <command…>     CI result bound to HEAD (§7.3)
pocp ci required [--apply]                                         required merge checks (§7.4)
pocp verify <rev>|<a>..<b> [--rerun|--rerun-unsigned] [--ci-results <file>]…
            [--require-coverage] [--policy-from <rev>] [--accept-policy-change]
            [--accept-test-change] [--accept-inconclusive] [--exit-detail]
            [--allowed-signers <file>]                                  CI checks (§7.2)
pocp metrics [--json]             see §11
pocp eval --mutants <n|all> [--jobs <n>] [--seed <n>] [--missed] [--save <file>]   see §11.2
pocp eval --replay <file> [--missed]                                 see §11.2
pocp history [--commits <n>] [--test "<cmd {tests}>"] [--fixes <n>]  see §11.3
```

Every command supports `--json`. All output that tools read is stable and versioned (`"pocp": 1`).

## 11. Measuring whether it works

### 11.1 Metrics

| Metric | Definition |
|---|---|
| **Catch rate** | caught ÷ (caught + escaped). *Caught*: landed packets that recorded a failed proof before landing, plus misses recorded at stage `gate`. *Escaped*: misses recorded at any later stage. |
| **Escape rate** | misses per 100 landed packets |
| **Proven share** | runnable obligations ÷ all obligations, across landed packets |
| **Friction** | gate blocks (with every file covered) whose subject later passed the gate unchanged with no failed proof in between, ÷ all gate blocks. Read from the local gate log (`.proof/runs/gate.jsonl`, §7); `gate.by_source` splits evaluations and blocks by `source`, with `hook` lines being commit attempts. |
| **Cost** | median total proof time per landed packet |
| **Ratchet growth** | rules with `source: miss:*` over time, reported apart as `rule-added` and `replay-confirmed` |

Expired and abandoned packets are reported, never counted as completed.

### 11.2 Mutation evaluation

`pocp eval --mutants <n|all>` makes small, known-bad edits (flip a comparison, swap an
operator, change a constant) in source files guarded by requirements, one at a time, and
checks whether those files' required checks catch each one. The result is a measured
catch rate rather than one inferred from history.

- Every check must pass on the unmodified code first, or the run stops.
- Test files are never mutated (`eval.exclude`); breaking a test only proves the test broke.
- Each mutant runs in its own fresh snapshot of the staged code, in parallel (`--jobs`,
  default one fewer than the CPU count); the baseline runs once, one check at a time. Nothing
  one check leaves behind can affect another mutant, and the working folder is never touched.
- `--save <file>` writes the exact sample (file, original line, mutated line) and every
  outcome. `--replay <file>` re-runs that sample on the current code (`--missed`: only its
  survivors); a mutant whose original line no longer exists is reported as gone, not scored.
- Checks run fastest-first, so a quick unit test can catch a mutant before a slow suite starts.
- Only a check that ran to the end and failed catches a mutant (as in the test guard, §6.2).
  After one that timed out, was killed, couldn't start or exited 126/127, the remaining checks
  still run. If none fails normally, the mutant is *not measured*: `outcome` is `timeout` (a
  check timed out) or `error`, `caught` is `null`, and `not_measured` lists the checks and
  why. Not-measured mutants count neither way: `total` is caught + missed, `catch_rate` is
  caught ÷ (caught + missed), and `not_measured`, `timeouts` and `errors` are reported beside
  it, in the output and the saved sample. `--replay --missed` re-runs them with the survivors.
- `--missed` lists only the survivors, with the original and mutated line.

### 11.3 History

`pocp history` gives numbers on day one, from git history alone, with no `.proof/` needed:

- **Gate replay:** how many of the last N commits the current rules would have asked a
  packet for, and why.
- **Fix replay** (`--test "<command>"`, where `{tests}` becomes the fix's test files):
  for past commits that look like bug fixes and changed both tests and code, run the
  fix's tests on the fix (should pass), then with only the code rolled back to the
  parent (should fail). `confirmed` means the test that came with the fix catches the
  bug it fixed, which is what a replay-confirmed miss is. Each replay runs in a
  temporary checkout that is removed afterwards.

## 12. Integrations

All are thin wrappers around `pocp gate --json` and friends.

- **Git hooks:** `pre-commit` (gate), `prepare-commit-msg` (trailer), `post-commit` (land).
- **Coding agents:** any harness with pre-edit or pre-commit hooks calls `pocp gate --json`
  and shows the reasons to the agent. A pre-edit hook can require a packet before files
  matching `triggers.globs` are edited. Examples are provided for common harnesses.
- **CI:** `pocp verify base..head --require-coverage --rerun` checks every commit in a pull
  request against the base policy and re-runs every check at the head. A faster, trusting
  mode wraps the test step in `pocp ci-run --results ci.jsonl -- <command>` and adds
  `--ci-results ci.jsonl`; it trusts everything that ran earlier in the job, which includes
  the pull request's tests.

## 13. Trust and security

- Obligations are shell commands from the repo, the same trust level as the repo's own
  test scripts. Running limits are in §5.4; CI guidance for untrusted changes is in §7.2.
- Proofs aren't hermetic (§5.3). They record what ran and against what, not that
  nothing else influenced the result.
- A trailer can be typed by hand, and so can a packet file. `verify` catches mismatched
  digests; `verify --rerun` gives an independent result; signed proofs (§5.5) tell you
  who ran a check and that the record wasn't edited since.
- A change can't loosen the rules or the trust root it is judged by (§7.2), and can't
  hollow out an existing test unnoticed (§6.2): the old tests must still pass on the new
  code, and the new tests must catch every sampled mutant the old ones caught. Neither
  defence catches a brand-new test that asserts nothing; mutation evaluation (§11.2) is how
  weak checks show up.
- Committed records hold hashes, never raw output or environment values. POCP never uploads anything.

## 14. Non-goals

- Not a test framework: it runs your tests, it doesn't define them.
- Not a CI system: it adds a gate and a verify step to whatever CI you have.
- Not code review: a packet records intent and proof, not approval.

## 15. Open questions

1. Should `snapshot` become the default once linking dependency folders is reliable?
2. Monorepos: per-package `.proof/` folders, or one root folder with package-scoped rules?
3. Should edits outside a packet's `touches` during a session widen it automatically
   (today `pocp widen` does it explicitly, re-applies requirements and logs it)?
4. Signed proofs from trusted CI runners (git SSH signing) so a CI result can stand in for a rerun.
5. Windows support without a POSIX shell.
