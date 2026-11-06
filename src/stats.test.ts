import { test } from "node:test";
import assert from "node:assert/strict";
import { wilsonInterval, intervalsDisjoint } from "./stats.js";

test("wilsonInterval: n=0 returns the widest possible interval", () => {
  const ci = wilsonInterval(0, 0);
  assert.equal(ci.low, 0);
  assert.equal(ci.high, 1);
});

test("wilsonInterval: bounds always stay within [0,1]", () => {
  for (const [k, n] of [
    [0, 5],
    [5, 5],
    [1, 1000],
    [999, 1000],
  ]) {
    const ci = wilsonInterval(k, n);
    assert.ok(ci.low >= 0 && ci.low <= 1, `low=${ci.low} out of range for ${k}/${n}`);
    assert.ok(ci.high >= 0 && ci.high <= 1, `high=${ci.high} out of range for ${k}/${n}`);
    assert.ok(ci.low <= ci.high);
  }
});

test("wilsonInterval: known reference value for 2/4 at 95%", () => {
  // Standard reference: Wilson 95% CI for 2/4 is approximately [0.150, 0.850].
  const ci = wilsonInterval(2, 4);
  assert.ok(Math.abs(ci.low - 0.15) < 0.01, `low=${ci.low}`);
  assert.ok(Math.abs(ci.high - 0.85) < 0.01, `high=${ci.high}`);
});

test("wilsonInterval: interval narrows as n grows at fixed proportion", () => {
  const small = wilsonInterval(5, 10);
  const large = wilsonInterval(500, 1000);
  assert.ok(large.high - large.low < small.high - small.low);
});

test("intervalsDisjoint: true when intervals do not overlap", () => {
  assert.equal(intervalsDisjoint({ low: 0, high: 0.2 }, { low: 0.3, high: 0.5 }), true);
});

test("intervalsDisjoint: false when intervals overlap", () => {
  assert.equal(intervalsDisjoint({ low: 0.15, high: 0.85 }, { low: 0.15, high: 0.85 }), false);
  assert.equal(intervalsDisjoint({ low: 0, high: 0.5 }, { low: 0.4, high: 0.9 }), false);
});

test("intervalsDisjoint: false when intervals touch exactly at a boundary", () => {
  // a.high == b.low is NOT disjoint by this function's strict-less-than definition.
  assert.equal(intervalsDisjoint({ low: 0, high: 0.5 }, { low: 0.5, high: 1 }), false);
});
