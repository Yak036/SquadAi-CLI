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

/** Celda de una columna del split (antes | después). */
export type SplitCell = { ln: number; t: string; k: " " | "+" | "-" };

/** Una fila visual: modificación en la misma línea, o hueco entre hunks. */
export type SplitRow = {
  left: SplitCell | null;
  right: SplitCell | null;
  gap?: boolean;
};

/** Contexto a cada lado del cambio. Más es ruido; menos pierde el ancla. */
const HUNK_CTX = 3;

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

/**
 * Unified → dos columnas alineadas. Un `-` seguido de `+` se sienta en la misma fila
 * (el caso típico: se editó una línea). Números de línea independientes por lado.
 */
export function splitDiff(unified: DiffRow[]): SplitRow[] {
  const out: SplitRow[] = [];
  let i = 0;
  let l = 1;
  let r = 1;
  while (i < unified.length) {
    const row = unified[i]!;
    if (row.k === " ") {
      out.push({
        left: { ln: l, t: row.t, k: " " },
        right: { ln: r, t: row.t, k: " " },
      });
      l += 1;
      r += 1;
      i += 1;
      continue;
    }
    const dels: string[] = [];
    const adds: string[] = [];
    while (i < unified.length && unified[i]!.k === "-") {
      dels.push(unified[i]!.t);
      i += 1;
    }
    while (i < unified.length && unified[i]!.k === "+") {
      adds.push(unified[i]!.t);
      i += 1;
    }
    const n = Math.max(dels.length, adds.length);
    for (let k = 0; k < n; k++) {
      const left = k < dels.length ? { ln: l, t: dels[k]!, k: "-" as const } : null;
      const right = k < adds.length ? { ln: r, t: adds[k]!, k: "+" as const } : null;
      if (left) l += 1;
      if (right) r += 1;
      out.push({ left, right });
    }
  }
  return out;
}

/** Recorta a los hunks con contexto. Sin esto el review muestra el README entero. */
export function focusHunks(rows: SplitRow[], ctx = HUNK_CTX): SplitRow[] {
  if (rows.length === 0) return rows;
  const dirty = rows.map((row) => row.left?.k === "-" || row.right?.k === "+");
  if (!dirty.some(Boolean)) return rows;
  const keep = dirty.map(() => false);
  for (let i = 0; i < rows.length; i++) {
    if (!dirty[i]) continue;
    const from = Math.max(0, i - ctx);
    const to = Math.min(rows.length - 1, i + ctx);
    for (let j = from; j <= to; j++) keep[j] = true;
  }
  const out: SplitRow[] = [];
  let i = 0;
  while (i < rows.length) {
    if (!keep[i]) {
      while (i < rows.length && !keep[i]) i += 1;
      if (out.length > 0 && i < rows.length) out.push({ left: null, right: null, gap: true });
      continue;
    }
    out.push(rows[i]!);
    i += 1;
  }
  return out;
}

/** Diff listo para pintar en la TUI. */
export function reviewDiff(before: string | null, after: string): SplitRow[] {
  return focusHunks(splitDiff(lineDiff(before ?? "", after)));
}

export function actionTitle(action: ChangeAction): string {
  return action === "created" ? "Create" : "Edit";
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
