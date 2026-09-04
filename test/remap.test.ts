/*
  The scenario that motivates this tool: restoring onto a machine where the
  username changed and drive letters moved. History and configs must follow.
*/

import { describe, expect, test } from "bun:test";
import { encodeClaudeProject, rewriteProjectSegment, rewriteText, type RewriteContext } from "../src/rewrite.ts";
import {
  fromPortable, toPortable, pathVariants, parseRelocation, relocate,
  type MachineProfile, type Relocation,
} from "../src/portable.ts";
import { decrypt, encrypt } from "../src/crypto.ts";

const OLD: MachineProfile = {
  user: "Jaros",
  home: "C:\\Users\\Jaros",
  appdata: "C:\\Users\\Jaros\\AppData\\Roaming",
  localAppdata: "C:\\Users\\Jaros\\AppData\\Local",
  programFiles: "C:\\Program Files",
  programData: "C:\\ProgramData",
  volumes: [
    { guid: "g1", label: "", letter: "C", sizeBytes: 1, role: "SYSTEM" },
    { guid: "g2", label: "", letter: "D", sizeBytes: 1, role: "DISK_D" },
  ],
};

// New PC: different user, and the old D: drive now shows up as E:
const NEW: MachineProfile = {
  user: "mara",
  home: "C:\\Users\\mara",
  appdata: "C:\\Users\\mara\\AppData\\Roaming",
  localAppdata: "C:\\Users\\mara\\AppData\\Local",
  programFiles: "C:\\Program Files",
  programData: "C:\\ProgramData",
  volumes: [
    { guid: "n1", label: "", letter: "C", sizeBytes: 1, role: "SYSTEM" },
    { guid: "n2", label: "", letter: "E", sizeBytes: 1, role: "DISK_D" },
  ],
};

function ctx(relocations: Relocation[] = []): RewriteContext {
  return {
    relocations,
    oldUser: OLD.user,
    oldHome: OLD.home,
    oldVolumes: { SYSTEM: "C:", DISK_D: "D:" },
    target: NEW,
    volumeMap: {},
    projectMap: {
      // Encoded folder name -> portable project path, as captured at backup time.
      "C--Users-Jaros-Desktop-Fia-Billing-fia-li-fia-li-v2": "{{HOME}}\\Desktop\\Fia Billing\\fia_li\\fia_li_v2",
      "D--CodeWorks": "{{VOL:DISK_D}}\\CodeWorks",
      "d---Stable-Diffusion": "{{VOL:DISK_D}}\\!Stable_Diffusion",
    },
  };
}

describe("Claude project folder encoding", () => {
  test("matches the real folder names observed on disk", () => {
    expect(encodeClaudeProject("D:\\CodeWorks")).toBe("D--CodeWorks");
    expect(encodeClaudeProject("d:\\!Stable_Diffusion")).toBe("d---Stable-Diffusion");
    expect(encodeClaudeProject("C:\\Users\\Jaros\\Desktop\\Fia Billing\\fia_li\\fia_li_v2"))
      .toBe("C--Users-Jaros-Desktop-Fia-Billing-fia-li-fia-li-v2");
    expect(encodeClaudeProject("C:\\Windows\\System32")).toBe("C--Windows-System32");
  });
});

describe("history folders follow the project to its new location", () => {
  test("username change rewrites the encoded folder", () => {
    const src = "{{HOME}}\\.claude\\projects\\C--Users-Jaros-Desktop-Fia-Billing-fia-li-fia-li-v2\\a1b2.jsonl";
    const out = rewriteProjectSegment(src, ctx());
    expect(out).toBe("{{HOME}}\\.claude\\projects\\C--Users-mara-Desktop-Fia-Billing-fia-li-fia-li-v2\\a1b2.jsonl");
  });

  test("drive letter change rewrites the encoded folder", () => {
    const src = "{{HOME}}\\.claude\\projects\\D--CodeWorks\\session.jsonl";
    expect(rewriteProjectSegment(src, ctx()))
      .toBe("{{HOME}}\\.claude\\projects\\E--CodeWorks\\session.jsonl");
  });

  test("lowercase drive duplicates fold into one canonical folder", () => {
    // Claude Code treats d:/ and D:/ as different projects; restoring normalises them.
    const src = "{{HOME}}\\.claude\\projects\\d---Stable-Diffusion\\s.jsonl";
    expect(rewriteProjectSegment(src, ctx()))
      .toBe("{{HOME}}\\.claude\\projects\\E---Stable-Diffusion\\s.jsonl");
  });

  test("unknown project folders are left untouched rather than mangled", () => {
    const src = "{{HOME}}\\.claude\\projects\\Z--Somewhere-Unknown\\s.jsonl";
    expect(rewriteProjectSegment(src, ctx())).toBe(src);
  });
});

