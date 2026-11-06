import { readFileSync, writeFileSync } from "node:fs";
import { exec as execCb } from "node:child_process";
import { promisify } from "node:util";
import ts from "typescript";
import type { TscWatcher } from "./incremental.js";

const exec = promisify(execCb);

/**
 * Run `command` and resolve to whether it exited 0. Async (not
 * `execSync`) is deliberate: `execSync` blocks the entire Node process
 * until it returns, which makes real concurrency impossible — you
 * cannot have two `execSync` calls "in flight" at once from one JS
 * thread no matter how many worker slots you hand them out to. `exec`
 * lets N test commands run as N genuinely concurrent child processes,
 * each awaited independently, which is what `--workers` needs.
 */
async function runShellCommand(command: string, cwd: string, timeoutMs: number, env?: NodeJS.ProcessEnv): Promise<boolean> {
  try {
    await exec(command, { cwd, timeout: timeoutMs, shell: "/bin/bash", env: env ? { ...process.env, ...env } : undefined });
    return true;
  } catch {
    return false;
  }
}

// Same disclosed-mutator-set philosophy as the source study: a fixed,
// enumerable list of operator/token-level mutations found via the
// TypeScript AST, not regex over raw lines. This means a `&&` sitting
// inside a string, comment, template literal, or regex literal is never
// touched: those never appear as BinaryExpression/token nodes in the
// parsed tree, so the walk simply never visits them. This is a
// deliberate improvement over the source study's original line-regex
// approach, which could (and occasionally did) mutate non-code text.
//
// The set has grown since the initial three kinds (boolean-literal
// inversion, equality/inequality swap, logical-connector flip) to also
// include arithmetic-operator replacement, relational-boundary
// replacement, and increment/decrement swap — still narrow and fully
// enumerated below, not "whatever a general mutation library ships."
export interface Mutant {
  start: number; // char offset into source, inclusive
  end: number; // char offset into source, exclusive
  line: number; // 1-indexed
  kind: string;
  original: string;
  replacement: string;
}

