// Interval statistics for eval reports (EVAL-PLAN principle 7).
// Wilson score intervals for simple proportions, and a cluster bootstrap for rates whose
// observations share a task or repo. Seeded, so a report reproduces exactly.

const Z95 = 1.959963984540054; // two-sided 95%
const Z95_ONE = 1.6448536269514722; // one-sided 95%

/** Wilson score interval for k successes out of n. */
export function wilson(k, n, z = Z95) {
  if (!Number.isInteger(k) || !Number.isInteger(n) || k < 0 || n < 0 || k > n) throw new Error(`bad counts ${k}/${n}`);
  if (n === 0) return { k, n, p: null, lo: null, hi: null };
  const p = k / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  // At 0 or n the bound is exactly 0 or 1; floating point would leave a tiny residue.
  return { k, n, p, lo: k === 0 ? 0 : Math.max(0, centre - half), hi: k === n ? 1 : Math.min(1, centre + half) };
}

/** One-sided 95% bounds: the bar test in PREREG §5 ("lower bound clears the bar"). */
export function wilsonOneSided(k, n) {
  const w = wilson(k, n, Z95_ONE);
  return { k, n, p: w.p, lower: w.lo, upper: w.hi };
}

/** Deterministic PRNG (mulberry32). */
export function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Cluster bootstrap percentile interval for a pooled rate.
 * `clusters` is [{ k, n }] per cluster (a task, a repo). Resamples clusters with replacement.
 */
export function clusterBootstrap(clusters, { reps = 4000, seed = 1, level = 0.95 } = {}) {
  const usable = clusters.filter((c) => c.n > 0);
  const K = usable.reduce((s, c) => s + c.k, 0);
  const N = usable.reduce((s, c) => s + c.n, 0);
  if (!N) return { k: 0, n: 0, clusters: 0, p: null, lo: null, hi: null };
  const rand = prng(seed);
  const stats = [];
  for (let r = 0; r < reps; r++) {
    let k = 0;
    let n = 0;
    for (let i = 0; i < usable.length; i++) {
      const c = usable[Math.floor(rand() * usable.length)];
      k += c.k;
      n += c.n;
    }
    stats.push(k / n);
  }
  stats.sort((a, b) => a - b);
  const q = (x) => stats[Math.min(stats.length - 1, Math.max(0, Math.floor(x * stats.length)))];
  const tail = (1 - level) / 2;
  return { k: K, n: N, clusters: usable.length, p: K / N, lo: q(tail), hi: q(1 - tail), reps, seed };
}

/** Format a rate for a report: "7/10 (70%, 95% CI 40–89%)". */
export function fmtRate({ k, n, p, lo, hi }) {
  if (!n) return `${k}/${n} (n/a)`;
  const pct = (x) => `${Math.round(x * 100)}%`;
  return `${k}/${n} (${pct(p)}, 95% CI ${pct(lo)}–${pct(hi)})`;
}
