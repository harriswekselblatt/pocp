import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { git, packetId, pocp, read, sampleRepo, sh, write, writeConfig, writeRules } from './helpers.js';
import { BREAK_ADD, TWEAK_ADD, NO_SSH_KEYGEN, commit, makeKey } from './fixtures.js';

test('host policy adds requirements and cannot loosen repo rules', () => {
  const dir = sampleRepo();
  const host = path.join(dir, '..', `host-${path.basename(dir)}.mjs`);
  fs.writeFileSync(host, `export default {
    name: 'acme',
    triggersFor() { return { globs: [{ glob: 'src/**', require_packet: false }], broad_files: 999 }; },
    requirementsFor(files) { return [{ id: 'syntax', glob: 'src/**', obligation: { kind: 'command', run: 'node --check src/math.js' } }]; },
    emit(type, payload) { if (type === 'packet.opened') process.stderr.write('HOST_EVENT ' + payload.id + '\\n'); },
  };\n`);
  write(dir, 'src/math.js', TWEAK_ADD);
  git(dir, 'add', 'src/math.js');
  const env = { POCP_HOST: host };
  const g = pocp(dir, ['gate', '--json'], { env });
  assert.equal(g.code, 1, 'host false did not exempt a repo-required file');
  const opened = pocp(dir, ['open', '--intent', 'x', '--touch', 'src/math.js', '--json'], { env });
  assert.match(opened.stderr, /HOST_EVENT p-/);
  const sources = opened.json.packet.obligations.map((o) => o.source);
  assert.deepEqual(sources, ['rule:math-tests', 'host:acme']);
  assert.equal(pocp(dir, ['prove', opened.json.packet.id], { env }).code, 0);
  assert.equal(pocp(dir, ['gate'], { env }).code, 0);
  assert.equal(pocp(dir, ['gate', '--no-host'], { env }).code, 0, 'repo rules alone are also satisfied');
});

test('verify catches forged trailers, missing packets and --no-verify commits', () => {
  const dir = sampleRepo({ hooks: true });
  // A commit that skipped the hooks entirely.
  write(dir, 'src/math.js', TWEAK_ADD);
  git(dir, 'add', 'src/math.js');
  git(dir, 'commit', '-q', '--no-verify', '-m', 'sneaky');
  const v1 = pocp(dir, ['verify', 'HEAD', '--require-coverage', '--json']);
  assert.equal(v1.code, 1);
  assert.deepEqual(v1.json.coverage.uncovered, ['src/math.js']);

  // A hand-typed trailer that points at nothing.
  git(dir, 'commit', '-q', '--no-verify', '--allow-empty', '-m', `fake\n\nProof-Of-Change: p-deadbeef subject=sha256:${'0'.repeat(12)} policy=sha256:${'0'.repeat(12)} proven=1/1 attested=0/0`);
  const v2 = pocp(dir, ['verify', 'HEAD', '--json']);
  assert.equal(v2.code, 1);
  assert.match(v2.json.packets[0].problems[0], /not in the commit/);
});

test('verify catches a real trailer copied onto different code', () => {
  const dir = sampleRepo({ hooks: true });
  write(dir, 'src/math.js', TWEAK_ADD);
  git(dir, 'add', 'src/math.js');
  const id = packetId(pocp(dir, ['open', '--intent', 'x', '--touch', 'src/math.js']).stdout);
  pocp(dir, ['prove', id]);
  commit(dir, 'real');
  const realTrailer = git(dir, 'log', '-1', '--format=%B').split('\n').find((l) => l.startsWith('Proof-Of-Change:'));
  assert.ok(realTrailer);
  // New, broken code committed with the old trailer pasted in, hooks skipped.
  write(dir, 'src/math.js', BREAK_ADD);
  git(dir, 'add', 'src/math.js');
  git(dir, 'commit', '-q', '--no-verify', '-m', `looks proven\n\n${realTrailer}`);
  const v = pocp(dir, ['verify', 'HEAD', '--json']);
  assert.equal(v.code, 1);
  const problems = v.json.packets[0].problems.join(' | ');
  assert.match(problems, /trailer subject does not match/);
  assert.match(problems, /no proof for o1 against this commit/);
});

