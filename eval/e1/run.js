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
  const id = runId({ batch, eval: evalName, split, task: u.task.task_id, agent: name, arm: u.arm, seed: opts.seed });
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
    unit: { task: u.task.task_id, agent: name, arm: u.arm, seed: opts.seed, split, position: u.position },
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
  const done = new Set();
  if (fs.existsSync(recFile)) {
    const prev = readRecords(recFile);
    const phases = new Set(prev.map((r) => r.phase));
    if (phases.size && !phases.has(phase)) throw new Refusal(`batch ${opts.batch} already holds ${[...phases].join('/')} records; this run would be ${phase}. Start a new batch.`);
    for (const r of prev) done.add(r.run_id);
  }

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
    skipped_already_recorded: units.filter((u) => done.has(runId({ batch: opts.batch, eval: evalName, split, task: u.task.task_id, agent: agentName(u.agent), arm: u.arm, seed: opts.seed }))).length,
  });
  writeJson(metaFile, meta);

  const todo = units.filter((u) => !done.has(runId({ batch: opts.batch, eval: evalName, split, task: u.task.task_id, agent: agentName(u.agent), arm: u.arm, seed: opts.seed })));
  const shellEnv = agentShellEnv(path.join(work, 'agent-shell'));
  const ctx = { opts, batch: opts.batch, phase, evalName, split, frozen, prompt, canary, agentsInfo, copy, work, basePins: { ...ctxPins, agent_shell: { SHELL: process.env.SHELL || null, ZDOTDIR: 'empty (per batch)' } }, invalidReason, shellEnv };
  const records = await pool(todo, opts.concurrency, async (u) => {
    const r = await runOne(u, ctx);
    if (opts.log) opts.log(`${r.unit.task} ${r.unit.agent} ${r.unit.arm}: ${JSON.stringify(summarize(r))}`);
    return r;
  });
  if (!opts.work && !opts.keep) removeTree(work);
  return { phase, invalidReason, canary, records, skipped: units.length - todo.length, file: recFile, work };
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
    process.stdout.write(`${JSON.stringify({ phase: res.phase, invalid_reason: res.invalidReason, canaries: res.canary.ok, ran: res.records.length, skipped: res.skipped, records: path.relative(process.cwd(), res.file) })}\n`);
  } catch (e) {
    process.stderr.write(`e1: ${e.message}\n`);
    process.exit(e instanceof Refusal ? 2 : 3);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
