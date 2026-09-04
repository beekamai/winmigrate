/*
  A backup must never end up encrypted under two passphrases. Every entry
  point checks the typed passphrase against what the backup already holds.
*/

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Manifest } from "../src/manifest.ts";
import { encrypt } from "../src/crypto.ts";
import { registerPassphrase, verifyPassphrase } from "../src/passphrase.ts";

let dir: string;
let mf: Manifest;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "wm-pass-"));
  mf = new Manifest(dir);
});
afterEach(() => {
  mf.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("passphrase verifier", () => {
  test("an empty backup accepts any passphrase, then binds to it", async () => {
    expect(await verifyPassphrase(mf, "first")).toBe("unknown");
    registerPassphrase(mf, "first");
    expect(await verifyPassphrase(mf, "first")).toBe("ok");
    expect(await verifyPassphrase(mf, "frist")).toBe("wrong");
  });

  test("registering again never replaces the original binding", async () => {
    registerPassphrase(mf, "first");
    registerPassphrase(mf, "second");
    expect(await verifyPassphrase(mf, "second")).toBe("wrong");
    expect(await verifyPassphrase(mf, "first")).toBe("ok");
  });

  test("a backup made before the verifier existed is checked against a real blob", async () => {
    const hash = "ab".repeat(32) + ".s";
    const path = mf.blobPath(hash);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, encrypt(Buffer.from("API_KEY=x"), "legacy"));
    mf.addBlob({ hash, size: 9, stored: 100, codec: "store" });
    mf.addEntry({
      profile: "secrets", portable: "{{HOME}}\\.env", source: "C:\\x\\.env",
      size: 9, mtime: 0, hash, encrypted: 1, rewrite: "none",
    });

    expect(await verifyPassphrase(mf, "legacy")).toBe("ok");
    expect(await verifyPassphrase(mf, "Legacy")).toBe("wrong");
  });

  test("an encrypted entry whose blob is gone cannot vouch for anything", async () => {
    mf.addEntry({
      profile: "secrets", portable: "{{HOME}}\\.env", source: "C:\\x\\.env",
      size: 9, mtime: 0, hash: "cd".repeat(32) + ".s", encrypted: 1, rewrite: "none",
    });
    expect(await verifyPassphrase(mf, "anything")).toBe("unknown");
  });
});
