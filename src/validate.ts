import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildGraph, isTestFile } from "./graph.js";
import { rank, type RankedFile, type Strategy } from "./rank.js";
import { confirmBaseline, findMutants, runOneMutant, type Mutant, type MutantOutcome, type RetryOptions } from "./mutate.js";
import { wilsonInterval, intervalsDisjoint, type Interval } from "./stats.js";
import { buildImpactGraph, computeImpactedTests, narrowImpactedTestsByIdentifier, buildImpactedTestCommand, type ImpactGraph } from "./impact.js";
import { buildCoverageIndex, computeCoverageImpactedTests, type CoverageIndex } from "./coverage.js";
import { readCheckpoint, readOriginals, appendCheckpointLine, checkpointKey, checkpointKeySet, type OutcomeRecord } from "./checkpoint.js";
import { TscWatcher } from "./incremental.js";
import { createWorkerPool, runPool, type WorkerPool } from "./worker-pool.js";

// Below this many mutants, a strategy's kill rate isn't reported as part
// of the ranked comparison — its Wilson interval would be too wide to
// say anything. It still appears in the output, just flagged.
export const MIN_MUTANTS_FOR_COMPARISON = 8;

export interface StrategyResult {
  strategy: Strategy;
  filesTried: number;
  mutants: number;
  killed: number;
  survived: number;
  errors: number;
  /** Mutants whose first attempt was "Killed" but which flipped to
   * "Survived" on at least one retry — see RetryOptions. Counted
   * separately from killRate's denominator (see buildStrategyResult),
   * since a flaky result asserts nothing about whether the mutation was
   * actually caught. */
  flaky: number;
  killRate: number | null;
  killRateCI95: Interval | null; // Wilson score interval
  sufficientSample: boolean;
  outcomes: MutantOutcome[];
}

export interface ValidateReport {
  root: string;
  entry: string;
  testCommand: string;
  filesPerStrategy: number;
  mutantsPerFile: number;
  baselinePassed: boolean;
  strategies: StrategyResult[];
  verdict: string;
  impactStats: {
    mutantsWithImpactedTests: number;
    mutantsFallenBack: number;
    dynamicRequireFileCount: number;
    dynamicImportFileCount: number;
    /** Times narrowImpactedTestsByIdentifier actually shrank a mutant's
     * impacted-test list below the plain file-level answer. */
    mutantsNarrowedByIdentifier: number;
  } | null;
  coverageStats: {
    testFiles: number;
    /** Distinct source files that appeared in ANY test's coverage output
     * — i.e. files the index has real, sound data for. */
    instrumentedFiles: number;
    /** Test files that errored while the index was built — coverage from
     * these is still used (a test can fail after covering real code), but
     * a suspiciously high count here is worth a look before trusting the
     * index's "no coverage" verdicts. */
    failedTestFiles: number;
    /** Mutants that matched at least one test's real, executed coverage
     * of that exact offset — the sound, per-mutant narrowing this option
     * exists for. */
    mutantsWithCoverageMatch: number;
    /** Mutants whose exact offset was in an instrumented file but matched
     * NO test's coverage — skipped entirely (no test process launched)
     * and recorded as Survived directly, since the coverage data already
     * proves nothing exercises that code. */
    mutantsSkippedNoCoverage: number;
    /** Mutants in a file the coverage index has no data for at all —
     * fell back to --impact's static answer (if enabled) or the full
     * suite, exactly like a plain --impact fallback. */
    mutantsUninstrumented: number;
  } | null;
}

export interface CoverageOptions {
  /** Same template shape as ImpactOptions.testFileCmdTemplate — a shell
   * command containing the literal "{files}" placeholder, invoked once
   * per test file (not once per mutant) while building the index. */
  testFileCmdTemplate: string;
}

export interface ImpactOptions {
  testFileCmdTemplate: string; // must contain "{files}"
  /** Also apply narrowImpactedTestsByIdentifier's heuristic, finer-than-
   * file-level narrowing on top of the file-level impacted-test list.
   * Default false: the file-level list alone is always correct (every
   * test that could exercise the mutated file), where the identifier
   * heuristic can occasionally under-include on unusual export styles
   * (see extractExportedNames). Opt in once you've seen `--impact`'s
   * plain file-level fallback rate on your repo and want to go further. */
  narrowByIdentifier?: boolean;
}

