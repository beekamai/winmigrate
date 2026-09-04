/*
  Path portability core: converts absolute Windows paths to machine-independent
  placeholders and back, so a backup survives a different username and different
  drive letters. Volumes are identified by GUID/label, never by letter alone.
*/

import { $ } from "bun";

export interface VolumeInfo {
  guid: string;
  label: string;
  letter: string;
  sizeBytes: number;
  /** Stable name used inside placeholders, e.g. VOL:CODE */
  role: string;
}

export interface MachineProfile {
  user: string;
  home: string;
  appdata: string;
  localAppdata: string;
  programFiles: string;
  programData: string;
  volumes: VolumeInfo[];
}

const PH = {
  home: "{{HOME}}",
  user: "{{USER}}",
  appdata: "{{APPDATA}}",
  localAppdata: "{{LOCALAPPDATA}}",
  programFiles: "{{PROGRAMFILES}}",
  programData: "{{PROGRAMDATA}}",
} as const;

export function normalizeSep(p: string): string {
  return p.replace(/\//g, "\\");
}

/** Windows paths are case-insensitive; compare on a folded form. */
export function foldPath(p: string): string {
  return normalizeSep(p).replace(/\\+$/, "").toLowerCase();
}

interface RawVolume {
  DriveLetter: string | null;
  FileSystemLabel: string | null;
  UniqueId: string | null;
  Size: number | null;
}

export async function detectVolumes(): Promise<VolumeInfo[]> {
  const ps =
    "Get-Volume | Where-Object DriveLetter | " +
    "Select-Object DriveLetter,FileSystemLabel,UniqueId,Size | ConvertTo-Json -Compress";
  const out = await $`powershell -NoProfile -NonInteractive -Command ${ps}`.text();
  const parsed = JSON.parse(out.trim() || "[]");
  const list: RawVolume[] = Array.isArray(parsed) ? parsed : [parsed];
  const systemLetter = (process.env.SystemDrive ?? "C:").slice(0, 1).toUpperCase();

  return list
    .filter((v) => v.DriveLetter)
    .map((v) => {
      const letter = String(v.DriveLetter).toUpperCase();
      const label = (v.FileSystemLabel ?? "").trim();
      const guid = extractGuid(v.UniqueId ?? "");
      return {
        guid,
        label,
        letter,
        sizeBytes: v.Size ?? 0,
        // The Windows volume is SYSTEM whatever an installer labels it: a fresh
        // install must resolve {{VOL:SYSTEM}} without being asked.
        role: letter === systemLetter ? "SYSTEM" : label || `DISK_${letter}`,
      } satisfies VolumeInfo;
    });
}

function extractGuid(uniqueId: string): string {
  const m = uniqueId.match(/Volume\{([0-9a-f-]+)\}/i);
  return m?.[1]?.toLowerCase() ?? uniqueId;
}

export async function detectMachine(): Promise<MachineProfile> {
  const env = process.env;
  const home = normalizeSep(env.USERPROFILE ?? `C:\\Users\\${env.USERNAME ?? "user"}`);
  return {
    user: env.USERNAME ?? "user",
    home,
    appdata: normalizeSep(env.APPDATA ?? `${home}\\AppData\\Roaming`),
    localAppdata: normalizeSep(env.LOCALAPPDATA ?? `${home}\\AppData\\Local`),
    programFiles: normalizeSep(env.ProgramFiles ?? "C:\\Program Files"),
    programData: normalizeSep(env.ProgramData ?? "C:\\ProgramData"),
    volumes: await detectVolumes(),
  };
}

/**
 * Rewrites an absolute path into placeholder form.
 * Order matters: the most specific prefix (LOCALAPPDATA) must win over HOME.
 */
export function toPortable(abs: string, m: MachineProfile): string {
  const p = normalizeSep(abs);
  const prefixes: Array<[string, string]> = [
    [m.localAppdata, PH.localAppdata],
    [m.appdata, PH.appdata],
    [m.home, PH.home],
    [m.programFiles, PH.programFiles],
    [m.programData, PH.programData],
  ];
  for (const [real, ph] of prefixes) {
    if (real && startsWithPath(p, real)) return ph + p.slice(real.length);
  }
  const letter = p.slice(0, 1).toUpperCase();
  if (/^[A-Z]:\\/i.test(p)) {
    const vol = m.volumes.find((v) => v.letter === letter);
    if (vol) return `{{VOL:${vol.role}}}` + p.slice(2);
  }
  return p;
}

/** Resolution target for restore: role -> drive root (e.g. "CODE" -> "E:"). */
export type VolumeMap = Record<string, string>;

/**
 * Moves a subtree to a new home on restore, e.g. Desktop projects onto a data
 * drive. Both sides are placeholder paths, so the rule survives drive changes.
 */
export interface Relocation {
  from: string;
  to: string;
}

/** Applies the first matching relocation to a placeholder path. */
export function relocate(portable: string, rules: Relocation[]): string {
  for (const r of rules) {
    const a = foldPath(portable);
    const b = foldPath(r.from);
    if (a === b) return r.to;
    if (a.startsWith(b + "\\")) return r.to + portable.slice(r.from.length);
  }
  return portable;
}

/**
 * Parses `--relocate "{{HOME}}\Desktop={{VOL:DISK_D}}\Projects"`.
 * A bare drive path on either side is accepted and kept verbatim.
 */
export function parseRelocation(spec: string): Relocation {
  // Split on the '=' that separates the two paths, not on one inside {{VOL:..}}.
  const idx = spec.indexOf("=", spec.lastIndexOf("}}") + 1 || 0);
  const at = idx > 0 ? idx : spec.indexOf("=");
  if (at <= 0) throw new Error(`Bad --relocate value: ${spec} (expected FROM=TO)`);
  const from = normalizeSep(spec.slice(0, at).trim());
  const to = normalizeSep(spec.slice(at + 1).trim());
  if (!from || !to) throw new Error(`Bad --relocate value: ${spec} (expected FROM=TO)`);
  return { from, to };
}

export function fromPortable(portable: string, m: MachineProfile, map: VolumeMap = {}): string {
  let p = portable;
  p = p.replaceAll(PH.localAppdata, m.localAppdata);
  p = p.replaceAll(PH.appdata, m.appdata);
  p = p.replaceAll(PH.home, m.home);
  p = p.replaceAll(PH.programFiles, m.programFiles);
  p = p.replaceAll(PH.programData, m.programData);
  p = p.replaceAll(PH.user, m.user);
  p = p.replace(/\{\{VOL:([^}]+)\}\}/g, (_full, role: string) => {
    const explicit = map[role];
    if (explicit) return explicit.replace(/[\\/]+$/, "");
    const byRole = m.volumes.find((v) => v.role === role);
    if (byRole) return `${byRole.letter}:`;
    throw new Error(
      `Cannot resolve volume role "${role}". Pass --map ${role}=<DriveLetter>: to restore.`,
    );
  });
  return normalizeSep(p);
}

function startsWithPath(p: string, prefix: string): boolean {
  const a = foldPath(p);
  const b = foldPath(prefix);
  return a === b || a.startsWith(b + "\\");
}

/**
 * Builds every textual spelling of a path that may appear inside config files,
 * so content rewriting catches all of them (forward slashes, escaped, lowercase drive).
 */
export function pathVariants(abs: string): string[] {
  const win = normalizeSep(abs);
  const fwd = win.replace(/\\/g, "/");
  const escaped = win.replace(/\\/g, "\\\\");
  const lowerDrive = (s: string) => s.replace(/^([A-Z]):/, (_m, d: string) => d.toLowerCase() + ":");
  const upperDrive = (s: string) => s.replace(/^([a-z]):/, (_m, d: string) => d.toUpperCase() + ":");
  const set = new Set([
    win,
    fwd,
    escaped,
    lowerDrive(win),
    lowerDrive(fwd),
    lowerDrive(escaped),
    upperDrive(win),
    upperDrive(fwd),
    upperDrive(escaped),
  ]);
  // Longest first so that a nested path is replaced before its parent prefix.
  return [...set].sort((a, b) => b.length - a.length);
}
