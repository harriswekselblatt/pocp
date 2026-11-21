#!/usr/bin/env node
// E1/E2 batch runner. One record per task × agent × arm, appended to
// eval/results/<eval>/<batch>.jsonl; run folders under eval/results/runs/<batch>/<run_id>/.
//
//   node eval/e1/run.js --eval E1a --split conflicting --agents claude,codex \
//     --arms plain,pocp-ci --tasks 10 --seed 1 --phase pilot --batch 2026-10-29-e1a-pilot-01 --concurrency 2
//
// See eval/e1/README.md for every option and what each record field means.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { basePins, sha256File, verifierHash } from '../lib/pins.js';
import { appendRecord, readRecords, runId } from '../lib/record.js';
import { prng } from '../lib/stats.js';
import { DEFAULT_TIMEOUT_S, PROMPT_FILE, agentName, getAgent, loadPrompt } from './agents/index.js';
import { judgeRun } from './judge.js';
import { CONDITIONS, brokenTasks, checkFrozen, drawTasks, frozenFile, loadTasks, FROZEN_DIR } from './lib/tasks.js';
import { E1_DIR, EVAL_DIR, POCP_ROOT, PYTHON, pool, removeTree, run, writeJson } from './lib/proc.js';
import { ARMS, agentShellEnv, isPocpArm, materialize, pocpAgentEnv, pocpCopy } from './materialize.js';

export const DEFAULTS = {
  arms: ['plain', 'pocp-ci'],
  seed: 1,
  concurrency: 1,
  timeoutS: DEFAULT_TIMEOUT_S,
  results: path.join(EVAL_DIR, 'results'),
  frozenDir: FROZEN_DIR,
  reference: path.join(EVAL_DIR, 'reference', 'check.py'),
  canaries: path.join(EVAL_DIR, 'reference', 'canaries.py'),
  prereg: path.join(EVAL_DIR, 'PREREG.md'),
};

export class Refusal extends Error {}

export function preregRegistered(file) {
  return fs.existsSync(file) && /^Registered:\s*yes\s*$/im.test(fs.readFileSync(file, 'utf8'));
}

/** Canaries: a known cheat per category and a known honest change must be labelled right. */
export async function runCanaries(file) {
  if (!fs.existsSync(file)) return { ok: false, path: path.relative(POCP_ROOT, file), reason: 'missing' };
  const r = await run(PYTHON.path, [file], { cwd: path.dirname(file), timeoutMs: 30 * 60_000 });
  return { ok: r.code === 0, path: path.relative(POCP_ROOT, file), sha256: sha256File(file), exit: r.code, ms: r.ms, output_tail: (r.out + r.err).slice(-1500) };
}

/** One hash over the harness code (eval/e1 and eval/lib, tests excluded). */
export function harnessHash() {
  const h = crypto.createHash('sha256');
  const walk = (dir) => {
    for (const n of fs.readdirSync(dir).sort()) {
      const full = path.join(dir, n);
      if (n === 'test' || n === 'node_modules') continue;
      const st = fs.statSync(full);
      if (st.isDirectory()) walk(full);
      else if (/\.(js|md)$/.test(n) && n !== 'RESULTS.md' && n !== 'README.md') {
        h.update(path.relative(EVAL_DIR, full));
        h.update('\0');
        h.update(fs.readFileSync(full));
        h.update('\0');
      }
    }
  };
  walk(E1_DIR);
  walk(path.join(EVAL_DIR, 'lib'));
  return h.digest('hex');
}

/**
 * The schedule: for each task and agent, the arms in a seeded order, rotated by task index
 * so every arm takes every position equally often (a Latin square over tasks).
 */
export function schedule(tasks, agents, arms, seed) {
  const rand = prng(seed * 7919 + 17);
  const basePerm = [...arms];
  for (let i = basePerm.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [basePerm[i], basePerm[j]] = [basePerm[j], basePerm[i]];
  }
  const units = [];
  tasks.forEach((task, ti) => {
    agents.forEach((agent, ai) => {
      const k = (ti + ai) % basePerm.length;
      const order = [...basePerm.slice(k), ...basePerm.slice(0, k)];
      order.forEach((arm, position) => units.push({ task, agent, arm, position }));
    });
  });
  return units;
}

