/*
  Interactive front-end: backup, R2 sync, restore with relocation, GitHub save.
  Every destructive step asks for confirmation and defaults to a dry run.
*/

import { existsSync } from "node:fs";
import { join } from "node:path";
import { Manifest } from "./manifest.ts";
import { detectMachine, parseRelocation, toPortable, type Relocation, type VolumeMap } from "./portable.ts";
import { PROFILES, profileByName } from "./profiles.ts";
import { scanProfile, type ScannedFile } from "./scan.ts";
import { packAll } from "./pack.ts";
import { restore, verify } from "./restore.ts";
import { buildProjectMap } from "./rewrite.ts";
import { discover, inspect, saveProject } from "./gitsave.ts";
import * as r2 from "./r2.ts";
import {
  Progress, c, confirm, humanBytes, line, menu, multiSelect, pause, prompt, rule, title,
} from "./ui.ts";

const DEFAULT_BACKUP = "D:\\wm-backup";

interface State {
  backupDir: string;
  passphrase: string | null;
}

function profileItems(preselect: string[] = []) {
  return PROFILES.map((p) => ({
    label: p.name.padEnd(9),
    hint: p.description,
    value: p.name,
    checked: preselect.length === 0 ? p.name !== "media" : preselect.includes(p.name),
  }));
}

async function needPassphrase(st: State, profiles: string[], forRestore = false): Promise<boolean> {
  const needs = profiles.some((n) => profileByName(n)?.rules.some((r) => r.secret));
  if (!needs) return true;
  if (st.passphrase) return true;
  const p = await prompt(
    forRestore ? "Пароль от зашифрованных данных:" : "Пароль для шифрования секретов:",
    { mask: true },
  );
  if (!p) return false;
  if (!forRestore) {
    const again = await prompt("Повторите пароль:", { mask: true });
    if (again !== p) {
      line(`\n  ${c.red}Пароли не совпадают.${c.reset}`);
      await pause();
      return false;
    }
  }
  st.passphrase = p;
  return true;
}

async function screenOverview(st: State): Promise<void> {
  title("Обзор", "что попадёт в бэкап с этой машины");
  line(`  ${c.grey}сканирую…${c.reset}`);

  let totalF = 0, totalB = 0;
  const rows: string[][] = [];
  for (const p of PROFILES) {
    const files = scanProfile(p);
    const bytes = files.reduce((s, f) => s + f.size, 0);
    totalF += files.length;
    totalB += bytes;
    const enc = p.rules.some((r) => r.secret) ? `${c.yellow}🔒${c.reset}` : "  ";
    rows.push([p.name, String(files.length), humanBytes(bytes), enc, p.description]);
  }

  title("Обзор", "что попадёт в бэкап с этой машины");
  for (const r of rows) {
    line(`  ${c.bold}${r[0]!.padEnd(9)}${c.reset} ${r[1]!.padStart(8)} ${r[2]!.padStart(9)} ${r[3]}  ${c.grey}${r[4]}${c.reset}`);
  }
  line(`  ${rule()}`);
  line(`  ${c.bold}${"ИТОГО".padEnd(9)}${c.reset} ${String(totalF).padStart(8)} ${humanBytes(totalB).padStart(9)}`);
  await pause();
}

async function screenBackup(st: State): Promise<void> {
  const chosen = await multiSelect(profileItems(), "Бэкап", "выбери профили (media отключён по умолчанию — он самый тяжёлый)");
  if (!chosen?.length) return;

  const dir = await prompt("Куда сохранить:", { def: st.backupDir });
  if (dir === null) return;
  st.backupDir = dir;

  if (!(await needPassphrase(st, chosen))) return;

  title("Бэкап", `профили: ${chosen.join(", ")}`);
  line(`  ${c.grey}сканирую файлы…${c.reset}\n`);

  const machine = await detectMachine();
  const mf = new Manifest(st.backupDir);
  mf.saveMachine(machine);

  try {
    const raw = await Bun.file(`${machine.home}\\.claude.json`).text();
    const map = buildProjectMap(JSON.parse(raw), (abs) => toPortable(abs, machine));
    mf.setMeta("projectMap", JSON.stringify(map));
  } catch { /* no Claude config on this machine */ }

  let all: ScannedFile[] = [];
  for (const n of chosen) {
    const p = profileByName(n)!;
    all = all.concat(scanProfile(p));
  }

  const bar = new Progress(`Упаковка ${all.length} файлов`);
  const res = await packAll(all, mf, machine, {
    concurrency: Math.min(16, navigator.hardwareConcurrency ?? 8),
    passphrase: st.passphrase ?? undefined,
    dryRun: false,
    onProgress: (done, total, bytes) => bar.render(done, total, bytes),
  });

  const store = mf.storeStats();
  bar.done(
    `${res.files} файлов · ${humanBytes(res.bytes)} → ${humanBytes(store.stored)} ` +
    `(сэкономлено ${humanBytes(Math.max(0, res.bytes - store.stored))})`,
  );
  if (res.errors.length) {
    line(`  ${c.yellow}!${c.reset} ошибок: ${res.errors.length} (первые 3):`);
    for (const e of res.errors.slice(0, 3)) line(`    ${c.grey}${e}${c.reset}`);
  }
  mf.close();
  await pause();
}

