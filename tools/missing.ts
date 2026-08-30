/*
  Read-only diagnosis of a running or interrupted backup: which files the
  profiles select but the manifest does not yet contain.
  Safe to run while a backup is in progress (opens the database read-only).
*/

import { Database } from "bun:sqlite";
import { join } from "node:path";
import { PROFILES, profileByName } from "../src/profiles.ts";
import { humanBytes, scanProfile } from "../src/scan.ts";
import { detectMachine, normalizeSep, toPortable } from "../src/portable.ts";

const dir = process.argv[2];
if (!dir) {
  console.log('usage: bun run tools/missing.ts <backupDir> [profile,...]');
  process.exit(1);
}
const only = (process.argv[3] ?? "").split(/[,\s]+/).filter(Boolean);

const db = new Database(join(dir, "manifest.db"), { readonly: true });
const have = new Set(
  db.query<{ portable: string }, []>("SELECT portable FROM entries").all().map((r) => r.portable.toLowerCase()),
);
console.log(`в манифесте: ${have.size} записей\n`);

const machine = await detectMachine();
const profiles = only.length ? only.map((n) => profileByName(n)!).filter(Boolean) : PROFILES;

let totalMissing = 0;
for (const p of profiles) {
  const files = scanProfile(p);
  const missing = files.filter((f) => {
    const portable = f.rule.relocateTo
      ? normalizeSep(f.rule.relocateTo) + normalizeSep(f.abs).slice(normalizeSep(f.rule.path).length)
      : toPortable(f.abs, machine);
    return !have.has(portable.toLowerCase());
  });
  if (!missing.length) {
    console.log(`  ✓ ${p.name.padEnd(15)} всё на месте (${files.length})`);
    continue;
  }
  totalMissing += missing.length;
  const bytes = missing.reduce((s, f) => s + f.size, 0);
  console.log(`  ✗ ${p.name.padEnd(15)} не хватает ${missing.length} из ${files.length} · ${humanBytes(bytes)}`);
  for (const m of missing.sort((a, b) => b.size - a.size).slice(0, 12)) {
    console.log(`        ${humanBytes(m.size).padStart(9)}  ${m.abs}`);
  }
  if (missing.length > 12) console.log(`        … и ещё ${missing.length - 12}`);
}

console.log(`\nвсего не хватает: ${totalMissing}`);
db.close();
