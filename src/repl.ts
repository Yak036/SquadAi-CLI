/**
 * REPL interactivo (OpenCode/Claude Code): prompt, slash commands, spinner mientras el back piensa.
 */
import readline from "node:readline";
import ora from "ora";
import { ApiError, type SquadApi } from "./api.js";
import { ContextManager, formatContextForPrompt } from "./context.js";
import {
  expandAtRefs,
  handleSlash,
  printStatus,
  refreshSession,
  type Ctx,
  type Session,
} from "./commands.js";
import { findAtRefs } from "./parse.js";
import { renderResult, theme } from "./ui.js";
import type { ChatTurn, OrchestrateRequest } from "./types.js";

export async function runRepl(api: SquadApi, session: Session): Promise<void> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    historySize: 200,
  });

  let busy = false;
  let abort: AbortController | null = null;
  let askingQuit = false;

  const ctx: Ctx = {
    api,
    session,
    print: (text) => process.stdout.write(text.endsWith("\n") ? text : text + "\n"),
    askSecret: (prompt) => askSecret(rl, prompt),
  };

  const prompt = () => {
    rl.setPrompt(theme.cyan("❯ "));
    rl.prompt();
  };

  // readline no cierra el proceso; process.on decide cancelar vs preguntar.
  rl.on("SIGINT", () => {
    /* swallow */
  });

  process.on("SIGINT", () => {
    void onProcessSigint();
  });

  async function onProcessSigint(): Promise<void> {
    if (askingQuit) return;
    if (busy && abort) {
      abort.abort();
      ctx.print(theme.sys("\n  cancelado — el proceso sigue vivo\n"));
      return;
    }
    askingQuit = true;
    rl.pause();
    const yes = await confirmQuit();
    askingQuit = false;
    if (yes) {
      ctx.print(theme.sys("  cerrando\n"));
      rl.close();
      process.exit(0);
    }
    ctx.print(theme.sys("  sigue corriendo\n"));
    rl.resume();
    if (!closed) prompt();
  }

  let closed = false;
  rl.on("close", () => {
    closed = true;
  });

  rl.on("line", (raw) => {
    void onLine(raw);
  });

  async function onLine(raw: string): Promise<void> {
    const line = raw.trim();
    if (!line) {
      prompt();
      return;
    }

    try {
      if (line.startsWith("/")) {
        const outcome = await handleSlash(ctx, line);
        if (outcome === "exit") {
          rl.close();
          return;
        }
        if (typeof outcome === "string" && outcome.trim()) {
          await runJob(outcome);
        }
      } else {
        await runJob(line);
      }
    } catch (err) {
      ctx.print(theme.err(err instanceof Error ? err.message : String(err)));
    }
    if (!closed) prompt();
  }

  async function runJob(requirement: string): Promise<void> {
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

    // Compress history if too long
    if (session.mode === "chat" && session.history.length) {
      payload.history = compressHistory(session.history.slice(-12));
    }

    abort = new AbortController();
    busy = true;
    rl.pause();
    const spinner = ora({
      text: session.mode === "chat" ? "chat (un modelo)…" : "orquestando (jefe → worker → QA)…",
      color: "cyan",
      spinner: "dots",
      stream: process.stderr,
    }).start();

    try {
      const result = await api.orchestrate(payload, abort.signal);
      spinner.stop();
      session.last = result;
      session.turns += 1;
      session.history = [
        ...session.history,
        { role: "user" as const, content: requirement },
        { role: "assistant" as const, content: result.summary },
      ].slice(-12);
      process.stdout.write(renderResult(result));
    } catch (err) {
      spinner.stop();
      if (err instanceof Error && err.name === "AbortError") {
        ctx.print(theme.sys("  job cancelado\n"));
        return;
      }
      const msg = err instanceof ApiError ? err.message : err instanceof Error ? err.message : String(err);
      ctx.print(theme.err(`  ${msg}\n`));
    } finally {
      busy = false;
      abort = null;
      rl.resume();
    }
  }

  await refreshSession(ctx);
  printStatus(ctx);
  prompt();

  await new Promise<void>((resolve) => rl.once("close", resolve));
}