export interface IncrementalBuildOptions {
  /** Path to the tsconfig to watch, relative to `root`. Default "tsconfig.json". */
  tsconfigPath?: string;
  /** How long to wait for the INITIAL build to settle before giving up. */
  startTimeoutMs?: number;
}

export interface ParallelOptions {
  /** Number of concurrent worker slots (isolated repo copies). 1 = no
   * parallelism (equivalent to omitting this option entirely). */
  workers: number;
}

export interface ShardOptions {
  index: number; // 0-indexed
  total: number;
}

export interface ValidateOptions {
  root: string;
  entry: string;
  testCommand: string;
  strategies: Strategy[];
  filesPerStrategy: number;
  mutantsPerFile: number;
  timeoutMs: number;
  scope?: string;
  impact?: ImpactOptions;
  /** Build a REAL per-test coverage index up front (one instrumented run
   * per test file via NODE_V8_COVERAGE) and use it to pick, per MUTANT
   * (not per file), only the tests whose actual execution covers that
   * exact offset. Strictly sounder than `impact`/`narrowByIdentifier`
   * (both static): a mutant whose offset no test executes is provably
   * going to survive and is reported Survived without spawning a test
   * process at all. Composes with `impact`: any file the coverage index
   * has no data for falls back to `impact`'s static answer, then to the
   * full suite — same layered-fallback shape `impact` itself uses. */
  coverage?: CoverageOptions;
  /** Path to a JSON-lines file. Each mutant's outcome is appended here as
   * soon as it's known. If the file already has records when a run starts,
   * mutants matching an already-recorded (strategy, file, start, kind) key
   * are skipped rather than re-run, and the baseline check is skipped
   * entirely (a non-empty checkpoint means a prior run in this exact
   * working tree already confirmed it passes clean). This is what makes a
   * run resumable across a crash or a killed process — including one that
   * dies mid-mutant, since the file is unaffected and just doesn't have a
   * record for that one yet. */
  checkpointPath?: string;
  /** Split one strategy's ranked file list across N parallel shards. Shard
   * i only processes files at ranked-list positions where `pos % total ===
   * index` — deterministic given the same graph and `filesPerStrategy`, so
   * running all N shards (each with its own --checkpoint file) covers
   * every file exactly once with no coordination between them. Combine
   * the shards' checkpoint files with the `aggregate` command afterward. */
  shard?: ShardOptions;
  /** Keep a persistent `tsc --watch` running for the whole run and wait
   * for it to settle after each mutant instead of paying for a clean
   * rebuild via `testCommand`. `testCommand` must NOT itself rebuild in
   * this mode — see `IncrementalBuildOptions` and `TscWatcher`. */
  incrementalBuild?: IncrementalBuildOptions;
  /** Run mutants concurrently across N isolated repo copies instead of
   * one at a time in `root`. See `worker-pool.ts`. Composes with
   * `--impact` (each slot's impacted-test command runs in that slot) and
   * `--checkpoint`/`--shard` (checkpoint writes are safe under this
   * concurrency model — see the note on `runPool` below). */
  parallel?: ParallelOptions;
  /** Extra attempts for any mutant whose first result is "Killed", to
   * distinguish a real kill from a flaky, mutation-unrelated test
   * failure. 0 (default) preserves the original single-attempt
   * behavior exactly. See mutate.ts's RetryOptions for why only
   * "Killed" is re-checked. */
  flakyRetries?: number;
  onProgress?: (msg: string) => void;
}

/**
 * Sample `filesPerStrategy` files under each strategy's top ranking,
 * generate up to `mutantsPerFile` mutants per file, run the real test
 * command against each, and report kill rate + a 95% Wilson interval
 * per strategy.
 *
 * A HIGHER kill rate for a strategy's sample means that strategy is
 * surfacing files that were already well-tested — i.e. wasting mutation
 * budget. For a *prioritization* tool the interesting comparison is the
 * INVERSE: which strategy's top-ranked files have the LOWEST kill rate
 * (most likely to hide a real gap) at fixed sample size. This function
 * reports raw kill rates and intervals per strategy; the CLI prints both
 * readings so you draw your own conclusion instead of trusting a canned
 * interpretation.
 *
 * If `opts.impact` is set, each mutant is tested against only the test
 * files that transitively import its file (via `computeImpactedTests`)
 * instead of the full `testCommand` — much faster on a real repo. When
 * no test file can be statically linked to a mutated file, it falls back
 * to the full `testCommand` for that mutant rather than skipping it or
 * guessing, and the fallback count is reported so you know how much of
 * the run used the full suite anyway.
 */
