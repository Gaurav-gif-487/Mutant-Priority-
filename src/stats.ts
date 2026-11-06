/**
 * Wilson score interval for a binomial proportion. Used instead of the
 * naive normal-approximation interval because it stays well-behaved at
 * the small sample sizes `validate` actually produces (a handful of
 * mutants per strategy) — the normal approximation can produce nonsense
 * bounds (e.g. negative lower bounds, or bounds outside [0,1]) exactly
 * in that regime.
 *
 * z=1.96 corresponds to a 95% interval.
 */
export interface Interval {
  low: number;
  high: number;
}

export function wilsonInterval(killed: number, n: number, z = 1.96): Interval {
  if (n === 0) return { low: 0, high: 1 };
  const p = killed / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = p + z2 / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  const low = (center - margin) / denom;
  const high = (center + margin) / denom;
  return { low: clamp01(low), high: clamp01(high) };
}

/** True if two intervals do not overlap at all — the strongest, most conservative
 * signal that two proportions actually differ given the sample. */
export function intervalsDisjoint(a: Interval, b: Interval): boolean {
  return a.high < b.low || b.high < a.low;
}

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}
