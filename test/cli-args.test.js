// The command line: help and version anywhere, a declared option schema per command, and
// every option the repository's own workflows, templates and docs use still parses.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pocp, sampleRepo } from './helpers.js';
import { COMMANDS, commandHelp, flagsFor, parseArgs, suggest } from '../src/cli-args.js';
import { VERSION } from '../src/engine.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PKG_VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const outsideRepo = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pocp-cliargs-')));

test('the version comes from package.json', () => {
  assert.equal(VERSION, PKG_VERSION);
});

test('--version, -v, -V and version print "pocp <version>" inside and outside a repository', () => {
  const inside = sampleRepo();
  const outside = outsideRepo();
  for (const dir of [inside, outside]) {
    for (const args of [['--version'], ['-v'], ['-V'], ['version'], ['status', '--version']]) {
      const r = pocp(dir, args);
      assert.equal(r.code, 0, `${args.join(' ')} in ${dir}: ${r.stderr}`);
      assert.equal(r.stdout, `pocp ${PKG_VERSION}\n`, args.join(' '));
      assert.equal(r.stderr, '');
    }
    assert.equal(pocp(dir, ['--version', '--json']).json.version, PKG_VERSION);
  }
  fs.rmSync(outside, { recursive: true, force: true });
});

test('-h, --help and help print the help inside and outside a repository; no command is exit 2', () => {
  const inside = sampleRepo();
  const outside = outsideRepo();
  for (const dir of [inside, outside]) {
    for (const args of [['-h'], ['--help'], ['help']]) {
      const r = pocp(dir, args);
      assert.equal(r.code, 0, `${args.join(' ')}: ${r.stderr}`);
      assert.match(r.stdout, /Proof of Change Protocol/);
      assert.doesNotMatch(r.stderr, /git repository/);
    }
    const none = pocp(dir, []);
    assert.equal(none.code, 2);
    assert.match(none.stdout, /Usage: pocp <command>/);
  }
  fs.rmSync(outside, { recursive: true, force: true });
});

test('an unknown command is reported before any repository is looked for, with a suggestion', () => {
  const outside = outsideRepo();
  const r = pocp(outside, ['nope']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /unknown command "nope" \(try "pocp help"\)/);
  assert.doesNotMatch(r.stderr, /git repository/);
  const typo = pocp(outside, ['verfy']);
  assert.equal(typo.code, 2);
  assert.match(typo.stderr, /unknown command "verfy"; did you mean "verify"\?/);
  fs.rmSync(outside, { recursive: true, force: true });
});

test('an unknown option is an error naming the command, and never takes the next argument', () => {
  const outside = outsideRepo();
  const r = pocp(outside, ['verify', '--bogus', 'HEAD']);
  assert.equal(r.code, 2);
  assert.equal(r.stderr, 'pocp: unknown option "--bogus" for "verify" (try "pocp help verify")\n');
  // With --help as well, parsing finishes and shows HEAD stayed a positional argument.
  assert.deepEqual(parseArgs(['verify', '--bogus', 'HEAD', '--help']).positional, ['verify', 'HEAD']);
  assert.throws(() => parseArgs(['status', '-x']), /unknown option "-x" for "status"/);
  assert.throws(() => parseArgs(['--bogus']), /unknown option "--bogus" \(try "pocp help"\)/);
  // An option another command has is still unknown here.
  assert.throws(() => parseArgs(['gate', '--rerun']), /unknown option "--rerun" for "gate"/);
  fs.rmSync(outside, { recursive: true, force: true });
});

test('a near miss gets a did-you-mean', () => {
  assert.throws(() => parseArgs(['verify', '--rerunn']), /did you mean "--rerun"\?/);
  assert.throws(() => parseArgs(['verify', '--require-coverag']), /did you mean "--require-coverage"\?/);
  assert.throws(() => parseArgs(['open', '--intnet', 'x']), /did you mean "--intent"\?/);
  assert.equal(suggest('zzzzzz', ['rerun', 'json']), null, 'nothing close: no suggestion');
});

test('with --json, a command-line error is a JSON envelope', () => {
  const outside = outsideRepo();
  const r = pocp(outside, ['verify', '--bogus', '--json']);
  assert.equal(r.code, 2);
  assert.equal(r.json.ok, false);
  assert.match(r.json.error, /unknown option "--bogus" for "verify"/);
  fs.rmSync(outside, { recursive: true, force: true });
});

