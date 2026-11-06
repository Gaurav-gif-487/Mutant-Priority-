import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  collectFiles,
  extractSpecs,
  resolveSpec,
  loadPathsConfig,
  isTestFile,
  findDynamicRequireCount,
  findDynamicImportCount,
  type PathsConfig,
} from "./graph.js";
import { loadWorkspaceMap, type WorkspaceMap } from "./workspaces.js";

export interface ImpactGraph {
  root: string;
  files: string[]; // source + test files together
  reverseAdj: Map<string, string[]>; // file -> files that import it
  dynamicRequireFiles: string[]; // files containing a require() this graph can't see through
  dynamicImportFiles: string[]; // files containing an import() this graph can't see through
  /** Repo-relative file -> sorted list of top-level exported identifier
   * names declared in it (best-effort, regex-based — see extractExportedNames).
   * Used by narrowImpactedTestsByIdentifier for a finer-than-file-level
   * filter over an already file-level-correct impacted-test list. */
  exportedNames: Map<string, string[]>;
}

/**
 * Build an import graph over BOTH source and test files (unlike
 * `buildGraph`, which deliberately excludes test files so they don't
 * distort fan-in/fan-out/depth metrics used for prioritization). This
 * graph exists for one purpose: given a mutated file, find which test
 * files could plausibly exercise it, so `validate --impact` can run a
 * narrower, faster test command per mutant instead of the whole suite.
 *
 * `entry` (the same entry file used for ranking) is used for one extra
 * resolution: if a test file imports the package under its OWN name —
 * `require("my-package")` from inside `my-package`'s own test suite,
 * which happens whenever a package's tests exercise it the same way an
 * external consumer would, and is common enough that ajv's own spec
 * suite does exactly this — that import is treated as importing `entry`,
 * the same way a workspace package's bare name resolves to its main
 * entry. Without this, EVERY test file that imports the package by name
 * shows zero statically-resolvable connection to anything, and
 * `--impact` falls back to the full suite for the whole repo.
 */
export function buildImpactGraph(root: string, entry?: string): ImpactGraph {
  const files = collectFiles(root, isTrackable);
  const fileset = new Set(files);
  const pathsConfig: PathsConfig | null = loadPathsConfig(root);
  const workspaceMap: WorkspaceMap | null = loadWorkspaceMap(root);
  const ownPackageName = entry ? loadOwnPackageName(root) : null;

  const reverseAdj = new Map<string, string[]>(files.map((f) => [f, []]));
  const dynamicRequireFiles: string[] = [];
  const dynamicImportFiles: string[] = [];
  const exportedNames = new Map<string, string[]>();

  for (const f of files) {
    let src: string;
    try {
      src = readFileSync(join(root, f), "utf-8");
    } catch {
      continue;
    }
    if (findDynamicRequireCount(src) > 0) dynamicRequireFiles.push(f);
    if (findDynamicImportCount(src) > 0) dynamicImportFiles.push(f);
    exportedNames.set(f, extractExportedNames(src));
    const specs = extractSpecs(src);
    for (const s of specs) {
      let r = resolveSpec(root, fileset, f, s, pathsConfig, workspaceMap);
      if ((r === null || r === false) && ownPackageName && entry && isSelfImport(s, ownPackageName)) {
        r = fileset.has(entry) ? entry : false;
      }
      if (r && r !== f) {
        reverseAdj.get(r)?.push(f); // r is imported by f -> record f as an importer of r
      }
    }
  }

  return { root, files, reverseAdj, dynamicRequireFiles, dynamicImportFiles, exportedNames };
}

// Matches `export function foo`, `export async function foo`, `export const
// foo =`, `export let/var foo =`, `export class Foo`, `export default
// function foo(...)`, and `export { a, b as c }` (the local, pre-`as` name
// only — a lightweight, deliberately non-exhaustive scan; see
// extractExportedNames's doc comment for what this misses).
const EXPORT_DECL_RE = /(?:^|\n)\s*export\s+(?:default\s+)?(?:async\s+)?(?:function\*?|class|const|let|var)\s+([A-Za-z_$][\w$]*)/g;
const EXPORT_BRACE_RE = /(?:^|\n)\s*export\s*\{([^}]+)\}/g;

/**
 * Best-effort extraction of the identifier names a file exports, scanning
 * source text (not a real type-checker/binder — same regex-over-text
 * tradeoff as extractSpecs). Used only to NARROW an already-computed,
 * file-level-correct impacted-test list: a false negative here just means
 * narrowImpactedTestsByIdentifier falls back to the full file-level list,
 * never to fewer tests than are actually safe. Known gaps: re-exports
 * (`export { x } from './y'`), `export default <expr>` with no name, and
 * anything generated or renamed at build time.
 */
