/*
  Single-writer guard for a backup directory. Two concurrent backups into the
  same folder corrupt nothing thanks to SQLite, but they do produce confusing
  "database is locked" errors and duplicated work — so refuse early instead.
*/

import { existsSync, readFileSync, unlinkSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export interface LockInfo {
  pid: number;
  started: string;
  host: string;
}

function lockPath(dir: string): string {
  return join(dir, ".winmigrate.lock");
}

function processAlive(pid: number): boolean {
  try {
    // Signal 0 performs the permission/existence check without killing.
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Throws with a readable message when another live process holds the lock. */
export function acquire(dir: string): () => void {
  mkdirSync(dir, { recursive: true });
  const p = lockPath(dir);

  if (existsSync(p)) {
    try {
      const info = JSON.parse(readFileSync(p, "utf8")) as LockInfo;
      if (info.pid !== process.pid && processAlive(info.pid)) {
        throw new Error(
          `Каталог ${dir} уже используется другим процессом winmigrate ` +
          `(PID ${info.pid}, запущен ${info.started}).\n` +
          `Дождись его завершения или выбери другой каталог.`,
        );
      }
    } catch (e) {
      // A corrupt or stale lock must not block work forever.
      if ((e as Error).message.startsWith("Каталог")) throw e;
    }
  }

  const info: LockInfo = {
    pid: process.pid,
    started: new Date().toISOString(),
    host: process.env.COMPUTERNAME ?? "",
  };
  writeFileSync(p, JSON.stringify(info));

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    try {
      const cur = JSON.parse(readFileSync(p, "utf8")) as LockInfo;
      if (cur.pid === process.pid) unlinkSync(p);
    } catch { /* already gone */ }
  };
  process.once("exit", release);
  return release;
}
