import { execFileSync } from "node:child_process";
import { sep } from "node:path";

/**
 * Repo-relative (posix-separated) paths of every file staged for the next
 * commit — i.e. `git diff --cached --name-only`, filtered to
 * Added/Copied/Modified/Renamed (`--diff-filter=ACMR`) so a staged
 * DELETION never shows up as "please mutation-test this file" (there's
 * nothing left on disk to mutate). Returns `[]` (not an error) when `root`
 * isn't a git repo or has nothing staged — callers treat that as "nothing
 * to check" rather than a failure, since a pre-commit hook running in that
 * state should not block the commit.
 */
export function getStagedFiles(root: string): string[] {
  let out: string;
  try {
    out = execFileSync("git", ["diff", "--cached", "--name-only", "--diff-filter=ACMR"], {
      cwd: root,
      encoding: "utf-8",
    });
  } catch {
    return []; // not a git repo, git not installed, or nothing staged
  }
  return out
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => l.split(sep).join("/"));
}
