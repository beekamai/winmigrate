/*
  Interactive front-end: backup, R2 sync, restore with relocation, GitHub save.
  Every destructive step asks for confirmation and defaults to a dry run.
*/

import { existsSync } from "node:fs";
import { join } from "node:path";
import { Manifest } from "./manifest.ts";
import { acquire } from "./lock.ts";
import { detectMachine, parseRelocation, toPortable, type Relocation, type VolumeMap } from "./portable.ts";
import { PROFILES, profileByName } from "./profiles.ts";
import { scanProfile, scanProfileAsync, type ScannedFile } from "./scan.ts";
import { packAll } from "./pack.ts";
import { restore, verify } from "./restore.ts";
import { buildProjectMap } from "./rewrite.ts";
import { discover, inspect, saveProject } from "./gitsave.ts";
import { detectRunning } from "./apps.ts";
import { registerPassphrase, verifyPassphrase } from "./passphrase.ts";
import * as r2 from "./r2.ts";
import {
  Progress, Spinner, c, cancellable, confirm, humanBytes, line, menu, multiSelect,
  closeInput, pause, prompt, rule, title,
} from "./ui.ts";

const DEFAULT_BACKUP = "D:\\wm-backup";

interface State {
  backupDir: string;
  passphrase: string | null;
  /** Backup the cached passphrase was verified against; another dir asks again. */
  passphraseDir: string | null;
  uploadConcurrency: number;
}

function profileItems(preselect: string[] = []) {
  return PROFILES.map((p) => ({
    label: p.name.padEnd(9),
    hint: p.description,
    value: p.name,
    checked: preselect.length === 0 ? p.name !== "media" : preselect.includes(p.name),
  }));
}

/**
 * Asks for the passphrase and proves it is the one the backup in `dir` was
 * made with before anything is encrypted or decrypted. Only a backup with
 * nothing encrypted yet falls back to the type-it-twice check.
 */
async function needPassphrase(st: State, profiles: string[], dir: string, forRestore = false): Promise<boolean> {
  const needs = profiles.some((n) => profileByName(n)?.rules.some((r) => r.secret));
  if (!needs) return true;
  if (st.passphrase && st.passphraseDir === dir) return true;

  const mf = existsSync(join(dir, "manifest.db")) ? new Manifest(dir) : null;
  try {
    for (;;) {
      const p = await prompt(
        forRestore ? "Пароль от зашифрованных данных:" : "Пароль для шифрования секретов:",
        { mask: true },
      );
      if (!p) return false;

      const verdict = mf ? await verifyPassphrase(mf, p) : "unknown";
      if (verdict === "wrong") {
        line(`  ${c.red}Не тот пароль: этот бэкап уже зашифрован другим.${c.reset} ${c.grey}(Esc — отмена)${c.reset}`);
        continue;
      }
      if (verdict === "ok") {
        line(`  ${c.green}✓ пароль совпадает с уже зашифрованными файлами${c.reset}`);
      } else if (forRestore) {
        line(`\n  ${c.red}В этом бэкапе нет зашифрованных файлов — проверить пароль не по чему.${c.reset}`);
        await pause();
        return false;
      } else {
        const again = await prompt("Повторите пароль:", { mask: true });
        if (again !== p) {
          line(`\n  ${c.red}Пароли не совпадают.${c.reset}`);
          await pause();
          return false;
        }
        line(`  ${c.grey}новый бэкап: с этого момента он привязан к этому паролю${c.reset}`);
      }
      st.passphrase = p;
      st.passphraseDir = dir;
      return true;
    }
  } finally {
    mf?.close();
  }
}

