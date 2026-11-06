import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runPrecommitCheck } from "./precommit.js";

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "mutant-priority-precommit-test-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fixture" }));
  mkdirSync(join(dir, "src"));
  mkdirSync(join(dir, "test"));
  // One BooleanLiteralInversion mutant.
  writeFileSync(join(dir, "src", "a.js"), `module.exports = { ok: true };\n`);
  writeFileSync(join(dir, "test", "a.test.js"), `require("../src/a.js");\n`);
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

test("runPrecommitCheck: no files given/staged -> vacuous pass, no test command run", async () => {
  await withRepo(async (dir) => {
    const report = await runPrecommitCheck({
      root: dir,
      testCommand: "exit 1", // would fail the whole check if this ever ran
      mutantsPerFile: 2,
      timeoutMs: 5000,
      files: [],
    });
    assert.equal(report.passed, true);
    assert.deepEqual(report.filesChecked, []);
  });
});

test("runPrecommitCheck: test files staged are excluded from mutation (nothing to check -> passes)", async () => {
  await withRepo(async (dir) => {
    const report = await runPrecommitCheck({
      root: dir,
      testCommand: "exit 1",
      mutantsPerFile: 2,
      timeoutMs: 5000,
      files: ["test/a.test.js"],
    });
    assert.equal(report.passed, true);
    assert.deepEqual(report.filesChecked, []);
  });
});

test("runPrecommitCheck: baseline failing aborts with passed=false and no mutants run", async () => {
  await withRepo(async (dir) => {
    const report = await runPrecommitCheck({
      root: dir,
      testCommand: "exit 1",
      mutantsPerFile: 2,
      timeoutMs: 5000,
      files: ["src/a.js"],
    });
    assert.equal(report.baselinePassed, false);
    assert.equal(report.passed, false);
    assert.deepEqual(report.results, []);
  });
});

test("runPrecommitCheck: a surviving mutant on a staged file fails the check", async () => {
  await withRepo(async (dir) => {
    // "exit 0" always passes -> baseline passes, and the mutant also
    // "passes" (survives) since nothing actually exercises the mutation.
    const report = await runPrecommitCheck({
      root: dir,
      testCommand: "exit 0",
      mutantsPerFile: 2,
      timeoutMs: 5000,
      files: ["src/a.js"],
    });
    assert.equal(report.baselinePassed, true);
    assert.equal(report.passed, false);
    assert.equal(report.results.length, 1);
    assert.equal(report.results[0].survived, 1);
  });
});

test("runPrecommitCheck: a killed mutant on a staged file passes the check", async () => {
  await withRepo(async (dir) => {
    // A command that passes on its first call (the baseline) and fails on
    // every call after that (simulating a test suite catching the
    // mutation), tracked via a marker file written on the first call.
    const counter = join(dir, "count.txt");
    const cmd = `bash -c '[ -f ${counter} ] && exit 1 || { touch ${counter}; exit 0; }'`;
    const report = await runPrecommitCheck({
      root: dir,
      testCommand: cmd,
      mutantsPerFile: 1,
      timeoutMs: 5000,
      files: ["src/a.js"],
    });
    assert.equal(report.baselinePassed, true);
    assert.equal(report.passed, true);
    assert.equal(report.results[0].killed, 1);
  });
});

test("runPrecommitCheck: --coverage skips a genuinely dead branch without running a test, and narrows the live one", async () => {
  await withRepo(async (dir) => {
    // Overwrite the fixture's src/a.js with a branchy function whose
    // `false` branch is dead code as far as the test suite goes.
    writeFileSync(join(dir, "src", "a.js"), `function isPos(x) {\n  if (x > 0) {\n    return true;\n  } else {\n    return false;\n  }\n}\nmodule.exports = { isPos };\n`);
    writeFileSync(
      join(dir, "test", "a.test.js"),
      `const { isPos } = require("../src/a.js");\nconst assert = require("node:assert/strict");\nassert.equal(isPos(1), true);\n`
    );

    const report = await runPrecommitCheck({
      root: dir,
      testCommand: "node --test test/",
      mutantsPerFile: 3, // boundary mutant + both boolean literals
      timeoutMs: 10000,
      files: ["src/a.js"],
      coverage: { testFileCmdTemplate: "node {files}" },
    });

    assert.equal(report.baselinePassed, true);
    const outcomes = report.results[0].outcomes;
    assert.equal(outcomes.length, 3);

    const trueMutant = outcomes.find((o) => o.line === 3);
    assert.equal(trueMutant?.status, "Killed");
    const falseMutant = outcomes.find((o) => o.line === 5);
    assert.equal(falseMutant?.status, "Survived");

    assert.ok(report.coverageStats);
    assert.equal(report.coverageStats!.mutantsSkippedNoCoverage, 1);
    assert.equal(report.coverageStats!.mutantsWithCoverageMatch, 2);
    assert.equal(report.passed, false); // the dead-branch mutant survived -> hook should still flag it
  });
});

test("runPrecommitCheck: --impact resolves the staged file's impacted test", async () => {
  await withRepo(async (dir) => {
    const marker = join(dir, "ran-impacted.txt");
    const report = await runPrecommitCheck({
      root: dir,
      testCommand: "exit 0",
      mutantsPerFile: 1,
      timeoutMs: 5000,
      files: ["src/a.js"],
      impact: { testFileCmdTemplate: `touch ${marker} && echo {files} && exit 0` },
    });
    assert.deepEqual(report.results[0].impactedTests, ["test/a.test.js"]);
  });
});
