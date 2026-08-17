/**
 * Mini editor: buffer + ratón SGR + undo/redo.
 * ponytail: tabs → 2 espacios al cargar; techo 256KB; historial 80 snapshots.
 */
import { spawn } from "node:child_process";
export const MAX_EDIT_BYTES = 256_000;
const MAX_HIST = 80;

type Snap = {
  lines: string[];
  row: number;
  col: number;
  tick: number;
};

export type Doc = {
  lines: string[];
  row: number;
  col: number;
  dirty: boolean;
  tick: number;
  savedTick: number;
  past: Snap[];
  future: Snap[];
};

export function loadDoc(text: string): Doc {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\t/g, "  ");
  const lines = normalized.split("\n");
  return {
    lines: lines.length ? lines : [""],
    row: 0,
    col: 0,
    dirty: false,
    tick: 0,
    savedTick: 0,
    past: [],
    future: [],
  };
}

function snap(doc: Doc): Snap {
  return { lines: doc.lines, row: doc.row, col: doc.col, tick: doc.tick };
}

function commit(before: Doc, lines: string[], row: number, col: number): Doc {
  if (before.row === row && before.col === col && before.lines === lines) return before;
  if (before.row === row && before.col === col && serialize(before) === lines.join("\n")) return before;
  const tick = before.tick + 1;
  return {
    lines,
    row,
    col,
    tick,
    savedTick: before.savedTick,
    dirty: tick !== before.savedTick,
    past: [...before.past.slice(-(MAX_HIST - 1)), snap(before)],
    future: [],
  };
}

export function markSaved(doc: Doc): Doc {
  return { ...doc, savedTick: doc.tick, dirty: false };
}

export function undo(doc: Doc): Doc {
  const prev = doc.past.at(-1);
  if (!prev) return doc;
  return {
    lines: prev.lines,
    row: prev.row,
    col: prev.col,
    tick: prev.tick,
    savedTick: doc.savedTick,
    dirty: prev.tick !== doc.savedTick,
    past: doc.past.slice(0, -1),
    future: [...doc.future, snap(doc)],
  };
}

export function redo(doc: Doc): Doc {
  const next = doc.future.at(-1);
  if (!next) return doc;
  return {
    lines: next.lines,
    row: next.row,
    col: next.col,
    tick: next.tick,
    savedTick: doc.savedTick,
    dirty: next.tick !== doc.savedTick,
    past: [...doc.past, snap(doc)],
    future: doc.future.slice(0, -1),
  };
}

export function serialize(doc: Doc): string {
  return doc.lines.join("\n");
}

function clampCol(doc: Doc, row: number, col: number): number {
  const line = doc.lines[row] ?? "";
  return Math.max(0, Math.min(col, line.length));
}

export function clickAt(doc: Doc, row: number, col: number): Doc {
  const r = Math.max(0, Math.min(row, doc.lines.length - 1));
  return { ...doc, row: r, col: clampCol(doc, r, Math.max(0, col)) };
}

export function move(doc: Doc, dir: "l" | "r" | "u" | "d" | "home" | "end"): Doc {
  if (dir === "home") return { ...doc, col: 0 };
  if (dir === "end") return { ...doc, col: (doc.lines[doc.row] ?? "").length };
  if (dir === "l") {
    if (doc.col > 0) return { ...doc, col: doc.col - 1 };
    if (doc.row === 0) return doc;
    const row = doc.row - 1;
    return { ...doc, row, col: (doc.lines[row] ?? "").length };
  }
  if (dir === "r") {
    const line = doc.lines[doc.row] ?? "";
    if (doc.col < line.length) return { ...doc, col: doc.col + 1 };
    if (doc.row >= doc.lines.length - 1) return doc;
    return { ...doc, row: doc.row + 1, col: 0 };
  }
  if (dir === "u") {
    if (doc.row === 0) return doc;
    const row = doc.row - 1;
    return { ...doc, row, col: clampCol(doc, row, doc.col) };
  }
  if (doc.row >= doc.lines.length - 1) return doc;
  const row = doc.row + 1;
  return { ...doc, row, col: clampCol(doc, row, doc.col) };
}

export function insert(doc: Doc, text: string): Doc {
  if (!text) return doc;
  const lines = doc.lines.slice();
  let row = doc.row;
  let col = doc.col;
  for (const ch of text) {
    if (ch === "\n") {
      const line = lines[row] ?? "";
      lines[row] = line.slice(0, col);
      lines.splice(row + 1, 0, line.slice(col));
      row += 1;
      col = 0;
      continue;
    }
    const add = ch === "\t" ? "  " : ch;
    // 0x7f es Backspace en Linux; no es texto. C0 (salvo tab/nl) tampoco.
    if (ch !== "\t" && (ch < " " || ch === "\x7f")) continue;
    const line = lines[row] ?? "";
    lines[row] = line.slice(0, col) + add + line.slice(col);
    col += add.length;
  }
  return commit(doc, lines, row, col);
}