describe("config contents are retargeted in every spelling", () => {
  test("backslash, forward-slash and escaped paths all get rewritten", () => {
    const json = JSON.stringify({
      a: "C:\\Users\\Jaros\\.claude",
      b: "C:/Users/Jaros/Desktop/Fia Billing",
      c: "D:/CodeWorks/citadel",
      d: "d:/CodeWorks/vpn_base",
    });
    const out = rewriteText(json, ctx());
    expect(out).not.toContain("Jaros");
    expect(out).toContain("C:/Users/mara/Desktop/Fia Billing");
    expect(out).toContain("E:/CodeWorks/citadel");
  });

  test("MCP server absolute paths survive the move", () => {
    const cfg = '{"command":"node","args":["D:\\\\CodeWorks\\\\mcp-screenshot\\\\dist\\\\index.js"]}';
    const out = rewriteText(cfg, ctx());
    expect(out).toContain("E:\\\\CodeWorks\\\\mcp-screenshot");
  });

  test("home wins over the volume prefix it lives under", () => {
    const out = rewriteText("C:\\Users\\Jaros\\x", ctx());
    expect(out).toBe("C:\\Users\\mara\\x");
  });
});

describe("portable path round-trip", () => {
  test("home and volume paths convert both ways", () => {
    const p1 = toPortable("C:\\Users\\Jaros\\.claude\\settings.json", OLD);
    expect(p1).toBe("{{HOME}}\\.claude\\settings.json");
    expect(fromPortable(p1, NEW)).toBe("C:\\Users\\mara\\.claude\\settings.json");

    const p2 = toPortable("D:\\CodeWorks\\citadel", OLD);
    expect(p2).toBe("{{VOL:DISK_D}}\\CodeWorks\\citadel");
    expect(fromPortable(p2, NEW)).toBe("E:\\CodeWorks\\citadel");
  });

  test("LOCALAPPDATA is preferred over the broader HOME prefix", () => {
    expect(toPortable("C:\\Users\\Jaros\\AppData\\Local\\NVIDIA", OLD))
      .toBe("{{LOCALAPPDATA}}\\NVIDIA");
  });

  test("an unmapped volume fails loudly instead of writing to the wrong disk", () => {
    expect(() => fromPortable("{{VOL:ARCHIVE}}\\x", NEW)).toThrow(/Cannot resolve volume role/);
  });

  test("explicit --map overrides auto-detection", () => {
    expect(fromPortable("{{VOL:DISK_D}}\\CodeWorks", NEW, { DISK_D: "Z:" })).toBe("Z:\\CodeWorks");
  });

  test("path variants cover the spellings configs actually use", () => {
    const v = pathVariants("D:\\CodeWorks");
    expect(v).toContain("D:\\CodeWorks");
    expect(v).toContain("D:/CodeWorks");
    expect(v).toContain("D:\\\\CodeWorks");
    expect(v).toContain("d:/CodeWorks");
    // Longest-first ordering prevents a parent prefix from eating a nested match.
    expect(v[0]!.length).toBeGreaterThanOrEqual(v[v.length - 1]!.length);
  });
});

