// The isolated runner: how `pocp verify --isolate` runs the pull request's code (the hosted
// secure profile, docs/THREAT-MODEL.md).
//
// pocp itself is the trusted controller. It builds each snapshot, starts the check, and reads
// back only what the kernel reports (exit status, signal, whether the time limit hit) and the
// bytes the check wrote to stdout/stderr. Each check runs as a fresh Linux user created for that
// one run, in its own copy of the snapshot, with its own HOME and TMPDIR:
//
// - A different user can't write pocp's files (the verifier checkout, the repository, the run
//   records), can't read RUNNER_TEMP or $HOME (made private first), can't signal or inspect
//   pocp's processes, and never gets the job's tokens in its environment.
// - It runs with no_new_privs and no capabilities, so setuid programs (sudo among them) give
//   it nothing.
// - Everything it starts runs as that user, so when the check ends or times out, killing every
//   process of that user kills everything it started, including children that left the
//   process group. The user is then deleted; its number is never reused in this run.
// - RLIMIT_NPROC bounds how many processes and threads it can have at once.
//
// The controller uses passwordless sudo (GitHub-hosted runners have it) to create the user and
// start the check. If any of that can't be done, or the preflight probe finds the worker could
// reach something it shouldn't, isolation is unavailable and verify fails: it never falls back
// to running checks as the same user.
import { spawnSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { onCleanup } from './exit.js';
import { CI_STEP_VARS, runWith } from './runner.js';
import { useDependencyRoot } from './workspace.js';

/** The folder pocp runs from (the verifier checkout, or the action's copy). */
export const POCP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export class IsolationError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'IsolationError';
    this.code = 'isolation_unavailable';
    this.details = details;
  }
}

// What a check's environment may hold under isolation, whatever run.env says: these, the
// names in run.env_allow, and the worker's own HOME/TMPDIR/USER. Never the job's tokens or
// files, whatever run.env_allow lists.
const SAFE_ENV = ['PATH', 'LANG', 'LANGUAGE', 'TZ', 'TERM', 'CI', 'GITHUB_ACTIONS', 'NODE_ENV', 'POCP', 'POCP_OBLIGATION'];
const NEVER_ENV = (k) => k.startsWith('ACTIONS_') || k.startsWith('RUNNER_') || CI_STEP_VARS.includes(k)
  || ['GITHUB_TOKEN', 'GITHUB_EVENT_PATH', 'SSH_AUTH_SOCK', 'GIT_ASKPASS', 'SSH_ASKPASS'].includes(k) || k.startsWith('POCP_SIGN');

/** The environment a worker gets: an allowlist of `env`, plus its own home and temp folders. */
export function workerEnv(env = {}, allow = [], sandbox = {}) {
  const out = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined || NEVER_ENV(k)) continue;
    if (SAFE_ENV.includes(k) || k.startsWith('LC_') || allow.includes(k)) out[k] = String(v);
  }
  if (sandbox.home) Object.assign(out, { HOME: sandbox.home, USER: sandbox.name, LOGNAME: sandbox.name });
  if (sandbox.tmp) Object.assign(out, { TMPDIR: sandbox.tmp, TMP: sandbox.tmp, TEMP: sandbox.tmp });
  if (!out.PATH) out.PATH = '/usr/local/bin:/usr/bin:/bin';
  return out;
}

/**
 * Linux: how many processes (threads' leaders) run as `uid`, real or effective, zombies
 * excluded. Read from /proc/<pid>/status, which every user can read and which a process can't
 * hide by making itself non-dumpable. null when /proc can't be read.
 */
export function uidProcesses(uid, procDir = '/proc') {
  let names;
  try {
    names = fs.readdirSync(procDir);
  } catch {
    return null;
  }
  let n = 0;
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    let status;
    try {
      status = fs.readFileSync(`${procDir}/${name}/status`, 'utf8');
    } catch {
      continue; // exited while we looked
    }
    const state = /^State:\s+(\S)/m.exec(status)?.[1];
    const ids = /^Uid:\s+(\d+)\s+(\d+)/m.exec(status);
    if (!ids || state === 'Z' || state === 'X') continue;
    if (Number(ids[1]) === uid || Number(ids[2]) === uid) n++;
  }
  return n;
}

