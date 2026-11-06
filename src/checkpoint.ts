import { readFileSync, appendFileSync, existsSync } from "node:fs";

/**
 * One completed mutant's outcome, persisted immediately after it runs so a
 * `validate --checkpoint <path>` run can resume after a crash (including a
 * hard `kill -9` or a sandbox reset that kills the process but leaves disk
 * intact) without re-running mutants already recorded, and without
 * re-confirming the baseline test suite a second time in the same tree.
 *
 * `start` (the mutant's character offset into its file) is the resume key,
 * not `line` — two mutants on the same line (e.g. `a + b - c` has both a
 * `+` and a `-` candidate on one line) would otherwise collide.
 */
export interface OutcomeRecord {
  type: "outcome";
  strategy: string;
  file: string;
  start: number;
  line: number; // kept for human-readable logs; not part of the resume key
  kind: string;
  status: "Killed" | "Survived" | "Error" | "Flaky";
}

/**
 * A file's pristine content, captured the FIRST time this checkpoint
 * lineage is about to mutate it — before any mutation happens. This
 * exists to fix a real crash scenario: `runOneMutant` writes the mutated
 * file to disk, then reverts it in a `finally` block, but a `SIGKILL` (or
 * an environment reset that kills the process the same way) can't be
 * caught, so the `finally` never runs and the file is left mutated on
 * disk. Without this record, a resumed run would read that mutated
 * content back as if it were the pristine source, compute mutant
 * candidates against already-corrupted code, and silently produce
 * meaningless results for every mutant remaining in that file. With it,
 * `validate` can unconditionally restore this content before touching the
 * file again on resume — restoring already-pristine content is a no-op,
 * so this is safe to do whether or not a crash actually happened.
 */
export interface OriginalRecord {
  type: "original";
  file: string;
  content: string;
}

export type CheckpointLine = OutcomeRecord | OriginalRecord;

export function checkpointKey(r: Pick<OutcomeRecord, "strategy" | "file" | "start" | "kind">): string {
  return `${r.strategy}\u0000${r.file}\u0000${r.start}\u0000${r.kind}`;
}

/**
 * Read and parse every line of a checkpoint file. Tolerant of exactly one
 * thing: a truncated/corrupt LAST line, which is what a process killed
 * mid-`appendFileSync` produces — that line represents a write that never
 * completed and is silently dropped. A corrupt line anywhere else in the
 * file is real, unexplained data loss and is NOT silently swallowed: it
 * throws, because guessing which of many lines to discard would make the
 * resume behavior unpredictable exactly when it matters most.
 *
 * Returns an empty array if the file doesn't exist yet.
 */
export function readCheckpointLines(path: string): CheckpointLine[] {
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, "utf-8");
  const lines = raw.split("\n").filter((l: string) => l.trim().length > 0);
  const records: CheckpointLine[] = [];
  for (let i = 0; i < lines.length; i++) {
    try {
      records.push(JSON.parse(lines[i]));
    } catch (err) {
      if (i === lines.length - 1) {
        continue; // truncated last line from a mid-write crash — drop it
      }
      throw new Error(
        `Corrupt checkpoint line ${i + 1} of ${lines.length} in ${path} — ` +
          `not the last line, so this isn't an expected mid-write truncation. ` +
          `Refusing to silently drop it: ${(err as Error).message}`
      );
    }
  }
  return records;
}

/** Convenience: just the outcome records from a checkpoint file. */
export function readCheckpoint(path: string): OutcomeRecord[] {
  return readCheckpointLines(path).filter((l): l is OutcomeRecord => l.type === "outcome");
}

/** Convenience: file -> pristine content, from a checkpoint file's
 * "original" records. If the same file somehow has more than one (it
 * shouldn't — see validate.ts's write-once check), the first one wins,
 * since that's the earliest-known-pristine content. */
export function readOriginals(path: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const l of readCheckpointLines(path)) {
    if (l.type === "original" && !map.has(l.file)) map.set(l.file, l.content);
  }
  return map;
}

/** Append one record as a single JSON line (one write call — the unit a
 * crash can truncate is exactly this line, which readCheckpointLines
 * tolerates for the last line only). */
export function appendCheckpointLine(path: string, record: CheckpointLine): void {
  appendFileSync(path, JSON.stringify(record) + "\n", "utf-8");
}

/** Build the set of resume keys already recorded, for O(1) skip checks. */
export function checkpointKeySet(records: OutcomeRecord[]): Set<string> {
  return new Set(records.map(checkpointKey));
}
