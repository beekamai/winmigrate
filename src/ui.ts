/*
  Minimal terminal UI primitives: menus, multi-select, prompts, progress bars.
  No dependencies — raw stdin plus ANSI escapes.
*/

const ESC = "\x1b[";

export const c = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  red: "\x1b[38;5;203m",
  green: "\x1b[38;5;114m",
  yellow: "\x1b[38;5;179m",
  blue: "\x1b[38;5;110m",
  magenta: "\x1b[38;5;176m",
  cyan: "\x1b[38;5;115m",
  grey: "\x1b[38;5;245m",
  accent: "\x1b[38;5;209m",
  inverse: "\x1b[7m",
};

export const hideCursor = () => process.stdout.write(`${ESC}?25l`);
export const showCursor = () => process.stdout.write(`${ESC}?25h`);
export const clear = () => process.stdout.write(`${ESC}2J${ESC}H`);
export const write = (s: string) => process.stdout.write(s);
export const line = (s = "") => process.stdout.write(s + "\n");

export function width(): number {
  return Math.max(60, Math.min(process.stdout.columns ?? 100, 120));
}

export function rule(char = "─"): string {
  return c.grey + char.repeat(width() - 2) + c.reset;
}

export function title(text: string, subtitle?: string): void {
  clear();
  line();
  line(`  ${c.accent}${c.bold}${text}${c.reset}`);
  if (subtitle) line(`  ${c.grey}${subtitle}${c.reset}`);
  line();
}