export function extractExportedNames(src: string): string[] {
  const names = new Set<string>();
  for (const re of [EXPORT_DECL_RE]) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) names.add(m[1]);
  }
  EXPORT_BRACE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = EXPORT_BRACE_RE.exec(src))) {
    for (const part of m[1].split(",")) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      const localName = trimmed.split(/\s+as\s+/)[0].trim();
      if (/^[A-Za-z_$][\w$]*$/.test(localName)) names.add(localName);
    }
  }
  return [...names].sort();
}

/**
 * Narrow an already-computed file-level `impactedTests` list by keeping
 * only the test files whose source text references at least one of
 * `mutatedFile`'s exported identifier names. This is a heuristic
 * refinement of `computeImpactedTests`'s file-level (and always safe)
 * answer, not a replacement for it: it can only ever shrink the list, and
 * only when the shrink is non-empty — if NO impacted test file mentions
 * any exported name (e.g. `extractExportedNames` found nothing, or the
 * mutated file has an unnamed default export), the original, file-level
 * list is returned unchanged rather than risking a false "no test covers
 * this" narrowing to zero.
 */
export function narrowImpactedTestsByIdentifier(
  graph: ImpactGraph,
  mutatedFile: string,
  impactedTests: string[]
): string[] {
  const names = graph.exportedNames.get(mutatedFile) ?? [];
  if (names.length === 0 || impactedTests.length <= 1) return impactedTests;

  const narrowed = impactedTests.filter((t) => {
    let src: string;
    try {
      src = readFileSync(join(graph.root, t), "utf-8");
    } catch {
      return true; // can't read it -> don't drop it, err toward safety
    }
    return names.some((n) => src.includes(n));
  });

  return narrowed.length > 0 ? narrowed : impactedTests;
}

/** True if `spec` is the package's own name, or `<name>/<subpath>` — the
 * bare-specifier form a test suite uses to import itself as if it were an
 * external consumer. Subpaths beyond the bare name aren't separately
 * resolved (only the package root maps to `entry`); a package importing
 * one of its own deep, non-exported paths under its own name is rare
 * enough not to be worth the added resolution surface here. */
function isSelfImport(spec: string, ownPackageName: string): boolean {
  return spec === ownPackageName || spec.startsWith(ownPackageName + "/");
}

function loadOwnPackageName(root: string): string | null {
  const p = join(root, "package.json");
  if (!existsSync(p)) return null;
  try {
    const pkg = JSON.parse(readFileSync(p, "utf-8"));
    return typeof pkg.name === "string" ? pkg.name : null;
  } catch {
    return null;
  }
}

function isTrackable(relPath: string): boolean {
  // Same extension/ignore rules as the source graph, but WITHOUT excluding
  // test files — that's the whole point of this separate graph.
  return /\.(ts|tsx|js|mjs|cjs)$/.test(relPath) && !relPath.endsWith(".d.ts");
}

/**
 * Given a mutated file (repo-relative path), return the sorted list of
 * test files that transitively import it — i.e. every file reachable by
 * walking "who imports this" edges outward from the mutated file,
 * filtered down to files matching the test-file convention.
 *
 * If the mutated file IS itself a test file, it's included in the result.
 * An empty result means no test file in this graph imports the mutated
 * file through any statically-resolvable path — that can mean the file
 * is genuinely untested, or that it's reached only through a dynamic or
 * unresolvable import (see graph.ts limitations). Callers should treat
 * an empty result as "fall back to the full suite," not as proof of dead
 * code.
 */
export function computeImpactedTests(graph: ImpactGraph, mutatedFile: string): string[] {
  const seen = new Set<string>([mutatedFile]);
  const q: string[] = [mutatedFile];
  const impacted = new Set<string>();
  if (isTestFile(mutatedFile)) impacted.add(mutatedFile);

  while (q.length) {
    const cur = q.shift()!;
    for (const importer of graph.reverseAdj.get(cur) ?? []) {
      if (seen.has(importer)) continue;
      seen.add(importer);
      if (isTestFile(importer)) impacted.add(importer);
      q.push(importer);
    }
  }

  return [...impacted].sort();
}

/**
 * Substitute `{files}` in a shell command template with the given test
 * file paths (each single-quoted for shell safety, space-joined). E.g.
 * template `"npx mocha {files}"` + `["test/a.test.js"]` ->
 * `"npx mocha 'test/a.test.js'"`.
 */
export function buildImpactedTestCommand(template: string, testFiles: string[]): string {
  const quoted = testFiles.map((f) => `'${f.replace(/'/g, `'\\''`)}'`).join(" ");
  return template.replace("{files}", quoted);
}
