import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync, readdirSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join, sep } from "node:path";
import { tmpdir } from "node:os";
import { buildImpactedTestCommand } from "./impact.js";

const exec = promisify(execFile);

/**
 * A single V8 coverage "range": a character-offset span (V8's offsets are
 * UTF-16 code-unit offsets into the source text — exactly what a JS
 * string's `.length`/`.slice` use, and exactly what TypeScript's own
 * `node.getStart()`/`getEnd()` (which `Mutant.start`/`.end` come from) use
 * too. That equivalence is what lets `isOffsetCovered` below compare a
 * mutant's offset directly against a V8 range with no unit conversion.
 */
export interface CoverageRange {
  startOffset: number;
  endOffset: number;
  count: number;
}

interface PerTestFileCoverage {
  testFile: string;
  /** Every range from every function in this script, flattened —
   * `isOffsetCovered` finds the innermost (smallest) containing range,
   * so flattening loses nothing: V8 emits ranges pre-nested per function,
   * and nesting across sibling functions never overlaps. */
  ranges: CoverageRange[];
}

export interface CoverageIndex {
  root: string;
  /** sourceFile -> one entry per test file whose run touched it at all
   * (V8 instruments every module actually `require`d/`import`ed during
   * that run, not just the ones the test file names directly). */
  byFile: Map<string, PerTestFileCoverage[]>;
  testFiles: string[];
  /** Test files that errored out (nonzero exit / timeout) while the index
   * was being built. Not fatal — a test file can legitimately fail on its
   * own and still have written valid coverage up to that point — but
   * surfaced so a caller can decide whether to trust "no coverage" from
   * one of these as real or as index-build noise. */
  failedTestFiles: string[];
}

/**
 * Is `offset` covered by the smallest (innermost) range that contains it?
 * V8 emits a whole-function range first (e.g. the whole `branchy` function,
 * count=1 because it ran at all) followed by any narrower sub-ranges V8's
 * block coverage carved out of it (e.g. an `else` branch that didn't run,
 * count=0) — so "smallest containing range" is exactly "the most specific
 * fact V8 recorded about this exact offset," which is what determines
 * whether a mutation planted at that offset was ever actually executed.
 * An offset with NO containing range at all (e.g. inside a comment, or a
 * file V8 never instrumented at that position) defaults to covered=true:
 * absence of range data is not evidence of non-execution, so treating it
 * as covered means we err toward running a real test rather than
 * silently — and wrongly — marking a mutant Survived.
 */
export function isOffsetCovered(ranges: CoverageRange[], offset: number): boolean {
  let best: CoverageRange | null = null;
  for (const r of ranges) {
    if (offset >= r.startOffset && offset < r.endOffset) {
      if (!best || r.endOffset - r.startOffset < best.endOffset - best.startOffset) best = r;
    }
  }
  return best ? best.count > 0 : true;
}

function toRepoRelative(root: string, fileUrl: string): string | null {
  if (!fileUrl.startsWith("file://")) return null;
  let p: string;
  try {
    p = new URL(fileUrl).pathname;
  } catch {
    return null;
  }
  // Windows file:// URLs have a leading slash before the drive letter
  // (file:///C:/...) that decodeURIComponent/URL.pathname preserves.
  if (process.platform === "win32" && /^\/[A-Za-z]:/.test(p)) p = p.slice(1);
  const rootNorm = root.endsWith(sep) ? root : root + sep;
  if (!p.startsWith(rootNorm)) return null;
  if (p.includes(`${sep}node_modules${sep}`)) return null;
  return p.slice(rootNorm.length).split(sep).join("/");
}

function readCoverageDir(dir: string): Array<{ url: string; functions: Array<{ ranges: CoverageRange[] }> }> {
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const out: Array<{ url: string; functions: Array<{ ranges: CoverageRange[] }> }> = [];
  for (const f of files) {
    try {
      const data = JSON.parse(readFileSync(join(dir, f), "utf-8"));
      if (Array.isArray(data.result)) out.push(...data.result);
    } catch {
      /* a partial/corrupt coverage file from a killed process — skip it, not fatal */
    }
  }
  return out;
}

/**
 * Build a REAL, sound coverage index by actually running each test file
 * once with `NODE_V8_COVERAGE` pointed at a scratch directory, then
 * reading back exactly which character ranges of which source files that
 * run executed. Cost is O(number of test files) real test-process
 * launches — done ONCE, up front, before the mutation loop — not O(number
 * of mutants). Compare `--impact`'s file-level static graph (instant, but
 * "imports it" is a superset of "actually exercises this line") or
 * `--narrow-by-identifier`'s text heuristic (still static): this is
 * ground truth from actually running the code.
 */
export async function buildCoverageIndex(
  root: string,
  testFileCmdTemplate: string,
  testFiles: string[],
  timeoutMs: number,
  onProgress?: (msg: string) => void
): Promise<CoverageIndex> {
  const log = onProgress ?? (() => {});
  const byFile = new Map<string, PerTestFileCoverage[]>();
  const failedTestFiles: string[] = [];
  const base = mkdtempSync(join(tmpdir(), "mutant-priority-coverage-"));

  try {
    for (let i = 0; i < testFiles.length; i++) {
      const testFile = testFiles[i];
      const covDir = join(base, String(i));
      mkdirSync(covDir, { recursive: true });
      const command = buildImpactedTestCommand(testFileCmdTemplate, [testFile]);
      log(`[coverage ${i + 1}/${testFiles.length}] instrumenting ${testFile}`);
      try {
        await exec(command, { cwd: root, timeout: timeoutMs, shell: "/bin/bash", env: { ...process.env, NODE_V8_COVERAGE: covDir } });
      } catch {
        // A test file that fails on its own can still have written real,
        // partial coverage before it exited — keep reading, just flag it.
        failedTestFiles.push(testFile);
      }

      const entries = readCoverageDir(covDir);
      const perFile = new Map<string, CoverageRange[]>();
      for (const entry of entries) {
        const rel = toRepoRelative(root, entry.url);
        if (!rel) continue;
        const ranges = entry.functions.flatMap((fn) => fn.ranges);
        const existing = perFile.get(rel);
        if (existing) existing.push(...ranges);
        else perFile.set(rel, ranges);
      }
      for (const [file, ranges] of perFile) {
        const list = byFile.get(file) ?? [];
        list.push({ testFile, ranges });
        byFile.set(file, list);
      }
    }
  } finally {
    // The exec() env still points several children's temp coverage dirs
    // at `base` for the duration of the loop above — safe to remove only
    // once every run in the loop has finished reading its own subdirectory.
    rmSync(base, { recursive: true, force: true });
  }

  return { root, byFile, testFiles, failedTestFiles };
}

/**
 * For a mutant at character offset `offset` in `file`, return the test
 * files whose real, executed coverage includes that exact offset —
 * or `null` if `file` was never instrumented by ANY test run in this
 * index (unknown; caller should fall back to `--impact`'s static answer
 * or the full suite, not assume "no test covers this").
 *
 * An empty (non-null) array is a genuine, actionable result: this exact
 * offset was not executed by any test in the current suite, so running
 * the mutation there is guaranteed to survive — the mutant can be marked
 * Survived directly, without spending a test-process launch to confirm
 * what the coverage data already proves.
 */
export function computeCoverageImpactedTests(index: CoverageIndex, file: string, offset: number): string[] | null {
  const perTest = index.byFile.get(file);
  if (!perTest) return null;
  return perTest.filter((pt) => isOffsetCovered(pt.ranges, offset)).map((pt) => pt.testFile);
}
