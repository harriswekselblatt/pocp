import crypto from 'node:crypto';

/** JSON with object keys sorted at every level and no whitespace. */
export function canonicalJson(value) {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      if (value[key] !== undefined) out[key] = sortKeys(value[key]);
    }
    return out;
  }
  return value;
}

export function sha256Hex(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

export function digest(data) {
  return `sha256:${sha256Hex(data)}`;
}

export function digestJson(value) {
  return digest(canonicalJson(value));
}

/** Short form used in trailers and human output: "sha256:" + 12 hex chars. */
export function shortDigest(d) {
  if (!d) return d;
  const [algo, hex] = String(d).split(':');
  return hex ? `${algo}:${hex.slice(0, 12)}` : d;
}

/** True when a full digest and a (possibly short) digest refer to the same value. */
export function digestMatches(full, maybeShort) {
  if (!full || !maybeShort) return false;
  const [a1, h1] = String(full).split(':');
  const [a2, h2] = String(maybeShort).split(':');
  if (a1 !== a2 || !h1 || !h2 || h2.length < 12) return false;
  return h1.startsWith(h2);
}

export function randomId(prefix) {
  return `${prefix}-${crypto.randomBytes(4).toString('hex')}`;
}