async function ensureR2(): Promise<r2.R2Config | null> {
  const cfg = r2.loadConfig();
  if (cfg) return cfg;
  line(`\n  ${c.yellow}R2 не настроен.${c.reset}`);
  const go = await confirm("Настроить сейчас?", true);
  if (!go) return null;
  return screenR2Config();
}

async function screenR2Config(): Promise<r2.R2Config | null> {
  title("Настройка Cloudflare R2", "ключи сохранятся в ~/.winmigrate/r2.json");
  line(`  ${c.grey}R2 → Manage API Tokens → Create Account API token (Object Read & Write)${c.reset}\n`);

  const existing = r2.loadConfig();
  const accountId = await prompt("Account ID:", { def: existing?.accountId });
  if (accountId === null) return null;
  const accessKeyId = await prompt("Access Key ID:", { def: existing?.accessKeyId });
  if (accessKeyId === null) return null;
  const secretAccessKey = await prompt("Secret Access Key:", { mask: true });
  if (secretAccessKey === null) return null;
  const bucket = await prompt("Bucket:", { def: existing?.bucket ?? "winmigrate" });
  if (bucket === null) return null;
  const prefix = await prompt("Префикс (папка в бакете):", { def: existing?.prefix ?? "winmigrate" });
  if (prefix === null) return null;

  const cfg: r2.R2Config = {
    accountId,
    accessKeyId,
    secretAccessKey: secretAccessKey || existing?.secretAccessKey || "",
    bucket,
    prefix,
  };

  line(`\n  ${c.grey}проверяю доступ…${c.reset}`);
  const t = await r2.testConnection(cfg);
  if (!t.ok) {
    line(`  ${c.red}✗ ${t.detail}${c.reset}`);
    await pause();
    return null;
  }
  r2.saveConfig(cfg);
  line(`  ${c.green}✓ ${t.detail}${c.reset}`);
  line(`  ${c.grey}сохранено в ${r2.CONFIG_PATH}${c.reset}`);
  await pause();
  return cfg;
}

async function screenUpload(st: State): Promise<void> {
  const cfg = await ensureR2();
  if (!cfg) return;

  const dir = await prompt("Какой бэкап заливать:", { def: st.backupDir });
  if (dir === null) return;
  st.backupDir = dir;
  if (!existsSync(join(dir, "manifest.db"))) {
    line(`\n  ${c.red}Нет manifest.db в ${dir} — сначала сделай бэкап.${c.reset}`);
    await pause();
    return;
  }

  title("Заливка в R2", `${cfg.bucket}/${cfg.prefix}`);
  line();
  const bar = new Progress("Отправка в Cloudflare R2");
  const res = await r2.upload(dir, cfg, {
    concurrency: 8,
    onProgress: (p) => bar.render(p.done, p.total, p.bytes, p.current),
  });
  bar.done(
    `загружено ${res.uploaded}, пропущено ${res.skipped} (уже в облаке) · ${humanBytes(res.bytes)}`,
  );
  if (res.errors.length) {
    line(`  ${c.red}ошибок: ${res.errors.length}${c.reset}`);
    for (const e of res.errors.slice(0, 3)) line(`    ${c.grey}${e}${c.reset}`);
  }
  await pause();
}

async function screenDownload(st: State): Promise<void> {
  const cfg = await ensureR2();
  if (!cfg) return;

  const dir = await prompt("Куда скачать бэкап:", { def: st.backupDir });
  if (dir === null) return;
  st.backupDir = dir;

  title("Скачивание из R2", `${cfg.bucket}/${cfg.prefix}`);
  line();
  const bar = new Progress("Загрузка из Cloudflare R2");
  const res = await r2.download(dir, cfg, {
    concurrency: 8,
    onProgress: (p) => bar.render(p.done, p.total, p.bytes, p.current),
  });
  bar.done(`${res.downloaded} объектов · ${humanBytes(res.bytes)} → ${dir}`);
  if (res.errors.length) {
    line(`  ${c.red}ошибок: ${res.errors.length}${c.reset}`);
    for (const e of res.errors.slice(0, 3)) line(`    ${c.grey}${e}${c.reset}`);
  }
  await pause();
}

