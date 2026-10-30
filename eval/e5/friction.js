#!/usr/bin/env node
// E5: friction from real gate logs (EVAL-PLAN "E5", PREREG §1 and §5: descriptive only).
//
// Reads, never writes, every POCP gate log on this machine for the configured repos and all
// their git worktrees, plus the proof durations recorded in packets, and reports:
//   - gate attempt sequences per staged subject: passed first try, blocked then passed (time
//     and blocked evaluations before the pass), never passed;
//   - proof durations per obligation kind (test, guard);
//   - log coverage: commits since adoption whose code no surviving log ever saw.
//
//   node eval/e5/friction.js            # print the summary, write nothing
//   node eval/e5/friction.js --write    # append run records to eval/results/E5/ and regenerate RESULTS.md
//   node eval/e5/friction.js --report   # regenerate RESULTS.md from the newest E5 friction batch
//   --repo <alias>=<path>[:public]      # repos to read (repeatable); private unless :public; default: this checkout only
//
// Repos can also be listed in eval/e5/repos.local.json (gitignored), as
// [{ "alias": "site", "path": "/path/to/repo", "private": true }, ...].
//
// Privacy: repos marked private appear only as their alias, with counts, durations and hashed
// ids. Before anything is written, the output is scanned for every commit subject, packet
// intent, file path, branch and worktree path collected from the private repos; any hit aborts.
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { basePins, POCP_ROOT } from '../lib/pins.js';
import { appendRecord, readRecords, runId } from '../lib/record.js';

// Only this checkout by default. Other repos (and whether they're private) come from the
// command line or a local, gitignored config, never from this file.
export const DEFAULT_REPOS = [{ alias: 'pocp', path: POCP_ROOT, private: false }];
export const LOCAL_CONFIG = path.join(POCP_ROOT, 'eval', 'e5', 'repos.local.json');

/** Repos from --repo <alias>=<path>[:public] flags (private unless :public), else repos.local.json, else the default. */
export function reposFromArgs(args, { configFile = LOCAL_CONFIG } = {}) {
  const flags = [];
  for (let i = 0; i < args.length; i++) if (args[i] === '--repo') flags.push(args[++i]);
  if (flags.length) {
    return flags.map((f) => {
      const m = /^([^=]+)=(.+?)(:public|:private)?$/.exec(f || '');
      if (!m) throw new Error(`--repo wants <alias>=<path>[:public], got "${f}"`);
      return { alias: m[1], path: path.resolve(m[2]), private: m[3] !== ':public' };
    });
  }
  if (fs.existsSync(configFile)) {
    const list = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    return list.map((r) => ({ alias: String(r.alias), path: path.resolve(r.path), private: r.private !== false }));
  }
  return DEFAULT_REPOS;
}
export const RESULTS_DIR = path.join(POCP_ROOT, 'eval', 'results');
export const BATCH_PREFIX = 'friction';
const POCP_FILES = ['.proof/rules.json', '.proof/config.json', '.proof/allowed_signers', '.proof/runs/gate.jsonl'];

// ---------- reading (read-only) ----------

function git(cwd, args, { allowFail = false } = {}) {
  try {
    return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 256 << 20 });
  } catch (err) {
    if (allowFail) return null;
    throw err;
  }
}

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

/** Worktrees from `git worktree list --porcelain`; the first is the main checkout. */
export function listWorktrees(repo) {
  const out = git(repo, ['worktree', 'list', '--porcelain'], { allowFail: true });
  if (out === null) return [];
  const wts = [];
  let cur = null;
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) {
      cur = { path: line.slice(9), branch: null, prunable: false, bare: false };
      wts.push(cur);
    } else if (cur && line.startsWith('branch ')) cur.branch = line.slice(7).replace(/^refs\/heads\//, '');
    else if (cur && line.startsWith('prunable')) cur.prunable = true;
    else if (cur && line === 'bare') cur.bare = true;
  }
  return wts;
}

/** Gate log entries, plus how many lines didn't parse. */
export function readGateLog(file) {
  if (!fs.existsSync(file)) return null;
  const entries = [];
  let malformed = 0;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      if (typeof e.at !== 'string' || !e.subject || !['pass', 'blocked'].includes(e.decision)) malformed++;
      else entries.push(e);
    } catch {
      malformed++;
    }
  }
  return { entries, malformed, sha256: sha(fs.readFileSync(file)) };
}

/**
 * The subject hash POCP gives a tree: every entry outside .proof/ as "<mode> <sha>\t<path>",
 * sorted by path, joined by newlines, SHA-256. Written here independently of src/git.js
 * (a test checks the two agree).
 */
