import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { getStagedFiles } from "./git.js";
import { isTestFile } from "./graph.js";
import { findMutants, confirmBaseline, runOneMutant, type MutantOutcome } from "./mutate.js";
import { pickEvenly } from "./validate.js";
import { buildImpactGraph, computeImpactedTests, narrowImpactedTestsByIdentifier, buildImpactedTestCommand, type ImpactGraph } from "./impact.js";
import { buildCoverageIndex, computeCoverageImpactedTests, type CoverageIndex } from "./coverage.js";

const SOURCE_EXT_RE = /\.(ts|tsx|js|jsx|mjs|cjs)$/;

export interface PrecommitImpactOptions {
  testFileCmdTemplate: string; // must contain "{files}"
  narrowByIdentifier?: boolean;
}

export interface PrecommitCoverageOptions {
  /** Same shape as ImpactOptions/CoverageOptions elsewhere: a shell
   * command template containing "{files}", run once per test file while
   * building the index. See coverage.ts and validate.ts's `coverage`
   * option — this is the same feature, scoped to staged files. */
  testFileCmdTemplate: string;
}

export interface PrecommitOptions {
  root: string;
  /** Same package-self-import resolution `--impact` uses; optional here
   * since precommit doesn't need a ranking entry point, only the impact
   * graph's self-import special case. */
  entry?: string;
  testCommand: string;
  mutantsPerFile: number;
  timeoutMs: number;
  impact?: PrecommitImpactOptions;
  /** See `validate`'s `coverage` option: sound, per-mutant test selection
   * from real, executed coverage instead of the static import graph.
   * Composes with `impact` the same way it does in `validate` — a file
   * the coverage index has no data for falls back to `impact`'s answer,
   * then the full suite. */
  coverage?: PrecommitCoverageOptions;
  /** Override staged-file detection — mainly for tests, but also lets a
   * caller run this against an arbitrary file list outside a git hook
   * (e.g. "files touched by this PR" from a CI diff). */
  files?: string[];
  onProgress?: (msg: string) => void;
}

export interface PrecommitFileResult {
  file: string;
  mutants: number;
  killed: number;
  survived: number;
  outcomes: MutantOutcome[];
  impactedTests: string[] | null; // null = fell back to the full suite (or --impact wasn't requested)
}

export interface PrecommitReport {
  root: string;
  filesChecked: string[];
  baselinePassed: boolean;
  results: PrecommitFileResult[];
  /** True iff the baseline passed AND no sampled mutant on a staged file
   * survived. An empty `filesChecked` (nothing staged, or nothing staged
   * that looks like source) passes vacuously — a hook that runs this
   * unconditionally on every commit shouldn't block commits that touch no
   * mutation-testable code. */
  passed: boolean;
  verdict: string;
  coverageStats: { mutantsWithCoverageMatch: number; mutantsSkippedNoCoverage: number; mutantsUninstrumented: number } | null;
}

/**
 * The `precommit` command's engine: mutation-test ONLY the files currently
 * staged for commit (or `opts.files`, if given), sampling a small number of
 * mutants per file and running them against the narrowest test command
 * this repo's static graphs can justify — same `--impact`/`--coverage`
 * machinery `validate` uses, just scoped to "what's about to be committed"
 * instead of a ranked sample of the whole repo. Intended to run in well
 * under the time a human will tolerate in a pre-commit hook; see
 * examples/pre-commit for a husky wiring.
 */
