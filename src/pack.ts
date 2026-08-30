/*
  Packing stage: hash, dedupe, compress and store each scanned file.
  Large or already-compressed payloads are streamed verbatim to avoid
  loading multi-gigabyte weights into memory.
*/

import { createReadStream, createWriteStream, mkdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { pipeline } from "node:stream/promises";
import { createHash } from "node:crypto";
import { Manifest } from "./manifest.ts";
import { encrypt } from "./crypto.ts";
import { isIncompressible, humanBytes, type ScannedFile } from "./scan.ts";
import { normalizeSep, toPortable, type MachineProfile } from "./portable.ts";

/** Above this size we never buffer the whole file. */
const STREAM_THRESHOLD = 128 * 1024 * 1024;

/**
 * A file held by a running application can block a read forever — Chrome's
 * extension files froze a whole backup with no CPU and no I/O. Every read is
 * therefore abortable, so one locked file costs a delay, not the run.
 */
const FILE_TIMEOUT_MS = 90_000;

export interface PackOptions {
  concurrency: number;
  passphrase?: string;
  dryRun: boolean;
  /** Re-pack everything even if the manifest already has an identical entry. */
  force?: boolean;
  /** Stops the run cleanly; already-stored files are kept for a later resume. */
  signal?: AbortSignal;
  onProgress?: (done: number, total: number, bytes: number) => void;
}

async function hashStream(path: string): Promise<string> {
  const h = createHash("sha256");
  const signal = AbortSignal.timeout(FILE_TIMEOUT_MS);
  await pipeline(createReadStream(path, { signal }), async function* (src) {
    for await (const chunk of src) h.update(chunk as Buffer);
    yield Buffer.alloc(0);
  });
  return h.digest("hex");
}

async function copyStream(from: string, to: string): Promise<number> {
  mkdirSync(dirname(to), { recursive: true });
  let bytes = 0;
  const signal = AbortSignal.timeout(FILE_TIMEOUT_MS);
  await pipeline(
    createReadStream(from, { signal }),
    async function* (src) {
      for await (const c of src) {
        bytes += (c as Buffer).length;
        yield c;
      }
    },
    createWriteStream(to),
  );
  return bytes;
}

/** Reads a whole file, but never waits on a lock forever. */
async function readAll(path: string): Promise<Buffer> {
  return await readFile(path, { signal: AbortSignal.timeout(FILE_TIMEOUT_MS) });
}

async function packOne(
  f: ScannedFile,
  mf: Manifest,
  machine: MachineProfile,
  opts: PackOptions,
): Promise<number> {
  // A rule may declare its own destination root (e.g. gather scattered media
  // into one review folder) instead of restoring to the original location.
  const portable = f.rule.relocateTo
    ? normalizeSep(f.rule.relocateTo) + normalizeSep(f.abs).slice(normalizeSep(f.rule.path).length)
    : toPortable(f.abs, machine);
  const secret = f.rule.secret === true;

  // Resume support: an entry with the same size and mtime whose blob is still
  // present is already backed up. Skipping avoids re-reading the file at all,
  // which is what makes an interrupted backup cheap to continue.
  if (!opts.force && !opts.dryRun) {
    const prev = mf.getEntry(f.profile, portable);
    if (prev && prev.size === f.size && prev.mtime === f.mtime) {
      if (await Bun.file(mf.blobPath(prev.hash)).exists()) return f.size;
    }
  }

  const streaming = f.size >= STREAM_THRESHOLD;

  let hash: string;
  let payload: Buffer | null = null;

  if (streaming) {
    hash = await hashStream(f.abs);
  } else {
    const buf = await readAll(f.abs);
    hash = createHash("sha256").update(buf).digest("hex");
    payload = buf;
  }

  // Secrets get a per-file random salt/IV, so their ciphertext is never
  // byte-identical; dedupe would be meaningless and is skipped.
  const dedupable = !secret;

  if (opts.dryRun) {
    mf.addEntry({
      profile: f.profile, portable, source: f.abs, size: f.size,
      mtime: f.mtime, hash, encrypted: secret ? 1 : 0, rewrite: f.rule.rewrite ?? "none",
    });
    if (dedupable && !mf.hasBlob(hash)) mf.addBlob({ hash, size: f.size, stored: f.size, codec: "store" });
    return f.size;
  }

  if (!(dedupable && mf.hasBlob(hash))) {
    const dest = mf.blobPath(secret ? `${hash}.s` : hash);
    const store = streaming || f.rule.store === true || isIncompressible(f.abs);
    let stored: number;
    let codec: "zstd" | "store";

    if (streaming) {
      stored = await copyStream(f.abs, dest);
      codec = "store";
    } else {
      const buf: Buffer = payload!;
      let outBuf: Buffer;
      if (store) {
        outBuf = buf;
        codec = "store";
      } else {
        // Async variant runs on Bun's thread pool, so workers actually overlap.
        const z = await Bun.zstdCompress(buf, { level: 3 });
        // Fall back to raw when compression does not pay off.
        if (z.length < buf.length * 0.95) {
          outBuf = Buffer.from(z);
          codec = "zstd";
        } else {
          outBuf = buf;
          codec = "store";
        }
      }
      if (secret) {
        if (!opts.passphrase) throw new Error("Secrets profile requires a passphrase");
        outBuf = encrypt(outBuf, opts.passphrase);
      }
      mkdirSync(dirname(dest), { recursive: true });
      await Bun.write(dest, outBuf);
      stored = outBuf.length;
    }
    mf.addBlob({ hash: secret ? `${hash}.s` : hash, size: f.size, stored, codec });
  }

  mf.addEntry({
    profile: f.profile,
    portable,
    source: f.abs,
    size: f.size,
    mtime: f.mtime,
    hash: secret ? `${hash}.s` : hash,
    encrypted: secret ? 1 : 0,
    rewrite: f.rule.rewrite ?? "none",
  });
  return f.size;
}

export async function packAll(
  files: ScannedFile[],
  mf: Manifest,
  machine: MachineProfile,
  opts: PackOptions,
): Promise<{ files: number; bytes: number; errors: string[]; aborted: boolean }> {
  const errors: string[] = [];
  let done = 0;
  let bytes = 0;
  let cursor = 0;
  let aborted = false;

  // Ctrl+C stops cleanly: workers finish the file in flight, the manifest is
  // left consistent, and a later run resumes from what is already stored.
  const onSigint = () => {
    if (!aborted) {
      aborted = true;
      process.stdout.write("\n  прерывание — доканчиваю текущие файлы, прогресс сохраняется…\n");
    }
  };
  process.on("SIGINT", onSigint);
  opts.signal?.addEventListener("abort", onSigint, { once: true });

  // Writes go through one SQLite connection, so transactions batch by worker turn.
  const worker = async () => {
    for (;;) {
      if (aborted || opts.signal?.aborted) return;
      const i = cursor++;
      if (i >= files.length) return;
      const f = files[i]!;
      try {
        // Must not be `bytes += await ...`: the left operand is read before the
        // await resumes, so concurrent workers would clobber each other's sum.
        const n = await packOne(f, mf, machine, opts);
        bytes += n;
      } catch (e) {
        const err = e as Error;
        const locked = err.name === "AbortError" || err.name === "TimeoutError"
          || /aborted|EBUSY|EPERM|being used by another process/i.test(err.message);
        errors.push(
          locked
            ? `${f.abs}: файл заблокирован приложением — пропущен`
            : `${f.abs}: ${err.message}`,
        );
      }
      done++;
      if (done % 200 === 0) opts.onProgress?.(done, files.length, bytes);
    }
  };

  try {
    await Promise.all(Array.from({ length: Math.max(1, opts.concurrency) }, worker));
  } finally {
    process.off("SIGINT", onSigint);
    opts.signal?.removeEventListener("abort", onSigint);
  }
  opts.onProgress?.(done, files.length, bytes);
  return { files: done, bytes, errors, aborted };
}

export { humanBytes };