async function screenOverview(st: State): Promise<void> {
  title("Обзор", "что попадёт в бэкап · Esc — прервать");
  line();

  const rows: string[][] = [];
  let totalF = 0, totalB = 0;

  const res = await cancellable(async (signal) => {
    for (const p of PROFILES) {
      const sp = new Spinner(`сканирую ${p.name}`);
      const files = await scanProfileAsync(p, {
        signal,
        onProgress: (found, current) => sp.tick(`${found} файлов · ${current}`),
      });
      sp.clear();
      const bytes = files.reduce((s, f) => s + f.size, 0);
      totalF += files.length;
      totalB += bytes;
      const enc = p.rules.some((r) => r.secret) ? `${c.yellow}🔒${c.reset}` : "  ";
      rows.push([p.name, String(files.length), humanBytes(bytes), enc, p.description]);
      line(`  ${c.bold}${p.name.padEnd(15)}${c.reset} ${String(files.length).padStart(8)} ${humanBytes(bytes).padStart(9)} ${enc}`);
    }
    return true;
  });

  if (res.cancelled) {
    line(`\n  ${c.yellow}прервано${c.reset}`);
    await pause();
    return;
  }

  title("Обзор", "что попадёт в бэкап с этой машины");
  for (const r of rows) {
    line(`  ${c.bold}${r[0]!.padEnd(9)}${c.reset} ${r[1]!.padStart(8)} ${r[2]!.padStart(9)} ${r[3]}  ${c.grey}${r[4]}${c.reset}`);
  }
  line(`  ${rule()}`);
  line(`  ${c.bold}${"ИТОГО".padEnd(9)}${c.reset} ${String(totalF).padStart(8)} ${humanBytes(totalB).padStart(9)}`);
  await pause();
}

/**
 * Blocks on applications that hold their data locked. Chrome once froze an
 * entire backup on its extension files, so this check runs before any work.
 */
async function checkRunningApps(profiles: string[]): Promise<boolean> {
  for (;;) {
    title("Проверка запущенных приложений", "они держат свои файлы и мешают копированию");
    line(`  ${c.grey}проверяю…${c.reset}`);
    const running = await detectRunning(profiles);

    if (!running.length) {
      title("Проверка запущенных приложений");
      line(`  ${c.green}✓ мешающих приложений не запущено${c.reset}`);
      await new Promise((r) => setTimeout(r, 700));
      return true;
    }

    title("Закрой эти приложения", "иначе их файлы скопируются частично или бэкап зависнет");
    for (const a of running) {
      line(`  ${c.yellow}●${c.reset} ${c.bold}${a.label}${c.reset} ${c.grey}(${a.count} проц.)${c.reset}`);
      line(`      ${c.grey}${a.reason}${c.reset}`);
      line(`      ${c.grey}профили: ${a.profiles.join(", ")}${c.reset}`);
    }
    line();

    const what = await menu(
      [
        { label: "Проверить снова", hint: "закрой приложения и нажми Enter", value: "again" },
        { label: "Продолжить всё равно", hint: "риск: неполные данные, возможны пропуски", value: "go" },
        { label: "Отмена", value: "cancel" },
      ],
      "Закрой эти приложения",
      running.map((a) => a.label).join(" · "),
    );
    if (what === "again" || what === null) continue;
    if (what === "cancel") return false;
    return true;
  }
}

