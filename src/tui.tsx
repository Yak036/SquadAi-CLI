/**
 * TUI Deep Midnight: explorador | workspace | monitor.
 * chat/squad hablan con el back; editor mira/abre archivos del workspace.
 */
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { Box, Text, render, useApp, useInput, useStdin, useStdout } from "ink";
import TextInput from "ink-text-input";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { SquadApi } from "./api.js";
import { ContextManager, formatContextForPrompt } from "./context.js";
import {
  composeInEditor,
  openFileInEditor,
  expandAtRefs,
  handleSlash,
  refreshSession,
  type Ctx,
  type Session,
} from "./commands.js";
import { findAtRefs } from "./parse.js";
import {
  backspace,
  clickAt,
  cmpPos,
  copyText,
  delChar,
  deleteRange,
  hitTest,
  insert,
  loadDoc,
  markSaved,
  MAX_EDIT_BYTES,
  mouseKind,
  mouseShift,
  MOUSE_OFF,
  MOUSE_ON,
  move,
  newline,
  ordered,
  parseMouse,
  pasteText,
  redo,
  scrollToCursor,
  serialize,
  textToCopy,
  undo,
  type Doc,
  type Pos,
} from "./buffer.js";
import {
  bar,
  C,
  enterMidnightScreen,
  insideWorkspace,
  leaveMidnightScreen,
  listVisibleTree,
  readSys,
  tintLine,
  type SysSnap,
  type TreeEntry,
} from "./midnight.js";
import { nextUiMode, parseUiMode, parseSlash, type UiMode } from "./parse.js";
import { isWriteTrace, lineDiff, readOrNull, relFromTrace, revertFile, sleep, type PendingChange } from "./review.js";
import type { OrchestrateRequest, TraceActor, TraceEvent } from "./types.js";

type Line = { kind: "user" | "squad" | "sys"; text: string; who?: string };
type Step = { actor: TraceActor; label: string; detail: string };

const HISTORY_CAP = 12;
const SPIN = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function useTermSize(): { columns: number; rows: number } {
  const { stdout } = useStdout();
  const [size, setSize] = useState({
    columns: stdout.columns || 80,
    rows: stdout.rows || 24,
  });
  useEffect(() => {
    const onResize = (): void => {
      setSize({ columns: stdout.columns || 80, rows: stdout.rows || 24 });
    };
    stdout.on("resize", onResize);
    return () => {
      stdout.off("resize", onResize);
    };
  }, [stdout]);
  return size;
}

function useSpinner(on: boolean): string {
  const [i, setI] = useState(0);
  useEffect(() => {
    if (!on) return;
    const t = setInterval(() => setI((n) => n + 1), 80);
    return () => clearInterval(t);
  }, [on]);
  return on ? (SPIN[i % SPIN.length] ?? "⠋") : "·";
}

function useClock(): string {
  const [now, setNow] = useState(() => new Date().toTimeString().slice(0, 8));
  useEffect(() => {
    const t = setInterval(() => setNow(new Date().toTimeString().slice(0, 8)), 1000);
    return () => clearInterval(t);
  }, []);
  return now;
}

function healthLabel(ok: boolean | undefined): string {
  return ok ? "ACTIVE" : "DOWN";
}

function colorFor(kind: Line["kind"]): string {
  if (kind === "user") return C.cyan;
  if (kind === "sys") return C.amber;
  return "white";
}

function actorColor(actor: TraceActor | "idle"): string {
  if (actor === "chat") return C.cyan;
  if (actor === "boss") return C.emerald;
  if (actor === "worker") return C.amber;
  if (actor === "qa") return C.emerald;
  return C.muted;
}

function friendlyStep(ev: TraceEvent): Step | null {
  const e = ev.event;
  if (e === "respuesta" || e.startsWith("tarea finalizada")) return null;
  let label = e;
  if (e === "captando mensaje" || e.startsWith("captando")) label = "escuchando";
  else if (e === "pensando" || e.startsWith("pensando")) label = "pensando";
  else if (e === "glob") label = "archivos";
  else if (e === "read") label = "leyendo";
  else if (e === "grep") label = "buscando";
  else if (e === "workspace") label = "carpeta";
  else if (e.startsWith("escribiendo")) label = "escribiendo";
  return { actor: ev.actor, label, detail: clipArgs(ev.detail) };
}

function clipArgs(raw: string): string {
  const t = raw.trim();
  if (!t) return "";
  try {
    const o = JSON.parse(t) as Record<string, unknown>;
    if (typeof o.pattern === "string") return o.pattern;
    if (typeof o.path === "string") return o.path;
  } catch {
    /* no JSON */
  }
  return t.length > 36 ? t.slice(0, 35) + "…" : t;
}

function modeColor(mode: UiMode): string {
  if (mode === "chat") return C.cyan;
  if (mode === "squad") return C.emerald;
  return C.amber;
}