/** Caja sí/no. Ctrl+C otra vez = sí (salir). */
function confirmQuit(): Promise<boolean> {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    const stdout = process.stdout;
    stdout.write(`
${theme.sys("┌─ ¿Cerrar squad? ─────────────────┐")}
${theme.sys("│")}  Esto termina ${theme.accent("npm run dev")}.        ${theme.sys("│")}
${theme.sys("│")}                                  ${theme.sys("│")}
${theme.sys("│")}    [${theme.ok("s")}] Sí     [${theme.cyan("n")}] No           ${theme.sys("│")}
${theme.sys("└──────────────────────────────────┘")}
`);
    const wasRaw = stdin.isRaw;
    if (stdin.isTTY) stdin.setRawMode(true);
    stdin.resume();

    const finish = (yes: boolean) => {
      stdin.off("data", onData);
      if (stdin.isTTY) stdin.setRawMode(Boolean(wasRaw));
      resolve(yes);
    };

    const onData = (chunk: string | Buffer) => {
      const s = chunk.toString("utf8").toLowerCase();
      if (s === "s" || s === "y" || s === "\r" || s === "\n") {
        finish(true);
        return;
      }
      if (s === "n" || s === "\x1b") {
        finish(false);
        return;
      }
      if (s === "\u0003") finish(true);
    };

    stdin.on("data", onData);
  });
}

/**
 * Lee una API key sin eco. Pausa el readline para no pelearse por stdin.
 */
function askSecret(rl: readline.Interface, prompt: string): Promise<string> {
  return new Promise((resolve) => {
    rl.pause();
    const stdin = process.stdin;
    const stdout = process.stdout;
    stdout.write(prompt);
    let value = "";
    const wasRaw = stdin.isRaw;
    if (stdin.isTTY) stdin.setRawMode(true);

    const finish = (result: string) => {
      stdin.off("data", onData);
      if (stdin.isTTY) stdin.setRawMode(Boolean(wasRaw));
      stdout.write("\n");
      rl.resume();
      resolve(result);
    };

    const onData = (chunk: string | Buffer) => {
      const s = chunk.toString("utf8");
      if (s === "\n" || s === "\r" || s === "\r\n") {
        finish(value);
        return;
      }
      if (s === "\u0003") {
        finish("");
        return;
      }
      if (s === "\u007f" || s === "\b") {
        value = value.slice(0, -1);
        return;
      }
      if (s === "\u0015") {
        value = "";
        return;
      }
      if (s >= " ") value += s;
    };

    stdin.on("data", onData);
  });
}

export async function runOnce(api: SquadApi, session: Session, requirement: string): Promise<number> {
  const ctx: Ctx = {
    api,
    session,
    print: (text) => process.stdout.write(text.endsWith("\n") ? text : text + "\n"),
    askSecret: async () => "",
  };
  await refreshSession(ctx);
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
  const spinner = ora({
    text: "orquestando…",
    color: "cyan",
    stream: process.stderr,
  }).start();
  try {
    const result = await api.orchestrate(payload);
    spinner.stop();
    process.stdout.write(renderResult(result));
    return result.status === "success" ? 0 : 1;
  } catch (err) {
    spinner.stop();
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(theme.err(msg) + "\n");
    return 1;
  }
}

/**
 * Compress old history turns into a summary to save tokens.
 * Keeps recent turns intact, summarizes older ones.
 */
function compressHistory(history: ChatTurn[]): ChatTurn[] {
  if (history.length <= 6) return history;

  const oldTurns = history.slice(0, -6);
  const recentTurns = history.slice(-6);

  // Create a summary of old turns
  const summaryParts: string[] = [];
  for (const turn of oldTurns) {
    const preview = turn.content.slice(0, 100).replace(/\n/g, " ");
    summaryParts.push(`${turn.role}: ${preview}...`);
  }

  const summary: ChatTurn = {
    role: "system",
    content: `[Historial previo resumido]: ${summaryParts.join(" | ")}`,
  };

  return [summary, ...recentTurns];
}
