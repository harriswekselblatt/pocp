// The isolated runner (pocp verify --isolate, src/isolate.js): a check is the pull request's
// code, and under isolation it must not be able to reach the verifier, the job's files or
// tokens, or pocp's processes, nor leave anything running. Each attack below is run as a check;
// it must fail while honest checks still pass. If isolation can't be set up, verify fails.
//
// The attack tests need what a GitHub-hosted Linux runner has: passwordless sudo, useradd,
// setpriv and prlimit. They run on any Linux GitHub Actions runner (RUNNER_TEMP set) and are
// skipped elsewhere: prepare() makes $HOME and RUNNER_TEMP private, which a developer's own
// machine shouldn't get from a test run. The fail-closed tests run everywhere.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { git, packetId, pocp as runPocp, read, sampleRepo, write, writeConfig } from './helpers.js';
import { TWEAK_ADD, commit } from './fixtures.js';
import { createIsolatedRunner, IsolationError, POCP_ROOT, trustedDir, trustedPath, uidProcesses, workerEnv } from '../src/isolate.js';

// The isolated runner narrows this process's PATH to folders no worker can change; a pocp this
// test starts gets the job's own PATH, as it would in a workflow step, and narrows it itself.
const JOB_PATH = process.env.PATH;
const pocp = (dir, args, { env = {} } = {}) => runPocp(dir, args, { env: { PATH: JOB_PATH, ...env } });
const ON_GITHUB_LINUX = process.platform === 'linux' && Boolean(process.env.RUNNER_TEMP);
const SKIP = ON_GITHUB_LINUX ? false : 'needs a Linux GitHub Actions runner (passwordless sudo, useradd, setpriv, prlimit)';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- everywhere: isolation that can't be set up fails closed -----------------------------------

test('isolation unavailable: the runner refuses to run anything', async () => {
  await assert.rejects(createIsolatedRunner({ platform: 'darwin' }).prepare(), (err) => err instanceof IsolationError && /need Linux/.test(err.message));
  await assert.rejects(createIsolatedRunner({ platform: 'linux', sudo: path.join(os.tmpdir(), 'no-such-sudo') }).prepare(), IsolationError);
  // Never prepared (no preflight probe): no check runs, not even as this user.
  await assert.rejects(createIsolatedRunner().run('echo hi', { cwd: os.tmpdir() }), /not prepared/);
});

test('verify --isolate fails closed when isolation is unavailable: exit 1, never verified, waiting or inconclusive', () => {
  const dir = sampleRepo({ hooks: true });
  write(dir, 'src/math.js', TWEAK_ADD);
  git(dir, 'add', 'src/math.js');
  const id = packetId(pocp(dir, ['open', '--intent', 'x', '--touch', 'src/math.js']).stdout);
  assert.equal(pocp(dir, ['prove', id]).code, 0);
  commit(dir, 'honest');
  const env = { POCP_ISOLATE_SUDO: path.join(os.tmpdir(), 'no-such-sudo') };
  for (const extra of [[], ['--exit-detail'], ['--json']]) {
    const v = pocp(dir, ['verify', 'HEAD', '--rerun', '--isolate', ...extra], { env });
    assert.equal(v.code, 1, `${extra.join(' ')}: ${v.stdout}${v.stderr}`);
    assert.match(`${v.stdout}${v.stderr}`, /isolation unavailable/);
    assert.doesNotMatch(v.stdout, /^verified/m);
  }
  // The same commit verifies with the cooperative runner, which says it isn't the secure profile.
  const plain = pocp(dir, ['verify', 'HEAD', '--rerun', '--json']);
  assert.equal(plain.code, 0, plain.stderr);
  assert.deepEqual(plain.json.isolation, { mode: 'cooperative', secure: false });
  const human = pocp(dir, ['verify', 'HEAD', '--rerun']);
  assert.match(human.stdout, /checks: cooperative: .*not the hosted secure profile/);
});

test('verify --install needs --isolate', () => {
  const dir = sampleRepo();
  const v = pocp(dir, ['verify', 'HEAD', '--install', 'npm ci']);
  assert.equal(v.code, 2);
  assert.match(v.stderr, /--install needs verify --isolate/);
});