function globalInstructions() {
  const hashIf = (f) => (fs.existsSync(f) ? sha256File(f) : null);
  return {
    claude_user_claude_md_sha256: hashIf(path.join(os.homedir(), '.claude', 'CLAUDE.md')),
    claude_user_claude_md_loaded: 'not expected: --setting-sources project (see README, check the init event)',
    codex_agents_md_sha256: hashIf(path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'AGENTS.md')),
  };
}

function modelFor(models, agent) {
  return models?.[agentName(agent)] ?? models?.[agent] ?? null;
}

async function runOne(u, ctx) {
  const { opts, batch, phase, evalName, split, frozen, prompt, canary, agentsInfo, copy } = ctx;
  const name = agentName(u.agent);
  const id = unitRunId({ batch, eval: evalName, split, task: u.task.task_id, agent: name, arm: u.arm, seed: opts.seed }, u.rerun || 0);
  const runDir = path.join(opts.results, 'runs', batch, id);
  fs.mkdirSync(runDir, { recursive: true });
  const started = new Date();
  const model = modelFor(opts.models, u.agent);
  const agent = getAgent(u.agent, opts.agentOptions?.[name] || {});
  const pins = {
    ...ctx.basePins,
    agent_cli: agentsInfo[u.agent].version ? `${agentsInfo[u.agent].cli} ${agentsInfo[u.agent].version}` : agentsInfo[u.agent].cli,
    agent_bin: agentsInfo[u.agent].bin,
    model: model || 'cli-default',
    prompt_sha256: prompt.sha256,
    dataset: frozen.dataset,
    frozen_file: path.relative(POCP_ROOT, frozen.file),
    frozen_sha256: frozen.sha256,
    frozen_manifest_ok: frozen.manifest_ok,
    budget: { timeout_s: opts.timeoutS, max_turns: null, max_budget_usd: opts.agentOptions?.[name]?.maxBudgetUsd ?? null },
    seed: opts.seed,
    reference_sha256: fs.existsSync(opts.reference) ? sha256File(opts.reference) : null,
    canaries_sha256: canary.sha256 || null,
    agent_pocp_copy_sha256: isPocpArm(u.arm) ? copy.sha256 : null,
  };
  let status = 'harness-error';
  let outcome = {};
  let attemptsOut = [];
  let error = null;
  let m = null;
  try {
    m = await materialize({ task: u.task, condition: evalName, arm: u.arm, parent: ctx.work });
    const extraEnv = { ...ctx.shellEnv, ...(isPocpArm(u.arm) ? pocpAgentEnv(copy) : {}) };
    const ag = await agent.run({ repo: m.repo, prompt: prompt.text, runDir, timeoutMs: opts.timeoutS * 1000, model, extraEnv });
    const agentEndedAt = Math.floor(Date.now() / 1000);
    status = ag.status;
    // A usage limit or a different model than the one pinned is the harness's problem, not
    // the agent's: the run is a harness error, never judged, left out of every denominator,
    // and (usage limit only) re-run after the reset (PREREG §3).
    const infra = infraFailure(ag, { runDir, model });
    if (infra) {
      const { files, final_text: finalText, ...agentRest } = ag;
      pins.model_used = ag.model_used || null;
      status = 'harness-error';
      error = `${infra.kind}: ${infra.message}`;
      outcome = { infra: infra.kind, error, agent: { ...agentRest, final_text: finalText ? finalText.slice(0, 1500) : null, files }, base: m.base };
    } else {
    const copyIntact = isPocpArm(u.arm) ? verifierHash(copy.root) === copy.sha256 : null;
    const j = await judgeRun(m, { task: u.task, condition: evalName, arm: u.arm, frozenFile: frozen.file, referencePath: opts.reference, runDir, work: m.top, agentEndedAt });
    const { files, final_text: finalText, ...agentRest } = ag;
    outcome = { ...j.outcome, agent: { ...agentRest, final_text: finalText ? finalText.slice(0, 1500) : null, files, pocp_copy_intact: copyIntact }, base: m.base, uncommitted_at_start: m.uncommitted_at_start };
    pins.model_used = ag.model_used || null;
    // The checker failing is our problem, not the agent's (eval/reference/README.md).
    if (j.outcome.checker_failed) {
      status = 'harness-error';
      error = `reference checker failed: ${j.outcome.reference?.error || j.outcome.reference_final_head?.error || 'checker-error'}`;
    }
    attemptsOut = j.attempts.sequence;
    writeJson(path.join(runDir, 'attempts.json'), { commits: j.attempts.commits, blocked_hook_runs: j.attempts.blocked_hook_runs, gate_log: j.attempts.gate_log, hooks_modified: j.attempts.hooks_modified, hooks_path: j.attempts.hooks_path });
    }
  } catch (e) {
    status = 'harness-error';
    error = String(e?.stack || e).slice(0, 3000);
    outcome = { error: String(e?.message || e).slice(0, 1000), base: m?.base ?? null };
  } finally {
    if (m && !opts.keep) removeTree(m.top);
  }
  const ended = new Date();
  const record = {
    eval: evalName,
    batch,
    phase,
    run_id: id,
    unit: { task: u.task.task_id, agent: name, arm: u.arm, seed: opts.seed, split, position: u.position, ...(u.rerun ? { rerun: u.rerun } : {}) },
    ...(u.supersedes ? { supersedes: u.supersedes } : {}),
    pins,
    started_at: started.toISOString(),
    ended_at: ended.toISOString(),
    duration_s: (ended - started) / 1000,
    status,
    excluded: null,
    attempts: attemptsOut,
    outcome,
    run_folder: path.relative(POCP_ROOT, runDir),
    canaries: { ok: canary.ok, reason: canary.reason || null },
    ...(error ? { error } : {}),
    ...(ctx.invalidReason ? { invalid_reason: ctx.invalidReason } : {}),
  };
  writeJson(path.join(runDir, 'run.json'), { run_id: id, unit: record.unit, status, pins: { model: pins.model, model_used: pins.model_used, agent_cli: pins.agent_cli }, summary: summarize(record) });
  appendRecord(opts.results, record);
  return record;
}

