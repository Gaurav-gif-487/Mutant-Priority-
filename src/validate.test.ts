import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { validate, aggregateFromRecords } from "./validate.js";
import { readCheckpoint, readCheckpointLines } from "./checkpoint.js";

function makeRepo(fileCount: number): string {
  const dir = mkdtempSync(join(tmpdir(), "mutant-priority-validate-test-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fixture" }));
  mkdirSync(join(dir, "src"));
  const files: string[] = [];
  for (let i = 0; i < fileCount; i++) {
    const rel = `src/f${i}.js`;
    // One BooleanLiteralInversion mutant per file, nothing else.
    writeFileSync(join(dir, rel), `module.exports = { ok${i}: true };\n`);
    files.push(rel);
  }
  // Entry just requires the first file, enough for buildGraph to have an entry point.
  writeFileSync(join(dir, "src", "index.js"), `require("./f0");\n`);
  return dir;
}

function withRepo(fileCount: number, fn: (dir: string) => Promise<void> | void) {
  const dir = makeRepo(fileCount);
  return (async () => {
    try {
      await fn(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  })();
}

const FAST_CMD = "exit 0"; // always "Survived" — these tests are about mechanics, not kill rates

test("checkpoint resume: 2 of 4 mutants pre-recorded — only the remaining 2 execute", async () => {
  await withRepo(4, async (dir) => {
    const cp = join(dir, "cp.jsonl");
    const counterFile = join(dir, "run-count.txt");
    const countingCmd = `echo x >> ${counterFile} && exit 0`;

    // Discover the real (file, start, kind) for each file's one mutant.
    const { findMutants } = await import("./mutate.js");
    const { readFileSync: rfs } = await import("node:fs");
    const targets: { file: string; start: number; kind: string }[] = [];
    for (let i = 0; i < 4; i++) {
      const rel = `src/f${i}.js`;
      const src = rfs(join(dir, rel), "utf-8");
      const [m] = findMutants(src, rel);
      targets.push({ file: rel, start: m.start, kind: m.kind });
    }

    // Pre-record exactly 2 of the 4 as already done, as an interrupted run's
    // checkpoint file would look, using the appendCheckpointLine + original
    // record shape validate() itself would have written.
    const { appendCheckpointLine } = await import("./checkpoint.js");
    for (const t of targets.slice(0, 2)) {
      const src = rfs(join(dir, t.file), "utf-8");
      appendCheckpointLine(cp, { type: "original", file: t.file, content: src });
      appendCheckpointLine(cp, { type: "outcome", strategy: "fanOut", file: t.file, start: t.start, line: 1, kind: t.kind, status: "Survived" });
    }

    const result = await validate({
      root: dir,
      entry: "src/index.js",
      testCommand: countingCmd,
      strategies: ["fanOut"],
      filesPerStrategy: 5,
      mutantsPerFile: 1,
      timeoutMs: 5000,
      checkpointPath: cp,
    });

    assert.equal(result.strategies[0].mutants, 4); // 2 pre-recorded + 2 executed = 4 total
    const executedCount = readFileSync(counterFile, "utf-8").trim().split("\n").filter(Boolean).length;
    assert.equal(executedCount, 2); // only the 2 NOT pre-recorded actually ran
  });
});

test("checkpoint resume: does not re-run mutants already recorded, and totals match", async () => {
  await withRepo(4, async (dir) => {
    const cp = join(dir, "cp.jsonl");
    const counterFile = join(dir, "run-count.txt");
    const countingCmd = `echo x >> ${counterFile} && exit 0`;

    const first = await validate({
      root: dir,
      entry: "src/index.js",
      testCommand: countingCmd,
      strategies: ["fanOut"],
      filesPerStrategy: 5,
      mutantsPerFile: 1,
      timeoutMs: 5000,
      checkpointPath: cp,
    });
    assert.equal(first.strategies[0].mutants, 4); // one mutant per file, 4 files
    // 4 mutant runs + 1 baseline confirmation (checkpoint was empty, so the
    // baseline actually gets confirmed once here) = 5 real invocations.
    const countAfterFirst = readFileSync(counterFile, "utf-8").trim().split("\n").length;
    assert.equal(countAfterFirst, 5);

    const second = await validate({
      root: dir,
      entry: "src/index.js",
      testCommand: countingCmd,
      strategies: ["fanOut"],
      filesPerStrategy: 5,
      mutantsPerFile: 1,
      timeoutMs: 5000,
      checkpointPath: cp,
    });
    assert.equal(second.strategies[0].mutants, 4); // same total, reconstructed from checkpoint
    // Checkpoint is non-empty now, so baseline is skipped too — nothing
    // AT ALL should invoke the test command a second time.
    const countAfterSecond = readFileSync(counterFile, "utf-8").trim().split("\n").length;
    assert.equal(countAfterSecond, 5); // unchanged — zero new invocations
  });
});

test("checkpoint resume: partial-then-full run produces the same totals as one uninterrupted run", async () => {
  await withRepo(6, async (dir) => {
    const cp = join(dir, "cp.jsonl");

    // Simulate an interruption: only look at the first 3 (of 6) ranked files.
    await validate({
      root: dir,
      entry: "src/index.js",
      testCommand: FAST_CMD,
      strategies: ["fanOut"],
      filesPerStrategy: 3,
      mutantsPerFile: 1,
      timeoutMs: 5000,
      checkpointPath: cp,
    });
    const midway = readCheckpoint(cp).length;
    assert.equal(midway, 3);

    // "Resume" with the full file count.
    const resumed = await validate({
      root: dir,
      entry: "src/index.js",
      testCommand: FAST_CMD,
      strategies: ["fanOut"],
      filesPerStrategy: 6,
      mutantsPerFile: 1,
      timeoutMs: 5000,
      checkpointPath: cp,
    });

    // A single uninterrupted run on a fresh, identical fixture.
    const freshDir = makeRepo(6);
    try {
      const uninterrupted = await validate({
        root: freshDir,
        entry: "src/index.js",
        testCommand: FAST_CMD,
        strategies: ["fanOut"],
        filesPerStrategy: 6,
        mutantsPerFile: 1,
        timeoutMs: 5000,
      });
      assert.equal(resumed.strategies[0].mutants, uninterrupted.strategies[0].mutants);
      assert.equal(resumed.strategies[0].killed, uninterrupted.strategies[0].killed);
      assert.equal(resumed.strategies[0].survived, uninterrupted.strategies[0].survived);
    } finally {
      rmSync(freshDir, { recursive: true, force: true });
    }
  });
});

test("checkpoint resume: a file left mutated by a simulated crash is restored before re-mutating", async () => {
  await withRepo(2, async (dir) => {
    const cp = join(dir, "cp.jsonl");
    const targetFile = join(dir, "src", "f0.js");
    const pristine = readFileSync(targetFile, "utf-8");

    // First run captures the "original" record for f0.js and f1.js.
    await validate({
      root: dir,
      entry: "src/index.js",
      testCommand: FAST_CMD,
      strategies: ["fanOut"],
      filesPerStrategy: 2,
      mutantsPerFile: 1,
      timeoutMs: 5000,
      checkpointPath: cp,
    });
    assert.equal(readFileSync(targetFile, "utf-8"), pristine); // reverted normally, no crash yet

    // Now simulate exactly what a SIGKILL mid-mutant leaves behind: the file
    // mutated on disk, with NO new outcome record for it (the process died
    // before it could append one).
    writeFileSync(targetFile, pristine.replace("true", "false"));
    assert.notEqual(readFileSync(targetFile, "utf-8"), pristine);

    // A completely fresh validate call (e.g. a brand new process after the
    // crash) must restore f0.js from the checkpoint's "original" record
    // before doing anything else with it — even though every mutant for
    // both files is already recorded as done, so this call touches nothing.
    await validate({
      root: dir,
      entry: "src/index.js",
      testCommand: FAST_CMD,
      strategies: ["fanOut"],
      filesPerStrategy: 2,
      mutantsPerFile: 1,
      timeoutMs: 5000,
      checkpointPath: cp,
    });
    assert.equal(readFileSync(targetFile, "utf-8"), pristine, "crash-corrupted file must be restored to pristine content");
  });
});

test("shard: N shards over the same repo cover every file exactly once, with no overlap", async () => {
  await withRepo(6, async (dir) => {
    const shardCps = [join(dir, "cp0.jsonl"), join(dir, "cp1.jsonl"), join(dir, "cp2.jsonl")];
    for (let i = 0; i < 3; i++) {
      await validate({
        root: dir,
        entry: "src/index.js",
        testCommand: FAST_CMD,
        strategies: ["fanOut"],
        filesPerStrategy: 6,
        mutantsPerFile: 1,
        timeoutMs: 5000,
        checkpointPath: shardCps[i],
        shard: { index: i, total: 3 },
      });
    }
    const allFiles = shardCps.flatMap((p) => readCheckpoint(p).map((r) => r.file));
    assert.equal(allFiles.length, 6); // every one of the 6 files covered
    assert.equal(new Set(allFiles).size, 6); // no file covered by more than one shard

    // aggregate across shards must match a single unsharded run.
    const merged = shardCps.flatMap((p) => readCheckpoint(p));
    const { strategies } = aggregateFromRecords(merged);
    assert.equal(strategies[0].mutants, 6);
  });
});

test("aggregate: combining checkpoint files reproduces the same kill/survive totals a live run would report", async () => {
  await withRepo(5, async (dir) => {
    const cp = join(dir, "cp.jsonl");
    const live = await validate({
      root: dir,
      entry: "src/index.js",
      testCommand: FAST_CMD,
      strategies: ["fanOut"],
      filesPerStrategy: 5,
      mutantsPerFile: 1,
      timeoutMs: 5000,
      checkpointPath: cp,
    });
    const records = readCheckpoint(cp);
    const { strategies } = aggregateFromRecords(records);
    assert.equal(strategies[0].mutants, live.strategies[0].mutants);
    assert.equal(strategies[0].killed, live.strategies[0].killed);
    assert.equal(strategies[0].survived, live.strategies[0].survived);
  });
});

test("checkpoint: 'original' record is written exactly once per file, even across multiple resumed calls", async () => {
  await withRepo(2, async (dir) => {
    const cp = join(dir, "cp.jsonl");
    await validate({
      root: dir, entry: "src/index.js", testCommand: FAST_CMD, strategies: ["fanOut"],
      filesPerStrategy: 1, mutantsPerFile: 1, timeoutMs: 5000, checkpointPath: cp,
    });
    await validate({
      root: dir, entry: "src/index.js", testCommand: FAST_CMD, strategies: ["fanOut"],
      filesPerStrategy: 2, mutantsPerFile: 1, timeoutMs: 5000, checkpointPath: cp,
    });
    const originals = readCheckpointLines(cp).filter((l) => l.type === "original");
    const byFile = new Set(originals.map((o: any) => o.file));
    assert.equal(originals.length, byFile.size); // no file has more than one "original" line
  });
});

test("coverage: a mutant on a genuinely dead branch is Survived without ever launching a test, while the live branch is really run and Killed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mutant-priority-coverage-integration-"));
  try {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fixture" }));
    mkdirSync(join(dir, "src"));
    mkdirSync(join(dir, "test"));
    writeFileSync(
      join(dir, "src", "isPos.js"),
      `function isPos(x) {\n  if (x > 0) {\n    return true;\n  } else {\n    return false;\n  }\n}\nmodule.exports = { isPos };\n`
    );
    writeFileSync(join(dir, "src", "index.js"), `require("./isPos.js");\n`);
    // Only ever calls isPos with a positive number -> the `false` branch is dead code as far as this suite goes.
    writeFileSync(
      join(dir, "test", "isPos.test.js"),
      `const { isPos } = require("../src/isPos.js");\nconst assert = require("node:assert/strict");\nassert.equal(isPos(1), true);\n`
    );

    const report = await validate({
      root: dir,
      entry: "src/index.js",
      testCommand: "node --test test/", // full-suite fallback, should never actually be needed here
      strategies: ["fanOut"],
      filesPerStrategy: 5,
      mutantsPerFile: 3, // the `x > 0` boundary mutant plus both the `true` and `false` literal mutants
      timeoutMs: 10000,
      coverage: { testFileCmdTemplate: "node {files}" },
    });

    assert.equal(report.baselinePassed, true);
    const outcomes = report.strategies[0].outcomes;
    assert.equal(outcomes.length, 3);

    // line 3 is `return true;` (the live branch) -> flipping it to `false`
    // breaks `assert.equal(isPos(1), true)`, and it's real coverage (the
    // test really ran this exact mutant), not a guess.
    const trueMutant = outcomes.find((o) => o.line === 3);
    assert.equal(trueMutant?.status, "Killed");

    // line 5 is `return false;` (the else branch) -> isPos is only ever
    // called with a positive number in this suite, so this exact offset
    // has zero real coverage: it must be Survived WITHOUT a test process
    // having been launched for it at all.
    const falseMutant = outcomes.find((o) => o.line === 5);
    assert.equal(falseMutant?.status, "Survived");

    assert.ok(report.coverageStats);
    // Both the boundary mutant (line 2) and the `true` mutant (line 3)
    // sit inside code this suite really executes -> narrowed to the one
    // real covering test, not skipped.
    assert.equal(report.coverageStats!.mutantsWithCoverageMatch, 2);
    // Only the dead `false` branch mutant is skipped outright.
    assert.equal(report.coverageStats!.mutantsSkippedNoCoverage, 1);
    assert.equal(report.coverageStats!.instrumentedFiles >= 1, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
