/*
  End-to-end proof for one directory: pack it, restore it elsewhere, compare
  every file by hash, and — for a git repo — run `git fsck` on the restored copy.

  Usage: bun run tools/roundtrip.ts "D:\CodeWorks\deepseek-harness"
*/

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Manifest } from "../src/manifest.ts";
import { packAll } from "../src/pack.ts";
import { restore } from "../src/restore.ts";
import { scanProfile, humanBytes } from "../src/scan.ts";
import { detectMachine, toPortable, normalizeSep } from "../src/portable.ts";
import type { Profile } from "../src/profiles.ts";

const src = normalizeSep(process.argv[2] ?? "");
if (!src || !existsSync(src)) {
  console.log('usage: bun run tools/roundtrip.ts "<folder>"');
  process.exit(1);
}

const work = join(tmpdir(), `wm-roundtrip-${process.pid}`);
const backupDir = join(work, "backup");
const restoreRoot = join(work, "restored");
mkdirSync(restoreRoot, { recursive: true });

const machine = await detectMachine();

// Same filters as the real `code` profile, so the test reflects production.
const profile: Profile = {
  name: "code",
  description: "roundtrip",
  rules: [{
    path: src,
    exclude: ["node_modules", "target", "dist", "build"],
    excludeExt: [".exe", ".dll", ".pdb"],
    maxFileSize: 25 * 1024 * 1024,
    rewrite: "none",
  }],
};

console.log(`источник: ${src}`);
const files = scanProfile(profile);
console.log(`файлов: ${files.length} · ${humanBytes(files.reduce((s, f) => s + f.size, 0))}`);

const mf = new Manifest(backupDir);
mf.saveMachine(machine);
const packed = await packAll(files, mf, machine, { concurrency: 8, dryRun: false });
console.log(`упаковано: ${packed.files}${packed.errors.length ? ` · ошибок ${packed.errors.length}` : ""}`);

// Restore the subtree into a scratch location via a relocation rule.
const fromPortablePath = toPortable(src, machine);
const toPortablePath = toPortable(restoreRoot, machine);
const res = await restore(mf, machine, {
  volumeMap: {},
  relocations: [{ from: fromPortablePath, to: toPortablePath }],
  dryRun: false,
  overwrite: true,
});
console.log(`восстановлено: ${res.items.length}${res.errors.length ? ` · ошибок ${res.errors.length}` : ""}`);

function sha(p: string): string {
  return createHash("sha256").update(require("node:fs").readFileSync(p)).digest("hex");
}

let same = 0, differ = 0, absent = 0;
for (const f of files) {
  const dest = join(restoreRoot, f.abs.slice(src.length + 1));
  if (!existsSync(dest)) { absent++; continue; }
  if (statSync(dest).size !== f.size) { differ++; continue; }
  if (f.size < 64 * 1024 * 1024 && sha(dest) !== sha(f.abs)) { differ++; continue; }
  same++;
}

console.log(`\nсовпало по хешу: ${same} · отличий: ${differ} · отсутствует: ${absent}`);

if (existsSync(join(restoreRoot, ".git"))) {
  console.log("\n=== git fsck на восстановленной копии ===");
  const out = await Bun.$`git -C ${restoreRoot} fsck --no-progress`.quiet().nothrow();
  const text = (out.stdout.toString() + out.stderr.toString()).trim();
  console.log(text || "(без замечаний)");
  const head = await Bun.$`git -C ${restoreRoot} log --oneline -1`.quiet().nothrow();
  console.log("HEAD: " + head.stdout.toString().trim());
  console.log(out.exitCode === 0 ? "✓ репозиторий целостен" : "✗ fsck сообщил о проблемах");
}

// Close the manifest before deleting: SQLite keeps the file handle open.
mf.close();
try {
  rmSync(work, { recursive: true, force: true });
} catch {
  console.log(`(временная папка осталась: ${work})`);
}
console.log(`\n${differ === 0 && absent === 0 ? "✓ РОУНДТРИП БЕЗ ПОТЕРЬ" : "✗ ЕСТЬ РАСХОЖДЕНИЯ"}`);
