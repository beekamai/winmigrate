#!/usr/bin/env bun
/*
  winmigrate — portable backup/restore of a Windows dev environment.
  Survives a different username and different drive letters by storing paths
  as placeholders and rewriting both filenames and config contents on restore.
*/

import { Manifest } from "./manifest.ts";
import { acquire } from "./lock.ts";
import { prune } from "./prune.ts";
import { detectMachine, parseRelocation, toPortable, type Relocation, type VolumeMap } from "./portable.ts";
import { PROFILES, allProfileNames, profileByName } from "./profiles.ts";
import { humanBytes, scanProfile, type ScannedFile } from "./scan.ts";
import { packAll } from "./pack.ts";
import { restore, verify } from "./restore.ts";
import { buildProjectMap } from "./rewrite.ts";
import { discover, inspect, saveProject } from "./gitsave.ts";
import { detectRunning } from "./apps.ts";

interface Args {
  cmd: string;
  profiles?: string[];
  out: string;
  map: VolumeMap;
  pass?: string;
  dryRun: boolean;
  overwrite: boolean;
  jobs: number;
  limit: number;
  roots: string[];
  apply: boolean;
  owner: string;
  prefix: string;
  includeExisting: boolean;
  relocations: Relocation[];
}

function parseArgs(argv: string[]): Args {
  const a: Args = {
    // Empty means "no command given" -> interactive menu.
    cmd: argv[0] ?? "",
    out: "D:\\winmigrate-backup",
    map: {},
    dryRun: false,
    overwrite: false,
    jobs: Math.max(4, Math.min(16, navigator.hardwareConcurrency ?? 8)),
    limit: 40,
    roots: ["D:\\CodeWorks", `${process.env.USERPROFILE ?? ""}\\Desktop`],
    apply: false,
    owner: "",
    prefix: "",
    includeExisting: false,
    relocations: [],
  };
  for (let i = 1; i < argv.length; i++) {
    const t = argv[i]!;
    const next = () => argv[++i] ?? "";
    // PowerShell turns `a,b` into an array and joins it with spaces, so accept both separators.
    if (t === "--profiles" || t === "-p") a.profiles = next().split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
    else if (t === "--out" || t === "-o" || t === "--from") a.out = next();
    else if (t === "--pass") a.pass = next();
    else if (t === "--jobs" || t === "-j") a.jobs = Number(next()) || a.jobs;
    else if (t === "--limit") a.limit = Number(next()) || a.limit;
    else if (t === "--relocate") a.relocations.push(parseRelocation(next()));
    else if (t === "--roots") a.roots = next().split(/[,\s]+/).filter(Boolean);
    else if (t === "--owner") a.owner = next();
    else if (t === "--prefix") a.prefix = next();
    else if (t === "--apply") a.apply = true;
    else if (t === "--include-existing") a.includeExisting = true;
    else if (t === "--dry-run" || t === "-n") a.dryRun = true;
    else if (t === "--overwrite") a.overwrite = true;
    else if (t === "--map") {
      const [role, letter] = next().split("=");
      if (role && letter) a.map[role] = letter;
    }
  }
  return a;
}

function selectedProfiles(names?: string[]) {
  if (!names?.length) return PROFILES;
  const out = [];
  for (const n of names) {
    const p = profileByName(n);
    if (!p) throw new Error(`Unknown profile "${n}". Available: ${allProfileNames().join(", ")}`);
    out.push(p);
  }
  return out;
}

function table(rows: string[][]): string {
  if (!rows.length) return "";
  const w = rows[0]!.map((_, i) => Math.max(...rows.map((r) => (r[i] ?? "").length)));
  return rows
    .map((r) => r.map((c, i) => (i === 0 ? c.padEnd(w[i]!) : c.padStart(w[i]!))).join("  "))
    .join("\n");
}

