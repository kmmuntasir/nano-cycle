// Node profiles + tier graphs — the deterministic "who exists and what may it do".
//
// Tiers demo/S/M have static graphs. Tier L is dynamic: the plan decomposes the
// task into CAPABILITIES, and the engine compiles each capability into backend /
// frontend coder nodes — N parallel coders per side when the plan calls for it —
// with capability-level dependencies. The counterpart rule is enforced at
// compile time: a capability with only one side must declare a legal class.
import { Type } from "typebox";

export const ARTIFACT_SCHEMAS = {
  // static plan (demo/S/M): one slice split into two halves
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
  // capability plan (L): a graph of capabilities the engine compiles into coder nodes
  plan_caps: Type.Object({
    task_summary: Type.String({ description: "One-paragraph restatement of the task" }),
    capabilities: Type.Array(
      Type.Object({
        id: Type.String({ description: "Short slug, unique, e.g. customer-crud" }),
        title: Type.String({ description: "What this capability delivers" }),
        backend: Type.Array(
          Type.Object({ path: Type.String(), purpose: Type.String() }),
          { description: "Backend files (empty if none)" },
        ),
        frontend: Type.Array(
          Type.Object({ path: Type.String(), purpose: Type.String() }),
          { description: "Frontend files (empty if none)" },
        ),
        dependsOn: Type.Array(Type.String(), {
          description: "Capability ids that must finish before this one starts",
        }),
        single_side_class: Type.Optional(
          Type.Union(
            ["plumbing", "devops", "qa", "no-counterpart"].map((c) => Type.Literal(c)),
            { description: "REQUIRED when exactly one side is empty: why this capability legally has no counterpart" },
          ),
        ),
      }),
      { description: "2–6 capabilities; each independently implementable; a file belongs to exactly one capability-side" },
    ),
    acceptance_criteria: Type.Array(Type.String(), { description: "Verifiable checks for the WHOLE task" }),
    divergence: Type.Optional(
      Type.String({ description: "ONLY if the task is not doable as specified — explain why and stop" }),
    ),
  }),
  implement: Type.Object({
    summary: Type.String(),
    files_written: Type.Array(Type.String()),
    notes: Type.Optional(
      Type.String({
        description:
          "Impl-delta: decisions made, deviations from the plan and why, anything the verifier should know",
      }),
    ),
  }),
  // clarify-phase tools: the PM loop
  questions: Type.Object({
    questions: Type.Array(
      Type.Object({
        id: Type.String({ description: "Short stable slug, e.g. delete-policy" }),
        question: Type.String({ description: "The product decision the owner must make" }),
        type: Type.Union(
          [Type.Literal("multiple-choice"), Type.Literal("boolean"), Type.Literal("text")],
          { description: "Question format" },
        ),
        options: Type.Optional(
          Type.Array(
            Type.Object({
              label: Type.String(),
              recommended: Type.Optional(Type.Boolean()),
              tradeoff: Type.Optional(Type.String()),
            }),
            { description: "For multiple-choice: 2–3 options, mark the recommended one" },
          ),
        ),
        why: Type.Optional(Type.String({ description: "One line: what changes in the build depending on the answer" })),
        suggested: Type.Optional(Type.String({ description: "Suggested answer if the owner just accepts defaults" })),
      }),
      {
        description:
          "1–5 questions, OWNER-ONLY product decisions (behavior policy, deletion semantics, naming/IA, migration, roles, scope deferrals). " +
          "NEVER ask what the project files answer; NEVER ask trivial questions with safe defaults — lock those as flagged assumptions instead.",
      },
    ),
  }),
  spec: Type.Object({
    summary: Type.String({ description: "The refined task, fully decided" }),
    source_docs: Type.Optional(
      Type.Array(Type.String(), {
        description: "Paths of the source requirement documents this spec traces (PRD, feature breakdowns, backlog, tickets — wherever the repo keeps them). Their requirements OUTRANK this spec's wording",
      }),
    ),
    decisions: Type.Array(
      Type.Object({ topic: Type.String(), decision: Type.String() }),
      { description: "Locked decisions (incl. the outcomes of clarification rounds)" },
    ),
    acceptance_criteria: Type.Array(Type.String(), {
      description: "THE contract — runnable/checkable criteria the verifier will gate on",
    }),
    ac_verification: Type.Optional(
      Type.Array(
        Type.Object({
          criterion: Type.String({
            description: "The criterion text EXACTLY as it appears in acceptance_criteria",
          }),
          env: Type.Union([Type.Literal("local"), Type.Literal("remote"), Type.Literal("human")], {
            description:
              "local = verifiable by running code/commands in this workspace; remote = needs a hosted service (GitHub CI runs, branch protection); human = needs a person to judge",
          }),
        }),
        { description: "ONE entry per acceptance criterion — tag every one" },
      ),
    ),
    out_of_scope: Type.Optional(Type.Array(Type.String())),
  }),
  verify: Type.Object({
    verdict: Type.Union([Type.Literal("accepted"), Type.Literal("gaps-found")]),
    checks: Type.Array(
      Type.Object({ criterion: Type.String(), pass: Type.Boolean(), evidence: Type.String() }),
    ),
    notes: Type.Optional(Type.String()),
  }),
  audit: Type.Object({
    verdict: Type.Union([Type.Literal("accepted"), Type.Literal("gaps-found")]),
    findings: Type.Array(
      Type.Object({
        category: Type.Union(
          [
            Type.Literal("requirement-conformity"),
            Type.Literal("locked-decision"),
            Type.Literal("quality"),
            Type.Literal("practice"),
          ],
          { description: "What kind of finding this is" },
        ),
        blocking: Type.Boolean({
          description: "True ONLY for spec/locked-decision violations, broken behavior, or security problems — these force another fix round",
        }),
        file: Type.Optional(Type.String({ description: "Offending file, ideally with :line" })),
        issue: Type.String({ description: "What is wrong, quoting the violated criterion/decision where applicable" }),
        fix: Type.Optional(Type.String({ description: "How to fix it" })),
      }),
      { description: "Empty when the implementation is right and clean" },
    ),
    notes: Type.Optional(Type.String()),
  }),
};

