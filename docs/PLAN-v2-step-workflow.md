# nano-cycle v2 — The Four-Step Workflow

**Status:** IMPLEMENTED on branch `v2-step-workflow` — live V1/V2 passed, remaining live validation (V3–V12) is the owner's: see `docs/V2-VALIDATION.md`
**Supersedes:** the tier/DAG pipeline engine (`host/pipeline.mjs`)
**Evidence base:** `PIPELINE-VS-REFERENCE-ROOT-CAUSE-ANALYSIS.md` (RC1–RC10), `comparison.md`, five runs of forensics, and the A/B finding that single-prompting with frontier models matches the multi-node pipeline.

---

## 1. What we are building and why

Testing showed that with modern frontier models and large context windows, the node-graph pipeline (plan node → parallel coder nodes → verify node → audit node, thin JSON relays between fresh sessions) provides no significant benefit over a single well-prompted coding agent. The forensics say why: the value was never in the sequencing — it was in the **gates, mechanical ground truth, and contract flow** (RC8, RC10: "determinism at the gates, context at the desk").

v2 collapses the engine to **four steps, each a fresh Pi instance**, with micro-steps as **skills** and **milestone tools**:

```txt
Step 1 (clarify)        Step 2 (build)                     Step 3 (verify)            Step 4 (security, optional)
PM clarification loop → plan → [owner gate] → tasks →  →   verify code → audit      →  security scan → VAPT
one session per         implement (subagents only            deliverables against       (deterministic scanners +
round, human-gated      when necessary), ONE                 requirements                model triage)
                        persistent session
                                 ↑                                                              |
                                 └──────────── fix loop (resume Step 2 session) ────────────────┘
```

| # | Step | Pi instances | Micro-steps (skills) | Tools |
|---|------|--------------|----------------------|-------|
| 1 | **Clarify** (optional, default ON) | one short-lived session per Q&A round (unchanged) | — (method lives in system prompt, as today) | read-only + `investigate` + web + `ask_questions`/`finalize_spec` |
| 2 | **Build** | **ONE persistent session** for the whole run (incl. fix rounds) | 2.1 plan · 2.2 task-breakdown · 2.3 implement | full write + milestone tools + `dispatch_coder` subagents |
| 3 | **Verify** | one fresh session per verification round | 3.1 verify code · 3.2 audit deliverables | read + bash + browser; **no write/edit** |
| 4 | **Security** (optional) | one fresh session per scan round | 4.1 security scan · 4.2 VAPT | read + bash + scanner tool |

**The constitutional rule (unchanged from v1, now explicit): skills own method, the driver owns law.**
Skills are advisory how-to manuals. The driver enforces: human gates, milestone existence and schema, mechanical checks, verdict reconciliation, remote CI, git integration, fix-round bounds, severity gating. Nothing the model can say overrules a driver-observed failure.

### The five agreed amendments (from the design review)

1. **Fix loop resumes Step 2's session** — verify (Step 3) and security (Step 4) findings are appended to the *same* build session as a feedback turn; the original builder context fixes its own work. Fresh build session only as corruption fallback.
2. **Audit ordering inside Step 3** — the audit phase must re-read source docs and the spec *before* looking at its own verify results; verify output is framed as claims to re-derive, not evidence.
3. **Step 4 determinism** — scanners (gitleaks, npm audit, semgrep/trivy when available) run driver/skill-script-side; the model only triages. Severity-gated blocking; unfixable-in-scope findings defer to an owner gate, never deadlock the run.
4. **Milestone artifacts + plan gate + git commits survive inside Step 2** — plan/tasks/impl-delta are schema'd tool submissions persisted to the run dir; the plan-approval human gate blocks inside the `submit_plan` tool; git commits land per milestone.
5. **Subagent policy lives in the task-breakdown skill** — file-disjoint, individually substantial tasks → parallel `dispatch_coder` subagents; shared/hot files → sequential work in the main context.

### What is deleted vs kept

| Kept (empirically earned) | Deleted (low ROI at frontier-model class) |
|---|---|
| Clarify loop + answers gate + `investigate` analyst | Tier DAGs (demo/S/M/L) and the tier compiler |
| Spec store (`runs/<id>/state.json`, `/api/specs/:project`) | Wave scheduler, lane packing, hot-file serialization |
| `checks.mjs` mechanical ground truth | Counterpart rule, `plan_caps` capability graphs |
| Verdict reconciliation (checks over verdicts, deferral) | Per-node model pickers → 4 per-step roles |
| Remote CI watch (`ci.mjs`), git integration (`git.mjs`) | Fix-round node requeue targeting → in-context fixing |
| State/events persistence, GUI streaming, cancel/resume | Per-ticket `verify-<cap>` gates |
| Bundled-skills loader, markdown-writer skill | `feedbackByNode`/`writtenFiles` node bookkeeping |
| Stall watchdog, process cleanup, orphan sweep | Mid-flight model restart (swap applies to not-yet-started steps) |