export async function runTui(api: SquadApi, session: Session, version: string): Promise<void> {
  enterMidnightScreen();
  process.once("exit", leaveMidnightScreen);
  try {
    const instance = render(<App api={api} session={session} version={version} />, {
      exitOnCtrlC: false,
    });
    await instance.waitUntilExit();
  } finally {
    leaveMidnightScreen();
  }
}

function App(props: { api: SquadApi; session: Session; version: string }): ReactNode {
  const { api, session, version } = props;
  const { exit } = useApp();
  const { stdin, setRawMode } = useStdin();
  const { columns, rows } = useTermSize();
  const clock = useClock();
  const [lines, setLines] = useState<Line[]>([]);
  const [steps, setSteps] = useState<Step[]>([]);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [quitAsk, setQuitAsk] = useState(false);
  const [connectMode, setConnectMode] = useState(false);
  const [away, setAway] = useState(false);
  const [railOpen, setRailOpen] = useState(true);
  const [actor, setActor] = useState<TraceActor | "idle">("idle");
  const [detail, setDetail] = useState("");
  const [stamp, setStamp] = useState(0);
  const [uiMode, setUiMode] = useState<UiMode>(session.mode);
  const [tree, setTree] = useState<TreeEntry[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [cursor, setCursor] = useState(0);
  const [openRel, setOpenRel] = useState<string | null>(null);
  const [doc, setDoc] = useState<Doc | null>(null);
  const [focus, setFocus] = useState<"tree" | "buf">("tree");
  const [anchor, setAnchor] = useState<Pos | null>(null);
  const [previewOff, setPreviewOff] = useState(0);
  const [pending, setPending] = useState<PendingChange[]>([]);
  const [reviewIdx, setReviewIdx] = useState(0);
  const [sys, setSys] = useState<SysSnap>({ cpu: 0, ramUsedGb: 0, ramTotalGb: 8, threads: os.cpus().length });
  const abortRef = useRef<AbortController | null>(null);
  const dragRef = useRef(false);
  const openRelRef = useRef<string | null>(null);
  const dirtyRef = useRef(false);
  const beforeRef = useRef<Map<string, string | null>>(new Map());
  openRelRef.current = openRel;
  dirtyRef.current = Boolean(doc?.dirty);
  const spin = useSpinner(busy);

  const push = (line: Line): void => {
    setLines((prev) => [...prev.slice(-60), line]);
  };

  const ctx: Ctx = {
    api,
    session,
    print: (text) => push({ kind: "sys", text: text.trimEnd() }),
    askSecret: async () => "",
  };

  useEffect(() => {
    void refreshSession(ctx).then(() => setStamp((n) => n + 1));
  }, []);

  const reloadTree = (): void => {
    void listVisibleTree(session.workspaceDir, expanded).then(setTree);
  };

  useEffect(() => {
    reloadTree();
  }, [session.workspaceDir, expanded, stamp]);

  useEffect(() => {
    setCursor((n) => (tree.length === 0 ? 0 : Math.min(n, tree.length - 1)));
  }, [tree]);

  useEffect(() => {
    const tick = (): void => {
      void readSys().then(setSys);
    };
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, []);

  const explorerW = Math.max(18, Math.min(26, Math.floor(columns * 0.22)));
  const railW = railOpen ? Math.max(20, Math.min(28, Math.floor(columns * 0.24))) : 0;
  const centerW = Math.max(24, columns - explorerW - railW - 4);
  const codeVis = Math.max(8, rows - 12);
  const treeVis = Math.max(4, rows - 12);
  const treeStart =
    tree.length <= treeVis ? 0 : Math.max(0, Math.min(cursor - treeVis + 1, tree.length - treeVis));

  useEffect(() => {
    if (away || uiMode !== "editor") {
      process.stdout.write(MOUSE_OFF);
      return;
    }
    process.stdout.write(MOUSE_ON);
    return () => {
      process.stdout.write(MOUSE_OFF);
    };
  }, [uiMode, away]);

  useEffect(() => {
    if (!doc) return;
    setPreviewOff((off) => scrollToCursor(doc.row, off, codeVis));
  }, [doc?.row, codeVis]);

  const persistIfDirty = async (): Promise<boolean> => {
    if (!openRel || !doc?.dirty) return true;
    const abs = path.resolve(session.workspaceDir, openRel);
    if (!insideWorkspace(session.workspaceDir, abs)) return false;
    try {
      await fs.writeFile(abs, serialize(doc), "utf8");
      setDoc(markSaved(doc));
      return true;
    } catch (err) {
      push({ kind: "sys", text: err instanceof Error ? err.message : String(err) });
      return false;
    }
  };

  const loadFile = (rel: string): void => {
    void (async () => {
      if (!(await persistIfDirty())) return;
      const abs = path.resolve(session.workspaceDir, rel);
      if (!insideWorkspace(session.workspaceDir, abs)) {
        push({ kind: "sys", text: "ruta bloqueada" });
        return;
      }
      try {
        const buf = await fs.readFile(abs);
        if (buf.byteLength > MAX_EDIT_BYTES) {
          setDoc(null);
          setOpenRel(rel);
          setFocus("tree");
          push({ kind: "sys", text: "archivo grande — ctrl+e abre $EDITOR" });
          return;
        }
        if (buf.includes(0)) {
          setDoc(null);
          setOpenRel(rel);
          setFocus("tree");
          push({ kind: "sys", text: "binario — ctrl+e abre $EDITOR" });
          return;
        }
        setDoc(loadDoc(buf.toString("utf8")));
        setOpenRel(rel);
        setPreviewOff(0);
        setAnchor(null);
        setFocus("buf");
      } catch {
        setDoc(null);
        push({ kind: "sys", text: "no se pudo leer" });
      }
    })();
  };

  const pullAiFile = async (rel: string): Promise<void> => {
    if (dirtyRef.current && openRelRef.current === rel) return;
    const after = await readOrNull(session.workspaceDir, rel);
    if (after === null) return;
    setOpenRel(rel);
    setAnchor(null);
    setDoc((prev) => {
      const next = loadDoc(after);
      if (!prev) return next;
      const row = Math.min(prev.row, next.lines.length - 1);
      const col = Math.min(prev.col, (next.lines[row] ?? "").length);
      return { ...next, row, col };
    });
  };

  const showPending = (items: PendingChange[], idx: number): void => {
    const item = items[idx];
    if (!item) {
      setPending([]);
      setReviewIdx(0);
      return;
    }
    setPending(items);
    setReviewIdx(idx);
    setOpenRel(item.rel);
    setDoc(loadDoc(item.after));
    setPreviewOff(0);
    setAnchor(null);
  };

  const acceptCurrent = (): void => {
    const rest = pending.filter((_, i) => i !== reviewIdx);
    showPending(rest, Math.min(reviewIdx, Math.max(0, rest.length - 1)));
    if (rest.length === 0) push({ kind: "sys", text: "cambios aceptados" });
  };

  const rejectCurrent = async (): Promise<void> => {
    const item = pending[reviewIdx];
    if (!item) return;
    try {
      await revertFile(session.workspaceDir, item.rel, item.before);
      const rest = pending.filter((_, i) => i !== reviewIdx);
      if (rest.length === 0) {
        setPending([]);
        setReviewIdx(0);
        await pullAiFile(item.rel);
        push({ kind: "sys", text: `revertido ${item.rel}` });
      } else {
        showPending(rest, Math.min(reviewIdx, rest.length - 1));
      }
      setStamp((n) => n + 1);
    } catch (err) {
      push({ kind: "sys", text: err instanceof Error ? err.message : String(err) });
    }
  };

  const acceptAll = (): void => {
    setPending([]);
    setReviewIdx(0);
    push({ kind: "sys", text: "todos los cambios aceptados" });
  };

  const rejectAll = async (): Promise<void> => {
    for (const item of pending) {
      try {
        await revertFile(session.workspaceDir, item.rel, item.before);
      } catch {
        /* sigue con el resto */
      }
    }
    const first = pending[0];
    setPending([]);
    setReviewIdx(0);
    if (first) await pullAiFile(first.rel);
    setStamp((n) => n + 1);
    push({ kind: "sys", text: "todos los cambios revertidos" });
  };

  const applyUiMode = (next: UiMode): void => {
    if (uiMode === "editor" && next !== "editor") {
      void persistIfDirty();
      setFocus("tree");
    }
    setUiMode(next);
    if (next === "chat" || next === "squad") session.mode = next;
    if (next === "editor") setFocus(openRel ? "buf" : "tree");
  };

  const cancelJob = (): void => {
    abortRef.current?.abort();
  };

  const leave = (): void => {
    void persistIfDirty().then(() => exit());
  };

  const suspendTty = async (fn: () => Promise<void>): Promise<void> => {
    setAway(true);
    await new Promise((r) => setTimeout(r, 40));
    leaveMidnightScreen();
    process.stdout.write("\x1b[?25h");
    if (stdin.isTTY) setRawMode(false);
    stdin.pause();
    try {
      await fn();
    } finally {
      stdin.resume();
      if (stdin.isTTY) setRawMode(true);
      enterMidnightScreen();
      setAway(false);
    }
  };

  const current = tree[cursor];

  const openAt = (index: number): void => {
    const ent = tree[index];
    if (!ent) return;
    setCursor(index);
    if (ent.dir) {
      setFocus("tree");
      setExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(ent.rel)) next.delete(ent.rel);
        else next.add(ent.rel);
        return next;
      });
      return;
    }
    loadFile(ent.rel);
  };

  const openCurrent = (): void => {
    openAt(cursor);
  };

  const editCurrent = async (): Promise<void> => {
    const rel = openRel ?? (current && !current.dir ? current.rel : null);
    if (!rel) {
      push({ kind: "sys", text: "elegí un archivo" });
      return;
    }
    if (!(await persistIfDirty())) return;
    const abs = path.resolve(session.workspaceDir, rel);
    if (!insideWorkspace(session.workspaceDir, abs)) {
      push({ kind: "sys", text: "ruta bloqueada" });
      return;
    }
    if (!process.env.EDITOR?.trim()) {
      push({ kind: "sys", text: "definí EDITOR (ej. export EDITOR=nvim)" });
      return;
    }
    try {
      await suspendTty(() => openFileInEditor(abs));
      loadFile(rel);
      reloadTree();
    } catch (err) {
      push({ kind: "sys", text: err instanceof Error ? err.message : String(err) });
    }
  };

  const onMouse = (raw: string): boolean => {
    const ev = parseMouse(raw);
    if (!ev || uiMode !== "editor") return false;
    const kind = mouseKind(ev);
    if (kind === "ignore") return true;
    const hit = hitTest(ev.x, ev.y, {
      explorerW,
      centerW,
      treeStart,
      treeLen: tree.length,
      treeVis,
      previewOff,
      codeVis,
    });
    if (kind === "wheel-up" || kind === "wheel-down") {
      dragRef.current = false;
      const delta = kind === "wheel-up" ? -3 : 3;
      if (hit.zone === "tree") {
        setFocus("tree");
        setCursor((n) => Math.max(0, Math.min(tree.length - 1, n + delta)));
      } else if (hit.zone === "code" && doc) {
        const maxOff = Math.max(0, doc.lines.length - 1);
        setPreviewOff((o) => Math.max(0, Math.min(maxOff, o + delta)));
      }
      return true;
    }
    if (kind === "up") {
      dragRef.current = false;
      return true;
    }
    // Arrastre: ancla fija, el cursor sigue al ratón → se sombrea.
    if (kind === "drag") {
      if (!dragRef.current || !doc) return true;
      const row = hit.zone === "code" ? hit.row : doc.row;
      const col = hit.zone === "code" ? hit.col : doc.col;
      setDoc(clickAt(doc, row, col));
      return true;
    }
    if (kind === "down" && hit.zone === "tree") {
      dragRef.current = false;
      openAt(hit.index);
      return true;
    }
    if (kind === "down" && hit.zone === "code") {
      dragRef.current = true;
      setFocus("buf");
      if (!doc) return true;
      if (mouseShift(ev)) {
        if (!anchor) setAnchor({ row: doc.row, col: doc.col });
      } else {
        setAnchor({ row: hit.row, col: hit.col });
      }
      setDoc(clickAt(doc, hit.row, hit.col));
      return true;
    }
    return true;
  };

  useInput(
    (input, key) => {
      if (away) return;
      if (/\[</.test(input) || input.includes("\x1b[<")) {
        onMouse(input);
        return;
      }
      if (onMouse(input)) return;
      if (quitAsk) {
        if (input === "s" || input === "y" || key.return) leave();
        else if (input === "n" || key.escape) setQuitAsk(false);
        else if (key.ctrl && input === "c") leave();
        return;
      }
      if (pending.length && !key.ctrl) {
        if (input === "y") {
          acceptCurrent();
          return;
        }
        if (input === "n") {
          void rejectCurrent();
          return;
        }
        if (input === "a") {
          acceptAll();
          return;
        }
        if (input === "r") {
          void rejectAll();
          return;
        }
      }

      const editing = uiMode === "editor" && focus === "buf" && doc;

      if (editing && key.ctrl && input === "c") {
        if (busy) {
          cancelJob();
          return;
        }
        copyText(textToCopy(doc, anchor));
        return;
      }
      if (editing && key.ctrl && (input === "p" || input === "v")) {
        void pasteText().then((text) => {
          if (!text) return;
          setDoc((prev) => {
            if (!prev) return prev;
            const cur: Pos = { row: prev.row, col: prev.col };
            const base =
              anchor && cmpPos(anchor, cur) !== 0 ? deleteRange(prev, anchor, cur) : prev;
            setAnchor(null);
            return insert(base, text);
          });
        });
        return;
      }

      if (key.ctrl && input === "p") {
        setRailOpen((v) => !v);
        return;
      }
      if (key.ctrl && input === "c") {
        if (busy) cancelJob();
        else setQuitAsk(true);
        return;
      }
      if (key.escape && busy) {
        cancelJob();
        return;
      }

      if (uiMode !== "editor") {
        if (key.tab) applyUiMode(nextUiMode(uiMode));
        return;
      }

      if (key.ctrl && input === "s") {
        void persistIfDirty();
        return;
      }
      if (key.ctrl && input === "e") {
        void editCurrent();
        return;
      }

      if (focus === "buf" && doc) {
        if (key.ctrl && (input === "y" || (input === "z" && key.shift))) {
          setAnchor(null);
          setDoc(redo(doc));
          return;
        }
        if (key.ctrl && input === "z") {
          setAnchor(null);
          setDoc(undo(doc));
          return;
        }
        if (key.escape) {
          setFocus("tree");
          setAnchor(null);
          return;
        }
        const eatSel = (): Doc => {
          if (!anchor || cmpPos(anchor, { row: doc.row, col: doc.col }) === 0) return doc;
          setAnchor(null);
          return deleteRange(doc, anchor, { row: doc.row, col: doc.col });
        };
        if (key.tab) {
          setDoc(insert(eatSel(), "  "));
          return;
        }
        if (key.return) {
          setDoc(newline(eatSel()));
          return;
        }
        // Linux manda Backspace como 0x7f; Ink lo etiqueta `delete` (el de adelante es CSI 3~ / ctrl+d).
        if (key.backspace || key.delete) {
          if (anchor && cmpPos(anchor, { row: doc.row, col: doc.col }) !== 0) {
            setDoc(eatSel());
            return;
          }
          setDoc(backspace(doc));
          return;
        }
        if (key.ctrl && input === "d") {
          setDoc(delChar(doc));
          return;
        }
        const arrow =
          key.leftArrow ? "l" : key.rightArrow ? "r" : key.upArrow ? "u" : key.downArrow ? "d" : key.home ? "home" : key.end ? "end" : null;
        if (arrow) {
          if (key.shift) {
            if (!anchor) setAnchor({ row: doc.row, col: doc.col });
          } else setAnchor(null);
          setDoc(move(doc, arrow));
          return;
        }
        if (key.pageDown) {
          setPreviewOff((o) => o + codeVis);
          return;
        }
        if (key.pageUp) {
          setPreviewOff((o) => Math.max(0, o - codeVis));
          return;
        }
        if (key.ctrl || key.meta) return;
        if (input) setDoc(insert(eatSel(), input));
        return;
      }

      if (key.tab) {
        applyUiMode(nextUiMode(uiMode));
        return;
      }
      if (key.escape) {
        setFocus("tree");
        return;
      }
      if (key.upArrow || input === "k") {
        setCursor((n) => Math.max(0, n - 1));
        return;
      }
      if (key.downArrow || input === "j") {
        setCursor((n) => Math.min(tree.length - 1, n + 1));
        return;
      }
      if (key.pageDown || input === "d") {
        setPreviewOff((o) => o + codeVis);
        return;
      }
      if (key.pageUp || input === "u") {
        setPreviewOff((o) => Math.max(0, o - codeVis));
        return;
      }
      if (key.return) {
        openCurrent();
        return;
      }
    },
    { isActive: !away },
  );

  const openPromptEditor = async (): Promise<void> => {
    if (!process.env.EDITOR?.trim()) {
      push({ kind: "sys", text: "definí EDITOR (ej. export EDITOR=nvim)" });
      return;
    }
    let text: string | null = null;
    let failed = false;
    try {
      await suspendTty(async () => {
        text = await composeInEditor(value);
      });
    } catch (err) {
      failed = true;
      push({ kind: "sys", text: err instanceof Error ? err.message : String(err) });
    }
    setValue("");
    if (failed) return;
    if (text) await runJob(text);
    else push({ kind: "sys", text: "editor vacío o cancelado" });
  };

  const runJob = async (requirement: string): Promise<void> => {
    if (!(await persistIfDirty())) return;
    beforeRef.current = new Map();
    setPending([]);
    const expanded = await expandAtRefs(requirement, session.workspaceDir, session.contextManager);

    // Build automatic context from workspace
    const explicitRefs = findAtRefs(requirement);
    const contextResult = await session.contextManager.buildContext(requirement, explicitRefs);
    const contextBlock = formatContextForPrompt(contextResult);

    const finalRequirement = contextBlock ? expanded + contextBlock : expanded;

    const payload: OrchestrateRequest = {
      requirement: finalRequirement,
      workspaceDir: session.workspaceDir,
      permissions: session.permissions,
      mode: session.mode,
    };
    if (session.mode === "chat" && session.history.length) {
      payload.history = session.history.slice(-HISTORY_CAP);
    }
    const ac = new AbortController();
    abortRef.current = ac;
    setBusy(true);
    setRailOpen(true);
    setSteps([]);
    setActor(session.mode === "chat" ? "chat" : "boss");
    setDetail("pensando…");
    push({ kind: "user", text: requirement });

    try {
      await api.orchestrateStream(payload, {
        signal: ac.signal,
        onTrace: (ev: TraceEvent) => {
          setActor(ev.actor === "system" ? "idle" : ev.actor);
          setDetail(ev.detail || ev.event);
          const step = friendlyStep(ev);
          if (step) setSteps((prev) => [...prev.slice(-40), step]);
          const rel = relFromTrace(ev);
          if (!rel) return;
          if (!beforeRef.current.has(rel)) {
            void readOrNull(session.workspaceDir, rel).then((text) => {
              if (!beforeRef.current.has(rel)) beforeRef.current.set(rel, text);
            });
          }
          if (isWriteTrace(ev)) {
            void sleep(120).then(() => pullAiFile(rel));
          }
        },
        onDone: (result) => {
          session.last = result;
          session.turns += 1;
          session.history = [
            ...session.history,
            { role: "user" as const, content: requirement },
            { role: "assistant" as const, content: result.summary },
          ].slice(-HISTORY_CAP);
          const extra = result.changes.map((c) => `${c.action} ${c.file}`).join("\n");
          push({
            kind: "squad",
            who: session.mode === "chat" ? "chat" : "squad",
            text: [result.summary, extra, result.error].filter(Boolean).join("\n") || result.status,
          });
          setStamp((n) => n + 1);
          void (async () => {
            const items: PendingChange[] = [];
            for (const c of result.changes) {
              const after = await readOrNull(session.workspaceDir, c.file);
              if (after === null) continue;
              const before = c.previous !== undefined ? c.previous : (beforeRef.current.get(c.file) ?? null);
              if (before === after) continue;
              items.push({ rel: c.file, before, after, action: c.action });
            }
            beforeRef.current = new Map();
            if (items.length) {
              showPending(items, 0);
              push({ kind: "sys", text: `${items.length} cambio(s) · y acepta · n revierte · a todos · r todos` });
            }
          })();
        },
      });
    } catch (err) {
      const aborted = err instanceof Error && err.name === "AbortError";
      push({ kind: "sys", text: aborted ? "turno cancelado" : err instanceof Error ? err.message : String(err) });
    } finally {
      abortRef.current = null;
      setBusy(false);
      setActor("idle");
      setDetail("");
    }
  };

  const onSubmit = async (raw: string): Promise<void> => {
    const line = raw.trim();
    setValue("");
    if (!line || busy || quitAsk || uiMode === "editor") return;
    if (pending.length) {
      push({ kind: "sys", text: "primero y/n los cambios de la IA" });
      return;
    }

    if (connectMode) {
      setConnectMode(false);
      if (!line) return;
      try {
        const saved = await api.putKey("deepseek", { apiKey: line });
        await refreshSession(ctx);
        setStamp((n) => n + 1);
        push({ kind: "sys", text: `key ${saved.id} → ${saved.apiKeyMasked}` });
      } catch (err) {
        push({ kind: "sys", text: err instanceof Error ? err.message : String(err) });
      }
      return;
    }

    if (line.startsWith("/")) {
      const parsed = parseSlash(line);
      if (parsed?.name === "exit") {
        setQuitAsk(true);
        return;
      }
      if (parsed?.name === "connect") {
        setConnectMode(true);
        push({ kind: "sys", text: "pega la API key de deepseek (no se muestra)" });
        return;
      }
      if (parsed?.name === "mode") {
        const next = parsed.args ? parseUiMode(parsed.args) : nextUiMode(uiMode);
        if (next) applyUiMode(next);
        else push({ kind: "sys", text: "uso: /mode squad|chat|editor" });
        return;
      }
      if (parsed?.name === "editor") {
        if (busy) return;
        await openPromptEditor();
        return;
      }
      const outcome = await handleSlash(ctx, line);
      setStamp((n) => n + 1);
      if (session.mode === "chat" || session.mode === "squad") setUiMode(session.mode);
      if (typeof outcome === "string" && outcome.trim()) await runJob(outcome);
      return;
    }

    await runJob(line);
  };

  const health = session.health;
  const empty = lines.length === 0;
  const split = uiMode !== "editor" && Boolean(openRel);
  const maxChat = Math.max(3, split ? Math.floor((rows - 14) / 2) : rows - 10);
  const fileVis = split ? Math.max(5, Math.floor((rows - 14) / 2)) : codeVis;
  const visible = lines.slice(-maxChat);
  const visibleSteps = steps.slice(-(Math.max(3, Math.floor((rows - 14) / 2))));
  const treeWindow = tree.slice(treeStart, treeStart + treeVis);
  const reviewing = pending[reviewIdx] ?? null;
  const diffRows = reviewing && openRel === reviewing.rel ? lineDiff(reviewing.before ?? "", reviewing.after) : null;
  const viewLines = diffRows
    ? diffRows.slice(previewOff, previewOff + fileVis)
    : doc
      ? doc.lines.slice(previewOff, previewOff + fileVis).map((t) => ({ k: " " as const, t }))
      : [];
  const previewTotal = diffRows ? diffRows.length : (doc?.lines.length ?? 0);
  const user = os.userInfo().username;
  const model = (session.config?.settings.workerModel ?? "—").slice(0, 16);
  const project = path.basename(session.workspaceDir);
  void stamp;

  const accent = modeColor(uiMode);
  const ramPct = sys.ramTotalGb > 0 ? (sys.ramUsedGb / sys.ramTotalGb) * 100 : 0;

  return (
    <Box flexDirection="column" width={columns} height={rows} backgroundColor={C.bg}>
      {/* Fondo opaco: Ink pinta cada celda con SGR 48, no el default transparente del TTY. */}
      <Box paddingX={1} justifyContent="space-between" backgroundColor={C.bg}>
        <Text color={C.emerald}>
          [USER: {user}]  [SESSION: {healthLabel(health?.ok)}]  [MODEL: {model}]
        </Text>
        <Text color={C.cyan}>
          [THREADS: {sys.threads}]  {clock}
        </Text>
      </Box>

      <Box flexGrow={1} flexDirection="row" paddingX={1} overflow="hidden" backgroundColor={C.bg}>
        {/* Explorador: árbol del workspace actual. Navegar solo en modo editor. */}
        <Box width={explorerW} flexDirection="column" borderStyle="single" borderColor={C.emerald} paddingX={1} overflow="hidden" backgroundColor={C.panel}>
          <Text color={C.emerald} bold>
            EXPLORER
          </Text>
          <Text dimColor wrap="truncate">
            {project}
          </Text>
          <Box flexGrow={1} flexDirection="column" marginTop={1} overflow="hidden" backgroundColor={C.panel}>
            {treeWindow.map((ent, i) => {
              const on = treeStart + i === cursor && uiMode === "editor";
              const mark = ent.dir ? (expanded.has(ent.rel) ? "▾ " : "▸ ") : "  ";
              return (
                <Text key={ent.rel} color={on ? C.cyan : ent.dir ? C.emerald : "white"} wrap="truncate" inverse={on && focus === "tree"}>
                  {"  ".repeat(ent.depth)}
                  {mark}
                  {ent.name}
                  {ent.dir ? "/" : ""}
                </Text>
              );
            })}
          </Box>
        </Box>

        <Box width={centerW} flexDirection="column" paddingX={1} overflow="hidden" backgroundColor={C.bg}>
          {uiMode !== "editor" ? (
            empty && !openRel ? (
              <Box flexGrow={1} flexDirection="column" alignItems="center" justifyContent="center" backgroundColor={C.bg}>
                <Text color={C.cyan}>squad</Text>
                <Text dimColor>{uiMode === "chat" ? "un modelo" : "jefe / worker / QA"}</Text>
              </Box>
            ) : (
              <Box flexGrow={1} flexDirection="column" overflow="hidden" backgroundColor={C.bg}>
                {visible.map((line, i) => (
                  <Text key={`${i}-${line.kind}`} color={colorFor(line.kind)} wrap="wrap">
                    {line.kind === "user" ? "tú  " : line.kind === "squad" ? `${line.who ?? "squad"}  ` : "    "}
                    {line.text}
                  </Text>
                ))}
              </Box>
            )
          ) : null}
          {uiMode === "editor" || openRel ? (
            <Box flexGrow={1} flexDirection="column" overflow="hidden" backgroundColor={C.bg}>
              <Text color={reviewing ? C.amber : C.cyan} wrap="truncate">
                {reviewing
                  ? `PENDIENTE ${reviewIdx + 1}/${pending.length}  ${openRel}  y acepta  n revierte`
                  : openRel
                    ? `~/${project}/${openRel}${doc?.dirty ? " *" : ""}`
                    : "click o enter abre · escribí en el centro"}
              </Text>
              <Box flexGrow={1} flexDirection="column" borderStyle="round" borderColor={reviewing ? C.amber : focus === "buf" ? C.cyan : C.muted} paddingX={1} marginTop={1} overflow="hidden" backgroundColor={C.panel}>
                {viewLines.length === 0 ? (
                  <Text dimColor>j/k o click en el árbol</Text>
                ) : (
                  viewLines.map((ln, i) => {
                    const text = ln.t;
                    const absRow = previewOff + i;
                    const interactive = uiMode === "editor" && focus === "buf" && !diffRows;
                    const caretOn = Boolean(interactive && doc && absRow === doc.row);
                    const col = caretOn && doc ? Math.min(doc.col, text.length) : 0;
                    const ch = text[col] ?? " ";
                    let selFrom: number | null = null;
                    let selTo: number | null = null;
                    if (interactive && doc && anchor && cmpPos(anchor, { row: doc.row, col: doc.col }) !== 0) {
                      const [s, e] = ordered(anchor, { row: doc.row, col: doc.col });
                      if (absRow >= s.row && absRow <= e.row) {
                        selFrom = absRow === s.row ? s.col : 0;
                        selTo = absRow === e.row ? e.col : text.length;
                      }
                    }
                    const color = ln.k === "+" ? C.emerald : ln.k === "-" ? C.rose : tintLine(text);
                    const mark = diffRows ? `${ln.k === " " ? " " : ln.k} ` : "";
                    return (
                      <Text key={i} color={color} wrap="truncate">
                        <Text color={C.muted}>
                          {String(absRow + 1).padStart(4, " ")} {mark}
                        </Text>
                        {selFrom !== null && selTo !== null ? (
                          <Text>
                            {text.slice(0, selFrom)}
                            <Text inverse>{text.slice(selFrom, selTo) || " "}</Text>
                            {text.slice(selTo)}
                          </Text>
                        ) : caretOn ? (
                          <Text>
                            {text.slice(0, col)}
                            <Text inverse>{ch}</Text>
                            {text.slice(col + 1)}
                          </Text>
                        ) : (
                          text || " "
                        )}
                      </Text>
                    );
                  })
                )}
              </Box>
              {openRel ? (
                <Text dimColor>
                  {reviewing
                    ? "y este  n este  a todos  r todos"
                    : `${doc ? `${(doc.row ?? 0) + 1}:${(doc.col ?? 0) + 1}` : "—"} · ${previewOff + 1}–${previewOff + viewLines.length}/${previewTotal}`}
                </Text>
              ) : null}
            </Box>
          ) : null}
        </Box>

        {railOpen ? (
          /* CPU/RAM reales + pasos del modelo mientras hay job. */
          <Box width={railW} flexDirection="column" borderStyle="single" borderColor={busy ? C.amber : C.emerald} paddingX={1} overflow="hidden" backgroundColor={C.panel}>
            <Text color={C.emerald} bold>
              SYSTEM
            </Text>
            <Text color={C.cyan}>
              CPU  {bar(sys.cpu, 10)} {sys.cpu.toFixed(0)}%
            </Text>
            <Text color={C.emerald}>
              RAM  {bar(ramPct, 10)} {sys.ramUsedGb.toFixed(1)}G
            </Text>
            <Text color={busy ? C.amber : C.muted}>
              {spin} {busy ? `${actor === "idle" ? session.mode : actor}` : "idle"}
            </Text>
            {busy ? (
              <Text color={C.amber} wrap="truncate">
                {(detail || "pensando…").slice(0, 22)}
              </Text>
            ) : (
              <Text dimColor>ctrl+p oculta</Text>
            )}
            <Box flexGrow={1} flexDirection="column" marginTop={1} overflow="hidden" backgroundColor={C.panel}>
              {visibleSteps.map((s, i) => (
                <Text key={`${i}-${s.label}`} color={actorColor(s.actor)} wrap="truncate">
                  {s.label}
                  {s.detail ? ` ${s.detail}` : ""}
                </Text>
              ))}
            </Box>
          </Box>
        ) : null}
      </Box>

      {quitAsk ? (
        <Box paddingX={2} marginBottom={1} backgroundColor={C.bg}>
          <Box borderStyle="round" borderColor={C.cyan} paddingX={2} paddingY={1} width={Math.min(48, columns - 4)} backgroundColor={C.panel}>
            <Box flexDirection="column" backgroundColor={C.panel}>
              <Text>¿Cerrar squad?</Text>
              <Text dimColor>Esto termina npm run dev.</Text>
              <Text>{" s Sí    n No"}</Text>
            </Box>
          </Box>
        </Box>
      ) : (
        <Box paddingX={1} marginBottom={1} flexDirection="column" backgroundColor={C.bg}>
          <Box borderStyle="round" borderColor={busy ? C.amber : accent} paddingX={1} backgroundColor={C.panel}>
            <Text color={accent} bold>
              {uiMode.toUpperCase()}
            </Text>
            {/* El modo vive en el prompt, no en una línea extra. */}
            <Text color={accent}> ▌ </Text>
            {away ? (
              <Text dimColor>en $EDITOR — guardá y salí</Text>
            ) : pending.length ? (
              <Text color={C.amber}>y acepta · n revierte · a todos · r todos</Text>
            ) : uiMode === "editor" ? (
              <Text dimColor>
                {focus === "buf"
                  ? "arrastrá para sombrear · ctrl+c copia · ctrl+p pega"
                  : "j/k árbol · enter/click abre · rueda · tab modo"}
              </Text>
            ) : connectMode ? (
              <TextInput value={value} onChange={setValue} onSubmit={(v) => void onSubmit(v)} mask="*" placeholder="sk-…" />
            ) : (
              <TextInput
                value={value}
                onChange={(v) => setValue(v.replace(/\t/g, ""))}
                onSubmit={(v) => void onSubmit(v)}
                placeholder={busy ? "Ctrl+C cancela" : "Enter command…  /help"}
              />
            )}
          </Box>
          <Text dimColor>
            {busy ? "ctrl+c cancela · ctrl+p proc" : "[TAB] Mode  [CTRL+P] Proc  [/help]  v" + version}
          </Text>
        </Box>
      )}
    </Box>
  );
}