export async function validate(opts: ValidateOptions): Promise<ValidateReport> {
  const { root, entry, testCommand, strategies, filesPerStrategy, mutantsPerFile, timeoutMs, scope, impact, checkpointPath, shard, incrementalBuild, parallel, onProgress } = opts;
  const log = onProgress ?? (() => {});

  let watcher: TscWatcher | null = null;
  let pool: WorkerPool | null = null;

  if (parallel && parallel.workers > 1) {
    log(`Snapshotting ${root} into ${parallel.workers} isolated worker copies...`);
    pool = await createWorkerPool({
      root,
      count: parallel.workers,
      incrementalBuild,
      onProgress: log,
    });
    log(`${parallel.workers} worker(s) ready.`);
  } else if (incrementalBuild) {
    log(`Starting persistent tsc --watch (${incrementalBuild.tsconfigPath ?? "tsconfig.json"}) — waiting for the initial build to settle...`);
    watcher = new TscWatcher({ root, tsconfigPath: incrementalBuild.tsconfigPath, onOutput: (t) => log(`[tsc --watch] ${t.trim()}`) });
    await watcher.start(incrementalBuild.startTimeoutMs ?? 60000);
    log("Initial build settled — mutants will wait for incremental recompiles instead of rebuilding from scratch.");
  }

  try {
    return await runValidate(opts, log, watcher, pool);
  } finally {
    await watcher?.stop();
    await pool?.destroy();
  }
}

interface MutantJob {
  rf: RankedFile;
  m: Mutant;
  cmdForFile: string;
  key: string;
}

