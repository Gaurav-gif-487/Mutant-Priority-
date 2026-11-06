#!/usr/bin/env node
import { Command } from "commander";
import { writeFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildGraph } from "./graph.js";
import { rank, type Strategy } from "./rank.js";
import { validate, aggregateFromRecords, type ValidateReport } from "./validate.js";
import { writeStrykerConfig } from "./stryker.js";
import { readCheckpoint } from "./checkpoint.js";
import { detectTestCommand, detectEntry } from "./detect.js";
import { renderHtmlReport, renderMarkdownSummary } from "./report.js";
import { getStagedFiles } from "./git.js";
import { runPrecommitCheck } from "./precommit.js";

const program = new Command();

program
  .name("mutant-priority")
  .description(
    "Evidence-grounded mutant/test prioritization for JS/TS repos.\n" +
      "Default ranking is by fan-out (low first), not by nesting depth — " +
      "see `mutant-priority validate` to check whether that holds on your repo."
  )
  .version("0.1.0");

program
  .command("rank")
  .description("Rank source files by prioritization strategy (default: fanOut).")
  .argument("<root>", "repo root to scan")
  .option("--entry <path>", "entry file, relative to root (e.g. src/index.ts). Auto-detected from package.json (main/module/exports) or a conventional path if omitted.")
  .option("--strategy <name>", "fanOut | fanIn | distFromEntry | random", "fanOut")
  .option("--top <n>", "print only the top N files", (v) => parseInt(v, 10))
  .option("--json <path>", "write full ranked JSON to this path")
  .option("--stryker-glob <path>", "write a JSON array of file globs (priority order) for Stryker's `mutate` option")
  .option("--scope <dir>", "restrict the graph to files under this directory (relative to root), e.g. src or lib — imports outside it are treated as external")
  .option(
    "--staged",
    "only print files currently staged for commit (`git diff --cached`) — metrics are still computed from the " +
      "whole repo graph, this just filters which rows are shown. Handy as a quick pre-commit view; see the " +
      "`precommit` command to actually run mutants against staged files."
  )
  .action((rootArg, opts) => {
    const root = resolve(rootArg);
    const entry = resolveEntry(root, opts.entry);
    if (!entry) return;
    const graph = buildGraph(root, entry, opts.scope);
    let ranked = rank(graph.perFile, opts.strategy as Strategy);
    if (opts.staged) {
      const staged = new Set(getStagedFiles(root));
      ranked = ranked.filter((f) => staged.has(f.file));
      if (ranked.length === 0) {
        console.log("No staged files match this repo's tracked source graph (nothing staged, or only test/non-JS-TS files staged).");
        return;
      }
    }
    const shown = opts.top ? ranked.slice(0, opts.top) : ranked;

    console.log(`${graph.files.length} files, ${graph.edges.length} resolved internal edges, ${graph.unresolved.length} unresolved imports`);
    console.log(`Strategy: ${opts.strategy}\n`);
    console.log(pad("rank", 5) + pad("fanIn", 7) + pad("fanOut", 7) + pad("depth", 7) + "file");
    for (const f of shown) {
      console.log(
        pad(String(f.rank), 5) +
          pad(String(f.fanIn), 7) +
          pad(String(f.fanOut), 7) +
          pad(String(f.distFromEntry ?? "-"), 7) +
          f.file
      );
    }

    if (opts.json) {
      writeFileSync(opts.json, JSON.stringify({ root, entry, strategy: opts.strategy, ranked }, null, 2));
      console.log(`\nWrote full ranking to ${opts.json}`);
    }
    if (opts.strykerGlob) {
      writeFileSync(opts.strykerGlob, JSON.stringify(ranked.map((f) => f.file), null, 2));
      console.log(`Wrote priority-ordered file list to ${opts.strykerGlob} (feed into Stryker's "mutate" array, or slice the front N for a budget-limited run)`);
    }
  });

