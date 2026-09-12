export type NodeStatus = "queued" | "running" | "done" | "failed" | "cancelled" | "awaiting-gate";

export interface NodeState {
  id: string;
  status: NodeStatus;
  usage: { input: number; output: number; cacheRead: number };
  retries: number;
  startedAt: number | null;
  endedAt: number | null;
  error: string | null;
}

export interface RunState {
  id: string;
  task: string;
  tier: string;
  project: string;
  status: "running" | "awaiting-gate" | "awaiting-answers" | "completed" | "failed" | "cancelled";
  createdAt: string;
  models: Record<string, string>;
  gate: {
    type?: "divergence" | "answers";
    nodeId: string;
    divergence?: string;
    questions?: { id: string; question: string; why?: string; suggested?: string }[];
    round?: number;
  } | null;
  error: string | null;
  nodes: NodeState[];
  artifacts: Record<string, unknown>;
}

export interface RunEvent {
  ts: number;
  nodeId: string;
  ev: { t: string; s?: string; name?: string; args?: string; ok?: boolean; usage?: Record<string, number> };
}

export interface ModelInfo {
  provider: string;
  id: string;
  label: string;
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
  models: () => jfetch<ModelInfo[]>("/api/models"),
  tiers: () => jfetch<Record<string, string[]>>("/api/tiers"),
  roles: () => jfetch<Record<string, string>>("/api/roles"),
  projects: () => jfetch<Project[]>("/api/projects"),
  addProject: (name: string, path: string) =>
    jfetch<Project[]>("/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, path }),
    }),
  listRuns: () =>
    jfetch<{ id: string; task: string; tier: string; project: string; status: string; createdAt: string }[]>(
      "/api/runs",
    ),
  getRun: (id: string) => jfetch<{ state: RunState; events: RunEvent[] }>(`/api/runs/${id}`),
  start: (
    task: string,
    tier: string,
    project: string,
    models: Record<string, string>,
    opts?: { clarify?: boolean; maxFixRounds?: number },
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
