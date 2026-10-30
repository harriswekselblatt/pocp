// Path redaction for anything eval/ writes to results/ (eval/README.md rule 9).
// Absolute paths name the machine's user and folder layout. Results keep the shape of a path,
// not the person: this checkout becomes <pocp>, temp folders become $TMPDIR, home becomes ~.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { POCP_ROOT } from './pins.js';

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function variants(p) {
  const out = new Set([p]);
  try { out.add(fs.realpathSync(p)); } catch { /* missing */ }
  if (p.startsWith('/private/')) out.add(p.slice('/private'.length));
  else if (p.startsWith('/var/') || p.startsWith('/tmp/')) out.add(`/private${p}`);
  return [...out].filter((x) => x && x !== '/').sort((a, b) => b.length - a.length);
}

/** Replacement rules, longest and most specific first. */
export function rules({ root = POCP_ROOT, home = os.homedir(), tmp = os.tmpdir() } = {}) {
  const r = [];
  for (const v of variants(root)) r.push([new RegExp(esc(v), 'g'), '<pocp>']);
  for (const v of variants(tmp)) r.push([new RegExp(esc(v), 'g'), '$TMPDIR']);
  // Agent scratch folders: /tmp/claude-<uid>/<project slug with the user name>/<session id>.
  r.push([/(?:\/private)?\/tmp\/claude-\d+\/[^/"'\s]+\/[0-9a-f-]{36}/g, '$SCRATCH']);
  // macOS per-user temp folders (with or without the T/C leaf), on any machine.
  r.push([/(?:\/private)?\/var\/folders\/[A-Za-z0-9_+-]+\/[A-Za-z0-9_+-]+\/[TC]/g, '$TMPDIR']);
  r.push([/(?:\/private)?\/var\/folders\/[A-Za-z0-9_+-]+\/[A-Za-z0-9_+-]+/g, '$TMPDIR']);
  for (const v of variants(home)) r.push([new RegExp(esc(v), 'g'), '~']);
  // Any other user's home folder (macOS, Linux).
  r.push([/\/Users\/[A-Za-z0-9._-]+/g, '~']);
  r.push([/\/home\/[A-Za-z0-9._-]+/g, '~']);
  // A home path flattened into a folder name (e.g. "-Users-<name>-Desktop-…").
  r.push([/-Users-[A-Za-z0-9._]+(?=-)/g, '-~']);
  return r;
}

// Agent session ids identify the account they ran on. Keep a short hash (enough to match a
// run to its local log), not the id.
const SESSION_ID = /"(thread_id|session_id)":"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"/g;
const idHash = (id) => crypto.createHash('sha256').update(id).digest('hex').slice(0, 16);

export function redactText(text, opts) {
  let s = String(text);
  for (const [re, to] of rules(opts)) s = s.replace(re, to);
  s = s.replace(SESSION_ID, (_, key, id) => `"${key.replace('_id', '_sha')}":"${idHash(id)}"`);
  return s;
}

/** Deep-redact every string in a JSON-able value. */
export function redactValue(v, opts) {
  return JSON.parse(redactText(JSON.stringify(v), opts));
}

/** Personal paths still present in text (for tests and the publish check). */
export function personalPaths(text) {
  const found = new Set();
  for (const re of [/\/Users\/[A-Za-z0-9._-]+/g, /\/home\/[A-Za-z0-9._-]+/g, /\/var\/folders\/[A-Za-z0-9_+-]+\/[A-Za-z0-9_+-]/g, /-Users-[A-Za-z0-9._]+-/g]) {
    for (const m of String(text).matchAll(re)) found.add(m[0]);
  }
  return [...found];
}

export const _test = { variants, esc, path };