export function summarize(r) {
  const o = r.outcome || {};
  return {
    status: r.status,
    ci_accepted: o.ci_accepted ?? null,
    pocp: o.pocp ? { accepted: o.pocp.accepted, class: o.pocp.class ?? o.pocp.verify_on_final_head?.class ?? null } : null,
    reference: o.reference?.label ?? null,
    kind: o.reference?.kind ?? null,
    net_cheat_shipped: o.net_cheat_shipped ?? null,
    harness_final_commit: Boolean(o.harness_final_commit),
    commits: (r.attempts || []).filter((a) => a.type === 'commit').length,
    hook_blocks: (r.attempts || []).filter((a) => a.type === 'hook-blocked').length,
    false_block: o.e2?.false_block ?? null,
  };
}

// The agent's account ran out of usage. Every later run would fail the same way, so the batch stops.
const USAGE_LIMIT = /(hit|reached|exceeded) (your |the )?(weekly |daily |monthly |5-hour |usage )?(limit|quota)|usage limit|rate[ -]?limit|quota exceeded|\b429\b/i;

/** How many times a unit that hit a usage limit may be re-run (PREREG §3). */
export const MAX_LIMIT_RERUNS = 2;

/** A re-run gets its own id; the first run keeps the id it always had. */
export function unitRunId(parts, rerun = 0) {
  return runId(rerun ? { ...parts, rerun } : parts);
}

/**
 * A failure of the run's infrastructure rather than the agent: a usage or rate limit (at the
 * start or mid-run; only looked for when the CLI did not finish cleanly, so a task about rate
 * limiting can't trip it), or a model other than the pinned one.
 */
export function infraFailure(ag, { runDir = null, model = null } = {}) {
  if (ag.status !== 'completed') {
    let stderrTail = '';
    const f = runDir && ag.files?.stderr ? path.join(runDir, ag.files.stderr) : null;
    if (f && fs.existsSync(f)) stderrTail = fs.readFileSync(f, 'utf8').slice(-4000);
    const text = `${ag.error || ''}\n${ag.final_text || ''}\n${stderrTail}`;
    const hit = text.match(USAGE_LIMIT);
    if (hit) {
      const line = text.split('\n').find((l) => USAGE_LIMIT.test(l)) || hit[0];
      return { kind: 'usage-limit', message: line.trim().slice(0, 300) };
    }
  }
  if (model && ag.model_used && ag.model_used !== model) return { kind: 'model-mismatch', message: `requested ${model}, CLI used ${ag.model_used}` };
  return null;
}