async function cmdPlan(a: Args): Promise<void> {
  const profiles = selectedProfiles(a.profiles);
  const rows: string[][] = [["PROFILE", "FILES", "SIZE"]];
  let totalF = 0;
  let totalB = 0;
  for (const p of profiles) {
    const files = scanProfile(p);
    const bytes = files.reduce((s, f) => s + f.size, 0);
    totalF += files.length;
    totalB += bytes;
    rows.push([p.name, String(files.length), humanBytes(bytes)]);
  }
  rows.push(["TOTAL", String(totalF), humanBytes(totalB)]);
  console.log(table(rows));
  console.log("\nNothing was written (plan only).");
}

async function cmdBackup(a: Args): Promise<void> {
  const machine = await detectMachine();
  const profiles = selectedProfiles(a.profiles);

  const running = await detectRunning(profiles.map((p) => p.name));
  if (running.length) {
    console.log("ВНИМАНИЕ: запущены приложения, держащие свои файлы:");
    for (const a of running) console.log(`  - ${a.label} (${a.count}): ${a.reason}`);
    console.log("Закрой их для полного бэкапа, либо продолжай — заблокированные файлы будут пропущены.\n");
  }

  const needsPass = profiles.some((p) => p.rules.some((r) => r.secret));
  if (needsPass && !a.pass && !a.dryRun) {
    console.error("Profile 'secrets' selected but no --pass given. Aborting.");
    process.exit(2);
  }

  const release = acquire(a.out);
  const mf = new Manifest(a.out);
  mf.saveMachine(machine);

  // Captured now: it is the only reliable source of real project paths,
  // which is what makes Claude Code history re-encodable on the new machine.
  try {
    const raw = await Bun.file(`${machine.home}\\.claude.json`).text();
    const map = buildProjectMap(JSON.parse(raw), (abs) => toPortable(abs, machine));
    mf.setMeta("projectMap", JSON.stringify(map));
    console.log(`Captured ${Object.keys(map).length} Claude project path mappings.`);
  } catch {
    console.log("No .claude.json found — skipping project path map.");
  }

  let all: ScannedFile[] = [];
  for (const p of profiles) {
    const files = scanProfile(p);
    console.log(`scan ${p.name.padEnd(8)} ${String(files.length).padStart(7)} files  ${humanBytes(files.reduce((s, f) => s + f.size, 0))}`);
    all = all.concat(files);
  }
  console.log(`\nPacking ${all.length} files with ${a.jobs} workers...`);

  const t0 = Date.now();
  const res = await packAll(all, mf, machine, {
    concurrency: a.jobs,
    passphrase: a.pass,
    dryRun: a.dryRun,
    onProgress: (done, total, bytes) => {
      const pct = ((done / total) * 100).toFixed(1);
      const mbps = bytes / 1024 / 1024 / ((Date.now() - t0) / 1000);
      process.stdout.write(`\r  ${pct}%  ${done}/${total}  ${mbps.toFixed(0)} MB/s   `);
    },
  });
  process.stdout.write("\n\n");

  const st = mf.storeStats();
  console.log(table([
    ["metric", "value"],
    ["files", String(res.files)],
    ["logical size", humanBytes(res.bytes)],
    ["unique blobs", String(st.blobs)],
    ["stored size", humanBytes(st.stored)],
    ["saved by dedup+zstd", humanBytes(Math.max(0, res.bytes - st.stored))],
    ["elapsed", `${((Date.now() - t0) / 1000).toFixed(1)}s`],
  ]));

  if (res.errors.length) {
    console.log(`\n${res.errors.length} errors (first 10):`);
    for (const e of res.errors.slice(0, 10)) console.log("  " + e);
  }
  if (res.aborted) {
    console.log(`\nПрервано. Прогресс сохранён — запусти ту же команду, продолжит с этого места.`);
  }
  console.log(`\nBackup at: ${a.out}${a.dryRun ? "  (dry run — no blobs written)" : ""}`);
  mf.close();
  release();
}

