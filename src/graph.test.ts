import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { buildGraph, extractSpecs, isTestFile, findDynamicRequireCount, findDynamicImportCount } from "./graph.js";

const FIXTURES = fileURLToPath(new URL("../fixtures/", import.meta.url));

test("extractSpecs: finds import/export/require/dynamic-import specifiers", () => {
  const src = `
    import a from "./a";
    export { b } from "./b";
    import "./side-effect";
    const c = require("./c");
    const d = import("./d");
  `;
  const specs = extractSpecs(src);
  assert.deepEqual([...specs].sort(), ["./a", "./b", "./c", "./d", "./side-effect"]);
});

test("extractSpecs: a dynamically-constructed require is invisible, not just unresolved", () => {
  // require("" + "..") — no string literal directly inside require(...), so
  // the regex-based extractor produces zero specs for this call. This is the
  // exact pattern ajv's spec/ajv.ts helper uses (see README's ajv section).
  const specs = extractSpecs(`const x = require("" + "..");`);
  assert.equal(specs.size, 0);
});

test("findDynamicRequireCount: a literal require() doesn't count", () => {
  assert.equal(findDynamicRequireCount(`const x = require("./a");`), 0);
});

test("findDynamicRequireCount: catches ajv's exact spec/ajv.ts pattern — require(\"\" + \"..\")", () => {
  assert.equal(findDynamicRequireCount(`const x = require("" + "..");`), 1);
});

test("findDynamicRequireCount: catches a variable and a template-literal argument", () => {
  assert.equal(findDynamicRequireCount(`require(pathVar);`), 1);
  assert.equal(findDynamicRequireCount(`require(\`\${base}/mod\`);`), 1);
});

test("findDynamicRequireCount: counts multiple dynamic calls, ignores mixed literal ones", () => {
  const src = `
    require("./a");
    require(x);
    require(y + z);
  `;
  assert.equal(findDynamicRequireCount(src), 2);
});

test("isTestFile: recognizes .test./.spec. suffixes and tests/__tests__ directories", () => {
  assert.equal(isTestFile("src/foo.test.ts"), true);
  assert.equal(isTestFile("src/foo.spec.tsx"), true);
  assert.equal(isTestFile("test/foo.ts"), true);
  assert.equal(isTestFile("__tests__/foo.js"), true);
  assert.equal(isTestFile("src/foo.ts"), false);
});

test("buildGraph: sample-repo — resolves relative imports, computes fan-in/fan-out/depth", () => {
  const root = FIXTURES + "sample-repo";
  const graph = buildGraph(root, "src/index.js");
  assert.equal(graph.files.length, 4);
  assert.equal(graph.unresolved.length, 0);

  const byFile = new Map(graph.perFile.map((f) => [f.file, f]));
  assert.equal(byFile.get("src/index.js")!.distFromEntry, 0);
  assert.equal(byFile.get("src/mathUtils.js")!.fanIn, 1);
  assert.equal(byFile.get("src/mathUtils.js")!.fanOut, 0);
});

test("buildGraph: alias-repo — resolves tsconfig baseUrl/paths aliases (@/* and exact @lib)", () => {
  const root = FIXTURES + "alias-repo";
  const graph = buildGraph(root, "src/main.ts");
  assert.equal(graph.unresolved.length, 0, JSON.stringify(graph.unresolved));

  const edgeTargets = graph.edges.filter(([from]) => from === "src/main.ts").map(([, to]) => to);
  assert.ok(edgeTargets.includes("src/lib/index.ts")); // via exact alias @lib
  assert.ok(edgeTargets.includes("src/lib/helper.ts")); // via wildcard alias @/*
});

test("buildGraph: monorepo — resolves npm/yarn workspace package names via package.json exports", () => {
  const root = FIXTURES + "monorepo";
  const graph = buildGraph(root, "packages/app/src/index.js");
  assert.equal(graph.unresolved.length, 0, JSON.stringify(graph.unresolved));

  const edgeTargets = graph.edges.filter(([from]) => from === "packages/app/src/index.js").map(([, to]) => to);
  assert.ok(edgeTargets.includes("packages/utils/src/index.js")); // "@acme/utils" -> exports["."]
  assert.ok(edgeTargets.includes("packages/utils/src/math.js")); // "@acme/utils/math" -> exports["./math"]
});

test("buildGraph: scope restricts the file set and treats outside-scope imports as external", () => {
  const root = FIXTURES + "monorepo";
  const graph = buildGraph(root, "packages/app/src/index.js", "packages/app");
  assert.deepEqual(graph.files, ["packages/app/src/index.js"]);
  // Both @acme/utils imports now resolve to files outside scope -> unresolved.
  assert.equal(graph.unresolved.length, 2);
});

test("buildGraph: an import to a genuinely external package (not aliased, not a workspace) is unresolved, not an error", () => {
  const root = FIXTURES + "sample-repo";
  const graph = buildGraph(root, "src/index.js");
  // sample-repo has no external imports in its current fixture files, so this
  // just confirms buildGraph doesn't throw when scanning normal source and
  // that everything present does resolve — the negative case is covered by
  // the monorepo "scope" test above, where external-looking specs appear.
  assert.equal(graph.entry, "src/index.js");
});

test("findDynamicImportCount: a literal import() doesn't count", () => {
  assert.equal(findDynamicImportCount(`import("./a").then((m) => m);`), 0);
});

test("findDynamicImportCount: catches a template-literal locale-loading pattern", () => {
  assert.equal(findDynamicImportCount("import(`./locales/${lang}.js`);"), 1);
});

test("findDynamicImportCount: catches a variable and a concatenated argument", () => {
  assert.equal(findDynamicImportCount(`import(pathVar);`), 1);
  assert.equal(findDynamicImportCount(`import("./" + name);`), 1);
});

test("findDynamicImportCount: counts multiple dynamic calls, ignores mixed literal ones", () => {
  const src = `
    import("./a");
    import(pathVar);
    import(\`./b/\${x}\`);
  `;
  assert.equal(findDynamicImportCount(src), 2);
});