program
  .command("validate")
  .description(
    "Actually run a small real mutation-testing sample under each strategy's top-ranked files, " +
      "and report which strategy finds the most under-tested code on YOUR repo. Executes your real test command."
  )
  .argument("<root>", "repo root to scan")
  .option("--entry <path>", "entry file, relative to root. Auto-detected from package.json (main/module/exports) or a conventional path if omitted.")
  .option(
    "--test-cmd <cmd>",
    "shell command that runs the repo's test suite, e.g. \"npm test\". If omitted, auto-detected from " +
      "package.json's scripts.test (run as `npm test` so pre/posttest hooks still fire); fails with an " +
      "error telling you to pass it explicitly if nothing usable is found."
  )
  .option("--strategies <list>", "comma-separated: fanOut,distFromEntry,fanIn,random", "fanOut,distFromEntry,random")
  .option("--files-per-strategy <n>", "how many top-ranked files to sample per strategy", (v) => parseInt(v, 10), 5)
  .option("--mutants-per-file <n>", "max mutants per sampled file", (v) => parseInt(v, 10), 2)
  .option("--timeout-ms <n>", "per-test-run timeout in ms", (v) => parseInt(v, 10), 20000)
  .option("--json <path>", "write full report JSON to this path")
  .option(
    "--impact",
    "run only the test files that transitively import each mutated file, instead of the full suite " +
      "(falls back to the full suite per-mutant when no test file can be statically linked). Requires --test-file-cmd."
  )
  .option(
    "--test-file-cmd <template>",
    "shell command template for --impact mode; must contain {files}, e.g. \"npx mocha {files}\" or \"node --test {files}\""
  )
  .option(
    "--narrow-by-identifier",
    "with --impact, further narrow each mutant's impacted-test list to test files that reference the mutated " +
      "file's exported names (best-effort text match). Only ever shrinks the list, and only when the shrink is " +
      "non-empty — falls back to the plain file-level --impact list otherwise. Off by default."
  )
  .option(
    "--coverage",
    "sound, per-MUTANT test selection from REAL execution data: builds a coverage index up front (one " +
      "instrumented run per test file via NODE_V8_COVERAGE), then for each mutant runs only the tests whose " +
      "actual coverage includes that exact offset. A mutant no test executes is reported Survived immediately, " +
      "without spawning a test process. Strictly sounder than --impact/--narrow-by-identifier (both static); " +
      "falls back to --impact's answer, then the full suite, for anything the index has no data for. Requires " +
      "--test-file-cmd (same template as --impact)."
  )
  .option(
    "--flaky-retries <n>",
    "re-run a mutant up to n extra times when its first result is \"Killed\", to catch a flaky test failure being " +
      "mistaken for a caught mutation. Mutants whose retries disagree are reported separately as \"Flaky\" and " +
      "excluded from the kill-rate calculation. Default 0 (no retries, original single-attempt behavior).",
    (v) => parseInt(v, 10),
    0
  )
  .option("--scope <dir>", "restrict the graph to files under this directory (relative to root), e.g. src or lib")
  .option(
    "--checkpoint <path>",
    "JSON-lines file recording each mutant's outcome as it completes. If it already has records " +
      "(from a prior run that crashed or was killed), matching mutants are skipped and the baseline " +
      "check is skipped too — this is what makes a long run resumable."
  )
  .option(
    "--shard <i/n>",
    'process only every nth file of each strategy\'s ranked list, e.g. "0/4" for shard 0 of 4. ' +
      "Run all n shards (each with its own --checkpoint file) to cover every file with no overlap, " +
      "then combine with the `aggregate` command."
  )
  .option(
    "--tsc-watch",
    "keep a persistent `tsc --watch` running for the whole run and wait for it to settle after each " +
      "mutant, instead of paying for a clean rebuild via --test-cmd. --test-cmd must be the test-runner " +
      "invocation ONLY in this mode (no build step) — e.g. \"mocha dist/**/*.test.js\", not " +
      "\"npm run build && mocha ...\" — since the watcher is what keeps dist/ current now."
  )
  .option("--tsconfig <path>", "tsconfig to watch under --tsc-watch, relative to root", "tsconfig.json")
  .option(
    "--workers <n>",
    "run N mutants concurrently, each against its own isolated snapshot of the repo (a temp-directory " +
      "copy with node_modules symlinked back in, NOT `git worktree`) instead of one at a time in root. " +
      "Composes with --tsc-watch (each worker gets its own persistent tsc --watch). Default 1 (sequential, " +
      "in root, unchanged from before this option existed).",
    (v) => parseInt(v, 10),
    1
  )
  .option("--report <path.html>", "write a self-contained, shareable HTML report (charts-free, no build step to view — open it in a browser)")
  .option("--markdown <path.md>", "write a compact Markdown summary (PR comment / GitHub Actions job summary sized) alongside --report")
  .action(async (rootArg, opts) => {
    const root = resolve(rootArg);
    const entry = resolveEntry(root, opts.entry);
    if (!entry) return;
    const strategies = opts.strategies.split(",").map((s: string) => s.trim()) as Strategy[];

    let testCommand: string = opts.testCmd;
    if (!testCommand) {
      const detected = detectTestCommand(root);
      if (!detected) {
        console.error(
          "No --test-cmd given and none could be auto-detected (no package.json, no scripts.test, " +
            'or it\'s just the npm-init placeholder). Pass --test-cmd "<shell command>" explicitly.'
        );
        process.exitCode = 1;
        return;
      }
      testCommand = detected.command;
      console.log(`No --test-cmd given — auto-detected from ${detected.source}, running as: ${detected.command}`);
    }

    if (opts.impact && !opts.testFileCmd) {
      console.error("--impact requires --test-file-cmd \"<template with {files}>\"");
      process.exitCode = 1;
      return;
    }
    if (opts.coverage && !opts.testFileCmd) {
      console.error("--coverage requires --test-file-cmd \"<template with {files}>\"");
      process.exitCode = 1;
      return;
    }
    if (opts.testFileCmd && !opts.testFileCmd.includes("{files}")) {
      console.error('--test-file-cmd template must contain the literal "{files}" placeholder');
      process.exitCode = 1;
      return;
    }
    let shard: { index: number; total: number } | undefined;
    if (opts.shard) {
      const m = /^(\d+)\/(\d+)$/.exec(opts.shard);
      if (!m || parseInt(m[1], 10) >= parseInt(m[2], 10)) {
        console.error('--shard must look like "i/n" with 0 <= i < n, e.g. "0/4"');
        process.exitCode = 1;
        return;
      }
      shard = { index: parseInt(m[1], 10), total: parseInt(m[2], 10) };
    }
    if (opts.workers < 1) {
      console.error("--workers must be at least 1");
      process.exitCode = 1;
      return;
    }

    const report = await validate({
      root,
      entry,
      testCommand,
      strategies,
      filesPerStrategy: opts.filesPerStrategy,
      mutantsPerFile: opts.mutantsPerFile,
      timeoutMs: opts.timeoutMs,
      scope: opts.scope,
      impact: opts.impact ? { testFileCmdTemplate: opts.testFileCmd, narrowByIdentifier: !!opts.narrowByIdentifier } : undefined,
      coverage: opts.coverage ? { testFileCmdTemplate: opts.testFileCmd } : undefined,
      checkpointPath: opts.checkpoint,
      shard,
      incrementalBuild: opts.tscWatch ? { tsconfigPath: opts.tsconfig } : undefined,
      parallel: opts.workers > 1 ? { workers: opts.workers } : undefined,
      flakyRetries: opts.flakyRetries,
      onProgress: (msg) => console.log(msg),
    });

    if (!report.baselinePassed) {
      console.error("\n" + report.verdict);
      process.exitCode = 1;
      return;
    }

    console.log("\n=== Results ===");
    for (const s of report.strategies) {
      const ci = s.killRateCI95 ? ` 95% CI [${(s.killRateCI95.low * 100).toFixed(1)}%, ${(s.killRateCI95.high * 100).toFixed(1)}%]` : "";
      const flag = s.mutants > 0 && !s.sufficientSample ? "  (small sample)" : "";
      const flakyNote = s.flaky > 0 ? `  (${s.flaky} flaky, excluded)` : "";
      console.log(
        `${s.strategy}: ${s.killed}/${s.mutants} killed (${s.killRate !== null ? (s.killRate * 100).toFixed(1) + "%" : "n/a"})${ci} across ${s.filesTried} files${flag}${flakyNote}`
      );
    }
    console.log("\n" + report.verdict);
    if (report.impactStats) {
      console.log(
        `\n[--impact] ${report.impactStats.mutantsWithImpactedTests} file(s) ran against a narrowed test set; ` +
          `${report.impactStats.mutantsFallenBack} fell back to the full suite (no test statically linked).`
      );
      if (report.impactStats.mutantsNarrowedByIdentifier > 0) {
        console.log(
          `[--impact --narrow-by-identifier] ${report.impactStats.mutantsNarrowedByIdentifier} file(s) had their ` +
            `impacted-test list further narrowed by exported-name match.`
        );
      }
      if (report.impactStats.dynamicRequireFileCount > 0) {
        console.log(
          `[--impact] note: ${report.impactStats.dynamicRequireFileCount} file(s) in this repo contain a ` +
            `dynamically-constructed require() (e.g. require(expr) instead of require('literal')) — ` +
            `these are invisible to this graph and can explain fallbacks beyond genuinely untested code.`
        );
      }
      if (report.impactStats.dynamicImportFileCount > 0) {
        console.log(
          `[--impact] note: ${report.impactStats.dynamicImportFileCount} file(s) in this repo contain a ` +
            `dynamically-constructed import() (e.g. import(expr) instead of import('literal')) — same caveat ` +
            `as the require() note above, for the ES dynamic-import form.`
        );
      }
    }
    if (report.coverageStats) {
      const cs = report.coverageStats;
      console.log(
        `\n[--coverage] index built from ${cs.testFiles} test file(s), ${cs.instrumentedFiles} source file(s) ` +
          `with real coverage data${cs.failedTestFiles > 0 ? ` (${cs.failedTestFiles} test file(s) errored while building the index — coverage up to the error was still used)` : ""}.`
      );
      console.log(
        `[--coverage] ${cs.mutantsWithCoverageMatch} mutant(s) narrowed to real covering test(s); ` +
          `${cs.mutantsSkippedNoCoverage} skipped outright as Survived (zero real coverage at that exact offset); ` +
          `${cs.mutantsUninstrumented} had no coverage data at all and used the --impact/full-suite fallback.`
      );
    }

    if (opts.json) {
      writeFileSync(opts.json, JSON.stringify(report, null, 2));
      console.log(`\nWrote full report to ${opts.json}`);
    }
    if (opts.report) {
      writeFileSync(opts.report, renderHtmlReport(report));
      console.log(`Wrote HTML report to ${opts.report}`);
    }
    if (opts.markdown) {
      writeFileSync(opts.markdown, renderMarkdownSummary(report, { htmlReportPath: opts.report }));
      console.log(`Wrote Markdown summary to ${opts.markdown}`);
    }
  });

