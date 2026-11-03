// Bench fixture: a guarded function whose test checks it through an assertion helper.
export function clamp(x, lo, hi) {
  return Math.min(hi, Math.max(lo, x));
}