test('a worker gets no tokens or job files in its environment, even ones run.env_allow lists', () => {
  const env = workerEnv({
    PATH: '/usr/bin', LANG: 'C.UTF-8', CI: 'true', HOME: '/home/runner', TMPDIR: '/home/runner/tmp', MY_VAR: 'x', OTHER: 'y',
    GITHUB_TOKEN: 'secret', ACTIONS_RUNTIME_TOKEN: 'secret', ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'secret', RUNNER_TEMP: '/home/runner/work/_temp',
    GITHUB_OUTPUT: '/f', GITHUB_ENV: '/f', GITHUB_STEP_SUMMARY: '/f', POCP_SIGN_KEY: '/k', SSH_AUTH_SOCK: '/s', GITHUB_EVENT_PATH: '/e',
  }, ['MY_VAR', 'GITHUB_TOKEN', 'ACTIONS_RUNTIME_TOKEN', 'RUNNER_TEMP', 'GITHUB_OUTPUT', 'POCP_SIGN_KEY'], { home: '/tmp/w/home', tmp: '/tmp/w/tmp', name: 'pocp-w1' });
  assert.deepEqual(env, { PATH: '/usr/bin', LANG: 'C.UTF-8', CI: 'true', MY_VAR: 'x', HOME: '/tmp/w/home', USER: 'pocp-w1', LOGNAME: 'pocp-w1', TMPDIR: '/tmp/w/tmp', TMP: '/tmp/w/tmp', TEMP: '/tmp/w/tmp' });
});

test('trustedDir: pocp runs programs only from folders no other user can change', () => {
  const me = process.getuid();
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'path-'));
  const ok = path.join(base, 'ok');
  const open = path.join(base, 'open');
  const under = path.join(open, 'bin');
  const sticky = path.join(base, 'sticky');
  const inSticky = path.join(sticky, 'bin');
  for (const d of [ok, under, inSticky]) fs.mkdirSync(d, { recursive: true });
  fs.chmodSync(open, 0o777);
  fs.chmodSync(sticky, 0o1777);
  assert.equal(trustedDir(ok, me), true);
  assert.equal(trustedDir(open, me), false, 'writable by others');
  assert.equal(trustedDir(under, me), false, 'a parent others can write could be renamed away');
  assert.equal(trustedDir(sticky, me), false, 'others can add files to a sticky folder');
  assert.equal(trustedDir(inSticky, me), true, 'but not rename ours in it');
  assert.equal(trustedDir(path.join(base, 'missing'), me), false);
  assert.equal(trustedDir(ok, me + 1), false, 'owned by someone else');
  assert.deepEqual(trustedPath(`${under}:${ok}::relative:${open}`, me), [ok]);
});

test('uidProcesses counts a user\'s live processes by real or effective uid, not zombies', () => {
  const proc = fs.mkdtempSync(path.join(os.tmpdir(), 'proc-'));
  const add = (pid, state, ruid, euid) => write(proc, `${pid}/status`, `Name:\tx\nState:\t${state} (x)\nUid:\t${ruid}\t${euid}\t${euid}\t${euid}\n`);
  add(10, 'S', 5000, 5000);
  add(11, 'Z', 5000, 5000);
  add(12, 'R', 1000, 5000);
  add(13, 'S', 1000, 1000);
  fs.mkdirSync(path.join(proc, 'self'));
  assert.equal(uidProcesses(5000, proc), 2);
  assert.equal(uidProcesses(1000, proc), 2, "pid 12 runs with real uid 1000");
  assert.equal(uidProcesses(5000, path.join(proc, 'missing')), null);
});

// --- Linux GitHub runners: the attacks ---------------------------------------------------------

let runner;
let repo;
let snap;
let controllerFile;
before(async () => {
  if (SKIP) return;
  repo = sampleRepo();
  runner = createIsolatedRunner();
  await runner.prepare({ root: repo });
  // A check's snapshot, as pocp would make it: pocp's own temporary folder.
  snap = fs.mkdtempSync(path.join(os.tmpdir(), 'pocp-tree-'));
  write(snap, 'ok.sh', 'echo honest output\n');
  write(snap, 'fail.sh', 'echo failing >&2; exit 3\n');
  write(snap, 'sub/where.sh', 'pwd; id -u; echo "$HOME $TMPDIR"\n');
  // A credential in pocp's home, readable by anyone who can get into it.
  controllerFile = path.join(os.homedir(), `.pocp-test-credential-${process.pid}`);
  fs.writeFileSync(controllerFile, 'token-in-home\n', { mode: 0o644 });
  process.on('exit', () => fs.rmSync(controllerFile, { force: true }));
});

