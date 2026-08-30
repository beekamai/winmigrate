/*
  Cloudflare R2 sync over Bun's native S3 client (no rclone, no SDK).

  The backup is a content-addressed store, so sync is naturally incremental:
  a blob whose hash already exists remotely is never re-uploaded.
*/

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

export interface R2Config {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  /** Key prefix inside the bucket, e.g. "winmigrate". */
  prefix: string;
}

export const CONFIG_PATH = join(
  process.env.USERPROFILE ?? ".",
  ".winmigrate",
  "r2.json",
);

export function loadConfig(): R2Config | null {
  // Environment wins, so CI or a one-off shell can override the stored file.
  const env = process.env;
  if (env.R2_ACCESS_KEY_ID && env.R2_SECRET_ACCESS_KEY && env.R2_BUCKET) {
    return {
      accountId: env.R2_ACCOUNT_ID ?? "",
      accessKeyId: env.R2_ACCESS_KEY_ID,
      secretAccessKey: env.R2_SECRET_ACCESS_KEY,
      bucket: env.R2_BUCKET,
      prefix: env.R2_PREFIX ?? "winmigrate",
    };
  }
  if (!existsSync(CONFIG_PATH)) return null;
  try {
    const c = JSON.parse(require("node:fs").readFileSync(CONFIG_PATH, "utf8")) as R2Config;
    return c.accessKeyId && c.secretAccessKey && c.bucket ? c : null;
  } catch {
    return null;
  }
}

export function saveConfig(c: R2Config): void {
  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  Bun.write(CONFIG_PATH, JSON.stringify(c, null, 2));
}

export function endpointFor(c: R2Config): string {
  return `https://${c.accountId}.r2.cloudflarestorage.com`;
}

export function makeClient(c: R2Config): Bun.S3Client {
  return new Bun.S3Client({
    accessKeyId: c.accessKeyId,
    secretAccessKey: c.secretAccessKey,
    bucket: c.bucket,
    endpoint: endpointFor(c),
    // R2 ignores the region but the S3 protocol requires one.
    region: "auto",
  });
}

export interface SyncProgress {
  done: number;
  total: number;
  bytes: number;
  totalBytes: number;
  current: string;
  skipped: number;
}

/** Every file that belongs to a backup directory, as store-relative keys. */
function backupFiles(root: string): { rel: string; abs: string; size: number }[] {
  const out: { rel: string; abs: string; size: number }[] = [];
  const walk = (dir: string, base: string) => {
    for (const name of readdirSync(dir)) {
      const abs = join(dir, name);
      const st = statSync(abs);
      if (st.isDirectory()) walk(abs, base);
      // WAL/SHM are transient SQLite sidecars; the checkpointed .db is enough.
      else if (!name.endsWith("-wal") && !name.endsWith("-shm")) {
        out.push({ rel: abs.slice(base.length + 1).replace(/\\/g, "/"), abs, size: st.size });
      }
    }
  };
  walk(root, root);
  return out;
}

async function pool<T>(items: T[], limit: number, fn: (t: T) => Promise<void>): Promise<void> {
  let i = 0;
  const worker = async () => {
    for (;;) {
      const idx = i++;
      if (idx >= items.length) return;
      await fn(items[idx]!);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, limit) }, worker));
}

export async function upload(
  backupDir: string,
  c: R2Config,
  opts: { concurrency?: number; onProgress?: (p: SyncProgress) => void } = {},
): Promise<{ uploaded: number; skipped: number; bytes: number; errors: string[] }> {
  const client = makeClient(c);
  const files = backupFiles(backupDir);
  // Checkpoint WAL so manifest.db on its own is a complete, consistent copy.
  checkpoint(backupDir);

  const totalBytes = files.reduce((s, f) => s + f.size, 0);
  const errors: string[] = [];
  let done = 0, skipped = 0, bytes = 0;

  await pool(files, opts.concurrency ?? 8, async (f) => {
    const key = `${c.prefix}/${f.rel}`;
    try {
      const remote = client.file(key);
      // Blobs are immutable (hash-named): if it exists, it is identical.
      const isBlob = f.rel.startsWith("blobs/");
      if (isBlob && (await remote.exists())) {
        skipped++;
      } else {
        await remote.write(Bun.file(f.abs));
        bytes += f.size;
      }
    } catch (e) {
      errors.push(`${f.rel}: ${(e as Error).message}`);
    }
    done++;
    opts.onProgress?.({ done, total: files.length, bytes, totalBytes, current: f.rel, skipped });
  });

  return { uploaded: done - skipped, skipped, bytes, errors };
}

export async function download(
  backupDir: string,
  c: R2Config,
  opts: { concurrency?: number; onProgress?: (p: SyncProgress) => void } = {},
): Promise<{ downloaded: number; bytes: number; errors: string[] }> {
  const client = makeClient(c);
  mkdirSync(backupDir, { recursive: true });

  const keys: { key: string; size: number }[] = [];
  let token: string | undefined;
  do {
    const page = await client.list({ prefix: `${c.prefix}/`, continuationToken: token, maxKeys: 1000 });
    for (const o of page.contents ?? []) {
      if (o.key) keys.push({ key: o.key, size: o.size ?? 0 });
    }
    token = page.isTruncated ? page.nextContinuationToken : undefined;
  } while (token);

  const totalBytes = keys.reduce((s, k) => s + k.size, 0);
  const errors: string[] = [];
  let done = 0, bytes = 0;

  await pool(keys, opts.concurrency ?? 8, async (k) => {
    const rel = k.key.slice(c.prefix.length + 1);
    const dest = join(backupDir, rel.replace(/\//g, "\\"));
    try {
      // Resume-friendly: an already-complete local file is not fetched again.
      if (existsSync(dest) && statSync(dest).size === k.size && k.size > 0) {
        done++;
        opts.onProgress?.({ done, total: keys.length, bytes, totalBytes, current: rel, skipped: 0 });
        return;
      }
      mkdirSync(dirname(dest), { recursive: true });
      await Bun.write(dest, client.file(k.key));
      bytes += k.size;
    } catch (e) {
      errors.push(`${rel}: ${(e as Error).message}`);
    }
    done++;
    opts.onProgress?.({ done, total: keys.length, bytes, totalBytes, current: rel, skipped: 0 });
  });

  return { downloaded: done, bytes, errors };
}

/** Folds the WAL into the main database file before it is copied anywhere. */
function checkpoint(backupDir: string): void {
  const dbPath = join(backupDir, "manifest.db");
  if (!existsSync(dbPath)) return;
  try {
    const db = new Database(dbPath);
    db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
    db.close();
  } catch {
    /* a concurrent writer will checkpoint on close anyway */
  }
}

export async function testConnection(c: R2Config): Promise<{ ok: boolean; detail: string }> {
  try {
    const client = makeClient(c);
    const probe = client.file(`${c.prefix}/.winmigrate-probe`);
    await probe.write(new Date().toISOString());
    const back = await probe.text();
    await probe.delete();
    return { ok: true, detail: `write+read+delete OK (${back.slice(0, 19)})` };
  } catch (e) {
    return { ok: false, detail: (e as Error).message };
  }
}