---

## 2. Target architecture

### 2.1 Step contracts (the only things that cross an instance boundary)

| Step | Consumes | Produces (milestone artifacts) |
|------|----------|-------------------------------|
| 1 Clarify | task, repo (read-only), web tools | `artifacts.spec` (summary, decisions, ACs, `ac_verification`, source_docs, out_of_scope) — unchanged schema |
| 2 Build | spec (verbatim ACs), source docs raw, repo rules, feedback turns | `artifacts.plan`, `artifacts.tasks`, `artifacts.implDelta` + **the code itself** |
| 3 Verify | spec, source docs raw, plan, tasks, impl-delta, driver mechanical+CI results | `artifacts.verify`, `artifacts.audit` |
| 4 Security | tree, prior reports, driver scanner output | `artifacts.security` |

All artifacts live in `runs/<id>/state.json` (as today) and are rendered to `runs/<id>/artifacts/<name>.md` for humans. **Nothing is written into the target repo except code and git commits.**

### 2.2 Run state v2

```jsonc
{
  "version": 2,
  "id": "...", "task": "...", "project": "...", "projectPath": "...", "createdAt": "...",
  "status": "running | awaiting-answers | awaiting-gate | completed | failed | cancelled | interrupted",
  "options": {
    "clarify": true, "requireQuestions": false, "approvePlan": true, "audit": true,
    "security": "off | scan | scan+vapt", "git": false, "remoteCi": false, "maxFixRounds": 2
  },
  "models": { "clarify": "...", "builder": "...", "verifier": "...", "security": "..." },
  "steps": [
    { "id": "clarify",  "status": "queued|running|done|failed|cancelled", "usage": {...},
      "startedAt": null, "endedAt": null, "durationMs": 0, "retries": 0, "error": null, "sessionFiles": [...] },
    { "id": "build",    "...": "...", "sessionFile": "runs/<id>/sessions/build-0.jsonl", "rounds": 0 },
    { "id": "verify",   "...": "...", "sessionFiles": ["verify-r0.jsonl", ...] },
    { "id": "security", "...": "..." }
  ],
  "round": 0,                       // current verify fix round
  "qa": [],                         // clarify Q&A (unchanged)
  "artifacts": { "spec": ..., "plan": ..., "tasks": ..., "implDelta": ..., "verify": ..., "audit": ..., "security": ... },
  "gate": null,                     // { type: "answers" | "plan-approval" | "divergence" | "security-override", ... }
  "pendingPlanApproval": null,
  "mechanicalChecks": ..., "remoteChecks": ..., "deferredChecks": ..., "scannerResults": ...,
  "git": { "enabled": ..., "baseBranch": ..., "runBranch": ..., "commits": [...], "merged": ..., "mergeError": ... },
  "error": null, "finishedAt": null, "gateWaitMs": 0, "gateSince": null
}
```

Event nodeIds become: `_run`, `clarify`, `build` (coder subagent events stream here with a `coder[<taskId>]:` notice prefix), `verify`, `security`.

### 2.3 The engine state machine (`host/engine.mjs`, replaces `pipeline.mjs`)

```txt
start() → validate options, git branch (if on), init state v2, execute()

execute():
  1  git: checkout run branch (resume safety — as today)
  2  if pendingPlanApproval → re-present gate (resume-after-cancel — as today)
  3  STEP 1  clarify (if options.clarify && !artifacts.spec)      [reuse, unchanged]
  4  STEP 2  build:
  4a    if !artifacts.implDelta:
        - get-or-create build session (SessionManager.open(sessionFile) on resume,
          else SessionManager.create(cwd, runs/<id>/sessions))
        - initial turn: builderPrompt(task, spec, sourceDocs, rules-in-system-prompt)
        - milestones arrive as tool calls: submit_plan (gate inside) → submit_tasks
          (driver validation) → submit_impl_delta (hard turn stop + git commit)
  5  STEP 3  verify loop (round = 0 .. options.maxFixRounds):
  5a    pre-flight: runMechanicalChecks (+ runRemoteCiGate when opted in; re-pushes
        each round, as today)
  5b    fresh verifier session → submits verify, then (if accepted) audit
  5c    reconcile: gating = failing verify checks (non-deferrable) + mechanical fails
        + red remote CI + blocking audit findings     [reuse reconcileVerify logic]
  5d    accepted → break; gaps → feedback turn into the BUILD session (5a of the
        next round re-checks everything)
  6  STEP 4  security (if options.security != "off"), one bounded fix round
        (NANO_SECURITY_FIX_ROUNDS, default 1):
  6a    pre-flight: driver scanner suite → scannerResults
  6b    fresh security session → triage + (if scan+vapt) VAPT method → submit_security
  6c    critical/high + fixable_in_scope → feedback turn into BUILD session → re-scan
  6d    critical/high + NOT fixable → security-override gate (owner accepts risk or
        the run fails); medium/low/info → recorded, non-gating
  7  finalize: status, honest failure reasons (reuse reason assembly), integrate(git)
```

