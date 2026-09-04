/*
  Content and layout rewriting on restore.

  Two problems are solved here:
  1. Config files hold absolute paths and the old username — they must be retargeted.
  2. Claude Code encodes a project's absolute path into the *folder name* under
     ~/.claude/projects, so a new drive letter or username orphans that history
     unless the folder is renamed to the newly-encoded path.
*/

import {
  fromPortable, normalizeSep, pathVariants, relocate,
  type MachineProfile, type Relocation, type VolumeMap,
} from "./portable.ts";
import type { Manifest } from "./manifest.ts";

/**
 * Claude Code's project-folder encoding: every character outside [A-Za-z0-9]
 * collapses to a dash. Verified against live folders, e.g.
 *   D:\CodeWorks                 -> D--CodeWorks
 *   d:\!Stable_Diffusion         -> d---Stable-Diffusion
 *   C:\Users\J\Desktop\Fia Billing -> C--Users-J-Desktop-Fia-Billing
 */
export function encodeClaudeProject(absPath: string): string {
  return normalizeSep(absPath).replace(/[^a-zA-Z0-9]/g, "-");
}

/** encoded folder name -> portable project path, captured at backup time. */
export type ProjectMap = Record<string, string>;

/**
 * Builds the encoded->portable map from the project list inside .claude.json.
 * Keys there are real absolute paths, which is what makes exact re-encoding possible.
 */
export function buildProjectMap(
  claudeJson: unknown,
  toPortableFn: (abs: string) => string,
): ProjectMap {
  const map: ProjectMap = {};
  const obj = claudeJson as { projects?: Record<string, unknown> } | null;
  if (!obj?.projects) return map;
  for (const raw of Object.keys(obj.projects)) {
    const abs = normalizeSep(raw);
    map[encodeClaudeProject(abs)] = toPortableFn(abs);
  }
  return map;
}

export interface RewriteContext {
  oldUser: string;
  oldHome: string;
  /** role -> old drive root, e.g. { CODE: "D:" } */
  oldVolumes: Record<string, string>;
  target: MachineProfile;
  volumeMap: VolumeMap;
  projectMap: ProjectMap;
  relocations: Relocation[];
}

/** Old absolute path -> new absolute path for each relocation rule. */
function relocationPairs(ctx: RewriteContext): Array<[string, string]> {
  const oldMachine: MachineProfile = {
    user: ctx.oldUser,
    home: ctx.oldHome,
    appdata: `${ctx.oldHome}\\AppData\\Roaming`,
    localAppdata: `${ctx.oldHome}\\AppData\\Local`,
    programFiles: "C:\\Program Files",
    programData: "C:\\ProgramData",
    volumes: Object.entries(ctx.oldVolumes).map(([role, root]) => ({
      role, guid: "", label: "", letter: root.replace(":", ""), sizeBytes: 0,
    })),
  };
  const out: Array<[string, string]> = [];
  for (const r of ctx.relocations) {
    try {
      out.push([fromPortable(r.from, oldMachine), fromPortable(r.to, ctx.target, ctx.volumeMap)]);
    } catch {
      /* unresolvable rule: skip rather than corrupt contents */
    }
  }
  return out;
}

/** Ordered old->new string pairs covering every spelling a path may take. */
function replacementPairs(ctx: RewriteContext): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];
  const push = (oldAbs: string, newAbs: string) => {
    if (!oldAbs || !newAbs) return;
    if (!oldAbs || !newAbs) return;
    const olds = pathVariants(oldAbs);
    for (const o of olds) {
      // Match the slash/escape style of the old spelling in the replacement.
      let n = normalizeSep(newAbs);
      if (o.includes("/") && !o.includes("\\")) n = n.replace(/\\/g, "/");
      else if (o.includes("\\\\")) n = n.replace(/\\/g, "\\\\");
      pairs.push([o, n]);
    }
  };

  // Relocations are more specific than the generic home/volume prefixes and are
  // longer, so the longest-first sort below naturally gives them priority.
  for (const [oldAbs, newAbs] of relocationPairs(ctx)) push(oldAbs, newAbs);

  for (const [role, oldRoot] of Object.entries(ctx.oldVolumes)) {
    const newRoot = ctx.volumeMap[role] ?? ctx.target.volumes.find((v) => v.role === role)?.letter;
    if (!newRoot) continue;
    const nr = newRoot.endsWith(":") ? newRoot : `${newRoot}:`;
    push(oldRoot, nr);
  }
  push(ctx.oldHome, ctx.target.home);

  // Longest patterns first: home lives under a volume, so it must win.
  pairs.sort((a, b) => b[0].length - a[0].length);

  if (ctx.oldUser && ctx.oldUser !== ctx.target.user) {
    pairs.push([ctx.oldUser, ctx.target.user]);
  }
  return pairs;
}

