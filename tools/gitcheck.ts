/*
  Checks whether the `code` profile's size/extension filters would mangle a git
  repository. A .git tree must be taken whole: dropping one packfile leaves a
  repo that cannot be checked out.
*/

import { existsSync, opendirSync, statSync } from "node:fs";
import { join } from "node:path";
import { humanBytes } from "../src/scan.ts";
import { profileByName } from "../src/profiles.ts";

const LIMIT = profileByName("code")?.rules[0]?.maxFileSize ?? 25 * 1024 * 1024;

function walkGit(dir: string, out: { path: string; size: number }[]): number {
  let total = 0;
  let d;
  try { d = opendirSync(dir); } catch { return 0; }
  try {
    let e = d.readSync();
    while (e) {
      const p = join(dir, e.name);
      if (e.isDirectory()) total += walkGit(p, out);
      else if (e.isFile()) {
        try {
          const s = statSync(p).size;
          total += s;
          if (s > LIMIT) out.push({ path: p, size: s });
        } catch { /* locked */ }
      }
      e = d.readSync();
    }
  } finally { d.closeSync(); }
  return total;
}

function repos(root: string, depth: number, found: string[] = []): string[] {
  if (depth < 0) return found;
  let d;
  try { d = opendirSync(root); } catch { return found; }
  try {
    let e = d.readSync();
    while (e) {
      if (e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules") {
        const p = join(root, e.name);
        if (existsSync(join(p, ".git"))) found.push(p);
        else repos(p, depth - 1, found);
      }
      e = d.readSync();
    }
  } finally { d.closeSync(); }
  return found;
}

const roots = ["D:\\CodeWorks", `${process.env.USERPROFILE}\\Desktop`];
const all: string[] = [];
for (const r of roots) repos(r, 2, all);

console.log(`репозиториев найдено: ${all.length}\n`);

const oversize: { path: string; size: number }[] = [];
let gitTotal = 0;
for (const repo of all) gitTotal += walkGit(join(repo, ".git"), oversize);

console.log(`суммарный размер .git: ${humanBytes(gitTotal)}`);
console.log(`лимит на файл в профиле code: ${humanBytes(LIMIT)}`);
console.log(`\nфайлов внутри .git крупнее лимита: ${oversize.length}`);
for (const o of oversize.sort((a, b) => b.size - a.size).slice(0, 15)) {
  console.log(`  ${humanBytes(o.size).padStart(9)}  ${o.path.replace("D:\\CodeWorks\\", "CW\\")}`);
}
if (oversize.length) {
  console.log(`\n⚠ Эти файлы были бы отброшены -> репозитории восстановились бы битыми.`);
}
