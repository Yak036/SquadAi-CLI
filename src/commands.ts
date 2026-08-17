/**
 * Estado de la sesión REPL + handlers de slash commands.
 * El backend guarda keys/settings; aquí solo overlays (workspace, permisos, último job).
 */
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import os from "node:os";
import type { SquadApi } from "./api.js";
import { ApiError } from "./api.js";
import { ContextManager, formatContextForPrompt } from "./context.js";
import { extractPublicAPI } from "./indexer.js";
import { expandTilde, findAtRefs, parseAgentMode, parseSlash, resolveWorkspace } from "./parse.js";
import type { AgentMode, AgentPermissions, ChatTurn, ConfigPublic, HealthResponse, OrchestrateResponse } from "./types.js";
import {
  renderHelp,
  renderStatus,
  resultToMarkdown,
  theme,
} from "./ui.js";

const SECRET_NAME = /^(?:\.env(?:\..*)?|credentials\.json|.*\.pem)$/i;
const MAX_AT_FILE_BYTES = 80_000;

export type Session = {
  apiUrl: string;
  workspaceDir: string;
  permissions: AgentPermissions;
  config: ConfigPublic | null;
  health: HealthResponse | null;
  last?: OrchestrateResponse;
  turns: number;
  /** chat = un modelo; squad = jefe/worker/QA. Ambos pueden escribir archivos. */
  mode: AgentMode;
  history: ChatTurn[];
  contextManager: ContextManager;
};

export type Ctx = {
  api: SquadApi;
  session: Session;
  askSecret: (prompt: string) => Promise<string>;
  print: (text: string) => void;
};

export function defaultPermissions(): AgentPermissions {
  return { writeFiles: true, createDirs: true, runCommands: false };
}

export async function refreshSession(ctx: Ctx): Promise<void> {
  try {
    ctx.session.health = await ctx.api.health();
    ctx.session.config = await ctx.api.getConfig();
  } catch (err) {
    ctx.session.health = null;
    ctx.session.config = null;
    ctx.print(theme.err(err instanceof Error ? err.message : String(err)));
  }
}

export function printStatus(ctx: Ctx): void {
  ctx.print(
    renderStatus({
      apiUrl: ctx.session.apiUrl,
      health: ctx.session.health,
      config: ctx.session.config,
      workspaceDir: ctx.session.workspaceDir,
      mode: ctx.session.mode,
    }),
  );
}

/**
 * Inyecta @ruta como bloque de código en el prompt (patrón OpenCode).
 * Bloquea secretos; si el archivo no existe, compresión inteligente para grandes.
 * Usa caché de archivos para evitar re-leer.
 */
export async function expandAtRefs(
  text: string,
  workspaceDir: string,
  contextManager?: ContextManager,
): Promise<string> {
  const refs = findAtRefs(text);
  if (!refs.length) return text;

  let out = text;
  for (const ref of refs) {
    const base = path.basename(ref);
    if (SECRET_NAME.test(base)) {
      out += `\n\n[omitido ${ref}: archivo protegido]\n`;
      continue;
    }
    const abs = path.resolve(workspaceDir, expandTilde(ref));
    const rel = path.relative(workspaceDir, abs);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      out += `\n\n[omitido ${ref}: fuera del workspace]\n`;
      continue;
    }
    try {
      // Intentar caché primero
      let body: string | null = null;
      if (contextManager) {
        body = await contextManager.getCachedFile(abs);
      }

      if (body === null) {
        const buf = await fs.readFile(abs);
        if (buf.byteLength > MAX_AT_FILE_BYTES) {
          // Compresión inteligente: extraer API pública en lugar de omitir
          const compressed = await extractPublicAPI(abs);
          if (compressed) {
            out += `\n\n--- ${ref} (resumido: API pública) ---\n${compressed}\n--- fin ${ref} ---\n`;
          } else {
            out += `\n\n[omitido ${ref}: demasiado grande y sin exports detectables]\n`;
          }
          continue;
        }
        body = buf.toString("utf8");
        // Guardar en caché
        if (contextManager) {
          contextManager.setCachedFile(abs, body);
        }
      }

      out += `\n\n--- ${ref} ---\n${body}\n--- fin ${ref} ---\n`;
    } catch {
      // ponytail: el back igual lista el árbol; no abortamos el prompt por un @ fallido
    }
  }
  return out;
}

