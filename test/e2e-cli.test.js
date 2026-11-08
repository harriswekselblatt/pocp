// Human-readable output and usage errors for every command.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { git, packetId, pocp, sampleRepo, sh, write } from './helpers.js';
import { BREAK_ADD, TWEAK_ADD, commit } from './fixtures.js';

test('usage errors exit 2 with a message', () => {
  const dir = sampleRepo();
  const cases = [
    [['open'], /needs --intent/],
    [['open', '--intent', 'x'], /at least one --touch/],
    [['add', 'p-1'], /usage: pocp add/],
    [['widen', 'p-1'], /usage: pocp widen/],
    [['ready'], /usage: pocp ready/],
    [['attest', 'p-1'], /usage: pocp attest/],
    [['abandon', 'p-1'], /usage: pocp abandon/],
    [['show'], /usage: pocp show/],
    [['blame'], /usage: pocp blame/],
    [['miss'], /usage: pocp miss record\|close\|list/],
    [['miss', 'close'], /usage: pocp miss close/],
    [['rules'], /usage: pocp rules check/],
    [['hooks'], /usage: pocp hooks/],
    [['check-edit'], /usage: pocp check-edit/],
    [['eval', '--mutants', '0'], /usage: pocp eval/],
    [['eval', '--mutants', 'x'], /usage: pocp eval/],
    [['trailer', '/nonexistent/msg'], /no such message file: \/nonexistent\/msg/],
    [['nope'], /unknown command "nope"/],
    [['open', '--intent'], /--intent needs a value/],
    [['miss', 'record', '--description', 'x', '--stage', 'later', '--file', 'a'], /stage must be one of/],
    [['miss', 'record', '--description', 'x', '--stage', 'ci', '--severity', 'meh', '--file', 'a'], /severity must be one of/],
    [['miss', 'record', '--description', 'x', '--stage', 'ci'], /at least one file/],
    [['miss', 'record', '--stage', 'ci', '--file', 'a'], /needs a description/],
    [['open', '--intent', 'x', '--touch', '/abs'], /repo-relative/],
  ];
  for (const [args, re] of cases) {
    const r = pocp(dir, args);
    assert.equal(r.code, 2, `${args.join(' ')} → ${r.code}: ${r.stderr}`);
    assert.match(r.stderr, re, args.join(' '));
  }
  const j = pocp(dir, ['open', '--json']);
  assert.equal(j.code, 2);
  assert.equal(j.json.ok, false);
  assert.match(j.json.error, /needs --intent/);
});

test('engine errors exit 1; outside a repo exits 2', () => {
  const dir = sampleRepo();
  assert.equal(pocp(dir, ['show', 'p-nothere']).code, 1);
  assert.match(pocp(dir, ['show', 'p-nothere']).stderr, /no packet "p-nothere"/);
  assert.match(pocp(dir, ['miss', 'close', 'm-nothere']).stderr, /no miss "m-nothere"/);
  const outside = fs.mkdtempSync(path.join(fs.realpathSync('/tmp'), 'pocp-norepo-'));
  const r = pocp(outside, ['status']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /not inside a git repository/);
});

test('help and version', () => {
  const dir = sampleRepo();
  const h = pocp(dir, ['help']);
  assert.equal(h.code, 0);
  assert.match(h.stdout, /Proof of Change Protocol/);
  assert.match(h.stdout, /Exit codes: 0 ok, 1 blocked/);
  assert.equal(pocp(dir, []).code, 2, 'no command is a usage error');
  assert.equal(pocp(dir, ['--help']).code, 0);
  // "pocp <version>", semantic versioning, pre-releases included (1.0.0-rc.1).
  assert.match(pocp(dir, ['version']).stdout, /^pocp \d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?\n$/);
  assert.equal(`pocp ${pocp(dir, ['version', '--json']).json.version}`, pocp(dir, ['version']).stdout.trim());
});

