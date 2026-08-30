<#
  Inventories application state worth backing up: configs, sessions, vaults.
  Reports paths and sizes only — never file contents.
#>
$opt = [IO.EnumerationOptions]@{
  RecurseSubdirectories = $true
  IgnoreInaccessible    = $true
  AttributesToSkip      = [IO.FileAttributes]::ReparsePoint
}
function Size([string]$p) {
  if (-not (Test-Path $p)) { return -1 }
  try {
    if (-not (Get-Item $p -Force).PSIsContainer) { return (Get-Item $p -Force).Length }
  } catch { return -1 }
  $s = 0L
  try { foreach ($f in [IO.Directory]::EnumerateFiles($p, '*', $opt)) { try { $s += [IO.FileInfo]::new($f).Length } catch {} } } catch {}
  $s
}
# Return a number, not a formatted string: the ru-RU thousands separator breaks [double] casts.
function MB([long]$b) { if ($b -lt 0) { -1 } else { [math]::Round($b / 1MB, 1) } }

$H = $env:USERPROFILE
$R = $env:APPDATA
$L = $env:LOCALAPPDATA

# name, path, why it matters
$apps = @(
  @('Grok CLI',           "$H\.grok",                            'chat history + config'),
  @('Codex CLI',          "$H\.codex",                           'history + config'),
  @('Gemini CLI',         "$H\.gemini",                          'history + config'),
  @('Antigravity',        "$H\.antigravity",                     'config'),
  @('Codeium',            "$H\.codeium",                         'config'),
  @('LM Studio',          "$H\.lmstudio",                        'models + config'),
  @('Cursor',             "$R\Cursor\User",                      'editor settings'),
  @('Windsurf',           "$R\Windsurf\User",                    'editor settings'),
  @('VS Code User',       "$R\Code\User",                        'settings/keybindings/snippets'),
  @('Obsidian appdata',   "$R\obsidian",                         'vault list + plugins config'),
  @('KeePassXC',          "$R\KeePassXC",                        'app config (NOT the database)'),
  @('KeePassXC local',    "$L\KeePassXC",                        'app config'),
  @('OBS Studio',         "$R\obs-studio",                       'scenes, profiles, hotkeys'),
  @('Telegram tdata',     "$R\Telegram Desktop\tdata",           'SESSION - login without re-auth'),
  @('Telegram (D:)',      'D:\Telegram Desktop\tdata',           'SESSION if portable install'),
  @('Discord',            "$R\discord",                          'settings; token in Local Storage'),
  @('Discord LocalStore', "$R\discord\Local Storage",            'SESSION token'),
  @('Ledger Live',        "$R\Ledger Live",                      'accounts (NOT keys - those are on device)'),
  @('Element/Matrix',     "$R\Element",                          'session + encryption keys'),
  @('Element desktop',    "$L\element-desktop",                  'session store'),
  @('Happ',               "$R\Happ",                             'VPN subscriptions/configs'),
  @('Happ local',         "$L\Happ",                             'VPN subscriptions/configs'),
  @('nekoray',            "$H\Desktop\nekoray",                  'VPN profiles'),
  @('Hiddify',            "$R\hiddify",                          'VPN subscriptions'),
  @('v2rayN',             "$R\v2rayN",                           'VPN profiles'),
  @('WireGuard',          'C:\Program Files\WireGuard\Data',     'tunnel configs'),
  @('OpenVPN cfg',        "$H\OpenVPN\config",                   'tunnel configs'),
  @('rclone',             "$R\rclone",                           'remotes incl. R2 creds'),
  @('rclone home',        "$H\.config\rclone",                   'remotes incl. R2 creds'),
  @('gh CLI',             "$H\.config\gh",                       'GitHub token'),
  @('git config',         "$H\.gitconfig",                       'identity + aliases'),
  @('git credentials',    "$H\.git-credentials",                 'STORED TOKENS'),
  @('SSH',                "$H\.ssh",                             'private keys + known_hosts'),
  @('AWS',                "$H\.aws",                             'credentials'),
  @('Docker',             "$H\.docker",                          'registry auth'),
  @('npm',                "$H\.npmrc",                           'registry tokens'),
  @('bun',                "$H\.bunfig.toml",                     'registry tokens'),
  @('Cargo',              "$H\.cargo\credentials.toml",          'crates.io token'),
  @('PyPI',               "$H\.pypirc",                          'PyPI token'),
  @('Notion',             "$R\Notion",                           'session'),
  @('Obsidian local',     "$L\obsidian",                         'cache'),
  @('Steam userdata',     'D:\Steam\userdata',                   'game configs incl. Dota 2'),
  @('osu!',               "$R\osu",                              'skins/settings'),
  @('DBeaver',            "$R\DBeaverData",                      'DB connections + saved creds'),
  @('Postman',            "$R\Postman",                          'collections'),
  @('Insomnia',           "$R\Insomnia",                         'collections'),
  @('dolphin_anty',       "$R\dolphin_anty",                     'browser profiles'),
  @('Warudo',             "$R\Warudo",                           'avatar setup'),
  @('VRChat',             "$L\..\LocalLow\VRChat",               'settings'),
  @('Thunderbird',        "$R\Thunderbird",                      'mail profiles'),
  @('KeePass (classic)',  "$R\KeePass",                          'app config'),
  @('Bitwarden',          "$R\Bitwarden",                        'vault cache'),
  @('Chrome Default',     "$L\Google\Chrome\User Data\Default",  'profile: bookmarks/passwords/cookies'),
  @('Firefox profiles',   "$R\Mozilla\Firefox\Profiles",         'profile: bookmarks/passwords'),
  @('Vivaldi',            "$L\Vivaldi\User Data\Default",        'profile'),
  @('Brave',              "$L\BraveSoftware\Brave-Browser\User Data\Default", 'profile'),
  @('MCP ssh-pilot',      "$H\.config\mcp-sshpilot",             'SAVED SSH SERVER PROFILES + creds'),
  @('Telegram tdata (D:)','D:\Telegram Desktop\tdata',           'SESSION - login without re-auth'),
  @('Serena MCP memory',  "$H\.serena",                          'per-project MCP memories'),
  @('MCP OAuth',          "$H\.mcp-auth",                        'MCP OAuth tokens'),
  @('Kimi CLI',           "$H\.kimi",                            'history + config'),
  @('Trae',               "$H\.trae",                            'editor state'),
  @('OpenClaude',         "$H\.openclaude",                      'config + history'),
  @('fish shell',         "$H\.config\fish",                     'shell functions/aliases'),
  @('scoop cfg',          "$H\.config\scoop",                    'package manager config'),
  @('shodan',             "$H\.config\shodan",                   'API key'),
  @('Claude Desktop',     "$R\Claude",                           'desktop app config'),
  @('AnyDesk',            "$R\AnyDesk",                          'remote access config'),
  @('Parsec',             "$R\Parsec",                           'streaming config'),
  @('Everything',         "$R\Everything",                       'search config')
)

