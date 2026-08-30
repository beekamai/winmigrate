/*
  Packing stage: hash, dedupe, compress and store each scanned file.
  Large or already-compressed payloads are streamed verbatim to avoid
  loading multi-gigabyte weights into memory.
*/

import { createReadStream, createWriteStream, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { pipeline } from "node:stream/promises";
import { createHash } from "node:crypto";
import { Manifest } from "./manifest.ts";
import { encrypt } from "./crypto.ts";
import { isIncompressible, humanBytes, type ScannedFile } from "./scan.ts";
import { toPortable, type MachineProfile } from "./portable.ts";

/** Above this size we never buffer the whole file. */
const STREAM_THRESHOLD = 128 * 1024 * 1024;

export interface PackOptions {
  concurrency: number;
  passphrase?: string;
  dryRun: boolean;
  onProgress?: (done: number, total: number, bytes: number) => void;
}

async function hashStream(path: string): Promise<string> {
  const h = createHash("sha256");
  await pipeline(createReadStream(path), async function* (src) {
    for await (const chunk of src) h.update(chunk as Buffer);
    yield Buffer.alloc(0);
  });
  return h.digest("hex");
}

async function copyStream(from: string, to: string): Promise<number> {
  mkdirSync(dirname(to), { recursive: true });
  let bytes = 0;
  await pipeline(
    createReadStream(from),
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

async function packOne(
  f: ScannedFile,
  mf: Manifest,
  machine: MachineProfile,
  opts: PackOptions,
): Promise<number> {
  const portable = toPortable(f.abs, machine);
  const secret = f.rule.secret === true;
  const streaming = f.size >= STREAM_THRESHOLD;

  let hash: string;
  let payload: Buffer | null = null;

  if (streaming) {
    hash = await hashStream(f.abs);
  } else {
    const buf = Buffer.from(await Bun.file(f.abs).arrayBuffer());
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
): Promise<{ files: number; bytes: number; errors: string[] }> {
  const errors: string[] = [];
  let done = 0;
  let bytes = 0;
  let cursor = 0;

  // Writes go through one SQLite connection, so transactions batch by worker turn.
  const worker = async () => {
    for (;;) {
      const i = cursor++;
      if (i >= files.length) return;
      const f = files[i]!;
      try {
        // Must not be `bytes += await ...`: the left operand is read before the
        // await resumes, so concurrent workers would clobber each other's sum.
        const n = await packOne(f, mf, machine, opts);
        bytes += n;
      } catch (e) {
        errors.push(`${f.abs}: ${(e as Error).message}`);
      }
      done++;
      if (done % 200 === 0) opts.onProgress?.(done, files.length, bytes);
    }
  };

  await Promise.all(Array.from({ length: Math.max(1, opts.concurrency) }, worker));
  opts.onProgress?.(done, files.length, bytes);
  return { files: done, bytes, errors };
}

export { humanBytes };
