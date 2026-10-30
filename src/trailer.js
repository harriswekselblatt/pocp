import { shortDigest } from './hash.js';

export const TRAILER_KEY = 'Proof-Of-Change';

export function formatTrailer({ id, subject, policy, proven, runnable, attested, manual }) {
  return `${id} subject=${shortDigest(subject)} policy=${shortDigest(policy)} proven=${proven}/${runnable} attested=${attested}/${manual}`;
}

export function parseTrailerValue(value) {
  const parts = String(value).trim().split(/\s+/);
  const out = { id: parts[0] };
  for (const part of parts.slice(1)) {
    const eq = part.indexOf('=');
    if (eq > 0) out[part.slice(0, eq)] = part.slice(eq + 1);
  }
  for (const k of ['proven', 'attested']) {
    if (out[k] && /^\d+\/\d+$/.test(out[k])) {
      const [a, b] = out[k].split('/').map(Number);
      out[k] = { done: a, total: b };
    }
  }
  return out;
}

/** Proof-Of-Change trailers from the final paragraph of a commit message. */
export function parseTrailers(message) {
  const paragraphs = String(message || '').replace(/\s+$/, '').split(/\n\s*\n/);
  const last = paragraphs[paragraphs.length - 1] || '';
  const out = [];
  for (const line of last.split('\n')) {
    const m = /^Proof-Of-Change:\s*(.+)$/i.exec(line.trim());
    if (m) out.push(parseTrailerValue(m[1]));
  }
  return out;
}
