import type { FileMetrics } from "./graph.js";

export type Strategy = "fanOut" | "distFromEntry" | "fanIn" | "random";

export interface RankedFile extends FileMetrics {
  rank: number;
  score: number;
}

/**
 * Rank files by a strategy.
 *
 * Default ("fanOut") is the ONLY structural signal that showed a
 * significant relationship to mutant survival in the source study
 * (ajv, p=0.006 — higher fan-out -> higher kill rate, i.e. files with
 * more outgoing dependencies tend to already be better-exercised, so
 * BUDGET-CONSTRAINED mutation runs get more signal per mutant by
 * mutating LOW fan-out files first: they're the ones most likely to
 * be under-tested).
 *
 * "distFromEntry" is included for completeness and for the `validate`
 * command's own use as a comparison baseline — the study found it did
 * NOT predict mutant survival in any of 4 repos (all p > 0.19). Do not
 * treat it as a good default; it's here so you can prove that to
 * yourself on your own repo instead of taking the study's word for it.
 */
export function rank(files: FileMetrics[], strategy: Strategy, seed = 42): RankedFile[] {
  let scored: Array<{ f: FileMetrics; score: number }>;

  switch (strategy) {
    case "fanOut":
      // Lower fan-out first: the study's signal was that LOW fan-out
      // correlates with lower kill rate (under-tested). We want to
      // spend a mutation budget where it's most likely to find gaps.
      // score = fanOut directly, ascending sort -> lowest fanOut ranks first.
      scored = files.map((f) => ({ f, score: f.fanOut }));
      break;
    case "fanIn":
      // No finding in the source study backs a direction for fan-in;
      // kept as a low-fanIn-first baseline for symmetry with fanOut,
      // not because it's been shown to matter.
      scored = files.map((f) => ({ f, score: f.fanIn }));
      break;
    case "distFromEntry":
      // Deepest-first, matching the original (unsupported) hypothesis.
      // score = -distFromEntry, ascending sort -> largest depth ranks first.
      scored = files.map((f) => ({ f, score: -(f.distFromEntry ?? -1) }));
      break;
    case "random": {
      const rng = mulberry32(seed);
      scored = files.map((f) => ({ f, score: rng() }));
      break;
    }
  }

  scored.sort((a, b) => a.score - b.score);
  return scored.map((s, i) => ({ ...s.f, rank: i + 1, score: s.score }));
}

function mulberry32(seed: number) {
  let a = seed;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
