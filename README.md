# SquadAi-CLI impresionante

REPL tipo OpenCode / Claude Code. Es el front del orquestador: hablas en la terminal y el CLI pega a **SquadAi-Back**.

```text
  tú
   |
   v          
  squad  ❯ crea un login 
  /workspace  /connect  /help
   |
   | HTTP
   v
  SquadAi-Back :4000
  /api/orchestrate
  /api/config
```

No es un emulador de PTY ni un dashboard web. Texto libre = tarea. `/` = comando.

## Arranque

El backend tiene que estar corriendo.

```bash
# terminal 1
cd SquadAi-Back && npm run dev

# terminal 2
cd SquadAi-CLI
npm install
npm run dev
# o en una carpeta concreta:
npm start -- /home/ramces/Documentos/Proyectos/Personal/pruebas
```

One-shot (una tarea y sale):

```bash
npm start -- -p "crea un hello world en ts"
npm start -- ./mi-proyecto -p "añade un README"
```

`npm link` deja el comando `squad` en el PATH.

Flags: `-a/--api` (default `http://localhost:4000`), `-p/--prompt`, `-h`, `-v`. Override: `SQUAD_API_URL`.

## Comandos 

| Comando | Qué hace |
|---|---|
| texto libre | manda el job al jefe |
| `/help` | esta lista |
| `/status` | backend, workspace, modelos, keys |
| `/workspace <dir>` | carpeta donde el squad escribe |
| `/models <boss> [worker]` | modelos DeepSeek |
| `/connect [id]` | pega una API key (sin eco). default `deepseek` |
| `/keys` | keys enmascaradas |
| `/retries <n>` | reintentos de QA (1–5) |
| `/permissions write\|dirs\|cmds on\|off` | permisos del job |
| `/new` | limpia historial local |
| `/export [archivo]` | último job a markdown |
| `/editor` | compone el prompt en `$EDITOR` |
| `/exit` `/quit` `/q` | salir |
| `@ruta/archivo.ts` | inyecta el archivo en el prompt (no lee `.env` / `*.pem`) |

Mientras el back piensa hay un spinner. El timeline (boss → worker → QA) se pinta cuando llega la respuesta.

## Stack

TypeScript ESM, `node:readline`, `chalk`, `ora`, `dotenv`. Sin Ink, Electron ni xterm.

```text
src/
  index.ts      argv + boot
  repl.ts       loop + spinner + key oculta
  commands.ts   slash commands
  parse.ts      /comandos, @refs, flags
  api.ts        fetch al back
  ui.ts         colores y trace
  types.ts      contratos del back
```

`npm run check` corre el selfcheck (parser, sin red).

## Changelog

`squad -v` imprime la versión de este paquete. El historial del producto está en [CHANGELOG.md](./CHANGELOG.md).

---

> Línea de prueba: edición desde el chat ✅
