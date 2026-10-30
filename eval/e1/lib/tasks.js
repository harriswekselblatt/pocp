// Frozen tasks: load, check against MANIFEST.json, draw by seed, and render the files a
// task repo holds. The repo layout is the contract shared with eval/reference/check.py.
import fs from 'node:fs';
import path from 'node:path';
import { sha256File } from '../../lib/pins.js';
import { prng } from '../../lib/stats.js';
import { EVAL_DIR } from './proc.js';

export const FROZEN_DIR = path.join(EVAL_DIR, 'tasks', 'frozen');
export const SENTINEL = 'POCP_EVAL_TESTS_PASSED';
export const CI_COMMAND = 'python3 tests/test_task.py';
export const TEST_FILE = 'tests/test_task.py';
export const SOLUTION_FILE = 'solution.py';
// PREREG §4. Used only when MANIFEST.json doesn't name the revision itself.
export const DEFAULT_DATASET = 'fjzzq2002/impossible_livecodebench@98650ffc3f28a01b261669b6d19fcd7773823710';

const REQUIRED = ['task_id', 'prompt', 'test', 'entry_point'];

export function frozenFile(split, dir = FROZEN_DIR) {
  return path.join(dir, `lcb-${split}.jsonl`);
}

export function loadTasks(file) {
  const tasks = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).map((l, i) => {
    const t = JSON.parse(l);
    for (const k of REQUIRED) if (typeof t[k] !== 'string' || !t[k]) throw new Error(`${file}:${i + 1}: task is missing "${k}"`);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(t.entry_point)) throw new Error(`${file}:${i + 1}: entry_point "${t.entry_point}" is not a Python identifier`);
    return t;
  });
  const ids = new Set();
  for (const t of tasks) {
    if (ids.has(t.task_id)) throw new Error(`${file}: duplicate task_id ${t.task_id}`);
    ids.add(t.task_id);
  }
  return tasks;
}

/** Find the sha256 the manifest lists for `name`, whatever reasonable shape it has. */
export function manifestEntry(manifest, name) {
  let found = null;
  const visit = (v, key) => {
    if (found || !v || typeof v !== 'object') return;
    if (key === name) {
      found = typeof v === 'string' ? { sha256: v } : v.sha256 ? v : null;
      if (found) return;
    }
    if (!Array.isArray(v) && (v.file === name || v.path === name || v.name === name || (typeof v.path === 'string' && path.basename(v.path) === name)) && v.sha256) {
      found = v;
      return;
    }
    for (const [k, x] of Object.entries(v)) {
      if (typeof x === 'string' && k === name && /^[0-9a-f]{64}$/.test(x)) found = { sha256: x };
      else visit(x, k);
    }
  };
  visit(manifest, null);
  return found;
}

/**
 * The frozen file for a split, checked. Returns { file, sha256, manifest_ok, dataset }.
 * manifest_ok is false when there's no manifest or it doesn't list the file; a mismatch
 * throws, because then the tasks aren't the frozen ones.
 */
export function checkFrozen(file) {
  const sha256 = sha256File(file);
  const mf = path.join(path.dirname(file), 'MANIFEST.json');
  if (!fs.existsSync(mf)) return { file, sha256, manifest_ok: false, dataset: DEFAULT_DATASET };
  const manifest = JSON.parse(fs.readFileSync(mf, 'utf8'));
  const entry = manifestEntry(manifest, path.basename(file));
  if (entry && entry.sha256 !== sha256) throw new Error(`${file}: sha256 ${sha256} doesn't match MANIFEST.json (${entry.sha256}); the frozen tasks were changed`);
  const rev = manifest.dataset_revision || manifest.revision || manifest.dataset?.revision;
  const name = manifest.dataset_name || manifest.dataset?.name || (typeof manifest.dataset === 'string' ? manifest.dataset : null);
  const dataset = name && rev ? `${name}@${rev}` : typeof manifest.dataset === 'string' && manifest.dataset.includes('@') ? manifest.dataset : rev ? `fjzzq2002/impossible_livecodebench@${rev}` : DEFAULT_DATASET;
  return { file, sha256, manifest_ok: Boolean(entry), dataset, manifest_sha256: sha256File(mf) };
}

/** Seeded Fisher-Yates over the file order. Never looks at task content. */
export function shuffled(items, seed) {
  const a = [...items];
  const rand = prng(seed);
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function drawTasks(tasks, { n, seed, ids } = {}) {
  if (ids?.length) {
    const byId = new Map(tasks.map((t) => [t.task_id, t]));
    return ids.map((id) => {
      if (!byId.has(id)) throw new Error(`task ${id} is not in the frozen file`);
      return byId.get(id);
    });
  }
  const order = shuffled(tasks.map((t) => t.task_id), seed);
  const pick = new Set(order.slice(0, n ?? tasks.length));
  return order.filter((id) => pick.has(id)).map((id) => tasks.find((t) => t.task_id === id));
}

/** solution.py: the task's prompt (signature + docstring) with a `pass` body. */
export function solutionStub(task) {
  const p = task.prompt.replace(/\s+$/, '');
  return `${p}\n    pass\n`;
}

/** tests/test_task.py: the check source, the import from the repo root, the sentinel. */
export function testFile(task, which = 'test') {
  const src = which === 'original' ? task.original_test ?? task.test : task.test;
  return [
    src.replace(/\s+$/, ''),
    '',
    '',
    'import os as _os',
    'import sys as _sys',
    '_sys.path.insert(0, _os.path.dirname(_os.path.dirname(_os.path.abspath(__file__))))',
    `from solution import ${task.entry_point}  # noqa: E402`,
    '',
    'if __name__ == "__main__":',
    `    check(${task.entry_point})`,
    `    print("${SENTINEL}")`,
    '',
  ].join('\n');
}

/** Which tests a condition commits, and in which mode the reference checker judges. */
export const CONDITIONS = {
  E1a: { tests: 'test', committed: true, mode: 'impossible', defaultSplit: 'conflicting' },
  E1b: { tests: 'test', committed: false, mode: 'impossible', defaultSplit: 'conflicting' },
  E2: { tests: 'original', committed: true, mode: 'original', defaultSplit: 'original' },
};

/**
 * Task ids MANIFEST.json flags as dataset-task-broken for this split: entries
 * { task_id, split } in any list under a key containing "broken" (the freezer writes
 * selfcheck.dataset_task_broken_candidates).
 */
export function brokenTasks(file, split) {
  const mf = path.join(path.dirname(file), 'MANIFEST.json');
  const out = new Set();
  if (!fs.existsSync(mf)) return out;
  const visit = (v, key) => {
    if (Array.isArray(v)) {
      if (/broken/i.test(key || '')) for (const e of v) if (e && e.task_id && (!e.split || e.split === split)) out.add(e.task_id);
      for (const x of v) visit(x, key);
    } else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) visit(x, k);
  };
  visit(JSON.parse(fs.readFileSync(mf, 'utf8')), null);
  return out;
}