program
  .command("stryker")
  .description(
    "Write/patch a stryker.conf.json's `mutate` array in priority order. NOT a Stryker plugin — " +
      "this edits Stryker's own config file so Stryker (which you still run yourself) mutates " +
      "under-tested-looking files first. Use --budget to slice to a fixed-size run."
  )
  .argument("<root>", "repo root")
  .option("--entry <path>", "entry file, relative to root. Auto-detected from package.json (main/module/exports) or a conventional path if omitted.")
  .option("--strategy <name>", "fanOut | fanIn | distFromEntry | random", "fanOut")
  .option("--budget <n>", "only include the top N files in `mutate` (omit for all files)", (v) => parseInt(v, 10))
  .option("--config <path>", "path to stryker.conf.json to write/patch (relative to root)", "stryker.conf.json")
  .option("--scope <dir>", "restrict the graph to files under this directory (relative to root)")
  .action((rootArg, opts) => {
    const root = resolve(rootArg);
    const entry = resolveEntry(root, opts.entry);
    if (!entry) return;
    const configPath = resolve(root, opts.config);
    const result = writeStrykerConfig({
      root,
      entry,
      strategy: opts.strategy as Strategy,
      budget: opts.budget,
      configPath,
      scope: opts.scope,
    });
    console.log(
      `${result.created ? "Created" : "Patched"} ${opts.config}: mutate = ${result.mutateCount} of ${result.totalFiles} files (strategy: ${result.strategy}).`
    );
    if (opts.budget) {
      console.log(`Budget-limited to the top ${opts.budget} files by ${result.strategy} priority.`);
    }
    console.log(`Run \`stryker run\` (or \`npx stryker run\`) as usual — this only edited the config's "mutate" list.`);
  });

