/*
  The async scan exists so a long walk can be interrupted and can report
  progress. It must produce exactly what the synchronous walk produces —
  a faster scan that quietly collects a different set is worse than a slow one.
*/

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { scanProfile, scanProfileAsync } from "../src/scan.ts";
import type { Profile } from "../src/profiles.ts";

const ROOT = join(tmpdir(), `wm-scan-${process.pid}`);

const profile: Profile = {
  name: "code",
  description: "test",
  rules: [{ path: ROOT, exclude: ["node_modules"], maxFileSize: 1024 * 1024 }],
};

beforeAll(() => {
  // Enough files to cross the yield threshold more than once.
  for (let d = 0; d < 8; d++) {
    const dir = join(ROOT, `dir${d}`, "nested");
    mkdirSync(dir, { recursive: true });
    for (let i = 0; i < 700; i++) writeFileSync(join(dir, `f${i}.txt`), "x");
  }
  mkdirSync(join(ROOT, "node_modules", "pkg"), { recursive: true });
  writeFileSync(join(ROOT, "node_modules", "pkg", "index.js"), "should be skipped");
  writeFileSync(join(ROOT, "huge.bin"), Buffer.alloc(2 * 1024 * 1024));
});

afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

describe("async scan matches the synchronous one", () => {
  test("same files, same order-independent set", async () => {
    const sync = scanProfile(profile).map((f) => f.abs).sort();
    const async_ = (await scanProfileAsync(profile)).map((f) => f.abs).sort();
    expect(async_.length).toBe(sync.length);
    expect(async_).toEqual(sync);
  });

  test("excludes and size limits are honoured identically", async () => {
    const files = await scanProfileAsync(profile);
    expect(files.some((f) => f.abs.includes("node_modules"))).toBe(false);
    expect(files.some((f) => f.abs.endsWith("huge.bin"))).toBe(false);
  });
});

describe("interruption", () => {
  test("an already-aborted signal stops before doing work", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(scanProfileAsync(profile, { signal: ctrl.signal })).rejects.toThrow(/abort/i);
  });

  test("aborting mid-walk raises AbortError rather than returning partial data", async () => {
    const ctrl = new AbortController();
    const p = scanProfileAsync(profile, {
      signal: ctrl.signal,
      // Abort as soon as the walk yields for the first time.
      onProgress: () => ctrl.abort(),
    });
    await expect(p).rejects.toThrow(/abort/i);
  });

  test("progress is reported during the walk, not only at the end", async () => {
    const seen: number[] = [];
    await scanProfileAsync(profile, { onProgress: (found) => seen.push(found) });
    expect(seen.length).toBeGreaterThan(1);
    expect(seen.at(-1)).toBeGreaterThan(0);
  });
});
