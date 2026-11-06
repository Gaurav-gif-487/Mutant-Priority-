import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getStagedFiles } from "./git.js";

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "mutant-priority-git-"));
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  git(dir, ["config", "user.name", "Test"]);
  return dir;
}

test("getStagedFiles: returns [] outside a git repo", () => {
  const dir = mkdtempSync(join(tmpdir(), "mutant-priority-notgit-"));
  try {
    assert.deepEqual(getStagedFiles(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("getStagedFiles: returns [] when nothing is staged", () => {
  const dir = initRepo();
  try {
    assert.deepEqual(getStagedFiles(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("getStagedFiles: lists a newly-added staged file", () => {
  const dir = initRepo();
  try {
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "a.js"), "module.exports = 1;\n");
    git(dir, ["add", "src/a.js"]);
    assert.deepEqual(getStagedFiles(dir), ["src/a.js"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("getStagedFiles: a staged deletion is excluded (--diff-filter=ACMR)", () => {
  const dir = initRepo();
  try {
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "a.js"), "module.exports = 1;\n");
    writeFileSync(join(dir, "src", "b.js"), "module.exports = 2;\n");
    git(dir, ["add", "."]);
    git(dir, ["commit", "-q", "-m", "init"]);
    // Stage a modification to a.js and a deletion of b.js in the same commit.
    writeFileSync(join(dir, "src", "a.js"), "module.exports = 3;\n");
    git(dir, ["add", "src/a.js"]);
    git(dir, ["rm", "-q", "--cached", "src/b.js"]);
    const staged = getStagedFiles(dir);
    assert.ok(staged.includes("src/a.js"), JSON.stringify(staged));
    assert.ok(!staged.includes("src/b.js"), JSON.stringify(staged));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
