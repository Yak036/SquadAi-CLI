/**
 * Diff + revert de lo que escribió la IA. El back ya pegó a disco; n restaura el snapshot.
 * ponytail: LCS tope 80k celdas; si el archivo es enorme, -todo / +todo.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { insideWorkspace } from "./midnight.js";
import type { ChangeAction, TraceEvent } from "./types.js";

export type PendingChange = {
  rel: string;
  before: string | null;
  after: string;
  action: ChangeAction;
};

export type DiffRow = { k: " " | "+" | "-"; t: string };

const TRACE_FILE = /^(?:escribiendo|aprobado|generando|revisando|rechazado|falló)\s+(.+)$/;

export function relFromTrace(ev: TraceEvent): string | null {
  const m = TRACE_FILE.exec(ev.event.trim());
  const rel = m?.[1]?.trim();
  return rel || null;
}

export function isWriteTrace(ev: TraceEvent): boolean {
  const e = ev.event;
  return e.startsWith("escribiendo ") || e.startsWith("aprobado ");
}

export async function readOrNull(root: string, rel: string): Promise<string | null> {
  const abs = path.resolve(root, rel);
  if (!insideWorkspace(root, abs)) return null;
  try {
    return await fs.readFile(abs, "utf8");
  } catch {
    return null;
  }
}

export async function revertFile(root: string, rel: string, before: string | null): Promise<void> {
  const abs = path.resolve(root, rel);
  if (!insideWorkspace(root, abs)) throw new Error("ruta bloqueada");
  if (before === null) {
    await fs.unlink(abs);
    return;
  }
  await fs.writeFile(abs, before, "utf8");
}

export function lineDiff(before: string, after: string): DiffRow[] {
  const a = before.split("\n");
  const b = after.split("\n");
  if (a.length * b.length > 80_000) {
    return [...a.map((t) => ({ k: "-" as const, t })), ...b.map((t) => ({ k: "+" as const, t }))];
  }
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => Array.from({ length: m + 1 }, () => 0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] = a[i] === b[j] ? (dp[i + 1]![j + 1] ?? 0) + 1 : Math.max(dp[i + 1]![j] ?? 0, dp[i]![j + 1] ?? 0);
    }
  }
  const out: DiffRow[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ k: " ", t: a[i] ?? "" });
      i += 1;
      j += 1;
    } else if ((dp[i + 1]![j] ?? 0) >= (dp[i]![j + 1] ?? 0)) {
      out.push({ k: "-", t: a[i] ?? "" });
      i += 1;
    } else {
      out.push({ k: "+", t: b[j] ?? "" });
      j += 1;
    }
  }
  while (i < n) {
    out.push({ k: "-", t: a[i] ?? "" });
    i += 1;
  }
  while (j < m) {
    out.push({ k: "+", t: b[j] ?? "" });
    j += 1;
  }
  return out;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
