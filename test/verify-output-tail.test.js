// When a re-run check fails, verify prints the end of what it printed. verify reports only
// hashes of a check's output as proof, so before this a check that failed in CI (where nobody
// can open the run log) said only "failed (exit 1)". The tail goes in verify's report, never in
// a proof record, and it is made inert: a check's output can't start a line a CI runner would
// read as a command, or put terminal escapes in the log.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { git, packetId, pocp, sampleRepo, write } from './helpers.js';
import { TWEAK_ADD, commit } from './fixtures.js';
import { failedOutputLines, outputTail, TAIL_BYTES, TAIL_LINES } from '../src/output-tail.js';

// The check prints 100 numbered lines, then (only when SAMPLE_FAIL is set) a line shaped like
// a GitHub workflow command, a colored line, and fails.
const CHECK = [
  "import { add, isPositive } from '../src/math.js';",
  "for (let i = 1; i <= 100; i++) console.log(`line ${i}`);",
  "if (add(2, 3) !== 5 || isPositive(1) !== true) process.exit(1);",
  "if (process.env.SAMPLE_FAIL) {",
  "  console.log('::error title=x::injected');",
  "  console.error('\\x1b[31mcolored\\x1b[0m\\x07');",
  "  console.error('FAILED here');",
  "  process.exit(1);",
  "}",
  '',
].join('\n');

function failingCommit() {
  const dir = sampleRepo({ hooks: true, deep: false });
  write(dir, 'test/math.check.mjs', CHECK);
  git(dir, 'add', '-A');
  git(dir, '-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', 'noisy check');
  write(dir, 'src/math.js', TWEAK_ADD);
  git(dir, 'add', 'src/math.js');
  const id = packetId(pocp(dir, ['open', '--intent', 'x', '--touch', 'src/math.js']).stdout);
  const proved = pocp(dir, ['prove', id]);
  assert.equal(proved.code, 0, proved.stdout + proved.stderr);
  commit(dir, 'swap add');
  return dir;
}

const filesUnder = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? filesUnder(path.join(d, e.name)) : [path.join(d, e.name)]));

test('verify prints the end of a failed check\'s output, inert, and keeps it out of proof records', () => {
  const dir = failingCommit();
  const v = pocp(dir, ['verify', 'HEAD', '--rerun'], { env: { SAMPLE_FAIL: '1' } });
  assert.equal(v.code, 1, v.stdout + v.stderr);
  assert.match(v.stdout, /rerun failed +node test\/math\.check\.mjs/);
  assert.match(v.stdout, /output of failed check "node test\/math\.check\.mjs" \(exit 1, p-[0-9a-f]+\)/);
  // The last 60 lines: line 44 to 100 and the three it printed on failure.
  assert.match(v.stdout, /^ {4}\| line 44$/m);
  assert.doesNotMatch(v.stdout, /\| line 43$/m);
  assert.match(v.stdout, /^ {4}\| FAILED here$/m);
  assert.match(v.stdout, /^ {4}\| colored$/m);
  // Inert: the workflow-command-shaped line is prefixed, and no escape or bell reaches the log.
  assert.match(v.stdout, /^ {4}\| ::error title=x::injected$/m);
  assert.doesNotMatch(v.stdout, /^\s*::/m);
  assert.doesNotMatch(v.stdout, /[\x1b\x07]/);

  // --json carries it on the failed re-run only.
  const j = pocp(dir, ['verify', 'HEAD', '--rerun', '--json'], { env: { SAMPLE_FAIL: '1' } });
  const failed = j.json.reruns.find((x) => x.status === 'failed');
  assert.ok(failed.output_tail.endsWith('FAILED here'), failed.output_tail);
  assert.equal(failed.output_tail.split('\n').length, TAIL_LINES);

  // Never in a proof record: the packets, proofs and status files hold none of it.
  const records = filesUnder(path.join(dir, '.proof')).filter((f) => !f.includes(`${path.sep}runs${path.sep}`));
  for (const f of records) assert.doesNotMatch(fs.readFileSync(f, 'utf8'), /FAILED here|line 44/, f);

  // A check that passes prints nothing extra.
  const ok = pocp(dir, ['verify', 'HEAD', '--rerun', '--json']);
  assert.equal(ok.code, 0, ok.stdout + ok.stderr);
  assert.ok(ok.json.reruns.every((x) => !('output_tail' in x)));
  assert.doesNotMatch(pocp(dir, ['verify', 'HEAD', '--rerun']).stdout, /output of failed check/);
});

test('outputTail: last lines, capped in bytes, cleaned', () => {
  assert.equal(outputTail(''), '');
  assert.equal(outputTail('\n  \n'), '');
  assert.equal(outputTail('a\r\nb\rc\n\n'), 'a\nb\nc');
  assert.equal(outputTail('one\ntwo\nthree', { maxLines: 2 }), 'two\nthree');
  // Byte cap: whole lines from the end.
  const long = Array.from({ length: 50 }, (_, i) => `${i}`.padStart(400, 'x')).join('\n');
  const t = outputTail(long);
  assert.ok(Buffer.byteLength(t) <= TAIL_BYTES, `${Buffer.byteLength(t)}`);
  assert.ok(t.endsWith('49'));
  // One line longer than the cap: its end, starting on a whole character.
  const wide = outputTail(`${'é'.repeat(10_000)}END`, { maxBytes: 101 });
  assert.ok(wide.startsWith('…é') && wide.endsWith('END'), wide);
  assert.doesNotMatch(wide, /�/);
  // Escapes and control characters go; tabs stay.
  assert.equal(outputTail('\x1b[1;31mred\x1b[0m\tx\x00\x08\x1b]0;title\x07!'), 'red\tx!');
});

test('failedOutputLines: prefixed lines, failed re-runs only, at most a few checks', () => {
  const r = (run, status, extra = {}) => ({ run, status, exit: 1, packets: ['p-1'], ...extra });
  assert.deepEqual(failedOutputLines([r('a', 'passed'), r('b', 'failed')]), []);
  const lines = failedOutputLines([r('a', 'failed', { output_tail: '::warning::x\nok' }), r('b', 'failed', { output_tail: 'y', timed_out: true, exit: null })]);
  assert.ok(lines.every((l) => !l.trimStart().startsWith('::')));
  assert.ok(lines.includes('    | ::warning::x'));
  assert.ok(lines.some((l) => /"b" \(timed out, p-1\)/.test(l)));
  const many = failedOutputLines(Array.from({ length: 6 }, (_, i) => r(`c${i}`, 'failed', { output_tail: 'z' })));
  assert.equal(many.filter((l) => l.includes('output of failed check')).length, 4);
  assert.match(many.at(-1), /2 more failed check/);
});
