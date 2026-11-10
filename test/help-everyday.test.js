// `pocp help`: six everyday commands for a person at a terminal, every command otherwise.
// CI workflows read the full help to learn which verify options a verifier supports, so the
// full list must stay what a non-terminal `pocp help` prints.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pocp } from './helpers.js';
import { EVERYDAY_HELP, helpFor } from '../src/cli.js';
import { COMMANDS } from '../src/cli-args.js';

const EVERYDAY = ['init', 'doctor', 'fix', 'status', 'verify', 'approve'];
const outside = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pocp-help-')));

test('in a terminal, pocp help shows the six everyday commands and how to see the rest', () => {
  const text = helpFor({ tty: true });
  assert.equal(text, EVERYDAY_HELP);
  const listed = [...text.matchAll(/^ {2}([a-z-]+) {2,}/gm)].map((m) => m[1]);
  assert.deepEqual(listed, EVERYDAY);
  for (const c of EVERYDAY) assert.ok(COMMANDS[c], `${c} is a real command`);
  assert.match(text, /pocp help advanced/);
  assert.doesNotMatch(text, /--accept-uncovered/);
});

test('not in a terminal, and with "help advanced" or --all, pocp help is the full list with every verify option', () => {
  const dir = outside();
  for (const args of [['help'], ['help', 'advanced'], ['help', '--all']]) {
    const r = pocp(dir, args);
    assert.equal(r.code, 0, args.join(' '));
    // What the shipped workflows grep for.
    for (const f of ['--accept-uncovered', '--accept-inconclusive', '--exit-detail', '--isolate']) assert.ok(r.stdout.includes(f), `${args.join(' ')}: ${f}`);
    assert.match(r.stdout, /Packets\n/);
  }
  assert.equal(helpFor({ tty: true, advanced: true }), helpFor({ tty: false }));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('approve is approvals by its everyday name: a PR to approve still needs a person at a terminal', () => {
  const dir = outside();
  const r = pocp(dir, ['approve', 'me/site#1']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /must be run by a person at a terminal/);
  assert.match(pocp(dir, ['help', 'approve']).stdout, /alias: approvals/);
  fs.rmSync(dir, { recursive: true, force: true });
});