const check = (command, opts = {}) => runner.run(command, { cwd: snap, root: snap, env: { PATH: process.env.PATH }, timeoutMs: 30_000, killGraceMs: 500, ...opts });

test('isolated: honest checks pass and fail as their exit says, as a fresh user in a copy', { skip: SKIP }, async () => {
  const ok = await check('sh ok.sh');
  assert.equal(ok.exit, 0, ok.output);
  assert.match(ok.output, /honest output/);
  const bad = await check('sh fail.sh');
  assert.equal(bad.exit, 3);
  assert.match(bad.output, /failing/);
  const where = await check('sh where.sh', { cwd: path.join(snap, 'sub') });
  assert.equal(where.exit, 0, where.output);
  const [cwd, uid, homes] = where.output.trim().split('\n');
  assert.notEqual(Number(uid), process.getuid());
  assert.equal(Number(uid), where.isolation.uid);
  assert.ok(cwd.endsWith('/sub') && !cwd.startsWith(snap), `a copy of the snapshot, not pocp's: ${cwd}`);
  assert.ok(!homes.includes(os.homedir()), homes);
  // node runs (the toolchain is outside $HOME), and the user is gone afterwards.
  const node = await check(`${JSON.stringify(process.execPath)} -e "console.log(1 + 1)"`);
  assert.equal(node.exit, 0, node.output);
  assert.match(node.output, /^2$/m);
  assert.equal(spawnSync('getent', ['passwd', String(where.isolation.uid)]).status, 2, 'the worker user was removed');
});

test('isolated: a check cannot write a sibling verifier file or its own snapshot\'s original', { skip: SKIP }, async () => {
  const before = read(POCP_ROOT, 'bin/pocp.js');
  const target = path.join(POCP_ROOT, 'src', `pwned-${process.pid}.js`);
  const r = await check('echo "process.exit(0)" > "$T/src/pwned-$P.js"; echo "process.exit(0)" >> "$T/bin/pocp.js"; echo x > "$S/ok.sh"; echo tampered > ok.sh', {
    env: { PATH: process.env.PATH, T: POCP_ROOT, P: String(process.pid), S: snap }, envAllow: ['T', 'P', 'S'],
  });
  // Each of the three writes outside its copy is refused; the last line changes only its copy.
  assert.equal(r.output.match(/Permission denied/g)?.length, 3, r.output);
  assert.equal(fs.existsSync(target), false);
  assert.equal(read(POCP_ROOT, 'bin/pocp.js'), before);
  assert.equal(read(snap, 'ok.sh'), 'echo honest output\n', 'pocp\'s snapshot is untouched (the check changed only its copy)');
  // ...nor the repository pocp verifies (its .proof run records included).
  const r2 = await check('touch "$R/pwned"; mkdir -p "$R/.proof/runs" && echo forged > "$R/.proof/runs/forged.log"', { env: { PATH: process.env.PATH, R: repo }, envAllow: ['R'] });
  assert.notEqual(r2.exit, 0);
  assert.equal(fs.existsSync(path.join(repo, 'pwned')), false);
  assert.equal(fs.existsSync(path.join(repo, '.proof', 'runs', 'forged.log')), false);
});

