/*
  Restore stage: materialises files from the blob store onto a possibly
  different machine, remapping paths in both filenames and file contents.
*/

import { mkdirSync, existsSync, utimesSync } from "node:fs";
import { dirname } from "node:path";
import { Manifest, type EntryRow } from "./manifest.ts";
import { decrypt } from "./crypto.ts";
import { fromPortable, relocate, type MachineProfile, type Relocation, type VolumeMap } from "./portable.ts";
import { buildContext, isRewritable, rewriteProjectSegment, rewriteText } from "./rewrite.ts";

export interface RestoreOptions {
  profiles?: string[];
  volumeMap: VolumeMap;
  relocations?: Relocation[];
  passphrase?: string;
  dryRun: boolean;
  overwrite: boolean;
  onProgress?: (done: number, total: number) => void;
}

export interface RestorePlanItem {
  from: string;
  to: string;
  size: number;
  rewritten: boolean;
  encrypted: boolean;
}

/** A Claude Code history folder whose encoded name changes on this machine. */
export interface ProjectRename {
  before: string;
  after: string;
}

function projectFolder(portable: string): string | null {
  const m = portable.match(/\.claude[\\/]projects[\\/]([^\\/]+)/i);
  return m?.[1] ?? null;
}

async function readBlob(mf: Manifest, e: EntryRow, passphrase?: string): Promise<Buffer> {
  const blob = mf.getBlob(e.hash);
  if (!blob) throw new Error(`missing blob for ${e.portable}`);
  let buf: Buffer = Buffer.from(await Bun.file(mf.blobPath(e.hash)).arrayBuffer());
  if (e.encrypted) {
    if (!passphrase) throw new Error("passphrase required for encrypted entries");
    buf = decrypt(buf, passphrase);
  }
  if (blob.codec === "zstd") buf = Buffer.from(await Bun.zstdDecompress(buf));
  return buf;
}

export async function restore(
  mf: Manifest,
  target: MachineProfile,
  opts: RestoreOptions,
): Promise<{ items: RestorePlanItem[]; errors: string[]; renames: ProjectRename[] }> {
  const relocations = opts.relocations ?? [];
  const ctx = buildContext(mf, target, opts.volumeMap, relocations);
  const entries = mf.entries(opts.profiles);
  const items: RestorePlanItem[] = [];
  const errors: string[] = [];
  const renameMap = new Map<string, string>();
  let done = 0;

  for (const e of entries) {
    try {
      // Relocate the file itself first, then re-encode any Claude history folder.
      const relocated = relocate(e.portable, relocations);
      const remapped = rewriteProjectSegment(relocated, ctx);
      const before = projectFolder(e.portable);
      const after = projectFolder(remapped);
      if (before && after && before !== after) renameMap.set(before, after);
      const dest = fromPortable(remapped, target, opts.volumeMap);
      const willRewrite = e.rewrite !== "none" && isRewritable(e.portable, e.size);
      items.push({
        from: e.portable,
        to: dest,
        size: e.size,
        rewritten: willRewrite,
        encrypted: !!e.encrypted,
      });

      if (opts.dryRun) {
        done++;
        continue;
      }
      if (existsSync(dest) && !opts.overwrite) {
        done++;
        continue;
      }

      let buf = await readBlob(mf, e, opts.passphrase);
      if (willRewrite) {
        const text = buf.toString("utf8");
        // Only rewrite when the payload really is UTF-8 text.
        if (!text.includes("�")) buf = Buffer.from(rewriteText(text, ctx), "utf8");
      }
      mkdirSync(dirname(dest), { recursive: true });
      await Bun.write(dest, buf);
      const t = new Date(e.mtime);
      try {
        utimesSync(dest, t, t);
      } catch {
        /* best effort */
      }
    } catch (err) {
      errors.push(`${e.portable}: ${(err as Error).message}`);
    }
    done++;
    if (done % 200 === 0) opts.onProgress?.(done, entries.length);
  }
  opts.onProgress?.(done, entries.length);
  const renames = [...renameMap].map(([before, after]) => ({ before, after }));
  return { items, errors, renames };
}

/** Verifies every referenced blob exists and its stored size matches. */
export async function verify(mf: Manifest): Promise<{ ok: number; bad: string[] }> {
  const entries = mf.entries();
  const bad: string[] = [];
  let ok = 0;
  const seen = new Set<string>();
  for (const e of entries) {
    if (seen.has(e.hash)) {
      ok++;
      continue;
    }
    seen.add(e.hash);
    const blob = mf.getBlob(e.hash);
    if (!blob) {
      bad.push(`no blob row: ${e.portable}`);
      continue;
    }
    const f = Bun.file(mf.blobPath(e.hash));
    if (!(await f.exists())) {
      bad.push(`blob file missing: ${e.portable}`);
      continue;
    }
    if (f.size !== blob.stored) {
      bad.push(`size mismatch (${f.size} != ${blob.stored}): ${e.portable}`);
      continue;
    }
    ok++;
  }
  return { ok, bad };
}
