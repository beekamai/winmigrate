/*
  Prevents a whole class of bug: a sensitive file encrypted by one rule but also
  collected in plaintext by a broader rule covering the same directory.

  Found in the wild — ~/.claude.json was encrypted, while its rotated copies in
  ~/.claude/backups/ went into the backup unencrypted with the same API keys.
*/

import { describe, expect, test } from "bun:test";
import { PROFILES } from "../src/profiles.ts";
import { explain } from "../src/scan.ts";

const HOME = process.env.USERPROFILE ?? "C:\\Users\\Default";

/** Files that must never be collected by a rule that does not encrypt. */
const MUST_BE_ENCRYPTED = [
  `${HOME}\\.claude.json`,
  `${HOME}\\.claude\\.mcp.json`,
  `${HOME}\\.claude\\backups\\.claude.json.backup.1788084381885`,
  `${HOME}\\.claude\\.credentials.json`,
  `${HOME}\\.claude\\.xai-credentials.json`,
  `${HOME}\\.ssh\\id_ed25519`,
  `${HOME}\\.config\\mcp-sshpilot\\servers.json`,
  `${HOME}\\.grok\\auth.json`,
];

function collectors(abs: string, size = 4096) {
  const plain: string[] = [];
  const encrypted: string[] = [];
  for (const p of PROFILES) {
    for (const rule of p.rules) {
      if (explain(abs, rule, size).included) {
        (rule.secret ? encrypted : plain).push(`${p.name}:${rule.path}`);
      }
    }
  }
  return { plain, encrypted };
}

describe("sensitive files are never collected in plaintext", () => {
  for (const file of MUST_BE_ENCRYPTED) {
    test(`${file.replace(HOME, "~")}`, () => {
      const { plain, encrypted } = collectors(file);
      expect(
        plain,
        `собирается без шифрования правилами: ${plain.join(", ")}`,
      ).toEqual([]);
      expect(encrypted.length, "не собирается вообще ни одним secret-правилом").toBeGreaterThan(0);
    });
  }
});

describe("ordinary files are still collected", () => {
  test("Claude settings and history remain in the backup", () => {
    const settings = collectors(`${HOME}\\.claude\\settings.json`);
    expect(settings.plain.length + settings.encrypted.length).toBeGreaterThan(0);
  });

  test("skills are collected — they are the point of the claude profile", () => {
    const skill = collectors(`${HOME}\\.claude\\skills\\dev-standards\\SKILL.md`);
    expect(skill.plain.length + skill.encrypted.length).toBeGreaterThan(0);
  });

  test("session history is collected", () => {
    const hist = collectors(`${HOME}\\.claude\\projects\\D--CodeWorks\\abc.jsonl`);
    expect(hist.plain.length + hist.encrypted.length).toBeGreaterThan(0);
  });
});
