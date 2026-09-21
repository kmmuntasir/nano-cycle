export type NodeStatus = "queued" | "running" | "done" | "failed" | "cancelled" | "awaiting-gate";

export interface NodeState {
  id: string;
  status: NodeStatus;
  usage: { input: number; output: number; cacheRead: number };
  retries: number;
  durationMs: number;
  startedAt: number | null;
  endedAt: number | null;
  error: string | null;
  /** v2 step extras */
  sessionFile?: string | null;
  sessionFiles?: string[];
  rounds?: number;
}

export interface ClarifyQuestion {
  id: string;
  question: string;
  type?: "multiple-choice" | "boolean" | "text";
  options?: { label: string; recommended?: boolean; tradeoff?: string }[];
  why?: string;
  suggested?: string;
}

/** One answered clarification round — the record of what was asked and what the owner answered. */
export interface QaRound {
  round: number;
  at: number;
  questions: ClarifyQuestion[];
  answers: Record<string, string>;
}

export type SecurityMode = "off" | "scan" | "scan+vapt";

export interface RunState {
  id: string;
  task: string;
  /** v2 has no tier; legacy v1 runs carry one. */
  tier?: string;
  version?: number;
  project: string;
  status: "running" | "awaiting-gate" | "awaiting-answers" | "completed" | "failed" | "cancelled" | "interrupted";
  createdAt: string;
  finishedAt: number | null;
  gateWaitMs: number;
  gateSince: number | null;
  models: Record<string, string>;
  options?: {
    clarify: boolean;
    requireQuestions?: boolean;
    maxFixRounds: number;
    git: boolean;
    audit: boolean;
    approvePlan: boolean;
    remoteCi: boolean;
    security: SecurityMode;
  };
  git?: {
    enabled: boolean;
    baseBranch: string;
    runBranch: string;
    commits: { node?: string; subject?: string; hash: string; files: string[] }[];
    merged: boolean;
    mergeError: string | null;
  };
  gate: {
    type?: "divergence" | "answers" | "plan-approval" | "security-override";
    nodeId: string;
    divergence?: string;
    questions?: ClarifyQuestion[];
    round?: number;
    plan?: PlanApproval;
    findings?: { severity: string; title: string; evidence: string; fix: string | null }[];
  } | null;
  error: string | null;
  /** v2 */
  steps?: NodeState[];
  round?: number;
  securityRound?: number;
  securityAccepted?: { at: string; findings: string[] } | null;
  scannerResults?: { round: number; at: string; scanners?: { id: string; title?: string; status: string; evidence: string }[] } | null;
  /** v1 legacy */
  nodes?: NodeState[];
  nodeModels?: Record<string, string>;
  prompts?: Record<string, string>;
  feedbackByNode?: Record<string, string>;
  writtenFiles?: Record<string, string[]>;
  tickets?: { id: string; title: string; implIds: string[]; verifyId: string }[];
  deferredChecks?: { criterion: string; env: string; evidence?: string }[];
  qa?: QaRound[];
  pendingQuestions?: { round: number; questions: ClarifyQuestion[] } | null;
  artifacts: Record<string, unknown>;
  remoteChecks?: {
    round: number;
    at: string;
    status: "pass" | "fail" | "skipped";
    evidence: string;
    runs: { id: number; name: string; status: string; conclusion: string | null; url: string; log: string | null }[];
  } | null;
  mechanicalChecks?: {
    round: number;
    at: string;
    checks: { id: string; title: string; status: string; evidence: string }[];
  } | null;
}

export interface PlanApproval {
  tier?: string;
  task_summary: string;
  approach?: string;
  acceptance_criteria: string[];
  files?: (string | { path: string; purpose?: string })[];
  /** v1 legacy shape */
  capabilities?: {
    id: string;
    title: string;
    backend: string[];
    frontend: string[];
    dependsOn: string[];
    single_side_class?: string | null;
  }[];
  backend?: string[];
  frontend?: string[];
}

export interface RunEvent {
  ts: number;
  nodeId: string;
  ev: { t: string; s?: string; name?: string; args?: string; ok?: boolean; usage?: Record<string, number> };
}

export interface RunSummary {
  id: string;
  task: string;
  tier?: string;
  project: string;
  status: string;
  createdAt: string;
}

export interface ModelInfo {
  provider: string;
  id: string;
  label: string;
  /** Thinking levels this model supports (e.g. ["low","high","max"]); absent when unknown. */
  thinkingLevels?: string[];
}

