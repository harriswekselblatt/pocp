// A packet that parses but isn't the shape POCP relies on is reported where it is read: verify
// gives a blocking finding, and local commands a clear error. Never a crash, never a pass.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { git, pocp, sampleRepo, sh, write } from './helpers.js';
import { TWEAK_ADD } from './fixtures.js';
import { packetProblem } from '../src/records.js';

const CI = ['--rerun', '--require-coverage', '--exit-detail', '--json'];

const VALID = { pocp: 1, id: 'p-1', state: 'open', touches: ['src/a.js'], obligations: [{ id: 'o1', kind: 'test', run: 'true' }], policy: null, proofs: [], attestations: [], history: [] };

// Each mangles a real packet into a shape the code can't use.
const MALFORMED = {
  'no obligations': (p) => ({ ...p, obligations: undefined }),
  'obligations not a list': (p) => ({ ...p, obligations: 'o1' }),
  'an obligation without an id': (p) => ({ ...p, obligations: p.obligations.map(({ id, ...o }) => o) }),
  'no touches': (p) => ({ ...p, touches: undefined }),
  'no proofs': (p) => ({ ...p, proofs: undefined }),
  'a list, not an object': () => [],
  'an id that differs from its file name': (p) => ({ ...p, id: 'p-00000000' }),
};

test('packet shape: what is required, and a usable packet passes', () => {
  assert.equal(packetProblem(VALID), null);
  assert.equal(packetProblem(VALID, { id: 'p-1' }), null);
  assert.equal(packetProblem({ ...VALID, deferrals: [], policy: 'sha256:abc' }), null);
  for (const [name, mangle] of Object.entries(MALFORMED)) assert.ok(packetProblem(mangle(VALID), { id: 'p-1' }), name);
  assert.match(packetProblem({ ...VALID, obligations: [{ id: 'o1' }] }), /obligations\[0\]/);
  assert.match(packetProblem({ ...VALID, id: 'p-2' }, { id: 'p-1' }), /file name/);
  assert.match(packetProblem({ ...VALID, deferrals: {} }), /deferrals/);
  assert.match(packetProblem({ ...VALID, policy: 3 }), /policy/);
});

/** A proven commit whose committed packet is then rewritten by `mangle`. */
function committedPacket(mangle) {
  const dir = sampleRepo({ hooks: true, deep: false });
  const base = git(dir, 'rev-parse', 'HEAD');
  write(dir, 'src/math.js', TWEAK_ADD);
  git(dir, 'add', '-A');
  assert.equal(pocp(dir, ['fix', '--intent', 'swap the operands']).code, 0);
  sh(dir, 'git', ['commit', '-q', '-m', 'swap the operands']);
  const rel = git(dir, 'ls-files', '.proof/packets').split('\n').find((f) => f.endsWith('.json'));
  write(dir, rel, JSON.stringify(mangle(JSON.parse(fs.readFileSync(path.join(dir, rel), 'utf8')))));
  return { dir, base, rel, id: path.basename(rel, '.json') };
}

for (const [name, mangle] of Object.entries(MALFORMED)) {
  test(`verify: a committed packet with ${name} is a blocking finding, not a crash`, () => {
    const { dir, base, rel } = committedPacket(mangle);
    git(dir, 'add', '-A');
    git(dir, '-c', 'core.hooksPath=/dev/null', 'commit', '-q', '--amend', '--no-edit');
    const v = pocp(dir, ['verify', `${base}..HEAD`, ...CI]);
    assert.equal(v.code, 1, v.stdout + v.stderr);
    const f = v.json.commits[0].findings.find((x) => x.code === 'missing_packet');
    assert.ok(f?.blocking, JSON.stringify(v.json.commits[0].findings));
    assert.match(f.detail, new RegExp(`${rel.replace(/\./g, '\\.')} is malformed: `));
  });
}

test('local commands report a malformed packet clearly (exit 2), never crash', () => {
  const { dir, rel, id } = committedPacket(MALFORMED['no obligations']);
  for (const args of [['status', '--json'], ['show', id, '--json']]) {
    const r = pocp(dir, args);
    assert.equal(r.code, 2, `${args[0]}: ${r.stdout}${r.stderr}`);
    assert.match(r.json.error, new RegExp(`${rel.replace(/\./g, '\\.')}: malformed packet: "obligations" must be a list`), args[0]);
  }
});

test('control: a well-formed committed packet still verifies', () => {
  const { dir, base } = committedPacket((p) => p);
  git(dir, 'add', '-A');
  git(dir, '-c', 'core.hooksPath=/dev/null', 'commit', '-q', '--amend', '--no-edit');
  const v = pocp(dir, ['verify', `${base}..HEAD`, ...CI]);
  assert.equal(v.code, 0, v.stdout + v.stderr);
});
