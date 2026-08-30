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
  /** Set while building file lists, before any transfer starts. */
  phase?: "scanning" | "listing" | "transfer";
}

export interface SyncOptions {
  concurrency?: number;
  signal?: AbortSignal;
  onProgress?: (p: SyncProgress) => void;
}

/** Lists every key already in the bucket under the prefix, with sizes. */
async function remoteIndex(
  client: Bun.S3Client,
  prefix: string,
  opts: SyncOptions,
): Promise<Map<string, number>> {
  const index = new Map<string, number>();
  let token: string | undefined;
  do {
    if (opts.signal?.aborted) throw new DOMException("aborted", "AbortError");
    const page = await client.list({ prefix: `${prefix}/`, continuationToken: token, maxKeys: 1000 });
    for (const o of page.contents ?? []) {
      if (o.key) index.set(o.key, o.size ?? 0);
    }
    opts.onProgress?.({
      done: 0, total: 0, bytes: 0, totalBytes: 0, skipped: 0,
      current: `в облаке уже ${index.size} объектов`, phase: "listing",
    });
    token = page.isTruncated ? page.nextContinuationToken : undefined;
  } while (token);
  return index;
}

/** Every file that belongs to a backup directory, as store-relative keys. */
async function backupFiles(
  root: string,
  opts: SyncOptions,
): Promise<{ rel: string; abs: string; size: number }[]> {
  const out: { rel: string; abs: string; size: number }[] = [];
  let sinceYield = 0;

  const walk = async (dir: string, base: string): Promise<void> => {
    const names = readdirSync(dir);
    const subdirs: string[] = [];
    for (const name of names) {
      const abs = join(dir, name);
      const st = statSync(abs);
      if (st.isDirectory()) subdirs.push(abs);
      // WAL/SHM are transient SQLite sidecars; the checkpointed .db is enough.
      else if (!name.endsWith("-wal") && !name.endsWith("-shm")) {
        out.push({ rel: abs.slice(base.length + 1).replace(/\\/g, "/"), abs, size: st.size });
      }
      // The blob store holds hundreds of thousands of files; without yielding,
      // this walk blocks the event loop and looks like a hang.
      if (++sinceYield >= 2000) {
        sinceYield = 0;
        opts.onProgress?.({
          done: 0, total: 0, bytes: 0, totalBytes: 0, skipped: 0,
          current: `найдено ${out.length} файлов`, phase: "scanning",
        });
        await new Promise((r) => setImmediate(r));
        if (opts.signal?.aborted) throw new DOMException("aborted", "AbortError");
      }
    }
    for (const s of subdirs) await walk(s, base);
  };

  await walk(root, root);
  return out;
}

async function pool<T>(
  items: T[],
  limit: number,
  fn: (t: T) => Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  let i = 0;
  const worker = async () => {
    for (;;) {
      if (signal?.aborted) return;
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
  opts: SyncOptions = {},
): Promise<{ uploaded: number; skipped: number; bytes: number; errors: string[]; aborted: boolean }> {
  const client = makeClient(c);
  // Checkpoint WAL so manifest.db on its own is a complete, consistent copy.
  checkpoint(backupDir);

  const files = await backupFiles(backupDir, opts);
  // One listing instead of an existence check per object: with 228k blobs that
  // is ~230 requests rather than 228k round-trips.
  const remote = await remoteIndex(client, c.prefix, opts);

  const pending = files.filter((f) => {
    const key = `${c.prefix}/${f.rel}`;
    const known = remote.get(key);
    // Blobs are content-addressed and immutable: same key means same bytes.
    if (f.rel.startsWith("blobs/")) return known === undefined;
    // The manifest changes between runs, so re-upload unless size matches.
    return known !== f.size;
  });

  const skipped = files.length - pending.length;
  const totalBytes = pending.reduce((s, f) => s + f.size, 0);
  const errors: string[] = [];
  let done = 0, bytes = 0, aborted = false;

  // Blobs average a few hundred KB, so throughput is bound by per-request
  // latency rather than bandwidth: more parallel requests, not bigger ones.
  await pool(pending, opts.concurrency ?? 32, async (f) => {
    if (opts.signal?.aborted) { aborted = true; return; }
    try {
      await client.file(`${c.prefix}/${f.rel}`).write(Bun.file(f.abs));
      bytes += f.size;
    } catch (e) {
      errors.push(`${f.rel}: ${(e as Error).message}`);
    }
    done++;
    opts.onProgress?.({
      done, total: pending.length, bytes, totalBytes, current: f.rel, skipped, phase: "transfer",
    });
  }, opts.signal);

  return { uploaded: done, skipped, bytes, errors, aborted: aborted || !!opts.signal?.aborted };
}

export async function download(
  backupDir: string,
  c: R2Config,
  opts: SyncOptions = {},
): Promise<{ downloaded: number; bytes: number; errors: string[]; aborted: boolean }> {
  const client = makeClient(c);
  mkdirSync(backupDir, { recursive: true });

  const index = await remoteIndex(client, c.prefix, opts);
  const keys = [...index].map(([key, size]) => ({ key, size }));

  const totalBytes = keys.reduce((s, k) => s + k.size, 0);
  const errors: string[] = [];
  let done = 0, bytes = 0;

  await pool(keys, opts.concurrency ?? 32, async (k) => {
    if (opts.signal?.aborted) return;
    const rel = k.key.slice(c.prefix.length + 1);
    const dest = join(backupDir, rel.replace(/\//g, "\\"));
    try {
      // Resume-friendly: an already-complete local file is not fetched again.
      if (existsSync(dest) && statSync(dest).size === k.size && k.size > 0) {
        done++;
        opts.onProgress?.({
          done, total: keys.length, bytes, totalBytes, current: rel, skipped: 0, phase: "transfer",
        });
        return;
      }
      mkdirSync(dirname(dest), { recursive: true });
      await Bun.write(dest, client.file(k.key));
      bytes += k.size;
    } catch (e) {
      errors.push(`${rel}: ${(e as Error).message}`);
    }
    done++;
    opts.onProgress?.({
      done, total: keys.length, bytes, totalBytes, current: rel, skipped: 0, phase: "transfer",
    });
  }, opts.signal);

  return { downloaded: done, bytes, errors, aborted: !!opts.signal?.aborted };
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

export interface RemoteCheck {
  localFiles: number;
  remoteObjects: number;
  missing: { rel: string; size: number }[];
  sizeMismatch: { rel: string; local: number; remote: number }[];
  extra: string[];
}

/**
 * Compares the local backup against the bucket. An interrupted upload is safe
 * — object writes are atomic, so a key is either absent or complete — but this
 * proves it rather than assuming it.
 */
export async function verifyRemote(
  backupDir: string,
  c: R2Config,
  opts: SyncOptions = {},
): Promise<RemoteCheck> {
  const client = makeClient(c);
  const files = await backupFiles(backupDir, opts);
  const remote = await remoteIndex(client, c.prefix, opts);

  const missing: RemoteCheck["missing"] = [];
  const sizeMismatch: RemoteCheck["sizeMismatch"] = [];
  const seen = new Set<string>();

  for (const f of files) {
    const key = `${c.prefix}/${f.rel}`;
    seen.add(key);
    const size = remote.get(key);
    if (size === undefined) missing.push({ rel: f.rel, size: f.size });
    else if (size !== f.size) sizeMismatch.push({ rel: f.rel, local: f.size, remote: size });
  }

  const extra = [...remote.keys()].filter((k) => !seen.has(k));
  return {
    localFiles: files.length,
    remoteObjects: remote.size,
    missing,
    sizeMismatch,
    extra,
  };
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
