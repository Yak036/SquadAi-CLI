/**
 * Cliente HTTP mínimo contra SquadAi-Back.
 * No cachea: cada comando lee estado fresco (keys/settings viven en SQLite del back).
 */
import type {
  ApiKeyPublic,
  ConfigPublic,
  HealthResponse,
  OrchestrateRequest,
  OrchestrateResponse,
  TraceEvent,
} from "./types.js";

export class ApiError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

type ConfigPatch = {
  settings?: Partial<{
    bossModel: string;
    workerModel: string;
    workspaceDir: string;
    maxRetries: number;
  }>;
  keys?: Array<{ id: string; label?: string; apiKey?: string; baseUrl?: string }>;
};

function isJobResult(body: unknown): boolean {
  if (!body || typeof body !== "object") return false;
  const rec = body as { status?: unknown; changes?: unknown; trace?: unknown };
  return typeof rec.status === "string" && Array.isArray(rec.changes) && Array.isArray(rec.trace);
}

async function readJson(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text.trim()) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ApiError(`Respuesta no JSON (HTTP ${res.status})`, res.status, text.slice(0, 240));
  }
}

export function createApi(baseUrl: string) {
  const root = baseUrl.replace(/\/$/, "");

  async function request(path: string, init: RequestInit = {}): Promise<unknown> {
    let res: Response;
    try {
      res = await fetch(`${root}${path}`, {
        ...init,
        headers: {
          accept: "application/json",
          ...(init.body ? { "content-type": "application/json" } : {}),
          ...init.headers,
        },
      });
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") throw err;
      const why = err instanceof Error ? err.message : String(err);
      throw new ApiError(
        `No pude hablar con ${root} (${why}). Arranca SquadAi-Back: npm run dev`,
        0,
        null,
      );
    }

    const body = await readJson(res);
    // 422 = job partial/failed: el JSON sigue siendo OrchestrateResponse, no un crash.
    if (!res.ok) {
      if (isJobResult(body)) return body;
      const rec = body && typeof body === "object" ? (body as { error?: string; summary?: string }) : {};
      throw new ApiError(rec.error || rec.summary || `HTTP ${res.status}`, res.status, body);
    }
    return body;
  }

  return {
    url: root,

    health: () => request("/health") as Promise<HealthResponse>,

    getConfig: () => request("/api/config") as Promise<ConfigPublic>,

    putConfig: (patch: ConfigPatch) =>
      request("/api/config", { method: "PUT", body: JSON.stringify(patch) }) as Promise<ConfigPublic>,

    putKey: (id: string, payload: { label?: string; apiKey?: string; baseUrl?: string }) =>
      request(`/api/config/keys/${encodeURIComponent(id)}`, {
        method: "PUT",
        body: JSON.stringify(payload),
      }) as Promise<ApiKeyPublic>,

    deleteKey: (id: string) =>
      request(`/api/config/keys/${encodeURIComponent(id)}`, { method: "DELETE" }) as Promise<ApiKeyPublic>,

    orchestrate: (payload: OrchestrateRequest, signal?: AbortSignal) => {
      const init: RequestInit = { method: "POST", body: JSON.stringify(payload) };
      if (signal) init.signal = signal;
      return request("/api/orchestrate", init) as Promise<OrchestrateResponse>;
    },

    orchestrateStream: async (
      payload: OrchestrateRequest,
      handlers: {
        signal: AbortSignal;
        onTrace: (event: TraceEvent) => void;
        onDone: (result: OrchestrateResponse) => void;
      },
    ): Promise<void> => {
      const res = await fetch(`${root}/api/orchestrate/stream`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "text/event-stream" },
        body: JSON.stringify(payload),
        signal: handlers.signal,
      });
      if (!res.body) throw new ApiError(`HTTP ${res.status} sin body`, res.status, null);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const chunks = buf.split("\n\n");
        buf = chunks.pop() ?? "";
        for (const chunk of chunks) {
          const line = chunk.split("\n").find((l) => l.startsWith("data: "));
          if (!line) continue;
          const frame = JSON.parse(line.slice(6)) as
            | { type: "trace"; event: TraceEvent }
            | { type: "done"; result: OrchestrateResponse }
            | { type: "error"; message: string };
          if (frame.type === "trace") handlers.onTrace(frame.event);
          else if (frame.type === "done") handlers.onDone(frame.result);
          else throw new ApiError(frame.message, 500, frame);
        }
      }
    },
  };
}

export type SquadApi = ReturnType<typeof createApi>;