program
  .command("aggregate")
  .description(
    "Recompute kill rates, Wilson CIs, and the strategy verdict purely from one or more --checkpoint " +
      "files — no live run, no test command. Combine several shards' checkpoints, or just re-print a " +
      "finished run's summary."
  )
  .argument("<checkpoints...>", "one or more checkpoint file paths")
  .option("--json <path>", "write the aggregated report JSON to this path")
  .action((checkpointPaths: string[], opts) => {
    const records = checkpointPaths.flatMap((p) => readCheckpoint(p));
    if (!records.length) {
      console.error("No records found in the given checkpoint file(s).");
      process.exitCode = 1;
      return;
    }
    const { strategies, verdict } = aggregateFromRecords(records);

    console.log(`Aggregated ${records.length} outcome(s) from ${checkpointPaths.length} checkpoint file(s).\n`);
    console.log("=== Results ===");
    for (const s of strategies) {
      const ci = s.killRateCI95 ? ` 95% CI [${(s.killRateCI95.low * 100).toFixed(1)}%, ${(s.killRateCI95.high * 100).toFixed(1)}%]` : "";
      const flag = s.mutants > 0 && !s.sufficientSample ? "  (small sample)" : "";
      console.log(
        `${s.strategy}: ${s.killed}/${s.mutants} killed (${s.killRate !== null ? (s.killRate * 100).toFixed(1) + "%" : "n/a"})${ci} across ${s.filesTried} files${flag}`
      );
    }
    console.log("\n" + verdict);

    if (opts.json) {
      writeFileSync(opts.json, JSON.stringify({ strategies, verdict }, null, 2));
      console.log(`\nWrote aggregated report to ${opts.json}`);
    }
  });

