import { test } from "node:test";
import assert from "node:assert/strict";
import { renderHtmlReport, renderMarkdownSummary } from "./report.js";
import type { ValidateReport } from "./validate.js";

function makeReport(overrides?: Partial<ValidateReport>): ValidateReport {
  return {
    root: "/tmp/repo",
    entry: "src/index.ts",
    testCommand: "npm test",
    filesPerStrategy: 5,
    mutantsPerFile: 2,
    baselinePassed: true,
    strategies: [
      {
        strategy: "fanOut",
        filesTried: 2,
        mutants: 4,
        killed: 3,
        survived: 1,
        errors: 0,
        flaky: 0,
        killRate: 0.75,
        killRateCI95: { low: 0.3, high: 0.95 },
        sufficientSample: false,
        outcomes: [
          { file: "src/a.ts", line: 3, kind: "EqualityReplacement", status: "Killed" },
          { file: "src/a.ts", line: 9, kind: "BooleanLiteralSwap", status: "Survived" },
        ],
      },
    ],
    verdict: "Some verdict text here.",
    impactStats: null,
    coverageStats: null,
    ...overrides,
  };
}

test("renderHtmlReport: includes strategy name, kill rate, and entry/test command", () => {
  const html = renderHtmlReport(makeReport());
  assert.match(html, /fanOut/);
  assert.match(html, /75\.0%/);
  assert.match(html, /src\/index\.ts/);
  assert.match(html, /npm test/);
  assert.match(html, /<!DOCTYPE html>/);
});

test("renderHtmlReport: escapes HTML-significant characters from file paths and verdict", () => {
  const report = makeReport({ verdict: "A <script>alert(1)</script> verdict" });
  const html = renderHtmlReport(report);
  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /&lt;script&gt;/);
});

test("renderHtmlReport: renders killed/survived rows with distinguishing classes", () => {
  const html = renderHtmlReport(makeReport());
  assert.match(html, /tr class="killed"/);
  assert.match(html, /tr class="survived"/);
});

test("renderHtmlReport: handles a failed baseline report (empty strategies) without throwing", () => {
  const report = makeReport({ baselinePassed: false, strategies: [], verdict: "Baseline failed." });
  assert.doesNotThrow(() => renderHtmlReport(report));
});

test("renderMarkdownSummary: produces a table row per strategy with kill rate and CI", () => {
  const md = renderMarkdownSummary(makeReport());
  assert.match(md, /\| fanOut \| 3\/4 \| 75\.0% ⚠️ small sample \| 30\.0% – 95\.0% \| 2 \|/);
});

test("renderMarkdownSummary: flags a failed baseline distinctly and skips the table", () => {
  const report = makeReport({ baselinePassed: false, strategies: [], verdict: "Baseline failed." });
  const md = renderMarkdownSummary(report);
  assert.match(md, /did not pass clean/);
  assert.doesNotMatch(md, /\| Strategy \|/);
});

test("renderMarkdownSummary: links to the HTML report when a path is given", () => {
  const md = renderMarkdownSummary(makeReport(), { htmlReportPath: "mutant-report.html" });
  assert.match(md, /\[Full per-mutant report\]\(mutant-report\.html\)/);
});
