/*
  Detects running applications that hold their own data files locked.

  Learned the hard way: with Chrome running, a backup stalled indefinitely on
  its extension files — no CPU, no I/O, no error. Warning up front is far
  better than diagnosing a frozen progress bar.
*/

import { $ } from "bun";

export interface AppLock {
  /** Process names without .exe, matched case-insensitively. */
  processes: string[];
  label: string;
  profiles: string[];
  reason: string;
}

export const LOCKERS: AppLock[] = [
  {
    processes: ["chrome"],
    label: "Google Chrome",
    profiles: ["browsers"],
    reason: "держит базы профиля и файлы расширений — бэкап встанет на них",
  },
  {
    processes: ["firefox"],
    label: "Firefox",
    profiles: ["browsers"],
    reason: "держит places.sqlite и cookies",
  },
  {
    processes: ["msedge", "brave", "vivaldi", "dolphin_anty"],
    label: "Другие Chromium-браузеры",
    profiles: ["browsers"],
    reason: "держат базы профиля",
  },
  {
    processes: ["telegram"],
    label: "Telegram",
    profiles: ["comms"],
    reason: "держит tdata — сессия может скопироваться несогласованно",
  },
  {
    processes: ["discord", "discordcanary", "discordptb"],
    label: "Discord",
    profiles: ["comms"],
    reason: "держит Local Storage с токеном сессии",
  },
  {
    processes: ["element", "element-desktop"],
    label: "Element",
    profiles: ["comms"],
    reason: "держит IndexedDB с ключами шифрования",
  },
  {
    processes: ["keepassxc"],
    label: "KeePassXC",
    profiles: ["vault", "wallets"],
    reason: "база паролей может быть открыта на запись",
  },
  {
    processes: ["obsidian"],
    label: "Obsidian",
    profiles: ["vault"],
    reason: "может дописывать заметки во время копирования",
  },
  {
    processes: ["electrum", "tonkeeper", "ledger live"],
    label: "Криптокошельки",
    profiles: ["wallets"],
    reason: "держат файлы кошелька открытыми",
  },
  {
    processes: ["obs64", "obs32"],
    label: "OBS Studio",
    profiles: ["apps"],
    reason: "пишет настройки при выходе — данные могут разъехаться",
  },
  {
    processes: ["postman"],
    label: "Postman",
    profiles: ["apps"],
    reason: "держит свои базы",
  },
  {
    processes: ["code", "windsurf", "cursor"],
    label: "VS Code / форки",
    profiles: ["editors"],
    reason: "дописывает состояние воркспейсов",
  },
  {
    processes: ["docker desktop", "com.docker.backend"],
    label: "Docker Desktop",
    profiles: ["code"],
    reason: "держит образы и тома",
  },
];

export interface RunningApp {
  label: string;
  reason: string;
  profiles: string[];
  count: number;
  pids: number[];
}

/** Returns the subset of lockers currently running that affect these profiles. */
export async function detectRunning(profiles: string[]): Promise<RunningApp[]> {
  let listing = "";
  try {
    // One PowerShell call: spawning a process per app name would be slow.
    listing = await $`powershell -NoProfile -NonInteractive -Command "Get-Process | Select-Object -Property Id,ProcessName | ConvertTo-Csv -NoTypeInformation"`
      .quiet()
      .text();
  } catch {
    return [];
  }

  const byName = new Map<string, number[]>();
  for (const raw of listing.split(/\r?\n/).slice(1)) {
    const m = raw.match(/^"(\d+)","(.*)"$/);
    if (!m) continue;
    const name = m[2]!.toLowerCase();
    const arr = byName.get(name) ?? [];
    arr.push(Number(m[1]));
    byName.set(name, arr);
  }

  const out: RunningApp[] = [];
  for (const lock of LOCKERS) {
    if (!lock.profiles.some((p) => profiles.includes(p))) continue;
    const pids: number[] = [];
    for (const proc of lock.processes) {
      const hit = byName.get(proc.toLowerCase());
      if (hit) pids.push(...hit);
    }
    if (pids.length) {
      out.push({
        label: lock.label,
        reason: lock.reason,
        profiles: lock.profiles.filter((p) => profiles.includes(p)),
        count: pids.length,
        pids,
      });
    }
  }
  return out;
}