async function screenBackup(st: State): Promise<void> {
  const chosen = await multiSelect(profileItems(), "Бэкап", "выбери профили (media отключён по умолчанию — он самый тяжёлый)");
  if (!chosen?.length) return;

  if (!(await checkRunningApps(chosen))) return;

  const dir = await prompt("Куда сохранить:", { def: st.backupDir });
  if (dir === null) return;
  st.backupDir = dir;

  if (!(await needPassphrase(st, chosen, st.backupDir))) return;

  title("Бэкап", `профили: ${chosen.join(", ")} · Esc — прервать сканирование`);
  line();

  const machine = await detectMachine();
  let release: () => void;
  try {
    release = acquire(st.backupDir);
  } catch (e) {
    line(`\n  ${c.red}${(e as Error).message}${c.reset}`);
    await pause();
    return;
  }
  const mf = new Manifest(st.backupDir);
  mf.saveMachine(machine);
  if (st.passphrase) registerPassphrase(mf, st.passphrase);

  try {
    const raw = await Bun.file(`${machine.home}\\.claude.json`).text();
    const map = buildProjectMap(JSON.parse(raw), (abs) => toPortable(abs, machine));
    mf.setMeta("projectMap", JSON.stringify(map));
  } catch { /* no Claude config on this machine */ }

  const scanned = await cancellable(async (signal) => {
    let all: ScannedFile[] = [];
    for (const n of chosen) {
      const p = profileByName(n)!;
      const sp = new Spinner(`сканирую ${p.name}`);
      const files = await scanProfileAsync(p, {
        signal,
        onProgress: (found, current) => sp.tick(`${found} файлов · ${current}`),
      });
      sp.clear();
      line(`  ${c.grey}${p.name.padEnd(15)} ${String(files.length).padStart(8)} файлов${c.reset}`);
      all = all.concat(files);
    }
    return all;
  });

  if (scanned.cancelled || !scanned.value) {
    line(`\n  ${c.yellow}сканирование прервано — ничего не записано${c.reset}`);
    mf.close();
    release();
    await pause();
    return;
  }
  const all = scanned.value;
  line();

  const bar = new Progress(`Упаковка ${all.length} файлов  ${c.grey}(Esc — прервать)${c.reset}`);
  const packRun = await cancellable((signal) =>
    packAll(all, mf, machine, {
      concurrency: Math.min(16, navigator.hardwareConcurrency ?? 8),
      passphrase: st.passphrase ?? undefined,
      dryRun: false,
      signal,
      onProgress: (done, total, bytes) => bar.render(done, total, bytes),
    }),
  );
  const res = packRun.value ?? { files: 0, bytes: 0, errors: [], aborted: true };

  const store = mf.storeStats();
  if (res.aborted) {
    bar.fail(`прервано на ${res.files} из ${all.length} — прогресс сохранён`);
    line(`  ${c.grey}запусти бэкап снова в ту же папку: продолжит с этого места${c.reset}`);
  } else {
    bar.done(
      `${res.files} файлов · ${humanBytes(res.bytes)} → ${humanBytes(store.stored)} ` +
      `(сэкономлено ${humanBytes(Math.max(0, res.bytes - store.stored))})`,
    );
  }
  const locked = res.errors.filter((e) => e.includes("заблокирован приложением"));
  const other = res.errors.filter((e) => !e.includes("заблокирован приложением"));
  if (locked.length) {
    line(`  ${c.yellow}!${c.reset} пропущено из-за блокировки приложением: ${locked.length}`);
    line(`  ${c.grey}закрой приложение и запусти бэкап снова — доберёт только их${c.reset}`);
    for (const e of locked.slice(0, 3)) line(`    ${c.grey}${e.split(":")[0]}${c.reset}`);
  }
  if (other.length) {
    line(`  ${c.yellow}!${c.reset} прочих ошибок: ${other.length} (первые 3):`);
    for (const e of other.slice(0, 3)) line(`    ${c.grey}${e}${c.reset}`);
  }
  mf.close();
  release();
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

  const speed = await menu(
    [
      { label: "Обычная (32 потока)", hint: "подходит большинству каналов", value: "32" },
      { label: "Быстрая (64 потока)", hint: "если канал широкий, а скорость упирается в задержки", value: "64" },
      { label: "Щадящая (8 потоков)", hint: "если интернет нужен для другого", value: "8" },
    ],
    "Скорость заливки",
    "мелких файлов много, поэтому решает число параллельных запросов",
  );
  if (speed === null) return;
  st.uploadConcurrency = Number(speed);

  title("Заливка в R2", `${cfg.bucket}/${cfg.prefix} · Esc — остановить`);
  line();

  const prep = new Spinner("подготовка");
  const bar = new Progress(`Отправка в Cloudflare R2  ${c.grey}(Esc — остановить)${c.reset}`);
  let started = false;

  const run = await cancellable((signal) =>
    r2.upload(dir, cfg, {
      signal,
      concurrency: st.uploadConcurrency,
      onProgress: (p) => {
        if (p.phase === "transfer") {
          if (!started) { prep.clear(); started = true; }
          bar.render(p.done, p.total, p.bytes, p.current);
        } else {
          prep.tick(p.phase === "listing" ? p.current : `читаю каталог · ${p.current}`);
        }
      },
    }),
  );
  if (!started) prep.clear();

  const res = run.value;
  if (run.cancelled || !res) {
    line(`\n  ${c.yellow}остановлено — загруженное остаётся в облаке${c.reset}`);
    line(`  ${c.grey}запусти заливку снова: отправит только недостающее${c.reset}`);
    await pause();
    return;
  }

  if (res.aborted) {
    bar.fail(`остановлено · отправлено ${res.uploaded} · ${humanBytes(res.bytes)}`);
    line(`  ${c.grey}повторный запуск дошлёт остальное${c.reset}`);
  } else {
    bar.done(
      `отправлено ${res.uploaded} · пропущено ${res.skipped} (уже в облаке) · ${humanBytes(res.bytes)}`,
    );
  }
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

  title("Скачивание из R2", `${cfg.bucket}/${cfg.prefix} · Esc — остановить`);
  line();

  const prep = new Spinner("получаю список объектов");
  const bar = new Progress(`Загрузка из Cloudflare R2  ${c.grey}(Esc — остановить)${c.reset}`);
  let started = false;

  const run = await cancellable((signal) =>
    r2.download(dir, cfg, {
      signal,
      concurrency: st.uploadConcurrency,
      onProgress: (p) => {
        if (p.phase === "transfer") {
          if (!started) { prep.clear(); started = true; }
          bar.render(p.done, p.total, p.bytes, p.current);
        } else {
          prep.tick(p.current);
        }
      },
    }),
  );
  if (!started) prep.clear();

  const res = run.value;
  if (run.cancelled || !res) {
    line(`\n  ${c.yellow}остановлено — скачанное сохранено${c.reset}`);
    line(`  ${c.grey}запусти снова: докачает недостающее${c.reset}`);
    await pause();
    return;
  }
  if (res.aborted) bar.fail(`остановлено · получено ${res.downloaded} · ${humanBytes(res.bytes)}`);
  else bar.done(`${res.downloaded} объектов · ${humanBytes(res.bytes)} → ${dir}`);
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
    // Same letter as before is the likeliest answer; never guess a different disk.
    const sameLetter = machine.volumes.find((x) => x.letter === v.letter);
    const answer = await prompt(
      `Том "${v.role}" (был ${v.letter}:${v.label ? `, метка "${v.label}"` : ""}) теперь какой диск?`,
      { def: sameLetter ? `${sameLetter.letter}:` : "" },
    );
    if (answer === null) { mf.close(); return; }
    const letter = answer.trim().replace(/[:\/]+$/, "").toUpperCase();
    if (!machine.volumes.some((x) => x.letter === letter)) {
      line(`
  ${c.red}Диска ${letter}: на этой машине нет.${c.reset}`);
      mf.close(); await pause(); return;
    }
    volumeMap[v.role] = `${letter}:`;
  }

  const relocations = await askRelocations(mf);
  if (relocations === null) { mf.close(); return; }
  if (!(await needPassphrase(st, chosen, dir, true))) { mf.close(); return; }

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