/**
 * Abre $EDITOR con un temp. Al guardar y salir, el texto vuelve como prompt.
 * La TUI tiene que pausar Ink y salir del buffer alterno ANTES de llamar esto.
 */
export async function composeInEditor(seed = ""): Promise<string | null> {
  const editor = process.env.EDITOR?.trim();
  if (!editor) return null;

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "squad-"));
  const file = path.join(dir, "prompt.md");
  await fs.writeFile(file, seed, "utf8");

  const parts = editor.split(/\s+/).filter(Boolean);
  const cmd = parts[0] ?? editor;
  const args = [...parts.slice(1), file];

  const code = await new Promise<number>((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: "inherit" });
    child.on("exit", (c) => resolve(c ?? 1));
    child.on("error", reject);
  });
  if (code !== 0) return null;
  const text = (await fs.readFile(file, "utf8")).trim();
  return text || null;
}

/** Abre un archivo del workspace en $EDITOR. Misma regla: la TUI tiene que pausarse. */
export async function openFileInEditor(abs: string): Promise<void> {
  const editor = process.env.EDITOR?.trim();
  if (!editor) throw new Error("definí EDITOR (ej. export EDITOR=nvim)");
  const parts = editor.split(/\s+/).filter(Boolean);
  const cmd = parts[0] ?? editor;
  const args = [...parts.slice(1), abs];
  const code = await new Promise<number>((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: "inherit" });
    child.on("exit", (c) => resolve(c ?? 1));
    child.on("error", reject);
  });
  if (code !== 0) throw new Error("el editor salió con error");
}

function parseOnOff(raw: string): boolean | null {
  const v = raw.toLowerCase();
  if (["on", "true", "1", "si", "sí"].includes(v)) return true;
  if (["off", "false", "0", "no"].includes(v)) return false;
  return null;
}

/**
 * Ejecuta un slash command. Devuelve:
 *  - "exit" para cerrar el REPL
 *  - string para mandarlo como prompt (p.ej. /editor)
 *  - null si ya se resolvió (status, help, …)
 */
