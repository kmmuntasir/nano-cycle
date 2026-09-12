// Node profiles + tier graphs — the deterministic "who exists and what may it do".
// The counterpart rule lives here as structure: M-tier plans split into backend /
// frontend halves with disjoint file lists, so the lanes can run in parallel.
import { Type } from "typebox";

export const ARTIFACT_SCHEMAS = {
  plan: Type.Object({
    task_summary: Type.String({ description: "One-paragraph restatement of the task" }),
    backend: Type.Array(
      Type.Object({ path: Type.String(), purpose: Type.String() }),
      { description: "Backend files to create/modify (empty if none)" },
    ),
    frontend: Type.Array(
      Type.Object({ path: Type.String(), purpose: Type.String() }),
      { description: "Frontend files to create/modify (empty if none)" },
    ),
    acceptance_criteria: Type.Array(Type.String(), { description: "Verifiable checks" }),
    divergence: Type.Optional(
      Type.String({ description: "ONLY if the task is not doable as specified — explain why and stop" }),
    ),
  }),
  implement: Type.Object({
    summary: Type.String(),
    files_written: Type.Array(Type.String()),
  }),
  verify: Type.Object({
    verdict: Type.Union([Type.Literal("accepted"), Type.Literal("gaps-found")]),
    checks: Type.Array(
      Type.Object({ criterion: Type.String(), pass: Type.Boolean(), evidence: Type.String() }),
    ),
    notes: Type.Optional(Type.String()),
  }),
};

// Built-in minimal rules — always present; project context files (AGENTS.md /
// CLAUDE.md / .claude/rules/*) are injected on top by host/rules.mjs.
const CODING_RULES = `
Rules (binding):
- TypeScript strict where applicable; no \`any\`; no TODOs or placeholder logic.
- Keep it minimal — implement exactly the task, nothing extra.
- If a command needs something unavailable, surface it instead of pretending success.
`.trim();

export const NODE_PROFILES = {
  plan: {
    title: "Plan",
    tools: ["read", "grep", "find", "ls", "report_artifact"],
    thinking: "low",
    schema: ARTIFACT_SCHEMAS.plan,
    artifact: "plan",
  },
  implement: {
    title: "Implement",
    tools: ["read", "write", "edit", "bash", "report_artifact"],
    thinking: "low",
    schema: ARTIFACT_SCHEMAS.implement,
    artifact: "implement",
    rules: CODING_RULES,
  },
  "implement-be": {
    title: "Implement (backend)",
    lane: "backend",
    tools: ["read", "write", "edit", "bash", "report_artifact"],
    thinking: "low",
    schema: ARTIFACT_SCHEMAS.implement,
    artifact: "implement-be",
  },
  "implement-fe": {
    title: "Implement (frontend)",
    lane: "frontend",
    tools: ["read", "write", "edit", "bash", "report_artifact"],
    thinking: "low",
    schema: ARTIFACT_SCHEMAS.implement,
    artifact: "implement-fe",
  },
  verify: {
    title: "Verify",
    tools: ["read", "bash", "report_artifact"],
    thinking: "low",
    schema: ARTIFACT_SCHEMAS.verify,
    artifact: "verify",
    rules: CODING_RULES,
  },
};

export const TIERS = {
  // demo: single-file scratch task
  demo: [
    { id: "plan", dependsOn: [] },
    { id: "implement", dependsOn: ["plan"] },
    { id: "verify", dependsOn: ["implement"] },
  ],
  // S: skip planning — one coding node, then the gate
  S: [
    { id: "implement", dependsOn: [] },
    { id: "verify", dependsOn: ["implement"] },
  ],
  // M: full-stack slice — plan splits into BE/FE halves; the lanes run in
  // parallel when their file lists are disjoint (the counterpart rule).
  M: [
    { id: "plan", dependsOn: [] },
    { id: "implement-be", dependsOn: ["plan"] },
    { id: "implement-fe", dependsOn: ["plan"] },
    { id: "verify", dependsOn: ["implement-be", "implement-fe"] },
  ],
};

export const MAX_FIX_ROUNDS = 1;
export const DEFAULT_TIER = "demo";
