# winmigrate — руководство по использованию

Перенос рабочего окружения Windows между установками: конфиги, история AI-инструментов,
код, сессии приложений, секреты. Переживает **смену имени пользователя** и **смену букв дисков**.

Стек: Bun + TypeScript. Внешних зависимостей нет — SQLite, zstd и S3-клиент встроены в Bun.

---

## Быстрый старт

```powershell
cd D:\CodeWorks\winmigrate
bun install
bun run src/cli.ts        # без аргументов открывается интерактивное меню
```

Меню: Обзор → Создать бэкап → Залить в R2 → Скачать из R2 → Восстановить → Проверить →
Код в GitHub → Настройка R2.

---

## Сценарий полной миграции

### На старой машине

1. **Код в GitHub** — меню «Код в GitHub».
   Проекты без remote и без git заливаются в приватные репозитории.
   Проект, где в коммит попал бы секрет, **блокируется** — это ожидаемо, не баг.
2. **Бэкап** — меню «Создать бэкап». Выбрать профили, задать пароль.
   Пароль защищает профили с 🔒. **Забыл пароль — данные потеряны**, восстановления нет.
3. **Проверить бэкап** — сверяет манифест с хранилищем.
4. **Залить в R2**.

### На новой машине

1. Поставить Bun: `powershell -c "irm bun.sh/install.ps1 | iex"`
2. `git clone <репозиторий winmigrate>` и `bun install`
3. `bun run src/cli.ts` → «Настройка R2» → «Скачать из R2»
4. «Восстановить»: выбрать профили, ответить на вопросы про диски и про перенос проектов,
   посмотреть **предпросмотр**, затем подтвердить запись.

---

## Команды CLI

Всё, что делает меню, доступно и без него.

```powershell
bun run src/cli.ts plan                       # что соберётся, без записи
bun run src/cli.ts backup -p 'claude,code' -o D:\wm-backup --pass <пароль>
bun run src/cli.ts verify -o D:\wm-backup
bun run src/cli.ts list -o D:\wm-backup       # содержимое + сколько зашифровано
bun run src/cli.ts r2-upload -o D:\wm-backup
bun run src/cli.ts r2-download -o D:\wm-backup
bun run src/cli.ts restore --from D:\wm-backup -n
bun run src/cli.ts gitsave                    # план; --apply чтобы выполнить
```

### Опции

| Опция | Значение |
|---|---|
| `-p, --profiles a,b` | Профили (по умолчанию все) |
| `-o, --out DIR` | Каталог бэкапа (для restore — `--from`) |
| `--map ROLE=E:` | Привязать том к букве на этой машине |
| `--relocate A=B` | Перенести поддерево (повторяемая) |
| `--pass STR` | Пароль для профилей с секретами |
| `-j, --jobs N` | Параллельных воркеров |
| `-n, --dry-run` | Только план, без записи |
| `--overwrite` | Перезаписывать существующие файлы |
| `--apply` | Для `gitsave`: реально пушить |

**PowerShell**: `-p a,b` превращается в массив — пиши `-p 'claude,code'` в кавычках.

---

## Профили

| Профиль | Что | 🔒 |
|---|---|---|
| `claude` | `~/.claude` целиком: история, **skills**, agents, commands, hooks, rules, plugins, memory; `.claude.json`; `.serena` | частично |
| `grok` | `.grok`: sessions, memory, skills, config (без рантайма ~820 МБ) | |
| `editors` | VS Code (settings/keybindings/snippets), Claude Desktop, fish, nvim | |
| `code` | `D:\CodeWorks`, Desktop, Documents | |
| `apps` | OBS, Steam userdata, Postman, osu!, VRChat, REAPER, JetBrains, Minecraft saves | |
| `comms` | Telegram tdata, Discord, Element — **сессии** | 🔒 |
| `vpn` | Happ `subs.db`, nekoray, WireGuard, OpenVPN | 🔒 |
| `vault` | Obsidian vault + базы KeePassXC | 🔒 |
| `wallets` | Electrum, Tonkeeper, Ledger Live, Bitwarden | 🔒 |
| `browsers` | Chrome/Firefox: закладки, история (см. ограничение ниже) | 🔒 |
| `media` | DCIM, LoRA, outputs, Videos — **самый тяжёлый** | |
| `secrets` | SSH, `mcp-sshpilot/servers.json`, Termius, токены | 🔒 |