export async function handleSlash(ctx: Ctx, line: string): Promise<"exit" | string | null> {
  const parsed = parseSlash(line);
  if (!parsed) return line;

  const { name, args } = parsed;
  const s = ctx.session;

  switch (name) {
    case "help":
      ctx.print(renderHelp());
      return null;

    case "exit":
      return "exit";

    case "status":
      await refreshSession(ctx);
      printStatus(ctx);
      ctx.print(
        `  ${theme.sys("permisos")}  write=${s.permissions.writeFiles}  dirs=${s.permissions.createDirs}  cmds=${s.permissions.runCommands}\n`,
      );
      return null;

    case "workspace": {
      if (!args) {
        ctx.print(`  workspace actual: ${s.workspaceDir}\n`);
        return null;
      }
      const dir = resolveWorkspace(args);
      s.workspaceDir = dir;
      try {
        await ctx.api.putConfig({ settings: { workspaceDir: dir } });
        await refreshSession(ctx);
      } catch (err) {
        ctx.print(theme.err(asMsg(err)));
      }
      ctx.print(`  workspace → ${dir}\n`);
      return null;
    }

    case "models": {
      const parts = args.split(/\s+/).filter(Boolean);
      if (!parts.length) {
        const m = s.config?.settings;
        ctx.print(`  boss ${m?.bossModel ?? "?"}  worker ${m?.workerModel ?? "?"}\n`);
        ctx.print(`  uso: /models <boss> [worker]\n`);
        return null;
      }
      const bossModel = parts[0] ?? "";
      try {
        if (parts[1]) {
          await ctx.api.putConfig({ settings: { bossModel, workerModel: parts[1] } });
        } else {
          await ctx.api.putConfig({ settings: { bossModel } });
        }
        await refreshSession(ctx);
        const m = ctx.session.config?.settings;
        ctx.print(`  modelos → boss ${m?.bossModel}  worker ${m?.workerModel}\n`);
      } catch (err) {
        ctx.print(theme.err(asMsg(err)));
      }
      return null;
    }

    case "retries": {
      const n = Number(args);
      if (!Number.isFinite(n)) {
        ctx.print(`  retries actual: ${s.config?.settings.maxRetries ?? "?"}\n`);
        return null;
      }
      try {
        await ctx.api.putConfig({ settings: { maxRetries: Math.trunc(n) } });
        await refreshSession(ctx);
        ctx.print(`  retries → ${ctx.session.config?.settings.maxRetries}\n`);
      } catch (err) {
        ctx.print(theme.err(asMsg(err)));
      }
      return null;
    }

    case "keys":
      await refreshSession(ctx);
      for (const k of ctx.session.config?.keys ?? []) {
        const flag = k.apiKeySet ? theme.ok("set") : theme.err("vacía");
        ctx.print(`  ${k.id.padEnd(12)} ${flag}  ${theme.sys(k.apiKeyMasked)}  ${theme.sys(k.baseUrl)}\n`);
      }
      ctx.print(`  ${theme.sys("para pegar una key: /connect [id]")}\n`);
      return null;

    case "connect": {
      const id = (args.split(/\s+/)[0] || "deepseek").toLowerCase();
      const apiKey = await ctx.askSecret(`API key (${id}): `);
      if (!apiKey.trim()) {
        ctx.print(theme.sys("cancelado\n"));
        return null;
      }
      try {
        const saved = await ctx.api.putKey(id, { apiKey: apiKey.trim() });
        await refreshSession(ctx);
        ctx.print(`  ${saved.id} → ${theme.ok(saved.apiKeyMasked)}\n`);
      } catch (err) {
        ctx.print(theme.err(asMsg(err)));
      }
      return null;
    }

    case "permissions": {
      const [which, flag] = args.split(/\s+/);
      if (!which) {
        ctx.print(
          `  write=${s.permissions.writeFiles}  dirs=${s.permissions.createDirs}  cmds=${s.permissions.runCommands}\n`,
        );
        return null;
      }
      const on = parseOnOff(flag ?? "");
      if (on === null) {
        ctx.print("  uso: /permissions write|dirs|cmds on|off\n");
        return null;
      }
      if (which === "write") s.permissions.writeFiles = on;
      else if (which === "dirs") s.permissions.createDirs = on;
      else if (which === "cmds") s.permissions.runCommands = on;
      else {
        ctx.print("  uso: /permissions write|dirs|cmds on|off\n");
        return null;
      }
      ctx.print(
        `  permisos → write=${s.permissions.writeFiles}  dirs=${s.permissions.createDirs}  cmds=${s.permissions.runCommands}\n`,
      );
      return null;
    }

    case "new":
      delete s.last;
      s.turns = 0;
      s.history = [];
      ctx.print(theme.sys("  sesión local limpia\n"));
      return null;

    case "mode": {
      if (!args) {
        ctx.print(`  modo actual: ${s.mode}  (tab o /mode squad|chat)\n`);
        return null;
      }
      const next = parseAgentMode(args);
      if (!next) {
        ctx.print("  uso: /mode squad|chat\n");
        return null;
      }
      s.mode = next;
      ctx.print(
        next === "squad"
          ? "  modo → squad (jefe / worker / QA). Pedí un cambio de código y orquesta.\n"
          : "  modo → chat (un modelo). Preguntá o pedí editar archivos.\n",
      );
      return null;
    }

    case "export": {
      if (!s.last) {
        ctx.print(theme.sys("  no hay job todavía\n"));
        return null;
      }
      const md = resultToMarkdown(s.last);
      if (!args) {
        ctx.print(md);
        return null;
      }
      const file = path.resolve(expandTilde(args));
      await fs.writeFile(file, md, "utf8");
      ctx.print(`  exportado → ${file}\n`);
      return null;
    }

    case "editor": {
      if (!process.env.EDITOR) {
        ctx.print(theme.err("  define EDITOR (ej. export EDITOR=nvim)\n"));
        return null;
      }
      const text = await composeInEditor();
      return text;
    }

    default:
      ctx.print(theme.err(`  comando desconocido: /${name}  (${theme.sys("prueba /help")})\n`));
      return null;
  }
}

function asMsg(err: unknown): string {
  if (err instanceof ApiError) return `  ${err.message}\n`;
  if (err instanceof Error) return `  ${err.message}\n`;
  return `  ${String(err)}\n`;
}