async function askRelocations(mf: Manifest): Promise<Relocation[] | null> {
  const has = mf.entries().some((e) => /^\{\{HOME\}\}\\Desktop\\/i.test(e.portable));
  if (!has) return [];

  const choice = await menu(
    [
      { label: "Да, на диск с данными", hint: "проекты уедут с рабочего стола, история Claude — за ними", value: "yes" },
      { label: "Нет, вернуть как было", hint: "обратно в Desktop", value: "no" },
    ],
    "Перенести проекты с рабочего стола?",
    "рабочий стол лежит на системном диске — при следующей переустановке всё повторится",
  );
  if (choice === null) return null;
  if (choice === "no") return [];

  const target = await prompt("Куда переносить:", { def: "D:\\Projects" });
  if (target === null) return null;
  return [parseRelocation(`{{HOME}}\\Desktop=${target}`)];
}

async function screenRestore(st: State): Promise<void> {
  const dir = await prompt("Откуда восстанавливать:", { def: st.backupDir });
  if (dir === null) return;
  st.backupDir = dir;
  if (!existsSync(join(dir, "manifest.db"))) {
    line(`\n  ${c.red}Нет manifest.db в ${dir}.${c.reset}`);
    await pause();
    return;
  }

  const mf = new Manifest(dir);
  const machine = await detectMachine();
  const available = [...new Set(mf.entries().map((e) => e.profile))];
  const items = profileItems(available).filter((i) => available.includes(i.value));

  const chosen = await multiSelect(items, "Восстановление", `бэкап от ${mf.getMeta("createdAt")?.slice(0, 16)}, пользователь "${mf.getMeta("user")}"`);
  if (!chosen?.length) { mf.close(); return; }

  // Volume mapping: anything the new machine cannot resolve must be asked about.
  const volumeMap: VolumeMap = {};
  for (const v of mf.volumes()) {
    const auto = machine.volumes.find((x) => x.role === v.role);
    if (auto) continue;
    const answer = await prompt(`Том "${v.role}" (был ${v.letter}:) теперь какой диск?`, { def: "D:" });
    if (answer === null) { mf.close(); return; }
    volumeMap[v.role] = answer;
  }

  const relocations = await askRelocations(mf);
  if (relocations === null) { mf.close(); return; }
  if (!(await needPassphrase(st, chosen, true))) { mf.close(); return; }

  // Always show a dry run before touching the filesystem.
  title("Восстановление", "предпросмотр — ничего не записывается");
  line();
  const dry = await restore(mf, machine, {
    profiles: chosen, volumeMap, relocations,
    passphrase: st.passphrase ?? undefined, dryRun: true, overwrite: false,
  });
  line(`  файлов к записи: ${c.bold}${dry.items.length}${c.reset}`);
  line(`  с переписыванием путей: ${dry.items.filter((i) => i.rewritten).length}`);
  if (dry.renames.length) {
    line(`\n  ${c.cyan}папок истории Claude будет переименовано: ${dry.renames.length}${c.reset}`);
    for (const r of dry.renames.slice(0, 5)) {
      line(`    ${c.grey}${r.before}${c.reset}`);
      line(`      → ${c.green}${r.after}${c.reset}`);
    }
    if (dry.renames.length > 5) line(`    ${c.grey}… и ещё ${dry.renames.length - 5}${c.reset}`);
  }
  line(`\n  примеры путей:`);
  for (const i of dry.items.slice(0, 6)) line(`    ${c.grey}${i.to}${c.reset}`);

  line();
  const go = await confirm("Записать на диск?", false);
  if (!go) { mf.close(); return; }
  const overwrite = await confirm("Перезаписывать существующие файлы?", false);

  title("Восстановление", "запись файлов");
  line();
  const bar = new Progress("Раскладываю по местам");
  const res = await restore(mf, machine, {
    profiles: chosen, volumeMap, relocations,
    passphrase: st.passphrase ?? undefined, dryRun: false, overwrite,
    onProgress: (done, total) => bar.render(done, total, 0),
  });
  bar.done(`восстановлено ${res.items.length} файлов`);
  if (res.errors.length) {
    line(`  ${c.red}ошибок: ${res.errors.length}${c.reset}`);
    for (const e of res.errors.slice(0, 5)) line(`    ${c.grey}${e}${c.reset}`);
  }
  mf.close();
  await pause();
}