Правки — в `src/profiles.ts`. Поля `Rule`: `path`, `exclude`, `includeOnly`,
`excludeExt`, `maxFileSize`, `rewrite`, `secret`, `store`.

---

## Перенос путей — как это работает

Пути хранятся плейсхолдерами: `{{HOME}}`, `{{LOCALAPPDATA}}`, `{{VOL:РОЛЬ}}`.
Тома опознаются по GUID/метке, а не по букве.

**Claude Code кодирует абсолютный путь проекта в имя папки истории:**
`D:\CodeWorks` → `D--CodeWorks` (любой не-буквенно-цифровой символ → `-`).
Поэтому при смене диска или имени пользователя папки переименовываются, иначе
история молча отвязывается от проекта. Соответствие «папка → реальный путь»
берётся из секции `projects` в `.claude.json` на момент бэкапа — обратно имя
раскодировать нельзя, кодировка теряет информацию.

### Перенос проектов с рабочего стола

```powershell
bun run src/cli.ts restore -p code,claude --from D:\wm-backup `
  --relocate "{{HOME}}\Desktop={{VOL:DISK_D}}\Projects"
```

Правило применяется в трёх местах сразу: имя файла, папка истории Claude,
пути внутри конфигов. В меню это отдельный вопрос при восстановлении.

---

## Cloudflare R2

Ключи: R2 → Manage API Tokens → **Create Account API token** → Object Read & Write.
Нужны Account ID, Access Key ID, Secret Access Key, имя бакета.

Хранятся в `~/.winmigrate/r2.json`; переменные окружения имеют приоритет:
`R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`, `R2_PREFIX`.

**Заливка инкрементальная**: блобы адресуются по SHA-256 и неизменяемы, поэтому
существующие в облаке не отправляются повторно. Скачивание умеет продолжаться —
файл нужного размера не качается заново.

⚠️ `r2.json` содержит рабочие ключи. Он лежит вне репозитория; в коммит не добавлять.

---

## Что НЕ переносится

- **Пароли и куки Chrome.** Chrome 127+ использует App-Bound Encryption
  (`app_bound_encrypted_key` в `Local State`), ключ привязан к машине и приложению;
  DPAPI-ключ привязан к SID пользователя Windows. После переустановки SID другой —
  расшифровать нельзя. Закладки и история переносятся. Пароли — через синхронизацию
  Google или экспорт в KeePassXC **до** переустановки.
- **Расширения VS Code** — ставятся через Settings Sync (вход по GitHub), это надёжнее
  копирования папки `extensions`.
- **Глобальные npm-пакеты**, от которых зависят MCP-серверы. Пути в конфиге чинятся,
  но сами пакеты надо доставить: `npm i -g <pkg>`.
- **Модели LM Studio / Stable Diffusion** — качаются заново, в бэкап не кладутся.

---

## Диагностика

```powershell
bun run tools/top.ts code 2      # где именно вес профиля: по подпапкам и расширениям
bun test                         # 25 тестов на перенос путей и шифрование
bunx tsc --noEmit                # типы
powershell -File tools\Scan-Apps.ps1   # инвентаризация приложений на машине
```

**Бэкап получился огромный** — почти всегда кэш. Запусти `tools/top.ts` и добавь
исключение в `src/profiles.ts`. Уже отсечены: кэш Stratz API (1,3 млн файлов),
вендоренные зависимости, локальные БД, скомпилированные бинарники.

**«Cannot resolve volume role X»** — том не опознан: `--map X=E:` или ответь на вопрос в меню.

**«Decryption failed»** — неверный пароль либо повреждённый блоб; проверь `verify`.

---

## Правила для агентов

- `restore` и `gitsave` по умолчанию **ничего не пишут**. Не убирай это.
- Не логируй значения секретов. Инструменты печатают пути и признак «зашифровано», не содержимое.
- `.claude.json` — секрет: в блоках `env` MCP-серверов лежат живые API-ключи.
- Не добавляй `.git` в исключения `code`, пока проекты не залиты в GitHub: для
  репозиториев без remote это единственная копия истории.
- Перед «готово»: `bunx tsc --noEmit` и `bun test`.
