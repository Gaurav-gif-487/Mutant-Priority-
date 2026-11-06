import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, dirname, relative, sep, normalize } from "node:path";

export interface WorkspacePackage {
  name: string;
  dirAbs: string; // absolute path to the package directory
  exports: unknown; // raw package.json "exports" field, if present
  main: string | null; // raw package.json "main"/"module" field, if present
}

export interface WorkspaceMap {
  packages: Map<string, WorkspacePackage>; // package name -> package info
}

/**
 * Discover workspace packages declared in the root `package.json`'s
 * `workspaces` field (npm/yarn array form, or `{ packages: [...] }`
 * yarn-classic object form), or in `pnpm-workspace.yaml`'s `packages:`
 * list. No general YAML parser is used for the pnpm case — just a
 * minimal reader for the one shape that file actually takes in
 * practice (a top-level `packages:` key followed by `- 'glob'` list
 * items); anything more exotic (YAML anchors, nested workspace
 * catalogs, comments mid-line) isn't handled. Only simple trailing-`/*`
 * globs are expanded (e.g. "packages/*"); a literal path entry (e.g.
 * "apps/web") is used as-is. Both cover the overwhelming majority of
 * real workspace configs.
 */
export function loadWorkspaceMap(root: string): WorkspaceMap | null {
  const globs = loadWorkspaceGlobs(root);
  if (!globs || globs.length === 0) return null;

  const packageDirs = new Set<string>();
  for (const g of globs) {
    for (const dir of expandGlob(root, g)) packageDirs.add(dir);
  }

  const packages = new Map<string, WorkspacePackage>();
  for (const dirAbs of packageDirs) {
    const p = join(dirAbs, "package.json");
    if (!existsSync(p)) continue;
    let pkg: any;
    try {
      pkg = JSON.parse(readFileSync(p, "utf-8"));
    } catch {
      continue;
    }
    if (!pkg.name) continue;
    packages.set(pkg.name, {
      name: pkg.name,
      dirAbs,
      exports: pkg.exports ?? null,
      main: pkg.main ?? pkg.module ?? null,
    });
  }

  return packages.size ? { packages } : null;
}

function loadWorkspaceGlobs(root: string): string[] | null {
  const pkgPath = join(root, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const rootPkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
      if (Array.isArray(rootPkg.workspaces)) return rootPkg.workspaces;
      if (rootPkg.workspaces && Array.isArray(rootPkg.workspaces.packages)) {
        return rootPkg.workspaces.packages;
      }
    } catch {
      /* fall through to pnpm-workspace.yaml */
    }
  }

  const pnpmPath = join(root, "pnpm-workspace.yaml");
  if (existsSync(pnpmPath)) {
    try {
      return parsePnpmWorkspaceYaml(readFileSync(pnpmPath, "utf-8"));
    } catch {
      return null;
    }
  }

  return null;
}

/**
 * Minimal reader for pnpm-workspace.yaml's `packages:` list — not a
 * general YAML parser. Handles:
 *   packages:
 *     - 'packages/*'
 *     - "apps/*"
 *     - tools/cli
 * Stops collecting once a line outside the list is reached (next
 * top-level key, blank line followed by dedent, etc.).
 */