async function cmdRestore(a: Args): Promise<void> {
  const machine = await detectMachine();
  const mf = new Manifest(a.out);

  console.log(`Backup made by user "${mf.getMeta("user")}" at ${mf.getMeta("createdAt")}`);
  console.log(`Restoring as user "${machine.user}"`);
  const oldVols = mf.volumes();
  console.log("\nVolume mapping:");
  for (const v of oldVols) {
    const target = a.map[v.role] ?? machine.volumes.find((x) => x.role === v.role)?.letter;
    console.log(`  ${v.role.padEnd(12)} ${v.letter}:  ->  ${target ? `${target}${target.endsWith(":") ? "" : ":"}` : "*** UNMAPPED (use --map) ***"}`);
  }

  if (a.relocations.length) {
    console.log("\nRelocations:");
    for (const r of a.relocations) console.log(`  ${r.from}  ->  ${r.to}`);
  }

  const res = await restore(mf, machine, {
    profiles: a.profiles,
    volumeMap: a.map,
    relocations: a.relocations,
    passphrase: a.pass,
    dryRun: a.dryRun,
    overwrite: a.overwrite,
    onProgress: (done, total) => process.stdout.write(`\r  ${done}/${total}   `),
  });
  process.stdout.write("\n");

  console.log(`\n${res.items.length} entries, ${res.items.filter((i) => i.rewritten).length} content-rewritten.`);

  if (res.renames.length) {
    console.log(`\n${res.renames.length} Claude history folders re-encoded for this machine:`);
    for (const r of res.renames.slice(0, a.limit)) console.log(`  ${r.before}\n    -> ${r.after}`);
    if (res.renames.length > a.limit) console.log(`  ... and ${res.renames.length - a.limit} more`);
  }

  if (a.dryRun) {
    console.log(`\nSample of planned writes (first ${a.limit}):`);
    for (const i of res.items.slice(0, a.limit)) {
      console.log(`  ${i.to}${i.rewritten ? "   [rewrite]" : ""}${i.encrypted ? " [dec]" : ""}`);
    }
    console.log("\nDry run — nothing written.");
  }
  if (res.errors.length) {
    console.log(`\n${res.errors.length} errors (first 10):`);
    for (const e of res.errors.slice(0, 10)) console.log("  " + e);
  }
  mf.close();
}

async function cmdPrune(a: Args): Promise<void> {
  const machine = await detectMachine();
  const release = acquire(a.out);
  const mf = new Manifest(a.out);
  const apply = !a.dryRun;

  console.log(`Сверяю ${a.out} с текущими правилами...\n`);
  const r = prune(mf, machine, apply);

  const plaintextSecrets = r.staleEntries.filter((s) => !s.encrypted);
  console.log(`устаревших записей: ${r.staleEntries.length}`);
  console.log(`осиротевших блобов: ${r.orphanBlobs.length} · освобождается ${humanBytes(r.freed)}`);
  if (plaintextSecrets.length) {
    console.log(`\nиз них незашифрованных (первые 10):`);
    for (const s of plaintextSecrets.slice(0, 10)) console.log(`  ${s.portable}`);
  }
  console.log(apply ? "\nУдалено." : "\nНичего не удалено (--dry-run). Убери -n, чтобы применить.");
  mf.close();
  release();
}

async function cmdVerify(a: Args): Promise<void> {
  const mf = new Manifest(a.out);
  const r = await verify(mf);
  console.log(`verified ${r.ok} entries, ${r.bad.length} problems`);
  for (const b of r.bad.slice(0, 20)) console.log("  " + b);
  mf.close();
  if (r.bad.length) process.exit(1);
}

async function cmdList(a: Args): Promise<void> {
  const mf = new Manifest(a.out);
  const rows: string[][] = [["PROFILE", "FILES", "SIZE", "ENCRYPTED"]];
  const enc = new Map<string, number>();
  for (const e of mf.entries()) {
    if (e.encrypted) enc.set(e.profile, (enc.get(e.profile) ?? 0) + 1);
  }
  for (const s of mf.stats()) {
    rows.push([s.profile, String(s.files), humanBytes(s.logical), String(enc.get(s.profile) ?? 0)]);
  }
  const st = mf.storeStats();
  console.log(table(rows));
  console.log(`\nblobs: ${st.blobs}  logical ${humanBytes(st.logical)}  stored ${humanBytes(st.stored)}`);
  mf.close();
}

