# winmigrate

Portable backup/restore of a Windows dev environment. Built to survive a clean
Windows reinstall where **the username and the drive letters may both change**.

Stack: Bun + TypeScript, no runtime dependencies (SQLite and zstd are built into Bun).

## Why it exists

Copying `~/.claude` to a new machine silently loses work. Two reasons:

1. Claude Code encodes a project's **absolute path into the folder name** under
   `~/.claude/projects` (`D:\CodeWorks` → `D--CodeWorks`). A new drive letter or
   username orphans that history — the files are there, but Claude Code will
   never look at them again.
2. `.claude.json` holds absolute paths (project list, MCP server entry points).
   Restored verbatim onto a different machine, every MCP server fails to start.

`winmigrate` stores paths as placeholders and rewrites them — in filenames *and*
in file contents — at restore time.

## Commands

```bash
bun run src/cli.ts plan                      # what would be collected
bun run src/cli.ts backup -p 'claude,apps' -o D:\wm-backup --pass <secret>
bun run src/cli.ts verify -o D:\wm-backup
bun run src/cli.ts restore --from E:\wm-backup --map 'DISK_D=E:' -n
bun run src/cli.ts gitsave                   # plan pushing local-only repos

# Move projects off the system disk on restore; history follows them:
bun run src/cli.ts restore -p code,claude --from E:\wm-backup \
  --relocate "{{HOME}}\Desktop={{VOL:DISK_D}}\Projects"
```

`restore` and `gitsave` never write anything until explicitly told: `restore`
needs the absence of `-n`, `gitsave` needs `--apply`.

## Design decisions

**Placeholders, not paths.** `toPortable`/`fromPortable` in `src/portable.ts`
map `C:\Users\Jaros\.claude` → `{{HOME}}\.claude` and `D:\CodeWorks` →
`{{VOL:DISK_D}}\CodeWorks`. Volumes are keyed by a *role* (label, or `DISK_<letter>`
when unlabeled) rather than a bare letter, so `--map DISK_D=E:` retargets a whole
tree. An unresolvable role throws instead of silently writing to the wrong disk.

**Project re-encoding.** `encodeClaudeProject` reproduces Claude Code's rule
(every non-alphanumeric character becomes `-`), verified against live folder
names. The encoded→real mapping is captured at backup time from the `projects`
keys inside `.claude.json`, because that is the only place the *real* paths
survive; the folder name itself is lossy and cannot be decoded back.
Restoring also normalises the drive-letter case, which merges the duplicate
`C:/…` vs `c:/…` project entries Claude Code otherwise treats as separate.

**Relocation.** `--relocate FROM=TO` moves a subtree on restore (both sides are
placeholder paths). It is applied in three places that must agree, or history
silently detaches from its project: the destination filename, the re-encoded
Claude history folder, and the path strings inside configs. Relocation pairs are
longer than the generic home/volume prefixes, so the longest-first sort in
`replacementPairs` gives them priority automatically. Prefix matching is
segment-aware — a rule for `Desktop` must not swallow `DesktopBackup`.

**Content rewriting** (`src/rewrite.ts`) replaces every spelling a path takes in
configs: backslash, forward slash, escaped (`D:\\CodeWorks`), and lowercase
drive letters. Replacements are applied longest-first so a parent prefix cannot
eat a nested match, and `HOME` is applied before the volume it lives under.

**Content-addressed store.** Files are deduped by SHA-256 into
`blobs/<xx>/<hash>.blob`, indexed by `manifest.db`. Duplicated model weights and
repeated dependency copies cost space once. Layout is rclone-friendly, so
syncing to R2 is incremental.

**Compression policy.** zstd level 3 for text; already-compressed payloads
(media, `.safetensors`, archives) and anything ≥128 MB are stored verbatim and
streamed, so multi-gigabyte weights never land in memory. Compression falls back
to raw when it saves less than 5%.

**Secrets** are AES-256-GCM encrypted under a scrypt-derived key
(`src/crypto.ts`). Because each file gets a random salt and IV, ciphertext is
never byte-identical and dedup is deliberately skipped for that profile.

**gitsave refuses rather than leaks.** A project is not pushed while any
secret-bearing file would land in a commit — checked with `git check-ignore`,
re-checked after `.gitignore` is written and before anything is staged. Losing a
repo is recoverable from the backup; a leaked key in a pushed commit is not.

## Profile sizing lessons

Raw directory size is a terrible guide to what is worth keeping:

- `code` measured 67 GB across 1.64M files. Actual source is ~13 GB / 260K files.
  The difference was one API cache (`marci_ai/cache/stratz/matches`, **1.3M
  cached JSON responses**), vendored dependency trees, local database state
  (`.local/mysql-data`), and packaged binaries.
- Hence `maxFileSize` (25 MB for code — a 2.8 GB `usage.db` is not source) and
  `excludeExt` for compiled/packaged output.
- Several apps invert the ratio: `%APPDATA%\obsidian` is pure Electron cache
  while the actual notes live in a vault elsewhere on disk. Always locate the
  data, never assume it sits under the app's config directory.
- `.claude.json` must be treated as a secret: MCP server definitions embed live
  API keys in their `env` blocks.

## Gotchas

- `bytes += await f()` is a race: the left operand is read before the await
  resumes, so concurrent workers clobber the sum. Assign to a temp first.
- Use `Bun.zstdCompress` (async, thread pool), not `zstdCompressSync` — the sync
  variant blocks the event loop and defeats the worker pool entirely (2.3x slower).
- PowerShell turns `-p a,b` into an array and joins with spaces; the arg parser
  accepts both `,` and whitespace as separators.

## Testing

`bun test` — `test/remap.test.ts` covers the scenario that motivates the tool:
username change, drive-letter change, casing duplicates, unknown folders left
untouched, unmapped volumes failing loudly, and secret round-trips.
