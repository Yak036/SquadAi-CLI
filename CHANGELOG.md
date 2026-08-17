# Changelog

Registro de cambios de **SquadAi** (Back, CLI y HUD).

El formato sigue [Keep a Changelog](https://keepachangelog.com/es/1.1.0/).
El versionado sigue [SemVer](https://semver.org/lang/es/): `MAJOR.MINOR.PATCH`.

Las tres carpetas (`SquadAi-Back`, `SquadAi-CLI`, `SquadAi-Hud`) publican la **misma** versión de producto. `squad -v` lee la de `SquadAi-CLI/package.json`.

### Cómo cortar una versión

1. Anota el trabajo en **[Unreleased]**.
2. Sube `version` en los tres `package.json` (y el campo `version` de cada `package-lock.json`).
3. Mueve el bloque Unreleased a `## [X.Y.Z] — YYYY-MM-DD`.
4. Deja **[Unreleased]** vacío otra vez.

## [Unreleased]

### Changed

- CLI: el review post-job muestra un diff lado a lado (antes | después), con hunks, `+`/`-` y fondo rojo/teal. Ya no pinta el archivo entero sin marcar el cambio.
- CLI: cada columna del diff tiene ancho fijo (números alineados, fondo recortado). El rojo ya no se mete en el verde.
- CLI: el click en el prompt ya no pega `[<0;17;54M`; mueve el cursor.
- CLI: el prompt no re-pinta todo el TUI por tecla; cursor y texto salen del mismo snapshot.

## [1.1.0] — 2026-08-17

Primera entrega usable: orquestador local, TUI Deep Midnight y review de cambios de la IA.

### Added

#### Backend (`SquadAi-Back`)

- Orquestador propio (sin CrewAI/LangChain): Jefe planifica → Worker genera → QA revisa, con reintentos.
- `POST /api/orchestrate` y `POST /api/orchestrate/stream` (SSE). `AbortSignal` hasta DeepSeek; job `cancelled`.
- Modos `squad` (jefe/worker/QA) y `chat` (un modelo). Default del API: squad si se omite; CLI/HUD mandan chat por defecto.
- Chat con tools `glob` / `read` / `grep` (tope 8). Squad sigue recibiendo `listTree()`.
- `FileService` con sandbox: bloqueo de path traversal, secretos (`.env`, `*.pem`, `credentials.json`), glob 100 hits, read 50 KB / 2000 líneas, grep 100 matches.
- `FileChange.previous`: contenido anterior al write, para que el CLI pueda revertir.
- Config en SQLite (`data/squad.sqlite`): settings y API keys enmascaradas. Endpoints `/api/config` y `/api/config/keys/:id`.
- Proveedor DeepSeek vía SDK OpenAI (`DEEPSEEK_BASE_URL`, `BOSS_MODEL`, `WORKER_MODEL`).
- Timeline `trace` (idea captada, razonamiento, orden al worker, TAREA FINALIZADA).

#### CLI (`SquadAi-CLI`)

- Binario `squad`. TUI Ink a pantalla completa (alt-screen), estilo OpenCode.
- Layout Deep Midnight de tres columnas: EXPLORER | workspace | SYSTEM (CPU/RAM + pasos del modelo).
- Modos de UI: `chat` → `squad` → `editor` (Tab o `/mode`). Solo chat/squad van al API.
- Explorador del `workspaceDir` (oculta `node_modules`, `.git`, `*.swp`; muestra `.env` en el árbol, no se lo manda al LLM).
- Mini editor in-TUI: cursor, click, rueda, arrastre para sombrear, Shift+flechas, Ctrl+S, Ctrl+Z/Y, Ctrl+C/P copia/pega, Backspace real en Linux.
- Fondo opaco `#12141d` (no hereda la transparencia del TTY).
- Chat y squad dejan el archivo abierto a la vista; la IA recarga el buffer al escribir.
- Review post-job: `y` acepta, `n` revierte, `a` todos, `r` todos.
- Slash commands: `/help` `/status` `/workspace` `/models` `/connect` `/keys` `/retries` `/permissions` `/mode` `/new` `/export` `/editor` `/exit`.
- `@ruta` inyecta el archivo en el prompt (bloquea secretos).
- One-shot: `squad -p "..."` / `squad <dir> -p "..."`.

#### HUD (`SquadAi-Hud`)

- App Vite en `:5173`: chat a la izquierda, grafo Jefe/Worker/QA (o nodo Modelo en chat).
- Consume SSE; Ctrl+C / Escape cancela el job.

### Changed

- Chat ya no mete el árbol entero en el prompt (solo path del workspace + mensaje).
- Parseo JSON del LLM: `JSON.parse` primero; unwrap de ` ```json ` solo si el payload empieza por fence; extracto por llaves balanceadas.
- Cancelación HTTP: no usar `req.on('close')` del body; solo `res.on('close')` si `!writableEnded`.

### Fixed

- JSON inválido cuando el worker metía ` ```bash ` dentro del código (el parser cortaba en el primer fence).
- Content vacío de reasoner: reintento de `chatText` sin `json_object`.
- `/editor` y `$EDITOR` rompían Ink: se sale del alt-screen y del raw mode, y se vuelve al volver de nvim.
- Backspace en Linux (byte `0x7f`) borraba hacia adelante; ahora borra hacia atrás. Adelante: Ctrl+D.
- Click en el editor limpiaba la selección; el arrastre no se escuchaba. Mouse SGR 1002 + ancla al pulsar.

## [1.0.0] — 2026-08-16

Estructura inicial: `SquadAi-Back`, `SquadAi-CLI`, `SquadAi-Hud`.