test('isolated: a check cannot write or read RUNNER_TEMP or the step\'s file-command files', { skip: SKIP }, async () => {
  const files = ['GITHUB_OUTPUT', 'GITHUB_ENV', 'GITHUB_STEP_SUMMARY'].map((k) => process.env[k]).filter(Boolean);
  const before = files.map((f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null));
  const cmd = [
    'touch "$RT/pwned-$P" && echo wrote-temp',
    'ls "$RT" && echo listed-temp',
    'for f in $FILES; do echo "verified=true" >> "$f" && echo "wrote $f"; cat "$f" >/dev/null && echo "read $f"; ls "$(dirname "$f")" && echo listed; done',
    'exit 0',
  ].join('\n');
  const r = await check(cmd, { env: { PATH: process.env.PATH, RT: process.env.RUNNER_TEMP, P: String(process.pid), FILES: files.join(' ') }, envAllow: ['RT', 'P', 'FILES'] });
  assert.equal(r.exit, 0);
  assert.doesNotMatch(r.output, /wrote-temp|listed-temp|^wrote |^read |^listed/m, r.output);
  assert.equal(fs.existsSync(path.join(process.env.RUNNER_TEMP, `pwned-${process.pid}`)), false);
  assert.deepEqual(files.map((f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null)), before, 'the step files are unchanged');
});

test('isolated: a check cannot signal or inspect pocp', { skip: SKIP }, async () => {
  const r = await check([
    'kill -TERM "$PARENT" && echo signalled',
    'kill -9 -1; echo after-kill-all',
    'cat "/proc/$PARENT/environ" >/dev/null && echo read-environ',
    'ls -l "/proc/$PARENT/fd/" >/dev/null 2>&1 && echo read-fds',
    'exit 0',
  ].join('\n'), { env: { PATH: process.env.PATH, PARENT: String(process.pid) }, envAllow: ['PARENT'] });
  // kill -9 -1 kills the check's own shell (the only process of its user), so the run ends by
  // signal; what matters is that pocp (this process) is still here and nothing got through.
  assert.doesNotMatch(r.output, /signalled|read-environ|read-fds/, r.output);
  process.kill(process.pid, 0);
});

test('isolated: a check cannot read tokens or credentials', { skip: SKIP }, async () => {
  const secrets = { GITHUB_TOKEN: 'ghs_secret_token', ACTIONS_RUNTIME_TOKEN: 'runtime_secret', ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'oidc_secret' };
  const r = await check([
    'env',
    'cat "$CRED" && echo read-cred',
    'cat "$HOME_OF_POCP/.git-credentials" "$HOME_OF_POCP/.npmrc" "$HOME_OF_POCP/.docker/config.json" 2>/dev/null && echo read-home',
    'for p in /proc/[0-9]*; do cat "$p/environ" 2>/dev/null | tr "\\0" "\\n" | grep -E "secret|TOKEN" ; done',
    'sudo -n cat /etc/shadow && echo root',
    'exit 0',
  ].join('\n'), {
    env: { PATH: process.env.PATH, ...process.env, ...secrets, CRED: controllerFile, HOME_OF_POCP: os.homedir() },
    // Even listed in run.env_allow, tokens are never passed.
    envAllow: ['CRED', 'HOME_OF_POCP', ...Object.keys(secrets)],
  });
  assert.equal(r.exit, 0, r.output);
  for (const v of Object.values(secrets)) assert.ok(!r.output.includes(v), `leaked ${v}`);
  assert.doesNotMatch(r.output, /token-in-home|read-cred|read-home|^root$/m, r.output);
});

test('isolated: nothing a check started survives it: a detached child is killed, and its user removed', { skip: SKIP }, async () => {
  const markers = fs.mkdtempSync('/tmp/pocp-markers-');
  fs.chmodSync(markers, 0o777);
  const marker = path.join(markers, 'survived');
  const r = await check('setsid sh -c \'sleep 2; touch "$M"\' </dev/null >/dev/null 2>&1 &\nnohup sh -c \'trap "" TERM HUP; sleep 2; touch "$M.2"\' </dev/null >/dev/null 2>&1 &\necho started', {
    env: { PATH: process.env.PATH, M: marker }, envAllow: ['M'],
  });
  assert.equal(r.exit, 0, r.output);
  assert.equal(uidProcesses(r.isolation.uid), 0, 'no process of the worker user is left');
  await sleep(3000);
  assert.deepEqual(fs.readdirSync(markers), [], 'the detached children never ran on');
  fs.rmSync(markers, { recursive: true, force: true });
});