describe("relocating projects off the Desktop", () => {
  // The whole point: projects must land on a data drive, not back on the system
  // disk, and their Claude history must follow them there.
  const OFF_DESKTOP: Relocation[] = [
    { from: "{{HOME}}\\Desktop", to: "{{VOL:DISK_D}}\\Projects" },
  ];

  test("a Desktop file is restored onto the data drive instead", () => {
    const p = relocate("{{HOME}}\\Desktop\\Fia Billing\\src\\main.ts", OFF_DESKTOP);
    expect(p).toBe("{{VOL:DISK_D}}\\Projects\\Fia Billing\\src\\main.ts");
    expect(fromPortable(p, NEW)).toBe("E:\\Projects\\Fia Billing\\src\\main.ts");
  });

  test("Claude history folder is re-encoded to the relocated path", () => {
    const src = "{{HOME}}\\.claude\\projects\\C--Users-Jaros-Desktop-Fia-Billing-fia-li-fia-li-v2\\s.jsonl";
    const out = rewriteProjectSegment(src, ctx(OFF_DESKTOP));
    // D: became E:, and the project no longer lives under the user profile.
    expect(out).toBe("{{HOME}}\\.claude\\projects\\E--Projects-Fia-Billing-fia-li-fia-li-v2\\s.jsonl");
  });

  test("the .claude directory itself is NOT dragged off the home folder", () => {
    // .claude lives under HOME but not under Desktop, so the rule must not match.
    expect(relocate("{{HOME}}\\.claude\\settings.json", OFF_DESKTOP))
      .toBe("{{HOME}}\\.claude\\settings.json");
  });

  test("config contents point at the new project location", () => {
    const json = JSON.stringify({ cwd: "C:\\Users\\Jaros\\Desktop\\Saitoha Working\\billing" });
    const out = rewriteText(json, ctx(OFF_DESKTOP));
    expect(out).toContain("E:\\\\Projects\\\\Saitoha Working\\\\billing");
    expect(out).not.toContain("Desktop");
  });

  test("paths outside the relocated subtree are untouched by the rule", () => {
    expect(relocate("{{VOL:DISK_D}}\\CodeWorks\\citadel", OFF_DESKTOP))
      .toBe("{{VOL:DISK_D}}\\CodeWorks\\citadel");
  });

  test("a sibling folder with a shared name prefix is not swallowed", () => {
    // "DesktopBackup" must not match a rule targeting "Desktop".
    expect(relocate("{{HOME}}\\DesktopBackup\\x", OFF_DESKTOP))
      .toBe("{{HOME}}\\DesktopBackup\\x");
  });

  test("--relocate parsing keeps placeholders intact", () => {
    const r = parseRelocation("{{HOME}}\\Desktop={{VOL:DISK_D}}\\Projects");
    expect(r.from).toBe("{{HOME}}\\Desktop");
    expect(r.to).toBe("{{VOL:DISK_D}}\\Projects");
  });

  test("--relocate accepts plain drive paths too", () => {
    const r = parseRelocation("D:\\CodeWorks=E:\\Work");
    expect(r.from).toBe("D:\\CodeWorks");
    expect(r.to).toBe("E:\\Work");
  });

  test("a malformed --relocate value is rejected", () => {
    expect(() => parseRelocation("no-equals-sign")).toThrow(/expected FROM=TO/);
  });
});

describe("secrets encryption", () => {
  test("round-trips with the right passphrase", () => {
    const plain = Buffer.from("GLM_API_KEY=super-secret-value\n", "utf8");
    const enc = encrypt(plain, "correct horse");
    expect(enc.subarray(0, 4).toString()).toBe("WMG1");
    expect(enc.includes("super-secret-value")).toBe(false);
    expect(decrypt(enc, "correct horse").toString("utf8")).toBe(plain.toString("utf8"));
  });

  test("a wrong passphrase fails instead of returning garbage", () => {
    const enc = encrypt(Buffer.from("x"), "right");
    expect(() => decrypt(enc, "wrong")).toThrow(/Decryption failed/);
  });

  test("tampered ciphertext is rejected by the auth tag", () => {
    const enc = encrypt(Buffer.from("payload"), "pw");
    enc[enc.length - 1] ^= 0xff;
    expect(() => decrypt(enc, "pw")).toThrow(/Decryption failed/);
  });
});

describe("username substitution is whole-word only", () => {
  test("a longer identifier containing the old username is left alone", () => {
    const c = ctx();
    const text = 'user=Jaros; author="Jaroslav"; path=C:\\Users\\Jaros\\x; id=Jaros_2';
    expect(rewriteText(text, c)).toBe('user=mara; author="Jaroslav"; path=C:\\Users\\mara\\x; id=Jaros_2');
  });
});
