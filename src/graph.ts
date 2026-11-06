import { readFileSync, statSync, readdirSync } from "node:fs";
import { join, relative, dirname, normalize, extname, basename, sep } from "node:path";
import ts from "typescript";
import { loadWorkspaceMap, resolveWorkspaceSpec, type WorkspaceMap } from "./workspaces.js";

const EXTS = [".ts", ".tsx", ".js", ".mjs", ".cjs"];
const IGNORE_DIRS = new Set(["node_modules", ".git", "dist", "build", "out", "coverage"]);

// import/export ... from '...'  and bare  import '...'
const IMPORT_RE =
  /(?:^|\n)\s*(?:import|export)\s+(?:[^'";]*?\sfrom\s+)?['"]([^'"]+)['"]/g;
// require('...')
const REQUIRE_RE = /require\(\s*['"]([^'"]+)['"]\s*\)/g;
// dynamic import('...')
const DYN_RE = /import\(\s*['"]([^'"]+)['"]\s*\)/g;

/** Extract every import/require/dynamic-import specifier referenced in `src`.
 * Exported so the impact-mapping module can scan test files with the same
 * logic used for source files, without duplicating the regexes. */
export function extractSpecs(src: string): Set<string> {
  const specs = new Set<string>();
  for (const re of [IMPORT_RE, REQUIRE_RE, DYN_RE]) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) specs.add(m[1]);
  }
  return specs;
}

// dynamic require('...') — a require() call whose argument is not a plain
// string literal, e.g. require("" + ".."), require(pathVar), require(`${x}`).
// These are structurally invisible to extractSpecs above: there's no
// literal specifier to capture, so no edge is ever recorded for them. This
// isn't a bug to fix (there's nothing to statically resolve), but a repo
// that relies on this pattern for real imports — ajv's spec/ajv.ts helper
// does exactly this — will have those edges silently missing from every
// graph built here. findDynamicRequireCount lets callers surface that as
// an explicit diagnostic instead of a silent gap.
const REQUIRE_CALL_RE = /require\s*\(\s*/g;

/** Count `require(...)` calls in `src` whose argument is NOT a plain single-
 * or double-quoted string literal — i.e. calls REQUIRE_RE above could never
 * have captured. Catches both `require(pathVar)` and, importantly,
 * `require("" + "..")` — a call that *starts* with a quote but isn't
 * actually just a string literal once the whole argument is considered
 * (this is ajv's exact spec/ajv.ts pattern). Same regex-over-source-text
 * caveats as extractSpecs: a `require(` appearing inside a string, comment,
 * or template literal is unlikely but not impossible to miscount. */
export function findDynamicRequireCount(src: string): number {
  let count = 0;
  REQUIRE_CALL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = REQUIRE_CALL_RE.exec(src))) {
    const rest = src.slice(m.index + m[0].length);
    // Matches ONLY if the whole argument is a single string literal
    // (optional trailing whitespace) followed immediately by the closing
    // paren — anything else (concatenation, a variable, a template
    // literal, another call) fails this and counts as dynamic.
    const isPlainLiteral = /^(['"])(?:\\.|(?!\1)[^\\])*\1\s*\)/.test(rest);
    if (!isPlainLiteral) count++;
  }
  return count;
}

// dynamic import('...') — an import() call whose argument is not a plain
// string literal, e.g. import(pathVar), import(`${x}`), import("" + "..").
// Mirrors findDynamicRequireCount below but for the ES dynamic-import form.
// Same rationale: DYN_RE above can only ever capture a literal specifier,
// so a non-literal import() is structurally invisible to the graph — this
// lets callers surface that gap as a diagnostic instead of a silent one.
const DYN_IMPORT_CALL_RE = /import\s*\(\s*/g;

/** Count `import(...)` calls in `src` whose argument is NOT a plain single-
 * or double-quoted string literal. Catches `import(pathVar)`,
 * `import(\`./locales/${lang}\`)`, and `import("./" + name)` — every shape
 * that a route-based code-splitting or i18n-locale-loading pattern tends to
 * use, none of which DYN_RE can resolve to a file. */
export function findDynamicImportCount(src: string): number {
  let count = 0;
  DYN_IMPORT_CALL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = DYN_IMPORT_CALL_RE.exec(src))) {
    const rest = src.slice(m.index + m[0].length);
    const isPlainLiteral = /^(['"])(?:\\.|(?!\1)[^\\])*\1\s*[,)]/.test(rest);
    if (!isPlainLiteral) count++;
  }
  return count;
}

export interface FileMetrics {
  file: string;
  fanIn: number;
  fanOut: number;
  distFromEntry: number | null;
}

export interface RepoGraph {
  root: string;
  entry: string;
  files: string[];
  edges: Array<[string, string]>;
  unresolved: Array<[string, string]>;
  perFile: FileMetrics[];
}

function isSource(relPath: string): boolean {
  const b = basename(relPath);
  if (b.endsWith(".d.ts")) return false;
  if (isTestFile(relPath)) return false;
  return EXTS.includes(extname(b));
}

/** True for files that look like test files by the same convention the
 * rest of this tool uses to exclude them from the prioritization graph
 * (used by the impact-mapping module to identify which importers of a
 * mutated file are actually test entry points). */
export function isTestFile(relPath: string): boolean {
  const b = basename(relPath);
  const posixRel = relPath.split(sep).join("/");
  if (/\.(test|spec)\.[tj]sx?$/.test(b)) return true;
  if (/(^|\/)(tests?|__tests__)(\/|$)/.test(posixRel)) return true;
  return false;
}

function collect(root: string): string[] {
  return collectFiles(root, isSource);
}

/** Walk `root` collecting files matching `predicate(relPath)`, skipping
 * common build/dependency directories. Exported so callers that need a
 * different file set (e.g. source+test together for impact mapping) can
 * reuse the same walk without duplicating the directory-skip logic. */
export function collectFiles(root: string, predicate: (relPath: string) => boolean): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      const full = join(dir, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (IGNORE_DIRS.has(name)) continue;
        walk(full);
      } else {
        const rel = relative(root, full).split(sep).join("/");
        if (predicate(rel)) out.push(rel);
      }
    }
  };
  walk(root);
  return out.sort();
}

