import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

// A clean `rm -rf dist && tsc` rebuild is the single biggest per-mutant cost
// on a real TS repo (measured on ajv: ~10-20s of the ~30-90s per mutant,
// for a ONE-CHARACTER change). `tsc --watch` recompiles incrementally on
// each file-save instead, so the fix is: start one long-lived watch process
// before the mutation loop begins, then just wait for it to catch up after
// each mutant is written to disk, instead of invoking `tsc` fresh.
//
// This module only drives the watcher and detects when a recompile has
// settled — it does not decide what test command to run afterward. The
// caller (validate.ts / cli.ts) is responsible for passing a `testCommand`
// that does NOT itself rebuild (e.g. `mocha dist/**/*.test.js`, not
// `npm run build && mocha ...`) when using this mode; `tsc --watch` already
// keeps `dist` current.
//
// Detection is text-matching on tsc's own watch-mode status lines rather
// than a file-system or IPC signal, because `--watch` has no other
// completion hook. This is a disclosed heuristic, not a guarantee: it
// assumes tsc's English status-message wording (locale-independent by
// default) and a debounce window wide enough that our write lands before
// the watcher's next `start` message. Both hold in practice; neither is
// enforced.
const RECOMPILE_START_MARKER = "Starting incremental compilation";
const RECOMPILE_READY_MARKER = "Watching for file changes.";

export interface TscWatcherOptions {
  root: string;
  /** Path to the tsconfig to build, relative to `root`. Default "tsconfig.json". */
  tsconfigPath?: string;
  /** Raw tsc watch output, forwarded line-by-line for progress logging. */
  onOutput?: (text: string) => void;
}

/**
 * Drives one persistent `tsc --watch` process for the lifetime of a
 * `validate` run. Call `start()` once, `waitForRecompile()` after each
 * mutant is written (or reverted) to disk, and `stop()` when done.
 */
export class TscWatcher {
  private proc: ChildProcess | null = null;
  private startCount = 0;
  private readyCount = 0;
  private startWaiters: Array<() => void> = [];
  private readyWaiters: Array<() => void> = [];
  private exited = false;
  private exitError: Error | null = null;
  private stopped = false;

  constructor(private readonly opts: TscWatcherOptions) {}