export function rewriteText(text: string, ctx: RewriteContext): string {
  let out = text;
  for (const [oldStr, newStr] of replacementPairs(ctx)) {
    if (oldStr === newStr) continue;
    // The bare username is the one pattern that is not a path: match it only
    // as a whole word, or "Max" would rewrite every "Maximum" in a config.
    if (oldStr === ctx.oldUser) {
      const re = new RegExp(`(?<![A-Za-z0-9_])${oldStr.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9_])`, "g");
      out = out.replace(re, () => newStr);
      continue;
    }
    out = out.replaceAll(oldStr, newStr);
  }
  return out;
}

/**
 * Rewrites a Claude Code projects/ path segment so the history keeps matching
 * the project's new location. Also folds the drive-letter casing duplicates
 * (C:/ vs c:/) that Claude Code otherwise treats as separate projects.
 */
export function rewriteProjectSegment(
  portablePath: string,
  ctx: RewriteContext,
): string {
  const marker = "\\.claude\\projects\\";
  const idx = portablePath.toLowerCase().indexOf(marker.toLowerCase());
  if (idx < 0) return portablePath;

  const head = portablePath.slice(0, idx + marker.length);
  const rest = portablePath.slice(idx + marker.length);
  const slash = rest.indexOf("\\");
  const encoded = slash < 0 ? rest : rest.slice(0, slash);
  const tail = slash < 0 ? "" : rest.slice(slash);

  const portableProject = ctx.projectMap[encoded];
  if (!portableProject) return portablePath; // unknown project: keep as-is

  let resolved: string;
  try {
    // Relocation first: a project moved off the Desktop must have its history
    // folder re-encoded against the new location, or the history is orphaned.
    resolved = fromPortable(relocate(portableProject, ctx.relocations), ctx.target, ctx.volumeMap);
  } catch {
    return portablePath;
  }
  // Normalize the drive letter to upper case so casing duplicates merge.
  resolved = resolved.replace(/^([a-z]):/, (_m, d: string) => d.toUpperCase() + ":");
  return head + encodeClaudeProject(resolved) + tail;
}

export function buildContext(
  mf: Manifest,
  target: MachineProfile,
  volumeMap: VolumeMap,
  relocations: Relocation[] = [],
): RewriteContext {
  const oldVolumes: Record<string, string> = {};
  for (const v of mf.volumes()) oldVolumes[v.role] = `${v.letter}:`;
  let projectMap: ProjectMap = {};
  const raw = mf.getMeta("projectMap");
  if (raw) {
    try {
      projectMap = JSON.parse(raw) as ProjectMap;
    } catch {
      projectMap = {};
    }
  }
  return {
    oldUser: mf.getMeta("user") ?? "",
    oldHome: mf.getMeta("home") ?? "",
    oldVolumes,
    target,
    volumeMap,
    projectMap,
    relocations,
  };
}

/** Text-ish payloads worth scanning for paths; binaries are left untouched. */
export function isRewritable(path: string, size: number): boolean {
  if (size > 32 * 1024 * 1024) return false;
  const lower = path.toLowerCase();
  return /\.(json|jsonl|md|txt|ya?ml|toml|ini|cfg|conf|sh|bat|cmd|ps1|ts|js|env|gitconfig|xml|log)$/.test(lower)
    || lower.endsWith("\\.gitconfig")
    || lower.endsWith("\\claude.md");
}