async function runValidate(
  opts: ValidateOptions,
  log: (msg: string) => void,
  watcher: TscWatcher | null,
  pool: WorkerPool | null
): Promise<ValidateReport> {
  const { root, entry, testCommand, strategies, filesPerStrategy, mutantsPerFile, timeoutMs, scope, impact, coverage, checkpointPath, shard, flakyRetries } = opts;

  const priorRecords = checkpointPath ? readCheckpoint(checkpointPath) : [];
  const doneKeys = checkpointKeySet(priorRecords);
  const originals = checkpointPath ? readOriginals(checkpointPath) : new Map<string, string>();

  let baselinePassed: boolean;
  if (checkpointPath && priorRecords.length > 0) {
    log(`Checkpoint at ${checkpointPath} already has ${priorRecords.length} recorded outcome(s) — skipping baseline reconfirmation (a prior run in this tree already passed it) and resuming.`);
    baselinePassed = true;
  } else {
    log("Confirming baseline test suite passes clean...");
    baselinePassed = await confirmBaseline(testCommand, root, Math.max(timeoutMs * 3, 30000));
  }
  if (!baselinePassed) {
    return {
      root,
      entry,
      testCommand,
      filesPerStrategy,
      mutantsPerFile,
      baselinePassed: false,
      strategies: [],
      impactStats: null,
      coverageStats: null,
      verdict:
        "Baseline test suite does not pass clean in this working tree. Aborting — " +
        "mutation results would be meaningless against a failing baseline.",
    };
  }

  const graph = buildGraph(root, entry, scope);
  let impactGraph: ImpactGraph | null = null;
  let mutantsWithImpactedTests = 0;
  let mutantsFallenBack = 0;
  let mutantsNarrowedByIdentifier = 0;
  if (impact) {
    log("Building test-impact graph (source + test files)...");
    impactGraph = buildImpactGraph(root, entry);
  }

  let coverageIndex: CoverageIndex | null = null;
  let coverageTestFileCount = 0;
  let mutantsWithCoverageMatch = 0;
  let mutantsSkippedNoCoverage = 0;
  let mutantsUninstrumented = 0;
  if (coverage) {
    // Reuse the impact graph's file listing if we already built one (same
    // whole-repo scan either way); otherwise build just enough of it to
    // find test files, without needing the resolved import edges impact
    // mode uses.
    const fileList = impactGraph ? impactGraph.files : buildImpactGraph(root, entry).files;
    const testFiles = fileList.filter((f) => isTestFile(f));
    coverageTestFileCount = testFiles.length;
    log(`Building real coverage index from ${testFiles.length} test file(s) (one instrumented run each)...`);
    coverageIndex = await buildCoverageIndex(root, coverage.testFileCmdTemplate, testFiles, timeoutMs, log);
    if (coverageIndex.failedTestFiles.length > 0) {
      log(`[coverage] ${coverageIndex.failedTestFiles.length} test file(s) exited nonzero while building the index (coverage collected up to that point is still used): ${coverageIndex.failedTestFiles.join(", ")}`);
    }
  }

  const results: StrategyResult[] = [];

  for (const strategy of strategies) {
    let ranked = rank(graph.perFile, strategy).slice(0, filesPerStrategy);
    if (shard) {
      ranked = ranked.filter((_, i) => i % shard.total === shard.index);
    }
    const priorForStrategy = priorRecords.filter((r) => r.strategy === strategy);
    const outcomes: MutantOutcome[] = [...priorForStrategy.map((r) => ({ file: r.file, line: r.line, kind: r.kind, status: r.status }))];
    let errors = priorForStrategy.filter((r) => r.status === "Error").length;
    const jobs: MutantJob[] = [];

    const recordOutcome = (key: string, file: string, start: number, line: number, kind: string, outcome: MutantOutcome) => {
      outcomes.push(outcome);
      if (checkpointPath) {
        appendCheckpointLine(checkpointPath, { type: "outcome", strategy, file, start, line, kind, status: outcome.status });
        doneKeys.add(key);
      }
    };

    for (const rf of ranked) {
      const absPath = join(root, rf.file);
      let src: string;
      try {
        src = readFileSync(absPath, "utf-8");
      } catch {
        errors++;
        continue;
      }

      if (checkpointPath) {
        const known = originals.get(rf.file);
        if (known !== undefined) {
          // A prior crash may have left this file mutated on disk (a
          // SIGKILL can't be caught, so runOneMutant's revert-in-finally
          // never ran). Restoring is idempotent — a no-op if nothing was
          // actually corrupted — so it always happens, not just when a
          // difference is detected, to avoid trusting disk state at all.
          // (In `pool` mode this file is never actually mutated — mutants
          // land in the worker copies instead — so this is a no-op here,
          // kept only so the checkpoint's "original" records stay
          // consistent whether or not a run happens to use --workers.)
          if (src !== known) writeFileSync(absPath, known, "utf-8");
          src = known;
        } else {
          appendCheckpointLine(checkpointPath, { type: "original", file: rf.file, content: src });
          originals.set(rf.file, src);
        }
      }

      const candidates = findMutants(src, rf.file);
      if (!candidates.length) continue;

      let fallbackCmdForFile = testCommand;
      const sampled = pickEvenly(candidates, mutantsPerFile);
      const anyNotDone = sampled.some((m) => !doneKeys.has(checkpointKey({ strategy, file: rf.file, start: m.start, kind: m.kind })));

      if (impact && impactGraph && anyNotDone) {
        let impactedTests = computeImpactedTests(impactGraph, rf.file);
        if (impact.narrowByIdentifier && impactedTests.length) {
          const narrowed = narrowImpactedTestsByIdentifier(impactGraph, rf.file, impactedTests);
          if (narrowed.length < impactedTests.length) {
            mutantsNarrowedByIdentifier += 1;
            log(`[${strategy}] ${rf.file}: narrowed impacted tests from ${impactedTests.length} to ${narrowed.length} by exported-name match`);
          }
          impactedTests = narrowed;
        }
        if (impactedTests.length) {
          fallbackCmdForFile = buildImpactedTestCommand(impact.testFileCmdTemplate, impactedTests);
          mutantsWithImpactedTests += 1;
          log(`[${strategy}] ${rf.file}: impacted tests = ${impactedTests.join(", ")}`);
        } else {
          mutantsFallenBack += 1;
          log(`[${strategy}] ${rf.file}: no impacted tests found statically — falling back to full suite`);
        }
      }

      for (const m of sampled) {
        const key = checkpointKey({ strategy, file: rf.file, start: m.start, kind: m.kind });
        if (doneKeys.has(key)) {
          continue; // already in outcomes via priorForStrategy above
        }

        let cmdForFile = fallbackCmdForFile;
        if (coverageIndex) {
          const coveringTests = computeCoverageImpactedTests(coverageIndex, rf.file, m.start);
          if (coveringTests === null) {
            mutantsUninstrumented += 1; // no coverage data at all -> use fallbackCmdForFile as-is
          } else if (coveringTests.length === 0) {
            mutantsSkippedNoCoverage += 1;
            log(`[${strategy}] ${rf.file}:${m.line} [${m.kind}]: no test's real coverage reaches this exact offset — Survived (skipped, no test run)`);
            recordOutcome(key, rf.file, m.start, m.line, m.kind, { file: rf.file, line: m.line, kind: m.kind, status: "Survived" });
            continue;
          } else {
            mutantsWithCoverageMatch += 1;
            cmdForFile = buildImpactedTestCommand(coverage!.testFileCmdTemplate, coveringTests);
          }
        }

        jobs.push({ rf, m, cmdForFile, key });
      }
    }

    const retryOpts: RetryOptions | undefined = flakyRetries && flakyRetries > 0 ? { retries: flakyRetries } : undefined;

    if (pool) {
      await runPool(jobs, pool.slots, async (job, slot) => {
        log(`[${strategy}] (worker ${slot.id}) ${job.rf.file}:${job.m.line} [${job.m.kind}]`);
        const absPath = join(slot.dirAbs, job.rf.file);
        const slotRetry: RetryOptions | undefined = retryOpts ? { ...retryOpts, env: slot.env } : undefined;
        const outcome = await runOneMutant(absPath, job.rf.file, job.m, job.cmdForFile, slot.dirAbs, timeoutMs, slot.watcher ?? undefined, slotRetry);
        if (outcome.status === "Flaky") log(`[${strategy}] (worker ${slot.id}) ${job.rf.file}:${job.m.line}: FLAKY across attempts ${JSON.stringify(outcome.attempts)}`);
        recordOutcome(job.key, job.rf.file, job.m.start, job.m.line, job.m.kind, outcome);
        return outcome;
      });
    } else {
      for (const job of jobs) {
        log(`[${strategy}] ${job.rf.file}:${job.m.line} [${job.m.kind}]`);
        const absPath = join(root, job.rf.file);
        const outcome = await runOneMutant(absPath, job.rf.file, job.m, job.cmdForFile, root, timeoutMs, watcher ?? undefined, retryOpts);
        if (outcome.status === "Flaky") log(`[${strategy}] ${job.rf.file}:${job.m.line}: FLAKY across attempts ${JSON.stringify(outcome.attempts)}`);
        recordOutcome(job.key, job.rf.file, job.m.start, job.m.line, job.m.kind, outcome);
      }
    }

    results.push(buildStrategyResult(strategy, ranked.length, outcomes, errors));
  }

  const verdict = summarize(results);
  return {
    root,
    entry,
    testCommand,
    filesPerStrategy,
    mutantsPerFile,
    baselinePassed: true,
    strategies: results,
    verdict,
    impactStats: impact
      ? {
          mutantsWithImpactedTests,
          mutantsFallenBack,
          dynamicRequireFileCount: impactGraph?.dynamicRequireFiles.length ?? 0,
          dynamicImportFileCount: impactGraph?.dynamicImportFiles.length ?? 0,
          mutantsNarrowedByIdentifier,
        }
      : null,
    coverageStats: coverageIndex
      ? {
          testFiles: coverageTestFileCount,
          instrumentedFiles: coverageIndex.byFile.size,
          failedTestFiles: coverageIndex.failedTestFiles.length,
          mutantsWithCoverageMatch,
          mutantsSkippedNoCoverage,
          mutantsUninstrumented,
        }
      : null,
  };
}