export interface PathsConfig {
  baseUrlAbs: string; // absolute path
  paths: Record<string, string[]>;
}

/**
 * Load `compilerOptions.baseUrl`/`paths` from the nearest tsconfig.json
 * (or jsconfig.json), following `extends` chains via the TS compiler's
 * own config parser so multi-file configs resolve correctly. Returns
 * null if no config or no `paths` is found — alias resolution is then
 * simply skipped, same as before this feature existed.
 */
export function loadPathsConfig(root: string): PathsConfig | null {
  for (const name of ["tsconfig.json", "jsconfig.json"]) {
    const configPath = ts.findConfigFile(root, ts.sys.fileExists, name);
    if (!configPath) continue;
    const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
    if (configFile.error || !configFile.config) continue;
    const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, dirname(configPath));
    const opts = parsed.options;
    if (!opts.paths || Object.keys(opts.paths).length === 0) continue;
    // ts resolves baseUrl to an absolute path relative to the config file's
    // directory; if baseUrl is unset, paths are still resolved relative to
    // the config file's directory per TS semantics.
    const baseUrlAbs = opts.baseUrl ?? dirname(configPath);
    return { baseUrlAbs, paths: opts.paths as Record<string, string[]> };
  }
  return null;
}

function existsAsSource(root: string, relPath: string, fileset: Set<string>): string | false {
  if (fileset.has(relPath)) return relPath;
  return false;
}

/** Expand a base path (no extension resolved yet) into candidate source files. */
function expandCandidates(base: string): string[] {
  const stemExt = extname(base);
  const stem = stemExt ? base.slice(0, -stemExt.length) : base;
  const candidates: string[] = [];
  if (stemExt === ".js" || stemExt === ".mjs" || stemExt === ".cjs") {
    candidates.push(stem + ".ts", stem + ".tsx");
  }
  candidates.push(base);
  for (const e of EXTS) candidates.push(base + e);
  for (const e of EXTS) candidates.push(join(base, "index" + e).split(sep).join("/"));
  return candidates;
}

/**
 * Resolve a non-relative specifier (e.g. `@/utils/foo`) against tsconfig
 * path aliases. Returns a list of repo-relative base paths to try (still
 * needing extension expansion), in the order the compiler would try them.
 */
