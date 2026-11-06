import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export interface DetectedTestCommand {
  command: string;
  /** Human-readable explanation of where this came from, for logging. */
  source: string;
}

// npm's own placeholder when a package was scaffolded without a real test
// script (`npm init` default). Treated as "no test script", not a real one
// — running it just prints an error and exits 1, which would make every
// `validate` run fail the baseline check for a reason that has nothing to
// do with mutation testing.
const NPM_INIT_PLACEHOLDER = /^echo\s+["']?Error:\s*no test specified["']?\s*&&\s*exit\s*1$/;

/**
 * Look for a usable test command in `root`'s package.json without the
 * caller having to pass --test-cmd. Only trusts `scripts.test` (via
 * `npm test`, so pre/post hooks still run) — this does not guess at
 * `scripts.build` or try to assemble a build+test chain itself, since
 * getting that wrong silently would be worse than asking the person to
 * specify it. Returns null if there's no package.json, no `scripts.test`,
 * or it's just the npm-init placeholder.
 */
export function detectTestCommand(root: string): DetectedTestCommand | null {
  const pkgPath = join(root, "package.json");
  if (!existsSync(pkgPath)) return null;

  let pkg: any;
  try {
    pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
  } catch {
    return null;
  }

  const testScript = pkg?.scripts?.test;
  if (typeof testScript !== "string" || testScript.trim() === "") return null;
  if (NPM_INIT_PLACEHOLDER.test(testScript.trim())) return null;

  // Run through `npm test` rather than the raw script string so npm's own
  // pre-test/post-test hooks (pretest, posttest) still fire, same as if
  // the person ran it themselves.
  return { command: "npm test", source: `package.json scripts.test: "${testScript}"` };
}

export interface DetectedEntry {
  /** Entry file path, relative to `root`. */
  file: string;
  source: string;
}

// Checked in this order because it's the order of decreasing confidence:
// an explicit package.json field IS the entry point by definition; a
// conventional file name is just a guess that happens to be right most
// of the time.
const CONVENTIONAL_ENTRIES = [
  "src/index.ts",
  "src/index.js",
  "src/index.tsx",
  "src/index.jsx",
  "src/main.ts",
  "src/main.js",
  "index.ts",
  "index.js",
  "lib/index.ts",
  "lib/index.js",
];

/**
 * Read the "exports" field's `"."` entry, whether it's a plain string or
 * a conditional-exports object (`{ "import": ..., "require": ..., "default": ... }`).
 * Only ever looks at the root `"."` condition — subpath exports aren't
 * "the entry point" in any useful sense for this tool.
 */
function mainExportSpecifier(exportsField: unknown): string | null {
  if (typeof exportsField === "string") return exportsField;
  if (exportsField && typeof exportsField === "object") {
    const dot = (exportsField as Record<string, unknown>)["."];
    if (typeof dot === "string") return dot;
    if (dot && typeof dot === "object") {
      const nested = dot as Record<string, unknown>;
      const candidate = nested.import ?? nested.require ?? nested.default ?? nested.node;
      if (typeof candidate === "string") return candidate;
    }
  }
  return null;
}

/**
 * Find a usable entry file without the caller having to pass --entry.
 * Tries, in order: package.json's `main`, then `module`, then
 * `exports["."]` — each checked as-written and, since these fields
 * commonly point at a BUILT file that may not exist until `npm run
 * build` has run (e.g. `"main": "dist/index.js"` before a fresh clone
 * has been built), also checked against the equivalent path under
 * `src/` with common extensions swapped in. Falls back to a short list
 * of conventional file names if package.json has none of those fields
 * or none of the candidates exist on disk. Returns null (not a guess)
 * if nothing checks out — silently guessing wrong here would point the
 * whole tool's import graph at the wrong root and produce a ranking
 * that looks plausible but is quietly meaningless.
 */
export function detectEntry(root: string): DetectedEntry | null {
  const pkgPath = join(root, "package.json");
  let pkg: any = null;
  if (existsSync(pkgPath)) {
    try {
      pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    } catch {
      pkg = null;
    }
  }

  if (pkg) {
    const fields: Array<[string, string | null | undefined]> = [
      ["main", typeof pkg.main === "string" ? pkg.main : undefined],
      ["module", typeof pkg.module === "string" ? pkg.module : undefined],
      ["exports", mainExportSpecifier(pkg.exports)],
    ];
    for (const [fieldName, spec] of fields) {
      if (!spec) continue;
      const cleaned = spec.replace(/^\.\//, "");
      for (const candidate of sourceCandidatesFor(cleaned)) {
        if (existsSync(join(root, candidate))) {
          return { file: candidate, source: `package.json "${fieldName}": "${spec}"` };
        }
      }
    }
  }

  for (const candidate of CONVENTIONAL_ENTRIES) {
    if (existsSync(join(root, candidate))) {
      return { file: candidate, source: `conventional path (no usable package.json entry field)` };
    }
  }

  return null;
}

/**
 * Given a `main`/`module`/`exports` specifier that may point at a build
 * output (`dist/index.js`), yield it as-is first, then the likely
 * pre-build source equivalents (`src/index.ts`, same basename under
 * `src/` with a `.ts`/`.tsx` extension) — in that order, so a build
 * that HAS already run (dist file present) is trusted over a guess.
 */
function sourceCandidatesFor(spec: string): string[] {
  const out = [spec];
  const distMatch = /^dist\/(.*)\.(js|mjs|cjs)$/.exec(spec);
  if (distMatch) {
    const [, rest] = distMatch;
    out.push(`src/${rest}.ts`, `src/${rest}.tsx`, `${rest}.ts`);
  }
  return out;
}
