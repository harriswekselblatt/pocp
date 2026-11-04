// How independent `pocp verify` is from the pull request it judges.
//
// In CI, verify runs the pull request's code (its re-runs). That code runs as the same user,
// on the same machine, so it gets every chance to cheat: write a CI results file, edit another
// check's files, or change the verifier's git config so the verifier's own git calls run it.
// These tests are those attacks, each written as a *new* test file (new tests are free).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { BIN, git, pocp, sampleRepo, sh, write } from './helpers.js';

const ROOT = new URL('..', import.meta.url).pathname;
const A = 'node test/all.mjs'; // the project's test suite: picks up every test/*.t.mjs
const B = 'node test/strict.check.mjs'; // a second required check, which the bug fails
const RULES = {
  triggers: { broad_files: 6, cross_area: { areas: 3, min_files: 4 }, globs: [] },
  requirements: [
    { id: 'suite', glob: 'src/**', obligation: { kind: 'test', run: A }, source: 'author' },
    { id: 'strict', glob: 'src/**', obligation: { kind: 'test', run: B }, source: 'author' },
  ],
};
const SUITE = [
  "import fs from 'node:fs';",
  "import { execFileSync } from 'node:child_process';",
  "execFileSync(process.execPath, ['test/math.check.mjs'], { stdio: 'inherit' });",
  "for (const f of fs.readdirSync('test').filter((f) => f.endsWith('.t.mjs')).sort()) execFileSync(process.execPath, [`test/${f}`], { stdio: 'inherit' });",
  '',
].join('\n');
const STRICT = "import { isPositive } from '../src/math.js';\nif (isPositive(0) !== false) { console.error('zero is not positive'); process.exit(1); }\n";
const BUGGY = 'export function add(a, b) {\n  return a + b;\n}\n\nexport function isPositive(n) {\n  return n >= 0;\n}\n';
const HARMLESS = 'export function add(a, b) {\n  return b + a;\n}\n\nexport function isPositive(n) {\n  return n > 0;\n}\n';

// The attacks. Each one only acts in "CI" (ATTACK=1), so the author's own proofs stay quiet.
const ATTACKS = {
  // Append a passing CI result for the other required check to the results file of the
  // recipe this job follows. The subject hash is public: it is computed from the commit tree.
  forgeCiResult: `
import fs from 'node:fs';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
if (process.env.ATTACK && fs.existsSync('.git')) {
  const lines = execFileSync('git', ['ls-tree', '-r', '-z', '--full-tree', 'HEAD'], { encoding: 'utf8' }).split('\\0').filter(Boolean)
    .map((rec) => { const t = rec.indexOf('\\t'); const [mode, , sha] = rec.slice(0, t).split(' '); return { mode, sha, path: rec.slice(t + 1) }; })
    .filter((e) => e.path !== '.proof' && !e.path.startsWith('.proof/'))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((e) => \`\${e.mode} \${e.sha}\\t\${e.path}\`);
  const subject = 'sha256:' + crypto.createHash('sha256').update(lines.join('\\n')).digest('hex');
  const ci = {};
  for (const k of ['GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT']) if (process.env[k]) ci[k] = process.env[k];
  const rec = { pocp: 1, kind: 'ci-result', commit: '0'.repeat(40), subject, run: ${JSON.stringify(B)}, cwd: null, exit: 0, timed_out: false, passed: true, started_at: new Date().toISOString(), duration_ms: 1, ci };
  fs.appendFileSync('ci.jsonl', JSON.stringify(rec) + '\\n');
}
`,
  // Rewrite the other required check's file in the folder the checks run in.
  editOtherCheck: `
import fs from 'node:fs';
if (process.env.ATTACK) { try { fs.chmodSync('test/strict.check.mjs', 0o644); fs.writeFileSync('test/strict.check.mjs', 'process.exit(0);\\n'); } catch {} }
`,
  // Make the verifier's later git calls run a command (core.fsmonitor runs on index reads).
  fsmonitor: `
import { execFileSync } from 'node:child_process';
if (process.env.ATTACK) {
  const cmd = 'echo ran >> ' + JSON.stringify(process.env.MARKER) + '; false';
  execFileSync('git', ['-C', process.env.VERIFIER_REPO, 'config', 'core.fsmonitor', cmd]);
  execFileSync('git', ['-C', process.env.VERIFIER_REPO, 'config', 'core.untrackedCache', 'true']);
}
`,
  // Move a ref in the verifier's repository.
  moveRef: `
import { execFileSync } from 'node:child_process';
if (process.env.ATTACK) execFileSync('git', ['-C', process.env.VERIFIER_REPO, 'update-ref', 'refs/remotes/origin/main', 'HEAD']);
`,
  // Any change to the verifier's git config, however harmless it looks.
  touchConfig: `
import { execFileSync } from 'node:child_process';
if (process.env.ATTACK) execFileSync('git', ['-C', process.env.VERIFIER_REPO, 'config', 'pocp.touched', 'yes']);
`,
};