function resolveAliasBases(root: string, cfg: PathsConfig, spec: string): string[] {
  const bases: string[] = [];
  for (const [pattern, targets] of Object.entries(cfg.paths)) {
    if (pattern.includes("*")) {
      const prefix = pattern.slice(0, pattern.indexOf("*"));
      const suffix = pattern.slice(pattern.indexOf("*") + 1);
      if (spec.startsWith(prefix) && spec.endsWith(suffix) && spec.length >= prefix.length + suffix.length) {
        const matched = spec.slice(prefix.length, spec.length - suffix.length);
        for (const target of targets) {
          const resolvedTarget = target.replace("*", matched);
          const abs = normalize(join(cfg.baseUrlAbs, resolvedTarget));
          bases.push(relative(root, abs).split(sep).join("/"));
        }
      }
    } else if (pattern === spec) {
      for (const target of targets) {
        const abs = normalize(join(cfg.baseUrlAbs, target));
        bases.push(relative(root, abs).split(sep).join("/"));
      }
    }
  }
  return bases;
}

export function resolveSpec(
  root: string,
  fileset: Set<string>,
  importerRel: string,
  spec: string,
  pathsConfig: PathsConfig | null,
  workspaceMap: WorkspaceMap | null
): string | false | null {
  let baseCandidates: string[];

  if (spec.startsWith(".")) {
    baseCandidates = [normalize(join(dirname(importerRel), spec)).split(sep).join("/")];
  } else {
    const tried: string[] = [];
    if (pathsConfig) tried.push(...resolveAliasBases(root, pathsConfig, spec));
    if (workspaceMap) {
      const wsBase = resolveWorkspaceSpec(root, workspaceMap, spec);
      if (wsBase) tried.push(wsBase);
    }
    if (tried.length === 0) return null; // no alias/workspace match -> external package, not tracked
    baseCandidates = tried;
  }

  for (const base of baseCandidates) {
    for (const c of expandCandidates(base)) {
      const r = existsAsSource(root, c, fileset);
      if (r) return r;
    }
  }
  return false;
}

function normalizeScopePrefix(scope: string): string {
  const s = scope.split(sep).join("/").replace(/^\.\//, "").replace(/\/+$/, "");
  return s ? s + "/" : "";
}

export function buildGraph(root: string, entry: string, scope?: string): RepoGraph {
  const scopePrefix = scope ? normalizeScopePrefix(scope) : null;
  const files = collect(root).filter((f) => !scopePrefix || f.startsWith(scopePrefix));
  const fileset = new Set(files);
  const edgeSet = new Set<string>();
  const edges: Array<[string, string]> = [];
  const unresolved: Array<[string, string]> = [];
  const pathsConfig = loadPathsConfig(root);
  const workspaceMap = loadWorkspaceMap(root);

  for (const f of files) {
    const src = readFileSync(join(root, f), "utf-8");
    const specs = extractSpecs(src);
    for (const s of specs) {
      const r = resolveSpec(root, fileset, f, s, pathsConfig, workspaceMap);
      if (r === false) {
        unresolved.push([f, s]);
      } else if (r && r !== f) {
        const key = `${f}\u0000${r}`;
        if (!edgeSet.has(key)) {
          edgeSet.add(key);
          edges.push([f, r]);
        }
      }
    }
  }

  const fanIn = new Map(files.map((f) => [f, 0]));
  const fanOut = new Map(files.map((f) => [f, 0]));
  for (const [a, b] of edges) {
    fanOut.set(a, (fanOut.get(a) ?? 0) + 1);
    fanIn.set(b, (fanIn.get(b) ?? 0) + 1);
  }

  const dist = bfsDist(files, edges, entry);

  const perFile: FileMetrics[] = files.map((f) => ({
    file: f,
    fanIn: fanIn.get(f) ?? 0,
    fanOut: fanOut.get(f) ?? 0,
    distFromEntry: dist.get(f) ?? null,
  }));

  return { root, entry, files, edges, unresolved, perFile };
}

function bfsDist(
  files: string[],
  edges: Array<[string, string]>,
  rootFile: string
): Map<string, number | null> {
  const adj = new Map<string, string[]>(files.map((f) => [f, []]));
  for (const [a, b] of edges) {
    adj.get(a)?.push(b);
  }
  const dist = new Map<string, number | null>(files.map((f) => [f, null]));
  if (!dist.has(rootFile)) return dist;
  dist.set(rootFile, 0);
  const q: string[] = [rootFile];
  while (q.length) {
    const u = q.shift()!;
    for (const v of adj.get(u) ?? []) {
      if (dist.get(v) === null) {
        dist.set(v, (dist.get(u) as number) + 1);
        q.push(v);
      }
    }
  }
  return dist;
}
