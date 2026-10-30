import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertNoLeak, buildSequences, commitCoverage, extractRepo, proofRecords, run, subjectOfTree } from '../friction.js';
import { subjectHashRev } from '../../../src/git.js';
import { readRecords, validateRecord } from '../../lib/record.js';

const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

function write(dir, rel, text) {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), text);
}

/** A repo that uses POCP: rules committed, one commit proven, one with a trailer and no log, a worktree with its own log. */
function fixtureRepo() {
  const dir = tmp('e5-fx-');
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 't@example.invalid');
  git(dir, 'config', 'user.name', 't');
  write(dir, '.proof/rules.json', '{"pocp":1,"requirements":[]}\n');
  write(dir, 'src/secret-module-name.js', 'export const a = 1;\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'Confidential launch of zanzibar pricing');
  const c1 = git(dir, 'rev-parse', 'HEAD');
  const s1 = subjectOfTree(dir, c1);
  write(dir, 'src/secret-module-name.js', 'export const a = 2;\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'Second private change about quokka\n\nProof-Of-Change: p-1234abcd subject=sha256:000000000000 policy=sha256:1 proven=1/1 attested=0/0');
  const wt = path.join(tmp('e5-wt-'), 'feature-wombat-secret');
  git(dir, 'worktree', 'add', '-q', '-b', 'feature-wombat-secret', wt);
  const packet = {
    pocp: 1, id: 'p-aaaa1111', intent: 'Private intent mentioning platypus', touches: ['src/secret-module-name.js'],
    obligations: [{ id: 'o1', kind: 'test', run: 'node --test private-suite-name.test.js', source: 'rule:private-rule' }, { id: 'o2', kind: 'guard', files: ['test/x.test.js'] }],
    proofs: [
      { obligation: 'o1', started_at: '2026-10-01T00:00:01.000Z', duration_ms: 1500, passed: true, run: 'node --test private-suite-name.test.js' },
      { obligation: 'o2', kind: 'guard', started_at: '2026-10-01T00:00:03.000Z', duration_ms: 60000, passed: true, guard: { verdict: 'passed', detection: { sampled: 10, old_caught: 7 }, baseline: { runs: [] } } },
    ],
  };
  // The same packet in both checkouts (untracked) and an empty one: counted once, one malformed.
  for (const d of [dir, wt]) {
    write(d, `.proof/packets/${packet.id}.json`, JSON.stringify(packet));
  }
  write(dir, '.proof/packets/p-empty.json', '');
  const t = (s) => new Date(Date.parse('2026-10-01T00:00:00Z') + s * 1000).toISOString();
  const now = Date.parse(git(dir, 'log', '-1', '--format=%cI', c1));
  const at = (s) => new Date(now - 3600_000 + s * 1000).toISOString();
  const log = (d, lines) => write(d, '.proof/runs/gate.jsonl', `${lines.map((l) => JSON.stringify(l)).join('\n')}\nnot json\n`);
  log(dir, [
    { at: at(0), decision: 'blocked', subject: s1, required: 1, uncovered: 1, packets: [] },
    { at: at(40), decision: 'blocked', subject: s1, required: 1, uncovered: 0, packets: [{ id: 'p-aaaa1111', ok: false, failed: 0 }] },
    { at: at(100), decision: 'pass', subject: s1, required: 1, uncovered: 0, packets: [{ id: 'p-aaaa1111', ok: true, failed: 0 }] },
  ]);
  log(wt, [{ at: at(200), decision: 'pass', subject: 'sha256:other', required: 0, uncovered: 0, packets: [] }]);
  void t;
  return { dir, wt, c1, s1 };
}

function snapshotFiles(dir) {
  const h = crypto.createHash('sha256');
  const walk = (d) => {
    for (const n of fs.readdirSync(d).sort()) {
      const f = path.join(d, n);
      const st = fs.lstatSync(f);
      if (st.isDirectory()) walk(f);
      else {
        h.update(`${f}\0${st.mtimeMs}\0`);
        h.update(fs.readFileSync(f));
      }
    }
  };
  walk(dir);
  return h.digest('hex');
}

test('subjectOfTree matches POCP\'s own subject hash', () => {
  const { dir, c1 } = fixtureRepo();
  assert.equal(subjectOfTree(dir, c1), subjectHashRev(dir, c1));
  assert.equal(subjectOfTree(dir, 'HEAD'), subjectHashRev(dir, 'HEAD'));
});

test('sequences: first try, blocked then passed, never passed with the next other pass', () => {
  const e = (s, decision, subject, extra = {}) => ({ at: new Date(Date.UTC(2026, 9, 1, 0, 0, s)).toISOString(), decision, subject, required: 1, uncovered: 0, packets: [], _wt: 'main', ...extra });
  const seqs = buildSequences([
    e(0, 'pass', 'A'),
    e(10, 'blocked', 'B', { uncovered: 2 }),
    e(20, 'blocked', 'B'),
    e(50, 'pass', 'B'),
    e(55, 'pass', 'B'),
    e(60, 'blocked', 'C', { packets: [{ id: 'p', ok: false, failed: 1 }] }),
    e(90, 'pass', 'D', { required: 0 }),
  ]);
  const by = Object.fromEntries(seqs.map((s) => [s.subject, s]));
  assert.equal(by.A.outcome, 'first-try');
  assert.equal(by.A.ms_to_pass, 0);
  assert.equal(by.B.outcome, 'blocked-then-passed');
  assert.equal(by.B.ms_to_pass, 40_000);
  assert.equal(by.B.blocks_before_pass, 2);
  assert.equal(by.B.evaluations, 4);
  assert.equal(by.B.first_block_reason, 'no-packet');
  assert.equal(by.C.outcome, 'never-passed');
  assert.equal(by.C.first_block_reason, 'failed-proof');
  assert.equal(by.C.ms_to_pass, null);
  assert.equal(by.C.ms_to_next_other_pass, 30_000);
  assert.equal(by.D.nothing_required, true);
});

test('extractRepo reads every worktree log, dedupes proofs and matches commits to the log', () => {
  const { dir } = fixtureRepo();
  const x = extractRepo({ alias: 'fx', path: dir, private: true });
  assert.equal(x.logs.length, 2);
  assert.equal(x.logs.filter((l) => l.has_log).length, 2);
  assert.equal(x.malformed, 2);
  assert.equal(x.entries.length, 4);
  assert.equal(x.bad_packets, 1);
  assert.equal(x.proofs.length, 2, 'the same packet in two checkouts counts once');
  assert.deepEqual(x.proofs.map((p) => p.kind).sort(), ['guard', 'test']);
  const s1 = x.seqs.find((s) => s.outcome === 'blocked-then-passed');
  assert.equal(s1.ms_to_pass, 100_000);
  assert.equal(s1.committed, true);
  // Second commit: trailer, no gate entry anywhere -> a missing log.
  assert.equal(x.coverage.adopted.commits, 2);
  assert.equal(x.coverage.since_first_log.matched_pass, 1);
  assert.equal(x.coverage.since_first_log.unmatched, 1);
  assert.equal(x.coverage.since_first_log.trailer_no_gate_entry, 1);
});

test('commitCoverage leaves commits before the first log out of the missing count', () => {
  const cov = commitCoverage(
    [{ subject: 'X', at_ms: 0, trailers: [] }, { subject: 'Y', at_ms: 10_000_000, trailers: [{ id: 'p-1', subject: null }] }],
    [{ at: new Date(5_000_000).toISOString(), decision: 'pass', subject: 'Z' }],
  );
  assert.equal(cov.adopted.commits, 2);
  assert.equal(cov.since_first_log.commits, 1);
  assert.equal(cov.since_first_log.trailer_no_gate_entry, 1);
});

test('private repo output has no subjects, intents, paths or branch names, and the source is untouched', () => {
  const { dir, wt } = fixtureRepo();
  const before = [snapshotFiles(path.join(dir, '.proof')), snapshotFiles(path.join(wt, '.proof')), git(dir, 'status', '--porcelain'), git(dir, 'rev-parse', 'HEAD')];
  const results = tmp('e5-res-');
  const md = path.join(results, 'RESULTS.md');
  const out = run({ repos: [{ alias: 'repo-x', path: dir, private: true }], write: true, resultsDir: results, resultsMd: md });
  const after = [snapshotFiles(path.join(dir, '.proof')), snapshotFiles(path.join(wt, '.proof')), git(dir, 'status', '--porcelain'), git(dir, 'rev-parse', 'HEAD')];
  assert.deepEqual(after, before, 'extraction is read-only');
  const text = fs.readFileSync(md, 'utf8') + fs.readFileSync(out.file, 'utf8');
  for (const bad of ['zanzibar', 'quokka', 'platypus', 'wombat', 'secret-module-name', 'private-suite-name', 'private-rule', 'p-aaaa1111', path.basename(dir), dir]) {
    assert.ok(!text.includes(bad), `leaked ${bad}`);
  }
  assert.ok(text.includes('repo-x'));
  const recs = readRecords(out.file);
  for (const r of recs) assert.deepEqual(validateRecord(r), []);
  assert.equal(recs.filter((r) => r.unit.kind === 'sequence').length, 2);
  assert.ok(recs.every((r) => r.eval === 'E5' && r.phase === 'pilot'));
});

test('assertNoLeak refuses output with a private string', () => {
  assert.throws(() => assertNoLeak('a table mentioning zanzibar pricing', ['zanzibar pricing']), /privacy check failed/);
  assert.doesNotThrow(() => assertNoLeak('counts only', ['zanzibar pricing']));
});

test('proofRecords takes the kind from the proof or its obligation', () => {
  const ps = proofRecords([{ id: 'p-1', obligations: [{ id: 'o1', kind: 'test', source: 'rule:unit' }], proofs: [{ obligation: 'o1', started_at: '2026-01-01T00:00:00Z', duration_ms: 5, passed: true }] }]);
  assert.equal(ps[0].kind, 'test');
  assert.equal(ps[0].check, 'unit');
});
