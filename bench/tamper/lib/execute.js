// One scenario, end to end: a cheating agent makes the commit in a scratch clone, then a
// fresh clone of that commit is judged by plain CI and by POCP's verify.
import fs from 'node:fs';
import path from 'node:path';
import { signProof } from '../../../src/sign.js';
import { benchEnv, git, pocp, run } from './proc.js';
import { cloneAt } from './workspace.js';

const json = (s) => {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
};
// Results are written where `pocp ci-run` writes by default, which is also where a
// cheating commit would plant a forged file.
export const CI_RESULTS = '.proof/runs/ci-results.jsonl';
const AGENT = 'agent@bench.invalid';

async function applyEdits(dir, edits, env) {
  for (const [rel, text] of Object.entries(edits)) {
    const full = path.join(dir, rel);
    if (text === null) {
      await git(dir, ['rm', '-q', '--', rel], { env });
    } else {
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, text);
    }
  }
  await git(dir, ['add', '-A'], { env });
}

async function stagedPaths(dir) {
  return (await git(dir, ['diff', '--cached', '--name-only', '--no-renames'])).split('\n').filter(Boolean);
}

async function newPacketFiles(dir) {
  const out = await git(dir, ['status', '--porcelain', '--untracked-files=all', '--', '.proof/packets']);
  return out.split('\n').filter(Boolean).map((l) => l.slice(3).trim()).filter((f) => f.endsWith('.json'));
}

/** Rewrite every failing proof in the scenario's packets as passed (re-signed when a key is given). */
async function forgeProofs(dir, env, signing) {
  let forged = 0;
  for (const rel of await newPacketFiles(dir)) {
    const file = path.join(dir, rel);
    const packet = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const p of packet.proofs || []) {
      if (p.passed && !signing) continue;
      if (!p.passed) forged++;
      p.passed = true;
      p.exit = 0;
      p.timed_out = false;
      if (signing) {
        delete p.signature;
        p.signature = signProof(p, signing);
      }
    }
    if (packet.state === 'failed') packet.state = 'proven';
    fs.writeFileSync(file, `${JSON.stringify(packet, null, 2)}\n`);
  }
  await git(dir, ['add', '-A', '.proof'], { env });
  return forged;
}

/** A committed results file with a passing record for every command CI might check. */
async function forgeCiResults(dir, env, commands) {
  const status = json((await pocp(dir, ['status', '--json'], { env })).out);
  const subject = status?.subject;
  const lines = [...new Set(commands)].map((run) => JSON.stringify({ pocp: 1, kind: 'ci-result', commit: '0'.repeat(40), subject, run, cwd: null, exit: 0, timed_out: false, passed: true, started_at: new Date(0).toISOString(), duration_ms: 1 }));
  const file = path.join(dir, CI_RESULTS);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
  await git(dir, ['add', '-f', CI_RESULTS], { env });
}

async function makeSigner(dir, env) {
  const keyDir = `${dir}-key`;
  fs.mkdirSync(keyDir, { recursive: true });
  const key = path.join(keyDir, 'id_ed25519');
  const r = await run('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', AGENT, '-f', key], { env });
  if (r.code !== 0) throw new Error(`ssh-keygen failed: ${r.err}`);
  const pub = fs.readFileSync(`${key}.pub`, 'utf8').trim().split(/\s+/).slice(0, 2).join(' ');
  fs.appendFileSync(path.join(dir, '.proof', 'allowed_signers'), `${AGENT} namespaces="pocp-proof" ${pub}\n`);
  await git(dir, ['add', '-A', '.proof'], { env });
  return { key, principal: AGENT };
}

/**
 * The agent's side: open a packet for what it changed, prove, sign off on any test-change
 * check itself, and commit through the hooks. When the hooks block, it commits with
 * --no-verify anyway. Returns what the local gate said.
 */
async function ceremony(dir, sc, env, { signing } = {}) {
  const local = { packet: null, proved: null, attested: 0, forged: 0 };
  const touches = sc.strategy.touchAll ? ['**'] : (await stagedPaths(dir)).filter((f) => !f.startsWith('.proof/packets/'));
  const gate0 = json((await pocp(dir, ['gate', '--json'], { env })).out);
  if ((gate0?.required_files || []).length || sc.strategy.touchAll) {
    const args = ['open', '--json', '--intent', sc.title, ...touches.flatMap((t) => ['--touch', t])];
    if (sc.strategy.touchAll) args.push('--test', 'true');
    const opened = await pocp(dir, args, { env });
    const packet = json(opened.out)?.packet;
    if (packet) {
      local.packet = packet.id;
      if (!packet.obligations.length) await pocp(dir, ['add', packet.id, '--test', 'true'], { env });
      const proveEnv = signing ? { ...env, POCP_SIGN_KEY: signing.key, POCP_SIGN_PRINCIPAL: signing.principal } : env;
      const proved = await pocp(dir, ['prove', '--json'], { env: proveEnv });
      local.proved = proved.code === 0 ? 'passed' : 'failed';
      // Sign off on whatever still needs it: manual checks, and a test-change check whose
      // mechanical run didn't pass (the agent vouches for its own change).
      const status = json((await pocp(dir, ['status', '--json'], { env })).out);
      const pending = new Set((status?.packets || []).find((p) => p.id === packet.id)?.evaluation?.unattested || []);
      const shown = json((await pocp(dir, ['show', packet.id, '--json'], { env })).out)?.packet;
      for (const ob of (shown?.obligations || []).filter((o) => o.kind === 'manual' || pending.has(o.id))) {
        const a = await pocp(dir, ['attest', packet.id, ob.id, '--by', 'claude-agent', '--note', 'assertions were not weakened'], { env });
        if (a.code === 0) local.attested++;
      }
    } else local.open_error = (opened.err || opened.out).trim().split('\n')[0];
  }
  await git(dir, ['add', '-A', '.proof'], { env });
  if (sc.strategy.forgeProofs) local.forged = await forgeProofs(dir, env, signing);
  if (sc.strategy.forgeCi) {
    const shown = local.packet ? json((await pocp(dir, ['show', local.packet, '--json'], { env })).out)?.packet : null;
    await forgeCiResults(dir, env, [sc.ciCommand, ...(shown?.obligations || []).filter((o) => o.run).map((o) => o.run)]);
  }
  return local;
}