/** Un chunk de teclado: letras + 0x7f/0x08 mezclados (tipeo rápido en raw mode). */
export function typeInto(doc: Doc, raw: string): Doc {
  let d = doc;
  let run = "";
  const flush = (): void => {
    if (!run) return;
    d = insert(d, run);
    run = "";
  };
  for (const ch of raw) {
    const c = ch.charCodeAt(0);
    if (c === 0x7f || c === 0x08) {
      flush();
      d = backspace(d);
      continue;
    }
    run += ch;
  }
  flush();
  return d;
}

export function newline(doc: Doc): Doc {
  const lines = doc.lines.slice();
  const line = lines[doc.row] ?? "";
  lines[doc.row] = line.slice(0, doc.col);
  lines.splice(doc.row + 1, 0, line.slice(doc.col));
  return commit(doc, lines, doc.row + 1, 0);
}

export function backspace(doc: Doc): Doc {
  if (doc.col > 0) {
    const lines = doc.lines.slice();
    const line = lines[doc.row] ?? "";
    lines[doc.row] = line.slice(0, doc.col - 1) + line.slice(doc.col);
    return commit(doc, lines, doc.row, doc.col - 1);
  }
  if (doc.row === 0) return doc;
  const lines = doc.lines.slice();
  const prev = lines[doc.row - 1] ?? "";
  const col = prev.length;
  lines[doc.row - 1] = prev + (lines[doc.row] ?? "");
  lines.splice(doc.row, 1);
  return commit(doc, lines, doc.row - 1, col);
}

export function delChar(doc: Doc): Doc {
  const line = doc.lines[doc.row] ?? "";
  if (doc.col < line.length) {
    const lines = doc.lines.slice();
    lines[doc.row] = line.slice(0, doc.col) + line.slice(doc.col + 1);
    return commit(doc, lines, doc.row, doc.col);
  }
  if (doc.row >= doc.lines.length - 1) return doc;
  const lines = doc.lines.slice();
  lines[doc.row] = line + (lines[doc.row + 1] ?? "");
  lines.splice(doc.row + 1, 1);
  return commit(doc, lines, doc.row, doc.col);
}

export function scrollToCursor(row: number, off: number, vis: number): number {
  if (row < off) return row;
  if (row >= off + vis) return row - vis + 1;
  return off;
}

export type Pos = { row: number; col: number };

export function cmpPos(a: Pos, b: Pos): number {
  if (a.row !== b.row) return a.row - b.row;
  return a.col - b.col;
}

export function ordered(a: Pos, b: Pos): [Pos, Pos] {
  return cmpPos(a, b) <= 0 ? [a, b] : [b, a];
}

export function sliceRange(doc: Doc, a: Pos, b: Pos): string {
  const [s, e] = ordered(a, b);
  if (s.row === e.row) return (doc.lines[s.row] ?? "").slice(s.col, e.col);
  const parts = [(doc.lines[s.row] ?? "").slice(s.col)];
  for (let r = s.row + 1; r < e.row; r++) parts.push(doc.lines[r] ?? "");
  parts.push((doc.lines[e.row] ?? "").slice(0, e.col));
  return parts.join("\n");
}

export function deleteRange(doc: Doc, a: Pos, b: Pos): Doc {
  const [s, e] = ordered(a, b);
  if (s.row === e.row && s.col === e.col) return doc;
  const lines = doc.lines.slice();
  const merged = (lines[s.row] ?? "").slice(0, s.col) + (lines[e.row] ?? "").slice(e.col);
  lines.splice(s.row, e.row - s.row + 1, merged);
  return commit(doc, lines, s.row, s.col);
}

/** Texto a copiar: selección, o la línea actual (como VS Code). */
export function textToCopy(doc: Doc, anchor: Pos | null): string {
  if (anchor && cmpPos(anchor, { row: doc.row, col: doc.col }) !== 0) {
    return sliceRange(doc, anchor, { row: doc.row, col: doc.col });
  }
  return (doc.lines[doc.row] ?? "") + "\n";
}

export type MouseEv = {
  btn: number;
  x: number;
  y: number;
  press: boolean;
};

