// Characterization goldens: what POCP prints and returns today, on fixed scenarios, so a
// restructuring step can show it changed nothing. Each case builds a repository, runs the
// commands CI and the hooks run, and compares the normalized result with test/golden/<case>.json.
//
// A structural change must leave every golden identical. A deliberate behavior change
// regenerates only the goldens it means to change, with UPDATE_GOLDEN=1, and the diff is
// reviewed like code. These show sameness, not correctness: security-invariants.test.js checks
// that the behavior is acceptable.
//
// Only the values listed in `normalize` are rewritten (each is volatile by nature: commit ids,
// random record ids, clock times, measured durations, temp paths, the guard seed). Everything else
// must match exactly, including configured timeouts and content digests.
//
// What these pin, and what they don't:
// - Human output is captured for `verify` (proven-commit, missing-packet) and `gate`
//   (failed-proof-local); every other run is `--json`. Help text, CI annotations and the
//   workflow contract are pinned by e2e-cli, cli-args, adopter-workflows and the workflow tests.
// - Exit codes are captured for every run, with `--exit-detail` on verify. The detailed exits
//   (4 approval required, 5 unfinished) are also asserted by e2e-verify-exit-detail and
//   e2e-verify-ci-unfinished; signature unavailable by sign-unavailable.
// - No golden depends on mutant sampling: the deep-mode case stops at "the old tests fail on the
//   new code", before any mutant is planted (old-tests regression coverage). `runCase` refuses
//   a capture that reached sampling, because its seed comes from commit ids that vary. Mutant
//   detection is covered by the guard and security-bypasses tests.
// - Verify runs with the shipped CI flags except `--isolate`, which needs a Linux runner with
//   root; isolation is covered by isolation.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BIN, TEST_TMP, git, pocp, sampleRepo, sh, tmpRepo, write, writeConfig, writeRules } from './helpers.js';
import { BREAK_ADD, TWEAK_ADD } from './fixtures.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const GOLDEN_DIR = path.join(here, 'golden');
const UPDATE = process.env.UPDATE_GOLDEN === '1';

// The CI invocation (action.yml with examples/github/pocp.yml's inputs), without the approvals
// and without --isolate (see above).
const CI_VERIFY = ['--rerun', '--require-coverage', '--exit-detail'];

