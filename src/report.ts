import type { ValidateReport, StrategyResult } from "./validate.js";

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function pct(n: number | null): string {
  return n === null ? "n/a" : `${(n * 100).toFixed(1)}%`;
}

function ciText(s: StrategyResult): string {
  return s.killRateCI95 ? `${pct(s.killRateCI95.low)} – ${pct(s.killRateCI95.high)}` : "—";
}

/**
 * A single self-contained HTML file (inline CSS, no external requests,
 * no build step to view it) summarizing a `validate` run: one card per
 * strategy with its kill rate and confidence interval, then a collapsible
 * per-mutant table underneath. `<details>` handles the collapsing so the
 * whole thing works with zero JavaScript.
 */
export function renderHtmlReport(report: ValidateReport): string {
  const generatedAt = new Date().toISOString();

  const cards = report.strategies
    .map((s) => {
      const rateClass = s.killRate === null ? "na" : s.killRate >= 0.7 ? "good" : s.killRate >= 0.4 ? "mid" : "low";
      const smallSampleBadge = s.mutants > 0 && !s.sufficientSample ? `<span class="badge">small sample</span>` : "";
      return `
      <div class="card">
        <div class="card-head">
          <span class="strategy-name">${escapeHtml(s.strategy)}</span>
          ${smallSampleBadge}
        </div>
        <div class="kill-rate ${rateClass}">${pct(s.killRate)}</div>
        <div class="card-row"><span>Killed</span><span>${s.killed} / ${s.mutants}</span></div>
        <div class="card-row"><span>95% CI</span><span>${ciText(s)}</span></div>
        <div class="card-row"><span>Files sampled</span><span>${s.filesTried}</span></div>
        ${s.errors ? `<div class="card-row error"><span>Errors</span><span>${s.errors}</span></div>` : ""}
      </div>`;
    })
    .join("\n");

  const tables = report.strategies
    .map((s) => {
      const rows = s.outcomes
        .map((o) => {
          const cls = o.status === "Killed" ? "killed" : o.status === "Survived" ? "survived" : "error";
          return `<tr class="${cls}"><td>${escapeHtml(o.file)}</td><td>${o.line}</td><td>${escapeHtml(o.kind)}</td><td>${o.status}</td></tr>`;
        })
        .join("\n");
      return `
      <details>
        <summary>${escapeHtml(s.strategy)} — ${s.outcomes.length} mutant(s)</summary>
        <table>
          <thead><tr><th>File</th><th>Line</th><th>Mutation</th><th>Result</th></tr></thead>
          <tbody>${rows || `<tr><td colspan="4" class="none">No mutants recorded.</td></tr>`}</tbody>
        </table>
      </details>`;
    })
    .join("\n");

  const impactBlock = report.impactStats
    ? `<p class="note">--impact: ${report.impactStats.mutantsWithImpactedTests} file(s) ran against a narrowed test set; ` +
      `${report.impactStats.mutantsFallenBack} fell back to the full suite.` +
      (report.impactStats.dynamicRequireFileCount > 0
        ? ` ${report.impactStats.dynamicRequireFileCount} file(s) use a dynamic require() invisible to this graph.`
        : "") +
      `</p>`
    : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>mutant-priority report — ${escapeHtml(report.entry)}</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; max-width: 900px; margin: 2rem auto; padding: 0 1rem; line-height: 1.5; }
  h1 { font-size: 1.4rem; margin-bottom: 0.1rem; }
  .meta { color: #666; font-size: 0.85rem; margin-bottom: 1.5rem; }
  .meta code { background: rgba(127,127,127,0.15); padding: 0.1em 0.4em; border-radius: 4px; }
  .cards { display: flex; flex-wrap: wrap; gap: 1rem; margin-bottom: 1.5rem; }
  .card { border: 1px solid rgba(127,127,127,0.3); border-radius: 10px; padding: 1rem 1.25rem; min-width: 190px; flex: 1; }
  .card-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 0.5rem; }
  .strategy-name { font-weight: 600; font-size: 1.05rem; }
  .badge { font-size: 0.7rem; background: rgba(200,150,0,0.2); color: #a66a00; padding: 0.15em 0.5em; border-radius: 999px; }
  .kill-rate { font-size: 2rem; font-weight: 700; margin-bottom: 0.5rem; }
  .kill-rate.good { color: #1a7f37; }
  .kill-rate.mid { color: #9a6700; }
  .kill-rate.low { color: #cf222e; }
  .kill-rate.na { color: #666; }
  .card-row { display: flex; justify-content: space-between; font-size: 0.85rem; color: #555; }
  .card-row.error { color: #cf222e; }
  .verdict { background: rgba(127,127,127,0.08); border-left: 4px solid #666; padding: 1rem; border-radius: 6px; margin-bottom: 1.5rem; white-space: pre-wrap; font-size: 0.9rem; }
  .note { font-size: 0.85rem; color: #666; }
  details { border: 1px solid rgba(127,127,127,0.25); border-radius: 8px; margin-bottom: 0.75rem; padding: 0.5rem 0.75rem; }
  summary { cursor: pointer; font-weight: 600; padding: 0.25rem 0; }
  table { width: 100%; border-collapse: collapse; margin-top: 0.5rem; font-size: 0.85rem; }
  th, td { text-align: left; padding: 0.35rem 0.5rem; border-bottom: 1px solid rgba(127,127,127,0.15); }
  tr.killed td:last-child { color: #1a7f37; font-weight: 600; }
  tr.survived td:last-child { color: #cf222e; font-weight: 600; }
  tr.error td:last-child { color: #9a6700; font-weight: 600; }
  td.none { color: #888; font-style: italic; }
  footer { margin-top: 2rem; font-size: 0.75rem; color: #888; }
</style>
</head>
<body>
  <h1>mutant-priority report</h1>
  <div class="meta">
    entry <code>${escapeHtml(report.entry)}</code> &middot;
    test command <code>${escapeHtml(report.testCommand)}</code> &middot;
    generated ${generatedAt}
  </div>

  <div class="cards">
    ${cards}
  </div>

  <div class="verdict">${escapeHtml(report.verdict)}</div>
  ${impactBlock}

  <h2>Mutant-level detail</h2>
  ${tables}

  <footer>Generated by mutant-priority. This is one small, disclosed sample against your real test suite — treat it as a pointer to where to spend a mutation budget, not a certification.</footer>
</body>
</html>
`;
}

/**
 * Compact Markdown summary of a validate run — sized for a PR comment or
 * a GitHub Actions job summary (`$GITHUB_STEP_SUMMARY`), not for a full
 * report. Links out to the HTML report artifact when `htmlReportPath` is
 * given, since Markdown can't render the per-mutant tables usefully.
 */
export function renderMarkdownSummary(report: ValidateReport, opts?: { htmlReportPath?: string }): string {
  const lines: string[] = [];
  lines.push(`### mutant-priority`);
  lines.push("");
  lines.push(`Entry: \`${report.entry}\` · Test command: \`${report.testCommand}\``);
  lines.push("");

  if (!report.baselinePassed) {
    lines.push(`**Baseline test suite did not pass clean — no mutation results.**`);
    lines.push("");
    lines.push(report.verdict);
    return lines.join("\n") + "\n";
  }

  lines.push(`| Strategy | Killed | Kill rate | 95% CI | Files |`);
  lines.push(`| --- | --- | --- | --- | --- |`);
  for (const s of report.strategies) {
    const flag = s.mutants > 0 && !s.sufficientSample ? " ⚠️ small sample" : "";
    lines.push(`| ${s.strategy} | ${s.killed}/${s.mutants} | ${pct(s.killRate)}${flag} | ${ciText(s)} | ${s.filesTried} |`);
  }
  lines.push("");
  lines.push("> " + report.verdict.split("\n").join("\n> "));

  if (report.impactStats) {
    lines.push("");
    lines.push(
      `_--impact: ${report.impactStats.mutantsWithImpactedTests} file(s) ran a narrowed test set, ` +
        `${report.impactStats.mutantsFallenBack} fell back to the full suite._`
    );
  }

  if (opts?.htmlReportPath) {
    lines.push("");
    lines.push(`[Full per-mutant report](${opts.htmlReportPath})`);
  }

  return lines.join("\n") + "\n";
}