async function screenVerify(st: State): Promise<void> {
  const dir = await prompt("Какой бэкап проверить:", { def: st.backupDir });
  if (dir === null) return;
  st.backupDir = dir;
  title("Проверка целостности", dir);
  line(`\n  ${c.grey}сверяю манифест с хранилищем…${c.reset}`);
  const mf = new Manifest(dir);
  const r = await verify(mf);
  if (r.bad.length === 0) line(`\n  ${c.green}✓ ${r.ok} записей, проблем нет${c.reset}`);
  else {
    line(`\n  ${c.red}✗ ${r.bad.length} проблем${c.reset}`);
    for (const b of r.bad.slice(0, 10)) line(`    ${c.grey}${b}${c.reset}`);
  }
  mf.close();
  await pause();
}

async function screenGitsave(): Promise<void> {
  title("Сохранение кода в GitHub", "план — ничего не отправляется без подтверждения");
  const owner = (await Bun.$`gh api user --jq .login`.quiet().text()).trim();
  line(`\n  ${c.grey}аккаунт: ${owner} · сканирую проекты…${c.reset}`);

  const roots = ["D:\\CodeWorks", `${process.env.USERPROFILE}\\Desktop`];
  const projects = [];
  for (const d of discover(roots)) projects.push(await inspect(d));

  const plans = [];
  for (const p of projects) {
    const r = await saveProject(p, { apply: false, owner, prefix: "", includeExisting: false });
    if (r.action !== "skip") plans.push(r);
  }
  const ok = plans.filter((r) => r.ok);
  const refused = plans.filter((r) => !r.ok);

  title("Сохранение кода в GitHub", `аккаунт ${owner}`);
  line(`  ${c.green}готовы к заливке: ${ok.length}${c.reset}`);
  line(`  ${c.red}заблокированы (в коммит попали бы секреты): ${refused.length}${c.reset}\n`);
  for (const r of refused.slice(0, 10)) {
    line(`    ${c.red}✗${c.reset} ${r.project.name} ${c.grey}— ${r.detail}${c.reset}`);
  }
  if (refused.length > 10) line(`    ${c.grey}… и ещё ${refused.length - 10}${c.reset}`);

  line();
  const go = await confirm(`Создать ${ok.length} приватных репозиториев и запушить?`, false);
  if (!go) return;

  title("Заливка в GitHub", `${ok.length} проектов`);
  line();
  let n = 0;
  for (const plan of ok) {
    n++;
    write(`\r  ${n}/${ok.length}  ${plan.project.name.slice(0, 40).padEnd(40)}`);
    const r = await saveProject(plan.project, { apply: true, owner, prefix: "", includeExisting: false });
    line(`\r  ${r.ok ? c.green + "✓" : c.red + "✗"}${c.reset} ${plan.project.name.padEnd(34)} ${c.grey}${r.detail}${c.reset}`);
  }
  await pause();
}

function write(s: string): void {
  process.stdout.write(s);
}

export async function runTui(): Promise<void> {
  const st: State = { backupDir: DEFAULT_BACKUP, passphrase: null };

  for (;;) {
    const cfg = r2.loadConfig();
    const r2status = cfg ? `${c.green}настроен${c.reset} ${c.grey}(${cfg.bucket})${c.reset}` : `${c.yellow}не настроен${c.reset}`;

    const choice = await menu(
      [
        { label: "Обзор", hint: "что и сколько попадёт в бэкап", value: "overview" },
        { label: "Создать бэкап", hint: "собрать, сжать, зашифровать секреты", value: "backup" },
        { label: "Залить в R2", hint: "отправить бэкап в облако", value: "upload" },
        { label: "Скачать из R2", hint: "забрать бэкап на новой машине", value: "download" },
        { label: "Восстановить", hint: "разложить по местам с переназначением путей", value: "restore" },
        { label: "Проверить бэкап", hint: "целостность хранилища", value: "verify" },
        { label: "Код в GitHub", hint: "приватные репы для локальных проектов", value: "gitsave" },
        { label: "Настройка R2", hint: `состояние: ${r2status}`, value: "r2cfg" },
        { label: "Выход", value: "quit" },
      ],
      "winmigrate",
      "перенос рабочего окружения между установками Windows",
    );

    switch (choice) {
      case "overview": await screenOverview(st); break;
      case "backup": await screenBackup(st); break;
      case "upload": await screenUpload(st); break;
      case "download": await screenDownload(st); break;
      case "restore": await screenRestore(st); break;
      case "verify": await screenVerify(st); break;
      case "gitsave": await screenGitsave(); break;
      case "r2cfg": await screenR2Config(); break;
      case "quit":
      case null:
        line(`\n  ${c.grey}пока${c.reset}\n`);
        return;
    }
  }
}