// Fixed commit times, so commit ids depend only on content and messages.
const DATES = { GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z' };
Object.assign(process.env, DATES);

const commitHooked = (dir, message) => sh(dir, 'git', ['commit', '-q', '-m', message]);
const commitBare = (dir, message) => git(dir, '-c', 'core.hooksPath=/dev/null', 'commit', '-q', '--allow-empty', '-m', message);

/** Stage everything and make it committable the way a person would: pocp fix, then commit. */
function fixAndCommit(dir, intent, message = intent) {
  git(dir, 'add', '-A');
  const r = pocp(dir, ['fix', '--intent', intent]);
  if (r.code !== 0) throw new Error(`fix failed for "${intent}":\n${r.stdout}\n${r.stderr}`);
  commitHooked(dir, message);
}

const CASES = [
  {
    name: 'proven-commit',
    about: 'a change proven with pocp fix and committed through the hooks verifies',
    build() {
      const dir = sampleRepo({ hooks: true, deep: false });
      const base = git(dir, 'rev-parse', 'HEAD');
      write(dir, 'src/math.js', TWEAK_ADD);
      fixAndCommit(dir, 'swap the operands');
      return { dir, runs: [['verify', `${base}..HEAD`, ...CI_VERIFY, '--json'], ['verify', `${base}..HEAD`, ...CI_VERIFY]] };
    },
  },
  {
    name: 'missing-packet',
    about: 'a commit made with --no-verify has no proof; coverage fails',
    build() {
      const dir = sampleRepo({ hooks: true, deep: false });
      const base = git(dir, 'rev-parse', 'HEAD');
      write(dir, 'src/math.js', TWEAK_ADD);
      git(dir, 'add', '-A');
      git(dir, 'commit', '-q', '--no-verify', '-m', 'skip the hooks');
      return { dir, runs: [['verify', `${base}..HEAD`, ...CI_VERIFY, '--json'], ['verify', `${base}..HEAD`, ...CI_VERIFY]] };
    },
  },
  {
    name: 'failed-proof-local',
    about: 'broken code: gate blocks, fix runs the check and reports the failure',
    build() {
      const dir = sampleRepo({ hooks: true, deep: false });
      write(dir, 'src/math.js', BREAK_ADD);
      git(dir, 'add', '-A');
      return { dir, runs: [['gate', '--json'], ['gate'], ['fix', '--intent', 'break add', '--json'], ['gate', '--json']] };
    },
  },
  {
    name: 'unfinished-proof-local',
    about: 'a check that times out is unfinished, not failed',
    build() {
      const dir = sampleRepo({ hooks: true, deep: false, rules: {
        triggers: { globs: [] },
        requirements: [{ id: 'slow', glob: 'src/**', obligation: { kind: 'test', run: 'node -e "setTimeout(() => {}, 60000)"', timeout_ms: 300 }, source: 'author' }],
      } });
      write(dir, 'src/math.js', TWEAK_ADD);
      git(dir, 'add', '-A');
      return { dir, runs: [['fix', '--intent', 'slow check', '--json'], ['gate', '--json']] };
    },
  },
  {
    name: 'test-edit-old-tests-fail-deep',
    about: 'deep mode: code broken and its test assertion removed; the old test fails on the new code, before any mutant is sampled (old-tests regression coverage)',
    build() {
      const dir = sampleRepo({ hooks: true, deep: true });
      const base = git(dir, 'rev-parse', 'HEAD');
      write(dir, 'src/math.js', BREAK_ADD);
      write(dir, 'test/math.check.mjs', fs.readFileSync(path.join(dir, 'test/math.check.mjs'), 'utf8').split('\n').filter((l) => !l.includes('add(2, 3)')).join('\n'));
      git(dir, 'add', '-A');
      pocp(dir, ['fix', '--intent', 'drop the add assertion']);
      git(dir, 'commit', '-q', '--no-verify', '-m', 'drop the add assertion');
      return { dir, runs: [['verify', `${base}..HEAD`, ...CI_VERIFY, '--json']] };
    },
  },
  {
    name: 'test-edit-fast',
    about: 'fast mode: an edited test always needs a person',
    build() {
      const dir = sampleRepo({ hooks: true, deep: false });
      const base = git(dir, 'rev-parse', 'HEAD');
      write(dir, 'test/math.check.mjs', `${fs.readFileSync(path.join(dir, 'test/math.check.mjs'), 'utf8')}// note\n`);
      fixAndCommit(dir, 'annotate the test');
      return { dir, runs: [['verify', `${base}..HEAD`, ...CI_VERIFY, '--json']] };
    },
  },
  {
    name: 'test-added',
    about: 'a new test file is guarded like an edited one',
    build() {
      const dir = sampleRepo({ hooks: true, deep: false });
      const base = git(dir, 'rev-parse', 'HEAD');
      write(dir, 'test/extra.check.mjs', "console.log('extra ok');\n");
      fixAndCommit(dir, 'add a test');
      return { dir, runs: [['verify', `${base}..HEAD`, ...CI_VERIFY, '--json']] };
    },
  },
  {
    name: 'policy-loosened',
    about: 'a PR removes the rule that judges it: a loosening, with and without approval for the head',
    build() {
      const dir = sampleRepo({ hooks: true, deep: false });
      const base = git(dir, 'rev-parse', 'HEAD');
      // Proven by its own (loosened) rules, so the only problem left is the loosening itself.
      writeRules(dir, { triggers: { globs: [] }, requirements: [] });
      write(dir, 'src/math.js', TWEAK_ADD);
      git(dir, 'add', '-A');
      const opened = pocp(dir, ['open', '--intent', 'drop the rule', '--touch', '.proof/rules.json', '--touch', 'src/math.js', '--command', 'true', '--json']);
      if (pocp(dir, ['prove', opened.json.packet.id]).code !== 0) throw new Error('prove failed');
      commitHooked(dir, 'drop the rule');
      const head = git(dir, 'rev-parse', 'HEAD');
      return { dir, runs: [
        ['verify', `${base}..HEAD`, ...CI_VERIFY, '--json'],
        ['verify', `${base}..HEAD`, ...CI_VERIFY, `--accept-policy-change=${head}`, '--json'],
      ] };
    },
  },
  {
    name: 'adoption',
    about: 'adopting POCP through the hooks: gate passes, but today the CI verify (--require-coverage) fails on uncovered .proof files',
    build() {
      const dir = tmpRepo();
      write(dir, 'src/math.js', TWEAK_ADD);
      write(dir, 'README.md', '# sample\n');
      git(dir, 'add', '-A');
      commitBare(dir, 'before pocp');
      const base = git(dir, 'rev-parse', 'HEAD');
      const init = pocp(dir, ['init', '--hooks']);
      if (init.code !== 0) throw new Error(init.stderr);
      git(dir, 'add', '-A');
      return { dir, runs: [['gate', '--json'], ['verify', `${base}..INDEX_COMMIT`, ...CI_VERIFY, '--json']], commitIndex: true };
    },
  },
  {
    name: 'invalid-policy',
    about: 'committed rules that are not valid JSON fail closed',
    build() {
      const dir = sampleRepo({ hooks: true, deep: false });
      const base = git(dir, 'rev-parse', 'HEAD');
      write(dir, '.proof/rules.json', '{ "pocp": 1, "requirements": [ \n');
      git(dir, 'add', '-A');
      git(dir, 'commit', '-q', '--no-verify', '-m', 'corrupt the rules');
      return { dir, runs: [['verify', `${base}..HEAD`, ...CI_VERIFY, '--json']] };
    },
  },
  {
    name: 'ci-file-changed',
    about: 'a change to a CI workflow needs the same approval as a policy change',
    build() {
      const dir = sampleRepo({ hooks: true, deep: false });
      const base = git(dir, 'rev-parse', 'HEAD');
      write(dir, '.github/workflows/ci.yml', 'name: ci\non: push\njobs: {}\n');
      fixAndCommit(dir, 'add a workflow');
      return { dir, runs: [['verify', `${base}..HEAD`, ...CI_VERIFY, '--json']] };
    },
  },
  {
    name: 'multi-commit-merge-tip',
    about: 'a range whose tip is a merge: each commit, then the net change',
    build() {
      const dir = sampleRepo({ hooks: true, deep: false });
      const base = git(dir, 'rev-parse', 'HEAD');
      git(dir, 'checkout', '-q', '-b', 'feature');
      write(dir, 'src/math.js', TWEAK_ADD);
      fixAndCommit(dir, 'swap the operands');
      write(dir, 'README.md', '# sample\n\nmore\n');
      fixAndCommit(dir, 'readme');
      git(dir, 'checkout', '-q', 'main');
      write(dir, 'docs.md', 'docs\n');
      git(dir, 'add', '-A');
      commitBare(dir, 'main moves on');
      git(dir, 'checkout', '-q', 'feature');
      git(dir, '-c', 'core.hooksPath=/dev/null', 'merge', '-q', '--no-edit', 'main');
      return { dir, runs: [['verify', `${base}..HEAD`, ...CI_VERIFY, '--json']] };
    },
  },
  {
    name: 'no-merge-base',
    about: 'unrelated history: the net change cannot be computed, so verify refuses',
    build() {
      const dir = sampleRepo({ hooks: true, deep: false });
      git(dir, 'checkout', '-q', '--orphan', 'other');
      git(dir, 'rm', '-rq', '--cached', '.');
      write(dir, 'other.txt', 'x\n');
      git(dir, 'add', 'other.txt');
      commitBare(dir, 'unrelated');
      return { dir, runs: [['verify', 'main..other', ...CI_VERIFY, '--json']] };
    },
  },
  {
    name: 'shallow-clone',
    about: 'verify refuses a shallow clone',
    build() {
      const src = sampleRepo({ hooks: true, deep: false });
      write(src, 'src/math.js', TWEAK_ADD);
      git(src, 'add', '-A');
      commitBare(src, 'second');
      const dir = path.join(TEST_TMP, `shallow-${path.basename(src)}`);
      git(TEST_TMP, 'clone', '-q', '--depth', '1', `file://${src}`, dir);
      return { dir, runs: [['verify', 'HEAD', ...CI_VERIFY, '--json']] };
    },
  },
  {
    name: 'corrupt-packet',
    about: 'a committed packet file that is not valid JSON',
    build() {
      const dir = sampleRepo({ hooks: true, deep: false });
      const base = git(dir, 'rev-parse', 'HEAD');
      write(dir, 'src/math.js', TWEAK_ADD);
      fixAndCommit(dir, 'swap the operands');
      const packet = git(dir, 'ls-files', '.proof/packets').split('\n').find((p) => p.endsWith('.json'));
      write(dir, packet, '{ not json');
      git(dir, 'add', '-A');
      // With the hooks off: prepare-commit-msg (which --no-verify does not skip) reads every packet,
      // so a corrupt one blocks committing at all.
      git(dir, '-c', 'core.hooksPath=/dev/null', 'commit', '-q', '--amend', '--no-edit');
      return { dir, runs: [['verify', `${base}..HEAD`, ...CI_VERIFY, '--json'], ['show', path.basename(packet, '.json'), '--json']] };
    },
  },
  {
    name: 'gate-working-policy-differs',
    about: 'today gate reads the working copy\'s policy, not the staged one (a planned change will judge the staged policy)',
    build() {
      const dir = sampleRepo({ hooks: true, deep: false });
      write(dir, 'src/math.js', TWEAK_ADD);
      git(dir, 'add', '-A');
      write(dir, '.proof/config.json', '{ not json');
      return { dir, runs: [['gate', '--json']] };
    },
  },
];

// ---------------------------------------------------------------------------- normalization

/**
 * Names every commit in the repository by its role: its subject, which each fixture sets
 * ("before pocp", "swap the operands", "Merge branch 'main' into feature"), with #2, #3 for a
 * repeated subject. A run that reports the wrong base or head then shows the wrong role in the
 * golden, instead of the same <commit:N>.
 */
function commitRoles(dir) {
  const roles = new Map();
  const seen = new Map();
  const log = git(dir, 'log', '--all', '--reverse', '--format=%H%x00%s');
  for (const line of log.split('\n').filter(Boolean)) {
    const [sha, subject] = line.split('\0');
    const n = (seen.get(subject) || 0) + 1;
    seen.set(subject, n);
    roles.set(sha, `<commit:${subject}${n > 1 ? ` #${n}` : ''}>`);
  }
  return roles;
}

/**
 * The allowlist. Each rule rewrites one kind of volatile value; nothing else is touched.
 * 1. Paths: the repository, the suite's temp root, the pocp checkout, node.
 * 2. Commit ids of this repository's commits (40 hex) and their short forms (7–39 hex prefixes),
 *    by role (commitRoles). Other hex values, content digests ("sha256:…") included, are kept:
 *    an unexpected id fails the comparison rather than being hidden.
 * 3. Random record ids: packets (p-…), misses (m-…), run logs (r-…): <packet:N>, <miss:N>,
 *    <run:N>, by first appearance (they are random; there is no role to check).
 * 4. Clock times (ISO 8601).
 * 5. Measured durations only: the `duration_ms` and `ms` fields (elapsed time; configured
 *    timeouts are `timeout_ms` and are kept), and in verify's human output the elapsed time in
 *    its header line ("… in a..b · 1.2s") and at the end of each re-run line ("(62ms)").
 * 6. The test guard's seed, which verify derives from the compared commit ids (rule 2): the `seed`
 *    field and "seed <n>" in text. runCase refuses any capture whose outcome depended on it.
 */
function normalize(capture, { dir }) {
  let text = JSON.stringify(capture);
  const roles = commitRoles(dir);
  const paths = [
    [dir, '<repo>'],
    [fs.realpathSync(dir), '<repo>'],
    [TEST_TMP, '<tmp>'],
    [path.dirname(path.dirname(BIN)), '<pocp>'],
    [process.execPath, '<node>'],
  ];
  for (const [p, label] of paths) text = text.split(p).join(label);
  text = text.replace(/<tmp>\/[A-Za-z0-9._-]+/g, '<tmp>/<dir>');

  const commits = [...roles.keys()];
  text = text.replace(/(?<![0-9a-f:])[0-9a-f]{7,40}(?![0-9a-f])/g, (hex) => {
    const matches = commits.filter((c) => c.startsWith(hex));
    if (matches.length > 1) throw new Error(`short id ${hex} names more than one commit`);
    return matches.length ? roles.get(matches[0]) : hex;
  });

  const ids = new Map();
  const KIND = { p: 'packet', m: 'miss', r: 'run' };
  text = text.replace(/\b([pmr])-[0-9a-f]{6,}\b/g, (id, kind) => {
    if (!ids.has(id)) ids.set(id, `<${KIND[kind]}:${[...ids.keys()].filter((k) => k[0] === kind).length + 1}>`);
    return ids.get(id);
  });

  text = text.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g, '<time>');
  // Numbers in fields keep their type: measured durations and seeds become 0.
  text = text.replace(/(\\?"(?:duration_ms|ms|seed)\\?":)\d+(\.\d+)?/g, (_, key) => `${key}0`);
  text = text.replace(/\bseed \d+/g, 'seed <seed>');
  text = text.replace(/( commit\(s\) in [^·]*? · )\d+(\.\d+)?(ms|s)\b/g, (_, head) => `${head}<duration>`);
  // Each re-run line of verify's human output ends with its elapsed time: "  rerun passed   cmd (62ms)".
  text = text.replace(/(  rerun \w+ (?:(?!\\n).)*?\()\d+(?:\.\d+)?(?:ms|s)\)/g, (_, head) => `${head}<duration>)`);
  return JSON.parse(text);
}

/** A guard summary that reports mutant results: its outcome depended on the varying seed. */
// The guard's results after sampling (src/guard-check.js): every one names sampled mutants.
const SAMPLED = /sampled mutants|mutants the old tests caught/;

// ---------------------------------------------------------------------------- running

function runCase(c) {
  const { dir, runs, commitIndex } = c.build();
  const out = [];
  for (let args of runs) {
    if (commitIndex && args.some((a) => a.includes('INDEX_COMMIT'))) {
      commitHooked(dir, 'adopt pocp');
      args = args.map((a) => a.replace('INDEX_COMMIT', 'HEAD'));
    }
    const r = pocp(dir, args);
    out.push({
      args,
      exit: r.code,
      ...(r.json ? { json: r.json } : { stdout: r.stdout }),
      stderr: r.stderr,
    });
  }
  const raw = JSON.stringify(out);
  if (SAMPLED.test(raw)) throw new Error(`${c.name}: the outcome depends on mutant sampling, whose seed varies with commit ids; fix the seed or assert the plan instead (see the header)`);
  return normalize({ case: c.name, about: c.about, runs: out }, { dir });
}

for (const c of CASES) {
  test(`golden: ${c.name}`, () => {
    const file = path.join(GOLDEN_DIR, `${c.name}.json`);
    const actual = runCase(c);
    if (UPDATE) {
      fs.mkdirSync(GOLDEN_DIR, { recursive: true });
      fs.writeFileSync(file, `${JSON.stringify(actual, null, 2)}\n`);
      return;
    }
    assert.ok(fs.existsSync(file), `no golden for ${c.name}: record it with UPDATE_GOLDEN=1 (and review the file)`);
    assert.deepEqual(actual, JSON.parse(fs.readFileSync(file, 'utf8')));
  });
}