test('amending drops the stale trailer; re-proving adds a fresh one', () => {
  const dir = sampleRepo({ hooks: true });
  write(dir, 'src/math.js', TWEAK_ADD);
  git(dir, 'add', 'src/math.js');
  const id = packetId(pocp(dir, ['open', '--intent', 'x', '--touch', 'src/math.js']).stdout);
  pocp(dir, ['prove', id]);
  commit(dir, 'real');
  // Re-open the landed work as a new packet for the amended code.
  write(dir, 'src/math.js', `${TWEAK_ADD}// amended\n`);
  git(dir, 'add', 'src/math.js');
  git(dir, 'commit', '-q', '--no-verify', '--amend', '--no-edit');
  assert.doesNotMatch(git(dir, 'log', '-1', '--format=%B'), /Proof-Of-Change/, 'old trailer removed');
  const v = pocp(dir, ['verify', 'HEAD', '--require-coverage', '--json']);
  assert.equal(v.code, 1, 'and the amended commit is not covered');

  const id2 = packetId(pocp(dir, ['open', '--intent', 'amended', '--touch', 'src/math.js']).stdout);
  assert.equal(pocp(dir, ['prove', id2]).code, 0);
  const r = sh(dir, 'git', ['commit', '--amend', '--no-edit']);
  assert.equal(r.status, 0, r.stderr);
  const msg = git(dir, 'log', '-1', '--format=%B');
  assert.equal((msg.match(/Proof-Of-Change:/g) || []).length, 1);
  assert.match(msg, new RegExp(id2));
  assert.equal(pocp(dir, ['verify', 'HEAD', '--require-coverage']).code, 0);
});

test('verify a range checks every non-merge commit', () => {
  const dir = sampleRepo({ hooks: true });
  const base = git(dir, 'rev-parse', 'HEAD');
  write(dir, 'src/math.js', TWEAK_ADD);
  git(dir, 'add', 'src/math.js');
  const id = packetId(pocp(dir, ['open', '--intent', 'x', '--touch', 'src/math.js']).stdout);
  pocp(dir, ['prove', id]);
  commit(dir, 'proven');
  write(dir, 'README.md', 'docs only\n');
  git(dir, 'add', 'README.md');
  commit(dir, 'docs');
  const ok = pocp(dir, ['verify', `${base}..HEAD`, '--require-coverage', '--json']);
  assert.equal(ok.code, 0, ok.stdout);
  assert.equal(ok.json.commits.length, 2);
  write(dir, 'src/math.js', BREAK_ADD);
  git(dir, 'add', 'src/math.js');
  git(dir, 'commit', '-q', '--no-verify', '-m', 'skip');
  const bad = pocp(dir, ['verify', `${base}..HEAD`, '--require-coverage', '--json']);
  assert.equal(bad.code, 1);
  assert.equal(bad.json.commits.filter((c) => !c.ok).length, 1);
});

test('signed proofs: valid for allowed signers, invalid if edited, skipped by --rerun-unsigned', { skip: NO_SSH_KEYGEN }, () => {
  const dir = sampleRepo({ hooks: true });
  const { key, pub } = makeKey(dir);
  write(dir, '.proof/allowed_signers', `dev@example.com namespaces="pocp-proof" ${pub}\n`);
  git(dir, 'add', '-A');
  git(dir, '-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', 'trust a signer');
  const env = { POCP_SIGN_KEY: key, POCP_SIGN_PRINCIPAL: 'dev@example.com' };
  write(dir, 'src/math.js', TWEAK_ADD);
  git(dir, 'add', 'src/math.js');
  const id = packetId(pocp(dir, ['open', '--intent', 'x', '--touch', 'src/math.js']).stdout);
  assert.equal(pocp(dir, ['prove', id], { env }).code, 0);
  const proof = JSON.parse(read(dir, `.proof/packets/${id}.json`)).proofs[0];
  assert.equal(proof.signature.principal, 'dev@example.com');
  assert.match(proof.signature.sig, /BEGIN SSH SIGNATURE/);
  commit(dir, 'signed change');

  const v = pocp(dir, ['verify', 'HEAD', '--rerun-unsigned', '--json']);
  assert.equal(v.code, 0, v.stdout);
  assert.equal(v.json.packets[0].signatures.valid, 1);
  assert.match(v.json.reruns[0].status, /signed by an allowed signer/, 'nothing re-ran');

  // Edit the committed proof (pretend it was faster) and the signature breaks.
  const file = path.join(dir, `.proof/packets/${id}.json`);
  const p = JSON.parse(fs.readFileSync(file, 'utf8'));
  p.proofs[0].duration_ms = 1;
  fs.writeFileSync(file, JSON.stringify(p));
  git(dir, 'add', file);
  git(dir, 'commit', '-q', '--no-verify', '--amend', '--no-edit', '-m', `tampered\n\n${git(dir, 'log', '-1', '--format=%B').split('\n').find((l) => l.startsWith('Proof-Of-Change'))}`);
  const t = pocp(dir, ['verify', 'HEAD', '--json']);
  assert.equal(t.code, 1);
  assert.match(t.json.packets[0].problems.join(' '), /invalid signature/);
});