test('a full session in plain text', () => {
  const dir = sampleRepo({ hooks: true });
  assert.match(pocp(dir, ['status']).stdout, /no active packets/);
  assert.match(pocp(dir, ['packets']).stdout, /no packets/);
  assert.match(pocp(dir, ['miss', 'list']).stdout, /no misses/);
  assert.match(pocp(dir, ['prove']).stdout, /nothing to prove/);
  assert.match(pocp(dir, ['sync']).stdout, /no active packets/);
  assert.match(pocp(dir, ['rules', 'check']).stdout, /rules: ok/);
  assert.match(pocp(dir, ['trailer']).stdout, /^$/);
  assert.match(pocp(dir, ['gate']).stdout, /gate passed \(no packet needed for 0 file\(s\)\)/);

  write(dir, 'src/math.js', TWEAK_ADD);
  git(dir, 'add', 'src/math.js');
  const opened = pocp(dir, ['open', '--intent', 'Tweak add', '--touch', 'src/math.js', '--draft', '--command', 'node --check src/math.js']);
  assert.match(opened.stdout, /o1 \[author\] command: node --check src\/math\.js/);
  assert.match(opened.stdout, /o2 \[rule:math-tests\] test: node test\/math\.check\.mjs/);
  assert.match(opened.stdout, /next: pocp prove p-/);
  const id = packetId(opened.stdout);
  assert.match(pocp(dir, ['packets']).stdout, new RegExp(`${id}  draft`));
  const g0 = pocp(dir, ['gate']);
  assert.match(g0.stderr, /is a draft and covers nothing until "pocp ready/);
  assert.match(pocp(dir, ['ready', id]).stdout, new RegExp(`${id} is open`));
  assert.match(pocp(dir, ['ready', id]).stderr, /not draft/);

  const blocked = pocp(dir, ['gate']);
  assert.equal(blocked.code, 1);
  assert.match(blocked.stderr, /commit blocked/);
  assert.match(blocked.stderr, /needs proof: o1, o2  →  pocp prove/);
  assert.match(pocp(dir, ['status']).stdout, new RegExp(`${id} open: Tweak add\\n  proven 0/2`));

  const added = pocp(dir, ['add', id, '--manual', 'Read the diff']);
  assert.match(added.stdout, new RegExp(`added o3 to ${id}: manual: Read the diff`));
  assert.match(pocp(dir, ['widen', id, '--touch', 'src/other.js']).stdout, /now covers 2 path\(s\)/);
  assert.match(pocp(dir, ['sync', id]).stdout, new RegExp(`${id}: up to date`));

  const proved = pocp(dir, ['prove', id]);
  assert.equal(proved.code, 0);
  assert.match(proved.stdout, /subject sha256:[0-9a-f]{12} \(clean mode\)/);
  assert.match(proved.stdout, /o1: pass \(\d+ms\)/);
  assert.match(proved.stdout, /needs sign-off: o3/);
  const again = pocp(dir, ['prove', id]);
  assert.match(again.stdout, /o1: skipped \(already proven for this subject\)/);
  const att = pocp(dir, ['attest', id, 'o3', '--by', 'me', '--note', 'fine']);
  assert.match(att.stdout, /o3 attested by me for sha256:/);
  assert.match(pocp(dir, ['trailer']).stdout, new RegExp(`^Proof-Of-Change: ${id} subject=`));
  assert.match(pocp(dir, ['gate']).stdout, /gate passed \(1 packet\(s\) proven for sha256:/);
  assert.match(pocp(dir, ['status']).stdout, /proven 2\/2 · attested 1\/1/);
  const shown = JSON.parse(pocp(dir, ['show', id.slice(0, 6)]).stdout);
  assert.equal(shown.id, id, 'prefix lookup');

  commit(dir, 'Tweak add');
  assert.match(pocp(dir, ['land']).stdout, new RegExp(`landed ${id} in [0-9a-f]{12}`), 'land reports; running it twice changes nothing');
  assert.match(pocp(dir, ['land', '--rev', 'HEAD~1']).stdout, /no packets landed in this commit/);
  assert.match(pocp(dir, ['packets', '--all']).stdout, new RegExp(`${id}  landed`));
  assert.match(pocp(dir, ['blame', 'src/math.js']).stdout, new RegExp(`[0-9a-f]{12}  ${id}`));
  assert.match(pocp(dir, ['blame', 'README.md']).stdout, /no packets have changed this file/);
  const v = pocp(dir, ['verify']);
  assert.match(v.stdout, /^verified: [0-9a-f]{12} subject sha256:[0-9a-f]{12} · \d{1,6}ms/, 'elapsed time, not a timestamp');
  assert.match(v.stdout, new RegExp(`${id}: ok`));
  const m = pocp(dir, ['metrics']);
  assert.match(m.stdout, /packets: 1 \(landed 1\)/);
  assert.match(m.stdout, /proven share: 67%/);
  assert.match(m.stdout, /ratchet: 0 rule\(s\) from misses/);

  const rec = pocp(dir, ['miss', 'record', '--description', 'add is wrong', '--stage', 'review', '--file', 'src/math.js']);
  assert.match(rec.stdout, new RegExp(`recorded m-[0-9a-f]{8} \\(linked to ${id}\\)`));
  assert.match(rec.stdout, /next: add a rule with "source": "miss:m-/);
  assert.match(pocp(dir, ['miss', 'list']).stdout, /m-[0-9a-f]{8}  open   review     add is wrong/);

  write(dir, 'src/math.js', BREAK_ADD);
  git(dir, 'add', 'src/math.js');
  const id2 = packetId(pocp(dir, ['open', '--intent', 'break', '--touch', 'src/math.js']).stdout);
  const fail = pocp(dir, ['prove', id2]);
  assert.equal(fail.code, 1);
  assert.match(fail.stdout, /o1: FAIL exit=1 · log \.proof\/runs\/r-[0-9a-f]{8}\.log/);
  assert.match(pocp(dir, ['gate']).stderr, /failed: o1/);
  assert.match(pocp(dir, ['abandon', id2, '--reason', 'no']).stdout, new RegExp(`${id2} abandoned`));
});

test('verify prints problems, coverage and reruns in plain text', () => {
  const dir = sampleRepo();
  const base = git(dir, 'rev-parse', 'HEAD');
  write(dir, 'src/math.js', TWEAK_ADD);
  git(dir, 'add', 'src/math.js');
  git(dir, 'commit', '-q', '--no-verify', '-m', 'unproven');
  const v = pocp(dir, ['verify', 'HEAD', '--require-coverage']);
  assert.equal(v.code, 1);
  assert.match(v.stdout, /NOT verified/);
  assert.match(v.stdout, /note: commit has no Proof-Of-Change trailers/);
  assert.match(v.stdout, /not covered: src\/math\.js/);
  const r = pocp(dir, ['verify', `${base}..HEAD`, '--require-coverage']);
  assert.match(r.stdout, /NOT verified: 1 commit\(s\) in \S+ · \d{1,6}ms/);
  assert.match(r.stdout, /BAD [0-9a-f]{12}: not covered: src\/math\.js/);
});

test('eval and history in plain text', () => {
  const dir = sampleRepo();
  const e = pocp(dir, ['eval', '--mutants', '3', '--jobs', '2', '--missed']);
  assert.equal(e.code, 0, e.stderr);
  assert.match(e.stdout, /mutation eval: caught \d+\/3 \(\d+%\) of \d+ sites · 2 workers · \d+s/);
  const all = pocp(dir, ['eval', '--mutants', '3', '--jobs', '2']);
  assert.equal(all.stdout.split('\n').filter((l) => /^\s+(caught|MISSED)/.test(l)).length, 3, 'without --missed every mutant is listed');
  const h = pocp(dir, ['history', '--commits', '5']);
  assert.match(h.stdout, /gate replay: \d+ of the last 1 commits would have needed a packet/);
  assert.match(h.stdout, /fix replay: skipped/);
  write(dir, '.proof/rules.json', '{"pocp":1,"requirements":[]}');
  const none = pocp(dir, ['eval', '--mutants', '2']);
  assert.equal(none.code, 1);
  assert.match(none.stdout, /no source files are guarded/);
});

test('init and hooks in plain text', () => {
  const dir = sampleRepo();
  assert.match(pocp(dir, ['init']).stdout, /\.proof\/ already set up\nhooks not installed/);
  assert.match(pocp(dir, ['hooks', 'install']).stdout, /hooks installed in /);
  assert.match(pocp(dir, ['hooks', 'uninstall']).stdout, /removed pocp from 3 hook\(s\)/);
  assert.match(pocp(dir, ['hooks', 'uninstall']).stdout, /no pocp hooks found/);
  git(dir, 'config', 'core.hooksPath', '/tmp/shared');
  const r = pocp(dir, ['init', '--hooks']);
  assert.equal(r.code, 2);
  assert.match(r.stdout, /hooks not installed: core\.hooksPath/);
});

test('check-edit and the trailer file hook in plain text', () => {
  const dir = sampleRepo();
  const c = pocp(dir, ['check-edit', 'src/math.js']);
  assert.equal(c.code, 1);
  assert.match(c.stderr, /open a packet before editing src\/math\.js/);
  assert.match(pocp(dir, ['check-edit', 'README.md']).stdout, /ok: not protected/);
  pocp(dir, ['open', '--intent', 'x', '--touch', 'src/**']);
  assert.match(pocp(dir, ['check-edit', 'src/math.js']).stdout, /ok: covered by an open packet \(src\/math\.js\)/);
  const msg = path.join(dir, '.git', 'MSG');
  fs.writeFileSync(msg, 'subject\n');
  assert.equal(pocp(dir, ['trailer', msg]).code, 0);
  assert.equal(fs.readFileSync(msg, 'utf8'), 'subject\n', 'nothing proven, nothing added');
});

test('a failing trailer step aborts the commit, even with --no-verify', () => {
  const dir = sampleRepo({ hooks: true });
  write(dir, 'README.md', 'changed\n');
  git(dir, 'add', 'README.md');
  const r = sh(dir, 'git', ['commit', '--no-verify', '-m', 'x'], { env: { POCP_BIN: 'false' }, allowFail: true });
  assert.notEqual(r.status, 0, 'prepare-commit-msg failure stops the commit');
});

test('clean-mode refusals name the offending files', () => {
  const dir = sampleRepo();
  write(dir, 'src/math.js', TWEAK_ADD);
  git(dir, 'add', 'src/math.js');
  write(dir, 'src/math.js', BREAK_ADD);
  const id = packetId(pocp(dir, ['open', '--intent', 'x', '--touch', 'src/math.js']).stdout);
  const r = pocp(dir, ['prove', id]);
  assert.match(r.stderr, /tracked files differ from what is staged: src\/math\.js/);
});

test('survivors: explicit revisions, rules check JSON, config errors, eval of one mutant and survivor display', () => {
  const dir = sampleRepo();
  const base = git(dir, 'rev-parse', 'HEAD');
  write(dir, 'README.md', 'x\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '--no-verify', '-m', 'second');
  assert.equal(pocp(dir, ['verify', base, '--json']).json.commit, base, 'the given revision is verified');
  assert.equal(pocp(dir, ['rules', 'check', '--json']).json.ok, true);
  write(dir, '.proof/rules.json', '{"pocp":1,"requirements":[{"id":"x"}]}');
  assert.equal(pocp(dir, ['rules', 'check', '--json']).json.ok, false);
  write(dir, '.proof/rules.json', '{broken');
  const bad = pocp(dir, ['status']);
  assert.equal(bad.code, 2, 'unreadable rules are a configuration error');
  assert.match(bad.stderr, /invalid JSON/);
  write(dir, '.proof/rules.json', JSON.stringify({ pocp: 1, requirements: [{ id: 'weak', glob: 'src/**', obligation: { kind: 'test', run: 'true' } }] }));
  const one = pocp(dir, ['eval', '--mutants', '1', '--missed']);
  assert.equal(one.code, 0, one.stderr);
  assert.match(one.stdout, /caught 0\/1/);
  assert.match(one.stdout, /MISSED  src\/math\.js:\d+ \S+\n      - .+\n      \+ .+/, 'survivors show the line before and after');
});

test('survivors 3: the GitHub summary names each commit\'s packets', () => {
  const dir = sampleRepo({ hooks: true });
  write(dir, 'src/math.js', TWEAK_ADD);
  git(dir, 'add', 'src/math.js');
  const id = packetId(pocp(dir, ['open', '--intent', 'x', '--touch', 'src/math.js']).stdout);
  pocp(dir, ['prove', id]);
  sh(dir, 'git', ['commit', '-m', 'x']);
  const summary = path.join(dir, '..', `${path.basename(dir)}-s.md`);
  pocp(dir, ['verify', 'HEAD'], { env: { GITHUB_STEP_SUMMARY: summary } });
  assert.match(fs.readFileSync(summary, 'utf8'), new RegExp(`\\| ${id} \\| ok \\|`));
});

test('eval --save and --replay through the CLI', () => {
  const dir = sampleRepo();
  const file = path.join(dir, '..', `${path.basename(dir)}-eval.json`);
  const s = pocp(dir, ['eval', '--mutants', '3', '--jobs', '2', '--save', file]);
  assert.equal(s.code, 0, s.stderr);
  assert.match(s.stdout, /saved to /);
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(saved.mutants.length, 3);
  assert.ok(saved.mutants.every((m) => typeof m.line_text === 'string' && typeof m.mutated_line === 'string'));
  const r = pocp(dir, ['eval', '--replay', file, '--json']);
  assert.equal(r.json.replayed, true);
  assert.equal(r.json.total, 3);
  assert.match(pocp(dir, ['eval', '--replay', file]).stdout, /mutation eval \(replayed sample\): caught \d+\/3/);
  assert.equal(pocp(dir, ['eval', '--replay', '/nope.json']).code, 2);
});
