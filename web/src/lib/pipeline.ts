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

/** v2 step order; falls back to v1 node ordering for legacy runs. */
export const STEP_ORDER = ["clarify", "build", "verify", "security"];

export function orderedUnits(state: RunState): NodeState[] {
  if (Array.isArray(state.steps)) {
    return [...state.steps].sort(
      (a, b) => STEP_ORDER.indexOf(a.id) - STEP_ORDER.indexOf(b.id),
    );
  }
  // v1 legacy
  const rank = (id: string) =>
    id === "clarify" ? 0 : id === "plan" ? 1 : id === "verify" ? 98 : id.startsWith("impl") ? 50 : 90;
  return [...(state.nodes ?? [])].sort((a, b) => rank(a.id) - rank(b.id));
}

export function isV2(state: RunState): boolean {
  return Array.isArray(state.steps);
}

export function isCoder(id: string): boolean {
  return id.startsWith("impl");
}