/** Take group and other write off every file and folder under `dir` that `uid` owns (links skipped). */
export function dropOthersWrite(dir, uid) {
  const fix = (p, st) => {
    if (st.uid === uid && !st.isSymbolicLink() && (st.mode & 0o022)) fs.chmodSync(p, st.mode & ~0o022 & 0o7777);
  };
  const walk = (d) => {
    let st;
    try {
      st = fs.lstatSync(d);
    } catch {
      return;
    }
    fix(d, st);
    if (!st.isDirectory()) return;
    for (const name of fs.readdirSync(d)) {
      const p = path.join(d, name);
      const s2 = fs.lstatSync(p);
      if (s2.isDirectory()) walk(p);
      else fix(p, s2);
    }
  };
  walk(dir);
}

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// The worker's shell, started as the worker with the command as $0 and its folder as $1 (pocp
// can't enter the worker's private folder itself, so the shell changes into it). fd 0 is a pipe
// only pocp holds open: if pocp dies in a way no handler can catch, the read ends and the
// watchdog kills every process of the worker's user (kill -1 as that user reaches exactly
// those). The command itself gets /dev/null as stdin.
const WATCHDOG = 'cd -- "$1" || exit 126\nexec 3<&0\n(while read -r _; do :; done; kill -9 -1) <&3 >/dev/null 2>&1 &\nexec 3<&- </dev/null\nexec /bin/sh -c "$0"';

/** Is a path inside a folder (or the folder itself)? */
const inside = (dir, p) => p === dir || p.startsWith(`${dir}${path.sep}`);

/**
 * The isolated runner. Options (for tests and unusual hosts):
 * - sudo: the sudo command (POCP_ISOLATE_SUDO, default "sudo")
 * - baseDir: where worker folders are made (default /tmp; it must be world-traversable)
 * - nproc: RLIMIT_NPROC for each worker (POCP_ISOLATE_NPROC, default 4096; it counts threads)
 */
