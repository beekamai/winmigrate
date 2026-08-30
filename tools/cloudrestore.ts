/*
  Proves the cloud copy is usable on its own: pulls the manifest straight from
  R2, opens it, then fetches a sample of the blobs it references and restores
  them into a scratch directory — decrypting and decompressing for real.

  Verifying that objects exist is not the same as proving a restore works.
*/

import { createHash } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import * as r2 from "../src/r2.ts";
import { decrypt } from "../src/crypto.ts";
import { humanBytes } from "../src/scan.ts";

const sampleSize = Number(process.argv[2] ?? 25);
const passphrase = process.argv[3];

const cfg = r2.loadConfig();
if (!cfg) { console.log("R2 не настроен"); process.exit(1); }
const client = r2.makeClient(cfg);

const work = join(tmpdir(), `wm-cloud-${process.pid}`);
mkdirSync(work, { recursive: true });
const dbPath = join(work, "manifest.db");

console.log("1. качаю manifest.db прямо из облака…");
// Bun 1.3.2 panics on Bun.write(path, s3File); buffer it explicitly instead.
const manifestBytes = await client.file(`${cfg.prefix}/manifest.db`).arrayBuffer();
await Bun.write(dbPath, manifestBytes);
console.log(`   получено ${humanBytes(manifestBytes.byteLength)}`);

console.log("2. открываю его как базу…");
const db = new Database(dbPath, { readonly: true });
const total = db.query<{ n: number }, []>("SELECT COUNT(*) n FROM entries").get()!.n;
const encrypted = db.query<{ n: number }, []>("SELECT COUNT(*) n FROM entries WHERE encrypted=1").get()!.n;
const profiles = db.query<{ profile: string; n: number }, []>(
  "SELECT profile, COUNT(*) n FROM entries GROUP BY profile ORDER BY n DESC",
).all();
console.log(`   записей: ${total} · зашифровано: ${encrypted}`);
console.log(`   профилей: ${profiles.map((p) => `${p.profile}(${p.n})`).join(", ")}`);

console.log(`\n3. восстанавливаю ${sampleSize} файлов из облака…`);
// Encrypted entries can only be checked when a passphrase is supplied.
// Cap the size: a restore check must not itself hog memory.
const MAX_BYTES = 32 * 1024 * 1024;
const rows = db.query<{ portable: string; hash: string; size: number; encrypted: number }, [number, number]>(
  passphrase
    ? `SELECT portable, hash, size, encrypted FROM entries
       WHERE size > 0 AND size <= ? ORDER BY encrypted DESC, RANDOM() LIMIT ?`
    : `SELECT portable, hash, size, encrypted FROM entries
       WHERE size > 0 AND size <= ? AND encrypted = 0 ORDER BY RANDOM() LIMIT ?`,
).all(MAX_BYTES, sampleSize);
if (!passphrase) {
  console.log("   (без пароля — проверяю только незашифрованные; передай пароль третьим аргументом)");
}

let ok = 0, bytes = 0;
const bad: string[] = [];

for (const row of rows) {
  const key = `${cfg.prefix}/blobs/${row.hash.slice(0, 2)}/${row.hash}.blob`;
  try {
    let buf = Buffer.from(await client.file(key).arrayBuffer());
    if (row.encrypted) {
      if (!passphrase) { bad.push(`${row.portable}: нужен пароль для проверки`); continue; }
      buf = decrypt(buf, passphrase);
    }
    const codec = db.query<{ codec: string }, [string]>("SELECT codec FROM blobs WHERE hash=?").get(row.hash)?.codec;
    if (codec === "zstd") buf = Buffer.from(await Bun.zstdDecompress(buf));

    // The blob name is the SHA-256 of the ORIGINAL file, so after fully
    // reversing storage the hash must match again.
    const plainHash = row.hash.replace(/\.s$/, "");
    const actual = createHash("sha256").update(buf).digest("hex");
    if (actual === plainHash && buf.length === row.size) {
      ok++; bytes += buf.length;
    } else {
      bad.push(`${row.portable}: хеш ${actual.slice(0, 12)} != ${plainHash.slice(0, 12)}`);
    }
  } catch (e) {
    bad.push(`${row.portable}: ${(e as Error).message}`);
  }
}

db.close();
rmSync(work, { recursive: true, force: true });

console.log(`\n   восстановлено и сверено: ${ok} из ${rows.length} · ${humanBytes(bytes)}`);
if (bad.length) {
  console.log(`\n✗ проблемы: ${bad.length}`);
  for (const b of bad.slice(0, 10)) console.log(`   ${b}`);
  process.exit(1);
} else {
  console.log("\n✓ из облака восстанавливается корректно: расшифровка, распаковка и хеши сходятся");
}
