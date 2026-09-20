// Node profiles + tier graphs — the deterministic "who exists and what may it do".
//
// Tiers demo/S/M have static graphs. Tier L is dynamic: the plan decomposes the
// task into CAPABILITIES, and the engine compiles each capability into backend /
// frontend coder nodes — N parallel coders per side when the plan calls for it —
// with capability-level dependencies. The counterpart rule is enforced at
// compile time: a capability with only one side must declare a legal class.
import { Type } from "typebox";

export const ARTIFACT_SCHEMAS = {
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
// ============================================================================
// v2 — the four-step workflow (docs/PLAN-v2-step-workflow.md). Additive: v1
// exports above stay until the engine switch + cleanup phase.
// ============================================================================

// Milestone artifact schemas — the structured outputs each phase submits via
// its milestone tool. verify/audit reuse ARTIFACT_SCHEMAS above.
export const MILESTONE_SCHEMAS = {
  plan: Type.Object({
    task_summary: Type.String({ description: "One-paragraph restatement of WHAT will be built" }),
    approach: Type.String({ description: "Key technical decisions: architecture shape, mechanisms reused vs created, migration/test strategy" }),
    files: Type.Array(
      Type.Object({
        path: Type.String(),
        purpose: Type.String(),
        task: Type.Optional(Type.String({ description: "Preliminary owning task slug (assigned firmly at task breakdown)" })),
      }),
      { description: "Every file to create/modify — real paths, real purposes" },
    ),
    acceptance_criteria: Type.Array(Type.String(), { description: "Verifiable criteria for the WHOLE task; carry every spec criterion verbatim" }),
    divergence: Type.Optional(Type.String({ description: "ONLY if the task cannot be done as specified — explain why and stop" })),
  }),
  tasks: Type.Object({
    tasks: Type.Array(
      Type.Object({
        id: Type.String({ description: "Short unique slug, e.g. auth-endpoints" }),
        title: Type.String(),
        description: Type.String({ description: "What done looks like for this slice" }),
        files: Type.Array(Type.String(), { description: "Files this task owns (subset of the plan's files; ≥1)" }),
        acceptance_criteria: Type.Array(Type.String(), { description: "Runnable, task-specific checks" }),
        dependsOn: Type.Array(Type.String(), { description: "Task ids that must complete first (real build-order only)" }),
        size: Type.Union([Type.Literal("S"), Type.Literal("M"), Type.Literal("L")]),
      }),
      { description: "2–8 tasks (a trivial feature may be 1); union of files must cover the plan's file list" },
    ),
  }),
  implDelta: Type.Object({
    summary: Type.String({ description: "What was built — features delivered, commands to see them work" }),
    files_written: Type.Array(Type.String(), { description: "Every file created/modified this round (project-relative)" }),
    notes: Type.Optional(Type.String({ description: "Impl-delta: decisions made, deviations from the plan and why" })),
    task_completion: Type.Optional(
      Type.Array(
        Type.Object({
          task: Type.String(),
          status: Type.Union([Type.Literal("done"), Type.Literal("partial"), Type.Literal("skipped")]),
          note: Type.Optional(Type.String()),
        }),
      ),
    ),
  }),
  security: Type.Object({
    verdict: Type.Union([Type.Literal("pass"), Type.Literal("findings")]),
    findings: Type.Array(
      Type.Object({
        id: Type.String({ description: "Stable slug, e.g. gitleaks-1, cors-credentials" }),
        source: Type.Union([Type.Literal("scanner"), Type.Literal("manual")]),
        severity: Type.Union(
          [Type.Literal("critical"), Type.Literal("high"), Type.Literal("medium"), Type.Literal("low"), Type.Literal("info")],
        ),
        title: Type.String(),
        evidence: Type.String({ description: "Observed command/output or file:line citation — no speculation" }),
        file: Type.Optional(Type.String()),
        fix: Type.Optional(Type.String()),
        fixable_in_scope: Type.Boolean({ description: "true = fixing touches only this feature's files/deps; false = owner/infra action or foreign systems" }),
      }),
      { description: "Every scanner-sourced and manual finding, severity-classified" },
    ),
    notes: Type.Optional(Type.String()),
  }),
};

// Step profiles — tools/thinking per v2 step. Custom (milestone/dispatch)
// tool names must appear in `tools` to be reachable (SDK contract).
export const STEP_PROFILES = {
  clarify: {
    tools: ["read", "grep", "find", "ls", "investigate", "ask_questions", "finalize_spec"],
    thinking: "high",
  },
  build: {
    tools: ["read", "write", "edit", "bash", "grep", "find", "ls", "submit_plan", "submit_tasks", "submit_impl_delta", "dispatch_coder"],
    thinking: "high",
  },
  verify: {
    tools: ["read", "grep", "find", "ls", "bash", "submit_verify", "submit_audit"],
    thinking: "high",
  },
  security: {
    tools: ["read", "grep", "find", "ls", "bash", "run_scanners", "submit_security"],
    thinking: "high",
  },
};

export const MODEL_ROLES_V2 = {
  clarify: "PM (clarify)",
  builder: "Builder",
  verifier: "Verifier",
  security: "Security",
};

// Security severity gate — findings at these severities block (fixable) or
// escalate to the owner (unfixable). Everything below is recorded, non-gating.
export const SEVERITY_GATE = ["critical", "high"];

export const SECURITY_FIX_ROUNDS = Number(process.env.NANO_SECURITY_FIX_ROUNDS ?? 1);
export const MAX_CODER_SUBAGENTS = Number(process.env.NANO_MAX_CODER_SUBAGENTS ?? 4);

const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

/** Driver validation for the plan milestone. Returns { errors, warnings }. */
export function validatePlan(plan, spec) {
  const errors = [];
  const warnings = [];
  if (!plan?.divergence) {
    if (!Array.isArray(plan?.files) || plan.files.length === 0) {
      errors.push("plan lists zero files — every task needs real file assignments; infra/CI/docs are files too");
    }
    if (!Array.isArray(plan?.acceptance_criteria) || plan.acceptance_criteria.length === 0) {
      errors.push("plan has no acceptance_criteria");
    }
  }
  if (spec?.acceptance_criteria?.length && Array.isArray(plan?.acceptance_criteria)) {
    const norm = (s) => String(s ?? "").toLowerCase().replace(/\s+/g, " ").trim();
    const planCrit = plan.acceptance_criteria.map(norm);
    const missing = spec.acceptance_criteria.filter(
      (c) => !planCrit.some((p) => p.includes(norm(c)) || norm(c).includes(p)),
    );
    if (missing.length) {
      warnings.push(
        `${missing.length} spec criterion(ia) not carried verbatim into the plan (the verifier still gates on the spec): ${missing.slice(0, 3).map((m) => `"${String(m).slice(0, 60)}"`).join("; ")}`,
      );
    }
  }
  return { errors, warnings };
}

/** Driver validation for the tasks milestone. Returns { errors, warnings }.
 *  The file-overlap⇒dependency rule replaces v1's compile-time counterpart rule. */
export function validateTasks(tasks, plan) {
  const errors = [];
  const warnings = [];
  const list = tasks?.tasks;
  if (!Array.isArray(list) || list.length === 0) {
    return { errors: ["no tasks submitted"], warnings };
  }
  const ids = new Set();
  for (const t of list) {
    if (!t?.id || !SLUG_RE.test(t.id)) errors.push(`task id "${t?.id}" is not a lowercase slug (a-z0-9-)`);
    if (ids.has(t?.id)) errors.push(`duplicate task id "${t?.id}"`);
    ids.add(t?.id);
    if (!Array.isArray(t?.files) || t.files.length === 0) errors.push(`task "${t?.id}" lists zero files`);
    if (!Array.isArray(t?.acceptance_criteria) || t.acceptance_criteria.length === 0) {
      errors.push(`task "${t?.id}" has no acceptance criteria`);
    }
  }
  // dependencies: exist + acyclic (DFS)
  const byId = new Map(list.map((t) => [t.id, t]));
  for (const t of list) {
    for (const d of t.dependsOn ?? []) {
      if (!byId.has(d)) errors.push(`task "${t.id}" depends on unknown "${d}"`);
      if (d === t.id) errors.push(`task "${t.id}" depends on itself`);
    }
  }
  const mark = {};
  const visit = (id) => {
    if (mark[id] === 2) return;
    if (mark[id] === 1) {
      errors.push(`task dependency cycle at "${id}"`);
      return;
    }
    mark[id] = 1;
    for (const d of byId.get(id)?.dependsOn ?? []) if (byId.has(d)) visit(d);
    mark[id] = 2;
  };
  for (const t of list) visit(t.id);
  // file-overlap rule: shared file ⇒ one must depend on the other (transitively)
  const norm = (p) => pathNormalize(String(p));
  const reaches = (from, to, seen = new Set()) => {
    if (from === to) return true;
    if (seen.has(from)) return false;
    seen.add(from);
    return (byId.get(from)?.dependsOn ?? []).some((d) => byId.has(d) && reaches(d, to, seen));
  };
  const fileOwners = new Map();
  for (const t of list) {
    for (const f of t.files ?? []) {
      const k = norm(f);
      fileOwners.set(k, [...(fileOwners.get(k) ?? []), t.id]);
    }
  }
  for (const [file, owners] of fileOwners) {
    if (owners.length > 1) {
      const ordered = owners.some((a) => owners.filter((b) => b !== a).every((b) => reaches(a, b)));
      if (!ordered) {
        errors.push(
          `file "${file}" is shared by tasks [${owners.join(", ")}] without a dependency edge between them — shared files must be ordered: make one task dependOn the other`,
        );
      }
    }
  }
  // coverage vs the plan's file list (warn, never reject)
  if (plan?.files?.length) {
    const taskFiles = new Set([...fileOwners.keys()]);
    const planFiles = plan.files.map((f) => norm(f.path));
    const unassigned = planFiles.filter((p) => !taskFiles.has(p));
    if (unassigned.length) {
      warnings.push(`plan file(s) not owned by any task (work that may silently not happen): ${unassigned.slice(0, 5).join(", ")}`);
    }
    const stray = [...taskFiles].filter((f) => !planFiles.includes(f));
    if (stray.length) {
      warnings.push(`task file(s) not in the plan's file list: ${stray.slice(0, 5).join(", ")}`);
    }
  }
  return { errors, warnings };
}

// Minimal path normalize (no node:path import needed at module top — config is imported by web tooling too)
function pathNormalize(p) {
  return String(p).replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/g, "").toLowerCase();
}

// Fix-round budgets (driver-enforced).
export const MAX_FIX_ROUNDS = 2;