export interface Project {
  name: string;
  path: string;
}

async function jfetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const text = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    // Never resolve with garbage (e.g. an SPA-fallback HTML page) — fail loudly.
    throw new Error(`non-JSON response from ${url}: ${text.slice(0, 80)}`);
  }
  if (!res.ok) throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
  return body as T;
}

export const api = {
  models: () => jfetch<ModelInfo[]>(`/api/models?_=${Date.now()}`),
  roles: () => jfetch<Record<string, string>>(`/api/roles?_=${Date.now()}`),
  projects: () => jfetch<Project[]>(`/api/projects?_=${Date.now()}`),
  addProject: (name: string, path: string) =>
    jfetch<Project[]>("/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, path }),
    }),
  removeProject: (name: string) =>
    jfetch<Project[]>(`/api/projects/${encodeURIComponent(name)}`, { method: "DELETE" }),
  listRuns: () => jfetch<RunSummary[]>(`/api/runs?_=${Date.now()}`),
  getRun: (id: string) =>
    jfetch<{ state: RunState; events: RunEvent[]; totalEvents?: number }>(`/api/runs/${id}`),
  start: (
    task: string,
    project: string,
    models: Record<string, string>,
    opts?: { clarify?: boolean; requireQuestions?: boolean; maxFixRounds?: number; git?: boolean; audit?: boolean; approvePlan?: boolean; remoteChecks?: boolean; security?: SecurityMode; ticketId?: string; stopAfterClarify?: boolean },
  ) =>
    jfetch<RunState>("/api/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ task, project, models, ...opts }),
    }),
  gate: (id: string, action: "approve" | "reject" | "cancel", comments?: string) =>
    jfetch<{ ok: boolean }>(`/api/runs/${id}/gate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action, comments }),
    }),
  answers: (id: string, answers: Record<string, string>) =>
    jfetch<{ ok: boolean }>(`/api/runs/${id}/answers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ answers }),
    }),
  cancel: (id: string) => jfetch<{ ok: boolean }>(`/api/runs/${id}/cancel`, { method: "POST" }),
  resume: (id: string) => jfetch<{ ok: boolean }>(`/api/runs/${id}/resume`, { method: "POST" }),
  setNodeModel: (id: string, step: string, model: string) =>
    jfetch<{ ok: boolean }>(`/api/runs/${id}/model`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ step, model }),
    }),
};

// --- v3 ticket queue -----------------------------------------------------------

export type TicketStatus = "draft" | "clarifying" | "clarified" | "queued" | "running" | "done" | "blocked";

export interface Ticket {
  id: string;
  title: string;
  description: string;
  sourceDoc: string | null;
  dependsOn: string[];
  order: number;
  status: TicketStatus;
  blockedReason: string | null;
  runId: string | null;
  history: { at: string; from: string | null; to: string; runId?: string; note?: string }[];
  createdAt: string;
  updatedAt: string;
}

export interface TicketStore {
  project: string;
  config: {
    models: Record<string, string>;
    options: { git: boolean; audit: boolean; security: SecurityMode; maxFixRounds: number; remoteChecks: boolean };
  };
  tickets: Ticket[];
  queue: { state: "idle" | "clarifying" | "awaiting-release" | "running" | "paused"; pausedAt: string | null };
}

export interface InboxItem {
  runId: string;
  ticketId: string | null;
  /** v3.1 wave runs: every ticket the single PM run is clarifying */
  waveTicketIds?: string[] | null;
  round: number;
  questions: ClarifyQuestion[];
}

