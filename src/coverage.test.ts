import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildCoverageIndex, computeCoverageImpactedTests, isOffsetCovered } from "./coverage.js";

test("isOffsetCovered: an offset with no containing range defaults to covered (absence isn't evidence)", () => {
  assert.equal(isOffsetCovered([], 5), true);
});

test("isOffsetCovered: picks the innermost (smallest) containing range, not the outer one", () => {
  const ranges = [
    { startOffset: 0, endOffset: 100, count: 1 }, // whole function ran
    { startOffset: 40, endOffset: 60, count: 0 }, // but this inner branch didn't
  ];
  assert.equal(isOffsetCovered(ranges, 10), true); // outside the inner branch -> outer range applies
  assert.equal(isOffsetCovered(ranges, 50), false); // inside the uncovered inner branch
});

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "mutant-priority-coverage-test-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fixture" }));
  mkdirSync(join(dir, "src"));
  mkdirSync(join(dir, "test"));
  writeFileSync(
    join(dir, "src", "branchy.js"),
    `function branchy(x) {\n  if (x > 0) {\n    return "pos";\n  } else {\n    return "neg";\n  }\n}\nmodule.exports = { branchy };\n`
  );
  writeFileSync(
    join(dir, "test", "pos.test.js"),
    `const { branchy } = require("../src/branchy.js");\nconst assert = require("node:assert/strict");\nassert.equal(branchy(1), "pos");\n`
  );
  return dir;
}

async function withRepo(fn: (dir: string) => Promise<void> | void) {
  const dir = makeRepo();
  try {
    await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("buildCoverageIndex + computeCoverageImpactedTests: a real per-line split — the exercised branch matches, the dead branch doesn't", async () => {
  await withRepo(async (dir) => {
    const index = await buildCoverageIndex(dir, "node {files}", ["test/pos.test.js"], 10000);
    assert.equal(index.byFile.has("src/branchy.js"), true);
    assert.equal(index.failedTestFiles.length, 0);

    const src = readFileSync(join(dir, "src", "branchy.js"), "utf-8");
    const posOffset = src.indexOf('"pos"');
    const negOffset = src.indexOf('"neg"');

    const posTests = computeCoverageImpactedTests(index, "src/branchy.js", posOffset);
    assert.deepEqual(posTests, ["test/pos.test.js"]);

    const negTests = computeCoverageImpactedTests(index, "src/branchy.js", negOffset);
    assert.deepEqual(negTests, []); // genuinely uncovered by this test file — not "unknown"
  });
});

test("computeCoverageImpactedTests: a file the index never instrumented returns null (unknown), not []", async () => {
  await withRepo(async (dir) => {
    writeFileSync(join(dir, "src", "untouched.js"), `module.exports = 1;\n`);
    const index = await buildCoverageIndex(dir, "node {files}", ["test/pos.test.js"], 10000);
    const result = computeCoverageImpactedTests(index, "src/untouched.js", 0);
    assert.equal(result, null);
  });
});

test("buildCoverageIndex: a test file that throws still contributes whatever it covered before failing, and is flagged", async () => {
  await withRepo(async (dir) => {
    writeFileSync(
      join(dir, "test", "throws.test.js"),
      `const { branchy } = require("../src/branchy.js");\nbranchy(-1);\nthrow new Error("boom");\n`
    );
    const index = await buildCoverageIndex(dir, "node {files}", ["test/throws.test.js"], 10000);
    assert.deepEqual(index.failedTestFiles, ["test/throws.test.js"]);

    const src = readFileSync(join(dir, "src", "branchy.js"), "utf-8");
    const negOffset = src.indexOf('"neg"');
    const tests = computeCoverageImpactedTests(index, "src/branchy.js", negOffset);
    assert.deepEqual(tests, ["test/throws.test.js"]); // covered before the throw
  });
});