export function subjectOfTree(repo, rev) {
  const out = git(repo, ['ls-tree', '-r', '-z', '--full-tree', rev]);
  const lines = [];
  for (const rec of out.split('\0')) {
    if (!rec) continue;
    const tab = rec.indexOf('\t');
    const [mode, , objSha] = rec.slice(0, tab).split(' ');
    const p = rec.slice(tab + 1);
    if (p === '.proof' || p.startsWith('.proof/')) continue;
    lines.push([p, `${mode} ${objSha}\t${p}`]);
  }
  lines.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return `sha256:${sha(lines.map((l) => l[1]).join('\n'))}`;
}

const TRAILER_RE = /^[ \t]*Proof-Of-Change:[ \t]*(p-[0-9a-z-]+)(?:.*?\bsubject=(sha256:[0-9a-f]+))?/gim;

/** Non-merge commits on any ref whose tree has .proof/rules.json (POCP in force). */
export function adoptedCommits(repo) {
  const out = git(repo, ['log', '--all', '--no-merges', '--format=%H%x1f%T%x1f%ct%x1f%B%x1e'], { allowFail: true });
  if (!out) return [];
  const commits = [];
  for (const rec of out.split('\x1e')) {
    const [h, tree, ct, body] = rec.replace(/^\n/, '').split('\x1f');
    if (!h || !tree) continue;
    commits.push({ sha: h.trim(), tree: tree.trim(), at_ms: Number(ct) * 1000, message: body || '' });
  }
  if (!commits.length) return [];
  // One batch call: does <commit>:.proof/rules.json exist?
  const input = commits.map((c) => `${c.sha}:.proof/rules.json`).join('\n');
  const res = execFileSync('git', ['-C', repo, 'cat-file', '--batch-check'], { input: `${input}\n`, encoding: 'utf8', maxBuffer: 64 << 20 });
  const has = res.split('\n').filter(Boolean).map((l) => !l.endsWith(' missing'));
  return commits.filter((_, i) => has[i]).map((c) => {
    const trailers = [...c.message.matchAll(TRAILER_RE)].map((m) => ({ id: m[1], subject: m[2] || null }));
    return { ...c, subject: subjectOfTree(repo, c.sha), trailers, title: c.message.split('\n')[0] };
  });
}

/** Packet JSON from every worktree folder (tracked or not) and every ref's tree; malformed counted. */
export function readPackets(repo, worktrees) {
  const packets = [];
  let malformed = 0;
  const seenBlob = new Set();
  const take = (text, where) => {
    try {
      const p = JSON.parse(text);
      if (p && typeof p.id === 'string') packets.push({ ...p, _where: where });
      else malformed++;
    } catch {
      malformed++;
    }
  };
  for (const wt of worktrees) {
    const dir = path.join(wt.path, '.proof', 'packets');
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json'))) take(fs.readFileSync(path.join(dir, f), 'utf8'), 'worktree');
  }
  const refs = (git(repo, ['for-each-ref', '--format=%(objectname)', 'refs/heads', 'refs/remotes'], { allowFail: true }) || '').split('\n').filter(Boolean);
  for (const ref of new Set(refs)) {
    const ls = git(repo, ['ls-tree', '-z', ref, '.proof/packets/'], { allowFail: true }) || '';
    for (const rec of ls.split('\0').filter(Boolean)) {
      const [, , blob] = rec.slice(0, rec.indexOf('\t')).split(' ');
      if (seenBlob.has(blob)) continue;
      seenBlob.add(blob);
      const text = git(repo, ['cat-file', 'blob', blob], { allowFail: true });
      if (text !== null) take(text, 'ref');
    }
  }
  return { packets, malformed };
}

/** Proofs deduplicated across copies of the same packet (by packet, obligation, start time). */
export function proofRecords(packets) {
  const seen = new Map();
  for (const p of packets) {
    const obs = new Map((p.obligations || []).map((o) => [o.id, o]));
    for (const pr of p.proofs || []) {
      const key = `${p.id}|${pr.obligation}|${pr.started_at}`;
      if (seen.has(key)) continue;
      const ob = obs.get(pr.obligation) || {};
      const kind = pr.kind || ob.kind || 'test';
      seen.set(key, {
        packet: p.id,
        obligation: pr.obligation,
        kind,
        check: String(ob.source || '').replace(/^(rule|guard):/, '') || null,
        run: pr.run || null,
        passed: Boolean(pr.passed),
        timed_out: Boolean(pr.timed_out),
        started_at: pr.started_at,
        duration_ms: Number.isFinite(pr.duration_ms) ? pr.duration_ms : null,
        guard: pr.guard ? { verdict: pr.guard.verdict, sampled: pr.guard.detection?.sampled ?? null, old_caught: pr.guard.detection?.old_caught ?? null, base_run: (pr.guard.baseline?.runs || []).length > 0 } : null,
      });
    }
  }
  return [...seen.values()].sort((a, b) => a.started_at.localeCompare(b.started_at));
}

