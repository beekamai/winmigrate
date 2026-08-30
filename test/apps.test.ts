/*
  Guards the locked-application warning. The failure it prevents: a backup that
  stalls forever with no CPU and no I/O because a running app holds a file.
*/

import { describe, expect, test } from "bun:test";
import { LOCKERS } from "../src/apps.ts";
import { allProfileNames } from "../src/profiles.ts";

describe("locker definitions stay in sync with the profiles", () => {
  test("every referenced profile actually exists", () => {
    const known = new Set(allProfileNames());
    for (const l of LOCKERS) {
      for (const p of l.profiles) {
        expect(known.has(p), `${l.label} ссылается на несуществующий профиль "${p}"`).toBe(true);
      }
    }
  });

  test("each entry names at least one process and one profile", () => {
    for (const l of LOCKERS) {
      expect(l.processes.length, l.label).toBeGreaterThan(0);
      expect(l.profiles.length, l.label).toBeGreaterThan(0);
      expect(l.reason.length, l.label).toBeGreaterThan(0);
    }
  });

  test("process names carry no .exe suffix and no path", () => {
    for (const l of LOCKERS) {
      for (const p of l.processes) {
        expect(p).not.toContain(".exe");
        expect(p).not.toContain("\\");
        expect(p).toBe(p.toLowerCase());
      }
    }
  });

  test("the browser that actually caused the freeze is covered", () => {
    const chrome = LOCKERS.find((l) => l.processes.includes("chrome"));
    expect(chrome).toBeDefined();
    expect(chrome!.profiles).toContain("browsers");
  });

  test("messenger sessions are covered, since a half-copied session is useless", () => {
    const names = LOCKERS.flatMap((l) => l.processes);
    expect(names).toContain("telegram");
    expect(names).toContain("discord");
  });
});
