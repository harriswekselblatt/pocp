// Where the raw run records live, and how to check a local copy of them.
//
// The records are kept in their own repository (RESULTS_REPO), pinned here to one commit, so
// this repository stays small. eval/results.sha256 lists the SHA-256 of every file the reports
// were generated from. A local copy in eval/results/ (fetched with eval/tools/fetch-results.js)
// counts only when it matches that list exactly: no file changed, missing or added.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const RESULTS_REPO = 'https://github.com/harriswekselblatt/pocp-eval';
export const RESULTS_COMMIT = '10ddbca554612979a5f7a482546313a7b8efd81a';

/** The checksum list: [{ sha256, file }], `file` relative to eval/ ("results/E1a/x.jsonl"). */
export function readManifest(text) {
  return text.split('\n').filter(Boolean).map((line, i) => {
    const m = /^([0-9a-f]{64}) {2}(results\/[^\0]+)$/.exec(line);
    if (!m) throw new Error(`results.sha256 line ${i + 1} is not "<sha256>  results/<path>"`);
    return { sha256: m[1], file: m[2] };
  });
}

function filesUnder(dir, base = dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? filesUnder(p, base) : [path.relative(base, p).split(path.sep).join('/')];
  });
}

/**
 * Compare a copy of the records (the folder holding `results/`) with the checksum list.
 * Returns { ok, changed, missing, extra }, each a list of paths relative to that folder.
 */
export function checkResults(root, manifest) {
  const want = new Map(manifest.map((e) => [e.file, e.sha256]));
  const have = fs.existsSync(path.join(root, 'results')) ? filesUnder(path.join(root, 'results'), root) : [];
  const changed = [];
  const missing = [];
  for (const [file, sha] of want) {
    const p = path.join(root, file);
    if (!fs.existsSync(p)) missing.push(file);
    else if (crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex') !== sha) changed.push(file);
  }
  const extra = have.filter((f) => !want.has(f)).sort();
  return { ok: !changed.length && !missing.length && !extra.length, changed, missing, extra };
}