test('a key that is not in allowed_signers does not count as signed', { skip: NO_SSH_KEYGEN }, () => {
  const dir = sampleRepo({ hooks: true });
  const trusted = makeKey(dir, 'trusted');
  const other = makeKey(dir, 'other');
  write(dir, '.proof/allowed_signers', `dev@example.com namespaces="pocp-proof" ${trusted.pub}\n`);
  git(dir, 'add', '-A');
  git(dir, '-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', 'trust');
  write(dir, 'src/math.js', TWEAK_ADD);
  git(dir, 'add', 'src/math.js');
  const id = packetId(pocp(dir, ['open', '--intent', 'x', '--touch', 'src/math.js']).stdout);
  pocp(dir, ['prove', id], { env: { POCP_SIGN_KEY: other.key, POCP_SIGN_PRINCIPAL: 'dev@example.com' } });
  commit(dir, 'signed by the wrong key');
  const v = pocp(dir, ['verify', 'HEAD', '--rerun-unsigned', '--json']);
  assert.equal(v.code, 1);
  assert.match(v.json.packets[0].problems.join(' '), /invalid signature/);
});

test('CI results bound to the commit replace re-runs; ranges re-run once at the head', () => {
  const dir = sampleRepo({ hooks: true });
  const base = git(dir, 'rev-parse', 'HEAD');
  for (const [n, body] of [[1, TWEAK_ADD], [2, `${TWEAK_ADD}// two\n`]]) {
    write(dir, 'src/math.js', body);
    git(dir, 'add', 'src/math.js');
    const id = packetId(pocp(dir, ['open', '--intent', `change ${n}`, '--touch', 'src/math.js']).stdout);
    pocp(dir, ['prove', id]);
    commit(dir, `change ${n}`);
  }
  const r = pocp(dir, ['verify', `${base}..HEAD`, '--rerun', '--json']);
  assert.equal(r.code, 0, r.stdout);
  assert.equal(r.json.reruns.length, 1, 'one check, run once for the whole range');
  assert.equal(r.json.reruns[0].status, 'passed');

  const results = path.join(dir, '..', `${path.basename(dir)}-ci.jsonl`);
  const ci = pocp(dir, ['ci-run', '--results', results, '--', 'node', 'test/math.check.mjs']);
  assert.equal(ci.code, 0, ci.stdout + ci.stderr);
  assert.match(ci.stdout, /ci-run: passed \(exit 0\)/);
  const skip = pocp(dir, ['verify', `${base}..HEAD`, '--rerun', '--ci-results', results, '--json']);
  assert.match(skip.json.reruns[0].status, /passing CI result for this code/);

  // A result for different code doesn't count.
  const rec = JSON.parse(fs.readFileSync(results, 'utf8').trim());
  rec.subject = 'sha256:' + '0'.repeat(64);
  fs.writeFileSync(results, `${JSON.stringify(rec)}\n`);
  const stale = pocp(dir, ['verify', `${base}..HEAD`, '--rerun', '--ci-results', results, '--json']);
  assert.equal(stale.json.reruns[0].status, 'passed', 'it ran instead');

  // ci-run passes the command's exit code through and refuses a dirty checkout.
  assert.equal(pocp(dir, ['ci-run', '--results', results, '--', 'sh', '-c', 'exit 3']).code, 3);
  write(dir, 'README.md', 'dirty\n');
  assert.match(pocp(dir, ['ci-run', '--results', results, '--', 'true']).stderr, /clean checkout/);
});