/** Build a StrategyResult from a flat outcome list — shared by a live
 * `validate` run and `aggregateFromRecords` (which reconstructs the same
 * shape from one or more checkpoint files with no live run at all). */
export function buildStrategyResult(strategy: Strategy, filesTried: number, outcomes: MutantOutcome[], errors: number): StrategyResult {
  const killed = outcomes.filter((o) => o.status === "Killed").length;
  const survived = outcomes.filter((o) => o.status === "Survived").length;
  const flaky = outcomes.filter((o) => o.status === "Flaky").length;
  // Flaky mutants are excluded from n (and so from killRate/its CI) —
  // they asserted nothing about whether the mutation was actually
  // caught, and folding them into either bucket would bias the rate in
  // whichever direction they happened to land.
  const n = outcomes.length - flaky;
  return {
    strategy,
    filesTried,
    mutants: n,
    killed,
    survived,
    errors,
    flaky,
    killRate: n ? round4(killed / n) : null,
    killRateCI95: n ? wilsonInterval(killed, n) : null,
    sufficientSample: n >= MIN_MUTANTS_FOR_COMPARISON,
    outcomes,
  };
}

/**
 * Recompute a full report's strategy results and verdict purely from one or
 * more checkpoint files' records — no live run, no test command, no repo
 * needed. This is what `aggregate` uses to combine several shards' output
 * (or just to re-print a finished run's summary from its checkpoint alone).
 */
