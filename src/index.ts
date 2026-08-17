#!/usr/bin/env node
import "dotenv/config";
import { readFileSync } from "node:fs";
import { createApi } from "./api.js";
import { ContextManager } from "./context.js";
import { defaultPermissions, type Session } from "./commands.js";
import { parseCliArgs } from "./parse.js";
import { runOnce } from "./repl.js";
import { runTui } from "./tui.js";
import { renderUsage } from "./ui.js";

const version = readPkgVersion();

const args = parseCliArgs(process.argv.slice(2));

if (args.help) {
  process.stdout.write(renderUsage());
  process.exit(0);
}
if (args.version) {
  process.stdout.write(`squad ${version}\n`);
  process.exit(0);
}

const api = createApi(args.apiUrl);
const workspaceDir = args.workspaceDir ?? process.cwd();
const session: Session = {
  apiUrl: api.url,
  workspaceDir,
  permissions: defaultPermissions(),
  config: null,
  health: null,
  turns: 0,
  mode: "chat",
  history: [],
  contextManager: new ContextManager(workspaceDir),
};

if (args.prompt) {
  const code = await runOnce(api, session, args.prompt);
  process.exit(code);
}

if (process.stdin.isTTY && process.stdout.isTTY) {
  await runTui(api, session, version);
} else {
  const { runRepl } = await import("./repl.js");
  await runRepl(api, session);
}

function readPkgVersion(): string {
  try {
    const url = new URL("../package.json", import.meta.url);
    const pkg = JSON.parse(readFileSync(url, "utf8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}