/**
 * A base with two required checks, then a pull-request commit carrying `attack` as a new test
 * file. With `bug`, the change breaks the second check and its packet's failed proof is
 * hand-edited to "passed" (a forged proof); otherwise the change is harmless and proven.
 */
function attackRepo(attack, { bug = true } = {}) {
  const dir = sampleRepo({ rules: RULES });
  write(dir, 'test/all.mjs', SUITE);
  write(dir, 'test/strict.check.mjs', STRICT);
  git(dir, 'add', '-A');
  git(dir, '-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', 'two required checks');
  const base = git(dir, 'rev-parse', 'HEAD');
  git(dir, 'update-ref', 'refs/remotes/origin/main', base);
  write(dir, 'src/math.js', bug ? BUGGY : HARMLESS);
  write(dir, 'test/zz-attack.t.mjs', ATTACKS[attack]);
  git(dir, 'add', '-A');
  const opened = pocp(dir, ['open', '--json', '--intent', 'change isPositive', '--touch', 'src/math.js']);
  const id = opened.json.packet.id;
  const proved = pocp(dir, ['prove', id]);
  assert.equal(proved.code, bug ? 1 : 0, proved.stdout + proved.stderr);
  if (bug) {
    const file = path.join(dir, '.proof', 'packets', `${id}.json`);
    const packet = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const p of packet.proofs) Object.assign(p, { passed: true, exit: 0, timed_out: false });
    if (packet.state === 'failed') packet.state = 'proven';
    fs.writeFileSync(file, `${JSON.stringify(packet, null, 2)}\n`);
  }
  git(dir, 'add', '-A');
  const trailer = pocp(dir, ['trailer']).stdout.trim();
  assert.match(trailer, /Proof-Of-Change:/);
  git(dir, '-c', 'core.hooksPath=/dev/null', 'commit', '-q', '--no-verify', '-m', `change isPositive\n\n${trailer}\n`);
  return { dir, base, head: git(dir, 'rev-parse', 'HEAD') };
}

const CI_ENV = { ATTACK: '1', GITHUB_RUN_ID: '7', GITHUB_RUN_ATTEMPT: '1' };

/** Run a shell snippet copied from the docs, with `pocp` meaning this checkout's CLI. */
function runSnippet(dir, snippet, env = {}) {
  const script = `pocp() { "${process.execPath}" "${BIN}" "$@"; }\n${snippet}`;
  const r = spawnSync('sh', ['-c', script], { cwd: dir, encoding: 'utf8', env: { ...process.env, ...env } });
  return { code: r.status, out: r.stdout + r.stderr };
}

/** The first ```bash block after `marker` in a doc. */
function snippetAfter(file, marker) {
  const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const at = text.indexOf(marker);
  assert.ok(at !== -1, `${file}: "${marker}" not found`);
  const m = /```(?:bash|sh)\n([\s\S]*?)```/.exec(text.slice(at));
  assert.ok(m, `${file}: no shell block after "${marker}"`);
  // A project-local install runs "npx pocp"; here pocp is provided on PATH, and npx would
  // look it up on the npm registry instead.
  return m[1].replace(/\bnpx pocp\b/g, 'pocp');
}