export function aggregateFromRecords(records: OutcomeRecord[]): { strategies: StrategyResult[]; verdict: string } {
  const byStrategy = new Map<string, OutcomeRecord[]>();
  for (const r of records) {
    const list = byStrategy.get(r.strategy) ?? [];
    list.push(r);
    byStrategy.set(r.strategy, list);
  }
  const results: StrategyResult[] = [];
  for (const [strategy, recs] of byStrategy) {
    const outcomes: MutantOutcome[] = recs.map((r) => ({ file: r.file, line: r.line, kind: r.kind, status: r.status }));
    const filesTried = new Set(recs.map((r) => r.file)).size;
    const errors = recs.filter((r) => r.status === "Error").length;
    results.push(buildStrategyResult(strategy as Strategy, filesTried, outcomes, errors));
  }
  return { strategies: results, verdict: summarize(results) };
}

/** Exported so `precommit.ts` can sample mutants the same way `validate`
 * does, without duplicating the "evenly spread across the candidate list"
 * logic. */
export function pickEvenly<T>(arr: T[], n: number): T[] {
  if (arr.length <= n) return arr;
  const step = arr.length / n;
  const out: T[] = [];
  for (let i = 0; i < n; i++) out.push(arr[Math.floor(i * step)]);
  return out;
}

function round4(x: number): number {
  return Math.round(x * 10000) / 10000;
}

export function summarize(results: StrategyResult[]): string {
  const withRates = results.filter((r) => r.killRate !== null && r.killRateCI95 !== null);
  if (withRates.length < 2) {
    return "Not enough strategies with mutants to compare. Try a larger sample (--files-per-strategy).";
  }

  const tooSmall = withRates.filter((r) => !r.sufficientSample);
  const smallSampleNote = tooSmall.length
    ? ` Note: ${tooSmall.map((r) => `"${r.strategy}" (n=${r.mutants})`).join(", ")} ` +
      `${tooSmall.length === 1 ? "has" : "have"} fewer than ${MIN_MUTANTS_FOR_COMPARISON} mutants — ` +
      `${tooSmall.length === 1 ? "its interval is" : "their intervals are"} wide enough that this run barely constrains ${tooSmall.length === 1 ? "it" : "them"}.`
    : "";

  const sorted = [...withRates].sort((a, b) => (a.killRate as number) - (b.killRate as number));
  const lowest = sorted[0];
  const highest = sorted[sorted.length - 1];
  const lowestCI = lowest.killRateCI95 as Interval;
  const highestCI = highest.killRateCI95 as Interval;
  const distinguishable = intervalsDisjoint(lowestCI, highestCI);

  const headline = distinguishable
    ? `"${lowest.strategy}" (${pct(lowest.killRate)}, 95% CI ${ciStr(lowestCI)}) had a kill rate whose interval ` +
      `does NOT overlap "${highest.strategy}"'s (${pct(highest.killRate)}, 95% CI ${ciStr(highestCI)}) — at this ` +
      `sample size that's a real difference, not just noise, on this run.`
    : `"${lowest.strategy}" (${pct(lowest.killRate)}, 95% CI ${ciStr(lowestCI)}) and "${highest.strategy}" ` +
      `(${pct(highest.killRate)}, 95% CI ${ciStr(highestCI)}) have OVERLAPPING confidence intervals — at this ` +
      `sample size the difference between them is not statistically distinguishable from noise. Don't read the ` +
      `raw percentages as a ranking; increase --mutants-per-file or --files-per-strategy to narrow the intervals.`;

  return (
    `On THIS repo and THIS sample (not a controlled experiment — treat as directional even when distinguishable): ` +
    `${headline}${smallSampleNote} A lower kill rate means that strategy's top-ranked files had more surviving ` +
    `mutants relative to sample size — i.e. it's the strategy more likely to be pointing a mutation budget at ` +
    `under-tested code, if the difference holds up. The source study found this pattern was NOT consistent across ` +
    `4 unrelated repos for distFromEntry, and fan-out only replicated in 1 of 3 repos where it was tested — so ` +
    `even a statistically clean result here is one more data point, not proof it generalizes.`
  );
}

function pct(x: number | null): string {
  return x === null ? "n/a" : `${(x * 100).toFixed(1)}%`;
}

function ciStr(ci: Interval): string {
  return `[${(ci.low * 100).toFixed(1)}%, ${(ci.high * 100).toFixed(1)}%]`;
}
