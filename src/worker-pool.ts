import { cpSync, existsSync, mkdtempSync, mkdirSync, symlinkSync, rmSync } from "node:fs";
import { join, basename } from "node:path";
import { tmpdir } from "node:os";
import { TscWatcher } from "./incremental.js";

export interface WorkerSlot {
  id: number;
  /** Isolated copy of the repo root this slot mutates/tests against. */
  dirAbs: string;
  /** Set only when incremental builds are enabled — one watcher per slot. */
  watcher: TscWatcher | null;
  /**
   * Env overrides unique to this slot, merged over process.env for every
   * test run in it: TMPDIR/TEMP/TMP point at a subdirectory of `dirAbs`
   * (instead of every slot sharing the real OS temp dir) and
   * MUTANT_PRIORITY_WORKER_ID is set to `id`. Two common sources of
   * "flaky under --workers but fine alone" are a shared temp file name
   * collision and a test suite that reads a worker-id-like env var to
   * pick a port — this addresses the first directly and gives a test
   * suite the hook it needs to address the second itself.
   */
  env: NodeJS.ProcessEnv;
}

export interface WorkerPoolIncrementalOptions {
  tsconfigPath?: string;
  startTimeoutMs?: number;
}

export interface WorkerPoolOptions {
  root: string;
  count: number;
  incrementalBuild?: WorkerPoolIncrementalOptions;
  onProgress?: (msg: string) => void;
}

export interface WorkerPool {
  slots: WorkerSlot[];
  /** Stop every slot's watcher and remove its temp directory. Idempotent. */
  destroy(): Promise<void>;
}

/**
 * Snapshot `root` into `count` isolated temp-directory copies so mutants
 * for different jobs can be applied and tested concurrently without
 * stepping on each other's file writes. `.git` and `node_modules` are
 * excluded from the copy: `.git` isn't needed to run tests, and
 * `node_modules` is symlinked back in instead of duplicated — mutation
 * testing never writes there, so sharing one real install across all
 * slots is both faster to set up and lighter on disk than reinstalling
 * per slot.
 *
 * This is a deliberately simpler alternative to `git worktree`: it works
 * identically in a non-git repo, and it captures the working tree
 * EXACTLY as it stands right now — including uncommitted and untracked
 * changes — where `git worktree add` only checks out a committed ref
 * and would silently drop local edits unless the diff were reapplied on
 * top afterward. The tradeoff is copy time and disk for a very large
 * repo; a `git worktree` + reapplied-diff variant is a possible
 * follow-up for repos where that copy cost dominates, not implemented
 * here.
 *
 * A side effect worth knowing: because mutants are applied inside these
 * copies, `root` itself is never written to in parallel mode at all — the
 * crash-recovery concern that `checkpoint.ts`'s "known original" tracking
 * exists for (a killed process leaving the REAL working tree mutated)
 * simply doesn't arise here; a crash mid-run just abandons a temp
 * directory that nothing else in the working tree ever depended on.
 */
export async function createWorkerPool(opts: WorkerPoolOptions): Promise<WorkerPool> {
  const { root, count, incrementalBuild, onProgress } = opts;
  const log = onProgress ?? (() => {});
  const slots: WorkerSlot[] = [];

  try {
    for (let i = 0; i < count; i++) {
      const dirAbs = mkdtempSync(join(tmpdir(), "mutant-priority-worker-"));
      log(`[worker ${i}] snapshotting repo into ${dirAbs}...`);
      cpSync(root, dirAbs, {
        recursive: true,
        filter: (src: string) => {
          const name = basename(src);
          return name !== ".git" && name !== "node_modules";
        },
      });

      const nodeModules = join(root, "node_modules");
      if (existsSync(nodeModules)) {
        symlinkSync(nodeModules, join(dirAbs, "node_modules"), "dir");
      }

      let watcher: TscWatcher | null = null;
      if (incrementalBuild) {
        watcher = new TscWatcher({
          root: dirAbs,
          tsconfigPath: incrementalBuild.tsconfigPath,
          onOutput: (t) => log(`[worker ${i}][tsc --watch] ${t.trim()}`),
        });
        await watcher.start(incrementalBuild.startTimeoutMs ?? 60000);
      }

      const tmpAbs = join(dirAbs, ".mutant-priority-tmp");
      mkdirSync(tmpAbs, { recursive: true });
      const env: NodeJS.ProcessEnv = {
        TMPDIR: tmpAbs,
        TEMP: tmpAbs,
        TMP: tmpAbs,
        MUTANT_PRIORITY_WORKER_ID: String(i),
      };

      slots.push({ id: i, dirAbs, watcher, env });
    }
  } catch (err) {
    // Partial pool creation failed — tear down whatever DID get created
    // rather than leaking temp directories and orphaned watch processes.
    for (const slot of slots) {
      await slot.watcher?.stop();
      try {
        rmSync(slot.dirAbs, { recursive: true, force: true });
      } catch {
        /* best-effort cleanup */
      }
    }
    throw err;
  }

  return {
    slots,
    async destroy() {
      for (const slot of slots) {
        await slot.watcher?.stop();
        try {
          rmSync(slot.dirAbs, { recursive: true, force: true });
        } catch {
          /* best-effort cleanup */
        }
      }
    },
  };
}

/**
 * Run `worker` over every item in `items`, at most `slots.length` at a
 * time, one slot per concurrent job. Results are returned in the same
 * order as `items` regardless of which order jobs actually finish in.
 * Deliberately simple (a shared cursor + one loop per slot) rather than
 * a queue/library — this is the entire scheduling need here: a fixed
 * pool pulling from a static list, no dynamic job submission mid-run.
 */
export async function runPool<T, R>(
  items: T[],
  slots: WorkerSlot[],
  worker: (item: T, slot: WorkerSlot) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;

  async function drain(slot: WorkerSlot): Promise<void> {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      results[i] = await worker(items[i], slot);
    }
  }

  await Promise.all(slots.map((slot) => drain(slot)));
  return results;
}