// ---------- analysis ----------

/**
 * One sequence per staged subject: every gate evaluation of that subject in the repo, in time
 * order, across its worktrees. The outcome is decided by the first pass.
 */
export function buildSequences(entries) {
  const bySubject = new Map();
  for (const e of entries) {
    if (!bySubject.has(e.subject)) bySubject.set(e.subject, []);
    bySubject.get(e.subject).push(e);
  }
  const seqs = [];
  for (const [subject, list] of bySubject) {
    list.sort((a, b) => a.at.localeCompare(b.at));
    const passIdx = list.findIndex((e) => e.decision === 'pass');
    const blocksBefore = passIdx === -1 ? list.length : passIdx;
    const firstBlock = list.find((e) => e.decision === 'blocked');
    const outcome = passIdx === 0 ? 'first-try' : passIdx > 0 ? 'blocked-then-passed' : 'never-passed';
    seqs.push({
      subject,
      worktrees: [...new Set(list.map((e) => e._wt))],
      wt: list[0]._wt,
      evaluations: list.length,
      first_at: list[0].at,
      last_at: list[list.length - 1].at,
      outcome,
      blocks_before_pass: passIdx === -1 ? null : blocksBefore,
      blocks: list.filter((e) => e.decision === 'blocked').length,
      ms_to_pass: passIdx > 0 ? Date.parse(list[passIdx].at) - Date.parse(firstBlock.at) : passIdx === 0 ? 0 : null,
      pass_at: passIdx >= 0 ? list[passIdx].at : null,
      nothing_required: list.every((e) => (e.required || 0) === 0),
      first_block_reason: firstBlock ? blockReason(firstBlock) : null,
    });
  }
  // For a subject that never passed: the next pass of a different subject in the same checkout
  // (most often the same work re-staged after a fix). Reported apart, never as a time to pass.
  for (const s of seqs.filter((x) => x.outcome === 'never-passed')) {
    const next = entries
      .filter((e) => e._wt === s.wt && e.decision === 'pass' && e.subject !== s.subject && e.at > s.last_at)
      .sort((a, b) => a.at.localeCompare(b.at))[0];
    s.ms_to_next_other_pass = next ? Date.parse(next.at) - Date.parse(s.first_at) : null;
  }
  return seqs.sort((a, b) => a.first_at.localeCompare(b.first_at));
}

export function blockReason(e) {
  if ((e.uncovered || 0) > 0) return 'no-packet';
  if ((e.packets || []).some((p) => (p.failed || 0) > 0)) return 'failed-proof';
  return 'not-proven';
}

/** Commits since adoption matched to gate evaluations by subject. */
export function commitCoverage(commits, entries) {
  const firstLog = entries.length ? Math.min(...entries.map((e) => Date.parse(e.at))) : null;
  const passed = new Set(entries.filter((e) => e.decision === 'pass').map((e) => e.subject));
  const seen = new Set(entries.map((e) => e.subject));
  const inWindow = firstLog === null ? [] : commits.filter((c) => c.at_ms >= firstLog - 60_000);
  const row = (list) => {
    const unmatched = list.filter((c) => !passed.has(c.subject));
    return {
      commits: list.length,
      matched_pass: list.filter((c) => passed.has(c.subject)).length,
      matched_blocked_only: unmatched.filter((c) => seen.has(c.subject)).length,
      unmatched: unmatched.filter((c) => !seen.has(c.subject)).length,
      with_trailer: list.filter((c) => c.trailers.length).length,
      trailer_no_gate_entry: list.filter((c) => c.trailers.length && !seen.has(c.subject)).length,
      trailer_subject_differs: list.filter((c) => c.trailers.some((t) => t.subject && !c.subject.startsWith(t.subject))).length,
    };
  };
  return {
    first_log_at: firstLog === null ? null : new Date(firstLog).toISOString(),
    adopted: row(commits),
    since_first_log: row(inWindow),
    unmatched_commits: inWindow.filter((c) => !seen.has(c.subject)),
  };
}

export function stats(values) {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return { n: 0, median: null, min: null, max: null };
  const m = v.length >> 1;
  return { n: v.length, median: v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2, min: v[0], max: v[v.length - 1] };
}

