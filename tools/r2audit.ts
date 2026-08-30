/*
  Strict integrity audit: compares what the bucket returns against the local
  blob file, byte for byte (by SHA-256 of the stored form).

  Note for anyone extending this: a blob's NAME is the hash of the original
  file, while its CONTENTS are the compressed (zstd) or encrypted form. Hashing
  the downloaded bytes and comparing them to the key therefore fails for every
  compressed blob — that is not corruption. Always compare against the local
  stored file.
*/

import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import * as r2 from "../src/r2.ts";
import { humanBytes } from "../src/scan.ts";

const backupDir = process.argv[2] ?? "D:\\wm-backup";
const sampleSize = Number(process.argv[3] ?? 40);

/**
 * Hard ceiling per object. Bun's S3 stream buffers aggressively, so auditing a
 * 4 GB blob pulled gigabytes into RAM and starved the machine. Multipart
 * behaviour is already exercised by objects in the tens of megabytes.
 */
const MAX_AUDIT_BYTES = 48 * 1024 * 1024;

const cfg = r2.loadConfig();
if (!cfg) { console.log("R2 не настроен"); process.exit(1); }

const client = r2.makeClient(cfg);
console.log("получаю список объектов…");

const objects: { key: string; size: number }[] = [];
let token: string | undefined;
do {
  const page = await client.list({ prefix: `${cfg.prefix}/`, continuationToken: token, maxKeys: 1000 });
  for (const o of page.contents ?? []) if (o.key) objects.push({ key: o.key, size: o.size ?? 0 });
  token = page.isTruncated ? page.nextContinuationToken : undefined;
} while (token);

console.log(`объектов в облаке: ${objects.length}`);

const auditable = objects.filter((o) => o.size <= MAX_AUDIT_BYTES);
const tooBig = objects.length - auditable.length;

// Largest auditable objects (these still went through multipart) plus a random tail.
const bySize = [...auditable].sort((a, b) => b.size - a.size);
const big = bySize.slice(0, Math.ceil(sampleSize / 2));
const random = bySize.slice(Math.ceil(sampleSize / 2)).sort(() => Math.random() - 0.5).slice(0, Math.floor(sampleSize / 2));
const sample = [...big, ...random];

console.log(`проверяю ${sample.length} объектов против локальных файлов`);
console.log(`(пропущено ${tooBig} объектов крупнее ${humanBytes(MAX_AUDIT_BYTES)} — чтобы не занимать память)\n`);

async function sha256Stream(it: AsyncIterable<Uint8Array>): Promise<string> {
  const h = createHash("sha256");
  for await (const chunk of it) h.update(chunk);
  return h.digest("hex");
}

let ok = 0, checkedBytes = 0, skipped = 0;
const bad: string[] = [];

for (const o of sample) {
  const rel = o.key.slice(cfg.prefix.length + 1).replace(/\//g, "\\");
  const localPath = join(backupDir, rel);
  if (!existsSync(localPath)) { skipped++; continue; }

  const localSize = statSync(localPath).size;
  if (localSize !== o.size) {
    bad.push(`${rel}: размер локально ${localSize}, в облаке ${o.size}`);
    continue;
  }
  try {
    const remoteHash = await sha256Stream(client.file(o.key).stream() as AsyncIterable<Uint8Array>);
    const localHash = await sha256Stream(Bun.file(localPath).stream() as AsyncIterable<Uint8Array>);
    checkedBytes += o.size;
    if (remoteHash === localHash) {
      ok++;
      process.stdout.write(`\r  совпало ${ok}/${sample.length} · ${humanBytes(checkedBytes)}          `);
    } else {
      bad.push(`${rel}: содержимое отличается`);
    }
  } catch (e) {
    bad.push(`${rel}: ${(e as Error).message}`);
  }
}

process.stdout.write("\n\n");
console.log(`побайтово совпало: ${ok} из ${sample.length - skipped}`);
console.log(`проверено данных:  ${humanBytes(checkedBytes)}`);
console.log(`крупнейший:        ${humanBytes(bySize[0]?.size ?? 0)}`);
if (skipped) console.log(`пропущено (нет локально): ${skipped}`);
if (bad.length) {
  console.log(`\n✗ РАСХОЖДЕНИЙ: ${bad.length}`);
  for (const b of bad.slice(0, 10)) console.log(`  ${b}`);
} else {
  console.log("\n✓ все проверенные объекты в облаке побайтово идентичны локальным");
}