Cancel/resume/gate/answer semantics carry over from v1: `finalizeCancel` aborts in-flight sessions (and **resolves** pending gate promises with `"cancel"` — fixing the v1 leak where `waitGate` could hang forever); resume re-enters `execute()`, which skips completed milestones via the `artifacts`/state checks above.

### 2.4 Milestone tools (the `report_artifact` successor)

Custom tools registered in the step session. Schemas validated by the SDK (typebox) before `execute` runs; driver-level validation results return **as the tool result text**, so correction happens in-session instead of via node retries.

| Tool | Step | Behavior |
|------|------|----------|
| `submit_plan` | 2 | Validate (see §2.5). If `divergence` → divergence gate. If `options.approvePlan` → plan-approval gate (blocks inside `execute` until the GUI answers). Returns `APPROVED — proceed to task breakdown…` / `REJECTED BY OWNER: <comments> — revise and resubmit` / `REJECTED: <driver validation reasons>`. |
| `submit_tasks` | 2 | Validate (§2.5). Returns acceptance summary + `proceed to implementation`. |
| `submit_impl_delta` | 2 | Record artifact → git commit (`feat:`/`fix:` per round) → **hard turn stop** (abort pattern from `ask_questions`) → returns `Recorded. Stop — verification begins.` |
| `submit_verify` | 3 | Driver reconciles immediately. Returns `VERIFY ACCEPTED — proceed to the audit phase…` or `GAPS RECORDED — fix round incoming; end your turn now` + hard turn stop (never audit a round that already failed). |
| `submit_audit` | 3 | Records; blocking findings reconciled after the session settles. |
| `submit_security` | 4 | Records; severity gating in the engine (§2.6). |
| `dispatch_coder` | 2 | Spawns a child builder session for ONE task (§2.7). |
| `run_scanners` | 4 | Re-invokes the driver scanner suite (for post-fix re-checks inside the session). |

The runner's existing "finished without calling the tool → one nudge retry" pattern applies to whichever milestone the step is currently awaiting.

### 2.5 Driver validation (replaces the counterpart rule / capability compiler)

`validatePlan(plan, spec)`:
- `files` non-empty unless `divergence`; `acceptance_criteria` non-empty.
- Spec-AC coverage warning (existing substring logic) — warn, never reject.

`validateTasks(tasks, plan)` — **rejections return through the tool result**:
- ≥1 task; ids are unique slugs; every task lists ≥1 file; `dependsOn` ids exist; no cycles (DFS, reuse); no self-deps.
- **File-overlap rule:** if two tasks share a file, one must `dependsOn` the other (else reject with the pair named) — this is the hot-file rule moved to plan time.
- Files referenced by tasks exist in the plan's file list (warn on strays).

### 2.6 Security gating (Step 4)

Scanner suite (driver-side, `skills/security-scan/scripts/run-scanners.mjs`, also callable via `run_scanners`):
- `gitleaks` — binary → pinned docker → skip (reuse `checks.mjs` resolution logic; the Step 3 `secrets-gitleaks` check result is also fed forward so nothing runs twice).
- `npm audit --json` (and `pnpm`/`yarn` equivalents when the lockfile says so) — fail on `critical|high` with a fix available.
- `semgrep --config auto` — when binary present, else recorded skip.
- `trivy` / compose image config scan — when binary + compose file present, else skip.
- Every scanner: `pass | fail | skip` + structured evidence. Skips never gate.

Model triage (the `security-scan` + `vapt` skills): classify findings, dedupe scanner noise, add manual findings (OWASP-derived probes for `scan+vapt`: security headers, CORS, error/stack leakage, authz spot checks on running endpoints when the stack boots), each with `severity` and `fixable_in_scope`.

Engine gate on `submit_security`:
- any `critical|high` with `fixable_in_scope: true` → **blocking** → fix round via the build session (bounded, §2.3 step 6c).
- any `critical|high` with `fixable_in_scope: false` → `security-override` gate: owner `approve` = accept risk, record, complete; `cancel` = run fails with the findings as reason.
- `medium|low|info` → recorded in `artifacts.security` + final notice, non-gating.

### 2.7 Coder subagents (`dispatch_coder`)

- Params: `{ task_id }` (the task comes from `artifacts.tasks`; optional `instructions` override).
- Child session: fresh, ephemeral, builder model, `thinking: high`, tools `read/write/edit/bash + report_artifact` (implement schema).
- Child prompt: task (title, description, files, per-task ACs) + spec ACs verbatim + source-doc text + the same rules context as the builder + `previous attempt` on re-dispatch.
- Caps: `NANO_MAX_CODER_SUBAGENTS` concurrent (default 4), total 8 per round — enforced in the tool, excess calls return "defer — dispatch later".
- Events stream under `build` with `coder[<taskId>]:` notices; the child's `files_written` merge into the impl-delta commit set.
- The task-breakdown skill defines WHEN to dispatch (disjoint + substantial → parallel; overlapping/sequential → do it yourself in-context).