// Built-in implementer rules — always present for coder nodes; project context
// files (AGENTS.md / CLAUDE.md / .claude/rules/*) are injected on top by
// host/rules.mjs. Verify/audit carry no coding rules: their method lives in
// their system prompts (host/prompts.mjs).
const IMPLEMENT_RULES = `
Rules (binding):
- Implement the task FULLY — every artifact the task, the spec's acceptance criteria, and the injected rules require. No stubs, no TODOs, no placeholder logic.
- TypeScript strict where applicable; no \`any\`.
- Run lint and tests for what you changed before reporting; fix what they surface. If no test setup exists, follow the injected testing rules if present.
- Stay inside your assigned files — sibling coder nodes are working on other files concurrently. On fix rounds: fix ONLY your assigned gaps; do not refactor unrelated code.
- If a command needs something unavailable, surface it instead of pretending success.
- Report honestly: summary of what you built, files_written, and notes (decisions made, deviations from the plan and why).
`.trim();

export const NODE_PROFILES = {
  plan: {
    title: "Plan",
    tools: ["read", "grep", "find", "ls", "report_artifact"],
    thinking: "high",
    schema: ARTIFACT_SCHEMAS.plan,
    role: "plan",
  },
  implement: {
    title: "Implement",
    tools: ["read", "write", "edit", "bash", "report_artifact"],
    thinking: "high",
    schema: ARTIFACT_SCHEMAS.implement,
    role: "backend",
    rules: IMPLEMENT_RULES,
  },
  verify: {
    title: "Verify",
    tools: ["read", "bash", "report_artifact"],
    thinking: "high",
    schema: ARTIFACT_SCHEMAS.verify,
    role: "verify",
  },
  audit: {
    title: "Audit",
    tools: ["read", "bash", "report_artifact"],
    thinking: "high",
    schema: ARTIFACT_SCHEMAS.audit,
    role: "audit",
  },
};

// Role = which model/config slot a node uses. Capability-derived coder nodes
// (impl-<cap>-be / impl-<cap>-fe) resolve to the backend/frontend roles, so a
// single run can drive N parallel backend coders and M parallel frontend coders.
export function profileFor(nodeId) {
  if (nodeId === "plan") return NODE_PROFILES.plan;
  // "verify" and per-ticket "verify-<capId>" nodes share the verify profile
  if (nodeId === "verify" || nodeId.startsWith("verify-")) return NODE_PROFILES.verify;
  if (nodeId === "audit") return NODE_PROFILES.audit;
  if (nodeId === "implement") return NODE_PROFILES.implement;
  if (nodeId.endsWith("-be")) return { ...NODE_PROFILES.implement, lane: "backend" };
  if (nodeId.endsWith("-fe")) return { ...NODE_PROFILES.implement, lane: "frontend" };
  throw new Error(`unknown node: ${nodeId}`);
}

export function roleOf(nodeId) {
  return profileFor(nodeId).role;
}

export const MODEL_ROLES = {
  clarify: "PM (clarify)",
  plan: "Plan",
  backend: "Backend coder",
  frontend: "Frontend coder",
  verify: "Verify",
  audit: "Audit",
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
  // M: one slice — plan splits into BE/FE halves; the engine compiles ONLY the
  // halves that have files, so an unused side never spawns a coder.
  M: [{ id: "plan", dependsOn: [] }],
  // L: DYNAMIC — the plan decomposes into capabilities; the engine compiles each
  // into backend/frontend coder nodes with capability-level dependencies. The
  // resulting graph can have any number of parallel coders per side.
  L: [{ id: "plan", dependsOn: [] }],
};

export const MAX_FIX_ROUNDS = 2;
export const DEFAULT_TIER = "demo";
export const LEGAL_SINGLE_SIDES = ["plumbing", "devops", "qa", "no-counterpart"];

// Clarify (PM) phase — Step 1 of the two-step flow: ask → answers → repeat.
// UNCAPPED by design: the PM decides when nothing essential remains unknown.
// The owner can always cancel from the GUI.
export const CLARIFY_PROFILE = {
  tools: ["read", "grep", "find", "ls", "investigate", "ask_questions", "finalize_spec"],
  thinking: "high",
};
