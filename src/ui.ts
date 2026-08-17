/**
 * Pintado tipo OpenCode/Claude Code: header de sesión, timeline del job, banner de cierre.
 */
import chalk from "chalk";
import type { ConfigPublic, HealthResponse, OrchestrateResponse, TraceActor, TraceEvent } from "./types.js";

const boss = chalk.hex("#c084fc");
const worker = chalk.hex("#fbbf24");
const qa = chalk.hex("#34d399");
const chat = chalk.hex("#22d3ee");
const sys = chalk.hex("#6b7280");
const ok = chalk.hex("#4ade80");
const err = chalk.hex("#f87171");
const accent = chalk.hex("#e5e7eb");
const cyan = chalk.hex("#22d3ee");

export const theme = { boss, worker, qa, chat, sys, ok, err, accent, cyan, dim: sys };

const ACTOR_COLOR: Record<TraceActor, (s: string) => string> = {
  boss,
  worker,
  qa,
  chat,
  system: sys,
};

function rule(title: string): string {
  const cols = Math.max(40, Math.min(process.stdout.columns ?? 72, 88));
  const pad = Math.max(1, cols - title.length - 4);
  return sys(`── ${title} ${"─".repeat(pad)}`);
}

export function renderBanner(version: string): string {
  return [
    "",
    `  ${accent("squad")}  ${sys("v" + version)}  ${sys("· multi-agente local")}`,
    `  ${sys("texto libre = tarea")}   ${cyan("/help")} ${sys("comandos")}   ${cyan("/exit")} ${sys("salir")}`,
    "",
  ].join("\n");
}

export function renderStatus(opts: {
  apiUrl: string;
  health: HealthResponse | null;
  config: ConfigPublic | null;
  workspaceDir: string;
  mode?: string;
  error?: string;
}): string {
  const lines: string[] = [];
  if (opts.error) {
    lines.push(`  ${err("backend")}   ${opts.error}`);
  } else if (opts.health) {
    const api = opts.health.ok ? ok("ok") : err("down");
    const key = opts.health.deepseek ? ok("key lista") : err("falta /connect");
    lines.push(`  ${sys("backend")}   ${opts.apiUrl}  ${api}  ${key}`);
  }

  lines.push(`  ${sys("workspace")} ${accent(opts.workspaceDir || "(sin carpeta)")}`);
  if (opts.mode) {
    lines.push(`  ${sys("modo")}      ${accent(opts.mode)}  ${sys("tab o /mode squad|chat|editor")}`);
  }

  if (opts.config) {
    const s = opts.config.settings;
    lines.push(`  ${sys("modelos")}   boss ${boss(s.bossModel)}  worker ${worker(s.workerModel)}  retries ${s.maxRetries}`);
    const keys = opts.config.keys
      .map((k) => `${k.id} ${k.apiKeySet ? sys(k.apiKeyMasked) : err("vacía")}`)
      .join("  ");
    if (keys) lines.push(`  ${sys("keys")}      ${keys}`);
  }
  lines.push("");
  return lines.join("\n");
}

export function renderHelp(): string {
  const rows: Array<[string, string]> = [
    ["/help", "esta lista"],
    ["/status", "backend, workspace, modelos, keys"],
    ["/workspace <dir>", "carpeta donde el squad escribe"],
    ["/models <boss> <worker>", "modelos DeepSeek (uno o dos)"],
    ["/connect [id]", "pega una API key (oculta). default: deepseek"],
    ["/keys", "lista keys (enmascaradas)"],
    ["/retries <n>", "reintentos de QA (1-5)"],
    ["/permissions [write|dirs|cmds] [on|off]", "permisos del job"],
    ["/mode squad|chat|editor", "chat / squad / editor (click, rueda, ctrl+s). Tab cicla"],
    ["/new", "limpia el historial local de esta sesión"],
    ["/export [archivo]", "vuelca el último job a markdown"],
    ["/editor", "abre $EDITOR para un prompt largo (pausa la TUI)"],
    ["/exit", "salir  (aliases: /quit /q)"],
    ["@ruta/archivo.ts", "inyecta el archivo en el prompt"],
  ];
  const body = rows.map(([cmd, desc]) => `  ${cyan(cmd.padEnd(42))} ${sys(desc)}`).join("\n");
  return `\n${rule("comandos")}\n${body}\n${sys("  Texto libre = mensaje. Tab cambia modo. Ambos modos pueden editar archivos.")}\n`;
}

export function renderUsage(): string {
  return `squad — REPL del orquestador SquadAi

Uso:
  squad                      REPL en el directorio actual
  squad <dir>                REPL en esa carpeta
  squad -p "crea un hello"   una sola tarea y sale
  squad <dir> -p "..."       una tarea en esa carpeta

Flags:
  -a, --api <url>     backend (default http://localhost:4000)
  -p, --prompt <txt>  one-shot
  -h, --help
  -v, --version
`;
}

export function renderTrace(events: TraceEvent[]): string {
  if (!events.length) return "";
  const lines = events.map((e) => {
    const color = ACTOR_COLOR[e.actor] ?? sys;
    const tag = color(e.actor.padEnd(6));
    const ev = accent(e.event);
    const detail = e.detail ? sys("  " + e.detail) : "";
    return `  ${tag}  ${ev}${detail}`;
  });
  return lines.join("\n");
}

export function renderResult(result: OrchestrateResponse): string {
  const banner =
    result.status === "success"
      ? ok("TAREA FINALIZADA  success")
      : result.status === "partial"
        ? worker("TAREA FINALIZADA  partial")
        : result.status === "cancelled"
          ? worker("TAREA CANCELADA")
          : err("TAREA FINALIZADA  failed");

  const chunks: string[] = ["", rule(banner)];
  if (result.trace.length) chunks.push(renderTrace(result.trace), "");
  if (result.summary) chunks.push(`  ${accent(result.summary)}`);
  if (result.error) chunks.push(`  ${err(result.error)}`);
  if (result.changes.length) {
    chunks.push("");
    for (const c of result.changes) {
      const action = c.action === "created" ? ok("created ") : worker("modified");
      chunks.push(`  ${action}  ${accent(c.file)}`);
      chunks.push(`           ${sys(c.path)}`);
    }
  }
  chunks.push(sys("─".repeat(Math.min(process.stdout.columns ?? 56, 56))), "");
  return chunks.join("\n");
}

export function resultToMarkdown(result: OrchestrateResponse): string {
  const lines = [
    `# squad job — ${result.status}`,
    "",
    result.summary,
    "",
    "## trace",
    ...result.trace.map((e) => `- **${e.actor}** ${e.event}${e.detail ? `: ${e.detail}` : ""}`),
    "",
    "## changes",
    ...result.changes.map((c) => `- ${c.action} \`${c.file}\` (${c.path})`),
  ];
  if (result.error) lines.push("", "## error", result.error);
  return lines.join("\n") + "\n";
}
