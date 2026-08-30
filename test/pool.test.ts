/*
  The transfer pool must bound memory, not just parallelism.

  Real failure this prevents: the backup contains a 4 GB blob; with 32 slots
  counted by file, large objects filled every slot at once and the process grew
  to 13 GB RSS.
*/

import { describe, expect, test } from "bun:test";
import { pool } from "../src/r2.ts";

const MB = 1024 * 1024;

/** Runs the pool while tracking peak concurrent "bytes in flight". */
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
      // Charged the same way the pool charges: streamed items book at most 32 MB.
      const cost = Math.min(t.size, 32 * MB);
      inFlight += cost;
      live++;
      peakBytes = Math.max(peakBytes, inFlight);
      peakCount = Math.max(peakCount, live);
      await new Promise((r) => setTimeout(r, 3));
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
    expect(r.peakCount).toBeGreaterThan(8);
  });

  test("large files do not all start at once", async () => {
    // 40 objects of 64 MB each: unbounded, 32 would start together (2 GB).
    const r = await measure(Array(40).fill(64 * MB), 32);
    expect(r.processed).toBe(40);
    expect(r.peakBytes).toBeLessThanOrEqual(256 * MB);
    expect(r.peakCount).toBeLessThanOrEqual(8);
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
    expect(r.peakBytes).toBeLessThanOrEqual(256 * MB);
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
        await new Promise((r) => setTimeout(r, 1));
      },
      ctrl.signal,
    );
    expect(done).toBeLessThan(500);
  });
});