test('isolated: a check cannot plant a program a later check runs (PATH folders and the tool cache are locked)', { skip: SKIP }, async () => {
  // An earlier run whose own result decides nothing (the install, a mutant run) plants a node
  // that always exits 0; a later required check must still run the real one.
  const wrapper = 'printf "#!/bin/sh\\nexit 0\\n"';
  const r = await check([
    'for d in $(echo "$PATH" | tr ":" " ") "$TC" "$TC/node" /opt /usr/local/bin; do',
    `  ${wrapper} > "$d/node" 2>/dev/null && chmod +x "$d/node" && echo "planted $d/node"`,
    'done',
    'n=$(command -v node)',
    `[ -n "$n" ] && ${wrapper} > "$n" 2>/dev/null && echo "overwrote $n"`,
    'for d in /opt/* "$TC"/*; do mv "$d" "$d.gone" 2>/dev/null && echo "moved $d"; done',
    'mkdir -p /opt/evil/bin 2>/dev/null && echo "made /opt/evil"',
    'exit 0',
  ].join('\n'), { env: { TC: process.env.RUNNER_TOOL_CACHE || '/opt/hostedtoolcache' }, envAllow: ['TC'] });
  assert.equal(r.exit, 0, r.output);
  assert.doesNotMatch(r.output, /planted|overwrote|moved|made/, r.output);
  const later = await check('command -v node; node -e "process.exit(3)"');
  assert.equal(later.exit, 3, `the real node ran: ${later.output}`);
});

test('isolated: a timed-out check is killed with everything it started', { skip: SKIP }, async () => {
  const started = Date.now();
  const r = await check('setsid sleep 60 </dev/null >/dev/null 2>&1 &\ntrap "" TERM\nsleep 60', { timeoutMs: 800, killGraceMs: 300 });
  assert.equal(r.timed_out, true);
  assert.ok(Date.now() - started < 15_000, `settled in ${Date.now() - started}ms`);
  assert.equal(uidProcesses(r.isolation.uid), 0);
});

test('isolated: the number of processes a check can have is bounded', { skip: SKIP }, async () => {
  const small = createIsolatedRunner({ nproc: 40 });
  await small.prepare({ root: repo });
  const r = await small.run('i=0; while [ $i -lt 100 ]; do sleep 5 & i=$((i+1)); done; echo spawned', { cwd: snap, root: snap, env: { PATH: process.env.PATH }, timeoutMs: 30_000, killGraceMs: 300 });
  assert.match(r.output, /fork|Resource temporarily unavailable/i, r.output);
  assert.equal(uidProcesses(r.isolation.uid), 0);
});

test('isolated: the preflight probe fails closed when a worker could reach a protected path', { skip: SKIP }, async () => {
  const open = fs.mkdtempSync('/tmp/pocp-open-');
  fs.chmodSync(open, 0o777);
  try {
    await assert.rejects(createIsolatedRunner().prepare({ root: repo, protect: [{ path: open, deny: 'write' }] }), (err) => err instanceof IsolationError && err.message.includes(`can write ${open}`));
  } finally {
    fs.rmSync(open, { recursive: true, force: true });
  }
});

test('isolated: dependencies install isolated, sealed read-only for the checks', { skip: SKIP }, async () => {
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'pocp-tree-'));
  write(src, 'package.json', '{}\n');
  const install = 'mkdir -p node_modules/dep && echo "module.exports = 42" > node_modules/dep/index.js && chmod u+s node_modules/dep/index.js; touch "$T/src/pwned-install" 2>/dev/null; exit 0';
  const r = await runner.installDeps(install, { dir: src, links: ['node_modules', '../escape'], env: { PATH: process.env.PATH, T: POCP_ROOT }, envAllow: ['T'], timeoutMs: 30_000 });
  assert.deepEqual(r.installed, ['node_modules']);
  assert.equal(fs.existsSync(path.join(POCP_ROOT, 'src', 'pwned-install')), false);
  const st = fs.statSync(path.join(r.depsRoot, 'node_modules', 'dep', 'index.js'));
  assert.equal(st.uid, 0, 'sealed: owned by root');
  assert.equal(st.mode & 0o6022, 0, 'no set-id bits, not writable by group or others');
  // A check uses it through the snapshot link, and can't change it for the next check.
  const tree = fs.mkdtempSync(path.join(os.tmpdir(), 'pocp-tree-'));
  fs.symlinkSync(path.join(r.depsRoot, 'node_modules'), path.join(tree, 'node_modules'));
  const use = await runner.run(`${JSON.stringify(process.execPath)} -e "console.log(require('dep'))"; echo poisoned > node_modules/dep/index.js && echo wrote`, { cwd: tree, root: tree, env: { PATH: process.env.PATH }, timeoutMs: 30_000 });
  assert.match(use.output, /^42$/m, use.output);
  assert.doesNotMatch(use.output, /^wrote$/m);
  assert.match(fs.readFileSync(path.join(r.depsRoot, 'node_modules', 'dep', 'index.js'), 'utf8'), /42/);
  // A failing install fails closed.
  await assert.rejects(runner.installDeps('exit 7', { dir: src, links: ['node_modules'], env: { PATH: process.env.PATH }, timeoutMs: 30_000 }), (err) => err instanceof IsolationError && /install "exit 7" failed \(exit 7\)/.test(err.message));
});