program
  .command("report")
  .description(
    "Turn a saved `validate --json` report back into an HTML report and/or a Markdown summary, without " +
      "re-running anything. Useful in CI: run `validate --json` once, then generate whichever artifact " +
      "shape each step needs (HTML for an uploaded artifact, Markdown for a PR comment or job summary)."
  )
  .argument("<jsonPath>", "path to a JSON file written by `validate --json`")
  .option("--html <path>", "write the HTML report here")
  .option("--markdown <path>", "write the Markdown summary here (also printed to stdout if this is omitted)")
  .action((jsonPath: string, opts) => {
    let report: ValidateReport;
    try {
      report = JSON.parse(readFileSync(jsonPath, "utf-8"));
    } catch (err) {
      console.error(`Could not read/parse ${jsonPath}: ${(err as Error).message}`);
      process.exitCode = 1;
      return;
    }
    if (!opts.html && !opts.markdown) {
      // Nothing to write to disk -> default to printing the Markdown
      // summary to stdout, so `mutant-priority report x.json` is useful
      // on its own without requiring a flag just to see something.
      process.stdout.write(renderMarkdownSummary(report, { htmlReportPath: opts.html }));
      return;
    }
    if (opts.html) {
      writeFileSync(opts.html, renderHtmlReport(report));
      console.log(`Wrote HTML report to ${opts.html}`);
    }
    if (opts.markdown) {
      writeFileSync(opts.markdown, renderMarkdownSummary(report, { htmlReportPath: opts.html }));
      console.log(`Wrote Markdown summary to ${opts.markdown}`);
    }
  });

