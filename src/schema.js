// The keys .proof/rules.json and .proof/config.json may contain, at every level. POCP ignores a
// key it doesn't know, so a misspelling ("fail_one" for "fail_on") silently turns a setting
// off. unknownKeys finds those keys and suggests the one that was probably meant.
//
// A key that starts with "$" is a comment and is never reported ("$why": "...").
// These are warnings: an unknown key changes nothing that passes or blocks.

const LEAF = true;
const listOf = (item) => ({ list: item });

const OBLIGATION = {
  id: LEAF, kind: LEAF, run: LEAF, text: LEAF, expect: LEAF, inputs: LEAF, timeout_ms: LEAF, cwd: LEAF,
  target: LEAF, changed_test_command: LEAF, source: LEAF,
  // the test guard's own obligations
  files: LEAF, mutants: LEAF, seed: LEAF, additions: LEAF,
};

export const RULES_SCHEMA = Object.freeze({
  pocp: LEAF,
  triggers: {
    broad_files: LEAF,
    cross_area: { areas: LEAF, min_files: LEAF },
    globs: listOf({ id: LEAF, glob: LEAF, require_packet: LEAF }),
  },
  count_exempt: LEAF,
  requirements: listOf({ id: LEAF, glob: LEAF, globs: LEAF, obligation: OBLIGATION, source: LEAF }),
});

export const CONFIG_SCHEMA = Object.freeze({
  pocp: LEAF,
  packet_ttl_days: LEAF,
  area_depth: LEAF,
  proofs_kept_per_obligation: LEAF,
  run: { mode: LEAF, timeout_ms: LEAF, kill_grace_ms: LEAF, env: LEAF, env_allow: LEAF, log_cap_bytes: LEAF, lockfile: LEAF },
  snapshot: { link: LEAF },
  sign: { key: LEAF, principal: LEAF },
  guard: { tests: LEAF, test_globs: LEAF, runner_globs: LEAF, extra_test_globs: LEAF, extra_runner_globs: LEAF, mutants: LEAF, seed: LEAF, additions: LEAF },
  verify: { fail_on: LEAF, require_ci: LEAF },
  ci: { files: LEAF, branch: LEAF, required_checks: LEAF, require_pull_request: LEAF, enforce_admins: LEAF, require_up_to_date: LEAF, workflow_approver: LEAF },
  eval: { exclude: LEAF },
});

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Edit distance between two short strings: insertions, deletions, substitutions, and swaps of neighbouring letters. */
function distance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}

/** The known key closest to `key`, when it is close enough to be a likely typo. */
function closest(key, known) {
  let best = null;
  let bestDistance = Infinity;
  for (const k of known) {
    const d = distance(key.toLowerCase(), k);
    if (d < bestDistance) [best, bestDistance] = [k, d];
  }
  return bestDistance <= Math.max(1, Math.floor(best?.length / 3)) ? best : null;
}

/**
 * Keys in `value` that `schema` doesn't know, as [{ path, suggestion }]: `path` is where the
 * key is ("verify.fail_one", "requirements[2].obligation.timout_ms"), `suggestion` the known
 * key at that level it most likely meant ("fail_on"), or null. Values the schema doesn't
 * describe further, and values of the wrong type, are not looked into (validation reports
 * wrong types).
 */
export function unknownKeys(value, schema, path = '') {
  if (schema === LEAF) return [];
  if (schema.list) {
    if (!Array.isArray(value)) return [];
    return value.flatMap((item, i) => unknownKeys(item, schema.list, `${path}[${i}]`));
  }
  if (!isPlainObject(value)) return [];
  const out = [];
  for (const [key, v] of Object.entries(value)) {
    const at = path ? `${path}.${key}` : key;
    if (key.startsWith('$')) continue;
    if (Object.hasOwn(schema, key)) out.push(...unknownKeys(v, schema[key], at));
    else out.push({ path: at, suggestion: closest(key, Object.keys(schema)) });
  }
  return out;
}

/** Readable warnings for the unknown keys in a policy file's parsed JSON. */
export function unknownKeyWarnings(file, value, schema) {
  return unknownKeys(value, schema).map(({ path, suggestion }) => `${file}: unknown key "${path}" is ignored${suggestion ? ` (did you mean "${suggestion}"?)` : ''}; start a key with "$" to keep it as a comment`);
}

/** Warnings for both policy files, from their parsed JSON (null or undefined when absent). */
export function policyKeyWarnings({ rules, config }) {
  return [
    ...unknownKeyWarnings('.proof/rules.json', rules, RULES_SCHEMA),
    ...unknownKeyWarnings('.proof/config.json', config, CONFIG_SCHEMA),
  ];
}