test('isolated verify: honest code verifies; a check that fails and tries to forge green stays red', { skip: SKIP }, () => {
  // The rules' check runs check.sh. Under verify it also tries everything: write the step's
  // output file, write the verifier, signal pocp, then fails if FAIL is set.
  const dir = sampleRepo({ hooks: true });
  write(dir, 'check.sh', [
    'node test/math.check.mjs || exit 1',
    'if [ -n "$ATTACK" ]; then',
    '  echo "code=0" >> "$OUT"; echo "verified=true" >> "$OUT"',
    '  echo "process.exit(0)" >> "$VERIFIER/bin/pocp.js"',
    '  for p in $(pgrep -u "$POCP_UID" 2>/dev/null); do kill -9 "$p"; done',
    '  [ -n "$FAIL" ] && exit 1',
    'fi',
    'exit 0',
    '',
  ].join('\n'));
  writeConfig(dir, { run: { mode: 'clean', timeout_ms: 120000, env: 'inherit', env_allow: ['ATTACK', 'FAIL', 'OUT', 'VERIFIER', 'POCP_UID'] }, snapshot: { link: ['node_modules'] } });
  const rules = JSON.parse(read(dir, '.proof/rules.json'));
  rules.requirements[0].obligation.run = 'sh check.sh';
  write(dir, '.proof/rules.json', `${JSON.stringify(rules, null, 2)}\n`);
  git(dir, 'add', '-A');
  git(dir, '-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', 'check script');
  write(dir, 'src/math.js', TWEAK_ADD);
  git(dir, 'add', 'src/math.js');
  const id = packetId(pocp(dir, ['open', '--intent', 'x', '--touch', 'src/math.js']).stdout);
  assert.equal(pocp(dir, ['prove', id]).code, 0);
  commit(dir, 'honest');

  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'out-')), 'step-output');
  fs.writeFileSync(out, '');
  const verifierBefore = read(POCP_ROOT, 'bin/pocp.js');
  const attack = { PATH: JOB_PATH, ATTACK: '1', OUT: out, VERIFIER: POCP_ROOT, POCP_UID: String(process.getuid()) };

  const honest = pocp(dir, ['verify', 'HEAD', '--rerun', '--isolate', '--json'], { env: { PATH: JOB_PATH } });
  assert.equal(honest.code, 0, honest.stdout + honest.stderr);
  assert.deepEqual(honest.json.isolation, { mode: 'user', secure: true });

  const passing = pocp(dir, ['verify', 'HEAD', '--rerun', '--isolate'], { env: attack });
  assert.equal(passing.code, 0, passing.stdout + passing.stderr);
  assert.match(passing.stdout, /checks: user: each check ran as a fresh unprivileged user/);

  const failing = pocp(dir, ['verify', 'HEAD', '--rerun', '--isolate', '--exit-detail'], { env: { ...attack, FAIL: '1' } });
  assert.equal(failing.code, 1, failing.stdout + failing.stderr);
  assert.match(failing.stdout, /NOT verified/);

  assert.equal(fs.readFileSync(out, 'utf8'), '', 'nothing reached the step output file');
  assert.equal(read(POCP_ROOT, 'bin/pocp.js'), verifierBefore);
});