export function createIsolatedRunner({
  sudo = process.env.POCP_ISOLATE_SUDO || 'sudo',
  baseDir = '/tmp',
  nproc = Number(process.env.POCP_ISOLATE_NPROC) || 4096,
  platform = process.platform,
} = {}) {
  let prepared = false;
  const usedUids = new Set();

  const asRoot = (args, { input, timeout = 60_000 } = {}) => {
    const r = spawnSync(sudo, ['-n', '--', ...args], { encoding: 'utf8', input, timeout, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
    if (r.error) throw new IsolationError(`isolation unavailable: could not run ${sudo} ${args[0]}: ${r.error.message}`);
    if (r.status !== 0) throw new IsolationError(`isolation unavailable: ${sudo} ${args[0]} failed (exit ${r.status}${r.signal ? `, ${r.signal}` : ''}): ${(r.stderr || '').trim().slice(0, 300)}`);
    return r.stdout;
  };
  const dropTo = (sb) => ['setpriv', `--reuid=${sb.uid}`, `--regid=${sb.gid}`, '--clear-groups', '--no-new-privs', '--inh-caps=-all', '--bounding-set=-all', '--'];

  function pickUid() {
    for (let i = 0; i < 50; i++) {
      const uid = 200_000 + crypto.randomInt(1_800_000);
      if (usedUids.has(uid)) continue;
      if (spawnSync('getent', ['passwd', String(uid)]).status === 0) continue;
      if (uidProcesses(uid) !== 0) continue;
      usedUids.add(uid);
      return uid;
    }
    throw new IsolationError('isolation unavailable: no free user id for a worker');
  }

  /** Signal every process of the sandbox's user, as that user (kill -1 reaches exactly those). */
  function killUser(sb, signal) {
    const sig = String(signal).replace(/^SIG/, '');
    spawnSync(sudo, ['-n', '--', ...dropTo(sb), '/bin/sh', '-c', `kill -s ${sig} -1`], { stdio: 'ignore', timeout: 30_000 });
  }

  /** A fresh user with a fresh copy of `src` (its work folder), its own home and temp. */
  function makeSandbox(src, { deps = false } = {}) {
    const base = fs.mkdtempSync(path.join(baseDir, 'pocp-iso-'));
    // Other users may pass through (to reach their own folders by name), not list or write.
    fs.chmodSync(base, 0o711);
    const uid = pickUid();
    const sb = { uid, gid: null, name: `pocp-w${uid}`, base, work: path.join(base, 'work'), home: path.join(base, 'home'), tmp: path.join(base, 'tmp'), deps: deps ? path.join(base, 'deps') : null, user: false };
    sb.unregister = onCleanup(() => destroy(sb, { quiet: true }));
    try {
      fs.cpSync(src, sb.work, { recursive: true, verbatimSymlinks: true });
      for (const d of [sb.home, sb.tmp, ...(sb.deps ? [sb.deps] : [])]) fs.mkdirSync(d);
      asRoot(['useradd', '--no-create-home', '--no-log-init', '--home-dir', sb.home, '--shell', '/usr/sbin/nologin', '--uid', String(uid), '--user-group', sb.name]);
      sb.user = true;
      sb.gid = Number(spawnSync('id', ['-g', sb.name], { encoding: 'utf8' }).stdout.trim());
      if (!Number.isInteger(sb.gid) || sb.gid <= 0) throw new IsolationError(`isolation unavailable: could not read the group of ${sb.name}`);
      const own = [sb.work, sb.home, sb.tmp, ...(sb.deps ? [sb.deps] : [])];
      // -P -h: never follow a symlink in the snapshot (its target is whatever the commit says).
      asRoot(['chown', '-R', '-P', '-h', `${sb.uid}:${sb.gid}`, '--', ...own]);
      asRoot(['chmod', '0700', '--', ...own]);
    } catch (err) {
      destroy(sb, { quiet: true });
      throw err instanceof IsolationError ? err : new IsolationError(`isolation unavailable: could not set up a worker: ${err.message}`);
    }
    return sb;
  }

  /**
   * Kill everything the sandbox's user runs, then remove its folders and the user. Returns the
   * problems; a process that can't be killed or a user that can't be removed is one.
   */
  function destroy(sb, { quiet = false, keep = [] } = {}) {
    if (sb.destroyed) return [];
    sb.destroyed = true;
    sb.unregister?.();
    const problems = [];
    if (sb.user) {
      for (let i = 0; i < 100 && uidProcesses(sb.uid) !== 0; i++) {
        killUser(sb, 'SIGKILL');
        sleepSync(i < 10 ? 10 : 50);
      }
      if (uidProcesses(sb.uid) !== 0) problems.push(`worker ${sb.name}'s processes could not be killed`);
    }
    const remove = [sb.work, sb.home, sb.tmp].filter((d) => !keep.includes(d));
    try {
      if (sb.user && !problems.length) asRoot(['rm', '-rf', '--one-file-system', '--', ...remove]);
      if (sb.user && !problems.length) asRoot(['userdel', sb.name]);
    } catch (err) {
      problems.push(err.message);
    }
    if (!sb.user) fs.rmSync(sb.base, { recursive: true, force: true });
    else if (!keep.length) {
      try {
        fs.rmdirSync(sb.base);
      } catch { /* left for the exit cleanup */ }
    }
    if (problems.length && !quiet) throw new IsolationError(`isolation failed: ${problems.join('; ')}`);
    return problems;
  }

  function launcherFor(sb) {
    return {
      spawn: (command, { cwd, env }) => spawn(sudo, [
        '-n', '--', 'prlimit', `--nproc=${nproc}:${nproc}`, '--', ...dropTo(sb),
        'env', '-i', ...Object.entries(env).map(([k, v]) => `${k}=${v}`), '/bin/sh', '-c', WATCHDOG, command, cwd,
      ], { cwd: '/', detached: true, stdio: ['pipe', 'pipe', 'pipe'] }),
      watch: (child) => child.stdin,
      kill(child, signal) {
        // sudo relays a signal to the command; the rest of the worker's processes are found by user.
        if (child.exitCode === null && child.signalCode === null) {
          try {
            process.kill(child.pid, signal);
          } catch { /* gone */ }
        }
        killUser(sb, signal);
      },
      alive: () => uidProcesses(sb.uid) !== 0,
      pollMs: 25,
    };
  }

  /** Run `command` as the sandbox's user in `cwd` (inside sb.work); always destroys the sandbox. */
  async function runIn(sb, command, cwd, opts) {
    const env = workerEnv(opts.env, opts.envAllow || [], sb);
    let res;
    try {
      res = await runWith(launcherFor(sb), command, { ...opts, cwd, env });
    } finally {
      if (!opts.keepSandbox) destroy(sb);
    }
    return { ...res, isolation: { mode: 'user', uid: sb.uid } };
  }

  function requirePlatform() {
    if (platform !== 'linux') throw new IsolationError(`isolation unavailable: isolated checks need Linux (this is ${platform})`);
    if (!fs.existsSync('/proc/self/status')) throw new IsolationError('isolation unavailable: /proc can\'t be read');
    const r = spawnSync(sudo, ['-n', 'true'], { stdio: 'ignore', timeout: 30_000 });
    if (r.error || r.status !== 0) throw new IsolationError(`isolation unavailable: passwordless ${sudo} is needed to create worker users${r.error ? ` (${r.error.message})` : ''}`);
  }

  return {
    kind: 'isolated',
    isolation: Object.freeze({ mode: 'user', secure: true, detail: 'each check ran as a fresh unprivileged user, with no access to pocp, the job\'s files or its tokens' }),

    /**
     * Before any of the pull request's code runs: check the host can isolate, make $HOME and
     * RUNNER_TEMP private, and run a probe as a worker that must find it can't reach what it
     * shouldn't. `protect` adds paths: { path, deny: 'write' | 'all' }.
     */
    async prepare({ root, protect = [] } = {}) {
      requirePlatform();
      const me = process.getuid();
      const privateDirs = [os.homedir(), process.env.RUNNER_TEMP].filter(Boolean);
      for (const d of privateDirs) {
        try {
          const st = fs.statSync(d);
          if (st.uid === me && (st.mode & 0o077)) fs.chmodSync(d, st.mode & 0o700);
        } catch { /* the probe decides */ }
      }
      // The node verify runs on must not be replaceable by a worker. actions/setup-node unpacks
      // Node into the tool cache writable by everyone, so take group and other write off the
      // installation and the folders above it that this user owns. The probe checks the rest.
      const nodeHome = path.resolve(path.dirname(process.execPath), '..');
      dropOthersWrite(nodeHome, me);
      const nodeAncestors = [];
      for (let d = nodeHome; d !== path.dirname(d); d = path.dirname(d)) nodeAncestors.push(d);
      for (const d of nodeAncestors) {
        try {
          const st = fs.lstatSync(d);
          if (st.uid === me && st.isDirectory() && (st.mode & 0o022)) fs.chmodSync(d, st.mode & ~0o022 & 0o7777);
        } catch { /* the probe decides */ }
      }
      const fileCommandDirs = CI_STEP_VARS.map((k) => process.env[k]).filter(Boolean).map((f) => path.dirname(f));
      const targets = [
        ...privateDirs.map((p) => ({ path: p, deny: 'all' })),
        ...fileCommandDirs.map((p) => ({ path: p, deny: 'all' })),
        ...CI_STEP_VARS.map((k) => process.env[k]).filter(Boolean).map((p) => ({ path: p, deny: 'all' })),
        { path: POCP_ROOT, deny: 'write' },
        { path: path.join(POCP_ROOT, 'src'), deny: 'write' },
        { path: path.join(POCP_ROOT, 'bin', 'pocp.js'), deny: 'write' },
        { path: process.execPath, deny: 'write' },
        { path: path.dirname(process.execPath), deny: 'write' },
        ...nodeAncestors.filter((d) => !fs.lstatSync(d).isSymbolicLink() && !(fs.lstatSync(d).mode & 0o1000)).map((d) => ({ path: d, deny: 'write' })),
        ...(root ? [{ path: root, deny: 'write' }, { path: path.join(root, '.proof'), deny: 'write' }, { path: path.join(root, '.git'), deny: 'write' }] : []),
        { path: '/var/run/docker.sock', deny: 'all' },
        ...protect,
      ];
      const script = [
        'for a; do k=${a%%:*}; p=${a#*:}',
        '  [ -e "$p" ] || [ -L "$p" ] || continue',
        '  if [ -w "$p" ]; then echo "can write $p"; fi',
        '  if [ "$k" = all ] && [ -r "$p" ]; then echo "can read $p"; fi',
        'done',
        // Every process of pocp's user: the worker must neither read its environment (the job's
        // tokens are in the runner's) nor signal it.
        'for d in /proc/[0-9]*; do',
        '  u=$(sed -n "s/^Uid:[[:space:]]*\\([0-9]*\\).*/\\1/p" "$d/status" 2>/dev/null) || continue',
        '  [ "$u" = "$POCP_CONTROLLER_UID" ] || continue',
        '  if cat "$d/environ" >/dev/null 2>&1; then echo "can read the environment of process ${d#/proc/}"; fi',
        '  if kill -0 "${d#/proc/}" 2>/dev/null; then echo "can signal process ${d#/proc/}"; fi',
        'done',
        'if sudo -n true >/dev/null 2>&1; then echo "can use sudo"; fi',
        'echo probe-ok',
      ].join('\n');
      const quote = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;
      const command = `/bin/sh -c ${quote(script)} probe ${targets.map((t) => quote(`${t.deny}:${t.path}`)).join(' ')}`;
      const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'pocp-probe-'));
      let res;
      try {
        const sb = makeSandbox(empty);
        res = await runIn(sb, command, sb.work, { env: { PATH: process.env.PATH, POCP_CONTROLLER_UID: String(me) }, envAllow: ['POCP_CONTROLLER_UID'], timeoutMs: 60_000, killGraceMs: 1_000 });
      } finally {
        fs.rmSync(empty, { recursive: true, force: true });
      }
      const lines = (res.output || '').split('\n').map((l) => l.trim()).filter(Boolean);
      const findings = lines.filter((l) => l !== 'probe-ok');
      if (res.exit !== 0 || lines[lines.length - 1] !== 'probe-ok' || findings.length) {
        const why = findings.length ? findings.join('; ') : `the probe did not finish (exit ${res.exit}${res.signal ? `, ${res.signal}` : ''}${res.timed_out ? ', timed out' : ''}${res.error ? `, ${res.error}` : ''})`;
        throw new IsolationError(`isolation unavailable: a worker ${findings.length ? 'could reach what it must not' : 'could not be started'}: ${why}`, { findings });
      }
      prepared = true;
      return { ok: true, probed: targets.length };
    },

    /**
     * Run one check. `root` is the snapshot (cwd is inside it): the worker gets its own copy of
     * it, so nothing it does reaches pocp's snapshot or another check's. Throws IsolationError
     * when a worker can't be set up or cleaned up; verify then fails.
     */
    async run(command, opts = {}) {
      if (!prepared) throw new IsolationError('isolation unavailable: the isolated runner was not prepared (prepare() runs the preflight probe)');
      const root = path.resolve(opts.root || opts.cwd);
      const cwd = path.resolve(opts.cwd || root);
      if (!inside(root, cwd)) throw new IsolationError(`isolation unavailable: check folder ${cwd} is outside its snapshot ${root}`);
      const sb = makeSandbox(root);
      return runIn(sb, command, path.join(sb.work, path.relative(root, cwd)), opts);
    },

    /**
     * Install dependencies isolated: run `command` as a worker in a copy of `dir` (the head's
     * files), then move the folders `links` names (node_modules, ...) to a sealed place owned by
     * root and read-only to every worker, and link snapshots to it from then on. Throws when
     * the install fails: verify can't judge checks without their dependencies.
     */
    async installDeps(command, { dir, links = [], timeoutMs = 600_000, killGraceMs = 5_000, logFile = null, logCapBytes, envAllow = [], env = process.env } = {}) {
      if (!prepared) throw new IsolationError('isolation unavailable: the isolated runner was not prepared');
      const rels = links.map((l) => path.normalize(String(l))).filter((l) => l && !path.isAbsolute(l) && !l.split(path.sep).includes('..') && l !== '.');
      const sb = makeSandbox(dir, { deps: true });
      const res = await runIn(sb, command, sb.work, { env, envAllow, timeoutMs, killGraceMs, logFile, logCapBytes, keepSandbox: true });
      try {
        if (res.exit !== 0 || res.timed_out || res.error) {
          const why = res.timed_out ? 'timed out' : res.error ? res.error : res.signal ? `killed by ${res.signal}` : `exit ${res.exit}`;
          const err = new IsolationError(`dependency install "${command}" failed (${why})${logFile ? `; output in ${logFile}` : ''}`);
          err.code = 'install_failed';
          throw err;
        }
        // Stop everything the install left running before touching its files.
        for (let i = 0; i < 100 && uidProcesses(sb.uid) !== 0; i++) {
          killUser(sb, 'SIGKILL');
          sleepSync(20);
        }
        if (uidProcesses(sb.uid) !== 0) throw new IsolationError('isolation failed: the install\'s processes could not be killed');
        // The worker moves its own folders (with only its own rights, so a symlink it planted
        // gets it nothing), then root seals them: no set-id bits, owned by root, read-only.
        const move = 'src=$1; dst=$2; shift 2; for rel; do if [ -d "$src/$rel" ] && [ ! -L "$src/$rel" ]; then mkdir -p "$dst/$(dirname "$rel")" && mv -- "$src/$rel" "$dst/$rel" || exit 1; fi; done';
        if (rels.length) asRoot([...dropTo(sb), '/bin/sh', '-c', move, 'move', sb.work, sb.deps, ...rels]);
        for (let i = 0; i < 20 && uidProcesses(sb.uid) !== 0; i++) killUser(sb, 'SIGKILL');
        asRoot(['chmod', '-R', 'u-s,g-s,go-w,a+rX', '--', sb.deps]);
        asRoot(['chown', '-R', '-P', '-h', '0:0', '--', sb.deps]);
        const setid = asRoot(['find', sb.deps, '-xdev', '-perm', '/6000', '-print', '-quit']).trim();
        if (setid) throw new IsolationError(`isolation failed: the install left a set-id file (${setid})`);
      } catch (err) {
        destroy(sb, { quiet: true });
        try {
          asRoot(['rm', '-rf', '--one-file-system', '--', sb.base]);
        } catch { /* best effort */ }
        throw err;
      }
      destroy(sb, { keep: [] });
      // The sealed folders stay until pocp exits.
      onCleanup(() => {
        try {
          spawnSync(sudo, ['-n', '--', 'rm', '-rf', '--one-file-system', '--', sb.base], { stdio: 'ignore', timeout: 60_000 });
        } catch { /* best effort */ }
      });
      useDependencyRoot(sb.deps);
      return { depsRoot: sb.deps, installed: rels.filter((r) => fs.existsSync(path.join(sb.deps, r))), result: res };
    },
  };
}