function scriptKindFor(filePath: string): ts.ScriptKind {
  if (filePath.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (filePath.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (filePath.endsWith(".ts")) return ts.ScriptKind.TS;
  return ts.ScriptKind.JS;
}

/**
 * Find mutable AST nodes in `src`. `filePath` is used only to pick a
 * parser mode (.ts/.tsx/.js/.jsx) — the file need not exist on disk.
 */
export function findMutants(src: string, filePath = "file.ts"): Mutant[] {
  const sourceFile = ts.createSourceFile(
    filePath,
    src,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    scriptKindFor(filePath)
  );
  const mutants: Mutant[] = [];

  function add(node: ts.Node, kind: string, replacement: string) {
    const start = node.getStart(sourceFile);
    const end = node.getEnd();
    const { line } = sourceFile.getLineAndCharacterOfPosition(start);
    mutants.push({ start, end, line: line + 1, kind, original: src.slice(start, end), replacement });
  }

  function isInTypePosition(node: ts.Node): boolean {
    // Skip `true`/`false` used as TypeScript literal types (e.g. `let a: true`)
    // — mutating those changes a type annotation, not runtime behavior, and
    // can break compilation without ever being exercised by a test.
    return !!node.parent && ts.isLiteralTypeNode(node.parent);
  }

  function visit(node: ts.Node) {
    if (node.kind === ts.SyntaxKind.TrueKeyword && !isInTypePosition(node)) {
      add(node, "BooleanLiteralInversion", "false");
    } else if (node.kind === ts.SyntaxKind.FalseKeyword && !isInTypePosition(node)) {
      add(node, "BooleanLiteralInversion", "true");
    } else if (ts.isBinaryExpression(node)) {
      const op = node.operatorToken;
      switch (op.kind) {
        case ts.SyntaxKind.EqualsEqualsToken:
          add(op, "EqualityReplacement", "!=");
          break;
        case ts.SyntaxKind.ExclamationEqualsToken:
          add(op, "InequalityReplacement", "==");
          break;
        case ts.SyntaxKind.EqualsEqualsEqualsToken:
          add(op, "StrictEqualityReplacement", "!==");
          break;
        case ts.SyntaxKind.ExclamationEqualsEqualsToken:
          add(op, "StrictInequalityReplacement", "===");
          break;
        case ts.SyntaxKind.AmpersandAmpersandToken:
          add(op, "LogicalConnectorFlip", "||");
          break;
        case ts.SyntaxKind.BarBarToken:
          add(op, "LogicalConnectorFlip", "&&");
          break;
        // Arithmetic operator replacement. NOTE: `+` is ambiguous between
        // numeric addition and string concatenation, and this tool has no
        // type checker — it will happily mutate a string-concat `+` into
        // `-`, producing a mutant that's often trivially killed (NaN vs a
        // string) rather than a meaningful arithmetic mutant. That's a
        // known, disclosed imprecision, not a silent one — see Limitations.
        case ts.SyntaxKind.PlusToken:
          add(op, "ArithmeticOperatorReplacement", "-");
          break;
        case ts.SyntaxKind.MinusToken:
          add(op, "ArithmeticOperatorReplacement", "+");
          break;
        case ts.SyntaxKind.AsteriskToken:
          add(op, "ArithmeticOperatorReplacement", "/");
          break;
        case ts.SyntaxKind.SlashToken:
          add(op, "ArithmeticOperatorReplacement", "*");
          break;
        case ts.SyntaxKind.PercentToken:
          add(op, "ArithmeticOperatorReplacement", "*");
          break;
        // Relational boundary mutation — the classic off-by-one-adjacent
        // mutator: swaps strict/inclusive at a comparison boundary.
        case ts.SyntaxKind.LessThanToken:
          add(op, "RelationalBoundaryReplacement", "<=");
          break;
        case ts.SyntaxKind.LessThanEqualsToken:
          add(op, "RelationalBoundaryReplacement", "<");
          break;
        case ts.SyntaxKind.GreaterThanToken:
          add(op, "RelationalBoundaryReplacement", ">=");
          break;
        case ts.SyntaxKind.GreaterThanEqualsToken:
          add(op, "RelationalBoundaryReplacement", ">");
          break;
      }
    } else if (
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)
    ) {
      // ++/-- swap. The operator token itself isn't a separate AST node for
      // unary expressions (unlike BinaryExpression), so the mutant span is
      // computed directly: 2 chars, either at the start (prefix, e.g. `++i`)
      // or the end (postfix, e.g. `i++`) of the expression's text range.
      const isPrefix = ts.isPrefixUnaryExpression(node);
      const start = isPrefix ? node.getStart(sourceFile) : node.getEnd() - 2;
      const end = start + 2;
      const replacement = node.operator === ts.SyntaxKind.PlusPlusToken ? "--" : "++";
      const { line } = sourceFile.getLineAndCharacterOfPosition(start);
      mutants.push({
        start,
        end,
        line: line + 1,
        kind: "IncrementDecrementReplacement",
        original: src.slice(start, end),
        replacement,
      });
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  mutants.sort((a, b) => a.start - b.start);
  return mutants;
}

export function applyMutant(src: string, mutant: Mutant): string {
  return src.slice(0, mutant.start) + mutant.replacement + src.slice(mutant.end);
}

export interface MutantOutcome {
  file: string;
  line: number;
  kind: string;
  status: "Killed" | "Survived" | "Error" | "Flaky";
  /** Present only when `retries` produced more than one observation for
   * this mutant. Each entry is "Killed" or "Survived" for that single
   * attempt — never "Flaky" or "Error" (a per-attempt timeout/nonzero
   * exit is folded into "Killed" the same way a single-attempt run
   * would, since that's already this tool's definition of "caught"). */
  attempts?: Array<"Killed" | "Survived">;
}

export interface RetryOptions {
  /** Extra attempts beyond the first, run ONLY when the first attempt's
   * result is "Killed" — a passing baseline that starts failing under a
   * mutation is the outcome a flaky, mutation-unrelated test failure can
   * fake, so that's the one worth re-checking. A first attempt of
   * "Survived" is not retried: a flaky test that passes anyway doesn't
   * inflate the kill rate, so there's nothing to protect against there. */
  retries: number;
  /** Extra env vars merged over process.env for this mutant's test runs —
   * e.g. a worker-unique TMPDIR/PORT to reduce shared-state flakiness
   * between concurrent workers. Does not affect flakiness *detection*,
   * only reduces one common CAUSE of it. */
  env?: NodeJS.ProcessEnv;
}

/**
 * Apply one mutant to `absPath`, run `testCommand`, revert, and report
 * kill/survive. testCommand's exit code determines the verdict: nonzero
 * (or timeout) = Killed, zero = Survived. Reverts the file even on error.
 *
 * Runs under `/bin/bash` explicitly rather than Node's default `/bin/sh`:
 * on most Linux systems `/bin/sh` is dash, which doesn't support brace
 * expansion (`{ts,js}`) or globstar (`**`) — both of which show up
 * constantly in real npm test scripts (e.g. `mocha "spec/**\/*.spec.{ts,js}"`).
 * Under plain `/bin/sh` those patterns pass through unexpanded, which can
 * silently change what a test command actually runs.
 *
 * If `incremental` is provided, this waits for it to report a settled
 * recompile right after writing the mutant to disk, and again after
 * reverting — instead of `testCommand` itself rebuilding from scratch.
 * `testCommand` in that mode must be the test-runner invocation ONLY (no
 * build step); the watcher owns keeping the build current. A recompile
 * that times out or a watch process that has already exited is treated
 * as "the mutant broke the build in a way this run couldn't recover
 * from" — reported as Killed, same bucket as a failing test, since
 * either way the mutant didn't survive.
 */
export async function runOneMutant(
  absPath: string,
  relPath: string,
  mutant: Mutant,
  testCommand: string,
  cwd: string,
  timeoutMs: number,
  incremental?: TscWatcher,
  retry?: RetryOptions
): Promise<MutantOutcome> {
  const original = readFileSync(absPath, "utf-8");
  writeFileSync(absPath, applyMutant(original, mutant), "utf-8");

  const attempts: Array<"Killed" | "Survived"> = [];
  const runOnce = async (): Promise<"Killed" | "Survived"> => {
    if (incremental) {
      await incremental.waitForRecompile(timeoutMs);
    }
    const passed = await runShellCommand(testCommand, cwd, timeoutMs, retry?.env);
    return passed ? "Survived" : "Killed";
  };

  let status: MutantOutcome["status"];
  try {
    attempts.push(await runOnce());
    // Only re-verify a "Killed" first attempt (see RetryOptions.retries doc)
    // — and only if the caller actually asked for retries.
    if (attempts[0] === "Killed" && retry && retry.retries > 0) {
      for (let i = 0; i < retry.retries; i++) {
        attempts.push(await runOnce().catch(() => "Killed" as const));
      }
      const allAgree = attempts.every((a) => a === attempts[0]);
      status = allAgree ? "Killed" : "Flaky";
    } else {
      status = attempts[0];
    }
  } catch {
    // Nonzero exit, timeout, or a recompile that never settled all count as "caught"
    if (!attempts.length) attempts.push("Killed");
    status = "Killed";
  } finally {
    writeFileSync(absPath, original, "utf-8");
    if (incremental) {
      // Best-effort: let the watcher catch up to the revert too, so the
      // NEXT mutant's waitForRecompile isn't waiting on this one's tail.
      // Not awaited on failure — a timeout here shouldn't fail the mutant
      // whose outcome was already decided above.
      try {
        await incremental.waitForRecompile(timeoutMs);
      } catch {
        /* the next mutant's own waitForRecompile will surface a real problem */
      }
    }
  }

  return {
    file: relPath,
    line: mutant.line,
    kind: mutant.kind,
    status,
    attempts: attempts.length > 1 ? attempts : undefined,
  };
}

export async function confirmBaseline(testCommand: string, cwd: string, timeoutMs: number): Promise<boolean> {
  return runShellCommand(testCommand, cwd, timeoutMs);
}
