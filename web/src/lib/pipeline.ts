import type { NodeState, RunState } from "../api";

export type NodeStatus = NodeState["status"];

export const STATUS_COLOR: Record<string, string> = {
  queued: "muted",
  running: "accent",
  done: "good",
  completed: "good",
  "awaiting-gate": "warn",
  "awaiting-answers": "warn",
  failed: "bad",
  cancelled: "muted",
  interrupted: "bad",
};

/** Nodes in pipeline order: clarify → plan → coders → verify. */
export function orderedNodes(state: RunState): NodeState[] {
  const rank = (id: string) =>
    id === "clarify" ? 0 : id === "plan" ? 1 : id === "verify" ? 98 : id.startsWith("impl") ? 50 : 90;
  return [...state.nodes].sort((a, b) => rank(a.id) - rank(b.id));
}

export function isCoder(id: string): boolean {
  return id.startsWith("impl");
}
