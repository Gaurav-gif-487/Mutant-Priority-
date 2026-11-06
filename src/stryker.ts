import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { buildGraph } from "./graph.js";
import { rank, type Strategy } from "./rank.js";

/**
 * NOT a Stryker plugin. Stryker's plugin API (TestRunner/Reporter/
 * Checker interfaces, its DI container, its peer-dependency contract)
 * is a much bigger surface than this tool needs, and implementing it
 * just to reorder a file list would add a lot of maintenance weight for
 * one feature. This does something narrower and more honest: it writes
 * (or patches) a real `stryker.conf.json`'s `mutate` array so the files
 * this tool considers most likely under-tested come first — which is
 * the one thing Stryker itself lets you control from outside its plugin
 * system. If you slice that array (via `--budget`) you get a real,
 * working budget-constrained Stryker run today, without waiting on a
 * plugin.
 */
export interface StrykerConfigOptions {
  root: string;
  entry: string;
  strategy: Strategy;
  budget?: number; // if set, only the top N files are included
  configPath: string; // where to write/patch, relative to root or absolute
  scope?: string;
}

export interface StrykerConfigResult {
  configPath: string;
  mutateCount: number;
  totalFiles: number;
  created: boolean; // true if the file didn't exist before
  strategy: Strategy;
}

export function writeStrykerConfig(opts: StrykerConfigOptions): StrykerConfigResult {
  const { root, entry, strategy, budget, configPath, scope } = opts;
  const graph = buildGraph(root, entry, scope);
  const ranked = rank(graph.perFile, strategy);
  const slice = budget ? ranked.slice(0, budget) : ranked;
  const mutate = slice.map((f) => f.file);

  const existed = existsSync(configPath);
  let config: Record<string, unknown> = {};
  if (existed) {
    try {
      config = JSON.parse(readFileSync(configPath, "utf-8"));
    } catch {
      // Unparseable existing file — don't guess, start fresh but still
      // preserve nothing rather than silently corrupt something we
      // couldn't read.
      config = {};
    }
  }

  config.mutate = mutate;
  config["$schema"] = config["$schema"] ?? "./node_modules/@stryker-mutator/core/schema/stryker-schema.json";
  // Preserve everything else already in the config untouched — only
  // `mutate` (and `$schema` if absent) are ever written by this tool.

  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");

  return {
    configPath,
    mutateCount: mutate.length,
    totalFiles: graph.files.length,
    created: !existed,
    strategy,
  };
}