/**
 * Incremental refresh: re-pack whatever changed since the last run, then push
 * only the new blobs. Both halves skip unchanged data, so running this again
 * shortly before a reinstall costs minutes, not hours.
 */
async function screenSync(st: State): Promise<void> {
  const dir = await prompt("Какой бэкап обновить:", { def: st.backupDir });
  if (dir === null) return;
  st.backupDir = dir;
  if (!existsSync(join(dir, "manifest.db"))) {
    line(`\n  ${c.red}Нет бэкапа в ${dir} — сначала создай его.${c.reset}`);
    await pause();
    return;
  }

  // Refresh exactly the profiles this backup already contains.
  const mfPeek = new Manifest(dir);
  const known = [...new Set(mfPeek.entries().map((e) => e.profile))];
  mfPeek.close();
  if (!known.length) {
    line(`\n  ${c.red}Бэкап пуст.${c.reset}`);
    await pause();
    return;
  }

  line(`\n  ${c.grey}профили в этом бэкапе: ${known.join(", ")}${c.reset}`);
  if (!(await checkRunningApps(known))) return;
  if (!(await needPassphrase(st, known, dir))) return;

  let release: () => void;
  try {
    release = acquire(dir);
  } catch (e) {
    line(`\n  ${c.red}${(e as Error).message}${c.reset}`);
    await pause();
    return;
  }

  title("Обновление бэкапа", "добавляю только новое и изменившееся · Esc — прервать");
  line();

  const machine = await detectMachine();
  const mf = new Manifest(dir);
  mf.saveMachine(machine);
  if (st.passphrase) registerPassphrase(mf, st.passphrase);
  try {
    const raw = await Bun.file(`${machine.home}\\.claude.json`).text();
    mf.setMeta("projectMap", JSON.stringify(buildProjectMap(JSON.parse(raw), (abs) => toPortable(abs, machine))));
  } catch { /* no Claude config */ }

  const scanned = await cancellable(async (signal) => {
    let all: ScannedFile[] = [];
    for (const n of known) {
      const p = profileByName(n);
      if (!p) continue;
      const sp = new Spinner(`сканирую ${n}`);
      const files = await scanProfileAsync(p, {
        signal,
        onProgress: (found, current) => sp.tick(`${found} файлов · ${current}`),
      });
      sp.clear();
      all = all.concat(files);
    }
    return all;
  });
  if (scanned.cancelled || !scanned.value) {
    line(`  ${c.yellow}прервано${c.reset}`);
    mf.close(); release(); await pause();
    return;
  }

  const before = mf.entries().length;
  const bar = new Progress(`Проверяю ${scanned.value.length} файлов  ${c.grey}(Esc — прервать)${c.reset}`);
  const packRun = await cancellable((signal) =>
    packAll(scanned.value!, mf, machine, {
      concurrency: Math.min(16, navigator.hardwareConcurrency ?? 8),
      passphrase: st.passphrase ?? undefined,
      dryRun: false,
      signal,
      onProgress: (done, total, bytes) => bar.render(done, total, bytes),
    }),
  );
  const after = mf.entries().length;
  const store = mf.storeStats();
  mf.close();
  release();

  if (!packRun.value || packRun.value.aborted) {
    bar.fail("прервано — прогресс сохранён");
    await pause();
    return;
  }
  bar.done(`новых записей: ${after - before} · в хранилище ${humanBytes(store.stored)}`);

  const cfg = r2.loadConfig();
  if (!cfg) {
    line(`  ${c.grey}R2 не настроен — заливка пропущена${c.reset}`);
    await pause();
    return;
  }

  line();
  const prep = new Spinner("подготовка");
  const upBar = new Progress(`Догружаю в R2  ${c.grey}(Esc — остановить)${c.reset}`);
  let started = false;
  const up = await cancellable((signal) =>
    r2.upload(dir, cfg, {
      signal,
      concurrency: st.uploadConcurrency,
      onProgress: (p) => {
        if (p.phase === "transfer") {
          if (!started) { prep.clear(); started = true; }
          upBar.render(p.done, p.total, p.bytes, p.current);
        } else prep.tick(p.current);
      },
    }),
  );
  if (!started) prep.clear();
  const ur = up.value;
  if (!ur || up.cancelled || ur.aborted) upBar.fail("заливка остановлена — повтори позже");
  else upBar.done(`отправлено ${ur.uploaded} · пропущено ${ur.skipped} · ${humanBytes(ur.bytes)}`);
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
  const st: State = { backupDir: DEFAULT_BACKUP, passphrase: null, passphraseDir: null, uploadConcurrency: 32 };

  for (;;) {
    const cfg = r2.loadConfig();
    const r2status = cfg ? `${c.green}настроен${c.reset} ${c.grey}(${cfg.bucket})${c.reset}` : `${c.yellow}не настроен${c.reset}`;

    const choice = await menu(
      [
        { label: "Обзор", hint: "что и сколько попадёт в бэкап", value: "overview" },
        { label: "Создать бэкап", hint: "собрать, сжать, зашифровать секреты", value: "backup" },
        { label: "Обновить и залить", hint: "добавить новое и изменившееся, догрузить в R2", value: "sync" },
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
      case "sync": await screenSync(st); break;
      case "upload": await screenUpload(st); break;
      case "download": await screenDownload(st); break;
      case "restore": await screenRestore(st); break;
      case "verify": await screenVerify(st); break;
      case "gitsave": await screenGitsave(); break;
      case "r2cfg": await screenR2Config(); break;
      case "quit":
      case null:
        line(`\n  ${c.grey}пока${c.reset}\n`);
        closeInput();
        return;
    }
  }
}