test('verify writes a GitHub job summary and error annotations', () => {
  const dir = sampleRepo();
  write(dir, 'src/math.js', TWEAK_ADD);
  git(dir, 'add', 'src/math.js');
  git(dir, 'commit', '-q', '--no-verify', '-m', 'unproven');
  const summary = path.join(dir, '..', `${path.basename(dir)}-summary.md`);
  const r = pocp(dir, ['verify', 'HEAD', '--require-coverage'], { env: { GITHUB_ACTIONS: 'true', GITHUB_STEP_SUMMARY: summary } });
  assert.equal(r.code, 1);
  assert.match(r.stdout, /::error title=POCP::/);
  const md = fs.readFileSync(summary, 'utf8');
  assert.match(md, /POCP ❌ not verified/);
  assert.match(md, /not covered: src\/math\.js/);
  const j = pocp(dir, ['verify', 'HEAD', '--require-coverage', '--json'], { env: { GITHUB_ACTIONS: 'true', GITHUB_STEP_SUMMARY: summary } });
  assert.equal(j.json.ok, false, 'with --json, stdout stays valid JSON inside GitHub Actions');
});

test('CI judges a PR by the base branch rules: dropping a requirement does not skip it', () => {
  const dir = sampleRepo({ hooks: true });
  const base = git(dir, 'rev-parse', 'HEAD');
  // The PR deletes the requirement and covers everything with a packet that has a trivial check.
  writeRules(dir, { requirements: [], triggers: { globs: [] } });
  write(dir, 'src/math.js', BREAK_ADD);
  git(dir, 'add', '-A');
  const id = packetId(pocp(dir, ['open', '--intent', 'sneaky', '--touch', 'src/math.js', '--touch', '.proof/rules.json', '--command', 'true']).stdout);
  assert.equal(pocp(dir, ['prove', id]).code, 0);
  assert.equal(commit(dir, 'drop the check').status, 0, 'passes locally, by its own rules');
  const v = pocp(dir, ['verify', `${base}..HEAD`, '--require-coverage', '--rerun', '--json']);
  assert.equal(v.code, 1);
  const c = v.json.commits[0];
  assert.equal(c.policy.from, base);
  assert.match(c.notes.join(' '), /policy loosened without approval/);
  assert.match(c.packets[0].problems.join(' '), /required obligation missing: math-tests/);
});

test('a PR cannot add its own signing key to skip CI re-runs', { skip: NO_SSH_KEYGEN }, () => {
  const dir = sampleRepo({ hooks: true });
  const base = git(dir, 'rev-parse', 'HEAD');
  const { key, pub } = makeKey(dir, 'attacker');
  write(dir, '.proof/allowed_signers', `me@example.com namespaces="pocp-proof" ${pub}\n`);
  write(dir, 'src/math.js', TWEAK_ADD);
  git(dir, 'add', '-A');
  const id = packetId(pocp(dir, ['open', '--intent', 'x', '--touch', 'src/math.js', '--touch', '.proof/allowed_signers']).stdout);
  const pr = pocp(dir, ['prove', id], { env: { POCP_SIGN_KEY: key, POCP_SIGN_PRINCIPAL: 'me@example.com' } });
  assert.equal(pr.code, 0, pr.stdout + pr.stderr);
  const c = commit(dir, 'add my key', { allowFail: true });
  assert.equal(c.status, 0, c.stderr);
  const v = pocp(dir, ['verify', `${base}..HEAD`, '--rerun-unsigned', '--json']);
  assert.equal(v.code, 1);
  assert.match(v.json.commits[0].notes.join(' '), /allowed_signers gained a key/);
  assert.equal(v.json.reruns[0].status, 'passed', 'the check was re-run, not skipped as signed');
});

test('stricter rules in a PR apply immediately', () => {
  const dir = sampleRepo({ hooks: true });
  const base = git(dir, 'rev-parse', 'HEAD');
  writeRules(dir, { triggers: { broad_files: 6, cross_area: { areas: 3, min_files: 4 }, globs: [] }, requirements: [
    { id: 'math-tests', glob: 'src/**', obligation: { kind: 'test', run: 'node test/math.check.mjs' } },
    { id: 'syntax', glob: 'src/**', obligation: { kind: 'command', run: 'node --check src/math.js' } },
  ] });
  write(dir, 'src/math.js', TWEAK_ADD);
  git(dir, 'add', '-A');
  const id = packetId(pocp(dir, ['open', '--intent', 'tighten', '--touch', 'src/math.js', '--touch', '.proof/rules.json']).stdout);
  assert.equal(pocp(dir, ['prove', id]).code, 0);
  commit(dir, 'tighten');
  const v = pocp(dir, ['verify', `${base}..HEAD`, '--require-coverage', '--json']);
  assert.equal(v.code, 0, v.stdout);
  assert.deepEqual(v.json.commits[0].policy.weakened, []);
});