Write-Host "`n=== APPLICATION STATE (found only) ===" -ForegroundColor Cyan
$rows = foreach ($a in $apps) {
  $sz = Size $a[1]
  if ($sz -ge 0) { [pscustomobject]@{ App = $a[0]; MB = (MB $sz); Why = $a[2]; Path = $a[1] } }
}
$rows | Sort-Object MB -Descending | Format-Table -AutoSize -Wrap

Write-Host "`n=== NOT FOUND (skip these) ===" -ForegroundColor DarkGray
($apps | Where-Object { (Size $_[1]) -lt 0 } | ForEach-Object { $_[0] }) -join ', '

Write-Host "`n=== PASSWORD DATABASES / KEY FILES ON DISK ===" -ForegroundColor Yellow
$pw = @()
foreach ($root in 'C:\Users\Jaros', 'D:\') {
  try {
    foreach ($f in [IO.Directory]::EnumerateFiles($root, '*', $opt)) {
      if ($f -match '[\\/](node_modules|\.venv|site-packages|\.git)[\\/]') { continue }
      if ($f -match '\.(kdbx|kdb|psafe3|opvpn|ovpn)$' -or $f -match '[\\/]wg\d*\.conf$') {
        $pw += [pscustomobject]@{ KB = [math]::Round([IO.FileInfo]::new($f).Length / 1KB, 1); Path = $f }
      }
    }
  } catch {}
}
if ($pw) { $pw | Sort-Object Path | Format-Table -AutoSize } else { 'none found' }

Write-Host "`n=== OBSIDIAN VAULTS ===" -ForegroundColor Cyan
$vaults = @()
foreach ($root in 'C:\Users\Jaros', 'D:\') {
  try {
    foreach ($d in [IO.Directory]::EnumerateDirectories($root, '.obsidian', [IO.SearchOption]::AllDirectories)) {
      $vaults += [pscustomobject]@{ Vault = (Split-Path $d -Parent); MB = (MB (Size (Split-Path $d -Parent))) }
    }
  } catch {}
}
if ($vaults) { $vaults | Format-Table -AutoSize } else { 'none found' }

Write-Host "`n=== UNREVIEWED AppData folders > 30 MB ===" -ForegroundColor Cyan
$known = $apps | ForEach-Object { $_[1].ToLower() }
foreach ($base in $R, $L) {
  [IO.Directory]::EnumerateDirectories($base) | ForEach-Object {
    if ($known -contains $_.ToLower()) { return }
    $s = Size $_
    if ($s -gt 30MB) { [pscustomobject]@{ Folder = $_.Replace($H, '~'); MB = (MB $s) } }
  } | Sort-Object MB -Descending | Select-Object -First 25 | Format-Table -AutoSize
}