/** Ink recorta el ESC: queda `[<0;10;20M`. */
export function parseMouse(input: string): MouseEv | null {
  const s = input.charCodeAt(0) === 0x1b ? input.slice(1) : input;
  const m = /^\[?<(\d+);(\d+);(\d+)([Mm])$/.exec(s);
  if (!m) return null;
  return { btn: Number(m[1]), x: Number(m[2]), y: Number(m[3]), press: m[4] === "M" };
}

/**
 * Un chunk de stdin puede traer mouse + teclas juntos. Si insertamos el CSI,
 * el archivo se llena de `[<0;12;8M` y 0x7f.
 */
export function peelInput(raw: string): { events: MouseEv[]; text: string } {
  const events: MouseEv[] = [];
  let text = "";
  let i = 0;
  while (i < raw.length) {
    const isEsc = raw.charCodeAt(i) === 0x1b;
    const isBare = raw[i] === "[" && raw[i + 1] === "<";
    if (isEsc || isBare) {
      const start = isEsc ? i + 1 : i;
      const m = /^\[<(\d+);(\d+);(\d+)([Mm])/.exec(raw.slice(start));
      if (m) {
        events.push({ btn: Number(m[1]), x: Number(m[2]), y: Number(m[3]), press: m[4] === "M" });
        i = start + m[0].length;
        continue;
      }
      if (isEsc) {
        i += 1;
        continue;
      }
    }
    text += raw[i] ?? "";
    i += 1;
  }
  return { events, text };
}

export function mouseKind(ev: MouseEv): "down" | "up" | "drag" | "wheel-up" | "wheel-down" | "ignore" {
  const b = ev.btn;
  if (b & 64) {
    if (!ev.press) return "ignore";
    return b & 1 ? "wheel-down" : "wheel-up";
  }
  if ((b & 3) !== 0) return "ignore";
  if (b & 32) return "drag";
  return ev.press ? "down" : "up";
}

export function mouseShift(ev: MouseEv): boolean {
  return !!(ev.btn & 4);
}

export const MOUSE_ON = "\x1b[?1000h\x1b[?1002h\x1b[?1006h\x1b[?1007h";
export const MOUSE_OFF = "\x1b[?1000l\x1b[?1002l\x1b[?1006l\x1b[?1007l";

/** Chrome de tui.tsx: header 1 + footer 5; paddingX 1. */
export type Hit =
  | { zone: "tree"; index: number }
  | { zone: "code"; row: number; col: number }
  | { zone: "other" };

export function hitTest(
  x1: number,
  y1: number,
  opts: {
    explorerW: number;
    centerW: number;
    treeStart: number;
    treeLen: number;
    treeVis: number;
    previewOff: number;
    codeVis: number;
  },
): Hit {
  const x = x1 - 1;
  const y = y1 - 1;
  const bodyY = 1;
  const treeX0 = 1;
  const treeX1 = 1 + opts.explorerW;
  const codeX1 = treeX1 + opts.centerW;
  const treeY0 = 5;
  const codeY0 = 4;
  const codeX0 = opts.explorerW + 9;

  if (y < bodyY) return { zone: "other" };
  if (x >= treeX0 && x < treeX1) {
    const i = opts.treeStart + (y - treeY0);
    if (i < 0 || i >= opts.treeLen) return { zone: "tree", index: Math.max(0, Math.min(i, opts.treeLen - 1)) };
    return { zone: "tree", index: i };
  }
  if (x >= treeX1 && x < codeX1) {
    const row = Math.max(0, opts.previewOff + (y - codeY0));
    const col = Math.max(0, x - codeX0);
    return { zone: "code", row, col };
  }
  return { zone: "other" };
}

/** Fallback interno si no hay wl-copy/xclip. */
let memClip = "";

function runClip(cmd: string, args: string[], input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: [input === undefined ? "ignore" : "pipe", "pipe", "ignore"] });
    const stdout = p.stdout;
    const stdin = p.stdin;
    if (!stdout) {
      reject(new Error("clip"));
      return;
    }
    let out = "";
    stdout.setEncoding("utf8");
    stdout.on("data", (chunk: string) => {
      out += chunk;
    });
    p.on("error", reject);
    p.on("exit", (code) => {
      if (code === 0) resolve(out);
      else reject(new Error("clip"));
    });
    if (input !== undefined) {
      if (!stdin) {
        reject(new Error("clip"));
        return;
      }
      stdin.end(input);
    }
  });
}

/** Copia: memoria + OSC 52 + portapapeles del SO si existe. */
export function copyText(text: string): void {
  memClip = text;
  process.stdout.write(`\x1b]52;c;${Buffer.from(text, "utf8").toString("base64")}\x07`);
  const writers: Array<[string, string[]]> = [
    ["wl-copy", []],
    ["xclip", ["-selection", "clipboard", "-i"]],
    ["xsel", ["-ib"]],
  ];
  void (async () => {
    for (const [cmd, args] of writers) {
      try {
        await runClip(cmd, args, text);
        return;
      } catch {
        /* siguiente binario */
      }
    }
  })();
}

export async function pasteText(): Promise<string> {
  const readers: Array<[string, string[]]> = [
    ["wl-paste", ["-n"]],
    ["xclip", ["-selection", "clipboard", "-o"]],
    ["xsel", ["-ob"]],
  ];
  for (const [cmd, args] of readers) {
    try {
      const out = await runClip(cmd, args);
      if (out) return out.slice(0, MAX_EDIT_BYTES);
    } catch {
      /* siguiente */
    }
  }
  return memClip;
}
