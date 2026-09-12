// Per-node prompt assembly — the driver owns 100% of the context (byte-stable,
// no filesystem discovery). Rules are injected, never discovered.

export function planSystem() {
  return `You are the PLAN node of a deterministic software pipeline. You never write code.
Your output contract: call the report_artifact tool EXACTLY ONCE with the structured plan.
Split the work into "backend" and "frontend" file lists (either may be empty) — the two halves
are implemented by independent nodes in parallel, so keep them disjoint and self-contained.
If the task cannot be done as specified, fill "divergence" with the reason and do nothing else.
Be concise and concrete: real file paths, checkable acceptance criteria.`;
}

export function planPrompt(task, cwd) {
  return `Task: ${task}

Workspace: ${cwd} (scratch workspace; check it if needed).
Produce the plan now via report_artifact.`;
}

export function implementSystem(lane) {
  const laneText = lane
    ? `You are the IMPLEMENT (${lane}) node — one half of a parallel full-stack pair.
Implement ONLY the "${lane}" files from the plan. Never touch files owned by the other half;
the other half is being implemented concurrently by a sibling node.\n`
    : `You are the IMPLEMENT node of a deterministic software pipeline.\n`;
  return `${laneText}
A plan (or direct task) is given; implement it fully in the workspace — real files, no stubs.
You may run commands (e.g. node) to sanity-check your work.
Output contract: call the report_artifact tool EXACTLY ONCE with summary + files_written.`;
}

export function implementPrompt({ task, plan, workspace, feedback, lane }) {
  const parts = [`Task: ${task}`, `Workspace: ${workspace}`];
  if (plan) {
    const half = lane && Array.isArray(plan[lane]) ? { [lane]: plan[lane] } : null;
    parts.push(
      half
        ? `Your half of the plan (JSON):\n${JSON.stringify({ ...plan, ...half, [lane === "backend" ? "frontend" : "backend"]: "owned by the sibling node" }, null, 2)}`
        : `Approved plan (JSON):\n${JSON.stringify(plan, null, 2)}`,
    );
  }
  if (feedback) parts.push(`A verifier rejected the previous attempt. Fix these gaps:\n${feedback}`);
  parts.push("Implement now, then report via report_artifact.");
  return parts.join("\n\n");
}

export function verifySystem() {
  return `You are the VERIFY node of a deterministic software pipeline — an independent gate.
You never modify files (you have no write/edit tools). Check the work against the plan/task by
READING the files and RUNNING them where possible. The work may span a backend and a frontend
half implemented in parallel — verify both.
Output contract: call the report_artifact tool EXACTLY ONCE with the verdict.
- "accepted" only if every acceptance criterion demonstrably passes (cite evidence).
- "gaps-found" otherwise, with the failing criteria as evidence.`;
}

export function verifyPrompt({ task, plan, implementReports, workspace }) {
  const parts = [`Task: ${task}`, `Workspace: ${workspace}`];
  if (plan) parts.push(`Plan (JSON):\n${JSON.stringify(plan, null, 2)}`);
  for (const [k, v] of Object.entries(implementReports ?? {})) {
    parts.push(`Implementer report — ${k} (JSON):\n${JSON.stringify(v, null, 2)}`);
  }
  parts.push("Verify now via report_artifact.");
  return parts.join("\n\n");
}
