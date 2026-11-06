import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { detectTestCommand, detectEntry } from "./detect.js";

function withRoot(pkg: unknown | null, fn: (root: string) => void) {
  const root = mkdtempSync(join(tmpdir(), "mutant-priority-detect-"));
  try {
    if (pkg !== null) {
      writeFileSync(join(root, "package.json"), JSON.stringify(pkg), "utf-8");
    }
    fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("detectTestCommand: returns `npm test` when scripts.test is a real command", () => {
  withRoot({ name: "x", scripts: { test: "mocha test/**/*.test.js" } }, (root) => {
    const result = detectTestCommand(root);
    assert.deepEqual(result?.command, "npm test");
    assert.match(result!.source, /mocha test/);
  });
});

test("detectTestCommand: returns null when there's no package.json", () => {
  withRoot(null, (root) => {
    assert.equal(detectTestCommand(root), null);
  });
});

test("detectTestCommand: returns null when there's no scripts.test at all", () => {
  withRoot({ name: "x", scripts: { build: "tsc" } }, (root) => {
    assert.equal(detectTestCommand(root), null);
  });
});

test("detectTestCommand: returns null for the npm-init placeholder", () => {
  withRoot({ name: "x", scripts: { test: 'echo "Error: no test specified" && exit 1' } }, (root) => {
    assert.equal(detectTestCommand(root), null);
  });
});

test("detectTestCommand: returns null for malformed package.json", () => {
  const root = mkdtempSync(join(tmpdir(), "mutant-priority-detect-"));
  try {
    writeFileSync(join(root, "package.json"), "{ not valid json", "utf-8");
    assert.equal(detectTestCommand(root), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// --- detectEntry ---

test("detectEntry: uses package.json's main field when the file exists", () => {
  const root = mkdtempSync(join(tmpdir(), "mutant-priority-detect-entry-"));
  try {
    writeFileSync(join(root, "package.json"), JSON.stringify({ main: "lib/start.js" }), "utf-8");
    mkdirSync(join(root, "lib"));
    writeFileSync(join(root, "lib", "start.js"), "module.exports = {};\n", "utf-8");
    const result = detectEntry(root);
    assert.equal(result?.file, "lib/start.js");
    assert.match(result!.source, /"main"/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("detectEntry: falls back from a not-yet-built dist/main to the src equivalent", () => {
  const root = mkdtempSync(join(tmpdir(), "mutant-priority-detect-entry-"));
  try {
    writeFileSync(join(root, "package.json"), JSON.stringify({ main: "dist/index.js" }), "utf-8");
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "index.ts"), "export {};\n", "utf-8");
    // NOTE: dist/index.js deliberately does not exist — repo hasn't been built yet.
    const result = detectEntry(root);
    assert.equal(result?.file, "src/index.ts");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("detectEntry: prefers an already-built dist file over guessing at src", () => {
  const root = mkdtempSync(join(tmpdir(), "mutant-priority-detect-entry-"));
  try {
    writeFileSync(join(root, "package.json"), JSON.stringify({ main: "dist/index.js" }), "utf-8");
    mkdirSync(join(root, "dist"));
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "dist", "index.js"), "module.exports = {};\n", "utf-8");
    writeFileSync(join(root, "src", "index.ts"), "export {};\n", "utf-8");
    const result = detectEntry(root);
    assert.equal(result?.file, "dist/index.js");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("detectEntry: reads exports['.'] as a conditional-exports object", () => {
  const root = mkdtempSync(join(tmpdir(), "mutant-priority-detect-entry-"));
  try {
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ exports: { ".": { import: "./src/index.ts", require: "./dist/index.js" } } }),
      "utf-8"
    );
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "index.ts"), "export {};\n", "utf-8");
    const result = detectEntry(root);
    assert.equal(result?.file, "src/index.ts");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("detectEntry: falls back to a conventional path when package.json has no usable field", () => {
  const root = mkdtempSync(join(tmpdir(), "mutant-priority-detect-entry-"));
  try {
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "x" }), "utf-8");
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "index.js"), "module.exports = {};\n", "utf-8");
    const result = detectEntry(root);
    assert.equal(result?.file, "src/index.js");
    assert.match(result!.source, /conventional/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("detectEntry: returns null when nothing checks out — never guesses wrong silently", () => {
  const root = mkdtempSync(join(tmpdir(), "mutant-priority-detect-entry-"));
  try {
    writeFileSync(join(root, "package.json"), JSON.stringify({ main: "dist/index.js" }), "utf-8");
    assert.equal(detectEntry(root), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
