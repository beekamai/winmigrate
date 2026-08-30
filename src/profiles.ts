/*
  Backup profiles: declarative rules for what to collect, what to skip,
  and which files need their contents rewritten on restore.

  Sizing note: rules deliberately exclude regenerable caches. Several apps keep
  a few hundred MB of Electron cache next to a few hundred KB of real state.
*/

import type { RewriteKind } from "./manifest.ts";

export interface Rule {
  /** Absolute source path (file or directory). Missing paths are skipped silently. */
  path: string;
  /** Extra excludes on top of the global list, matched against the relative path. */
  exclude?: string[];
  /** Only these top-level names are taken (simple prefix match, no globs). */
  includeOnly?: string[];
  rewrite?: RewriteKind;
  /** Skip files larger than this. Source code never is; databases and blobs are. */
  maxFileSize?: number;
  /** Skip files smaller than this — filters out icons and sprite junk. */
  minFileSize?: number;
  /** Skip these extensions (lowercase, with dot). */
  excludeExt?: string[];
  /** Take ONLY these extensions (lowercase, with dot). */
  includeExt?: string[];
  /**
   * Restore this rule's files under a different root instead of their original
   * location, preserving the tree below `path`. Used to gather scattered media
   * into one folder for manual review rather than scattering it again.
   */
  relocateTo?: string;
  /** Encrypt with the backup passphrase. */
  secret?: boolean;
  /** Skip compression: already-compressed payloads (media, model weights). */
  store?: boolean;
}

export interface Profile {
  name: string;
  description: string;
  rules: Rule[];
}

/** Directories that never belong in a backup: rebuildable or pure cache. */
export const GLOBAL_EXCLUDES = [
  "node_modules", ".venv", "venv", "__pycache__", ".next", ".nuxt", ".turbo",
  "target/debug", "target/release", "build/intermediates", ".gradle",
  ".pytest_cache", ".mypy_cache", "dist-newstyle",
  "Thumbs.db", "desktop.ini", ".DS_Store",
];

/** Electron/Chromium cache directories — present in almost every desktop app. */
const ELECTRON_CACHE = [
  "Cache", "Code Cache", "GPUCache", "DawnCache", "DawnGraphiteCache",
  "DawnWebGPUCache", "ShaderCache", "GrShaderCache", "component_crx_cache",
  "Crashpad", "logs", "CachedData", "Service Worker", "blob_storage",
  "WidevineCdm", "Dictionaries", "module_data",
];

/**
 * Build output and vendored sources. `.git` is deliberately NOT here: repos
 * without a remote exist only on this disk, so their history must be kept.
 */
const CODE_ARTEFACTS = [
  "dist", "build", "out", "obj", "target", "coverage",
  "deps", "third_party", "vendor", "Pods",
  ".angular", ".parcel-cache", ".cache", ".output", "bin/Debug", "bin/Release",
  // API response caches: marci_ai alone holds 1.3M cached Stratz match files.
  "cache", ".cache_ggr", "__cache__",
];

/** Compiled output, installers and packaged payloads — not sources. */
const BINARY_EXT = [
  ".exe", ".dll", ".pdb", ".ipch", ".lib", ".so", ".dylib", ".apk", ".dex",
  ".jar", ".aab", ".msi", ".zip", ".7z", ".rar", ".iso", ".ress", ".ttc",
  ".blend", ".blend1", ".unitypackage", ".pak", ".wad",
];

/** Photos, video, animation and layered design sources worth reviewing by hand. */
const MEDIA_EXT = [
  // photos and images
  ".jpg", ".jpeg", ".png", ".webp", ".heic", ".heif", ".avif", ".bmp", ".tif", ".tiff",
  // animation
  ".gif", ".apng", ".webm",
  // video
  ".mp4", ".mov", ".mkv", ".avi", ".m4v", ".mpg", ".mpeg", ".wmv",
  // layered / vector design sources — logos and avatars live here
  ".psd", ".psb", ".ai", ".eps", ".svg", ".xcf", ".fig", ".sketch",
  ".afphoto", ".afdesign", ".cdr", ".kra", ".clip",
  // camera raw
  ".cr2", ".cr3", ".nef", ".arw", ".dng", ".orf", ".rw2", ".raf",
];

/** Local database/state directories that a service recreates on first run. */
const LOCAL_DATA = [".local", "mysql-data", "pgdata", "postgres-data", "redis-data", "mongo-data"];

const HOME = process.env.USERPROFILE ?? "C:\\Users\\Default";
const LOCAL = process.env.LOCALAPPDATA ?? `${HOME}\\AppData\\Local`;
const ROAMING = process.env.APPDATA ?? `${HOME}\\AppData\\Roaming`;
const LOCALLOW = `${HOME}\\AppData\\LocalLow`;

