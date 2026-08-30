/*
  Answers "will this exact file be backed up, by which profile, and where will it land?"
  Usage: bun run tools/check.ts "C:\path\one.png" "C:\path\two.jpg"
         bun run tools/check.ts --dir "C:\Users\Jaros\Downloads"   (samples a directory)
*/

import { statSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PROFILES } from "../src/profiles.ts";
import { explain, humanBytes } from "../src/scan.ts";
import { normalizeSep } from "../src/portable.ts";

const args = process.argv.slice(2);
let targets: string[] = [];

if (args[0] === "--dir") {
  const dir = args[1]!;
  targets = readdirSync(dir)
    .map((n) => join(dir, n))
    .filter((p) => {
      try { return statSync(p).isFile(); } catch { return false; }
    });
} else {
  targets = args;
}

if (!targets.length) {
  console.log('usage: bun run tools/check.ts "<file>" [...]  |  --dir "<folder>"');
  process.exit(1);
}

let included = 0;
for (const t of targets) {
  const abs = normalizeSep(t);
  let size = 0;
  try {
    size = statSync(abs).size;
  } catch {
    console.log(`  ${abs}\n      ФАЙЛ НЕ НАЙДЕН`);
    continue;
  }

  const hits: string[] = [];
  const misses: string[] = [];
  for (const p of PROFILES) {
    for (const rule of p.rules) {
      const r = explain(abs, rule, size);
      if (r.included) {
        const dest = rule.relocateTo
          ? normalizeSep(rule.relocateTo) + abs.slice(normalizeSep(rule.path).length)
          : "(на исходное место)";
        hits.push(`${p.name}${rule.secret ? " 🔒" : ""} → ${dest}`);
      } else if (r.reason !== "вне области правила") {
        misses.push(`${p.name}: ${r.reason}`);
      }
    }
  }

  const name = abs.split("\\").pop();
  if (hits.length) {
    included++;
    console.log(`  ✓ ${name}  ${humanBytes(size)}`);
    for (const h of hits) console.log(`      ${h}`);
  } else {
    console.log(`  ✗ ${name}  ${humanBytes(size)}`);
    for (const m of [...new Set(misses)].slice(0, 3)) console.log(`      ${m}`);
  }
}

console.log(`\n  итого: ${included} из ${targets.length} попадут в бэкап`);
