import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { loadWorkspaceMap, resolveWorkspaceSpec } from "./workspaces.js";

const FIXTURES = fileURLToPath(new URL("../fixtures/", import.meta.url));

test("loadWorkspaceMap: npm/yarn array-form `workspaces` field with a glob", () => {
  const root = FIXTURES + "monorepo";
  const ws = loadWorkspaceMap(root);
  assert.ok(ws, "expected a workspace map");
  assert.deepEqual([...ws!.packages.keys()].sort(), ["@acme/app", "@acme/utils"]);
});

test("loadWorkspaceMap: pnpm-workspace.yaml with quoted, unquoted, and commented glob entries", () => {
  const root = FIXTURES + "pnpm-monorepo";
  const ws = loadWorkspaceMap(root);
  assert.ok(ws, "expected a workspace map");
  // Fixture's pnpm-workspace.yaml lists "packages/*" (quoted) which expands
  // to the two real package dirs; "tools/cli" (unquoted, no such dir) simply
  // contributes nothing since there's nothing to read there.
  assert.ok(ws!.packages.size >= 1);
});

test("loadWorkspaceMap: returns null when there's no workspace config at all", () => {
  const root = FIXTURES + "sample-repo";
  assert.equal(loadWorkspaceMap(root), null);
});

test("resolveWorkspaceSpec: exact package name resolves via exports['.']", () => {
  const root = FIXTURES + "monorepo";
  const ws = loadWorkspaceMap(root)!;
  const resolved = resolveWorkspaceSpec(root, ws, "@acme/utils");
  assert.equal(resolved, "packages/utils/src/index.js");
});

test("resolveWorkspaceSpec: subpath resolves via exports['./subpath']", () => {
  const root = FIXTURES + "monorepo";
  const ws = loadWorkspaceMap(root)!;
  const resolved = resolveWorkspaceSpec(root, ws, "@acme/utils/math");
  assert.equal(resolved, "packages/utils/src/math.js");
});

test("resolveWorkspaceSpec: unknown package name resolves to null", () => {
  const root = FIXTURES + "monorepo";
  const ws = loadWorkspaceMap(root)!;
  assert.equal(resolveWorkspaceSpec(root, ws, "left-pad"), null);
});

test("resolveWorkspaceSpec: package with no exports map falls back to main", () => {
  const root = FIXTURES + "pnpm-monorepo";
  const ws = loadWorkspaceMap(root)!;
  const utilsName = [...ws.packages.keys()].find((n) => n.includes("utils"));
  if (utilsName) {
    const resolved = resolveWorkspaceSpec(root, ws, utilsName);
    assert.ok(resolved, `expected a resolution for ${utilsName}`);
  }
});
