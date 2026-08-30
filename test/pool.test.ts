/*
  The transfer pool must bound memory, not just parallelism.

  Real failure this prevents: the backup contains a 4 GB blob; with 32 slots
  counted by file, large objects filled every slot at once and the process grew
  to 13 GB RSS.
*/

import { describe, expect, test } from "bun:test";
import { pool } from "../src/r2.ts";

const MB = 1024 * 1024;

/** The pool charges streamed items at most one part-pair (16 MB). */
const CHARGE = (size: number) => Math.min(size, 16 * MB);
const BUDGET = 128 * MB;

/**
 * Runs the pool while tracking peak concurrent "bytes in flight".
 * Uses a microtask yield rather than a timer: peak values must depend on the
 * pool's own accounting, not on how loaded the machine happens to be.
 */
async function measure(sizes: number[], limit: number) {
  let inFlight = 0;
  let peakBytes = 0;
  let peakCount = 0;
  let live = 0;
  let processed = 0;

  await pool(
    sizes.map((size, id) => ({ id, size })),
    limit,
    (t) => t.size,
    async (t) => {
      const cost = CHARGE(t.size);
      inFlight += cost;
      live++;
      peakBytes = Math.max(peakBytes, inFlight);
      peakCount = Math.max(peakCount, live);
      await Promise.resolve();
      await Promise.resolve();
      inFlight -= cost;
      live--;
      processed++;
    },
  );
  return { peakBytes, peakCount, processed };
}

describe("memory-bounded transfer pool", () => {
  test("many small files run at full parallelism", async () => {
    const r = await measure(Array(200).fill(64 * 1024), 32);
    expect(r.processed).toBe(200);
    // Small items cost almost nothing, so the file-count limit is what binds.
    expect(r.peakCount).toBeGreaterThan(1);
    expect(r.peakCount).toBeLessThanOrEqual(32);
  });

  test("large files do not all start at once", async () => {
    // 40 objects of 64 MB each: unbounded, 32 would start together (2 GB).
    const r = await measure(Array(40).fill(64 * MB), 32);
    expect(r.processed).toBe(40);
    expect(r.peakBytes).toBeLessThanOrEqual(BUDGET);
  });

  test("a single object larger than the budget still runs", async () => {
    const r = await measure([4096 * MB], 32);
    expect(r.processed).toBe(1);
  });

  test("an oversized object does not deadlock the files after it", async () => {
    const r = await measure([4096 * MB, ...Array(50).fill(1 * MB)], 32);
    expect(r.processed).toBe(51);
  });

  test("mixed workload stays inside the budget", async () => {
    const sizes = [];
    for (let i = 0; i < 300; i++) sizes.push(i % 25 === 0 ? 200 * MB : 128 * 1024);
    const r = await measure(sizes, 32);
    expect(r.processed).toBe(300);
    expect(r.peakBytes).toBeLessThanOrEqual(BUDGET);
  });

  test("every item is processed exactly once", async () => {
    const seen = new Set<number>();
    let dupes = 0;
    await pool(
      Array.from({ length: 500 }, (_, id) => ({ id, size: 1024 })),
      16,
      (t) => t.size,
      async (t) => {
        if (seen.has(t.id)) dupes++;
        seen.add(t.id);
      },
    );
    expect(seen.size).toBe(500);
    expect(dupes).toBe(0);
  });

  test("an abort signal stops the pool early", async () => {
    const ctrl = new AbortController();
    let done = 0;
    await pool(
      Array.from({ length: 500 }, (_, id) => ({ id, size: 1024 })),
      8,
      (t) => t.size,
      async () => {
        done++;
        if (done === 20) ctrl.abort();
        await Promise.resolve();
      },
      ctrl.signal,
    );
    // Workers finish the item in hand, so a small overshoot past 20 is expected.
    expect(done).toBeLessThan(100);
  });
});
