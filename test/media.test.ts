/*
  Media gathering: only real media, no icon junk, no chat-export dumps, and
  everything lands under one review folder instead of its original location.
*/

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { explain, scanProfile } from "../src/scan.ts";
import { Manifest } from "../src/manifest.ts";
import { packAll } from "../src/pack.ts";
import { detectMachine, type MachineProfile } from "../src/portable.ts";
import type { Profile } from "../src/profiles.ts";

const ROOT = join(tmpdir(), `wm-media-${process.pid}`);
const SRC = join(ROOT, "Downloads");
const OUT = join(ROOT, "backup");

function put(rel: string, bytes: number): void {
  const abs = join(SRC, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, Buffer.alloc(bytes, 7));
}

const profile: Profile = {
  name: "personal-media",
  description: "test",
  rules: [
    {
      path: SRC,
      includeExt: [".jpg", ".png", ".psd", ".mp4", ".gif"],
      minFileSize: 10 * 1024,
      exclude: ["DataExport_*"],
      store: true,
      relocateTo: "{{VOL:DISK_D}}\\Media-Inbox\\Downloads",
    },
  ],
};

beforeAll(() => {
  mkdirSync(SRC, { recursive: true });
  put("logo.psd", 40 * 1024);
  put("avatar.png", 30 * 1024);
  put("clip.mp4", 50 * 1024);
  put("photos/holiday.jpg", 25 * 1024);
  put("favicon.png", 2 * 1024);              // below minFileSize
  put("notes.txt", 40 * 1024);               // wrong extension
  put("archive.zip", 90 * 1024);             // wrong extension
  put("DataExport_2024-08-27/chat/a.jpg", 60 * 1024); // excluded dump
});

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

describe("selection", () => {
  test("keeps only media above the size floor, outside excluded dumps", () => {
    const names = scanProfile(profile).map((f) => f.abs.slice(SRC.length + 1).replace(/\\/g, "/")).sort();
    expect(names).toEqual(["avatar.png", "clip.mp4", "logo.psd", "photos/holiday.jpg"]);
  });

  test("a tiny icon is not mistaken for a logo", () => {
    expect(scanProfile(profile).some((f) => f.abs.endsWith("favicon.png"))).toBe(false);
  });

  test("chat exports are excluded by the trailing-wildcard rule", () => {
    expect(scanProfile(profile).some((f) => f.abs.includes("DataExport_"))).toBe(false);
  });

  test("non-media files never enter the profile", () => {
    const exts = scanProfile(profile).map((f) => f.abs.slice(f.abs.lastIndexOf(".")));
    expect(exts).not.toContain(".txt");
    expect(exts).not.toContain(".zip");
  });
});

describe("explaining a single file's fate", () => {
  const rule = profile.rules[0]!;

  test("a real artwork is accepted with its reason", () => {
    const r = explain(join(SRC, "marci_logo.png"), rule, 2.2 * 1024 * 1024);
    expect(r.included).toBe(true);
  });

  test("a library icon is rejected by the size floor, and says so", () => {
    const r = explain(join(SRC, "iconly-glass-shield.svg"), rule, 9.5 * 1024);
    expect(r.included).toBe(false);
    expect(r.reason).toContain("порога");
  });

  test("a wrong extension is rejected naming the extension", () => {
    const r = explain(join(SRC, "installer.exe"), rule, 5 * 1024 * 1024);
    expect(r.included).toBe(false);
    expect(r.reason).toContain(".exe");
  });

  test("a file outside the rule's root is reported as out of scope", () => {
    const r = explain("C:\\Elsewhere\\photo.jpg", rule, 500 * 1024);
    expect(r.included).toBe(false);
    expect(r.reason).toBe("вне области правила");
  });

  test("a chat-export attachment is rejected even though it is a real photo", () => {
    const r = explain(join(SRC, "DataExport_2024-08-27", "chat", "a.jpg"), rule, 600 * 1024);
    expect(r.included).toBe(false);
    expect(r.reason).toContain("exclude");
  });
});

describe("gathering into one review folder", () => {
  let machine: MachineProfile;

  test("every file is stored under the review root, keeping its subtree", async () => {
    machine = await detectMachine();
    const mf = new Manifest(OUT);
    mf.saveMachine(machine);
    const files = scanProfile(profile);
    const res = await packAll(files, mf, machine, { concurrency: 4, dryRun: false });
    expect(res.errors).toEqual([]);

    const portables = mf.entries(["personal-media"]).map((e) => e.portable).sort();
    expect(portables).toEqual([
      "{{VOL:DISK_D}}\\Media-Inbox\\Downloads\\avatar.png",
      "{{VOL:DISK_D}}\\Media-Inbox\\Downloads\\clip.mp4",
      "{{VOL:DISK_D}}\\Media-Inbox\\Downloads\\logo.psd",
      "{{VOL:DISK_D}}\\Media-Inbox\\Downloads\\photos\\holiday.jpg",
    ]);
    // Nothing points back at the user profile, so a restore cannot scatter them again.
    expect(portables.some((p) => p.includes("{{HOME}}"))).toBe(false);
    mf.close();
  });
});
