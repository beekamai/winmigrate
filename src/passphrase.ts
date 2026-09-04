/*
  Guards against the one mistake encryption cannot undo: continuing a backup
  under a different passphrase than the one already used, which leaves blobs
  that no single passphrase can open. A verifier is stored in the manifest;
  backups made before it existed are checked against a real encrypted blob.
*/

import { Manifest } from "./manifest.ts";
import { decrypt, encrypt } from "./crypto.ts";

const META_KEY = "passCheck";
const CANARY = Buffer.from("winmigrate passphrase check");

export type PassVerdict = "ok" | "wrong" | "unknown";

/**
 * "unknown" means the backup holds nothing encrypted yet, so any passphrase is
 * acceptable and becomes the one this backup is bound to.
 */
export async function verifyPassphrase(mf: Manifest, pass: string): Promise<PassVerdict> {
  const stored = mf.getMeta(META_KEY);
  if (stored) {
    try {
      return decrypt(Buffer.from(stored, "base64"), pass).equals(CANARY) ? "ok" : "wrong";
    } catch {
      return "wrong";
    }
  }
  // Legacy backup without a verifier: the smallest encrypted blob on disk is the
  // ground truth for what passphrase this backup was made with.
  const rows = mf.db
    .query<{ hash: string }, []>(
      "SELECT hash FROM entries WHERE encrypted=1 ORDER BY size ASC LIMIT 20",
    )
    .all();
  for (const r of rows) {
    const f = Bun.file(mf.blobPath(r.hash));
    if (!(await f.exists())) continue;
    try {
      decrypt(Buffer.from(await f.arrayBuffer()), pass);
      return "ok";
    } catch {
      return "wrong";
    }
  }
  return "unknown";
}

/** Binds the backup to this passphrase; a no-op once a verifier exists. */
export function registerPassphrase(mf: Manifest, pass: string): void {
  if (mf.getMeta(META_KEY)) return;
  mf.setMeta(META_KEY, encrypt(CANARY, pass).toString("base64"));
}
