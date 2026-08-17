/**
 * Deep Midnight: árbol del workspace + CPU/RAM. Sin deps.
 * El TTY no puede cargar JetBrains Mono; los colores sí.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const C = {
  /** Carbón opaco: celdas con este bg no heredan la transparencia del TTY. */
  bg: "#12141d",
  panel: "#1a1d27",
  cyan: "#22d3ee",
  emerald: "#34d399",
  amber: "#fbbf24",
  rose: "#f87171",
  muted: "#7a8496",
  /** Fondos de diff tipo OpenCode: rojo apagado / teal apagado. */
  delBg: "#3b1d22",
  addBg: "#163a3c",
  /** Syntax highlighting */
  synKeyword: "#c792ea",
  synString: "#c3e88d",
  synNumber: "#f78c6c",
  synComment: "#546e7a",
  synFunction: "#82aaff",
  synType: "#ffcb6b",
  synOperator: "#89ddff",
  synProperty: "#f07178",
  synBoolean: "#ff5370",
  synDecorator: "#c792ea",
  synText: "#d6deeb",
} as const;

/** #12141d en SGR 48 para el clear del alt-screen (BCE). */
const BG_SGR = "\x1b[48;2;18;20;29m";

export function enterMidnightScreen(): void {
  process.stdout.write(`\x1b[?1049h${BG_SGR}\x1b[H\x1b[2J`);
}

export function leaveMidnightScreen(): void {
  process.stdout.write("\x1b[?1000l\x1b[?1002l\x1b[?1006l\x1b[?1007l\x1b[0m\x1b[?1049l");
}

const SKIP = new Set(["node_modules", ".git", "dist", "coverage", ".next", ".turbo"]);
const JUNK = /(?:^~)|(?:\.sw[pon]$)|(?:~$)/i;
const MAX_ENTRIES = 220;

export type TreeEntry = {
  rel: string;
  name: string;
  dir: boolean;
  depth: number;
};

export async function listVisibleTree(root: string, expanded: Set<string>): Promise<TreeEntry[]> {
  const out: TreeEntry[] = [];
  await walk(root, "", 0, expanded, out);
  return out;
}

async function walk(
  absDir: string,
  relDir: string,
  depth: number,
  expanded: Set<string>,
  out: TreeEntry[],
): Promise<void> {
  if (out.length >= MAX_ENTRIES) return;
  let names: string[];
  try {
    names = await fs.readdir(absDir);
  } catch {
    return;
  }
  names.sort((a, b) => a.localeCompare(b));
  for (const name of names) {
    if (out.length >= MAX_ENTRIES) return;
    if (SKIP.has(name) || JUNK.test(name) || name === "." || name === "..") continue;
    const abs = path.join(absDir, name);
    const rel = relDir ? `${relDir}/${name}` : name;
    let dir = false;
    try {
      dir = (await fs.stat(abs)).isDirectory();
    } catch {
      continue;
    }
    out.push({ rel, name, dir, depth });
    if (dir && expanded.has(rel)) await walk(abs, rel, depth + 1, expanded, out);
  }
}

export function bar(pct: number, width: number): string {
  const n = Math.max(0, Math.min(width, Math.round((pct / 100) * width)));
  return "█".repeat(n) + "░".repeat(width - n);
}

export type SysSnap = {
  cpu: number;
  ramUsedGb: number;
  ramTotalGb: number;
  threads: number;
};

let prevCpu: { idle: number; total: number } | null = null;

export async function readSys(): Promise<SysSnap> {
  const threads = os.cpus().length || 1;
  const ramTotalGb = os.totalmem() / 1024 ** 3;
  const ramUsedGb = (os.totalmem() - os.freemem()) / 1024 ** 3;
  const cpu = await readCpuPct();
  return { cpu, ramUsedGb, ramTotalGb, threads };
}

async function readCpuPct(): Promise<number> {
  if (process.platform !== "linux") {
    const load = os.loadavg()[0] ?? 0;
    const n = os.cpus().length || 1;
    return Math.max(0, Math.min(100, (load / n) * 100));
  }
  try {
    const text = await fs.readFile("/proc/stat", "utf8");
    const line = text.split("\n")[0] ?? "";
    const parts = line.trim().split(/\s+/).slice(1).map(Number);
    const idle = (parts[3] ?? 0) + (parts[4] ?? 0);
    const total = parts.reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0);
    const prev = prevCpu;
    prevCpu = { idle, total };
    if (!prev) return 0;
    const dIdle = idle - prev.idle;
    const dTotal = total - prev.total;
    if (dTotal <= 0) return 0;
    return Math.max(0, Math.min(100, (1 - dIdle / dTotal) * 100));
  } catch {
    return 0;
  }
}

/** Evita `/tmp/proj` matching `/tmp/proj-evil`. */
export function insideWorkspace(root: string, abs: string): boolean {
  const r = path.resolve(root);
  const a = path.resolve(abs);
  return a === r || a.startsWith(r + path.sep);
}

export function tintLine(line: string): "cyan" | "green" | "gray" | "white" {
  const t = line.trim();
  if (!t || t.startsWith("//") || t.startsWith("#") || t.startsWith("*") || t.startsWith("/*")) return "gray";
  if (/^(import|export|from|def |class |function |const |let |var |return )/.test(t)) return "cyan";
  if (t.startsWith("\"") || t.startsWith("'") || t.startsWith("`")) return "green";
  return "white";
}