export const ticketsApi = {
  store: (project: string) => jfetch<TicketStore>(`/api/tickets/${encodeURIComponent(project)}?_=${Date.now()}`),
  create: (project: string, body: { id?: string; title: string; description?: string; dependsOn?: string[] }) =>
    jfetch<Ticket>(`/api/tickets/${encodeURIComponent(project)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  update: (project: string, id: string, patch: Partial<Ticket>) =>
    jfetch<Ticket>(`/api/tickets/${encodeURIComponent(project)}/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    }),
  remove: (project: string, id: string) =>
    jfetch<{ ok: boolean }>(`/api/tickets/${encodeURIComponent(project)}/${encodeURIComponent(id)}`, { method: "DELETE" }),
  import: (project: string, body: { path?: string; markdown?: string; json?: unknown; sourceDoc?: string }) =>
    jfetch<{ created: string[]; skipped: string[]; sourceDoc: string | null }>(`/api/tickets/${encodeURIComponent(project)}/import`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  queue: (project: string, body: { action: string; ticketIds?: string[]; ticketId?: string; orderedIds?: string[]; models?: Record<string, string>; options?: Record<string, unknown> }) =>
    jfetch<{ ok?: boolean; released?: number; error?: string }>(`/api/queue/${encodeURIComponent(project)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  inbox: (project: string) =>
    jfetch<{ project: string; items: InboxItem[] }>(`/api/inbox/${encodeURIComponent(project)}?_=${Date.now()}`),
};

// --- Standalone Project Coding Agent Chat ---

export interface ChatSessionSummary {
  id: string;
  file: string;
  name: string | null;
  firstMessage: string | null;
  messageCount: number;
  createdAt: string | null;
  modifiedAt: string | null;
}

export interface ChatToolResult {
  toolCallId: string;
  toolName: string;
  isError: boolean;
  content: string;
  details?: {
    diff?: string;
    patch?: string;
    firstChangedLine?: number;
    [key: string]: unknown;
  } | null;
  timestamp: number;
}

export interface ChatToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  result?: ChatToolResult | null;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  timestamp: number;
  content: string;
  model?: string | null;
  thinking?: string;
  toolCalls?: ChatToolCall[];
  usage?: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite?: number;
    total: number;
    cost?: number | { total?: number } | null;
  } | null;
  stopReason?: string | null;
}

export interface ChatSessionDetail {
  id: string;
  file: string;
  title: string | null;
  model: string | null;
  thinkingLevel: string | null;
  messages: ChatMessage[];
  isGenerating: boolean;
}

export interface ChatEventMessage {
  type: "chat_event";
  event: "start" | "prompt_start" | "text_delta" | "thinking_delta" | "tool_start" | "tool_update" | "tool_end" | "turn_end" | "prompt_end" | "done" | "error" | "aborted" | "session_renamed";
  project: string;
  sessionId: string;
  delta?: string;
  prompt?: string;
  toolCallId?: string;
  toolName?: string;
  args?: unknown;
  partialResult?: unknown;
  ok?: boolean;
  content?: string;
  details?: unknown;
  usage?: unknown;
  title?: string;
  error?: string;
}

export const chatApi = {
  listSessions: (project: string) =>
    jfetch<ChatSessionSummary[]>(`/api/chat/${encodeURIComponent(project)}/sessions?_=${Date.now()}`),
  createSession: (project: string, body?: { modelSpec?: string; thinkingLevel?: string; title?: string }) =>
    jfetch<ChatSessionDetail>(`/api/chat/${encodeURIComponent(project)}/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body ?? {}),
    }),
  getSession: (project: string, sessionId: string) =>
    jfetch<ChatSessionDetail>(`/api/chat/${encodeURIComponent(project)}/sessions/${encodeURIComponent(sessionId)}?_=${Date.now()}`),
  deleteSession: (project: string, sessionId: string) =>
    jfetch<{ ok: boolean }>(`/api/chat/${encodeURIComponent(project)}/sessions/${encodeURIComponent(sessionId)}`, {
      method: "DELETE",
    }),
  renameSession: (project: string, sessionId: string, title: string) =>
    jfetch<{ ok: boolean; title: string }>(`/api/chat/${encodeURIComponent(project)}/sessions/${encodeURIComponent(sessionId)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title }),
    }),
  sendMessage: (project: string, sessionId: string, body: { prompt: string; modelSpec?: string; thinkingLevel?: string }) =>
    jfetch<{ ok: boolean }>(`/api/chat/${encodeURIComponent(project)}/sessions/${encodeURIComponent(sessionId)}/message`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  abort: (project: string, sessionId: string) =>
    jfetch<{ ok: boolean }>(`/api/chat/${encodeURIComponent(project)}/sessions/${encodeURIComponent(sessionId)}/abort`, {
      method: "POST",
    }),
};

export type WsMessage = {
  type: string;
  runId?: string;
  state?: RunState;
  nodeId?: string;
  ev?: RunEvent["ev"];
  project?: string;
  sessionId?: string;
  event?: string;
  [key: string]: unknown;
};

export function openWs(onMessage: (msg: WsMessage) => void): WebSocket {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onmessage = (m) => {
    try {
      onMessage(JSON.parse(m.data));
    } catch {
      /* ignore malformed */
    }
  };
  return ws;
}
