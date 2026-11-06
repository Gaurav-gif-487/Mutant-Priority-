import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { findMutants, applyMutant, runOneMutant, confirmBaseline } from "./mutate.js";

function kinds(src: string, path = "f.ts"): string[] {
  return findMutants(src, path).map((m) => m.kind);
}

test("findMutants: boolean literal inversion, both directions", () => {
  assert.deepEqual(kinds("const a = true;"), ["BooleanLiteralInversion"]);
  assert.deepEqual(kinds("const a = false;"), ["BooleanLiteralInversion"]);
  const [m] = findMutants("const a = true;");
  assert.equal(m.replacement, "false");
});

test("findMutants: does NOT mutate `true`/`false` used as a TS literal type", () => {
  // `let a: true` — the TrueKeyword here is a type annotation, not a value.
  assert.deepEqual(kinds("let a: true;", "f.ts"), []);
});

test("findMutants: equality/inequality/strict variants, each a single swap", () => {
  assert.equal(findMutants("a == b;")[0].replacement, "!=");
  assert.equal(findMutants("a != b;")[0].replacement, "==");
  assert.equal(findMutants("a === b;")[0].replacement, "!==");
  assert.equal(findMutants("a !== b;")[0].replacement, "===");
});

test("findMutants: logical connector flip", () => {
  assert.equal(findMutants("a && b;")[0].replacement, "||");
  assert.equal(findMutants("a || b;")[0].replacement, "&&");
});

test("findMutants: arithmetic operator replacement covers +,-,*,/,%", () => {
  assert.equal(findMutants("a + b;")[0].replacement, "-");
  assert.equal(findMutants("a - b;")[0].replacement, "+");
  assert.equal(findMutants("a * b;")[0].replacement, "/");
  assert.equal(findMutants("a / b;")[0].replacement, "*");
  assert.equal(findMutants("a % b;")[0].replacement, "*");
});

test("findMutants: relational boundary replacement covers <,<=,>,>=", () => {
  assert.equal(findMutants("a < b;")[0].replacement, "<=");
  assert.equal(findMutants("a <= b;")[0].replacement, "<");
  assert.equal(findMutants("a > b;")[0].replacement, ">=");
  assert.equal(findMutants("a >= b;")[0].replacement, ">");
});

test("findMutants: increment/decrement swap, prefix and postfix", () => {
  const prefix = findMutants("++i;")[0];
  assert.equal(prefix.kind, "IncrementDecrementReplacement");
  assert.equal(prefix.original, "++");
  assert.equal(prefix.replacement, "--");

  const postfix = findMutants("i++;")[0];
  assert.equal(postfix.original, "++");
  assert.equal(postfix.replacement, "--");

  const dec = findMutants("i--;")[0];
  assert.equal(dec.replacement, "++");
});

test("findMutants: skips string/comment/template content entirely (AST-based, not regex)", () => {
  const src = `
    // if (a && b) true
    const s = "a && b == true";
    const t = \`nested \${1 + 1} && \${true}\`;
  `;
  const found = findMutants(src);
  // Only the two real code sites inside the template's \${...} holes:
  // `1 + 1` (arithmetic) and the literal `true`.
  const foundKinds = found.map((m) => m.kind).sort();
  assert.deepEqual(foundKinds, ["ArithmeticOperatorReplacement", "BooleanLiteralInversion"]);
});

test("findMutants: does not touch unrelated operators (e.g. bitwise, exponent, compound assignment)", () => {
  assert.deepEqual(kinds("a & b;"), []);
  assert.deepEqual(kinds("a | b;"), []);
  assert.deepEqual(kinds("a ** b;"), []);
  assert.deepEqual(kinds("a += 1;"), []);
});

test("findMutants: mutants are sorted by source position", () => {
  const src = "if (b) {} \n if (a) {}";
  const found = findMutants(src);
  for (let i = 1; i < found.length; i++) {
    assert.ok(found[i].start >= found[i - 1].start);
  }
});

test("applyMutant: splices exactly the matched span, leaving surrounding text untouched", () => {
  const src = "const ok = true; // keep this comment";
  const [m] = findMutants(src);
  const out = applyMutant(src, m);
  assert.equal(out, "const ok = false; // keep this comment");
});

test("applyMutant: increment/decrement replacement preserves surrounding statement", () => {
  const src = "let i = 0;\ni++;\nconsole.log(i);";
  const [m] = findMutants(src);
  assert.equal(applyMutant(src, m), "let i = 0;\ni--;\nconsole.log(i);");
});

// --- integration: runOneMutant / confirmBaseline actually spawn a shell test command ---

