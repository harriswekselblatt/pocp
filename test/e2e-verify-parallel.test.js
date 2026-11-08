import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { git, pocp, sampleRepo, write, writeConfig, writeRules } from './helpers.js';
import { commit } from './fixtures.js';
import { createRunMemo } from '../src/engine.js';

// Every check run appends "<label> start|end <ms>" to this log (outside every snapshot), so a
// test can see which runs happened and whether they overlapped.
function check(label) {
  return [
    "import fs from 'node:fs';",
    "import { add } from '../src/math.js';",
    `const say = (what) => process.env.RUN_LOG && fs.appendFileSync(process.env.RUN_LOG, \`${label} \${what} \${Date.now()}\\n\`);`,
    "say('start');",
    'await new Promise((r) => setTimeout(r, 1200));',
    "if (add(2, 3) !== 5) { say('fail'); process.exit(1); }",
    "say('end');",
    '',
  ].join('\n');
}

/** Two checks; one commit on top of `base` edits the first check's test and the code. */
function parallelRepo() {
  const dir = sampleRepo();
  write(dir, 'test/a.check.mjs', check('a-base'));
  write(dir, 'test/b.check.mjs', check('b'));
  writeRules(dir, {
    triggers: { broad_files: 6, cross_area: { areas: 3, min_files: 4 }, globs: [] },
    requirements: [
      { id: 'a', globs: ['src/**', 'test/**'], obligation: { kind: 'test', run: 'node test/a.check.mjs' }, source: 'author' },
      { id: 'b', globs: ['src/**', 'test/**'], obligation: { kind: 'test', run: 'node test/b.check.mjs' }, source: 'author' },
    ],
  });
  writeConfig(dir, { ...JSON.parse(fs.readFileSync(path.join(dir, '.proof/config.json'), 'utf8')), guard: { mutants: 0 } });
  git(dir, 'add', '-A');
  git(dir, '-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', 'two checks');
  const base = git(dir, 'rev-parse', 'HEAD');
  write(dir, 'src/math.js', `${fs.readFileSync(path.join(dir, 'src/math.js'), 'utf8')}// tweak\n`);
  write(dir, 'test/a.check.mjs', check('a-head'));
  git(dir, 'add', '-A');
  assert.equal(pocp(dir, ['fix', '--intent', 'tweak and reword a check']).code, 0);
  assert.equal(commit(dir, 'tweak').status, 0);
  return { dir, base };
}

function readLog(file) {
  const runs = new Map();
  for (const line of fs.readFileSync(file, 'utf8').trim().split('\n')) {
    const [label, what, at] = line.split(' ');
    if (!runs.has(label)) runs.set(label, []);
    if (what === 'start') runs.get(label).push({ start: Number(at) });
    else runs.get(label).at(-1).end = Number(at);
  }
  return runs;
}

test('verify --rerun runs the re-runs and the test guard side by side, each check once per code', () => {
  const { dir, base } = parallelRepo();
  const log = path.join(dir, '..', `${path.basename(dir)}-runs.log`);
  const v = pocp(dir, ['verify', `${base}..HEAD`, '--rerun', '--accept-test-change', '--jobs', '4', '--json'], { env: { RUN_LOG: log } });
  assert.equal(v.code, 0, v.stdout + v.stderr);
  const runs = readLog(log);
  // a-head and b on the new code: the guard's new-code baseline and the tip's re-run share
  // those runs (not run again). The old tests: a-base (restored) and b on the new code.
  assert.equal(runs.get('a-head').length, 1, 'a on the new code ran once');
  assert.equal(runs.get('a-base').length, 1, 'the old a ran once');
  assert.equal(runs.get('b').length, 2, 'b ran once on each tree (new code; new code with the old tests)');
  const [rerunA] = runs.get('a-head');
  const [oldA] = runs.get('a-base');
  assert.ok(oldA.start < rerunA.end && rerunA.start < oldA.end, 'the old tests ran while the re-run was running');
  // One commit: the guard claims the new-code runs first, and the tip's re-run reuses them.
  const guard = v.json.commits[0].test_guard.mechanical[0].result;
  assert.ok(guard.new_tests.runs.every((r) => !r.reused));
  assert.ok(v.json.reruns.filter((r) => /check\.mjs/.test(r.run)).every((r) => /already run on this commit/.test(r.reused)));
});

test('verify --jobs 1 runs one check at a time, with the same verdict', () => {
  const { dir, base } = parallelRepo();
  const log = path.join(dir, '..', `${path.basename(dir)}-runs.log`);
  const v = pocp(dir, ['verify', `${base}..HEAD`, '--rerun', '--accept-test-change', '--jobs', '1', '--json'], { env: { RUN_LOG: log } });
  assert.equal(v.code, 0, v.stdout + v.stderr);
  const all = [...readLog(log).values()].flat().sort((x, y) => x.start - y.start);
  assert.equal(all.length, 4);
  for (let i = 1; i < all.length; i++) assert.ok(all[i].start >= all[i - 1].end, 'no two checks overlapped');
});

test('memo.share: a check asked for while it runs is run once; only a pass is shared', async () => {
  const memo = createRunMemo({ jobs: 4 });
  const ob = { id: 'o1', run: 'node t.js' };
  let runs = 0;
  const slowPass = () => new Promise((r) => setTimeout(() => r({ passed: true, duration_ms: 7 }), 30)).finally(() => runs++);
  const [a, b] = await Promise.all([memo.share('s1', ob, slowPass), memo.share('s1', ob, slowPass)]);
  assert.equal(runs, 1);
  assert.ok(a.result.passed);
  assert.deepEqual(b.reused, { duration_ms: 7 });
  // Other code, another check: their own runs.
  await memo.share('s2', ob, slowPass);
  await memo.share('s1', { id: 'o2', run: 'node u.js' }, slowPass);
  assert.equal(runs, 3);

  // A failure (or a run that didn't finish) is never shared: whoever waited runs it itself.
  let failRuns = 0;
  const fail = () => new Promise((r) => setTimeout(() => r({ passed: false, exit: 1 }), 30)).finally(() => failRuns++);
  const ob3 = { id: 'o3', run: 'node v.js' };
  const [c, d] = await Promise.all([memo.share('s1', ob3, fail), memo.share('s1', ob3, fail)]);
  assert.equal(failRuns, 2);
  assert.equal(c.result.passed, false);
  assert.equal(d.result.passed, false);

  // A check that matches output is never shared either.
  let expectRuns = 0;
  const ob4 = { id: 'o4', run: 'node w.js', expect: 'ok' };
  await Promise.all([memo.share('s1', ob4, () => slowPass().finally(() => expectRuns++)), memo.share('s1', ob4, () => slowPass().finally(() => expectRuns++))]);
  assert.equal(expectRuns, 2);
});

test('memo.limit: at most `jobs` at once', async () => {
  const memo = createRunMemo({ jobs: 2 });
  let now = 0;
  let peak = 0;
  await Promise.all(Array.from({ length: 6 }, () => memo.limit(async () => {
    peak = Math.max(peak, ++now);
    await new Promise((r) => setTimeout(r, 10));
    now--;
  })));
  assert.equal(peak, 2);
});