test('help for one command: "pocp help <cmd>", "<cmd> --help" and "<cmd> -h" print only its usage', () => {
  const outside = outsideRepo();
  for (const args of [['help', 'verify'], ['verify', '--help'], ['verify', '-h'], ['verify', '--bogus', '--help']]) {
    const r = pocp(outside, args);
    assert.equal(r.code, 0, `${args.join(' ')}: ${r.stderr}`);
    assert.match(r.stdout, /Usage: pocp verify/);
    assert.match(r.stdout, /--accept-test-change\[=<sha>\]/);
    assert.doesNotMatch(r.stdout, /miss record|Proof of Change Protocol/, 'not the full help');
  }
  const bad = pocp(outside, ['help', 'nope']);
  assert.equal(bad.code, 2);
  assert.match(bad.stderr, /unknown command "nope"/);
  fs.rmSync(outside, { recursive: true, force: true });
});

test('each command\'s help lists exactly the options it accepts', () => {
  for (const cmd of Object.keys(COMMANDS)) {
    const help = commandHelp(cmd, VERSION);
    const listed = new Set([...help.matchAll(/^ {2}--([a-z][a-z-]*)/gm)].map((m) => m[1]));
    assert.deepEqual([...listed].sort(), Object.keys(flagsFor(cmd)).sort(), cmd);
  }
});

test('every option in the full help is accepted by some command', () => {
  const r = pocp(ROOT, ['help']);
  const accepted = new Set(Object.keys(COMMANDS).flatMap((c) => Object.keys(flagsFor(c))));
  const mentioned = new Set([...r.stdout.matchAll(/--([a-z][a-z-]*)/g)].map((m) => m[1]));
  for (const f of mentioned) assert.ok(accepted.has(f), `--${f} is in the help but no command accepts it`);
  // The workflows decide which approvals to pass by reading this help.
  for (const f of ['--accept-uncovered', '--accept-inconclusive', '--exit-detail']) assert.ok(r.stdout.includes(f), f);
});

test('approvals: bare, =true, =false or a sha; anything else, or two different values, is refused', () => {
  const v = (...a) => parseArgs(['verify', 'b..h', ...a]).flags;
  assert.equal(v('--accept-test-change')['accept-test-change'], true);
  assert.equal(v('--accept-test-change=true')['accept-test-change'], true);
  assert.equal(v('--accept-test-change=false')['accept-test-change'], false);
  assert.equal(v('--accept-test-change=abc1234')['accept-test-change'], 'abc1234');
  assert.equal(v('--accept-test-change=abc1234', '--accept-test-change=abc1234')['accept-test-change'], 'abc1234', 'the same value twice is not ambiguous');
  assert.throws(() => v('--accept-test-change=main'), /--accept-test-change takes a commit sha/);
  assert.throws(() => v('--accept-test-change='), /--accept-test-change takes a commit sha/);
  assert.throws(() => v('--accept-test-change=abc1234', '--accept-test-change=def5678'), /more than once with different values/);
  assert.throws(() => v('--accept-policy-change=false', '--accept-policy-change'), /more than once with different values/);
  // A separate word is never taken as an approval's value.
  assert.deepEqual(parseArgs(['verify', '--accept-test-change', 'b..h']).positional, ['verify', 'b..h']);
  assert.throws(() => v('--accept-something=abc'), /unknown approval --accept-something: this pocp supports --accept-test-change, --accept-policy-change, --accept-uncovered, --accept-inconclusive/);
});

test('values: missing, starting with "--", ill-typed numbers, repeated single values', () => {
  assert.throws(() => parseArgs(['open', '--intent']), /--intent needs a value$/);
  assert.throws(() => parseArgs(['open', '--intent', '--json']), /--intent needs a value \(to give one that starts with "-", write --intent=<value>\)/);
  assert.equal(parseArgs(['open', '--intent=--odd', '--touch', 'a']).flags.intent, '--odd');
  assert.equal(parseArgs(['add', 'p', '--command', 'x', '--expect', '-1']).obligations[0].expect, '-1', 'a single dash value is a value');
  assert.throws(() => parseArgs(['eval', '--jobs', 'four']), /--jobs needs a whole number, got "four"/);
  assert.throws(() => parseArgs(['add', 'p', '--test', 't', '--timeout', '5s']), /--timeout needs a whole number/);
  assert.equal(parseArgs(['add', 'p', '--test', 't', '--timeout', '500']).obligations[0].timeout_ms, 500);
  assert.throws(() => parseArgs(['open', '--intent', 'a', '--intent', 'b']), /--intent is given more than once/);
  assert.deepEqual(parseArgs(['verify', '--ci-results', 'a', '--ci-results=b']).flags['ci-results'], ['a', 'b']);
  assert.throws(() => parseArgs(['verify', '--rerun=yes']), /--rerun takes no value/);
  assert.equal(parseArgs(['verify', '--rerun=false']).flags.rerun, false);
  // `miss record --check <cmd>` takes a command; `ci required --check` is a switch.
  assert.equal(parseArgs(['miss', 'record', '--check', 'npm test']).flags.check, 'npm test');
  assert.equal(parseArgs(['ci', 'required', '--check']).flags.check, true);
  // Options may come before the command.
  assert.equal(parseArgs(['--json', 'status']).command, 'status');
  assert.equal(parseArgs(['--by', 'me', 'open', '--intent', 'x']).flags.by, 'me');
});