async function cmdGitsave(a: Args): Promise<void> {
  let owner = a.owner;
  if (!owner) {
    owner = (await Bun.$`gh api user --jq .login`.quiet().text()).trim();
  }
  console.log(`GitHub owner: ${owner}${a.apply ? "" : "   (planning only — pass --apply to execute)"}\n`);

  const dirs = discover(a.roots);
  const projects = [];
  for (const d of dirs) projects.push(await inspect(d));

  const refused = [];
  const rows: string[][] = [["PROJECT", "STATE", "DIRTY", "ACTION"]];
  for (const p of projects) {
    const r = await saveProject(p, {
      apply: a.apply, owner, prefix: a.prefix, includeExisting: a.includeExisting,
    });
    if (r.action === "skip") continue;
    if (!r.ok) refused.push(r);
    rows.push([p.name.slice(0, 34), p.state, String(p.dirty), `${r.action}: ${r.detail}`.slice(0, 60)]);
  }
  console.log(table(rows));

  if (refused.length) {
    console.log(`\n${refused.length} project(s) REFUSED — secrets would be committed:`);
    for (const r of refused) {
      console.log(`  ${r.project.name}`);
      for (const s of r.project.exposed.slice(0, 4)) console.log(`      ${s}`);
    }
    console.log("\nAdd these to .gitignore (or move them out) and re-run.");
  }
  if (!a.apply) console.log("\nNothing was pushed. Re-run with --apply to execute the plan.");
}

function usage(): void {
  console.log(`winmigrate — portable Windows environment backup

  bun run src/cli.ts <command> [options]

Run with no command to open the interactive menu (TUI).

Commands:
  tui           Interactive menu (default when no command is given)
  r2-upload     Push a backup directory to Cloudflare R2
  r2-download   Pull a backup from Cloudflare R2 into -o DIR
  r2-verify     Compare the local backup against the bucket (what is missing)
  r2-prune      Delete bucket objects the local backup no longer has (-n first)
  plan       Show what would be collected, write nothing
  backup     Collect, dedupe, compress into a backup directory
  restore    Materialise a backup onto this machine, remapping paths
  verify     Check that every blob referenced by the manifest exists
  prune      Drop entries the current rules no longer select, and dead blobs
             (use -n first to preview; needed after tightening a secret rule)
  list       Show contents of an existing backup
  gitsave    Push local-only projects to private GitHub repos (plans by default)

Options:
  -p, --profiles a,b   Profiles: ${allProfileNames().join(", ")} (default: all)
  -o, --out DIR        Backup directory (also --from for restore)
      --map ROLE=E:    Map a volume role to a drive on this machine
      --relocate A=B   Move a subtree on restore (repeatable). Claude history
                       folders are re-encoded to follow the moved projects, e.g.
                       --relocate "{{HOME}}\\Desktop={{VOL:DISK_D}}\\Projects"
      --pass STR       Passphrase for the secrets profile
  -j, --jobs N         Parallel workers (default: CPU-based)
  -n, --dry-run        Plan only, write nothing
      --overwrite      Overwrite existing files on restore

Examples:
  bun run src/cli.ts plan
  bun run src/cli.ts backup -p claude,apps -o D:\\wm-backup
  bun run src/cli.ts restore -p claude --from E:\\wm-backup --map DISK_D=E: -n
`);
}