export function summarize(seqs) {
  const by = (o) => seqs.filter((s) => s.outcome === o);
  const subst = seqs.filter((s) => !s.nothing_required);
  const btp = by('blocked-then-passed');
  return {
    sequences: seqs.length,
    evaluations: seqs.reduce((a, s) => a + s.evaluations, 0),
    nothing_required: seqs.filter((s) => s.nothing_required).length,
    first_try: by('first-try').length,
    first_try_substantive: subst.filter((s) => s.outcome === 'first-try').length,
    substantive: subst.length,
    blocked_then_passed: btp.length,
    never_passed: by('never-passed').length,
    never_passed_next_other_pass: by('never-passed').filter((s) => s.ms_to_next_other_pass !== null).length,
    never_passed_committed: by('never-passed').filter((s) => s.committed).length,
    first_at: seqs.length ? seqs.map((s) => s.first_at).sort()[0] : null,
    last_at: seqs.length ? seqs.map((s) => s.last_at || s.first_at).sort().pop() : null,
    time_to_pass_ms: stats(btp.map((s) => s.ms_to_pass)),
    blocks_before_pass: stats(btp.map((s) => s.blocks_before_pass)),
    next_other_pass_ms: stats(by('never-passed').map((s) => s.ms_to_next_other_pass)),
    first_block_reason: countBy(seqs.filter((s) => s.first_block_reason), (s) => s.first_block_reason),
  };
}

function countBy(xs, f) {
  const o = {};
  for (const x of xs) o[f(x)] = (o[f(x)] || 0) + 1;
  return o;
}

export function proofSummary(proofs) {
  const out = {};
  for (const kind of [...new Set(proofs.map((p) => p.kind))].sort()) {
    const ps = proofs.filter((p) => p.kind === kind && p.duration_ms !== null);
    out[kind] = { ...stats(ps.map((p) => p.duration_ms)), passed: ps.filter((p) => p.passed).length, failed: ps.filter((p) => !p.passed).length };
  }
  return out;
}

/** Everything about one repo. Read-only. */
export function extractRepo(repo) {
  const worktrees = listWorktrees(repo.path);
  const wtId = (wt, i) => (i === 0 ? 'main' : repo.private ? `wt-${sha(`${repo.alias}|${wt.path}`).slice(0, 8)}` : path.basename(wt.path));
  const logs = [];
  const entries = [];
  let malformed = 0;
  worktrees.forEach((wt, i) => {
    const file = path.join(wt.path, '.proof', 'runs', 'gate.jsonl');
    const exists = fs.existsSync(wt.path);
    const log = exists ? readGateLog(file) : null;
    const hasProof = exists && fs.existsSync(path.join(wt.path, '.proof'));
    logs.push({ id: wtId(wt, i), folder_exists: exists, proof_dir: hasProof, has_log: Boolean(log), entries: log?.entries.length || 0, malformed: log?.malformed || 0, sha256: log?.sha256 || null, prunable: wt.prunable });
    if (log) {
      malformed += log.malformed;
      for (const e of log.entries) entries.push({ ...e, _wt: wtId(wt, i) });
    }
  });
  const adopted = fs.existsSync(path.join(repo.path, '.proof', 'rules.json')) || Boolean(git(repo.path, ['log', '--all', '-1', '--format=%H', '--', '.proof/rules.json'], { allowFail: true })?.trim());
  const commits = adopted ? adoptedCommits(repo.path) : [];
  const { packets, malformed: badPackets } = readPackets(repo.path, worktrees.filter((w) => fs.existsSync(w.path)));
  const proofs = proofRecords(packets);
  const seqs = buildSequences(entries);
  const committed = new Set(commits.map((c) => c.subject));
  for (const s of seqs) s.committed = committed.has(s.subject);
  const coverage = commitCoverage(commits, entries);
  // Strings that must never appear in output for a private repo.
  const secrets = repo.private
    ? [
        repo.path, path.basename(repo.path),
        ...worktrees.flatMap((w) => [w.path, path.basename(w.path), w.branch].filter(Boolean)),
        ...commits.map((c) => c.title),
        ...packets.flatMap((p) => [p.intent, ...(p.touches || []), ...(p.obligations || []).flatMap((o) => [o.run, ...(o.files || [])])]),
      ].filter((s) => typeof s === 'string' && s.trim().length >= 8 && !/^(main|master)$/.test(s))
    : [];
  const publicStrings = repo.private ? [] : packets.flatMap((p) => (p.obligations || []).map((o) => o.run)).filter(Boolean);
  return { repo, adopted, logs, entries, malformed, packets: packets.length, bad_packets: badPackets, proofs, seqs, coverage, secrets, publicStrings };
}

// ---------- privacy ----------

