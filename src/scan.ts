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
    // Trailing wildcard matches a whole path segment by prefix, e.g. "DataExport_*".
    if (pat.endsWith("*")) {
      const p = pat.slice(0, -1).toLowerCase();
      if (segs.some((s) => s.toLowerCase().startsWith(p))) return true;
      continue;
    }
    if (segs.some((s) => s.toLowerCase() === pat.toLowerCase())) return true;
  }
  return false;
}

function extAllowed(name: string, excludeExt?: string[], includeExt?: string[]): boolean {
  const dot = name.lastIndexOf(".");
  const ext = dot < 0 ? "" : name.slice(dot).toLowerCase();
  if (includeExt?.length) return ext !== "" && includeExt.includes(ext);
  if (!excludeExt?.length) return true;
  if (!ext) return true;
  return !excludeExt.includes(ext);
}

function sizeAllowed(size: number, rule: Rule): boolean {
  if (rule.maxFileSize !== undefined && size > rule.maxFileSize) return false;
  if (rule.minFileSize !== undefined && size < rule.minFileSize) return false;
  return true;
}

/**
 * A git object store must be taken whole: dropping a single packfile (they run
 * to hundreds of MB) leaves a repository that cannot be checked out. Size and
 * extension filters therefore never apply inside .git.
 */
export function insideGitDir(rel: string): boolean {
  return /(^|[\\/])\.git([\\/]|$)/i.test(rel);
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
          const inGit = insideGitDir(rel);
          if (!inGit && !extAllowed(ent.name, rule.excludeExt, rule.includeExt)) {
            ent = dir.readSync();
            continue;
          }
          const st = statSync(abs);
          if (inGit || sizeAllowed(st.size, rule)) {
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

/**
 * Explains whether one concrete file would be collected by a rule, and why not.
 * Used by the `check` command so a decision can be verified without a full scan.
 */
export function explain(abs: string, rule: Rule, size: number): { included: boolean; reason: string } {
  const root = rule.path.replace(/[\\/]+$/, "").toLowerCase();
  const file = abs.toLowerCase();
  if (file !== root && !file.startsWith(root + "\\")) {
    return { included: false, reason: "вне области правила" };
  }
  const rel = abs.slice(rule.path.length).replace(/^[\\/]/, "");
  if (excluded(rel, rule.exclude ?? [])) return { included: false, reason: "исключено правилом exclude" };
  if (!includeAllowed(rel, rule.includeOnly)) return { included: false, reason: "не входит в includeOnly" };
  if (insideGitDir(rel)) return { included: true, reason: "внутри .git — фильтры не применяются" };

  const dot = abs.lastIndexOf(".");
  const ext = dot < 0 ? "" : abs.slice(dot).toLowerCase();
  if (rule.includeExt?.length && !rule.includeExt.includes(ext)) {
    return { included: false, reason: `расширение ${ext || "(нет)"} не в includeExt` };
  }
  if (rule.excludeExt?.includes(ext)) return { included: false, reason: `расширение ${ext} в excludeExt` };
  if (rule.minFileSize !== undefined && size < rule.minFileSize) {
    return { included: false, reason: `меньше порога ${Math.round(rule.minFileSize / 1024)} KB` };
  }
  if (rule.maxFileSize !== undefined && size > rule.maxFileSize) {
    return { included: false, reason: `больше лимита ${Math.round(rule.maxFileSize / 1024 / 1024)} MB` };
  }
  return { included: true, reason: "подходит" };
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
      if (sizeAllowed(st.size, rule) && extAllowed(rule.path, rule.excludeExt, rule.includeExt)) {
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
