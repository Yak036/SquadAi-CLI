/**
 * Parseo de slash commands, paths y flags.
 * OpenCode/Claude: "/" dispara comando; el resto es el prompt al agente.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type SlashCommand = {
  name: string;
  args: string;
};

/** Aliases al estilo OpenCode (/q, /quit, /clear). */
const ALIASES: Record<string, string> = {
  q: "exit",
  quit: "exit",
  clear: "new",
  doctor: "status",
  summarize: "help",
  resume: "status",
  agent: "mode",
  modelo: "mode",
};

export function parseSlash(line: string): SlashCommand | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("/")) return null;
  const body = trimmed.slice(1).trim();
  if (!body) return { name: "help", args: "" };
  const space = body.search(/\s/);
  const raw = (space === -1 ? body : body.slice(0, space)).toLowerCase();
  const args = space === -1 ? "" : body.slice(space).trim();
  return { name: ALIASES[raw] ?? raw, args };
}

export function parseAgentMode(raw: string): "squad" | "chat" | null {
  const v = raw.trim().toLowerCase();
  if (v === "squad" || v === "team" || v === "agente") return "squad";
  if (v === "chat" || v === "modelo" || v === "ask") return "chat";
  return null;
}

export type UiMode = "squad" | "chat" | "editor";

export function parseUiMode(raw: string): UiMode | null {
  const agent = parseAgentMode(raw);
  if (agent) return agent;
  const v = raw.trim().toLowerCase();
  if (v === "editor" || v === "edit" || v === "code") return "editor";
  return null;
}

export function nextUiMode(cur: UiMode): UiMode {
  if (cur === "chat") return "squad";
  if (cur === "squad") return "editor";
  return "chat";
}

export function expandTilde(input: string): string {
  const trimmed = input.trim();
  if (trimmed === "~") return os.homedir();
  if (trimmed.startsWith("~/")) return path.join(os.homedir(), trimmed.slice(2));
  return trimmed;
}

export function resolveWorkspace(input: string, cwd = process.cwd()): string {
  const expanded = expandTilde(input);
  return path.resolve(cwd, expanded);
}

/**
 * Tokens @ruta (OpenCode) → se expanden leyendo el archivo en otro módulo.
 * Aquí solo extraemos paths; ignoramos emails (foo@bar.com).
 */
export function findAtRefs(text: string): string[] {
  const refs: string[] = [];
  const re = /(^|[\s])@([^\s]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const token = m[2] ?? "";
    if (!token || token.includes("@")) continue;
    refs.push(token);
  }
  return refs;
}

export type CliArgs = {
  apiUrl: string;
  workspaceDir?: string;
  prompt?: string;
  help: boolean;
  version: boolean;
};

/**
 * squad                  → REPL, workspace = cwd
 * squad <dir>            → REPL en esa carpeta
 * squad -p "msg"         → one-shot en cwd
 * squad <dir> -p "msg"   → one-shot en dir
 */
export function parseCliArgs(argv: string[], cwd = process.cwd(), env: NodeJS.ProcessEnv = process.env): CliArgs {
  const apiUrl = (env.SQUAD_API_URL?.trim() || "http://localhost:4000").replace(/\/$/, "");
  const out: CliArgs = { apiUrl, help: false, version: false };
  const rest: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    if (arg === "-h" || arg === "--help") {
      out.help = true;
      continue;
    }
    if (arg === "-v" || arg === "--version") {
      out.version = true;
      continue;
    }
    if (arg === "-a" || arg === "--api") {
      const next = argv[++i];
      if (next) out.apiUrl = next.replace(/\/$/, "");
      continue;
    }
    if (arg === "-p" || arg === "--prompt") {
      const next = argv[++i];
      if (next) out.prompt = next;
      continue;
    }
    if (arg === "--") {
      const joined = argv.slice(i + 1).join(" ").trim();
      if (joined) out.prompt = joined;
      break;
    }
    rest.push(arg);
  }

  const first = rest[0];
  if (first && looksLikeDir(first, cwd)) {
    out.workspaceDir = resolveWorkspace(first, cwd);
    const leftover = rest.slice(1).join(" ").trim();
    if (leftover && !out.prompt) out.prompt = leftover;
  } else if (rest.length && !out.prompt) {
    out.prompt = rest.join(" ").trim();
  }

  return out;
}

function looksLikeDir(token: string, cwd: string): boolean {
  if (token.startsWith("-")) return false;
  const resolved = resolveWorkspace(token, cwd);
  try {
    return fsExistsDir(resolved);
  } catch {
    return token.startsWith("/") || token.startsWith(".") || token.startsWith("~");
  }
}

/** Inyectable en tests; en runtime mira el disco. */
let fsExistsDir: (p: string) => boolean = (p) => {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
};

/** Permite al selfcheck stubbear existsSync sin tocar disco real. */
export function setDirExistsForTests(fn: (p: string) => boolean): void {
  fsExistsDir = fn;
}