/** The public form of a sequence for a record: hashed ids for private repos. */
export function publicSequence(alias, isPrivate, s) {
  const id = (x) => (isPrivate ? `h-${sha(`${alias}|${x}`).slice(0, 12)}` : x);
  return {
    subject_id: id(s.subject),
    worktree: s.wt,
    worktrees: s.worktrees.length,
    evaluations: s.evaluations,
    first_at: s.first_at,
    outcome: s.outcome,
    blocks: s.blocks,
    blocks_before_pass: s.blocks_before_pass,
    ms_to_pass: s.ms_to_pass,
    ms_to_next_other_pass: s.ms_to_next_other_pass ?? null,
    nothing_required: s.nothing_required,
    first_block_reason: s.first_block_reason,
    committed: Boolean(s.committed),
  };
}

export function assertNoLeak(text, secrets) {
  const hits = [...new Set(secrets)].filter((s) => text.includes(s));
  if (hits.length) throw new Error(`privacy check failed: output contains ${hits.length} private string(s) (not shown)`);
}

// ---------- records and report ----------

export function buildRecords(extracts, { batch, at, pins }) {
  const records = [];
  for (const x of extracts) {
    const { alias } = x.repo;
    for (const s of x.seqs) {
      const pub = publicSequence(alias, x.repo.private, s);
      records.push({
        eval: 'E5', batch, phase: 'pilot', run_id: runId([batch, alias, pub.subject_id]),
        unit: { kind: 'sequence', repo: alias, subject: pub.subject_id },
        pins: { ...pins, source: 'gate.jsonl' },
        started_at: at, ended_at: at, duration_s: 0, status: 'completed',
        attempts: [],
        outcome: { sequence: pub },
      });
    }
    records.push({
      eval: 'E5', batch, phase: 'pilot', run_id: runId([batch, alias, 'repo-summary']),
      unit: { kind: 'repo-summary', repo: alias },
      pins: { ...pins, source: 'gate.jsonl + packets + git log' },
      started_at: at, ended_at: at, duration_s: 0, status: 'completed',
      attempts: [],
      outcome: {
        adopted: x.adopted,
        private: x.repo.private,
        logs: x.logs,
        malformed_log_lines: x.malformed,
        packets_read: x.packets,
        malformed_packet_files: x.bad_packets,
        coverage: { first_log_at: x.coverage.first_log_at, adopted: x.coverage.adopted, since_first_log: x.coverage.since_first_log },
        summary: summarize(x.seqs),
        proofs: x.proofs.map((p) => ({
          kind: p.kind,
          check: x.repo.private ? (p.check ? `c-${sha(`${alias}|${p.check}`).slice(0, 6)}` : null) : p.check,
          run: x.repo.private ? null : p.run,
          packet: x.repo.private ? `h-${sha(`${alias}|${p.packet}`).slice(0, 12)}` : p.packet,
          passed: p.passed,
          timed_out: p.timed_out,
          started_at: p.started_at,
          duration_ms: p.duration_ms,
          guard: p.guard,
        })),
        unmatched_commits: x.coverage.unmatched_commits.map((c) => ({
          commit: x.repo.private ? `h-${sha(`${alias}|${c.sha}`).slice(0, 12)}` : c.sha.slice(0, 7),
          title: x.repo.private ? null : c.title,
          at: new Date(c.at_ms).toISOString(),
          trailer: c.trailers.length > 0,
        })),
      },
    });
  }
  return records;
}

const fmtS = (ms) => (ms === null || ms === undefined ? '–' : ms < 60_000 ? `${Math.round(ms / 1000)} s` : ms < 3_600_000 ? `${(ms / 60_000).toFixed(1)} min` : `${(ms / 3_600_000).toFixed(1)} h`);
const rng = (st) => (st.n ? `${fmtS(st.median)} (${fmtS(st.min)}–${fmtS(st.max)})` : '–');
const rngN = (st) => (st.n ? `${st.median} (${st.min}–${st.max})` : '–');