### 2.8 Model roles (per step, not per node)

`MODEL_ROLES` v2: `clarify: "PM (clarify)"`, `builder: "Builder"`, `verifier: "Verifier"`, `security: "Security"`. Thinking `high` for all (unchanged). Mid-run swaps apply to steps that have not started; a running step keeps its model (the v1 mid-flight restart machinery is deliberately dropped — one persistent session must not change models mid-context).

### 2.9 Rules injection (`rules.mjs`, step-based)

| Step | Injected context |
|------|------------------|
| clarify | AGENTS/CLAUDE (as today) |
| build (+ coder children) | AGENTS/CLAUDE + backend + frontend + security + testing + git rule files (the builder is one context; the lane split is gone) |
| verify | AGENTS/CLAUDE + all five rule files (as today's verify) |
| security | AGENTS/CLAUDE + security-rules |

Precedence (`.claude/` over `.pi/`), 20k/file cap, `.pi/AGENTS.md` fallback — all unchanged.

### 2.10 Skills (`skills/`, loaded per step via `skillsOverride` filtering)

| Skill | Injected into | Content source |
|-------|---------------|----------------|
| `planning` | build | `planSystem`/`planCapsSystem` prompts: investigate first, functional task shape, file lists mandatory, divergence protocol, AC carry-through |
| `task-breakdown` | build | task decomposition rules + per-task ACs + dependsOn + overlap rule + **the dispatch policy** (§2.7) |
| `implementation` | build | `IMPLEMENT_RULES` + `implementSystem`: full mandate, no stubs, failure paths, lint/tests before reporting, impl-delta discipline |
| `verification` | verify | `verifySystem`: assume-unmet-until-observed, runtime/cold-boot/journey/negative/depth methods, evidence standard |
| `audit-deliverables` | verify | `auditSystem` + **amendment 2**: re-read source docs and spec FIRST, treat own verify checks as claims, requirement-conformity both directions |
| `security-scan` | security | scanner usage + triage method + severity classification + `scripts/run-scanners.mjs` |
| `vapt` | security (only when `scan+vapt`) | running-app assessment: boot, probe, OWASP-derived local checklist, scope honesty, evidence capture |
| `markdown-writer` | all steps | unchanged |

Each step's **system prompt** (the law) mandates the phase order and *forces* loading the skill at each phase start ("read `<skill-dir>/SKILL.md` before starting phase X") — skill descriptions alone must not be the trigger for mandatory phases. Driver-side, a milestone submitted without its phase is still schema-validated, so a skipped skill degrades quality, not correctness.

### 2.11 Session persistence (`runner.mjs` extension)

- `SessionManager.create(cwd, sessionDir)` with `sessionDir = runs/<id>/sessions/` → new persistent session; record its file path into the step state.
- Resume: `SessionManager.open(sessionFile)`. System prompt comes from the `DefaultResourceLoader` override (same builder prompt re-supplied), so a resumed session is indistinguishable from the live one.
- Verify/security/clarify sessions are persisted too (audit trail, near-zero cost).
- **Spike first** (TODO 2): confirm file-path retrieval, resume fidelity, blocking-tool + abort interplay, and that `systemPromptOverride` applies on resumed sessions.

### 2.12 Compaction insurance

Long build sessions may auto-compact. Every feedback turn into the build session re-states the durable spine (plan summary + task list + spec ACs) in the turn header, and the implementation skill mandates re-reading key files before editing after any long gap. Artifacts on disk (`state.json`) remain the source of truth for the driver regardless.

---

## 3. Server API changes

| Endpoint | Change |
|---|---|
| `POST /api/runs` | drop `tier`; add `security: "off"\|"scan"\|"scan+vapt"`; `models` keys = 4 roles; keep `clarify`, `requireQuestions`, `maxFixRounds`, `git`, `audit`, `approvePlan`, `remoteChecks` |
| `GET /api/roles` | returns the 4 v2 roles |
| `GET /api/tiers` | removed at cleanup (returns `{}` during migration) |
| `POST /api/runs/:id/gate` | unchanged wire format; now also serves `security-override` |
| `POST /api/runs/:id/model` | body `{ step, model }`; applies to not-yet-started steps |
| `POST /api/runs/:id/answers`, `/cancel`, `/resume`, `GET /api/runs/:id`, `/api/specs/:project` | unchanged (spec endpoint reads `artifacts.spec`, present in v2) |

v1 runs: listed and viewable (state/events readers are shape-agnostic); `resume` returns 409 `legacy run — not resumable by the step engine`. The boot-time orphan sweep marks v1 `running` states `interrupted`, as today.

## 4. GUI changes

- `api.ts`: `RunState` v2 types (`steps` instead of `nodes`; `options.security`); start payload without tier, with security.
- `StartForm`/`NewRunModal`: remove tier picker; add **Security** select (Off / Scan / Scan + VAPT); 4 model pickers + master chooser.
- `lib/pipeline.ts`: `orderedSteps()` (clarify → build → verify → security; falls back to legacy `nodes` rendering for v1 runs), step metadata, remove coder helpers.
- `PipelineLanes` → **StepTimeline**: four step cards with status, usage, rounds counter (build: `round N`), gate badge.
- `GatePanel`: keep `answers`, `plan-approval`, `divergence`; add **`security-override`** (findings table + Accept risk / Cancel).
- `Workbench` Artifacts tab: add `tasks`, `implDelta`, `security`, `scannerResults`; keep spec/qa/plan/verify/audit/mechanical/deferred/remote.

## 5. Test plan

**Unit / script tests** (`node --test` or plain assert scripts, no framework needed):
1. `validatePlan` / `validateTasks`: overlap-without-dep rejection, cycle rejection, stray-file warning, empty-file-list rejection.
2. Severity gating: fixable→blocking, unfixable→override gate, medium→record.
3. Reconciliation reuse on a synthetic verify artifact + mechanical fails (existing `__internals` tests port).
4. Feedback-turn formatting (gap → owning task mapping via `pathTokensIn` against task file lists).

**Spike (TODO 2, before any engine work):** persistent-session probe script proving create → prompt → reopen → prompt retains context; blocking tool execute while a gate waits; abort during blocked tool; file-path retrieval.

**Live validation (sandbox + scratch repo, after GUI build):**

| # | Scenario | Pass criteria |
|---|----------|---------------|
| V1 | Small feature, clarify OFF, security OFF, git OFF | plan → tasks → impl → verify+audit accepted; artifacts + steps in state; run completes |
| V2 | Clarify ON | ≥1 question round answered in GUI; spec locked; spec flows verbatim into build + verify prompts |
| V3 | Plan gate reject | owner rejects with comments → build session revises plan in the SAME session (check events) → resubmit → approved |
| V4 | Divergence | plan divergence → gate → approve-anyway continues / cancel stops |
| V5 | Forced mechanical failure | plant an undeclared import → verify round 0 gates → **fix round resumes the build session** (same session file, no fresh exploration burst) → round 1 green |
| V6 | Audit blocking finding | fixture where verify passes but audit blocks → fix round → accepted |
| V7 | Security scan | project with planted secret → gitleaks fails → blocking → fix round → re-scan pass; `scan+vapt` on a bootable stack exercises running-app probes |
| V8 | Unfixable security finding | e.g. high dep vuln with no fix → security-override gate → accept → completed with recorded risk |
| V9 | Cancel mid-build → resume | session resumed from disk (verify session continuity in events), milestones intact |
| V10 | Cancel at plan gate → resume | gate re-presented (the v1 FIX-REPORT regression must stay fixed) |
| V11 | Git-on run (scratch repo) | `feat:` commit at impl-delta, `fix:` commit after fix round, ff-merge on accept, branch kept on fail |
| V12 | maxFixRounds exhaustion | honest failure with assembled reasons in `state.error` |

**Process discipline (from Track 0):** implement on a branch; do not delete `pipeline.mjs` until V1–V12 pass; keep the working tree committed per milestone of this plan itself.

---

## 6. TODO — sequenced implementation checklist

> Strictly ordered. Each item is completable with only the items above it. "Done when" is the acceptance check.

### Phase 0 — Groundwork

- [x] **1. Branch + docs**
  - `git checkout -b v2-step-workflow`; commit this plan (`docs/PLAN-v2-step-workflow.md`).
  - Done when: branch exists, plan committed.

- [x] **2. SDK persistence spike** (`spike/session-persistence.mjs`, scratch, not wired to the server)
  - Prove: (a) `SessionManager.create(cwd, sessionDir)` persists and the file path is retrievable (inspect the manager/session object); (b) `SessionManager.open(path)` + `createAgentSession` resumes with full context (ask a factual question, close, reopen, ask a dependent question); (c) a custom tool whose `execute` blocks on an external promise works mid-turn and the model continues with its result; (d) `session.abort()` during the blocked tool settles cleanly; (e) `systemPromptOverride` applies to resumed sessions.
  - Done when: script runs green and the exact retrieval API is written down in this file's margin (or a `docs/SPIKE-NOTES.md`).

### Phase 1 — Skills (pure content, no host changes)

- [x] **3. `skills/planning/SKILL.md`** — migrate `planSystem` + `planCapsSystem` content into skill form: investigate-first, task-shaped decomposition, mandatory file lists with purposes, functional (not web-specific) lane language dropped in favor of tasks, divergence protocol, "carry every spec AC verbatim".
  - Done when: skill frontmatter valid (name/description), content covers the listed points, `loadSkillsFromDir` picks it up (quick node probe).
- [x] **4. `skills/task-breakdown/SKILL.md`** — decomposition rules (2–8 tasks, per-task ACs, dependsOn semantics, file-overlap⇒dependency rule), sizes, and the **dispatch policy**: parallel `dispatch_coder` for file-disjoint substantial tasks, sequential in-context otherwise, re-dispatch with previous attempt on fix rounds.
  - Done when: as above.
- [x] **5. `skills/implementation/SKILL.md`** — `IMPLEMENT_RULES` + `implementSystem` merged: full mandate, no stubs/TODOs, failure-path tests, lint+test before reporting, stay within task files, honest impl-delta (`task_completion` per task).
  - Done when: as above.
- [x] **6. `skills/verification/SKILL.md`** — migrate `verifySystem` verbatim-in-substance: assume-unmet standard, runtime/cold-boot/user-journey/negative/universal/version/test-ship/test-depth methods, evidence discipline, mechanical results are ground truth.
  - Done when: as above.
- [x] **7. `skills/audit-deliverables/SKILL.md`** — migrate `auditSystem` + amendment 2: **re-read source docs + spec BEFORE verify results**, verify checks are claims, requirement-conformity in both directions (doc→impl, plan→impl), locked decisions, blocking semantics, impl-delta cross-check.
  - Done when: as above.
- [x] **8. `skills/security-scan/SKILL.md` + `scripts/run-scanners.mjs`** — scanner suite (gitleaks binary→docker→skip; `npm audit --json` (+pnpm/yarn by lockfile); semgrep/trivy when present, else recorded skip) emitting JSON `{scanners: [{id, status, evidence, findings}]}`; triage method: severity classes, false-positive discipline, `fixable_in_scope` definition.
  - Done when: `node skills/security-scan/scripts/run-scanners.mjs <dir>` runs standalone on a fixture with a planted secret (gitleaks fails) and on a clean tree (passes/skips honestly).
- [x] **9. `skills/vapt/SKILL.md`** — running-app method: boot via documented commands, endpoint/header/CORS/error-leakage/authz probes, OWASP-derived checklist with concrete commands, "scope honesty" (what a local VAPT is and is not), evidence capture into findings.
  - Done when: as above.

### Phase 2 — Configuration (additive)

- [x] **10. `host/config.mjs` v2 additions** — `MILESTONE_SCHEMAS` (`plan`, `tasks`, `implDelta`, `security`; reuse existing `verify`/`audit`/`questions`/`spec` schemas), `STEP_PROFILES` (tools/thinking per step: clarify unchanged; build full-write + custom tools; verify read+bash+browser; security read+bash), `MODEL_ROLES` v2, `SEVERITY_GATE = ["critical","high"]`. Export `validatePlan`/`validateTasks` (pure functions, §2.5). Nothing v1 is removed yet.
  - Done when: `node --check` passes; a small test script exercises validateTasks rejections (overlap-without-dep, cycle, unknown dep).

### Phase 3 — Runner (additive)

- [x] **11. Per-step skill filtering in `host/runner.mjs`** — `skillsOverride` filters bundled skills by step allowlist (`clarify: [markdown-writer]`, `build: [planning, task-breakdown, implementation, markdown-writer]`, `verify: [verification, audit-deliverables, markdown-writer]`, `security: [security-scan, vapt, markdown-writer]`). Skill dirs must be resolvable to absolute paths in the system prompt instruction ("read `<abs>/SKILL.md`") — expose a `skillDir(name)` helper.
  - Done when: probe script creates a session for a fake step and the system prompt's skill listing contains exactly the allowlisted skills.
- [x] **12. Persistent step sessions in `host/runner.mjs`** — new `openStepSession({ stepId, runDir, tools, customTools, systemPrompt, cwd, modelSpec, modelRuntime, thinking, onEvent, signal })`: creates (`SessionManager.create(cwd, runs/<id>/sessions)`) or opens (`SessionManager.open(sessionFile)`) a persistent session using the spike-verified API; returns `{ session, sessionFile, prompt(text), abort() }` with the stall watchdog + event normalization factored out of `runNode` (shared helper). `runNode` keeps working for clarify rounds/analyst/coder children (unchanged behavior).
  - Done when: probe script: open → prompt → close handle → reopen from file → prompt; context continuity verified; watchdog fires on a stalled fake.

### Phase 4 — Prompts (additive)

- [x] **13. `host/prompts.mjs` v2 additions** — `builderSystem(rulesCtx)` (workflow law: phases in order, forced skill loads with abs paths, milestone-tool contracts, dispatch policy pointer, compaction discipline), `builderPrompt({task, workspace, spec, sourceDocText, feedbackTurn?})`, `verifierSystem(rulesCtx)` (phases: verification skill → submit_verify → only-if-accepted audit phase; read-only stance; no source edits, scratch in /tmp only), `verifierPrompt({task, workspace, spec, sourceDocText, acVerification, plan, tasks, implDelta, mechanicalResults, remotePolicy, remoteResults})`, `securitySystem(rulesCtx)` + `securityPrompt({workspace, scannerResults, priorReports, vapt: bool})`. Existing clarify functions unchanged; v1 functions untouched until cleanup.
  - Done when: `node --check` + a render test prints each prompt with a fixture spec/mechanical results and a reviewer pass confirms the contract blocks (ACs verbatim, source docs raw, mechanical ground truth) are present.

### Phase 5 — Rules (additive)

- [x] **14. `host/rules.mjs` step support** — `stepContextFiles(projectPath, stepId)` + `loadStepContext(...)` per the §2.9 matrix (build/verify get all five rule files; security gets AGENTS + security-rules; clarify AGENTS only). Node-based functions remain for v1 until cleanup.
  - Done when: probe against a fixture project with `.claude/rules/*` returns the right file sets per step.

### Phase 6 — Engine (new file, not yet wired)

- [x] **15. `host/engine.mjs` — core skeleton** — `createEngine({ modelRuntime, emit, webTools })` with the v2 state shape, `start()` (options validation, git branch setup via `git.mjs`, one-active-run-per-project guard), `execute()` step sequencing per §2.3, step status bookkeeping (`beginStep/endStep`), cancel/finalizeCancel (aborts sessions, **resolves** pending gates with `"cancel"`), gate/answer plumbing (`waitGate`, answers resolver — ported), resume entry, `activeRunFor`. Reuse from pipeline.mjs where literal: `specIntoPrompt`, `loadSourceDocs`/`sourceDocsFor`, `matchAcVerification`, `ENV_LIMIT_RE`, `pathTokensIn`, `commitSuffixFor`, failure-reason assembly, `reconcileVerify` (extended with audit-blocking + security inputs), `runMechanicalGate`, `runRemoteCiGate`, `integrate`.
  - Done when: `node --check`; a dry-run with stub sessions walks clarify-off → build → verify → done in a unit harness (fake `openStepSession` injected via a parameter).
- [x] **16. Milestone tools + in-tool gates** — `makeMilestoneTools(run, engine)` per §2.4: submit_plan (validation + divergence gate + plan-approval gate blocking in execute, results as tool text), submit_tasks (validation), submit_impl_delta (record + commit + hard stop), submit_verify (reconcile + accept/gap text + hard stop), submit_audit, submit_security (record only). `pendingPlanApproval` stash for resume-at-gate.
  - Done when: unit harness drives each tool with fixtures (approve/reject/diverge/gap paths) and state transitions correctly.
- [x] **17. Build-step session lifecycle** — get-or-create build session (§2.11), initial `builderPrompt` turn, feedback turns for fix rounds (gap list formatted per §2.3 5d with owning-task mapping via `pathTokensIn` against `artifacts.tasks` files; plan/tasks/spec re-stated in the turn header for compaction insurance), `feat:`/`fix:` milestone commits, session file recorded in state; corruption fallback (new session file indexed `-1`, `-2`).
  - Done when: unit harness simulates round-0 gap → feedback turn → round-1 accept across a real persistent session file.
- [x] **18. Verify loop** — per-round fresh verifier session (tools: read/grep/find/ls/bash + web_reader when available + submit tools), pre-flight mechanical + remote CI, submit_verify/submit_audit flow, reconciliation, bounded rounds, honest failure assembly.
  - Done when: unit harness with fake verifier output covers accepted / verify-gap / audit-blocking / exhausted-rounds paths.
- [x] **19. Security step** — pre-flight scanner execution (invoke `run-scanners.mjs` as a child process, structured output into `state.scannerResults`), fresh security session, `run_scanners` + `submit_security` tools, severity gating per §2.6, security-override gate, bounded security fix round (`NANO_SECURITY_FIX_ROUNDS`, default 1).
  - Done when: unit harness covers fixable-blocking / unfixable-override / medium-non-gating paths.
- [x] **20. `dispatch_coder`** — child session spawner per §2.7 (builder model, write tools, task-scoped prompt with rules context, caps via env), events under `build`, `files_written` merged into the commit set.
  - Done when: sandbox probe — a fake build session dispatches two tasks, children write files, events + commit reflect both.

### Phase 7 — Server switch

- [x] **21. `host/server.mjs` → engine** — import `createEngine`; `POST /api/runs` builds v2 options (security select, 4 model roles, no tier); `/api/roles` returns v2; `/model` accepts step ids; `/api/tiers` temporarily `{}`; gate/answers/cancel/resume wire to the engine's identical API surface; boot orphan sweep handles v2 statuses (same list).
  - Done when: server boots; `curl` start (clarify off, security off) against the sandbox reaches the build step events; v1 run GET still renders.

### Phase 8 — GUI

- [x] **22. `web/src/api.ts`** — v2 types (`steps`, `options.security`, gate union + `security-override`), start payload, remove tier fetch.
  - Done when: `npm run build` passes with updated consumers.
- [x] **23. `StartForm`/`NewRunModal` + `ModelPicker`** — security select (Off/Scan/Scan+VAPT), 4 role pickers + master, localStorage keys migrated (fallback to old keys → `auto`).
  - Done when: a start payload from the GUI produces a v2 run server-side.
- [x] **24. `lib/pipeline.ts` + `PipelineLanes` → StepTimeline** — ordered steps, rounds counter, gate badge, legacy fallback for v1 runs.
  - Done when: V1-style run renders four step cards; an old v1 run still renders read-only.
- [x] **25. `GatePanel` security-override + `Workbench` artifacts** — findings table with Accept-risk/Cancel; artifacts tab gains tasks/implDelta/security/scannerResults.
  - Done when: `npm run build` green; manual click-through of each gate type against a paused live run.

### Phase 9 — Live validation (V1–V12 of §5)

- [~] **26. Happy paths (V1, V2, V3, V4)** — V1 ✅ (dev `20260920-154407664` + owner-validated `20260920-194320256`, 11/11) V2 ✅ (dev `20260920-155539141` + owner-validated `20260920-204148298` post-watchdog-fix) live-passed 2026-09-20 (glm-5.3-flash); V3/V4 harness-covered — **live runs deferred to owner** (docs/V2-VALIDATION.md).
- [~] **27. Fix-loop paths (V5, V6)** — harness-covered (13/13, session-identity asserted); **live runs deferred to owner** (V5 fixture: plant violations INSIDE the project — see runbook).
- [~] **28. Security paths (V7, V8)** — override gate observed live (run 20260920-161038752, out-of-scope secret classified honestly); fixable-secret fix loop **deferred to owner** (V7).
- [~] **29. Lifecycle paths (V9–V12)** — V10 harness-covered; V9/V11/V12 **deferred to owner** (runbook §V9–V12).

### Phase 10 — Cleanup & docs

- [x] **30. Delete v1 engine code** — remove `host/pipeline.mjs`; strip `TIERS`, `NODE_PROFILES`, `profileFor`, `roleOf`, `LEGAL_SINGLE_SIDES`, `plan_caps` schema, v1 prompt functions (`planSystem`…`auditPrompt` non-clarify), node-based rules functions, `/api/tiers`. Grep for dead references.
  - Done when: `node --check host/*.mjs` clean; server boots; a V1-style smoke run still completes.
- [x] **31. README rewrite** — two-phase/four-step flow, skills-vs-law table, security step, session persistence + fix-loop description, updated env vars (`NANO_MAX_CODER_SUBAGENTS`, `NANO_SECURITY_FIX_ROUNDS` documented alongside existing), GUI screenshots updated.
  - Done when: README describes only what ships.
- [ ] **32. Final merge + tag** — BLOCKED ON OWNER VALIDATION (V3–V12 per docs/V2-VALIDATION.md): merge `v2-step-workflow` to main; tag `v2.0.0`. The v1 engine remains retrievable in git history (last on main @ 90d2505).

---

## 7. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Model skips a mandatory skill/phase | System prompt forces skill loads; milestone tools are the enforcement (no artifact → gate never opens); nudge-retry pattern |
| Build session degrades over very long features (compaction) | Feedback turns re-state plan/tasks/spec; artifacts on disk are truth; `dispatch_coder` offloads bulk writing to fresh child contexts |
| Blocking gate inside a tool + cancel races | Spike (TODO 2e); finalizeCancel resolves gates with `"cancel"` and aborts sessions; V9/V10 regression scenarios |
| Verify anchors on its own earlier round | Each round is a FRESH session (only the build session persists) |
| Security false positives burn fix rounds | Scanners degrade to recorded skips; `fixable_in_scope` + owner override; single bounded security round |
| Persistent-session API assumptions wrong | Phase 0 spike precedes all engine work; fallback = fresh build session with artifacts injected (documented degrade path) |
| GUI/model-pick regression for mid-run swaps | Accepted scope cut: swaps apply to unstarted steps only (§2.8) |

## 8. Out of scope (deliberate)

- Worktree isolation for parallel coder subagents (hot-file rule at plan time + sequential dispatch is the mitigation; revisit only if collisions reappear).
- The Track-3 A/B scoreboard harness (recommended as a follow-up once v2 is stable; the old engine stays in git history for comparison).
- Per-ticket verification inside Step 2 (task-level ACs + the single deep verify step replace it; revisit if large features show verify shallowness).
