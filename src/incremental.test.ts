import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TscWatcher } from "./incremental.js";

function makeTsProject(): string {
  const root = mkdtempSync(join(tmpdir(), "mutant-priority-watch-"));
  mkdirSync(join(root, "src"));
  writeFileSync(
    join(root, "tsconfig.json"),
    JSON.stringify(
      { compilerOptions: { outDir: "dist", rootDir: "src", module: "commonjs", target: "es2020" }, include: ["src"] }
    ),
    "utf-8"
  );
  writeFileSync(join(root, "src", "index.ts"), "export const flag = true;\n", "utf-8");
  return root;
}

// These spawn a REAL `tsc --watch` process (same integration-test philosophy
// as mutate.test.ts's shell-command tests) rather than mocking child_process,
// so they're slower than a unit test and skipped from the default fast loop
// isn't needed here — the timeouts are generous but the whole suite still
// finishes in well under a minute.
test("TscWatcher: start() resolves once the initial build settles, and dist/ exists", async () => {
  const root = makeTsProject();
  const watcher = new TscWatcher({ root });
  try {
    await watcher.start(30000);
    assert.doesNotThrow(() => readFileSync(join(root, "dist", "index.js"), "utf-8"));
  } finally {
    await watcher.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("TscWatcher: waitForRecompile resolves after a source edit is picked up incrementally", async () => {
  const root = makeTsProject();
  const watcher = new TscWatcher({ root });
  try {
    await watcher.start(30000);

    writeFileSync(join(root, "src", "index.ts"), "export const flag = false;\n", "utf-8");
    await watcher.waitForRecompile(20000);

    const built = readFileSync(join(root, "dist", "index.js"), "utf-8");
    assert.match(built, /flag = false/);
  } finally {
    await watcher.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("TscWatcher: start() rejects if the tsconfig path doesn't exist", async () => {
  const root = makeTsProject();
  const watcher = new TscWatcher({ root, tsconfigPath: "does-not-exist.json" });
  try {
    await assert.rejects(() => watcher.start(15000));
  } finally {
    await watcher.stop();
    rmSync(root, { recursive: true, force: true });
  }
});
