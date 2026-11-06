import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, appendFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  readCheckpoint,
  readCheckpointLines,
  readOriginals,
  appendCheckpointLine,
  checkpointKey,
  checkpointKeySet,
} from "./checkpoint.js";

function withTempDir(fn: (dir: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), "mutant-priority-checkpoint-test-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("readCheckpoint: missing file returns empty array, not an error", () => {
  withTempDir((dir) => {
    assert.deepEqual(readCheckpoint(join(dir, "nope.jsonl")), []);
  });
});

test("appendCheckpointLine + readCheckpoint: round-trips outcome records exactly", () => {
  withTempDir((dir) => {
    const path = join(dir, "cp.jsonl");
    appendCheckpointLine(path, { type: "outcome", strategy: "fanOut", file: "a.ts", start: 10, line: 2, kind: "BooleanLiteralInversion", status: "Killed" });
    appendCheckpointLine(path, { type: "outcome", strategy: "fanOut", file: "a.ts", start: 40, line: 5, kind: "EqualityReplacement", status: "Survived" });

    const records = readCheckpoint(path);
    assert.equal(records.length, 2);
    assert.equal(records[0].status, "Killed");
    assert.equal(records[1].status, "Survived");
  });
});

test("readOriginals: extracts file->content map from 'original' records, ignores 'outcome' records", () => {
  withTempDir((dir) => {
    const path = join(dir, "cp.jsonl");
    appendCheckpointLine(path, { type: "original", file: "a.ts", content: "const x = true;\n" });
    appendCheckpointLine(path, { type: "outcome", strategy: "fanOut", file: "a.ts", start: 10, line: 1, kind: "BooleanLiteralInversion", status: "Killed" });

    const originals = readOriginals(path);
    assert.equal(originals.size, 1);
    assert.equal(originals.get("a.ts"), "const x = true;\n");
    assert.equal(readCheckpoint(path).length, 1); // "original" line excluded from readCheckpoint
  });
});

test("readOriginals: first record for a file wins if duplicated", () => {
  withTempDir((dir) => {
    const path = join(dir, "cp.jsonl");
    appendCheckpointLine(path, { type: "original", file: "a.ts", content: "FIRST" });
    appendCheckpointLine(path, { type: "original", file: "a.ts", content: "SECOND" });
    assert.equal(readOriginals(path).get("a.ts"), "FIRST");
  });
});

test("readCheckpointLines: tolerates a truncated LAST line (the kill -9 mid-append case)", () => {
  withTempDir((dir) => {
    const path = join(dir, "cp.jsonl");
    appendCheckpointLine(path, { type: "outcome", strategy: "fanOut", file: "a.ts", start: 1, line: 1, kind: "BooleanLiteralInversion", status: "Killed" });
    // Simulate a write that was interrupted partway through JSON.stringify's output:
    appendFileSync(path, '{"type":"outcome","strategy":"fanOut","file":"b.ts","st');

    const lines = readCheckpointLines(path);
    assert.equal(lines.length, 1); // only the complete first line survives
  });
});

test("readCheckpointLines: a corrupt line that is NOT last throws rather than silently dropping data", () => {
  withTempDir((dir) => {
    const path = join(dir, "cp.jsonl");
    writeFileSync(path, '{"broken"\n{"type":"outcome","strategy":"fanOut","file":"a.ts","start":1,"line":1,"kind":"X","status":"Killed"}\n');
    assert.throws(() => readCheckpointLines(path), /not the last line/);
  });
});

test("checkpointKey: distinguishes two mutants on the same line by start offset, not line", () => {
  // `a + b - c` has both a `+` and a `-` mutant candidate on line 1.
  const k1 = checkpointKey({ strategy: "fanOut", file: "a.ts", start: 2, kind: "ArithmeticOperatorReplacement" });
  const k2 = checkpointKey({ strategy: "fanOut", file: "a.ts", start: 6, kind: "ArithmeticOperatorReplacement" });
  assert.notEqual(k1, k2);
});

test("checkpointKeySet: builds a set usable for O(1) skip checks", () => {
  const set = checkpointKeySet([
    { type: "outcome", strategy: "fanOut", file: "a.ts", start: 10, line: 2, kind: "BooleanLiteralInversion", status: "Killed" },
  ]);
  assert.ok(set.has(checkpointKey({ strategy: "fanOut", file: "a.ts", start: 10, kind: "BooleanLiteralInversion" })));
  assert.ok(!set.has(checkpointKey({ strategy: "fanOut", file: "a.ts", start: 99, kind: "BooleanLiteralInversion" })));
});