function parsePnpmWorkspaceYaml(text: string): string[] {
  const lines = text.split("\n");
  const globs: string[] = [];
  let inPackages = false;
  for (const raw of lines) {
    const line = raw.replace(/\r$/, "");
    if (/^packages:\s*(#.*)?$/.test(line.trim()) && !line.startsWith(" ")) {
      inPackages = true;
      continue;
    }
    if (inPackages) {
      const itemMatch = line.match(/^\s*-\s*(.+?)\s*(#.*)?$/);
      if (itemMatch) {
        let value = itemMatch[1].trim();
        if (
          (value.startsWith("'") && value.endsWith("'")) ||
          (value.startsWith('"') && value.endsWith('"'))
        ) {
          value = value.slice(1, -1);
        }
        if (value) globs.push(value);
        continue;
      }
      // Any non-list-item, non-blank line ends the `packages:` block.
      if (line.trim() !== "") inPackages = false;
    }
  }
  return globs;
}

/** Expand "packages/*" style globs into concrete directories. Only a single
 * trailing `/*` segment is supported; anything else is treated as a literal
 * path (matching how most real workspace configs actually look). */
function expandGlob(root: string, pattern: string): string[] {
  if (pattern.endsWith("/*")) {
    const base = join(root, pattern.slice(0, -2));
    let entries: string[];
    try {
      entries = readdirSync(base);
    } catch {
      return [];
    }
    const dirs: string[] = [];
    for (const name of entries) {
      const full = join(base, name);
      try {
        if (statSync(full).isDirectory()) dirs.push(full);
      } catch {
        /* skip */
      }
    }
    return dirs;
  }
  return [join(root, pattern)];
}

/**
 * Resolve a bare specifier (e.g. `@myorg/utils` or `@myorg/utils/subpath`)
 * against known workspace packages, returning a repo-relative base path
 * (still needing extension expansion) if it matches, or null if `spec`
 * doesn't correspond to any known workspace package.
 */
export function resolveWorkspaceSpec(root: string, ws: WorkspaceMap, spec: string): string | null {
  // Exact package name (subpath "." export) or "<name>/<subpath>"
  let pkgName: string;
  let subpath: string; // "" for the package root, else without leading "/"
  const pkg0 = ws.packages.get(spec);
  if (pkg0) {
    pkgName = spec;
    subpath = "";
  } else {
    // find the longest matching package name prefix followed by "/"
    let matched: string | null = null;
    for (const name of ws.packages.keys()) {
      if (spec.startsWith(name + "/") && (matched === null || name.length > matched.length)) {
        matched = name;
      }
    }
    if (!matched) return null;
    pkgName = matched;
    subpath = spec.slice(matched.length + 1);
  }

  const pkg = ws.packages.get(pkgName)!;
  const target = resolveExportsOrMain(pkg, subpath);
  if (target === null) return null;
  const abs = normalize(join(pkg.dirAbs, target));
  return relative(root, abs).split(sep).join("/");
}

function resolveExportsOrMain(pkg: WorkspacePackage, subpath: string): string | null {
  if (pkg.exports) {
    const key = subpath ? `./${subpath}` : ".";
    const resolved = resolveExportsField(pkg.exports, key);
    if (resolved) return resolved;
    // wildcard subpath export, e.g. "./*": "./src/*.ts"
    if (subpath) {
      const wildcard = resolveExportsWildcard(pkg.exports, subpath);
      if (wildcard) return wildcard;
    }
    return null; // package has an exports map but this subpath isn't exposed
  }
  if (!subpath) return pkg.main ?? "index.js";
  return subpath; // no exports map -> deep imports resolve as plain relative paths
}

function resolveExportsField(exportsField: any, key: string): string | null {
  if (typeof exportsField === "string") {
    return key === "." ? exportsField : null;
  }
  if (typeof exportsField !== "object" || exportsField === null) return null;
  const entry = exportsField[key];
  if (entry === undefined) return null;
  return pickCondition(entry);
}

function resolveExportsWildcard(exportsField: any, subpath: string): string | null {
  if (typeof exportsField !== "object" || exportsField === null) return null;
  for (const [pattern, target] of Object.entries(exportsField)) {
    if (!pattern.startsWith("./") || !pattern.includes("*")) continue;
    const prefix = pattern.slice(2, pattern.indexOf("*"));
    const suffix = pattern.slice(pattern.indexOf("*") + 1);
    if (subpath.startsWith(prefix) && subpath.endsWith(suffix)) {
      const matched = subpath.slice(prefix.length, subpath.length - suffix.length);
      const resolved = pickCondition(target);
      if (resolved) return resolved.replace("*", matched);
    }
  }
  return null;
}

function pickCondition(entry: any): string | null {
  if (typeof entry === "string") return entry;
  if (typeof entry !== "object" || entry === null) return null;
  // Preference order favors what a bundler/Node resolving from source
  // would want to land on: prefer "import"/"require" over "default",
  // and prefer either over "types".
  for (const cond of ["import", "require", "node", "default"]) {
    if (typeof entry[cond] === "string") return entry[cond];
    if (typeof entry[cond] === "object") {
      const nested = pickCondition(entry[cond]);
      if (nested) return nested;
    }
  }
  return null;
}
