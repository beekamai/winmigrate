/* Diagnostic: where the bytes of a profile actually are, grouped by subtree. */
import { profileByName } from "../src/profiles.ts";
import { humanBytes, scanProfile } from "../src/scan.ts";

const name = process.argv[2] ?? "code";
const depth = Number(process.argv[3] ?? 2);
const p = profileByName(name);
if (!p) throw new Error(`no profile ${name}`);

const files = scanProfile(p);
const bySub = new Map<string, { n: number; b: number }>();
const byExt = new Map<string, { n: number; b: number }>();

for (const f of files) {
  const rel = f.abs.slice(f.rule.path.length + 1);
  const key = f.rule.path + "\\" + rel.split("\\").slice(0, depth).join("\\");
  const s = bySub.get(key) ?? { n: 0, b: 0 };
  s.n++; s.b += f.size; bySub.set(key, s);

  const dot = f.abs.lastIndexOf(".");
  const ext = dot > 0 ? f.abs.slice(dot).toLowerCase() : "(none)";
  const e = byExt.get(ext) ?? { n: 0, b: 0 };
  e.n++; e.b += f.size; byExt.set(ext, e);
}

console.log(`profile ${name}: ${files.length} files, ${humanBytes(files.reduce((s, f) => s + f.size, 0))}\n`);
console.log("TOP SUBTREES:");
for (const [k, v] of [...bySub].sort((a, b) => b[1].b - a[1].b).slice(0, 25)) {
  console.log(`  ${humanBytes(v.b).padStart(9)}  ${String(v.n).padStart(8)}  ${k}`);
}
console.log("\nTOP EXTENSIONS:");
for (const [k, v] of [...byExt].sort((a, b) => b[1].b - a[1].b).slice(0, 18)) {
  console.log(`  ${humanBytes(v.b).padStart(9)}  ${String(v.n).padStart(8)}  ${k}`);
}