async function withTempFile(
  content: string,
  fn: (dir: string, absPath: string, relPath: string) => void | Promise<void>
) {
  const dir = mkdtempSync(join(tmpdir(), "mutant-priority-test-"));
  const relPath = "target.js";
  const absPath = join(dir, relPath);
  writeFileSync(absPath, content, "utf-8");
  try {
    await fn(dir, absPath, relPath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("confirmBaseline: true for an exit-0 command, false for a nonzero exit", async () => {
  await withTempFile("", async (dir) => {
    assert.equal(await confirmBaseline("exit 0", dir, 5000), true);
    assert.equal(await confirmBaseline("exit 1", dir, 5000), false);
  });
});

test("runOneMutant: Survived when the test command can't tell the mutant apart", async () => {
  await withTempFile("module.exports = { flag: true };\n", async (dir, absPath, relPath) => {
    const mutant = findMutants("module.exports = { flag: true };\n", relPath)[0];
    // Test command ignores the file entirely -> always exits 0 -> mutant survives.
    const outcome = await runOneMutant(absPath, relPath, mutant, "exit 0", dir, 5000);
    assert.equal(outcome.status, "Survived");
  });
});

test("runOneMutant: Killed when the mutated value actually breaks the test", async () => {
  const src = "module.exports = { flag: true };\n";
  await withTempFile(src, async (dir, absPath, relPath) => {
    const mutant = findMutants(src, relPath)[0];
    const testCmd = `node -e "if (require('./${relPath}').flag !== true) process.exit(1)"`;
    const outcome = await runOneMutant(absPath, relPath, mutant, testCmd, dir, 5000);
    assert.equal(outcome.status, "Killed");
  });
});

test("runOneMutant: reverts the file after running, regardless of outcome", async () => {
  const src = "module.exports = { flag: true };\n";
  await withTempFile(src, async (dir, absPath, relPath) => {
    const mutant = findMutants(src, relPath)[0];
    await runOneMutant(absPath, relPath, mutant, "exit 1", dir, 5000);
    assert.equal(readFileSync(absPath, "utf-8"), src);
  });
});

test("runOneMutant: brace expansion works because the shell is bash, not sh/dash", async () => {
  // dash (the default /bin/sh on most Linux systems) does not support
  // `{a,b}` brace expansion; if runOneMutant silently fell back to sh,
  // this command would produce the literal string "{a,b}" and fail.
  const src = "module.exports = { flag: true };\n";
  await withTempFile(src, async (dir, absPath, relPath) => {
    const mutant = findMutants(src, relPath)[0];
    const outcome = await runOneMutant(absPath, relPath, mutant, "echo {a,b} | grep -q '^a b$'", dir, 5000);
    assert.equal(outcome.status, "Survived"); // exit 0 -> mutant "survives" this no-op check, proving brace expansion worked
  });
});

test("runOneMutant: retries=0 (default) never re-runs, unchanged behavior", async () => {
  const src = "module.exports = { flag: true };\n";
  await withTempFile(src, async (dir, absPath, relPath) => {
    const mutant = findMutants(src, relPath)[0];
    const outcome = await runOneMutant(absPath, relPath, mutant, "exit 1", dir, 5000);
    assert.equal(outcome.status, "Killed");
    assert.equal(outcome.attempts, undefined);
  });
});

test("runOneMutant: a Killed result that stays Killed across every retry is reported as Killed, with attempts recorded", async () => {
  const src = "module.exports = { flag: true };\n";
  await withTempFile(src, async (dir, absPath, relPath) => {
    const mutant = findMutants(src, relPath)[0];
    const outcome = await runOneMutant(absPath, relPath, mutant, "exit 1", dir, 5000, undefined, { retries: 2 });
    assert.equal(outcome.status, "Killed");
    assert.deepEqual(outcome.attempts, ["Killed", "Killed", "Killed"]);
  });
});

test("runOneMutant: a Killed first attempt that flips to Survived on retry is reported as Flaky", async () => {
  const src = "module.exports = { flag: true };\n";
  await withTempFile(src, async (dir, absPath, relPath) => {
    const mutant = findMutants(src, relPath)[0];
    const counter = join(dir, "attempt-count.txt");
    // Fails the first call (Killed), then passes every call after (Survived) —
    // simulates a flaky test that only fails once.
    const cmd = `bash -c 'n=$(cat ${counter} 2>/dev/null || echo 0); echo $((n+1)) > ${counter}; [ "$n" = "0" ] && exit 1 || exit 0'`;
    const outcome = await runOneMutant(absPath, relPath, mutant, cmd, dir, 5000, undefined, { retries: 1 });
    assert.equal(outcome.status, "Flaky");
    assert.deepEqual(outcome.attempts, ["Killed", "Survived"]);
  });
});

test("runOneMutant: a Survived first attempt is never retried, even with retries set", async () => {
  const src = "module.exports = { flag: true };\n";
  await withTempFile(src, async (dir, absPath, relPath) => {
    const mutant = findMutants(src, relPath)[0];
    const counter = join(dir, "attempt-count.txt");
    const cmd = `bash -c 'n=$(cat ${counter} 2>/dev/null || echo 0); echo $((n+1)) > ${counter}; exit 0'`;
    const outcome = await runOneMutant(absPath, relPath, mutant, cmd, dir, 5000, undefined, { retries: 3 });
    assert.equal(outcome.status, "Survived");
    assert.equal(outcome.attempts, undefined); // only one call ever made
    assert.equal(readFileSync(counter, "utf-8").trim(), "1");
  });
});

test("runOneMutant: retry.env is passed through to the test command", async () => {
  const src = "module.exports = { flag: true };\n";
  await withTempFile(src, async (dir, absPath, relPath) => {
    const mutant = findMutants(src, relPath)[0];
    const outcome = await runOneMutant(absPath, relPath, mutant, "[ \"$MY_MARKER\" = \"hi\" ] && exit 1 || exit 0", dir, 5000, undefined, {
      retries: 0,
      env: { MY_MARKER: "hi" },
    });
    assert.equal(outcome.status, "Killed"); // the env var was seen -> command exited nonzero
  });
});