/** Every `pocp <command> ... --flag` in the files that ship or run pocp. */
function documentedInvocations() {
  const files = [];
  const walk = (d) => {
    if (!fs.existsSync(path.join(ROOT, d))) return;
    for (const e of fs.readdirSync(path.join(ROOT, d), { withFileTypes: true })) {
      const rel = path.join(d, e.name);
      if (e.isDirectory()) walk(rel);
      else if (/\.(md|ya?ml|m?js|sh|json)$/.test(e.name)) files.push(rel);
    }
  };
  for (const d of ['docs', 'examples', '.github', 'status', 'src']) walk(d);
  for (const f of ['README.md', 'SPEC.md', 'REVIEWING.md', 'action.yml']) if (fs.existsSync(path.join(ROOT, f))) files.push(f);
  const found = [];
  const re = /\bpocp(?:\.js)?\s+([a-z][a-z-]*)((?:(?!\bpocp\b)[^`'"|;&)\n])*)/g;
  for (const f of files) {
    const text = fs.readFileSync(path.join(ROOT, f), 'utf8');
    for (const m of text.matchAll(re)) {
      if (!COMMANDS[m[1]]) continue;
      for (const fl of m[2].matchAll(/(?:^|\s|\[)--([a-z][a-z-]*)/g)) found.push({ file: f, cmd: m[1], flag: fl[1] });
    }
  }
  return found;
}

test('every option the repository\'s docs, templates and workflows use is still accepted', () => {
  const found = documentedInvocations();
  assert.ok(found.length > 30, `scanned ${found.length} uses`);
  for (const { file, cmd, flag } of found) assert.ok(flagsFor(cmd)[flag], `${file}: pocp ${cmd} --${flag}`);
  // The verify step's arguments, as the workflow and the action build them.
  const wf = fs.readFileSync(path.join(ROOT, '.github/workflows/pocp.yml'), 'utf8');
  const set = wf.split('\n').find((l) => l.trim().startsWith('set -- --rerun'));
  const args = set.trim().replace(/^set -- /, '').split(/\s+/).map((a) => a.replace(/="\$\w+"$/, '=abc1234'));
  assert.ok(parseArgs(['verify', 'b..h', ...args, '--accept-uncovered=abc1234', '--accept-inconclusive=abc1234', '--exit-detail']));
  assert.ok(parseArgs(['verify', 'b..h', ...args.map((a) => a.replace('=abc1234', '=false'))]));
  const action = fs.readFileSync(path.join(ROOT, 'action.yml'), 'utf8');
  const actionFlags = [...action.matchAll(/args\+=\("?(--[a-z-]+)/g)].map((m) => m[1]);
  assert.ok(actionFlags.length >= 6, actionFlags.join(' '));
  for (const f of actionFlags) assert.ok(flagsFor('verify')[f.slice(2)], `action.yml: verify ${f}`);
  assert.ok(parseArgs(['verify', 'b..h', '--rerun', '--ci-results', 'r.jsonl', '--accept-policy-change=abc1234', '--require-coverage', '--exit-detail']));
});

test('the git hooks pocp installs call commands that parse', async () => {
  const { hookBodies } = await import('../src/init.js');
  const bodies = Object.values(hookBodies('/x/bin/pocp.js')).join('\n');
  for (const m of bodies.matchAll(/pocp_run ([a-z-]+)((?: --?[a-z-]+)*)/g)) {
    assert.ok(parseArgs([m[1], ...m[2].trim().split(/\s+/).filter(Boolean)]), m[0]);
  }
});