  /**
   * Spawn `tsc --watch` and resolve once its FIRST build finishes (i.e.
   * the first "Watching for file changes." line). Rejects if tsc exits
   * or the initial build doesn't settle within `timeoutMs`.
   */
  start(timeoutMs = 60000): Promise<void> {
    const tsconfig = this.opts.tsconfigPath ?? "tsconfig.json";
    return new Promise((resolvePromise, reject) => {
      // Prefer the project's own installed tsc over `npx tsc`: it's faster
      // to start (no resolution step), avoids `npx` prompting to install a
      // package on a cold cache (which would hang forever waiting on
      // stdin nothing is ever written to), and avoids silently picking up
      // a differently-versioned global tsc than the one the project
      // actually depends on. `npx --yes` is the fallback for a repo with
      // no local install, and is itself non-interactive.
      const localTsc = join(this.opts.root, "node_modules", ".bin", process.platform === "win32" ? "tsc.cmd" : "tsc");
      const [cmd, args] = existsSync(localTsc)
        ? [localTsc, ["--watch", "--preserveWatchOutput", "-p", tsconfig]]
        : ["npx", ["--yes", "tsc", "--watch", "--preserveWatchOutput", "-p", tsconfig]];

      const proc = spawn(cmd, args, {
        cwd: this.opts.root,
        shell: true,
      });
      this.proc = proc;

      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.stop();
        reject(new Error(`tsc --watch did not complete its initial build within ${timeoutMs}ms`));
      }, timeoutMs);

      const onData = (chunk: Buffer) => {
        // Once stop() has been called, nothing in this process is waiting
        // on marker counts anymore, and the caller (worker-pool.ts) may
        // already be deleting this slot's directory — a late-arriving
        // chunk describing that (tsc's own watcher noticing its files
        // disappearing) is noise about a run that already finished, not
        // a new fact worth logging or counting.
        if (this.stopped) return;
        const text = chunk.toString("utf-8");
        this.opts.onOutput?.(text);
        this.consume(text);
        if (!settled && text.includes(RECOMPILE_READY_MARKER)) {
          settled = true;
          clearTimeout(timer);
          resolvePromise();
        }
      };
      proc.stdout?.on("data", onData);
      proc.stderr?.on("data", onData);

      proc.on("error", (err) => {
        this.exited = true;
        this.exitError = err;
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(err);
        }
      });
      proc.on("exit", (code) => {
        this.exited = true;
        this.exitError = new Error(`tsc --watch exited early (code ${code})`);
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(this.exitError);
        }
        this.flushAll();
      });
    });
  }

  /** Feed raw output into the marker counters, waking any waiters. */
  private consume(text: string): void {
    if (text.includes(RECOMPILE_START_MARKER)) {
      this.startCount++;
      const waiters = this.startWaiters;
      this.startWaiters = [];
      waiters.forEach((w) => w());
    }
    if (text.includes(RECOMPILE_READY_MARKER)) {
      this.readyCount++;
      const waiters = this.readyWaiters;
      this.readyWaiters = [];
      waiters.forEach((w) => w());
    }
  }

  private flushAll(): void {
    const s = this.startWaiters;
    const r = this.readyWaiters;
    this.startWaiters = [];
    this.readyWaiters = [];
    s.forEach((w) => w());
    r.forEach((w) => w());
  }

  /**
   * Wait for the recompile triggered by a file write that happens right
   * before this call: first the NEXT "starting incremental compilation"
   * line (proof tsc noticed the change), then the NEXT "watching for file
   * changes" line after that (proof it settled). Waiting for the pair,
   * not just a ready-count bump, avoids resolving on a stale build that
   * had already finished before this call.
   */
  waitForRecompile(timeoutMs = 20000): Promise<void> {
    if (this.exited) return Promise.reject(this.exitError ?? new Error("tsc --watch already exited"));
    const startBefore = this.startCount;
    return new Promise((resolveWait, reject) => {
      const deadline = Date.now() + timeoutMs;
      const onTimeout = () => reject(new Error(`tsc --watch did not recompile within ${timeoutMs}ms`));
      let timer = setTimeout(onTimeout, timeoutMs);

      const afterStart = () => {
        if (this.readyCount > readyBefore) {
          clearTimeout(timer);
          resolveWait();
          return;
        }
        clearTimeout(timer);
        const remaining = Math.max(0, deadline - Date.now());
        timer = setTimeout(onTimeout, remaining);
        this.readyWaiters.push(() => {
          clearTimeout(timer);
          resolveWait();
        });
      };

      const readyBefore = this.readyCount;
      if (this.startCount > startBefore) {
        afterStart();
        return;
      }
      this.startWaiters.push(afterStart);
    });
  }

  /** Send SIGTERM and resolve once the process has actually exited (or
   * immediately if it already had, or after a short grace period if it
   * won't die politely). Callers that remove the watched directory right
   * after `stop()` — as `worker-pool.ts`'s `destroy()` does — need this
   * to actually wait, not just fire-and-forget `kill()`: tsc's own file
   * watcher notices the directory disappearing out from under a still-
   * alive process and logs a spurious "cannot read tsconfig.json" error
   * for a run that's already finished successfully.
   */
  stop(): Promise<void> {
    this.stopped = true;
    const proc = this.proc;
    this.proc = null;
    if (!proc || proc.exitCode !== null || proc.killed) return Promise.resolve();
    return new Promise((resolveStop) => {
      const done = () => resolveStop();
      // 'close' (not 'exit') is what guarantees the child's stdout/stderr
      // pipes have finished delivering their last buffered chunks to our
      // 'data' listeners — 'exit' can fire while a final chunk is still
      // in flight, which previously showed up as a spurious "cannot read
      // tsconfig.json" log line arriving just after this function had
      // already let the caller delete the directory.
      proc.once("close", done);
      proc.kill();
      setTimeout(() => {
        proc.off("close", done);
        resolveStop();
      }, 2000);
    });
  }
}
