// The friction benchmark's summary: what RESULTS.md reports from a results file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarize } from '../bench/friction/lib/report.js';

const hooks = (gate, trailer, land) => [{ cmd: 'gate', ms: gate, exit: 0 }, ...(trailer ? [{ cmd: 'trailer', ms: trailer, exit: 0 }, { cmd: 'land', ms: land, exit: 0 }] : [])];

test('summarize counts blocked, stuck and person-needed commits, and hook times', () => {
  const s = summarize({
    commits: [
      { commit: 'a', subject: 'free', full: true, outcome: 'free', first_attempt: { hooks: hooks(100, 80, 40) }, repeat_prove: { ms: 200, ran: 0 }, ci: { ok: true, verify_ms: 300, findings: [] } },
      { commit: 'b', subject: 'blocked', full: true, outcome: 'ceremony', gate: { explained: true }, first_attempt: { hooks: hooks(120) }, steps: [{ cmd: 'fix', ms: 5000 }, { cmd: 'git commit', ms: 400, hooks: hooks(110, 90, 50) }], ceremony_commands: 1, repeat_prove: { ms: 250, ran: 0 }, ci: { ok: false, verify_ms: 900, findings: ['test_change'] }, needs_person: true },
      { commit: 'c', subject: 'stuck', full: true, outcome: 'stuck', first_attempt: { hooks: hooks(130) }, steps: [{ cmd: 'open', ms: 100 }, { cmd: 'prove', ms: 7000 }, { cmd: 'git commit', ms: 300, hooks: hooks(140) }], ceremony_commands: 2 },
      { commit: 'd', subject: 'tier one', full: false, outcome: 'ceremony', first_attempt: { hooks: hooks(150) } },
      { commit: 'e', subject: 'broken', outcome: 'error', error: 'x' },
    ],
  });
  assert.equal(s.commits, 4);
  assert.equal(s.errors, 1);
  assert.equal(s.free, 1);
  assert.equal(s.ceremony, 3);
  assert.equal(s.stuck, 1);
  assert.equal(s.full, 3);
  assert.equal(s.explained, 1);
  assert.equal(s.needs_person, 1);
  assert.equal(s.ci_failed, 1);
  assert.equal(s.commands_per_blocked, 1.5);
  assert.equal(s.hooks.gate.max, 150);
  assert.equal(s.hooks.trailer.max, 90);
  assert.equal(s.prove.max, 7100 - 100);
  assert.equal(s.repeat_prove.ran, 0);
  assert.equal(s.verify.max, 900);
});
