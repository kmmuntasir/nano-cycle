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
}

export interface RunState {
  id: string;
  task: string;
  tier: string;
  project: string;
  status: "running" | "awaiting-gate" | "awaiting-answers" | "completed" | "failed" | "cancelled" | "interrupted";
  createdAt: string;
  finishedAt: number | null;
  gateWaitMs: number;
  gateSince: number | null;
  models: Record<string, string>;
  git?: {
    enabled: boolean;
    baseBranch: string;
    runBranch: string;
    commits: { node: string; hash: string; files: string[] }[];
    merged: boolean;
    mergeError: string | null;
  };
  gate: {
    type?: "divergence" | "answers" | "plan-approval";
    nodeId: string;
    divergence?: string;
    questions?: {
      id: string;
      question: string;
      type?: "multiple-choice" | "boolean" | "text";
      options?: { label: string; recommended?: boolean; tradeoff?: string }[];
      why?: string;
      suggested?: string;
    }[];
    round?: number;
    plan?: PlanApproval;
  } | null;
  error: string | null;
  nodes: NodeState[];
  nodeModels?: Record<string, string>;
  prompts?: Record<string, string>;
  artifacts: Record<string, unknown>;
  feedbackByNode?: Record<string, string>;
  writtenFiles?: Record<string, string[]>;
  deferredChecks?: { criterion: string; env: string; evidence?: string }[];
  tickets?: { id: string; title: string; implIds: string[]; verifyId: string }[];
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
  tier: string;
  task_summary: string;
  acceptance_criteria: string[];
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
  tier: string;
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
  tiers: () => jfetch<Record<string, string[]>>(`/api/tiers?_=${Date.now()}`),
  roles: () => jfetch<Record<string, string>>(`/api/roles?_=${Date.now()}`),
  projects: () => jfetch<Project[]>(`/api/projects?_=${Date.now()}`),
  addProject: (name: string, path: string) =>
    jfetch<Project[]>("/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, path }),
    }),
  listRuns: () => jfetch<RunSummary[]>(`/api/runs?_=${Date.now()}`),
  getRun: (id: string) => jfetch<{ state: RunState; events: RunEvent[] }>(`/api/runs/${id}`),
  start: (
    task: string,
    tier: string,
    project: string,
    models: Record<string, string>,
    opts?: { clarify?: boolean; maxFixRounds?: number; git?: boolean; audit?: boolean; approvePlan?: boolean; remoteChecks?: boolean },
  ) =>
    jfetch<RunState>("/api/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ task, tier, project, models, ...opts }),
    }),
  gate: (id: string, action: "approve" | "cancel") =>
    jfetch<{ ok: boolean }>(`/api/runs/${id}/gate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action }),
    }),
  answers: (id: string, answers: Record<string, string>) =>
    jfetch<{ ok: boolean }>(`/api/runs/${id}/answers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ answers }),
    }),
  cancel: (id: string) => jfetch<{ ok: boolean }>(`/api/runs/${id}/cancel`, { method: "POST" }),
  resume: (id: string) => jfetch<{ ok: boolean }>(`/api/runs/${id}/resume`, { method: "POST" }),
  setNodeModel: (id: string, node: string, model: string) =>
    jfetch<{ ok: boolean }>(`/api/runs/${id}/model`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ node, model }),
    }),
};

export function openWs(onMessage: (msg: { type: string; runId?: string; state?: RunState; nodeId?: string; ev?: RunEvent["ev"] }) => void): WebSocket {
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