export function humanBytes(n: number): string {
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0, v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${u[i]}`;
}

export type Key = { name: string; ctrl: boolean; text?: string };

/** Strips bracketed-paste markers and control characters from pasted text. */
export function sanitizePaste(s: string): string {
  return s
    .replace(/\x1b\[20[01]~/g, "")
    // A multi-line paste into a single-line prompt takes the first line.
    .split(/\r?\n/)[0]!
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
}

export function decode(buf: string): Key {
  // Bracketed paste must be checked first: it starts with an escape sequence,
  // so the arrow-key branch below would otherwise swallow it.
  if (buf.includes("\x1b[200~")) {
    const text = sanitizePaste(buf);
    return text ? { name: "paste", ctrl: false, text } : { name: "noop", ctrl: false };
  }
  if (buf === "\x1b[201~") return { name: "noop", ctrl: false };

  if (buf === "\x03") return { name: "ctrl-c", ctrl: true };
  if (buf === "\r" || buf === "\n") return { name: "enter", ctrl: false };
  if (buf === " ") return { name: "space", ctrl: false };
  if (buf === "\x1b") return { name: "escape", ctrl: false };
  if (buf === "\x7f" || buf === "\b") return { name: "backspace", ctrl: false };
  if (buf === "\x16") return { name: "ctrl-v", ctrl: true };
  if (buf === "\x1b[A") return { name: "up", ctrl: false };
  if (buf === "\x1b[B") return { name: "down", ctrl: false };
  if (buf === "\x1b[C") return { name: "right", ctrl: false };
  if (buf === "\x1b[D") return { name: "left", ctrl: false };

  // Anything longer than one character that is not a known escape sequence is a
  // paste: right-click and Ctrl+V both arrive as a single bulk chunk.
  if (buf.length > 1 && !buf.startsWith("\x1b[")) {
    const text = sanitizePaste(buf);
    if (text) return { name: "paste", ctrl: false, text };
  }
  return { name: buf, ctrl: false };
}

/** Fallback for terminals that send ^V instead of the clipboard contents. */
async function readClipboard(): Promise<string> {
  try {
    const out = await Bun.$`powershell -NoProfile -NonInteractive -Command Get-Clipboard -Raw`
      .quiet()
      .text();
    return sanitizePaste(out);
  } catch {
    return "";
  }
}

async function readKey(): Promise<Key> {
  const stdin = process.stdin;
  if (stdin.isTTY) stdin.setRawMode(true);
  stdin.resume();
  return new Promise((resolve) => {
    const onData = (d: Buffer) => {
      stdin.off("data", onData);
      stdin.pause();
      resolve(decode(d.toString("utf8")));
    };
    stdin.on("data", onData);
  });
}

export interface MenuItem {
  label: string;
  hint?: string;
  value: string;
  disabled?: boolean;
}

export async function menu(items: MenuItem[], heading: string, sub?: string): Promise<string | null> {
  let idx = items.findIndex((i) => !i.disabled);
  if (idx < 0) idx = 0;
  hideCursor();
  try {
    for (;;) {
      title(heading, sub);
      for (let i = 0; i < items.length; i++) {
        const it = items[i]!;
        const sel = i === idx;
        const bullet = sel ? `${c.accent}❯${c.reset}` : " ";
        const label = it.disabled
          ? `${c.grey}${it.label}${c.reset}`
          : sel ? `${c.bold}${it.label}${c.reset}` : it.label;
        const hint = it.hint ? `  ${c.grey}${it.hint}${c.reset}` : "";
        line(`  ${bullet} ${label}${hint}`);
      }
      line();
      line(`  ${c.grey}↑↓ выбор · Enter подтвердить · Esc выход${c.reset}`);

      const k = await readKey();
      if (k.name === "ctrl-c" || k.name === "escape") return null;
      if (k.name === "up") {
        do { idx = (idx - 1 + items.length) % items.length; } while (items[idx]!.disabled);
      } else if (k.name === "down") {
        do { idx = (idx + 1) % items.length; } while (items[idx]!.disabled);
      } else if (k.name === "enter" && !items[idx]!.disabled) {
        return items[idx]!.value;
      }
    }
  } finally {
    showCursor();
  }
}

export interface CheckItem {
  label: string;
  hint?: string;
  value: string;
  checked: boolean;
}

export async function multiSelect(items: CheckItem[], heading: string, sub?: string): Promise<string[] | null> {
  let idx = 0;
  const state = items.map((i) => ({ ...i }));
  hideCursor();
  try {
    for (;;) {
      title(heading, sub);
      for (let i = 0; i < state.length; i++) {
        const it = state[i]!;
        const sel = i === idx;
        const box = it.checked ? `${c.green}◉${c.reset}` : `${c.grey}○${c.reset}`;
        const bullet = sel ? `${c.accent}❯${c.reset}` : " ";
        const label = sel ? `${c.bold}${it.label}${c.reset}` : it.label;
        const hint = it.hint ? `  ${c.grey}${it.hint}${c.reset}` : "";
        line(`  ${bullet} ${box} ${label}${hint}`);
      }
      line();
      line(`  ${c.grey}↑↓ навигация · Space отметить · A все · N ничего · Enter далее · Esc назад${c.reset}`);

      const k = await readKey();
      if (k.name === "ctrl-c" || k.name === "escape") return null;
      if (k.name === "up") idx = (idx - 1 + state.length) % state.length;
      else if (k.name === "down") idx = (idx + 1) % state.length;
      else if (k.name === "space") state[idx]!.checked = !state[idx]!.checked;
      else if (k.name.toLowerCase() === "a") state.forEach((s) => (s.checked = true));
      else if (k.name.toLowerCase() === "n") state.forEach((s) => (s.checked = false));
      else if (k.name === "enter") return state.filter((s) => s.checked).map((s) => s.value);
    }
  } finally {
    showCursor();
  }
}

export async function prompt(question: string, opts: { mask?: boolean; def?: string } = {}): Promise<string | null> {
  let value = "";
  showCursor();
  // Ask the terminal to wrap pastes in markers so they arrive as one chunk.
  write(`${ESC}?2004h`);
  try {
    for (;;) {
      const shown = opts.mask ? "•".repeat(value.length) : value;
      const def = opts.def && !value ? `${c.grey}(${opts.def})${c.reset} ` : "";
      const hint = value ? "" : `  ${c.grey}(вставка: ПКМ или Ctrl+V)${c.reset}`;
      write(`\r${ESC}2K  ${c.cyan}?${c.reset} ${question} ${def}${shown}${hint}`);
      const k = await readKey();
      if (k.name === "ctrl-c" || k.name === "escape") { line(); return null; }
      if (k.name === "enter") { line(); return value || opts.def || ""; }
      if (k.name === "backspace") { value = value.slice(0, -1); continue; }
      if (k.name === "paste" && k.text) { value += k.text; continue; }
      if (k.name === "ctrl-v") { value += await readClipboard(); continue; }
      // Printable single character.
      if (k.name.length === 1 && k.name >= " ") value += k.name;
    }
  } finally {
    write(`${ESC}?2004l`);
  }
}

export async function confirm(question: string, def = false): Promise<boolean> {
  const answer = await menu(
    [
      { label: def ? "Да" : "Нет", value: def ? "y" : "n" },
      { label: def ? "Нет" : "Да", value: def ? "n" : "y" },
    ],
    question,
  );
  return answer === "y";
}

export async function pause(msg = "Enter — продолжить"): Promise<void> {
  line();
  line(`  ${c.grey}${msg}${c.reset}`);
  for (;;) {
    const k = await readKey();
    if (k.name === "enter" || k.name === "escape" || k.name === "ctrl-c") return;
  }
}

/**
 * Runs a long operation while Esc / Ctrl+C can abort it. The operation must
 * honour the AbortSignal — a synchronous loop that never yields cannot be
 * interrupted no matter what is listening.
 */
export async function cancellable<T>(
  fn: (signal: AbortSignal) => Promise<T>,
): Promise<{ value?: T; cancelled: boolean }> {
  const ctrl = new AbortController();
  const stdin = process.stdin;
  const onData = (d: Buffer) => {
    const s = d.toString("utf8");
    if (s === "\x03" || s === "\x1b") ctrl.abort();
  };

  const wasRaw = stdin.isTTY ? stdin.isRaw : false;
  if (stdin.isTTY) stdin.setRawMode(true);
  stdin.on("data", onData);
  stdin.resume();

  try {
    const value = await fn(ctrl.signal);
    return { value, cancelled: false };
  } catch (e) {
    if ((e as Error).name === "AbortError") return { cancelled: true };
    throw e;
  } finally {
    stdin.off("data", onData);
    stdin.pause();
    if (stdin.isTTY) stdin.setRawMode(wasRaw);
  }
}

/** Single-line spinner for work with no measurable total. */
export class Spinner {
  private frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  private i = 0;
  private last = 0;

  constructor(private label: string) {}

  tick(detail = ""): void {
    const now = Date.now();
    if (now - this.last < 80) return;
    this.last = now;
    const f = this.frames[this.i++ % this.frames.length]!;
    const max = width() - this.label.length - 12;
    const shown = detail.length > max ? "…" + detail.slice(-max) : detail;
    write(`\r${ESC}2K  ${c.accent}${f}${c.reset} ${this.label}  ${c.grey}${shown}${c.reset}`);
  }

  clear(): void {
    write(`\r${ESC}2K`);
  }
}

/** Redrawing progress bar. Call render() as often as you like; it is cheap. */
export class Progress {
  private last = 0;
  private started = Date.now();
  private lines = 0;

  constructor(private label: string) {}

  render(done: number, total: number, bytes: number, current = ""): void {
    const now = Date.now();
    if (now - this.last < 60 && done < total) return;
    this.last = now;

    const w = width() - 24;
    const pct = total ? done / total : 0;
    const filled = Math.round(pct * w);
    const elapsed = (now - this.started) / 1000;
    const rate = elapsed > 0 ? bytes / elapsed : 0;

    const bar = `${c.accent}${"█".repeat(filled)}${c.grey}${"░".repeat(Math.max(0, w - filled))}${c.reset}`;
    const stat = `${(pct * 100).toFixed(1).padStart(5)}%  ${humanBytes(rate)}/s`;
    const detail = current
      ? `  ${c.grey}${current.length > width() - 6 ? "…" + current.slice(-(width() - 8)) : current}${c.reset}`
      : "";

    if (this.lines) write(`${ESC}${this.lines}A`);
    line(`  ${this.label}`);
    line(`  ${bar} ${stat}`);
    line(`  ${c.grey}${done}/${total} файлов · ${humanBytes(bytes)}${c.reset}${detail}`);
    this.lines = 3;
  }

  done(summary: string): void {
    line();
    line(`  ${c.green}✓${c.reset} ${summary}`);
  }

  fail(summary: string): void {
    line();
    line(`  ${c.red}✗${c.reset} ${summary}`);
  }
}
