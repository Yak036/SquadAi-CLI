/**
 * Diff lado a lado. Cada celda tiene ancho fijo: Ink no recorta solo con flexGrow,
 * y el fondo SGR solo pinta donde hay caracteres, así que recortamos y rellenamos.
 */
import { Box, Text } from "ink";
import type { ReactNode } from "react";
import { C } from "./midnight.js";
import type { SplitCell, SplitRow } from "./review.js";
import { colorizeLine, langFromExt, type ColoredSegment } from "./syntax.js";

function lnWidth(rows: SplitRow[]): number {
  let m = 1;
  for (const row of rows) {
    if (row.left) m = Math.max(m, row.left.ln);
    if (row.right) m = Math.max(m, row.right.ln);
  }
  return Math.max(2, String(m).length);
}

/** Ancho de pantalla de un codepoint. Emoji/CJK = 2; combiners = 0. */
export function colW(ch: string): number {
  const cp = ch.codePointAt(0) ?? 0;
  if (cp <= 0x1f || cp === 0x7f) return 0;
  if (cp >= 0x300 && cp <= 0x36f) return 0;
  if (cp >= 0xfe00 && cp <= 0xfe0f) return 0;
  if (cp === 0x200d) return 0;
  if (cp >= 0x1f000) return 2;
  if (cp >= 0x2600 && cp <= 0x27bf) return 2;
  if (cp >= 0x2300 && cp <= 0x23ff) return 2;
  if (cp >= 0x2e80 && cp <= 0xa4cf) return 2;
  if (cp >= 0xac00 && cp <= 0xd7a3) return 2;
  if (cp >= 0xf900 && cp <= 0xfaff) return 2;
  if (cp >= 0xff00 && cp <= 0xff60) return 2;
  return 1;
}

export function visWidth(s: string): number {
  let w = 0;
  for (const ch of s) w += colW(ch);
  return w;
}

/** Recorta a `n` columnas de pantalla. No rellena. */
export function clipCols(s: string, n: number): string {
  let w = 0;
  let out = "";
  for (const ch of s) {
    const dw = colW(ch);
    if (w + dw > n) break;
    out += ch;
    w += dw;
  }
  return out;
}

/** Recorta y rellena con espacios hasta `n` columnas. */
export function fitCols(s: string, n: number): string {
  if (n <= 0) return "";
  const clipped = clipCols(s.replace(/\t/g, "  "), n);
  return clipped + " ".repeat(Math.max(0, n - visWidth(clipped)));
}

function clipSegs(segs: ColoredSegment[], max: number): ColoredSegment[] {
  const out: ColoredSegment[] = [];
  let used = 0;
  for (const seg of segs) {
    if (used >= max) break;
    const text = clipCols(seg.text.replace(/\t/g, "  "), max - used);
    if (!text) break;
    out.push({ text, color: seg.color });
    used += visWidth(text);
  }
  return out;
}

function Cell(props: {
  cell: SplitCell | null;
  file: string;
  pad: number;
  width: number;
}): ReactNode {
  const { cell, file, pad, width } = props;
  const gutterW = pad + 3;
  const bodyW = Math.max(0, width - gutterW);
  const bg = cell?.k === "-" ? C.delBg : cell?.k === "+" ? C.addBg : C.panel;
  const mark = !cell ? " " : cell.k === " " ? " " : cell.k;
  const markColor = cell?.k === "-" ? C.rose : cell?.k === "+" ? C.cyan : C.muted;
  const gutter = `${cell ? String(cell.ln).padStart(pad, " ") : " ".repeat(pad)} ${mark} `;
  const segs = cell ? clipSegs(colorizeLine(cell.t, langFromExt(file)), bodyW) : [];
  const used = segs.reduce((n, s) => n + visWidth(s.text), 0);
  const padRight = " ".repeat(Math.max(0, bodyW - used));

  return (
    <Box width={width} height={1} flexShrink={0} overflow="hidden" backgroundColor={bg}>
      <Text>
        <Text color={markColor} backgroundColor={bg}>
          {gutter}
        </Text>
        {segs.map((seg, i) => (
          <Text key={i} color={seg.color} backgroundColor={bg}>
            {seg.text}
          </Text>
        ))}
        <Text backgroundColor={bg}>{padRight}</Text>
      </Text>
    </Box>
  );
}

export function DiffView(props: {
  rows: SplitRow[];
  off: number;
  vis: number;
  file: string;
  width: number;
}): ReactNode {
  const { rows, off, vis, file, width } = props;
  const pad = lnWidth(rows);
  const slice = rows.slice(off, off + vis);
  const colWSize = Math.max(8, Math.floor((width - 1) / 2));
  const total = colWSize * 2 + 1;

  if (slice.length === 0) {
    return <Text dimColor>sin cambios visibles</Text>;
  }

  return (
    <Box flexDirection="column" width={total} overflow="hidden">
      {slice.map((row, i) =>
        row.gap ? (
          <Box key={`g${off + i}`} width={total} height={1} flexShrink={0}>
            <Text color={C.muted}>{fitCols("···", total)}</Text>
          </Box>
        ) : (
          <Box key={off + i} flexDirection="row" width={total} height={1} flexShrink={0}>
            <Cell cell={row.left} file={file} pad={pad} width={colWSize} />
            <Text color={C.muted}>│</Text>
            <Cell cell={row.right} file={file} pad={pad} width={colWSize} />
          </Box>
        ),
      )}
    </Box>
  );
}
