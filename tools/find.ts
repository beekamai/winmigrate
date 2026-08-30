/* Searches a finished backup for files by name substring, and verifies their blobs exist. */

import { Manifest } from "../src/manifest.ts";
import { humanBytes } from "../src/scan.ts";

const dir = process.argv[2];
const needle = (process.argv[3] ?? "").toLowerCase();
if (!dir) {
  console.log('usage: bun run tools/find.ts <backupDir> [substring]');
  process.exit(1);
}

const mf = new Manifest(dir);
const all = mf.entries();
const hits = needle ? all.filter((e) => e.portable.toLowerCase().includes(needle)) : all;

let ok = 0, missing = 0;
for (const e of hits.slice(0, 40)) {
  const f = Bun.file(mf.blobPath(e.hash));
  const present = await f.exists();
  if (present) ok++; else missing++;
  const mark = present ? "✓" : "✗ БЛОБ ОТСУТСТВУЕТ";
  console.log(`  ${mark} ${humanBytes(e.size).padStart(9)}  ${e.portable}`);
}
if (hits.length > 40) console.log(`  … и ещё ${hits.length - 40}`);
console.log(`\n  найдено: ${hits.length} · блобы на месте: ${ok}${missing ? ` · ПОТЕРЯНО: ${missing}` : ""}`);
mf.close();