const codeLines = (text) => text.split('\n').filter((l) => !/^\s*#/.test(l)).map((l) => l.replace(/\s#.*$/, ''));

test('forged CI result: the README CI recipe blocks it', () => {
  const { dir } = attackRepo('forgeCiResult');
  // The README's test step is `npm test`; this project's suite is A.
  const r = runSnippet(dir, snippetAfter('README.md', 'In CI:').replaceAll('npm test', A), CI_ENV);
  assert.notEqual(r.code, 0, r.out);
  assert.match(r.out, /rerun failed\s+node test\/strict\.check\.mjs/);
  assert.doesNotMatch(r.out, /passing CI result/);
});

test('forged CI result: the trusting ci-run mode accepts it, as documented', () => {
  // `ci-run` + `--ci-results` trusts everything that ran earlier in the job. This is the
  // reproduction of why it is not the default; if results ever become unforgeable from inside
  // the test process, this test should flip.
  const { dir, base } = attackRepo('forgeCiResult');
  assert.equal(pocp(dir, ['ci-run', '--results', 'ci.jsonl', '--', A], { env: CI_ENV }).code, 0);
  const v = pocp(dir, ['verify', `${base}..HEAD`, '--require-coverage', '--rerun', '--ci-results', 'ci.jsonl'], { env: CI_ENV });
  assert.equal(v.code, 0, v.stdout + v.stderr);
  assert.match(v.stdout, /skipped: passing CI result/);
});

test('every CI recipe users copy re-runs the checks and trusts no results file', () => {
  const recipes = {
    'README.md': snippetAfter('README.md', 'In CI:'),
    'docs/QUICKSTART.md': snippetAfter('docs/QUICKSTART.md', '## 4. Add CI'),
    'examples/any-ci/pocp-ci.sh': fs.readFileSync(path.join(ROOT, 'examples/any-ci/pocp-ci.sh'), 'utf8'),
    'examples/gitlab/.gitlab-ci.yml': fs.readFileSync(path.join(ROOT, 'examples/gitlab/.gitlab-ci.yml'), 'utf8'),
  };
  for (const [file, text] of Object.entries(recipes)) {
    const code = codeLines(text).join('\n');
    assert.match(code, /\bverify\b[^\n]*--rerun(?!-unsigned)\b/, `${file}: verify re-runs every check`);
    assert.doesNotMatch(code, /--ci-results|\bci-run\b/, `${file}: no CI results file in the default recipe`);
  }
  const wf = codeLines(fs.readFileSync(path.join(ROOT, 'examples/github/pocp.yml'), 'utf8')).join('\n');
  assert.match(wf, /rerun:\s*all/);
  assert.doesNotMatch(wf, /ci-results|ci-run/);
  const action = fs.readFileSync(path.join(ROOT, 'action.yml'), 'utf8');
  assert.match(action, /rerun:\n(?:\s+\w.*\n)*?\s+default: 'all'/, 'action defaults to rerun: all');
  assert.match(action, /ci-results:\n\s+description: .*trust/i, 'the ci-results input says what it trusts');
});

test('installs pin a GitHub commit; nothing runs the unpublished npm name', () => {
  const files = ['action.yml', 'examples/github/pocp.yml', 'examples/gitlab/.gitlab-ci.yml', 'examples/any-ci/pocp-ci.sh', '.github/workflows/pocp.yml'];
  for (const f of files) {
    const text = fs.readFileSync(path.join(ROOT, f), 'utf8');
    assert.doesNotMatch(text, /npx[^\n]*["' ]pocp@/, `${f}: no npx pocp@<version>`);
    for (const m of text.matchAll(/npx --yes "([^"]+)"/g)) assert.match(m[1], /^github:harriswekselblatt\/pocp#/, `${f}: ${m[1]}`);
  }
  assert.doesNotMatch(fs.readFileSync(path.join(ROOT, 'action.yml'), 'utf8'), /pocp-version/);
});

test("a new test can't rewrite another required check's files before verify re-runs it", () => {
  const { dir, base } = attackRepo('editOtherCheck');
  const v = pocp(dir, ['verify', `${base}..HEAD`, '--require-coverage', '--rerun'], { env: { ATTACK: '1' } });
  assert.notEqual(v.code, 0, v.stdout + v.stderr);
  assert.match(v.stdout, /rerun failed\s+node test\/strict\.check\.mjs/);
});

for (const form of ['range', 'single commit']) {
  test(`fsmonitor planted during a re-run never runs in the verifier's git calls (${form})`, () => {
    const { dir, base } = attackRepo('fsmonitor', { bug: false });
    const marker = path.join(dir, '..', `${path.basename(dir)}-marker`);
    const target = form === 'range' ? `${base}..HEAD` : 'HEAD';
    const v = pocp(dir, ['verify', target, '--rerun'], { env: { ATTACK: '1', VERIFIER_REPO: dir, MARKER: marker } });
    assert.equal(fs.existsSync(marker), false, `the planted command ran:\n${fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8') : ''}`);
    assert.equal(v.code, 1, v.stdout + v.stderr);
    assert.match(v.stderr, /git state changed while verify ran the pull request's code/);
  });
}

test('verify fails closed when the checks change git config, even harmlessly', () => {
  const { dir, base } = attackRepo('touchConfig', { bug: false });
  const clean = pocp(dir, ['verify', `${base}..HEAD`, '--rerun']);
  assert.equal(clean.code, 0, clean.stdout + clean.stderr);
  const v = pocp(dir, ['verify', `${base}..HEAD`, '--rerun'], { env: { ATTACK: '1', VERIFIER_REPO: dir } });
  assert.equal(v.code, 1, v.stdout + v.stderr);
  assert.match(v.stderr, /git state changed while verify ran the pull request's code/);
  assert.match(v.stderr, /config/);
});

test('verify fails closed when the checks move a ref in the repository', () => {
  const { dir, base } = attackRepo('moveRef', { bug: false });
  const v = pocp(dir, ['verify', `${base}..HEAD`, '--rerun'], { env: { ATTACK: '1', VERIFIER_REPO: dir } });
  assert.equal(v.code, 1, v.stdout + v.stderr);
  assert.match(v.stderr, /git state changed while verify ran the pull request's code \(refs changed\)/);
});

test('a git directory named in the environment is not used by verify', () => {
  const { dir, base } = attackRepo('touchConfig', { bug: false });
  const other = sampleRepo();
  const v = pocp(dir, ['verify', `${base}..HEAD`, '--rerun'], { env: { GIT_DIR: path.join(other, '.git'), GIT_WORK_TREE: other } });
  assert.equal(v.code, 0, v.stdout + v.stderr);
  assert.match(v.stdout, /verified: 1 commit/);
});

// --- approvals bound to a commit -------------------------------------------------------

function policyLoosening() {
  const dir = sampleRepo();
  const base = git(dir, 'rev-parse', 'HEAD');
  write(dir, '.proof/rules.json', `${JSON.stringify({ pocp: 1, requirements: [] }, null, 2)}\n`);
  git(dir, 'add', '-A');
  git(dir, '-c', 'core.hooksPath=/dev/null', 'commit', '-q', '--no-verify', '-m', 'drop the math rule');
  return { dir, base, head: git(dir, 'rev-parse', 'HEAD') };
}

test('an approval given for one head does not carry over to a later push', () => {
  const { dir, base, head } = policyLoosening();
  assert.equal(pocp(dir, ['verify', `${base}..HEAD`]).code, 1, 'needs approval');
  const atHead = pocp(dir, ['verify', `${base}..HEAD`, `--accept-policy-change=${head}`]);
  assert.equal(atHead.code, 0, atHead.stdout + atHead.stderr);
  assert.equal(pocp(dir, ['verify', `${base}..HEAD`, `--accept-policy-change=${head.slice(0, 12)}`]).code, 0, 'a short sha works');
  // A new push after the approval: the approval named the old head.
  write(dir, 'README.md', '# sample, pushed after approval\n');
  git(dir, 'add', '-A');
  git(dir, '-c', 'core.hooksPath=/dev/null', 'commit', '-q', '--no-verify', '-m', 'later push');
  const stale = pocp(dir, ['verify', `${base}..HEAD`, `--accept-policy-change=${head}`]);
  assert.equal(stale.code, 1, stale.stdout + stale.stderr);
  assert.match(stale.stderr, /approval for .* does not cover/);
  // The plain flag (CI decides when to pass it) is unchanged.
  assert.equal(pocp(dir, ['verify', `${base}..HEAD`, '--accept-policy-change']).code, 0);
  assert.equal(pocp(dir, ['verify', `${base}..HEAD`, '--accept-policy-change=false']).code, 1);
});

// --- POCP's git calls never run commands from git config ------------------------------

test("POCP's git calls ignore core.fsmonitor, hooks and diff drivers in the repository's config", async () => {
  const { checkRevTo, changedLines } = await import('../src/git.js').then((m) => ({ checkRevTo: m.checkoutRevTo, changedLines: m.changedLines }));
  const dir = sampleRepo();
  const marker = path.join(dir, '..', `${path.basename(dir)}-marker`);
  const run = `echo ran >> ${JSON.stringify(marker)}; false`;
  const hooks = path.join(dir, '..', `${path.basename(dir)}-hooks`);
  write(hooks, 'post-checkout', `#!/bin/sh\necho hook >> ${JSON.stringify(marker)}\n`);
  fs.chmodSync(path.join(hooks, 'post-checkout'), 0o755);
  git(dir, 'config', 'core.fsmonitor', run);
  git(dir, 'config', 'core.hooksPath', hooks);
  git(dir, 'config', 'diff.external', run);
  git(dir, 'config', 'diff.evil.textconv', run);
  write(dir, '.gitattributes', '*.js diff=evil\n');
  write(dir, 'src/math.js', HARMLESS);
  git(dir, '-c', 'core.fsmonitor=false', 'add', '-A');
  git(dir, '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', 'commit', '-q', '--no-verify', '-m', 'x');
  const out = path.join(dir, '..', `${path.basename(dir)}-out`);
  checkRevTo(dir, 'HEAD', `${out}/`, path.join(dir, '..', `${path.basename(dir)}-index`));
  assert.ok(fs.existsSync(path.join(out, 'src', 'math.js')));
  assert.deepEqual([...changedLines(dir, 'HEAD~1', 'HEAD', ['src/math.js']).get('src/math.js')], [2]);
  assert.equal(fs.existsSync(marker), false, fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8') : '');
  // The same calls without POCP's flags do run it (the setup is live).
  sh(dir, 'git', ['status']);
  assert.equal(fs.existsSync(marker), true);
});

// --- verify.require_ci under the default recipe ---------------------------------------

test('verify --rerun runs verify.require_ci commands itself', () => {
  for (const [check, expected] of [['node -e "process.exit(0)"', 0], ['node -e "process.exit(3)"', 1]]) {
    const dir = sampleRepo();
    write(dir, '.proof/config.json', `${JSON.stringify({ pocp: 1, verify: { require_ci: [check] } }, null, 2)}\n`);
    git(dir, 'add', '-A');
    git(dir, '-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', 'require ci');
    const base = git(dir, 'rev-parse', 'HEAD');
    write(dir, 'README.md', '# sample\n\nmore\n');
    git(dir, 'add', '-A');
    git(dir, '-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', 'docs');
    const v = pocp(dir, ['verify', `${base}..HEAD`, '--rerun', '--json']);
    assert.equal(v.code, expected, v.stdout + v.stderr);
    assert.equal(v.json.reruns.find((r) => r.run === check)?.status, expected ? 'failed' : 'passed');
    if (expected) assert.match(JSON.stringify(v.json.commits.at(-1).findings), /ci_failed.*failed when re-run by this verify/);
    const one = pocp(dir, ['verify', 'HEAD', '--rerun']);
    assert.equal(one.code, expected, one.stdout + one.stderr);
  }
});
