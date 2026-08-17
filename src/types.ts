/**
 * Contratos que el CLI espera del backend. Deben seguir a SquadAi-Back/src/types.ts.
 */

export type AgentMode = "squad" | "chat";
export type FileAction = "create" | "modify";
export type ChangeAction = "created" | "modified";
export type JobStatus = "success" | "partial" | "failed" | "cancelled";
export type TraceActor = "boss" | "worker" | "qa" | "system" | "chat";

export type AgentPermissions = {
  writeFiles: boolean;
  createDirs: boolean;
  runCommands: boolean;
};

export type ChatTurn = {
  role: "user" | "assistant" | "system";
  content: string;
};

export type TraceEvent = {
  at: string;
  actor: TraceActor;
  event: string;
  detail: string;
};

export type FileChange = {
  action: ChangeAction;
  file: string;
  path: string;
  previous?: string | null;
};

export type ContextEntry = {
  rel: string;
  content: string;
  reason: string;
  priority: number;
};

export type OrchestrateRequest = {
  requirement: string;
  workspaceDir?: string;
  maxRetries?: number;
  permissions?: Partial<AgentPermissions>;
  mode?: AgentMode;
  history?: ChatTurn[];
  context?: ContextEntry[];
  contextSummary?: string;
};

export type OrchestrateResponse = {
  status: JobStatus;
  summary: string;
  changes: FileChange[];
  trace: TraceEvent[];
  error?: string;
};

export type AppSettings = {
  bossModel: string;
  workerModel: string;
  workspaceDir: string;
  maxRetries: number;
};

export type ApiKeyPublic = {
  id: string;
  label: string;
  apiKeySet: boolean;
  apiKeyMasked: string;
  baseUrl: string;
};

export type ConfigPublic = {
  settings: AppSettings;
  keys: ApiKeyPublic[];
};

export type HealthResponse = {
  ok: boolean;
  deepseek: boolean;
};
