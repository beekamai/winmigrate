/*
  Backup manifest: SQLite index over a content-addressed blob store.
  Identical files are stored once (dedup by SHA-256), so duplicated model
  weights and repeated dependencies cost space only a single time.
*/

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { MachineProfile, VolumeInfo } from "./portable.ts";

export type RewriteKind = "none" | "json-paths" | "text-paths";

export interface EntryRow {
  id: number;
  profile: string;
  portable: string;
  source: string;
  size: number;
  mtime: number;
  hash: string;
  encrypted: number;
  rewrite: RewriteKind;
}

export interface BlobRow {
  hash: string;
  size: number;
  stored: number;
  codec: "zstd" | "store";
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS volumes (
  role   TEXT PRIMARY KEY,
  guid   TEXT NOT NULL,
  label  TEXT NOT NULL,
  letter TEXT NOT NULL,
  size   INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS blobs (
  hash   TEXT PRIMARY KEY,
  size   INTEGER NOT NULL,
  stored INTEGER NOT NULL,
  codec  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS entries (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  profile   TEXT NOT NULL,
  portable  TEXT NOT NULL,
  source    TEXT NOT NULL,
  size      INTEGER NOT NULL,
  mtime     INTEGER NOT NULL,
  hash      TEXT NOT NULL,
  encrypted INTEGER NOT NULL DEFAULT 0,
  rewrite   TEXT NOT NULL DEFAULT 'none',
  UNIQUE(profile, portable)
);
CREATE INDEX IF NOT EXISTS idx_entries_profile ON entries(profile);
CREATE INDEX IF NOT EXISTS idx_entries_hash    ON entries(hash);
`;

export class Manifest {
  readonly db: Database;
  readonly root: string;
  readonly blobDir: string;

  constructor(root: string) {
    this.root = root;
    this.blobDir = join(root, "blobs");
    mkdirSync(this.blobDir, { recursive: true });
    this.db = new Database(join(root, "manifest.db"), { create: true });
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA synchronous = NORMAL;");
    this.db.exec(SCHEMA);
  }

  blobPath(hash: string): string {
    return join(this.blobDir, hash.slice(0, 2), `${hash}.blob`);
  }

  setMeta(key: string, value: string): void {
    this.db.query("INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .run(key, value);
  }

  getMeta(key: string): string | undefined {
    const r = this.db.query<{ value: string }, [string]>("SELECT value FROM meta WHERE key=?").get(key);
    return r?.value;
  }

  saveMachine(m: MachineProfile): void {
    this.setMeta("user", m.user);
    this.setMeta("home", m.home);
    this.setMeta("createdAt", new Date().toISOString());
    const ins = this.db.query(
      "INSERT INTO volumes(role,guid,label,letter,size) VALUES(?,?,?,?,?) ON CONFLICT(role) DO UPDATE SET guid=excluded.guid,label=excluded.label,letter=excluded.letter,size=excluded.size",
    );
    for (const v of m.volumes) ins.run(v.role, v.guid, v.label, v.letter, v.sizeBytes);
  }

  volumes(): VolumeInfo[] {
    return this.db
      .query<{ role: string; guid: string; label: string; letter: string; size: number }, []>(
        "SELECT role,guid,label,letter,size FROM volumes",
      )
      .all()
      .map((r) => ({ role: r.role, guid: r.guid, label: r.label, letter: r.letter, sizeBytes: r.size }));
  }

  hasBlob(hash: string): boolean {
    return !!this.db.query<{ n: number }, [string]>("SELECT 1 AS n FROM blobs WHERE hash=?").get(hash);
  }

  addBlob(b: BlobRow): void {
    this.db
      .query("INSERT INTO blobs(hash,size,stored,codec) VALUES(?,?,?,?) ON CONFLICT(hash) DO NOTHING")
      .run(b.hash, b.size, b.stored, b.codec);
  }

  getBlob(hash: string): BlobRow | null {
    return this.db.query<BlobRow, [string]>("SELECT hash,size,stored,codec FROM blobs WHERE hash=?").get(hash);
  }

  addEntry(e: Omit<EntryRow, "id">): void {
    this.db
      .query(
        `INSERT INTO entries(profile,portable,source,size,mtime,hash,encrypted,rewrite)
         VALUES(?,?,?,?,?,?,?,?)
         ON CONFLICT(profile,portable) DO UPDATE SET
           source=excluded.source, size=excluded.size, mtime=excluded.mtime,
           hash=excluded.hash, encrypted=excluded.encrypted, rewrite=excluded.rewrite`,
      )
      .run(e.profile, e.portable, e.source, e.size, e.mtime, e.hash, e.encrypted, e.rewrite);
  }

  entries(profiles?: string[]): EntryRow[] {
    if (!profiles?.length) {
      return this.db.query<EntryRow, []>("SELECT * FROM entries ORDER BY portable").all();
    }
    const marks = profiles.map(() => "?").join(",");
    return this.db
      .query<EntryRow, string[]>(`SELECT * FROM entries WHERE profile IN (${marks}) ORDER BY portable`)
      .all(...profiles);
  }

  /** Aggregate stats used by the summary output. */
  stats(): { profile: string; files: number; logical: number }[] {
    return this.db
      .query<{ profile: string; files: number; logical: number }, []>(
        "SELECT profile, COUNT(*) AS files, COALESCE(SUM(size),0) AS logical FROM entries GROUP BY profile ORDER BY logical DESC",
      )
      .all();
  }

  storeStats(): { blobs: number; logical: number; stored: number } {
    const r = this.db
      .query<{ blobs: number; logical: number; stored: number }, []>(
        "SELECT COUNT(*) AS blobs, COALESCE(SUM(size),0) AS logical, COALESCE(SUM(stored),0) AS stored FROM blobs",
      )
      .get();
    return r ?? { blobs: 0, logical: 0, stored: 0 };
  }

  close(): void {
    this.db.close();
  }
}