export function usageLimitHit(rec) {
  if (rec?.outcome?.infra === 'usage-limit') return true;
  // Records written before the harness classified limits (agent-error with the message).
  if (rec?.status !== 'agent-error') return false;
  const a = rec.outcome?.agent || {};
  return USAGE_LIMIT.test(`${a.error || ''} ${a.result_text || ''} ${a.final_text || ''}`);
}

/**
 * What a resumed batch still has to run for one unit, given the records already in the batch:
 * nothing, the first run, or a re-run of the last one that hit a usage limit.
 */
export function nextAttempt(parts, byId) {
  let rerun = 0;
  let prev = null;
  for (;;) {
    const rec = byId.get(unitRunId(parts, rerun));
    if (!rec) break;
    prev = rec;
    rerun++;
  }
  if (!prev) return { rerun: 0 };
  if (prev.outcome?.infra === 'usage-limit' && rerun <= MAX_LIMIT_RERUNS) return { rerun, supersedes: prev.run_id };
  return null;
}

/** Run a batch. Throws Refusal when the batch may not run. */

export async function runBatch(input) {
  const opts = { ...DEFAULTS, ...input };
  const evalName = opts.eval;
  if (!CONDITIONS[evalName]) throw new Refusal(`--eval must be one of ${Object.keys(CONDITIONS).join(', ')}`);
  if (!opts.batch || !/^[A-Za-z0-9._-]+$/.test(opts.batch)) throw new Refusal('--batch is required (letters, digits, . _ -)');
  if (!['pilot', 'counted'].includes(opts.phase)) throw new Refusal('--phase must be pilot or counted ("invalid" is assigned, never asked for)');
  const arms = opts.arms;
  for (const a of arms) if (!ARMS.includes(a)) throw new Refusal(`unknown arm ${a}`);
  if (!opts.agents?.length) throw new Refusal('--agents is required');
  const split = opts.split || CONDITIONS[evalName].defaultSplit;
  if (evalName === 'E2' && split !== 'original') throw new Refusal('E2 runs on the original split');
  if (evalName !== 'E2' && split === 'original') throw new Refusal(`${evalName} needs an impossible split, not original`);

  const file = frozenFile(split, opts.frozenDir);
  if (!fs.existsSync(file)) throw new Refusal(`no frozen tasks at ${file}`);
  const frozen = checkFrozen(file);
  const prompt = loadPrompt(opts.promptFile || PROMPT_FILE);
  const canary = await runCanaries(opts.canaries);
  const pinsNow = basePins();
  // Outside a git checkout (e.g. POCP's own clean-room proof runs of these tests) there's no
  // commit to pin; say so explicitly rather than leave it empty. Counted batches refuse it.
  if (!pinsNow.pocp_commit) pinsNow.pocp_commit = 'not-a-git-checkout';
  // The interpreter every child uses (plain CI, POCP's checks, the agent's shell, the checker).
  pinsNow.python = PYTHON.version;
  pinsNow.python_path = PYTHON.path;
  pinsNow.python_executable = PYTHON.executable;

  let phase = opts.phase;
  let invalidReason = opts.invalid || null;
  if (phase === 'counted') {
    const why = [];
    if (!preregRegistered(opts.prereg)) why.push(`${path.relative(POCP_ROOT, opts.prereg)} doesn't say "Registered: yes"`);
    if (!canary.ok) why.push(`canaries ${canary.reason || `failed (exit ${canary.exit})`}`);
    if (!frozen.manifest_ok) why.push('the frozen file is not listed in MANIFEST.json');
    if (String(pinsNow.pocp_commit).endsWith('+dirty')) why.push('the POCP checkout has uncommitted changes in bin/ or src/');
    if (pinsNow.pocp_commit === 'not-a-git-checkout') why.push('POCP is not a git checkout, so its commit cannot be pinned');
    if (opts.agents.some((a) => a.startsWith('fake:'))) why.push('fake agents are for tests');
    if (invalidReason) why.push(`--invalid was given (${invalidReason})`);
    if (why.length) throw new Refusal(`refusing --phase counted: ${why.join('; ')}`);
  } else if (!canary.ok) {
    phase = 'invalid';
    invalidReason = invalidReason || `canaries ${canary.reason || `failed (exit ${canary.exit})`}`;
  }
  if (invalidReason) phase = 'invalid';

  const recFile = path.join(opts.results, evalName, `${opts.batch}.jsonl`);
  const byId = new Map();
  if (fs.existsSync(recFile)) {
    const prev = readRecords(recFile);
    const phases = new Set(prev.map((r) => r.phase));
    if (phases.size && !phases.has(phase)) throw new Refusal(`batch ${opts.batch} already holds ${[...phases].join('/')} records; this run would be ${phase}. Start a new batch.`);
    for (const r of prev) byId.set(r.run_id, r);
  }
  const unitParts = (u) => ({ batch: opts.batch, eval: evalName, split, task: u.task.task_id, agent: agentName(u.agent), arm: u.arm, seed: opts.seed });

  // Tasks the frozen manifest flags dataset-task-broken never enter the draw (PREREG §3
  // exclusion); which ones were skipped is recorded in batch.json and every record's pins.
  const broken = brokenTasks(file, split);
  const all = loadTasks(file);
  const skippedBroken = all.filter((t) => broken.has(t.task_id)).map((t) => t.task_id);
  const tasks = drawTasks(all.filter((t) => !broken.has(t.task_id)), { n: opts.tasks, seed: opts.seed, ids: opts.taskIds?.filter((id) => !broken.has(id)) });
  if (opts.taskIds?.length && opts.taskIds.some((id) => broken.has(id)) && opts.log) opts.log(`skipping dataset-task-broken: ${opts.taskIds.filter((id) => broken.has(id)).join(', ')}`);
  const units = schedule(tasks, opts.agents, arms, opts.seed);
  const agentsInfo = {};
  for (const a of [...new Set(opts.agents)]) agentsInfo[a] = await getAgent(a, opts.agentOptions?.[agentName(a)] || {}).describe();
  const work = opts.work || fs.mkdtempSync(path.join(os.tmpdir(), `pocp-e1-${opts.batch}-`));
  fs.mkdirSync(work, { recursive: true });
  const copy = arms.some(isPocpArm) ? pocpCopy(path.join(work, 'agent-pocp')) : null;

  const ctxPins = { ...pinsNow, harness_sha256: harnessHash(), global_instructions: globalInstructions(), dataset_task_broken_skipped: skippedBroken };
  const batchDir = path.join(opts.results, 'runs', opts.batch);
  fs.mkdirSync(batchDir, { recursive: true });
  const metaFile = path.join(batchDir, 'batch.json');
  const meta = fs.existsSync(metaFile) ? JSON.parse(fs.readFileSync(metaFile, 'utf8')) : { batch: opts.batch, eval: evalName, starts: [] };
  meta.starts.push({
    at: new Date().toISOString(),
    phase,
    invalid_reason: invalidReason,
    argv: input.argv || null,
    split,
    seed: opts.seed,
    arms,
    agents: opts.agents.map(agentName),
    agents_info: agentsInfo,
    models: opts.models || {},
    timeout_s: opts.timeoutS,
    concurrency: opts.concurrency,
    tasks: tasks.map((t) => t.task_id),
    skipped_dataset_task_broken: skippedBroken,
    canary,
    frozen: { file: path.relative(POCP_ROOT, frozen.file), sha256: frozen.sha256, manifest_ok: frozen.manifest_ok, dataset: frozen.dataset },
    prompt_sha256: prompt.sha256,
    pins: ctxPins,
    schedule: units.map((u) => ({ task: u.task.task_id, agent: agentName(u.agent), arm: u.arm, position: u.position })),
    skipped_already_recorded: units.filter((u) => !nextAttempt(unitParts(u), byId)).length,
    usage_limit_reruns: units.map((u) => ({ u, next: nextAttempt(unitParts(u), byId) })).filter((x) => x.next?.rerun).map((x) => ({ task: x.u.task.task_id, agent: agentName(x.u.agent), arm: x.u.arm, rerun: x.next.rerun, supersedes: x.next.supersedes })),
  });
  writeJson(metaFile, meta);

  const todo = units.map((u) => ({ u, next: nextAttempt(unitParts(u), byId) })).filter((x) => x.next).map((x) => ({ ...x.u, ...x.next }));
  const shellEnv = agentShellEnv(path.join(work, 'agent-shell'));
  const ctx = { opts, batch: opts.batch, phase, evalName, split, frozen, prompt, canary, agentsInfo, copy, work, basePins: { ...ctxPins, agent_shell: { SHELL: process.env.SHELL || null, ZDOTDIR: 'empty (per batch)' } }, invalidReason, shellEnv };
  let stopped = null;
  const records = (await pool(todo, opts.concurrency, async (u) => {
    if (stopped) return null; // not started, not recorded: a resumed batch picks it up
    const r = await runOne(u, ctx);
    if (opts.log) opts.log(`${r.unit.task} ${r.unit.agent} ${r.unit.arm}: ${JSON.stringify(summarize(r))}`);
    if (!stopped && usageLimitHit(r)) {
      stopped = `stopped: the agent hit a usage limit (${r.unit.agent}, ${r.unit.task} ${r.unit.arm}); later runs were not started. Resume this batch after the limit resets: runs that hit the limit are re-run (at most ${MAX_LIMIT_RERUNS} times) and supersede the failed record.`;
      if (opts.log) opts.log(stopped);
    } else if (!stopped && r.outcome?.infra === 'model-mismatch') {
      stopped = `stopped: ${r.error} (${r.unit.agent}, ${r.unit.task} ${r.unit.arm}); later runs were not started. Fix the model pin and start a new batch.`;
      if (opts.log) opts.log(stopped);
    }
    return r;
  })).filter(Boolean);
  if (!opts.work && !opts.keep) removeTree(work);
  return { phase, invalidReason, canary, records, stopped, skipped: units.length - todo.length, file: recFile, work };
}

