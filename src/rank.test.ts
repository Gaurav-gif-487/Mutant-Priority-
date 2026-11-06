import { test } from "node:test";
import assert from "node:assert/strict";
import { rank } from "./rank.js";
import type { FileMetrics } from "./graph.js";

const files: FileMetrics[] = [
  { file: "a.ts", fanIn: 3, fanOut: 5, distFromEntry: 1 },
  { file: "b.ts", fanIn: 1, fanOut: 0, distFromEntry: 3 },
  { file: "c.ts", fanIn: 0, fanOut: 2, distFromEntry: 2 },
  { file: "d.ts", fanIn: 2, fanOut: 0, distFromEntry: null },
];

test("rank fanOut: ascending — lowest fan-out first", () => {
  const ranked = rank(files, "fanOut");
  // b and d are tied at fanOut=0; both must precede c (2) and a (5).
  const order = ranked.map((r) => r.file);
  assert.ok(order.indexOf("b.ts") < order.indexOf("c.ts"));
  assert.ok(order.indexOf("d.ts") < order.indexOf("c.ts"));
  assert.equal(order[order.length - 1], "a.ts"); // highest fanOut ranks last
  assert.equal(ranked[0].rank, 1);
});

test("rank fanIn: ascending — lowest fan-in first", () => {
  const ranked = rank(files, "fanIn");
  assert.equal(ranked[0].file, "c.ts"); // fanIn=0
  assert.equal(ranked[ranked.length - 1].file, "a.ts"); // fanIn=3, highest
});

test("rank distFromEntry: deepest first, unreached (null) treated as depth -1 (last)", () => {
  const ranked = rank(files, "distFromEntry");
  assert.equal(ranked[0].file, "b.ts"); // distFromEntry=3, deepest -> first
  assert.equal(ranked[ranked.length - 1].file, "d.ts"); // null -> sorts last
});

test("rank random: deterministic for a fixed seed", () => {
  const a = rank(files, "random", 7).map((r) => r.file);
  const b = rank(files, "random", 7).map((r) => r.file);
  assert.deepEqual(a, b);
});

test("rank random: different seeds usually produce different orders", () => {
  const many: FileMetrics[] = Array.from({ length: 20 }, (_, i) => ({
    file: `f${i}.ts`,
    fanIn: 0,
    fanOut: 0,
    distFromEntry: null,
  }));
  const a = rank(many, "random", 1).map((r) => r.file);
  const b = rank(many, "random", 2).map((r) => r.file);
  assert.notDeepEqual(a, b);
});

test("rank: assigns contiguous 1-indexed ranks", () => {
  const ranked = rank(files, "fanOut");
  assert.deepEqual(
    ranked.map((r) => r.rank),
    [1, 2, 3, 4]
  );
});
