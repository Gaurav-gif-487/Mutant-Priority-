import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync, rmSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createWorkerPool, runPool } from "./worker-pool.js";

function makeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "mutant-priority-pool-repo-"));
  mkdirSync(join(root, "src"));
  mkdirSync(join(root, ".git"));
  mkdirSync(join(root, "node_modules"));
  writeFileSync(join(root, ".git", "HEAD"), "ref: refs/heads/main\n", "utf-8");
  writeFileSync(join(root, "node_modules", "marker.txt"), "installed-dep\n", "utf-8");
  writeFileSync(join(root, "src", "index.js"), "module.exports = 1;\n", "utf-8");
  return root;
}

test("createWorkerPool: snapshots source files into each slot, excluding .git", async () => {
  const root = makeRepo();
  const pool = await createWorkerPool({ root, count: 2 });
  try {
    assert.equal(pool.slots.length, 2);
    for (const slot of pool.slots) {
      assert.equal(readFileSync(join(slot.dirAbs, "src", "index.js"), "utf-8"), "module.exports = 1;\n");
      assert.equal(existsSync(join(slot.dirAbs, ".git")), false);
    }
  } finally {
    await pool.destroy();
    rmSync(root, { recursive: true, force: true });
  }
});

test("createWorkerPool: symlinks node_modules back in rather than copying it", async () => {
  const root = makeRepo();
  const pool = await createWorkerPool({ root, count: 1 });
  try {
    const slot = pool.slots[0];
    const linkPath = join(slot.dirAbs, "node_modules");
    assert.equal(lstatSync(linkPath).isSymbolicLink(), true);
    // The symlink resolves to the SAME install — editing it from the slot's
    // path is visible from root's path too, proving it's shared, not copied.
    assert.equal(readFileSync(join(linkPath, "marker.txt"), "utf-8"), "installed-dep\n");
  } finally {
    await pool.destroy();
    rmSync(root, { recursive: true, force: true });
  }
});

test("createWorkerPool: each slot is an independent copy — writing in one doesn't affect another", async () => {
  const root = makeRepo();
  const pool = await createWorkerPool({ root, count: 2 });
  try {
    const [a, b] = pool.slots;
    writeFileSync(join(a.dirAbs, "src", "index.js"), "module.exports = 999;\n", "utf-8");
    assert.equal(readFileSync(join(b.dirAbs, "src", "index.js"), "utf-8"), "module.exports = 1;\n");
    assert.equal(readFileSync(join(root, "src", "index.js"), "utf-8"), "module.exports = 1;\n");
  } finally {
    await pool.destroy();
    rmSync(root, { recursive: true, force: true });
  }
});

test("createWorkerPool: destroy() removes every slot's temp directory", async () => {
  const root = makeRepo();
  const pool = await createWorkerPool({ root, count: 2 });
  const dirs = pool.slots.map((s) => s.dirAbs);
  await pool.destroy();
  for (const d of dirs) assert.equal(existsSync(d), false);
  rmSync(root, { recursive: true, force: true });
});

test("runPool: every item is processed exactly once, results stay in input order", async () => {
  const root = makeRepo();
  const pool = await createWorkerPool({ root, count: 3 });
  try {
    const items = [10, 20, 30, 40, 50, 60, 70];
    const seenBySlot = new Map<number, number>();
    const results = await runPool(items, pool.slots, async (n, slot) => {
      seenBySlot.set(slot.id, (seenBySlot.get(slot.id) ?? 0) + 1);
      await new Promise((r) => setTimeout(r, 5));
      return n * 2;
    });
    assert.deepEqual(results, items.map((n) => n * 2));
    // With 7 items over 3 slots, work should actually be spread out, not
    // all landing on slot 0 (which would indicate no real concurrency).
    assert.ok(seenBySlot.size > 1);
  } finally {
    await pool.destroy();
    rmSync(root, { recursive: true, force: true });
  }
});

test("runPool: respects the slot count as a concurrency ceiling", async () => {
  const root = makeRepo();
  const pool = await createWorkerPool({ root, count: 2 });
  try {
    let inFlight = 0;
    let maxInFlight = 0;
    const items = Array.from({ length: 6 }, (_, i) => i);
    await runPool(items, pool.slots, async (i) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 10));
      inFlight--;
      return i;
    });
    assert.equal(maxInFlight, 2);
  } finally {
    await pool.destroy();
    rmSync(root, { recursive: true, force: true });
  }
});
