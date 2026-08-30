/*
  Filesystem walker driven by profile rules. Produces the file list to back up,
  applying global excludes, per-rule excludes and include filters.
*/

import { opendirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { GLOBAL_EXCLUDES, type Profile, type Rule } from "./profiles.ts";

export interface ScannedFile {
  abs: string;
  size: number;
  mtime: number;
  rule: Rule;
  profile: string;
}

/** Payloads that are already compressed — spending CPU on zstd is wasted work. */
const INCOMPRESSIBLE = new Set([
  ".jpg", ".jpeg", ".png", ".gif", ".webp", ".heic", ".avif",
  ".mp4", ".mkv", ".mov", ".avi", ".webm", ".m4v",
  ".mp3", ".aac", ".ogg", ".opus", ".flac", ".m4a",
  ".zip", ".7z", ".rar", ".gz", ".xz", ".zst", ".bz2",
  ".safetensors", ".ckpt", ".pt", ".pth", ".gguf", ".onnx", ".bin",
  ".pdf", ".psd", ".exe", ".dll", ".wasm",
]);

export function isIncompressible(path: string): boolean {
  const dot = path.lastIndexOf(".");
  if (dot < 0) return false;
  return INCOMPRESSIBLE.has(path.slice(dot).toLowerCase());
}

function segments(rel: string): string[] {
  return rel.split(/[\\/]/).filter(Boolean);
}

function excluded(rel: string, extra: string[]): boolean {
  const segs = segments(rel);
  const relFwd = rel.replace(/\\/g, "/");
  for (const pat of [...GLOBAL_EXCLUDES, ...extra]) {
    if (pat.includes("/")) {
      if (relFwd.includes(pat)) return true;
      continue;
    }
    if (pat.startsWith("*.")) {
      if (relFwd.toLowerCase().endsWith(pat.slice(1).toLowerCase())) return true;
      continue;
    }
    if (segs.some((s) => s.toLowerCase() === pat.toLowerCase())) return true;
  }
  return false;
}

function extAllowed(name: string, excludeExt?: string[]): boolean {
  if (!excludeExt?.length) return true;
  const dot = name.lastIndexOf(".");
  if (dot < 0) return true;
  return !excludeExt.includes(name.slice(dot).toLowerCase());
}

function includeAllowed(rel: string, includeOnly?: string[]): boolean {
  if (!includeOnly?.length) return true;
  const first = segments(rel)[0]?.toLowerCase() ?? "";
  const full = rel.replace(/\\/g, "/").toLowerCase();
  return includeOnly.some((i) => {
    const k = i.toLowerCase();
    return first === k || full === k || full.startsWith(k + "/");
  });
}

function walk(root: string, rule: Rule, profile: string, out: ScannedFile[]): void {
  let dir;
  try {
    dir = opendirSync(root);
  } catch {
    return;
  }
  try {
    let ent = dir.readSync();
    while (ent) {
      const abs = join(root, ent.name);
      // Reparse points (junctions/symlinks) would duplicate trees or loop.
      if (ent.isSymbolicLink()) {
        ent = dir.readSync();
        continue;
      }
      const rel = relative(rule.path, abs);
      if (excluded(rel, rule.exclude ?? []) || !includeAllowed(rel, rule.includeOnly)) {
        ent = dir.readSync();
        continue;
      }
      if (ent.isDirectory()) {
        walk(abs, rule, profile, out);
      } else if (ent.isFile()) {
        try {
          if (!extAllowed(ent.name, rule.excludeExt)) {
            ent = dir.readSync();
            continue;
          }
          const st = statSync(abs);
          if (rule.maxFileSize === undefined || st.size <= rule.maxFileSize) {
            out.push({ abs, size: st.size, mtime: Math.floor(st.mtimeMs), rule, profile });
          }
        } catch {
          /* vanished or locked mid-scan */
        }
      }
      ent = dir.readSync();
    }
  } finally {
    dir.closeSync();
  }
}

export function scanProfile(p: Profile): ScannedFile[] {
  const out: ScannedFile[] = [];
  for (const rule of p.rules) {
    let st;
    try {
      st = statSync(rule.path);
    } catch {
      continue; // rule points at something absent on this machine
    }
    if (st.isDirectory()) {
      walk(rule.path, rule, p.name, out);
    } else if (st.isFile()) {
      const over = rule.maxFileSize !== undefined && st.size > rule.maxFileSize;
      if (!over && extAllowed(rule.path, rule.excludeExt)) {
        out.push({ abs: rule.path, size: st.size, mtime: Math.floor(st.mtimeMs), rule, profile: p.name });
      }
    }
  }
  return out;
}

export function humanBytes(n: number): string {
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${u[i]}`;
}

export { sep };