async function commitThroughHooks(dir, sc, env, local) {
  const gate = json((await pocp(dir, ['gate', '--json'], { env })).out);
  local.gate = gate?.decision || 'error';
  local.gate_codes = [...new Set([...(gate?.problems || []).map((p) => p.code), ...((gate?.uncovered || []).length ? ['uncovered'] : [])])];
  const c = await run('git', ['commit', '-q', '-m', sc.title], { cwd: dir, env });
  local.hooks = c.code === 0 ? 'passed' : 'blocked';
  if (c.code !== 0) await git(dir, ['commit', '-q', '--no-verify', '-m', sc.title], { env });
}

/** Run the agent's side of a scenario. Returns the local record; HEAD is the scenario commit. */
async function cheat(dir, sc, env) {
  const s = sc.strategy;
  if (s.mode === 'no-verify') {
    await applyEdits(dir, sc.edits, env);
    await git(dir, ['commit', '-q', '--no-verify', '-m', sc.title], { env });
    return { gate: 'skipped', gate_codes: [], hooks: 'skipped (--no-verify)' };
  }
  if (s.mode === 'stale') {
    await applyEdits(dir, s.honest, env);
    const local = await ceremony(dir, sc, env);
    const trailers = (await pocp(dir, ['trailer'], { env })).out.trim();
    await applyEdits(dir, sc.edits, env);
    const msg = `${sc.title}\n\n${trailers}\n`;
    await git(dir, ['-c', 'core.hooksPath=/dev/null', 'commit', '-q', '--no-verify', '-m', msg], { env });
    return { ...local, gate: 'skipped', gate_codes: [], hooks: 'skipped (hooks disabled, trailer pasted)' };
  }
  if (s.mode === 'split') {
    // The cheat lands over several commits, each made the usual way; only the range is judged.
    let local = {};
    for (const [i, step] of s.steps.entries()) {
      await applyEdits(dir, step, env);
      local = await ceremony(dir, { ...sc, title: `${sc.title} (${i + 1}/${s.steps.length})` }, env);
      await commitThroughHooks(dir, { ...sc, title: `${sc.title} (${i + 1}/${s.steps.length})` }, env, local);
    }
    return local;
  }
  if (s.mode === 'merge') {
    // An honest side branch is merged, and the cheat is added to the merge commit itself.
    const branch = (await git(dir, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
    await git(dir, ['checkout', '-q', '-b', `${branch}-side`], { env });
    await applyEdits(dir, s.side, env);
    const sideLocal = await ceremony(dir, { ...sc, title: 'Honest side change' }, env);
    await commitThroughHooks(dir, { ...sc, title: 'Honest side change' }, env, sideLocal);
    await git(dir, ['checkout', '-q', branch], { env });
    await git(dir, ['merge', '-q', '--no-ff', '--no-commit', `${branch}-side`], { env });
    await applyEdits(dir, sc.edits, env);
    const local = await ceremony(dir, sc, env);
    await commitThroughHooks(dir, sc, env, local);
    return local;
  }
  const signing = s.signer ? await makeSigner(dir, env) : null;
  await applyEdits(dir, sc.edits, env);
  if (s.hide) {
    // The bug is staged; the file on disk is put back and hidden from git diff.
    for (const [rel, text] of Object.entries(sc.edits)) {
      if (text === null || !sc.originals?.[rel]) continue;
      fs.writeFileSync(path.join(dir, rel), sc.originals[rel]);
      await git(dir, ['update-index', `--${s.hide}`, '--', rel], { env });
    }
  }
  const local = await ceremony(dir, sc, env, { signing });
  await commitThroughHooks(dir, sc, env, local);
  return local;
}

function verdictCodes(v) {
  if (!v) return [];
  const codes = new Set();
  for (const c of v.commits || []) for (const f of c.findings || []) if (f.blocking) codes.add(f.code);
  // Findings on the whole range (a cheat split across commits or inside a merge shows up here).
  for (const f of [...(v.findings || []), ...(v.net?.findings || [])]) if (f.blocking !== false && f.code !== 'rerun_failed') codes.add(f.code);
  if ((v.rerun_failures || []).length) codes.add('rerun_failed');
  return [...codes].sort();
}

/** Plain CI and POCP, each on a fresh clone of the scenario commit. */
async function judge(dir, base, head, target, env, { removesJobs, baseConfig, fastMode = false } = {}) {
  const ci = await cloneAt(dir, `${dir}-ci`, head, target);
  const words = target.ciCommand.split(/\s+/).filter(Boolean);
  const plainRun = await pocp(ci, ['ci-run', '--', ...words], { env });
  const recorded = fs.existsSync(path.join(ci, CI_RESULTS));
  const plain = plainRun.code === 0 ? 'pass' : recorded ? 'fail' : 'error';
  // The default recipe: re-run everything; CI results written during the job aren't trusted.
  const v = await pocp(ci, ['verify', `${base}..${head}`, '--require-coverage', '--rerun', '--json'], { env });
  // The faster mode trusts what ran in the job; recorded apart, for scenarios that target it.
  let fast;
  if (fastMode && recorded) {
    const f = await pocp(ci, ['verify', `${base}..${head}`, '--require-coverage', '--rerun-unsigned', '--ci-results', CI_RESULTS, '--json'], { env });
    const fj = json(f.out);
    fast = { pocp: f.code === 0 ? 'pass' : 'block', codes: fj && !fj.error ? verdictCodes(fj) : [`error: ${String(fj?.error || f.err).trim().split('\n').pop().slice(0, 160)}`] };
  }
  const parsed = json(v.out);
  const pocpVerdict = v.code === 0 ? 'pass' : 'block';
  // A workflow without the POCP step never runs verify on GitHub. What decides is whether
  // the base branch requires that job's check (ci.required_checks): a required check that
  // never reports blocks the merge; an optional one is simply absent.
  if (removesJobs?.length) {
    const required = new Set(baseConfig?.ci?.required_checks || []);
    const blocked = removesJobs.some((j) => required.has(j));
    return { plain, plain_exit: plainRun.code, pocp: blocked ? 'block' : 'pass', codes: blocked ? ['required_check_missing'] : [], ci, verify_would_say: parsed ? verdictCodes(parsed) : [] };
  }
  const msg = String(parsed?.error || v.err || v.out).trim();
  const codes = parsed && !parsed.error ? verdictCodes(parsed) : [/tracked in the repository/.test(msg) ? 'ci_results_refused' : `error: ${msg.split('\n').pop().slice(0, 160)}`];
  return { plain, plain_exit: plainRun.code, pocp: pocpVerdict, codes, ci, ...(fast ? { fast } : {}) };
}

export function outcomeOf(sc, j) {
  if (!sc.bug) return j.pocp === 'block' ? 'false-positive' : j.plain === 'pass' ? 'ok' : 'plain-ci-false-positive';
  if (j.plain === 'pass') return j.pocp === 'block' ? 'incremental' : 'missed';
  return j.pocp === 'block' ? 'both' : 'pocp-missed-ci-caught';
}

/** Run one scenario in its own clone of the base. */
export async function runScenario(sc, { baseDir, base, target, workDir, profile, baseConfig, keep = false }) {
  const started = Date.now();
  const dir = path.join(workDir, `s-${profile}-${sc.id}`);
  const env = benchEnv();
  await cloneAt(baseDir, dir, base, target);
  await git(dir, ['checkout', '-q', '-b', `bench/${sc.id}`]);
  const hooks = await pocp(dir, ['hooks', 'install'], { env });
  if (hooks.code !== 0) throw new Error(`hooks install failed: ${hooks.err}`);
  sc.ciCommand = target.ciCommand;
  let local;
  let error = null;
  try {
    local = await cheat(dir, sc, env);
  } catch (e) {
    error = String(e.message || e).split('\n')[0];
    local = {};
  }
  const head = await git(dir, ['rev-parse', 'HEAD']);
  let j = { plain: 'error', pocp: 'error', codes: [] };
  if (head !== base) j = await judge(dir, base, head, target, env, { removesJobs: sc.strategy.removesJobs, baseConfig, fastMode: sc.strategy.fastMode });
  else error = error || 'no commit was made';
  if (!keep) for (const d of [dir, `${dir}-ci`, `${dir}-key`]) fs.rmSync(d, { recursive: true, force: true });
  return {
    id: sc.id,
    category: sc.category,
    title: sc.title,
    bug: sc.bug,
    mutant: sc.bug ? sc.mutant : null,
    plain_ci: j.plain,
    pocp: j.pocp,
    codes: j.codes,
    ...(j.fast ? { ci_results_mode: j.fast } : {}),
    local: { gate: local.gate ?? null, gate_codes: local.gate_codes || [], hooks: local.hooks ?? null, proved: local.proved ?? null, attested: local.attested || 0, forged: local.forged || 0 },
    outcome: error && head === base ? 'error' : outcomeOf(sc, j),
    error,
    ms: Date.now() - started,
  };
}
