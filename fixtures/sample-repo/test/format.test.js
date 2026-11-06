const test = require("node:test");
const assert = require("node:assert");
const { describe } = require("../src/format");

test("describe formats even numbers", () => {
  assert.strictEqual(describe(4, "count"), "count: 4 (even)");
});
test("describe formats odd numbers", () => {
  assert.strictEqual(describe(3, "count"), "count: 3 (odd)");
});
test("describe handles blank label", () => {
  assert.strictEqual(describe(3, ""), "unknown");
});
