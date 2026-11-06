import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildImpactGraph, computeImpactedTests, buildImpactedTestCommand, extractExportedNames, narrowImpactedTestsByIdentifier } from "./impact.js";

const FIXTURES = fileURLToPath(new URL("../fixtures/", import.meta.url));

test("computeImpactedTests: plain relative import connects a source file to its test", () => {
  const root = FIXTURES + "skewed-repo";
  const graph = buildImpactGraph(root);
  const impacted = computeImpactedTests(graph, "src/underTested.js");
  assert.ok(impacted.includes("test/underTested.test.js"), JSON.stringify(impacted));
});

test("computeImpactedTests: a file with no importer at all in the graph falls back (empty result)", () => {
  const dir = mkdtempSync(join(tmpdir(), "mutant-priority-impact-notest-"));
  try {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "notest" }));
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "orphan.js"), `module.exports = { x: 1 };\n`);
    // No test file anywhere imports orphan.js — nothing to connect it to.
    const graph = buildImpactGraph(dir);
    const impacted = computeImpactedTests(graph, "src/orphan.js");
    assert.deepEqual(impacted, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("computeImpactedTests: self-import fix — a test importing the package by its own name resolves to entry", () => {
  const root = FIXTURES + "self-import-repo";
  const graph = buildImpactGraph(root, "lib/index.js");
  // test/index.test.js does `require("mylib")`, lib/index.js does
  // `require("./helper")` -> helper.js should trace back to the test
  // through entry, exactly the ajv-shaped pattern this fix targets.
  const impacted = computeImpactedTests(graph, "lib/helper.js");
  assert.deepEqual(impacted, ["test/index.test.js"]);
});

test("computeImpactedTests: WITHOUT the entry argument, the same self-import does not resolve", () => {
  const root = FIXTURES + "self-import-repo";
  const graph = buildImpactGraph(root); // no entry passed
  const impacted = computeImpactedTests(graph, "lib/helper.js");
  assert.deepEqual(impacted, []); // proves the fix is genuinely doing the work, not something else
});

test("computeImpactedTests: a dynamically-constructed require never resolves, self-import fix or not", () => {
  // Reproduces ajv's real spec/ajv.ts pattern: require("" + "..") instead
  // of require("mylib"). No string literal argument -> extractSpecs sees
  // nothing -> no edge, regardless of the self-import fix being present.
  const dir = mkdtempSync(join(tmpdir(), "mutant-priority-impact-test-"));
  try {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "mylib", main: "lib/index.js" }));
    mkdirSync(join(dir, "lib"));
    mkdirSync(join(dir, "test"));
    writeFileSync(join(dir, "lib", "index.js"), `module.exports = require("./helper");\n`);
    writeFileSync(join(dir, "lib", "helper.js"), `module.exports = { ok: true };\n`);
    writeFileSync(join(dir, "test", "index.test.js"), `const lib = require("" + "..");\n`);

    const graph = buildImpactGraph(dir, "lib/index.js");
    const impacted = computeImpactedTests(graph, "lib/helper.js");
    assert.deepEqual(impacted, []); // correctly falls back — this is not a bug
    // and it's surfaced as a diagnostic, not silently indistinguishable
    // from "genuinely no test covers this":
    assert.deepEqual(graph.dynamicRequireFiles, ["test/index.test.js"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("computeImpactedTests: mutating a test file itself always includes that file", () => {
  const root = FIXTURES + "skewed-repo";
  const graph = buildImpactGraph(root);
  const impacted = computeImpactedTests(graph, "test/underTested.test.js");
  assert.deepEqual(impacted, ["test/underTested.test.js"]);
});

test("buildImpactedTestCommand: substitutes {files}, single-quoting each path", () => {
  const cmd = buildImpactedTestCommand("npx mocha {files} -R dot", ["test/a.test.js", "test/b.test.js"]);
  assert.equal(cmd, "npx mocha 'test/a.test.js' 'test/b.test.js' -R dot");
});

test("buildImpactedTestCommand: escapes a single quote inside a path", () => {
  const cmd = buildImpactedTestCommand("run {files}", ["test/it's-weird.test.js"]);
  assert.equal(cmd, `run 'test/it'\\''s-weird.test.js'`);
});

test("extractExportedNames: finds function/const/class declarations and export-brace names", () => {
  const src = `
export function foo() {}
export const bar = 1;
class Internal {}
export class Baz {}
const qux = 1;
export { qux, Internal as Renamed };
`;
  assert.deepEqual(extractExportedNames(src), ["Baz", "Internal", "bar", "foo", "qux"].sort());
});

test("extractExportedNames: an unnamed default export yields no names (known, documented gap)", () => {
  const src = `export default function() { return 1; }\n`;
  assert.deepEqual(extractExportedNames(src), []);
});

test("narrowImpactedTestsByIdentifier: keeps only test files that mention an exported name", () => {
  const dir = mkdtempSync(join(tmpdir(), "mutant-priority-narrow-"));
  try {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "narrow-fixture" }));
    mkdirSync(join(dir, "src"));
    mkdirSync(join(dir, "test"));
    writeFileSync(join(dir, "src", "lib.js"), `export function widgetize(x) { return x; }\nexport function other(x) { return x; }\n`);
    writeFileSync(join(dir, "test", "widgetize.test.js"), `const { widgetize } = require("../src/lib.js");\nwidgetize(1);\n`);
    writeFileSync(join(dir, "test", "other.test.js"), `const { other } = require("../src/lib.js");\nother(1);\n`);
    // A third test imports lib.js but never mentions either name by text —
    // e.g. it re-exports the whole module. Should be dropped by the narrow.
    writeFileSync(join(dir, "test", "reexport.test.js"), `const lib = require("../src/lib.js");\nlib.widgetize(1);\n`);

    const graph = buildImpactGraph(dir);
    const impacted = computeImpactedTests(graph, "src/lib.js");
    assert.deepEqual(impacted, ["test/other.test.js", "test/reexport.test.js", "test/widgetize.test.js"]);

    const narrowed = narrowImpactedTestsByIdentifier(graph, "src/lib.js", impacted);
    // reexport.test.js textually contains "widgetize" (via lib.widgetize),
    // so the heuristic correctly keeps it too — it's a text match, not a
    // static-binding proof, by design (see the function's doc comment).
    assert.deepEqual(narrowed, ["test/other.test.js", "test/reexport.test.js", "test/widgetize.test.js"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("narrowImpactedTestsByIdentifier: falls back to the full list when no exported names are found", () => {
  const dir = mkdtempSync(join(tmpdir(), "mutant-priority-narrow-fallback-"));
  try {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "narrow-fallback" }));
    mkdirSync(join(dir, "src"));
    mkdirSync(join(dir, "test"));
    // Default export with no name -> extractExportedNames finds nothing.
    writeFileSync(join(dir, "src", "lib.js"), `export default function() { return 1; }\n`);
    writeFileSync(join(dir, "test", "lib.test.js"), `import lib from "../src/lib.js";\nlib();\n`);

    const graph = buildImpactGraph(dir);
    const impacted = computeImpactedTests(graph, "src/lib.js");
    const narrowed = narrowImpactedTestsByIdentifier(graph, "src/lib.js", impacted);
    assert.deepEqual(narrowed, impacted); // unchanged, not narrowed to zero
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("buildImpactGraph: dynamicImportFiles catches a non-literal import() the same way dynamicRequireFiles does for require()", () => {
  const dir = mkdtempSync(join(tmpdir(), "mutant-priority-dynimport-"));
  try {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "dynimport-fixture" }));
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "loader.js"), `const lang = "en";\nimport(\`./locales/\${lang}.js\`).then((m) => m);\n`);
    const graph = buildImpactGraph(dir);
    assert.deepEqual(graph.dynamicImportFiles, ["src/loader.js"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