/** RESULTS.md from one batch of records. Only aliases, counts, durations and hashed ids. */
export function renderResults(records, { batch, file }) {
  const summaries = records.filter((r) => r.unit.kind === 'repo-summary');
  const seqsBy = (alias) => records.filter((r) => r.unit.kind === 'sequence' && r.unit.repo === alias).map((r) => r.outcome.sequence);
  const allSeqs = records.filter((r) => r.unit.kind === 'sequence').map((r) => r.outcome.sequence);
  const pins = summaries[0]?.pins || {};
  const at = summaries[0]?.started_at;
  const L = [];
  L.push('# E5 results: friction from real gate logs (pilot, descriptive only)');
  L.push('');
  L.push(`Generated by \`node eval/e5/friction.js --write\` from \`${path.relative(path.join(POCP_ROOT, 'eval', 'e5'), file)}\` (batch \`${batch}\`, extracted ${at}, POCP ${String(pins.pocp_commit).slice(0, 12)}). Every number below comes from that file. PREREG §5: E5 is descriptive only, so there are no bars, intervals or tail claims here.`);
  L.push('');
  L.push('**Unit** (PREREG §1): one gate attempt sequence for one staged subject: every gate evaluation in a repo (all its worktrees) of the same staged-code hash, in time order. The outcome is set by the first `pass`:');
  L.push('');
  L.push('- *passed first try*: the first evaluation passed;');
  L.push('- *blocked then passed*: one or more `blocked` before the first `pass`. Time to pass is from the first block to that pass; "blocked evaluations" counts the blocks before it;');
  L.push('- *never passed*: no logged `pass` for that subject. **Rule for attempts with no logged pass:** they count as never passed, and their time is never put into time to pass. Usually the code was changed and re-staged, which makes a new subject; the gap from the first block to the next pass of a *different* subject in the same checkout is shown separately as an upper bound, not as a time to pass.');
  L.push('');
  L.push('**A gate evaluation is not always a commit attempt.** The log gets a line from the pre-commit hook, from `pocp gate`, and from each gate check inside `pocp fix` (2–4 per fix). The log does not record which. So "blocked evaluations" overstates commit attempts, and a `pass` logged by `pocp fix` can come a little before the commit that followed it.');
  L.push('');
  L.push('**Nothing required:** subjects where every evaluation had no file that any rule requires proof for. Their first-try pass is free, so the substantive rows leave them out.');
  L.push('');

  L.push('## Outcomes per repo');
  L.push('');
  L.push('| Repo | Log span | Logs read (worktrees with a log / listed) | Gate evaluations | Sequences | Nothing required | Passed first try | First try, substantive | Blocked then passed | Never passed |');
  L.push('|---|---|---|---|---|---|---|---|---|---|');
  const pooled = { sequences: 0, evaluations: 0, nothing_required: 0, first_try: 0, first_try_substantive: 0, substantive: 0, blocked_then_passed: 0, never_passed: 0, logs: 0, wts: 0 };
  for (const r of summaries) {
    const o = r.outcome;
    const s = o.summary;
    const logs = o.logs.filter((l) => l.has_log).length;
    for (const k of Object.keys(pooled)) if (k in s) pooled[k] += s[k];
    pooled.logs += logs;
    pooled.wts += o.logs.length;
    L.push(`| ${r.unit.repo}${o.adopted ? '' : ' (not adopted)'} | ${s.first_at ? `${s.first_at.slice(0, 10)} to ${s.last_at.slice(0, 10)}` : '–'} | ${logs} / ${o.logs.length} | ${s.evaluations} | ${s.sequences} | ${s.nothing_required} | ${s.first_try} of ${s.sequences} | ${s.first_try_substantive} of ${s.substantive} | ${s.blocked_then_passed} | ${s.never_passed} |`);
  }
  L.push(`| **pooled** | | ${pooled.logs} / ${pooled.wts} | ${pooled.evaluations} | ${pooled.sequences} | ${pooled.nothing_required} | ${pooled.first_try} of ${pooled.sequences} | ${pooled.first_try_substantive} of ${pooled.substantive} | ${pooled.blocked_then_passed} | ${pooled.never_passed} |`);
  L.push('');

  L.push('## Blocked, then passed: time and blocked evaluations');
  L.push('');
  L.push('Median (min–max). Wall clock from the first block to the first pass of the same subject; it includes the agent\'s own time between commands, not only POCP\'s.');
  L.push('');
  L.push('| Repo | n | Time to pass | Blocked evaluations before the pass | First block reason (all blocked sequences) |');
  L.push('|---|---|---|---|---|');
  for (const r of summaries) {
    const s = r.outcome.summary;
    L.push(`| ${r.unit.repo} | ${s.blocked_then_passed} | ${rng(s.time_to_pass_ms)} | ${rngN(s.blocks_before_pass)} | ${fmtReasons(s.first_block_reason)} |`);
  }
  const btpAll = allSeqs.filter((s) => s.outcome === 'blocked-then-passed');
  L.push(`| **pooled** | ${btpAll.length} | ${rng(stats(btpAll.map((s) => s.ms_to_pass)))} | ${rngN(stats(btpAll.map((s) => s.blocks_before_pass)))} | ${fmtReasons(countBy(allSeqs.filter((s) => s.first_block_reason), (s) => s.first_block_reason))} |`);
  L.push('');
  L.push('Reasons: *no-packet*, the staged files needed a packet and none covered them; *failed-proof*, a covering packet had a failing check; *not-proven*, a packet covered them but wasn\'t proven for this exact code (or wasn\'t staged).');
  L.push('');
  L.push('Every time to pass, sorted (seconds):');
  L.push('');
  for (const r of summaries) {
    const xs = seqsBy(r.unit.repo).filter((s) => s.outcome === 'blocked-then-passed').map((s) => Math.round(s.ms_to_pass / 1000)).sort((a, b) => a - b);
    L.push(`- ${r.unit.repo}: ${xs.length ? xs.join(', ') : 'none'}`);
  }
  L.push('');

  L.push('## Never passed under the same subject');
  L.push('');
  L.push('| Repo | Never passed | …followed by a pass of another subject in the same checkout | Gap to that pass, median (min–max) | …committed anyway (a commit has this exact code) |');
  L.push('|---|---|---|---|---|');
  for (const r of summaries) {
    const s = r.outcome.summary;
    L.push(`| ${r.unit.repo} | ${s.never_passed} | ${s.never_passed_next_other_pass} | ${rng(s.next_other_pass_ms)} | ${s.never_passed_committed} |`);
  }
  L.push('');
  L.push('A never-passed subject that was committed anyway means the hook was skipped (`--no-verify`) or its passing evaluation was logged in a checkout whose log is gone.');
  L.push('');

  L.push('## Proof durations by obligation kind');
  L.push('');
  L.push('From the proofs recorded in packets (every worktree folder, tracked or not, and every branch tip), each proof counted once. Median (min–max).');
  L.push('');
  L.push('| Repo | Kind | Proofs | Passed | Failed | Duration |');
  L.push('|---|---|---|---|---|---|');
  for (const r of summaries) {
    const ps = r.outcome.proofs;
    for (const kind of [...new Set(ps.map((p) => p.kind))].sort()) {
      const k = ps.filter((p) => p.kind === kind && p.duration_ms !== null);
      L.push(`| ${r.unit.repo} | ${kind} | ${k.length} | ${k.filter((p) => p.passed).length} | ${k.filter((p) => !p.passed).length} | ${rng(stats(k.map((p) => p.duration_ms)))} |`);
    }
  }
  L.push('');
  const pocp = summaries.find((r) => !r.outcome.private);
  if (pocp) {
    L.push(`### ${pocp.unit.repo}, by check (public repo, shown in full)`);
    L.push('');
    L.push('| Check | Kind | Proofs | Duration |');
    L.push('|---|---|---|---|');
    const ps = pocp.outcome.proofs;
    for (const key of [...new Set(ps.map((p) => `${p.kind}|${p.check}`))].sort()) {
      const [kind, check] = key.split('|');
      const k = ps.filter((p) => p.kind === kind && String(p.check) === check);
      L.push(`| ${check} | ${kind} | ${k.length} | ${rng(stats(k.map((p) => p.duration_ms)))} |`);
    }
    L.push('');
    const guards = ps.filter((p) => p.kind === 'guard');
    if (guards.length) {
      L.push('Every guard proof:');
      L.push('');
      L.push('| Started | Packet | Verdict | Mutants caught by old tests | Base run | Duration |');
      L.push('|---|---|---|---|---|---|');
      for (const g of guards) L.push(`| ${g.started_at} | \`${g.packet}\` | ${g.guard?.verdict || '–'} | ${g.guard?.sampled != null ? `${g.guard.old_caught} of ${g.guard.sampled}` : '–'} | ${g.guard?.base_run ? 'yes' : 'no'} | ${fmtS(g.duration_ms)} |`);
      L.push('');
    }
  }

  L.push('## Log coverage');
  L.push('');
  L.push('Logs live in `.proof/runs/` of each checkout and are never committed, so a deleted worktree takes its log with it. To see what\'s missing, every non-merge commit on any branch whose tree has `.proof/rules.json` is matched to the gate log entries by subject (the tree\'s hash outside `.proof/`, which is what the gate logs). A commit with no entry of its subject in any surviving log was made where no log survives (a removed worktree), with the hook skipped (`--no-verify`), or rewritten later (rebase, amend, cherry-pick).');
  L.push('');
  L.push('| Repo | Worktrees listed | …with a log | …folder gone | Commits since adoption | Since the first log entry | Matched to a pass | Seen only blocked | No entry at all | …of which carry a `Proof-Of-Change` trailer |');
  L.push('|---|---|---|---|---|---|---|---|---|---|');
  for (const r of summaries) {
    const o = r.outcome;
    const c = o.coverage.since_first_log;
    L.push(`| ${r.unit.repo} | ${o.logs.length} | ${o.logs.filter((l) => l.has_log).length} | ${o.logs.filter((l) => !l.folder_exists).length} | ${o.coverage.adopted.commits} | ${c.commits} | ${c.matched_pass} | ${c.matched_blocked_only} | ${c.unmatched} | ${c.trailer_no_gate_entry} |`);
  }
  L.push('');
  L.push('Commits before a repo\'s first surviving log entry aren\'t counted as missing: gate logging may not have existed yet. Malformed lines and unreadable packet files:');
  L.push('');
  for (const r of summaries) L.push(`- ${r.unit.repo}: ${r.outcome.malformed_log_lines} malformed log line(s), ${r.outcome.malformed_packet_files} unreadable packet file(s) (empty or not JSON), ${r.outcome.packets_read} packet copies read`);
  L.push('');
  if (pocp && pocp.outcome.unmatched_commits.length) {
    L.push(`${pocp.unit.repo} commits with no gate entry (public, in full):`);
    L.push('');
    for (const c of pocp.outcome.unmatched_commits) L.push(`- \`${c.commit}\` ${c.at.slice(0, 16)} ${c.trailer ? '(trailer) ' : ''}${c.title}`);
    L.push('');
  }

  L.push('## Limits');
  L.push('');
  L.push('- Covers only the repositories whose logs were read, on one machine (EVAL-PLAN "Limits"). A repository with a handful of sequences gives anecdotes, not rates.');
  L.push('- All work was by AI agents and the maintainer on the same machine, mostly on POCP itself, so this is not a sample of outside use.');
  L.push('- Time to pass is wall clock and includes the agent thinking, running unrelated commands, and machine load. It is not POCP\'s run time; the proof durations are.');
  L.push('- The log has no field saying whether an evaluation came from the hook, `pocp gate` or `pocp fix`; adding one (`source`) would let "blocked evaluations" become "blocked commit attempts".');
  L.push('- EVAL-PLAN\'s earlier partial reading counted entries differently; the numbers here supersede it.');
  L.push('');
  return `${L.join('\n')}\n`;
}

