/*
  Removes entries a backup should no longer contain, plus the blobs they were
  the last reference to.

  Needed whenever rules tighten: a file collected under old rules stays in the
  store forever otherwise. That matters most for secrets — plaintext copies
  captured before a rule started encrypting them must actually be deleted.
*/

import { existsSync, rmSync } from "node:fs";
import { Manifest } from "./manifest.ts";
import { PROFILES, profileByName } from "./profiles.ts";
import { scanProfile } from "./scan.ts";
import { normalizeSep, toPortable, type MachineProfile } from "./portable.ts";

export interface PruneResult {
  staleEntries: { portable: string; profile: string; size: number; encrypted: number }[];
  orphanBlobs: { hash: string; stored: number }[];
  freed: number;
}

/** Portable paths the current rules would produce for a profile. */
function currentPortables(profileName: string, machine: MachineProfile): Set<string> {
  const p = profileByName(profileName);
  const out = new Set<string>();
  if (!p) return out;
  for (const f of scanProfile(p)) {
    const portable = f.rule.relocateTo
      ? normalizeSep(f.rule.relocateTo) + normalizeSep(f.abs).slice(normalizeSep(f.rule.path).length)
      : toPortable(f.abs, machine);
    // Encryption is part of identity here: the same path stored unencrypted is
    // stale once its rule became secret.
    out.add(`${portable.toLowerCase()}|${f.rule.secret ? 1 : 0}`);
  }
  return out;
}

export function prune(mf: Manifest, machine: MachineProfile, apply: boolean): PruneResult {
  const inBackup = [...new Set(mf.entries().map((e) => e.profile))];
  const stale: PruneResult["staleEntries"] = [];

  for (const profileName of inBackup) {
    // A profile no longer defined at all: leave it alone rather than guess.
    if (!PROFILES.some((p) => p.name === profileName)) continue;
    const wanted = currentPortables(profileName, machine);
    for (const e of mf.entries([profileName])) {
      if (!wanted.has(`${e.portable.toLowerCase()}|${e.encrypted ? 1 : 0}`)) {
        stale.push({ portable: e.portable, profile: e.profile, size: e.size, encrypted: e.encrypted });
      }
    }
  }

  if (apply && stale.length) {
    const del = mf.db.query("DELETE FROM entries WHERE profile=? AND portable=?");
    for (const s of stale) del.run(s.profile, s.portable);
  }

  // Blobs with no remaining reference are dead weight (and, for a plaintext
  // secret, a leak that survives the entry deletion).
  const orphans = mf.db
    .query<{ hash: string; stored: number }, []>(
      "SELECT hash, stored FROM blobs WHERE hash NOT IN (SELECT DISTINCT hash FROM entries)",
    )
    .all();

  let freed = 0;
  for (const o of orphans) {
    freed += o.stored;
    if (apply) {
      const p = mf.blobPath(o.hash);
      if (existsSync(p)) {
        try { rmSync(p); } catch { /* locked */ }
      }
    }
  }
  if (apply && orphans.length) {
    mf.db.exec("DELETE FROM blobs WHERE hash NOT IN (SELECT DISTINCT hash FROM entries)");
  }

  return { staleEntries: stale, orphanBlobs: orphans, freed };
}
