import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { mkdtempSync, cpSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeStrykerConfig } from "./stryker.js";

const FIXTURES = fileURLToPath(new URL("../fixtures/", import.meta.url));

function withCopiedFixture(name: string, fn: (root: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), "mutant-priority-stryker-test-"));
  cpSync(FIXTURES + name, dir, { recursive: true });
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("writeStrykerConfig: creates a new config with mutate list in strategy order", () => {
  withCopiedFixture("sample-repo", (root) => {
    const configPath = join(root, "stryker.conf.json");
    const result = writeStrykerConfig({ root, entry: "src/index.js", strategy: "fanOut", configPath, budget: 2 });
    assert.equal(result.created, true);
    assert.equal(result.mutateCount, 2);
    assert.equal(result.totalFiles, 4);

    const written = JSON.parse(readFileSync(configPath, "utf-8"));
    assert.equal(written.mutate.length, 2);
    assert.ok(written["$schema"]);
  });
});

test("writeStrykerConfig: patches an existing config, preserving unrelated fields", () => {
  withCopiedFixture("sample-repo", (root) => {
    const configPath = join(root, "stryker.conf.json");
    writeFileSync(
      configPath,
      JSON.stringify({ testRunner: "mocha", mutate: ["old.js"], reporters: ["html"] }, null, 2)
    );

    const result = writeStrykerConfig({ root, entry: "src/index.js", strategy: "fanIn", configPath, budget: 1 });
    assert.equal(result.created, false);

    const written = JSON.parse(readFileSync(configPath, "utf-8"));
    assert.equal(written.testRunner, "mocha"); // untouched
    assert.deepEqual(written.reporters, ["html"]); // untouched
    assert.equal(written.mutate.length, 1); // overwritten
    assert.notDeepEqual(written.mutate, ["old.js"]);
  });
});

test("writeStrykerConfig: without --budget, includes every file in the graph", () => {
  withCopiedFixture("sample-repo", (root) => {
    const configPath = join(root, "stryker.conf.json");
    const result = writeStrykerConfig({ root, entry: "src/index.js", strategy: "fanOut", configPath });
    assert.equal(result.mutateCount, result.totalFiles);
  });
});

test("writeStrykerConfig: an unparseable existing config is not silently corrupted with garbage — it's replaced cleanly", () => {
  withCopiedFixture("sample-repo", (root) => {
    const configPath = join(root, "stryker.conf.json");
    writeFileSync(configPath, "{ not valid json");

    const result = writeStrykerConfig({ root, entry: "src/index.js", strategy: "fanOut", configPath, budget: 1 });
    const written = JSON.parse(readFileSync(configPath, "utf-8")); // must be valid JSON now
    assert.equal(written.mutate.length, 1);
    assert.equal(result.created, false); // file existed before, even though unparseable
  });
});