export const PROFILES: Profile[] = [
  {
    name: "claude",
    description: "Claude Code: history, memory, rules, skills, agents, settings, MCP config",
    rules: [
      {
        path: `${HOME}\\.claude`,
        exclude: [
          "cache", "shell-snapshots", "paste-cache", "telemetry", "debug",
          "daemon", "session-env", "statsig", ".credentials.json",
          ".xai-credentials.json", "sh.exe.stackdump",
          // Rotated copies of .claude.json carrying the same live API keys.
          // Without this they would be collected here in plaintext, defeating
          // the encryption applied to the original below.
          "backups", "^.mcp.json",
        ],
        rewrite: "text-paths",
      },
      // Holds MCP server env blocks with live API keys, so it is encrypted as
      // well as path-rewritten. Order on restore is decrypt -> unzstd -> rewrite.
      { path: `${HOME}\\.claude.json`, rewrite: "json-paths", secret: true },
      { path: `${HOME}\\.claude\\.mcp.json`, rewrite: "json-paths", secret: true },
      { path: `${HOME}\\.claude\\backups`, rewrite: "json-paths", secret: true },
      { path: `${HOME}\\.serena`, exclude: ["cache", "logs"], rewrite: "text-paths" },
    ],
  },
  {
    name: "grok",
    description: "Grok CLI: chat history, memory, skills, config",
    rules: [
      {
        path: `${HOME}\\.grok`,
        // bin/downloads/bundled are the redistributable runtime (≈820 MB); the
        // value is in sessions/ (≈970 MB of chat history) and memory/.
        exclude: [
          "bin", "downloads", "bundled", "vendor", "marketplace-cache",
          "logs", "memtrace", "debug", "upload_queue", "auth.json", "auth2.json",
        ],
        rewrite: "text-paths",
      },
    ],
  },
  {
    name: "editors",
    description: "VS Code settings, keybindings and snippets",
    rules: [
      {
        path: `${ROAMING}\\Code\\User`,
        includeOnly: ["settings.json", "keybindings.json", "snippets", "profiles", "tasks.json", "globalStorage/storage.json"],
        rewrite: "json-paths",
      },
      // Claude Desktop, if installed alongside Claude Code.
      { path: `${ROAMING}\\Claude`, exclude: ELECTRON_CACHE, rewrite: "json-paths" },
      { path: `${HOME}\\.config\\fish` },
      { path: `${LOCAL}\\nvim` },
    ],
  },
  {
    name: "code",
    description: "Source code: CodeWorks + Desktop projects (no node_modules/build)",
    rules: [
      // Vendored dependency trees (boringssl et al.) and build artefacts are
      // restored by the build, not by us — they dominate the raw size otherwise.
      {
        path: "D:\\CodeWorks",
        exclude: [...CODE_ARTEFACTS, ...LOCAL_DATA],
        excludeExt: BINARY_EXT,
        maxFileSize: 25 * 1024 * 1024,
        rewrite: "none",
      },
      {
        path: `${HOME}\\Desktop`,
        exclude: [...CODE_ARTEFACTS, ...LOCAL_DATA],
        excludeExt: BINARY_EXT,
        maxFileSize: 25 * 1024 * 1024,
        rewrite: "none",
      },
      { path: `${HOME}\\Documents`, maxFileSize: 25 * 1024 * 1024, rewrite: "none" },
    ],
  },
  {
    name: "apps",
    description: "Desktop app settings: OBS, Obsidian, Steam, Postman, osu!, VRChat",
    rules: [
      // plugin_config carries plugin binaries; scenes/profiles are what matters.
      { path: `${ROAMING}\\obs-studio`, exclude: ["updates", "plugin_config/obs-browser", "crashes"] },
      { path: `${ROAMING}\\obsidian`, includeOnly: ["obsidian.json", "Preferences"], rewrite: "json-paths" },
      { path: "D:\\Steam\\userdata", exclude: ["shadercache", "httpcache"] },
      { path: `${ROAMING}\\Postman`, exclude: [...ELECTRON_CACHE, "logs"] },
      { path: `${ROAMING}\\osu`, includeOnly: ["Skins", "osu!.Jaros.cfg", "collection.db", "scores.db"] },
      { path: `${LOCALLOW}\\VRChat`, exclude: [...ELECTRON_CACHE, "VRChat/Cache-WindowsPlayer", "Unity"] },
      { path: `${ROAMING}\\Parsec`, exclude: ["log"] },
      { path: `${ROAMING}\\AnyDesk`, exclude: ["chat", "thumbnails"] },
      { path: `${ROAMING}\\Notion`, includeOnly: ["Preferences", "Local Storage", "notion.log"] },
      { path: `${ROAMING}\\REAPER`, exclude: ["Peaks", "MediaFiles", "ReaPlugs"] },
      { path: `${ROAMING}\\.minecraft\\saves` },
      { path: `${ROAMING}\\.minecraft\\options.txt` },
      { path: `${LOCAL}\\JetBrains`, includeOnly: ["IdeaIC*", "PyCharm*", "WebStorm*", "Rider*"], exclude: ["caches", "index", "log", "tmp"] },
      { path: `${HOME}\\.gitconfig`, rewrite: "text-paths" },
      { path: `${HOME}\\.wslconfig` },
    ],
  },
  {
    name: "comms",
    description: "Messenger sessions — encrypted: restoring these logs you straight back in",
    rules: [
      // tdata is the Telegram session; user_data/*cache* is just downloaded media.
      {
        path: "D:\\Telegram Desktop\\tdata",
        // Match by segment name: accounts live in user_data, user_data#2,
        // user_data#3 … and a path-prefix list silently missed the numbered ones.
        exclude: ["cache", "media_cache", "emoji", "dumps", "Code Cache", "GPUCache", "EBWebView"],
        secret: true,
      },
      {
        path: `${ROAMING}\\Telegram Desktop\\tdata`,
        exclude: ["cache", "media_cache", "emoji", "dumps", "Code Cache", "GPUCache", "EBWebView"],
        secret: true,
      },
      { path: `${ROAMING}\\discord`, includeOnly: ["settings.json", "Local Storage", "Local State"], secret: true },
      { path: `${ROAMING}\\Element`, includeOnly: ["IndexedDB", "Local Storage", "EventStore", "config.json"], secret: true },
      { path: `${LOCAL}\\element-desktop`, includeOnly: ["IndexedDB", "Local Storage", "EventStore"], secret: true },
    ],
  },
  {
    name: "vpn",
    description: "VPN clients: Happ subscriptions, nekoray profiles, tunnel configs",
    rules: [
      // subs.db is the whole subscription list — under a megabyte.
      { path: `${LOCAL}\\Happ`, includeOnly: ["subs.db", "settings", "config"], secret: true },
      { path: `${ROAMING}\\Happ`, exclude: ["update", "dumps"], secret: true },
      { path: `${HOME}\\Desktop\\nekoray`, includeOnly: ["config", "profiles", "groups"], secret: true },
      { path: `${ROAMING}\\hiddify`, exclude: ["logs"], secret: true },
      { path: `${ROAMING}\\v2rayN`, exclude: ["logs"], secret: true },
      { path: "C:\\Program Files\\WireGuard\\Data\\Configurations", secret: true },
      { path: `${HOME}\\OpenVPN\\config`, secret: true },
    ],
  },
  {
    name: "vault",
    description: "Obsidian vault + KeePassXC databases — small, irreplaceable, encrypted",
    rules: [
      // Notes are tiny; the vault also holds Пароли.kdbx, so the whole tree is encrypted.
      { path: "D:\\openclaw-obsidian", exclude: [".trash", ".stfolder", ".stfolder.removed*"], secret: true },
      { path: `${HOME}\\Downloads\\Telegram Desktop\\Пароли.kdbx`, secret: true },
      { path: `${ROAMING}\\Google\\AndroidStudio2025.3.2\\c.kdbx`, secret: true },
    ],
  },
  {
    name: "wallets",
    description: "Crypto app state — encrypted. Ledger/hardware keys live on the device, not here",
    rules: [
      { path: `${ROAMING}\\Ledger Live`, includeOnly: ["app.json", "user.json"], secret: true },
      { path: `${ROAMING}\\KeePassXC`, secret: true },
      { path: `${LOCAL}\\KeePassXC`, secret: true },
      { path: `${ROAMING}\\Bitwarden`, includeOnly: ["data.json"], secret: true },
      // Electrum wallet files are the funds themselves if not hardware-backed.
      { path: `${ROAMING}\\Electrum\\wallets`, secret: true },
      { path: `${ROAMING}\\Electrum\\config`, secret: true },
      { path: `${ROAMING}\\Tonkeeper`, exclude: [...ELECTRON_CACHE, "packages", "app-*"], secret: true },
      { path: `${LOCAL}\\Tonkeeper\\User Data`, exclude: ELECTRON_CACHE, secret: true },
    ],
  },
  {
    name: "browsers",
    description: "Browser profiles: bookmarks/history. NOTE: saved passwords are DPAPI-bound",
    rules: [
      {
        path: `${LOCAL}\\Google\\Chrome\\User Data\\Default`,
        // Chrome's Login Data is encrypted against the Windows account (DPAPI);
        // it will NOT decrypt under a new user. Bookmarks/history survive fine.
        includeOnly: ["Bookmarks", "History", "Preferences", "Web Data", "Login Data", "Cookies", "Favicons", "Extensions"],
        exclude: ELECTRON_CACHE,
        secret: true,
      },
      { path: `${LOCAL}\\Google\\Chrome\\User Data\\Local State`, secret: true },
      { path: `${ROAMING}\\Mozilla\\Firefox\\Profiles`, exclude: [...ELECTRON_CACHE, "storage/default", "minidumps"], secret: true },
      { path: `${ROAMING}\\dolphin_anty`, exclude: [...ELECTRON_CACHE], secret: true },
    ],
  },
  {
    name: "personal-media",
    description: "Фото/видео/GIF/PSD из Загрузок и с Рабочего стола → одна папка для ручного разбора",
    rules: [
      {
        path: `${HOME}\\Downloads`,
        includeExt: MEDIA_EXT,
        // Below this it is favicons, sprites and emoji, not photos or logos.
        minFileSize: 10 * 1024,
        // Telegram chat exports are 31k files of conversation attachments —
        // a separate archive, not the personal photos this profile is for.
        exclude: ["DataExport_*", "ChatExport_*"],
        store: true,
        relocateTo: "{{VOL:DISK_D}}\\Media-Inbox\\Downloads",
      },
      {
        path: `${HOME}\\Desktop`,
        includeExt: MEDIA_EXT,
        minFileSize: 10 * 1024,
        // Project asset folders would drown the real photos in sprites and icons.
        exclude: [...CODE_ARTEFACTS, "node_modules", "assets", "public", "static",
                  "img", "images", "icons", "textures", "sprites", "materials",
                  // Editing scratch: proxies, renders and cache, not source photos.
                  "davinci resolve", "DataExport_*", "ChatExport_*"],
        store: true,
        relocateTo: "{{VOL:DISK_D}}\\Media-Inbox\\Desktop",
      },
    ],
  },
  {
    name: "media",
    description: "Irreplaceable media: phone photos, own LoRA training, generated outputs",
    rules: [
      { path: "D:\\Mi 11\\DCIM", store: true },
      { path: "D:\\!Stable_Diffusion\\webui\\models\\Lora", store: true },
      { path: "D:\\!Stable_Diffusion\\outputs", store: true },
      { path: "D:\\!Stable_Diffusion\\webui\\outputs", store: true },
      { path: "D:\\comfy_ui\\models\\loras", store: true },
      { path: "D:\\comfy_ui\\user", rewrite: "none" },
      { path: "D:\\Videos", store: true },
    ],
  },
  {
    name: "secrets",
    description: "Credentials and keys — always encrypted with the backup passphrase",
    rules: [
      { path: `${HOME}\\.ssh`, secret: true },
      // Saved SSH server profiles for the ssh-tool MCP, including credentials.
      { path: `${HOME}\\.config\\mcp-sshpilot`, secret: true },
      // Termius keeps hosts and credentials in its Electron databases.
      { path: `${ROAMING}\\Termius`, includeOnly: ["databases", "IndexedDB", "Local Storage"], secret: true },
      { path: `${ROAMING}\\OpenVPN Connect\\profiles`, secret: true },
      { path: `${HOME}\\.mcp-auth`, secret: true },
      { path: `${HOME}\\.claude\\.credentials.json`, secret: true },
      { path: `${HOME}\\.claude\\.xai-credentials.json`, secret: true },
      { path: `${HOME}\\.grok\\auth.json`, secret: true },
      { path: `${HOME}\\.aws`, secret: true },
      { path: `${HOME}\\.config\\gh`, secret: true },
      { path: `${HOME}\\.config\\shodan`, secret: true },
      { path: `${HOME}\\.docker\\config.json`, secret: true },
      { path: `${HOME}\\.npmrc`, secret: true },
      { path: `${HOME}\\.git-credentials`, secret: true },
      { path: `${HOME}\\.cargo\\credentials.toml`, secret: true },
      { path: `${HOME}\\.pypirc`, secret: true },
      { path: "D:\\CodeWorks\\haulier\\secrets", secret: true },
    ],
  },
];

export function profileByName(name: string): Profile | undefined {
  return PROFILES.find((p) => p.name === name);
}

export function allProfileNames(): string[] {
  return PROFILES.map((p) => p.name);
}