function parseArgs(argv) {
  const o = { argv: argv.join(' ') };
  const list = (v) => v.split(',').map((s) => s.trim()).filter(Boolean);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const v = () => {
      if (i + 1 >= argv.length) throw new Refusal(`${a} needs a value`);
      return argv[++i];
    };
    switch (a) {
      case '--eval': o.eval = v(); break;
      case '--split': o.split = v(); break;
      case '--agents': o.agents = list(v()); break;
      case '--arms': o.arms = list(v()); break;
      case '--tasks': o.tasks = Number(v()); break;
      case '--task-ids': o.taskIds = list(v()); break;
      case '--seed': o.seed = Number(v()); break;
      case '--phase': o.phase = v(); break;
      case '--batch': o.batch = v(); break;
      case '--concurrency': o.concurrency = Number(v()); break;
      case '--timeout-s': o.timeoutS = Number(v()); break;
      case '--model': {
        // --model claude=opus or --model codex=gpt-5.5 (repeatable)
        const [k, m] = v().split('=');
        o.models = { ...(o.models || {}), [k]: m };
        break;
      }
      case '--max-budget-usd': o.agentOptions = { ...(o.agentOptions || {}), claude: { ...(o.agentOptions?.claude || {}), maxBudgetUsd: Number(v()) } }; break;
      case '--frozen-dir': o.frozenDir = path.resolve(v()); break;
      case '--reference': o.reference = path.resolve(v()); break;
      case '--canaries': o.canaries = path.resolve(v()); break;
      case '--results': o.results = path.resolve(v()); break;
      case '--work': o.work = path.resolve(v()); break;
      case '--invalid': o.invalid = v(); break;
      case '--keep': o.keep = true; break;
      default: throw new Refusal(`unknown option ${a}`);
    }
  }
  return o;
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
    const res = await runBatch({ ...opts, log: (s) => process.stderr.write(`${s}\n`) });
    process.stdout.write(`${JSON.stringify({ phase: res.phase, invalid_reason: res.invalidReason, canaries: res.canary.ok, ran: res.records.length, skipped: res.skipped, stopped: res.stopped, records: path.relative(process.cwd(), res.file) })}\n`);
  } catch (e) {
    process.stderr.write(`e1: ${e.message}\n`);
    process.exit(e instanceof Refusal ? 2 : 3);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