export async function runPrecommitCheck(opts: PrecommitOptions): Promise<PrecommitReport> {
  const { root, entry, testCommand, mutantsPerFile, timeoutMs, impact, coverage, onProgress } = opts;
  const log = onProgress ?? (() => {});

  const candidateFiles = opts.files ?? getStagedFiles(root);
  const filesChecked = candidateFiles.filter((f) => SOURCE_EXT_RE.test(f) && !isTestFile(f) && existsSync(join(root, f)));

  if (filesChecked.length === 0) {
    return {
      root,
      filesChecked: [],
      baselinePassed: true,
      results: [],
      passed: true,
      verdict: "No staged source files to check (nothing staged, or only test files / non-JS-TS files staged).",
      coverageStats: null,
    };
  }

  log(`Confirming baseline test suite passes clean before checking ${filesChecked.length} staged file(s)...`);
  const baselinePassed = await confirmBaseline(testCommand, root, Math.max(timeoutMs * 3, 30000));
  if (!baselinePassed) {
    return {
      root,
      filesChecked,
      baselinePassed: false,
      results: [],
      passed: false,
      verdict: "Baseline test suite does not pass clean in this working tree — aborting. Fix the failing tests before this check can say anything about your staged changes.",
      coverageStats: null,
    };
  }

  let impactGraph: ImpactGraph | null = null;
  if (impact || coverage) {
    log("Building test-impact graph (source + test files)...");
    impactGraph = buildImpactGraph(root, entry);
  }

  let coverageIndex: CoverageIndex | null = null;
  let mutantsWithCoverageMatch = 0;
  let mutantsSkippedNoCoverage = 0;
  let mutantsUninstrumented = 0;
  if (coverage && impactGraph) {
    const testFiles = impactGraph.files.filter((f) => isTestFile(f));
    log(`Building real coverage index from ${testFiles.length} test file(s) (one instrumented run each)...`);
    coverageIndex = await buildCoverageIndex(root, coverage.testFileCmdTemplate, testFiles, timeoutMs, log);
  }

  const results: PrecommitFileResult[] = [];

  for (const file of filesChecked) {
    const absPath = join(root, file);
    const src = readFileSync(absPath, "utf-8");
    const candidates = findMutants(src, file);
    if (!candidates.length) {
      results.push({ file, mutants: 0, killed: 0, survived: 0, outcomes: [], impactedTests: null });
      continue;
    }

    let fallbackCmdForFile = testCommand;
    let impactedTests: string[] | null = null;
    if (impact && impactGraph) {
      let tests = computeImpactedTests(impactGraph, file);
      if (impact.narrowByIdentifier && tests.length) {
        tests = narrowImpactedTestsByIdentifier(impactGraph, file, tests);
      }
      if (tests.length) {
        fallbackCmdForFile = buildImpactedTestCommand(impact.testFileCmdTemplate, tests);
        impactedTests = tests;
      } else {
        log(`${file}: no impacted tests found statically — falling back to full suite`);
      }
    }

    const sampled = pickEvenly(candidates, mutantsPerFile);
    const outcomes: MutantOutcome[] = [];
    for (const m of sampled) {
      let cmdForFile = fallbackCmdForFile;
      if (coverageIndex) {
        const coveringTests = computeCoverageImpactedTests(coverageIndex, file, m.start);
        if (coveringTests === null) {
          mutantsUninstrumented += 1;
        } else if (coveringTests.length === 0) {
          mutantsSkippedNoCoverage += 1;
          log(`${file}:${m.line} [${m.kind}]: no test's real coverage reaches this exact offset — Survived (skipped, no test run)`);
          outcomes.push({ file, line: m.line, kind: m.kind, status: "Survived" });
          continue;
        } else {
          mutantsWithCoverageMatch += 1;
          cmdForFile = buildImpactedTestCommand(coverage!.testFileCmdTemplate, coveringTests);
        }
      }

      log(`${file}:${m.line} [${m.kind}]${cmdForFile !== testCommand ? " (narrowed test set)" : ""}`);
      const outcome = await runOneMutant(absPath, file, m, cmdForFile, root, timeoutMs);
      outcomes.push(outcome);
    }

    results.push({
      file,
      mutants: outcomes.length,
      killed: outcomes.filter((o) => o.status === "Killed").length,
      survived: outcomes.filter((o) => o.status === "Survived").length,
      outcomes,
      impactedTests,
    });
  }

  const totalSurvived = results.reduce((n, r) => n + r.survived, 0);
  const totalMutants = results.reduce((n, r) => n + r.mutants, 0);
  const passed = totalSurvived === 0;

  const verdict = passed
    ? `All ${totalMutants} sampled mutant(s) across ${filesChecked.length} staged file(s) were caught.`
    : `${totalSurvived} of ${totalMutants} sampled mutant(s) SURVIVED across staged files: ` +
      results
        .filter((r) => r.survived > 0)
        .map((r) => `${r.file} (${r.survived} survived)`)
        .join(", ") +
      ". Consider adding/strengthening a test before committing, or re-run without this check if it's a false alarm.";

  return {
    root,
    filesChecked,
    baselinePassed: true,
    results,
    passed,
    verdict,
    coverageStats: coverageIndex ? { mutantsWithCoverageMatch, mutantsSkippedNoCoverage, mutantsUninstrumented } : null,
  };
}