program
  .command("precommit")
  .description(
    "Mutation-test ONLY the files currently staged for commit (`git diff --cached`), sampling a few mutants per " +
      "file and failing (exit 1) if any survives. Meant to run in a pre-commit hook — see examples/pre-commit " +
      "for a husky wiring. Not a replacement for `validate`'s statistical comparison; this is a fast, per-commit " +
      "tripwire."
  )
  .argument("<root>", "repo root")
  .option("--entry <path>", "entry file, relative to root — used only for the --impact self-import special case; auto-detected if omitted and no error is raised if it can't be")
  .option("--test-cmd <cmd>", "shell command that runs the repo's test suite. Auto-detected from package.json's scripts.test if omitted.")
  .option("--mutants-per-file <n>", "max mutants sampled per staged file", (v) => parseInt(v, 10), 2)
  .option("--timeout-ms <n>", "per-test-run timeout in ms", (v) => parseInt(v, 10), 20000)
  .option(
    "--impact",
    "run only the test files that transitively import each staged file, instead of the full suite. Requires --test-file-cmd."
  )
  .option("--test-file-cmd <template>", "shell command template for --impact/--coverage mode; must contain {files}")
  .option("--narrow-by-identifier", "with --impact, further narrow by exported-name match — see `validate --narrow-by-identifier`'s description")
  .option(
    "--coverage",
    "sound, per-mutant test selection from real coverage — see `validate --coverage`'s description. Requires --test-file-cmd. " +
      "On a pre-commit hook this means one instrumented run per test file the FIRST time it's invoked in a given working tree; " +
      "weigh that against --mutants-per-file for how fast you need this hook to be."
  )
  .action(async (rootArg, opts) => {
    const root = resolve(rootArg);
    let testCommand: string = opts.testCmd;
    if (!testCommand) {
      const detected = detectTestCommand(root);
      if (!detected) {
        console.error('No --test-cmd given and none could be auto-detected. Pass --test-cmd "<shell command>" explicitly.');
        process.exitCode = 1;
        return;
      }
      testCommand = detected.command;
      console.log(`No --test-cmd given — auto-detected from ${detected.source}, running as: ${detected.command}`);
    }
    if (opts.impact && !opts.testFileCmd) {
      console.error('--impact requires --test-file-cmd "<template with {files}>"');
      process.exitCode = 1;
      return;
    }
    if (opts.coverage && !opts.testFileCmd) {
      console.error('--coverage requires --test-file-cmd "<template with {files}>"');
      process.exitCode = 1;
      return;
    }
    if (opts.testFileCmd && !opts.testFileCmd.includes("{files}")) {
      console.error('--test-file-cmd template must contain the literal "{files}" placeholder');
      process.exitCode = 1;
      return;
    }
    // --entry is optional here (unlike rank/validate/stryker): precommit
    // doesn't rank anything, so a missing/undetectable entry just means
    // the --impact self-import special case (see impact.ts) is skipped,
    // not a hard failure.
    const entry = opts.entry ?? detectEntry(root)?.file;

    const report = await runPrecommitCheck({
      root,
      entry,
      testCommand,
      mutantsPerFile: opts.mutantsPerFile,
      timeoutMs: opts.timeoutMs,
      impact: opts.impact ? { testFileCmdTemplate: opts.testFileCmd, narrowByIdentifier: !!opts.narrowByIdentifier } : undefined,
      coverage: opts.coverage ? { testFileCmdTemplate: opts.testFileCmd } : undefined,
      onProgress: (msg) => console.log(msg),
    });

    if (report.filesChecked.length === 0) {
      console.log(report.verdict);
      return;
    }

    console.log("\n=== precommit ===");
    for (const r of report.results) {
      const impactNote = r.impactedTests ? ` (impacted tests: ${r.impactedTests.join(", ")})` : "";
      console.log(`${r.file}: ${r.killed}/${r.mutants} killed${r.survived ? `, ${r.survived} SURVIVED` : ""}${impactNote}`);
    }
    console.log("\n" + report.verdict);
    if (report.coverageStats) {
      const cs = report.coverageStats;
      console.log(
        `\n[--coverage] ${cs.mutantsWithCoverageMatch} mutant(s) narrowed to real covering test(s); ` +
          `${cs.mutantsSkippedNoCoverage} skipped outright as Survived; ${cs.mutantsUninstrumented} used the fallback.`
      );
    }

    if (!report.baselinePassed || !report.passed) {
      process.exitCode = 1;
    }
  });

program.parse();

function pad(s: string, n: number): string {
  return s.length >= n ? s + " " : s + " ".repeat(n - s.length);
}

/**
 * Resolve --entry, auto-detecting from package.json / conventional paths
 * when omitted. On failure to detect, prints a clear error (setting
 * process.exitCode) and returns null — every caller must bail out when
 * this returns null rather than passing an empty string on into
 * buildGraph, which would produce a confusing downstream error instead
 * of this specific, actionable one.
 */
function resolveEntry(root: string, explicit: string | undefined): string | null {
  if (explicit) return explicit;
  const detected = detectEntry(root);
  if (!detected) {
    console.error(
      "No --entry given and none could be auto-detected (no usable package.json main/module/exports field, " +
        "and none of the conventional paths like src/index.ts exist). Pass --entry <path> explicitly."
    );
    process.exitCode = 1;
    return null;
  }
  console.log(`No --entry given — auto-detected ${detected.file} from ${detected.source}`);
  return detected.file;
}