async function cmdR2(a: Args, dir: "up" | "down"): Promise<void> {
  const r2 = await import("./r2.ts");
  const cfg = r2.loadConfig();
  if (!cfg) {
    console.error(`R2 is not configured. Run the TUI ("bun run src/cli.ts") -> "Настройка R2",\nor set R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / R2_BUCKET.`);
    process.exit(2);
  }
  const onProgress = (p: { done: number; total: number; bytes: number }) =>
    process.stdout.write(`\r  ${p.done}/${p.total}  ${(p.bytes / 1024 / 1024).toFixed(0)} MB   `);

  if (dir === "up") {
    const r = await r2.upload(a.out, cfg, { onProgress });
    process.stdout.write("\n");
    console.log(`uploaded ${r.uploaded}, skipped ${r.skipped}, ${(r.bytes / 1024 / 1024).toFixed(0)} MB`);
    if (r.errors.length) console.log(`errors: ${r.errors.length}`);
  } else {
    const r = await r2.download(a.out, cfg, { onProgress });
    process.stdout.write("\n");
    console.log(`downloaded ${r.downloaded}, ${(r.bytes / 1024 / 1024).toFixed(0)} MB -> ${a.out}`);
    if (r.errors.length) console.log(`errors: ${r.errors.length}`);
  }
}

const a = parseArgs(process.argv.slice(2));
try {
  switch (a.cmd) {
    case "tui": {
      const { runTui } = await import("./tui.ts");
      await runTui();
      break;
    }
    case "r2-verify": {
      const r2 = await import("./r2.ts");
      const cfg = r2.loadConfig();
      if (!cfg) { console.error("R2 не настроен."); process.exit(2); }
      process.stdout.write("сверяю локальный бэкап с бакетом...\n");
      const r = await r2.verifyRemote(a.out, cfg, {
        onProgress: (p) => process.stdout.write(`\r  ${p.current}                    `),
      });
      process.stdout.write("\n\n");
      console.log(`локальных файлов: ${r.localFiles}`);
      console.log(`объектов в облаке: ${r.remoteObjects}`);
      console.log(`не залито:        ${r.missing.length}`);
      console.log(`размер не совпал: ${r.sizeMismatch.length}`);
      console.log(`лишнее в облаке:  ${r.extra.length}`);
      for (const m of r.sizeMismatch.slice(0, 10)) {
        console.log(`  ! ${m.rel}: локально ${m.local}, в облаке ${m.remote}`);
      }
      if (!r.missing.length && !r.sizeMismatch.length) {
        console.log("\nВ облаке лежит полная копия бэкапа.");
      } else {
        console.log("\nЗапусти r2-upload — дошлёт недостающее.");
      }
      break;
    }
    case "r2-prune": {
      const r2 = await import("./r2.ts");
      const cfg = r2.loadConfig();
      if (!cfg) { console.error("R2 не настроен."); process.exit(2); }
      const apply = !a.dryRun;
      console.log(`Ищу в бакете объекты, которых нет в ${a.out}...\n`);
      const r = await r2.pruneRemote(a.out, cfg, apply, {
        onProgress: (p) => process.stdout.write(`\r  ${p.current}                              `),
      });
      process.stdout.write("\n\n");
      console.log(`лишних объектов: ${r.extra.length} · примерно ${humanBytes(r.freedApprox)}`);
      for (const e of r.extra.slice(0, 10)) console.log(`  ${e}`);
      if (r.extra.length > 10) console.log(`  … и ещё ${r.extra.length - 10}`);
      console.log(apply ? `\nудалено: ${r.deleted}` : "\nНичего не удалено (-n). Убери -n, чтобы применить.");
      break;
    }
    case "r2-upload": await cmdR2(a, "up"); break;
    case "r2-download": await cmdR2(a, "down"); break;
    case "plan": await cmdPlan(a); break;
    case "backup": await cmdBackup(a); break;
    case "restore": await cmdRestore(a); break;
    case "verify": await cmdVerify(a); break;
    case "prune": await cmdPrune(a); break;
    case "list": await cmdList(a); break;
    case "gitsave": await cmdGitsave(a); break;
    case "help": case "--help": case "-h": usage(); break;
    // No command at all: the interactive menu is the friendly default.
    default: {
      if (!a.cmd || a.cmd === "help") {
        const { runTui } = await import("./tui.ts");
        await runTui();
      } else {
        console.error(`unknown command: ${a.cmd}\n`);
        usage();
        process.exit(2);
      }
    }
  }
} catch (e) {
  console.error(`\nerror: ${(e as Error).message}`);
  process.exit(1);
}