function fmtReasons(o) {
  const ks = Object.keys(o || {}).sort();
  return ks.length ? ks.map((k) => `${k} ${o[k]}`).join(', ') : '–';
}

export function newestBatchFile(dir = path.join(RESULTS_DIR, 'E5')) {
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir).filter((f) => f.startsWith(`${BATCH_PREFIX}-`) && f.endsWith('.jsonl')).sort();
  return files.length ? path.join(dir, files[files.length - 1]) : null;
}

export function run({ repos = DEFAULT_REPOS, write = false, resultsDir = RESULTS_DIR, resultsMd = path.join(POCP_ROOT, 'eval', 'e5', 'RESULTS.md'), now = new Date() } = {}) {
  const extracts = repos.filter((r) => fs.existsSync(r.path)).map(extractRepo);
  const at = now.toISOString();
  const batch = `${BATCH_PREFIX}-${at.slice(0, 19).replace(/[:T]/g, '-')}`;
  const records = buildRecords(extracts, { batch, at, pins: basePins() });
  // A string that the public repo itself uses (a shared command like "npm test") is not private.
  // So are POCP's own file names, which every adopter has.
  const shared = new Set([...POCP_FILES, ...extracts.filter((x) => !x.repo.private).flatMap((x) => x.publicStrings)]);
  const secrets = extracts.flatMap((x) => x.secrets).filter((s) => ![...shared].some((p) => p.includes(s)));
  const file = path.join(resultsDir, 'E5', `${batch}.jsonl`);
  const md = renderResults(records, { batch, file });
  assertNoLeak(JSON.stringify(records), secrets);
  assertNoLeak(md, secrets);
  if (write) {
    for (const r of records) appendRecord(resultsDir, r);
    fs.writeFileSync(resultsMd, md);
  }
  return { records, md, batch, file, extracts };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  if (args.includes('--report')) {
    const file = newestBatchFile();
    if (!file) throw new Error('no E5 friction batch yet; run with --write');
    const records = readRecords(file);
    fs.writeFileSync(path.join(POCP_ROOT, 'eval', 'e5', 'RESULTS.md'), renderResults(records, { batch: records[0].batch, file }));
  } else {
    const { records, batch, md } = run({ repos: reposFromArgs(args), write: args.includes('--write') });
    process.stdout.write(args.includes('--write') ? `wrote ${records.length} records, batch ${batch}\n` : md);
  }
}
