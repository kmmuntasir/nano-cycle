// Engine v2 — the four-step workflow state machine (docs/PLAN-v2-step-workflow.md).
//
//   Step 1 clarify  — PM loop, one short session per Q&A round (lifted from v1)
//   Step 2 build    — ONE persistent session: plan → tasks → implement
//   Step 3 verify   — fresh session per round: verify → audit
//   Step 4 security — optional fresh session: scanner triage (+ VAPT)
//
// Fix loops RESUME the build session (amendment 1). The driver owns law:
// human gates, milestone schemas/validation, mechanical checks, remote CI,
// verdict reconciliation, severity gating, git. Skills own method.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import {
  ARTIFACT_SCHEMAS,
  MILESTONE_SCHEMAS,
  STEP_PROFILES,
  SEVERITY_GATE,
  SECURITY_FIX_ROUNDS,
  MAX_CODER_SUBAGENTS,
  MAX_FIX_ROUNDS,
  validatePlan,
  validateTasks,
} from "./config.mjs";
import { loadStepContext } from "./rules.mjs";
import {
  clarifySystem,
  clarifyPrompt,
  builderSystem,
  builderPrompt,
  builderFeedbackTurn,
  verifierSystem,
  verifierPrompt,
  securitySystem,
  securityPrompt,
} from "./prompts.mjs";
import { runNode, openStepSession, makeTool, addUsage, skillDirFor } from "./runner.mjs";
import { runMechanicalChecks } from "./checks.mjs";
import { detectCiCapability, watchRunsForSha } from "./ci.mjs";
import * as git from "./git.mjs";
import { killRunProcesses } from "./prockill.mjs";
import { runDir } from "./state.mjs";
import { resolveProject } from "./projects.mjs";

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCANNER_SCRIPT = path.join(ROOT_DIR, "skills", "security-scan", "scripts", "run-scanners.mjs");
const SKILL_DIRS = {
  planning: skillDirFor("planning"),
  taskBreakdown: skillDirFor("task-breakdown"),
  implementation: skillDirFor("implementation"),
  verification: skillDirFor("verification"),
  auditDeliverables: skillDirFor("audit-deliverables"),
  securityScan: skillDirFor("security-scan"),
  vapt: skillDirFor("vapt"),
};

// --- shared helpers (lifted from v1 pipeline.mjs where noted) ------------------

const pathKey = (p) => path.normalize(p).toLowerCase();

// Spec AC verification-environment matching (v1, verbatim behavior).
function matchAcVerification(acVerification, criterion) {
  const list = Array.isArray(acVerification) ? acVerification : [];
  const norm = (s) => String(s ?? "").toLowerCase().replace(/\s+/g, " ").trim();
  const target = norm(criterion);
  if (!target) return null;
  let hit = list.find((a) => norm(a.criterion) === target);
  if (!hit) {
    hit = list.find((a) => norm(a.criterion).includes(target) || target.includes(norm(a.criterion)));
  }
  return hit?.env ?? null;
}

// Evidence that smells of an environment limit rather than a real defect (v1).
const ENV_LIMIT_RE =
  /not verifiable|no (github )?remote|branch protection|hosted (service|ci|runtime)|cannot (access|observe|verify)|can't (access|observe|verify)|needs? (a )?(human|person|owner|manual)|external (service|system)|manual(ly)? (check|verif)|not observable/i;

// File-path tokens from gap text (v1) — used for owning-task hints.
const PATH_TOKEN_RE = /(?:[.~\/]?[\w@.-]+\/)*[\w@.-]+\.[A-Za-z]{1,8}(?::\d+)?/g;
function pathTokensIn(text) {
  const out = [];
  for (const m of String(text ?? "").matchAll(PATH_TOKEN_RE)) {
    const raw = m[0].replace(/:\d+$/, "");
    if (!raw.includes("/") && raw.length < 6) continue;
    out.push(raw);
  }
  return out;
}

// Commit suffix honors the project's ticket-id convention (v1).
const COMMIT_ID_RE = /\b(OMNI-\d{1,4}|F\d{1,3}|#\d+)\b/i;
function commitSuffixFor(task, runId) {
  const m = String(task ?? "").match(COMMIT_ID_RE);
  return m ? `(${m[1].toUpperCase()})` : `(nano ${runId})`;
}

// Source-doc loader (v1): the ORIGINAL requirements gate the run.
function loadSourceDocs(run) {
  const docs = run.spec?.source_docs;
  if (!Array.isArray(docs) || docs.length === 0) return null;
  const parts = [];
  for (const rel of docs.slice(0, 5)) {
    const abs = path.resolve(run.projectPath, String(rel));
    if (!abs.startsWith(path.resolve(run.projectPath))) continue;
    try {
      let content = fs.readFileSync(abs, "utf8");
      if (content.length > 30_000) content = content.slice(0, 30_000) + "\n(truncated)";
      parts.push(`--- ${rel} ---\n${content}`);
    } catch {
      emitSafe(run, "_run", { t: "notice", s: `source doc unreadable: ${rel}` });
    }
  }
  return parts.length ? parts.join("\n\n") : null;
}
function sourceDocsFor(run) {
  if (run.sourceDocCache === undefined || run.sourceDocCache === null) {
    run.sourceDocCache = loadSourceDocs(run) ?? "";
  }
  return run.sourceDocCache || null;
}
function emitSafe(run, nodeId, ev) {
  try {
    run.__emit?.event(run.id, nodeId, ev);
  } catch {
    /* emit not wired (unit harness) */
  }
}

function promiseExternals() {
  const box = { promiseSettled: false };
  const promise = new Promise((r) => {
    box.resolve = r;
  });
  return { promise: box.promise, resolve: box.resolve, box };
}

// ============================================================================

export function createEngine({ modelRuntime, emit, webTools, adapters }) {
  const runs = new Map(); // runId -> controller
  // Test seams (unit harness): the real implementations are the defaults.
  const openSessionImpl = adapters?.openStepSession ?? openStepSession;
  const runNodeImpl = adapters?.runNode ?? runNode;
  const mechanicalImpl = adapters?.runMechanicalChecks ?? runMechanicalChecks;
  const scannerImpl = adapters?.runScannerSuite ?? runScannerSuite;

  const stepState = (run, id) => run.state.steps.find((s) => s.id === id);
  const sessionsDir = (run) => path.join(runDir(run.id), "sessions");

  function beginStep(run, id) {
    const s = stepState(run, id);
    if (!s) return null;
    s.status = "running";
    if (!s.startedAt) s.startedAt = Date.now();
    run.current.set(id, new AbortController());
    emit.state(run);
    return s;
  }

  function endStep(run, id, patch = {}) {
    const s = stepState(run, id);
    if (!s) return;
    s.status = patch.status ?? "done";
    s.endedAt = Date.now();
    if (s.startedAt) s.durationMs = (s.durationMs ?? 0) + Math.max(0, s.endedAt - s.startedAt);
    Object.assign(s, patch);
    run.current.delete(id);
    emit.state(run);
  }

  // Gate-wait accounting (v1): gate time excluded from working time.
  const gateOpen = (run) => {
    run.gateSince = Date.now();
    run.state.gateSince = run.gateSince;
  };
  const gateClose = (run) => {
    if (run.gateSince) {
      run.state.gateWaitMs = (run.state.gateWaitMs ?? 0) + Math.max(0, Date.now() - run.gateSince);
      run.gateSince = null;
      run.state.gateSince = null;
    }
  };

  // A gate decision awaited from INSIDE a milestone tool (submit_plan's
  // approval block, security override). Resolved by the gate API or by cancel
  // (finalizeCancel resolves pending gates — the v1 leak, fixed).
  function awaitGateDecision(run, gatePayload) {
    run.state.gate = gatePayload;
    run.state.status = "awaiting-gate";
    gateOpen(run);
    emit.state(run);
    return new Promise((resolve) => {
      run.gateResolver = resolve;
    }).finally(() => {
      run.gateResolver = null;
      gateClose(run);
      run.state.gate = null;
      if (!run.cancelRequested) run.state.status = "running";
      emit.state(run);
    });
  }

  // Hard cancel (v1 shape, adapted): abort in-flight sessions, RESOLVE pending
  // gates/answers with "cancel" so blocked tools and waiters settle.
  function finalizeCancel(run, reason = "cancelled by owner") {
    if (run.finalized) return false;
    run.finalized = true;
    run.cancelRequested = true;
    for (const c of run.current.values()) {
      try {
        c.abort();
      } catch {
        /* ignore */
      }
    }
    if (run.gateResolver) {
      const r = run.gateResolver;
      run.gateResolver = null;
      r("cancel");
    }
    if (run.answersResolver) {
      const r = run.answersResolver;
      run.answersResolver = null;
      r("cancel");
    }
    try {
      run.buildHandle?.abort();
    } catch {
      /* ignore */
    }
    const now = Date.now();
    for (const s of run.state.steps) {
      if (s.status === "running") {
        if (s.startedAt) s.durationMs = (s.durationMs ?? 0) + Math.max(0, now - s.startedAt);
        s.status = "cancelled";
        s.endedAt = now;
        s.error = reason;
      }
    }
    gateClose(run);
    // An interrupted answers gate keeps its PENDING questions — resume
    // re-presents them to the owner directly (no model turn needed).
    if (run.state.gate?.type === "answers" && run.state.gate.questions?.length) {
      run.state.pendingQuestions = { round: run.state.gate.round ?? 1, questions: run.state.gate.questions };
    }
    run.state.gate = null;
    run.state.status = "cancelled";
    run.state.error = null;
    run.state.finishedAt = now;
    run.done.promiseSettled = true;
    try {
      run.done.resolve("cancelled");
    } catch {
      /* already resolved */
    }
    run.done.box.promiseSettled = true;
    emit.state(run);
    // Out-of-band cancel never flows back through execute()'s settle() (its
    // catch returns early once finalized) — fire the observer HERE or queue
    // tickets strand at 'running' when the owner hard-cancels their run.
    try {
      run.onSettled?.("cancelled");
    } catch {
      /* observer errors never break the run */
    }
    return true;
  }

  // --- git (v1, milestone-granular) --------------------------------------------

  function commitMilestone(run, subject, files) {
    if (!run.git?.enabled) return;
    const abs = (files ?? [])
      .map((f) => path.resolve(run.projectPath, f))
      .filter((a) => a.startsWith(path.resolve(run.projectPath)));
    if (abs.length === 0) return;
    (async () => {
      try {
        for (const a of abs) await git.stagePath(run.projectPath, path.relative(run.projectPath, a));
        if (!(await git.hasStaged(run.projectPath))) return;
        const hash = await git.commit(run.projectPath, subject);
        run.state.git.commits.push({ subject, hash, files: abs });
        emit.event(run.id, "build", {
          t: "notice",
          s: `git: committed ${abs.length} file(s) (${hash.slice(0, 7)}) on ${run.git.runBranch} — "${subject}"`,
        });
        emit.state(run);
      } catch (e) {
        emit.event(run.id, "build", { t: "notice", s: `git commit failed: ${e.message}` });
      }
    })();
  }

  async function integrate(run, accepted) {
    const g = run.git;
    if (!g?.enabled) return;
    try {
      run.buildHandle?.close();
      run.buildHandle = null;
    } catch {
      /* ignore */
    }
    try {
      await git.checkout(run.projectPath, g.baseBranch);
    } catch (e) {
      emit.event(run.id, "_run", { t: "notice", s: `git: checkout ${g.baseBranch} failed: ${e.message}` });
      return;
    }
    if (!accepted) {
      run.state.git.mergeError = "run not accepted — branch kept unmerged";
      emit.event(run.id, "_run", {
        t: "notice",
        s: `git: run not accepted — branch ${g.runBranch} kept with its commits for inspection`,
      });
      return;
    }
    try {
      await git.ffMerge(run.projectPath, g.runBranch);
      await git.deleteBranch(run.projectPath, g.runBranch);
      run.state.git.merged = true;
      emit.event(run.id, "_run", {
        t: "notice",
        s: `git: ff-merged ${g.runBranch} into ${g.baseBranch} and deleted the branch — ready to push`,
      });
    } catch (e) {
      run.state.git.mergeError = String(e?.message ?? e);
      emit.event(run.id, "_run", {
        t: "notice",
        s: `git: ff-merge failed (${run.state.git.mergeError}) — branch ${g.runBranch} kept`,
      });
    }
  }

  // --- Step 1: clarify (v1, lifted with steps-state instead of nodes) ----------

  async function clarifyPhase(run) {
    const rounds = (run.state.qa ?? []).map((r) => ({ questions: r.questions, answers: r.answers }));
    let emptyRounds = 0;
    let round = rounds.length;
    // Resume after cancel-at-answers-gate: the SAME pending questions go back
    // to the owner directly — no model turn, no re-asking, zero tokens.
    if (run.state.pendingQuestions?.questions?.length) {
      const pending = run.state.pendingQuestions;
      run.state.pendingQuestions = null;
      round = pending.round;
      emit.event(run.id, "clarify", {
        t: "notice",
        s: `resume: re-presenting ${pending.questions.length} unanswered question(s) from round ${round} — no model turn needed`,
      });
      run.state.gate = { type: "answers", nodeId: "clarify", round: pending.round, questions: pending.questions };
      run.state.status = "awaiting-answers";
      gateOpen(run);
      emit.state(run);
      const answers = await new Promise((resolve) => {
        run.answersResolver = resolve;
      });
      run.answersResolver = null;
      gateClose(run);
      if (answers === "cancel") throw new Error("cancelled at answers gate");
      rounds.push({ questions: pending.questions, answers });
      run.state.qa = [...(run.state.qa ?? []), { round, at: Date.now(), questions: pending.questions, answers }];
      run.state.gate = null;
      run.state.status = "running";
      emit.state(run);
    }
    while (true) {
      round += 1;
      const history = rounds.map((r, i) => ({
        round: i + 1,
        qna: r.questions.map((q) => ({ question: q.question, answer: r.answers[q.id] ?? "(no answer)" })),
      }));
      const mode = run.options.requireQuestions && rounds.length === 0 ? "questions-only" : "both";
      let prompt = clarifyPrompt(run.task, history, run.projectPath);
      if (mode === "questions-only") {
        prompt += "\n\nOWNER POLICY: at least one clarification round is REQUIRED before the spec may lock. finalize_spec is unavailable this round — investigate the project, then ask your highest-leverage questions via ask_questions.";
      }
      if (emptyRounds > 0) {
        prompt += `\n\nYou have called ask_questions with no questions ${emptyRounds} time(s). Do NOT do that again — either ask real questions via ask_questions, or finalize via finalize_spec.`;
      }
      const result = await clarifyNode(run, prompt, mode);

      if (result.type === "spec") {
        emit.event(run.id, "clarify", {
          t: "notice",
          s: `spec finalized after ${rounds.length} clarification round(s): ${result.spec.acceptance_criteria?.length ?? 0} acceptance criteria`,
        });
        return result.spec;
      }

      const qs = result.questions ?? [];
      if (qs.length === 0) {
        emptyRounds += 1;
        if (emptyRounds >= 3) throw new Error("clarify kept returning empty question sets");
        continue;
      }
      emptyRounds = 0;

      run.state.gate = { type: "answers", nodeId: "clarify", round, questions: qs };
      run.state.status = "awaiting-answers";
      gateOpen(run);
      emit.state(run);
      emit.event(run.id, "clarify", {
        t: "notice",
        s: `asking ${qs.length} question(s): ${qs.map((q) => q.id).join(", ")}`,
      });
      const answers = await new Promise((resolve) => {
        run.answersResolver = resolve;
      });
      run.answersResolver = null;
      gateClose(run);
      if (answers === "cancel") throw new Error("cancelled at answers gate");
      rounds.push({ questions: qs, answers });
      run.state.qa = [...(run.state.qa ?? []), { round, at: Date.now(), questions: qs, answers }];
      run.state.gate = null;
      run.state.status = "running";
      emit.state(run);
    }
  }

  function makeInvestigateTool(run) {
    let calls = 0;
    return defineTool({
      name: "investigate",
      label: "Investigate",
      description:
        "Spawn a read-only analyst session to research a question about this project (code, structure, conventions, data). Returns a concise evidence-backed digest with file paths.",
      parameters: Type.Object({
        question: Type.String({ description: "What the analyst should investigate and report on" }),
      }),
      execute: async (_toolCallId, params) => {
        if (calls >= 3) {
          return {
            content: [{ type: "text", text: "Investigate limit reached (3 per clarify phase). Decide with what you have." }],
            details: {},
          };
        }
        calls += 1;
        emit.event(run.id, "clarify", { t: "notice", s: `analyst dispatched: ${String(params.question).slice(0, 80)}` });
        let digest = "";
        const usage = { input: 0, output: 0, cacheRead: 0 };
        await runNodeImpl({
          nodeId: "clarify",
          stepId: "clarify",
          tools: ["read", "grep", "find", "ls"],
          customTools: [],
          requireArtifact: false,
          thinking: "low",
          systemPrompt:
            "You are a read-only ANALYST. Investigate the project and answer with a concise, " +
            "evidence-backed digest citing file paths. You have no write tools.",
          prompt: String(params.question),
          cwd: run.projectPath,
          modelSpec: run.models.clarify ?? "auto",
          modelRuntime,
          signal: run.current.get("clarify")?.signal,
          onEvent: (_id, ev) => {
            if (ev.t === "text") digest += ev.s;
            if (ev.t === "usage") addUsage(usage, ev.usage);
            emit.event(run.id, "clarify", ev);
          },
        });
        const cs = stepState(run, "clarify");
        if (cs) addUsage(cs.usage, usage);
        return { content: [{ type: "text", text: digest.trim() || "(analyst returned nothing)" }], details: {} };
      },
    });
  }

  async function clarifyNode(run, prompt, mode) {
    beginStep(run, "clarify");
    const store = { result: null };
    const ctrl = new AbortController();
    const cancelSignal = run.current.get("clarify")?.signal;
    if (cancelSignal) cancelSignal.addEventListener("abort", () => ctrl.abort(), { once: true });
    const tools = [];
    if (mode !== "finalize-only") {
      tools.push(
        makeTool({
          name: "ask_questions",
          label: "Ask questions",
          description: "Ask the owner up to 5 high-leverage clarification questions.",
          schema: ARTIFACT_SCHEMAS.questions,
          onCall: (p) => {
            store.result = { type: "questions", questions: p.questions ?? [] };
            ctrl.abort(); // hard pause — the owner answers in the GUI
          },
        }),
      );
    }
    // Owner policy (requireQuestions): the spec cannot lock until at least one
    // question round was asked — finalize_spec is structurally WITHHELD on the
    // first round, not merely discouraged.
    if (mode !== "questions-only") {
      tools.push(
        makeTool({
          name: "finalize_spec",
          label: "Finalize spec",
          description: "Finalize the requirements spec.",
          schema: ARTIFACT_SCHEMAS.spec,
          onCall: (p) => (store.result = { type: "spec", spec: p }),
        }),
      );
    }
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    byName.investigate = makeInvestigateTool(run);
    if (webTools?.search) byName.web_search = webTools.search;
    if (webTools?.reader) byName.web_reader = webTools.reader;
    const available = Object.keys(byName);
    const node = stepState(run, "clarify");
    let lastErr = null;
    for (let attempt = 0; attempt <= 1; attempt++) {
      try {
        await runNodeImpl({
          nodeId: "clarify",
          stepId: "clarify",
          tools: available,
          customTools: available.map((n) => byName[n]),
          artifactStore: { artifacts: [] },
          requireArtifact: false,
          thinking: STEP_PROFILES.clarify.thinking,
          systemPrompt: clarifySystem(),
          prompt:
            attempt === 0
              ? prompt
              : prompt +
                (mode === "questions-only"
                  ? "\n\nIMPORTANT: respond ONLY by calling the ask_questions tool — finalize_spec is unavailable this round (the owner requires at least one question round). Do not write your answer as text."
                  : "\n\nIMPORTANT: respond ONLY by calling the ask_questions tool or the finalize_spec tool — do not write your answer as text."),
          cwd: run.projectPath,
          modelSpec: run.models.clarify ?? "auto",
          modelRuntime,
          signal: ctrl.signal,
          onEvent: (nodeId, ev) => {
            if (ev.t === "usage") addUsage(node.usage, ev.usage);
            emit.event(run.id, nodeId, ev);
          },
        });
        if (run.cancelRequested) {
          endStep(run, "clarify", { status: "cancelled", error: "cancelled by owner" });
          throw new Error("cancelled");
        }
        if (store.result) {
          endStep(run, "clarify");
          return store.result;
        }
        throw new Error("clarify finished without calling ask_questions or finalize_spec");
      } catch (err) {
        if (store.result && !run.cancelRequested) {
          endStep(run, "clarify");
          return store.result;
        }
        lastErr = err;
        if (run.cancelRequested) break;
        node.retries += 1;
        emit.event(run.id, "clarify", { t: "notice", s: `attempt failed: ${err.message}` });
      }
    }
    endStep(run, "clarify", { status: run.cancelRequested ? "cancelled" : "failed", error: String(lastErr?.message ?? lastErr) });
    throw lastErr ?? new Error("clarify failed");
  }

  // --- Step 2: build (persistent session + milestone tools) --------------------

  function tasksWithStatus(run) {
    const tasks = run.state.artifacts.tasks?.tasks ?? [];
    const completion = new Map(
      (run.state.artifacts.implDelta?.task_completion ?? []).map((t) => [t.task, t.status]),
    );
    return tasks.map((t) => ({ ...t, status: completion.get(t.id) ?? null }));
  }

  // Owning-task hints for a gap: file-path tokens matched against task files.
  function taskHint(run, text) {
    const tokens = pathTokensIn(text);
    if (tokens.length === 0) return null;
    const hits = new Set();
    for (const t of tasksWithStatus(run)) {
      const files = (t.files ?? []).map(pathKey);
      for (const tok of tokens) {
        const k = pathKey(tok);
        if (files.some((f) => f.includes(k) || k.includes(f))) {
          hits.add(t.id);
          break;
        }
      }
    }
    return hits.size ? [...hits].join("+") : null;
  }

  // A milestone tool's hard stop aborts the in-flight prompt() — the SDK
  // rejects the pending promise with an AbortError. That is SUCCESS when the
  // milestone the tool represents was recorded (v1 clarify's swallow-guard,
  // ported). Anything else rethrows.
  async function safePrompt(handle, text, milestoneRecorded) {
    try {
      await handle.prompt(text);
    } catch (err) {
      if (milestoneRecorded()) return;
      if (/abort/i.test(String(err?.message ?? err)) && milestoneRecorded(true)) return; // last-chance re-check
      throw err;
    }
  }

  // Optional divergence fields sometimes come back as literal "none"/"n/a" —
  // treat those as absent so a filled-but-empty field can't open a gate.
  function realDivergence(v) {
    const s = String(v ?? "").trim();
    return /^(none|no|n\/a|na|nothing|null|\.| - )$/i.test(s) ? undefined : s || undefined;
  }

  function buildMilestoneTools(run, ctrl) {
    const stop = () => {
      // Hard turn stop (mirrors v1 ask_questions): the milestone is recorded;
      // further work this turn is waste. The session survives and stays
      // resumable for fix-round feedback turns (probe-verified).
      ctrl.abort();
      run.buildHandle?.abort();
    };

    const submitPlan = defineTool({
      name: "submit_plan",
      label: "Submit plan",
      description: "Submit the implementation plan (PLAN phase milestone). Call EXACTLY ONCE per plan revision. Leave divergence EMPTY unless the task truly cannot be done as specified.",
      parameters: MILESTONE_SCHEMAS.plan,
      execute: async (_id, p) => {
        const divergence = realDivergence(p?.divergence);
        const { errors, warnings } = validatePlan(p, run.spec);
        for (const w of warnings) emit.event(run.id, "build", { t: "notice", s: `plan warning: ${w}` });
        if (errors.length) {
          emit.event(run.id, "build", { t: "notice", s: `plan rejected by driver: ${errors.join("; ")}` });
          return {
            content: [{ type: "text", text: `REJECTED by the driver — fix these problems and call submit_plan again with the corrected plan:\n- ${errors.join("\n- ")}` }],
            details: {},
          };
        }
        // Persist the plan BEFORE any gate: a cancel/restart at the gate must
        // never lose it — resume re-presents the SAME plan (no model re-plan).
        run.state.artifacts.plan = p;
        if (divergence) {
          run.state.pendingPlanGate = { type: "divergence", plan: p };
          emit.event(run.id, "build", { t: "notice", s: `divergence: ${String(divergence).slice(0, 200)}` });
          emit.state(run);
          const decision = await awaitGateDecision(run, { type: "divergence", nodeId: "build", divergence });
          if (decision === "cancel" || run.cancelRequested) {
            stop();
            return { content: [{ type: "text", text: "Run cancelled at the divergence gate." }], details: {} };
          }
          run.state.pendingPlanGate = null;
          emit.state(run);
          return {
            content: [{ type: "text", text: "The owner approved despite the divergence — proceed to the TASK BREAKDOWN phase: read " + SKILL_DIRS.taskBreakdown + "/SKILL.md, then call submit_tasks." }],
            details: {},
          };
        }
        if (run.options.approvePlan) {
          run.state.pendingPlanGate = { type: "plan-approval", plan: p };
          emit.event(run.id, "build", { t: "notice", s: "plan submitted — owner approval required (plan-approval gate)" });
          emit.state(run);
          const decision = await awaitGateDecision(run, {
            type: "plan-approval",
            nodeId: "build",
            plan: {
              task_summary: p.task_summary,
              approach: p.approach,
              files: (p.files ?? []).map((f) => f.path),
              acceptance_criteria: p.acceptance_criteria ?? [],
            },
          });
          if (decision?.action === "reject") {
            run.state.pendingPlanGate = null;
            emit.state(run);
            const comments = String(decision.comments ?? "").slice(0, 2000);
            emit.event(run.id, "build", { t: "notice", s: `plan REJECTED by owner${comments ? `: ${comments.slice(0, 200)}` : ""}` });
            return {
              content: [{ type: "text", text: `REJECTED BY OWNER${comments ? `: ${comments}` : " (no comments given)"} — revise the plan accordingly and call submit_plan again.` }],
              details: {},
            };
          }
          if (decision === "cancel" || run.cancelRequested || decision?.action === "cancel") {
            // pendingPlanGate DELIBERATELY kept — resume re-presents the SAME
            // plan for approval instead of asking the model to re-plan.
            stop();
            return { content: [{ type: "text", text: "Run cancelled at the plan gate. The plan is stored; the owner will review it when the run resumes." }], details: {} };
          }
          run.state.pendingPlanGate = null;
          emit.state(run);
        }
        emit.event(run.id, "build", {
          t: "notice",
          s: `plan approved: ${p.task_summary.slice(0, 120)} — ${(p.files ?? []).length} file(s), ${(p.acceptance_criteria ?? []).length} criteria`,
        });
        emit.state(run);
        return {
          content: [{ type: "text", text: "APPROVED — proceed to the TASK BREAKDOWN phase now: read " + SKILL_DIRS.taskBreakdown + "/SKILL.md, then call submit_tasks exactly once." }],
          details: {},
        };
      },
    });

    const submitTasks = defineTool({
      name: "submit_tasks",
      label: "Submit tasks",
      description: "Submit the task breakdown (TASK BREAKDOWN phase milestone). Call EXACTLY ONCE per revision.",
      parameters: MILESTONE_SCHEMAS.tasks,
      execute: async (_id, p) => {
        const { errors, warnings } = validateTasks(p, run.state.artifacts.plan);
        for (const w of warnings) emit.event(run.id, "build", { t: "notice", s: `tasks warning: ${w}` });
        if (errors.length) {
          emit.event(run.id, "build", { t: "notice", s: `tasks rejected by driver: ${errors.join("; ")}` });
          return {
            content: [{ type: "text", text: `REJECTED by the driver — fix these problems and call submit_tasks again:\n- ${errors.join("\n- ")}` }],
            details: {},
          };
        }
        run.state.artifacts.tasks = p;
        emit.event(run.id, "build", {
          t: "notice",
          s: `tasks accepted: ${p.tasks.map((t) => `${t.id}(${t.size})`).join(" → ").replace(/ → /g, ", ")}`,
        });
        emit.state(run);
        return {
          content: [{ type: "text", text: `Tasks accepted (${p.tasks.length}). Proceed to the IMPLEMENT phase now: read ${SKILL_DIRS.implementation}/SKILL.md and build every task fully (dispatch_coder per the skill's policy). Call submit_impl_delta when ALL tasks are done and lint/tests are green.` }],
          details: {},
        };
      },
    });

    const submitImplDelta = defineTool({
      name: "submit_impl_delta",
      label: "Submit impl-delta",
      description: "Report the implementation result (IMPLEMENT phase milestone). Call EXACTLY ONCE per round when all tasks are done.",
      parameters: MILESTONE_SCHEMAS.implDelta,
      execute: async (_id, p) => {
        run.state.artifacts.implDelta = p;
        endStep(run, "build"); // per-round done; fix rounds re-begin the step
        const partial = (p.task_completion ?? []).filter((t) => t.status !== "done");
        emit.event(run.id, "build", {
          t: "notice",
          s: `impl-delta: ${(p.files_written ?? []).length} file(s)${partial.length ? ` — PARTIAL tasks: ${partial.map((t) => t.task).join(", ")}` : ""}`,
        });
        // Milestone commit on the run branch (feat: on round 0, fix: after).
        const title = String(p.summary ?? run.task).replace(/\s+/g, " ").trim().slice(0, 48) || "implementation";
        const type = (run.state.steps.find((s) => s.id === "build")?.rounds ?? 0) > 0 ? "fix" : "feat";
        const suffix = commitSuffixFor(run.task, run.id);
        const maxTitle = Math.max(16, 72 - type.length - 2 - suffix.length - 1);
        commitMilestone(run, `${type}: ${title.slice(0, maxTitle)} ${suffix}`, p.files_written);
        emit.state(run);
        stop();
        return {
          content: [{ type: "text", text: partial.length ? `Recorded — note: ${partial.length} task(s) reported partial/skipped; verification will judge the tree as-is. STOP now; verification begins.` : "Recorded. STOP now — verification begins outside this session." }],
          details: {},
        };
      },
    });

    // dispatch_coder — one task per fresh child builder session (§2.7).
    let inFlight = 0;
    let dispatched = 0;
    const dispatchCoder = defineTool({
      name: "dispatch_coder",
      label: "Dispatch coder",
      description:
        "Spawn a fresh builder subagent for ONE task (per the task-breakdown skill's dispatch policy). Returns the subagent's report.",
      parameters: Type.Object({
        task_id: Type.String({ description: "The task slug from submit_tasks" }),
        instructions: Type.Optional(Type.String({ description: "Extra instructions for the subagent (optional)" })),
      }),
      execute: async (_toolCallId, params) => {
        const task = (run.state.artifacts.tasks?.tasks ?? []).find((t) => t.id === params.task_id);
        if (!task) {
          return { content: [{ type: "text", text: `unknown task_id "${params.task_id}" — use a slug from submit_tasks` }], details: {} };
        }
        if (inFlight >= MAX_CODER_SUBAGENTS || dispatched >= MAX_CODER_SUBAGENTS * 2) {
          return {
            content: [{ type: "text", text: "dispatch cap reached — implement this task yourself in this session." }],
            details: {},
          };
        }
        inFlight += 1;
        dispatched += 1;
        emit.event(run.id, "build", { t: "notice", s: `coder[${task.id}]: dispatched (${task.title.slice(0, 60)})` });
        try {
          const spec = run.spec;
          const sourceDocText = sourceDocsFor(run);
          const parts = [
            `You are a CODER subagent for ONE task of a larger build. Implement it fully — no stubs, no TODOs.`,
            `Task ${task.id} — ${task.title}:`,
            task.description,
            `Files you own (stay inside them):\n${task.files.map((f) => `- ${f}`).join("\n")}`,
            `Task acceptance criteria:\n${task.acceptance_criteria.map((c) => `- ${c}`).join("\n")}`,
          ];
          if (spec?.acceptance_criteria?.length) {
            parts.push(
              `Overall acceptance criteria (satisfy every one that touches your files):\n${spec.acceptance_criteria.map((c) => `- ${c}`).join("\n")}`,
            );
          }
          if (sourceDocText) parts.push(`SOURCE REQUIREMENT DOCUMENT (requirements OUTRANK summaries):\n\n${sourceDocText}`);
          if (params.instructions) parts.push(`Additional instructions from the lead builder:\n${params.instructions}`);
          parts.push("Run lint/tests for what you changed before reporting. Report via report_artifact: summary, files_written, notes.");
          let systemPrompt = "You are a CODER subagent. Implement fully; failure paths too; run lint/tests before reporting.";
          const ctx = loadStepContext(run.projectPath, "build", (f) =>
            emit.event(run.id, "build", { t: "notice", s: `context injected: ${f.name} (${f.chars} chars)` }),
          );
          if (ctx) systemPrompt += `\n\n${ctx}`;
          const store = { artifacts: [] };
          const usage = { input: 0, output: 0, cacheRead: 0 };
          const reportTool = makeTool({
            name: "report_artifact",
            label: "Report artifact",
            description: "Report the structured result. Call it EXACTLY ONCE when done.",
            schema: ARTIFACT_SCHEMAS.implement,
            onCall: (p2) => store.artifacts.push(p2),
          });
          await runNodeImpl({
            nodeId: "build",
            stepId: "build",
            tools: ["read", "write", "edit", "bash", "grep", "find", "ls", "report_artifact"],
            customTools: [reportTool],
            artifactStore: store,
            requireArtifact: true,
            thinking: "high",
            systemPrompt,
            prompt: parts.join("\n\n"),
            cwd: run.projectPath,
            modelSpec: run.models.builder ?? "auto",
            modelRuntime,
            signal: run.current.get("build")?.signal,
            onEvent: (_id, ev) => {
              if (ev.t === "usage") addUsage(usage, ev.usage);
              emit.event(run.id, "build", ev);
            },
          });
          const artifact = store.artifacts[store.artifacts.length - 1] ?? {};
          const bs = stepState(run, "build");
          if (bs) addUsage(bs.usage, usage);
          emit.event(run.id, "build", {
            t: "notice",
            s: `coder[${task.id}]: finished — ${(artifact.files_written ?? []).length} file(s) written`,
          });
          return {
            content: [{ type: "text", text: `Subagent report for ${task.id}:\n${JSON.stringify(artifact, null, 2)}` }],
            details: {},
          };
        } finally {
          inFlight -= 1;
        }
      },
    });

    return [submitPlan, submitTasks, submitImplDelta, dispatchCoder];
  }

  async function getOrCreateBuildSession(run) {
    if (run.buildHandle) return run.buildHandle;
    const step = stepState(run, "build");
    const ctrl = run.current.get("build");
    let systemPrompt = builderSystem({ skillDirs: SKILL_DIRS });
    const ctx = loadStepContext(run.projectPath, "build", (f) =>
      emit.event(run.id, "build", { t: "notice", s: `context injected: ${f.name} (${f.chars} chars)` }),
    );
    if (ctx) systemPrompt += `\n\n${ctx}`;
    const handle = await openSessionImpl({
      stepId: "build",
      sessionFile: step?.sessionFile ?? null,
      sessionsDir: sessionsDir(run),
      tools: [...STEP_PROFILES.build.tools],
      customTools: buildMilestoneTools(run, ctrl),
      systemPrompt,
      cwd: run.projectPath,
      modelSpec: run.models.builder ?? "auto",
      modelRuntime,
      thinking: STEP_PROFILES.build.thinking,
      onEvent: (nodeId, ev) => {
        const s = stepState(run, "build");
        if (ev.t === "usage" && s) addUsage(s.usage, ev.usage);
        emit.event(run.id, nodeId, ev);
      },
      signal: ctrl?.signal,
    });
    if (step && !step.sessionFile) {
      step.sessionFile = handle.sessionFile;
      emit.state(run);
    }
    if (handle.resumed) {
      emit.event(run.id, "build", { t: "notice", s: "build session resumed from disk (context intact)" });
    }
    run.buildHandle = handle;
    return handle;
  }

  // One full build turn. kind: 'initial' | { feedback: { round, source, gaps } }
  async function buildTurn(run, kind) {
    beginStep(run, "build");
    const handle = await getOrCreateBuildSession(run);
    const step = stepState(run, "build");
    let text;
    let expected;
    if (kind === "initial") {
      text = builderPrompt({
        task: run.task,
        workspace: run.projectPath,
        spec: run.spec,
        sourceDocText: sourceDocsFor(run),
      });
      expected = () => run.cancelRequested || run.state.artifacts.plan;
    } else if (kind === "plan-approved") {
      const plan = run.state.artifacts.plan;
      text = [
        "Your run was cancelled while your submitted plan was awaiting owner approval. The run has now been resumed and the owner has APPROVED your submitted plan (restated):",
        JSON.stringify(
          {
            task_summary: plan?.task_summary,
            approach: plan?.approach,
            files: plan?.files,
            acceptance_criteria: plan?.acceptance_criteria,
          },
          null,
          2,
        ),
        "Do NOT investigate again and do NOT re-plan or call submit_plan. Proceed directly to the TASK BREAKDOWN phase: read " + SKILL_DIRS.taskBreakdown + "/SKILL.md, then call submit_tasks exactly once.",
      ].join("\n\n");
      expected = () => run.cancelRequested || run.state.artifacts.tasks;
    } else {
      step.rounds = (step.rounds ?? 0) + 1;
      expected = () => run.cancelRequested || run.state.artifacts.implDelta;
      text = builderFeedbackTurn({
        round: kind.feedback.round,
        source: kind.feedback.source,
        gaps: kind.feedback.gaps
          .map((g) => {
            const hint = taskHint(run, g);
            return hint ? `[task: ${hint}] ${g}` : g;
          })
          .join("\n"),
        plan: run.state.artifacts.plan,
        tasks: tasksWithStatus(run),
        spec: run.spec,
      });
      emit.state(run);
    }
    await safePrompt(handle, text, expected);
    if (run.cancelRequested) throw new Error("cancelled");
    // Milestone nudge (v1 pattern): the turn ended without the expected call.
    if (!expected()) {
      const want =
        kind === "initial" ? "submit_plan" : kind === "plan-approved" ? "submit_tasks" : "submit_impl_delta";
      emit.event(run.id, "build", { t: "notice", s: `turn ended without ${want} — nudging once` });
      await handle.prompt(
        `You ended your turn without the required milestone call. Call ${want} now with the structured result. Do nothing else first.`,
      );
    }
  }

  // --- pre-flight gates (v1, adapted) -------------------------------------------

  async function runMechanicalGate(run) {
    emit.event(run.id, "_run", { t: "notice", s: "mechanical checks: running (driver-deterministic)" });
    const checks = await mechanicalImpl({ projectPath: run.projectPath, runId: run.id, emit });
    run.state.mechanicalChecks = { round: run.state.round ?? 0, at: new Date().toISOString(), checks };
    for (const c of checks) {
      emit.event(run.id, "_run", {
        t: "notice",
        s: `checks: ${c.id} — ${c.status}${c.status === "fail" ? `: ${String(c.evidence).slice(0, 300)}` : c.status === "skipped" ? ` (${String(c.evidence).slice(0, 120)})` : ""}`,
      });
    }
    emit.state(run);
  }

  async function runRemoteCiGate(run) {
    if (!run.options.remoteCi) return;
    if (run.ciCapability === undefined) {
      run.ciCapability = await detectCiCapability(run.projectPath);
      if (!run.ciCapability.ok) {
        run.state.remoteChecks = {
          round: run.state.round ?? 0,
          at: new Date().toISOString(),
          status: "skipped",
          evidence: `remote CI unavailable: ${run.ciCapability.reason}`,
          runs: [],
        };
        emit.event(run.id, "_run", { t: "notice", s: `remote CI: skipped — ${run.ciCapability.reason}` });
        emit.state(run);
        return;
      }
      emit.event(run.id, "_run", { t: "notice", s: "remote CI: gh + origin verified" });
    }
    if (!run.ciCapability.ok) return;
    try {
      emit.event(run.id, "_run", {
        t: "notice",
        s: `remote CI: pushing ${run.git.runBranch} to origin (owner opted in — this triggers hosted CI)`,
      });
      await git.pushBranch(run.projectPath, run.git.runBranch);
    } catch (e) {
      run.state.remoteChecks = {
        round: run.state.round ?? 0,
        at: new Date().toISOString(),
        status: "skipped",
        evidence: `push failed: ${String(e?.message ?? e).slice(0, 300)}`,
        runs: [],
      };
      emit.event(run.id, "_run", { t: "notice", s: `remote CI: push failed — recorded skip` });
      emit.state(run);
      return;
    }
    const sha = await git.headSha(run.projectPath);
    const result = await watchRunsForSha({ cwd: run.projectPath, sha, emit: (ev) => emit.event(run.id, "_run", ev) });
    run.state.remoteChecks = { round: run.state.round ?? 0, at: new Date().toISOString(), ...result };
    emit.event(run.id, "_run", {
      t: "notice",
      s: `remote CI: ${result.status}${result.status !== "pass" ? `: ${String(result.evidence).slice(0, 300)}` : ` — ${String(result.evidence).slice(0, 220)}`}`,
    });
    emit.state(run);
  }

  function remoteCiPolicy(run) {
    if (!run.options.remoteCi) {
      return "REMOTE CI VERIFICATION IS DISABLED for this run (owner opt-out). Do NOT attempt to reason about hosted CI behavior. For remote-tagged criteria, record the check with evidence beginning \"not verifiable from this environment: remote CI verification disabled for this run\" — the driver defers those instead of gating on them.";
    }
    const rc = run.state.remoteChecks;
    if (!rc) return "Remote CI verification is enabled: the driver pushes the run branch and watches the hosted Actions runs before each verification round — cite the DRIVER-OBSERVED REMOTE CI RESULTS block whenever present.";
    if (rc.status === "skipped") {
      return `Remote CI verification was attempted but skipped: ${String(rc.evidence).slice(0, 300)} — treat hosted-CI criteria as deferred unless the results block shows an observation.`;
    }
    return "Remote CI verification is enabled and observed by the driver — hosted-CI criteria are evidenced by the DRIVER-OBSERVED REMOTE CI RESULTS block; branch-protection SETTINGS remain remote.";
  }

  // --- reconciliation (v1, extended) ----------------------------------------------

  function recordDeferred(run, check, env) {
    const list = (run.state.deferredChecks ??= []);
    if (list.some((d) => d.criterion === check.criterion)) return;
    list.push({ criterion: check.criterion, env, evidence: String(check.evidence ?? "").slice(0, 400) });
    emit.event(run.id, "verify", {
      t: "notice",
      s: `needs ${env} verification (recorded, non-gating): ${String(check.criterion).slice(0, 120)}`,
    });
  }

  function reconcileVerify(run, verifyArtifact) {
    const failingChecks = (verifyArtifact?.checks ?? []).filter((c) => !c.pass);
    const mechFailing = (run.state.mechanicalChecks?.checks ?? []).filter((c) => c.status === "fail");
    const remoteFailing =
      run.state.remoteChecks?.status === "fail"
        ? [{ criterion: "Hosted CI runs triggered by the run branch complete successfully", evidence: run.state.remoteChecks.evidence }]
        : [];
    const nonGating = [];
    const gatingChecks = [];
    for (const c of failingChecks) {
      const legacy = /^\s*not verifiable/i.test(c.evidence ?? "");
      const env = matchAcVerification(run.spec?.ac_verification, c.criterion);
      const envLimited = (env === "remote" || env === "human") && ENV_LIMIT_RE.test(c.evidence ?? "");
      if (legacy || envLimited) nonGating.push(c);
      else gatingChecks.push(c);
      if (envLimited) recordDeferred(run, c, env);
    }
    if (nonGating.length > 0) {
      emit.event(run.id, "verify", {
        t: "notice",
        s: `${nonGating.length} check(s) not verifiable from this environment — recorded, non-gating`,
      });
    }
    let verdict = verifyArtifact?.verdict ?? "gaps-found";
    if (verdict === "accepted" && (gatingChecks.length > 0 || mechFailing.length > 0 || remoteFailing.length > 0)) {
      verdict = "gaps-found";
      emit.event(run.id, "verify", {
        t: "notice",
        s: `verdict overridden: "accepted" despite ${gatingChecks.length} failing check(s)${mechFailing.length ? ` and ${mechFailing.length} mechanical failure(s)` : ""}${remoteFailing.length ? " and a failed remote CI run" : ""}`,
      });
    }
    return { verdict, gatingChecks, mechFailing, remoteFailing };
  }

  function auditBlocking(run) {
    const audit = run.state.artifacts.audit;
    if (!audit || !run.options.audit) return [];
    const blocking = (audit.findings ?? []).filter((f) => f.blocking);
    if (audit.verdict === "accepted" && blocking.length > 0) {
      emit.event(run.id, "verify", { t: "notice", s: `audit verdict overridden: "accepted" despite ${blocking.length} blocking finding(s)` });
    }
    return blocking;
  }

  // --- Step 3: verify (fresh session per round) -----------------------------------

  async function verifyRound(run, round) {
    beginStep(run, "verify");
    const step = stepState(run, "verify");
    step.sessionFiles = step.sessionFiles ?? [];
    if (run.options.remoteCi) await runRemoteCiGate(run);
    if (run.cancelRequested) throw new Error("cancelled");
    await runMechanicalGate(run);
    if (run.cancelRequested) throw new Error("cancelled");

    const ctrl = run.current.get("verify");
    let systemPrompt = verifierSystem({ skillDirs: SKILL_DIRS });
    const ctx = loadStepContext(run.projectPath, "verify", (f) =>
      emit.event(run.id, "verify", { t: "notice", s: `context injected: ${f.name} (${f.chars} chars)` }),
    );
    if (ctx) systemPrompt += `\n\n${ctx}`;

    const tools = [...STEP_PROFILES.verify.tools];
    const customTools = [];
    if (webTools?.reader) {
      tools.push("web_reader");
      customTools.push(webTools.reader);
      emit.event(run.id, "verify", { t: "notice", s: "browser tool attached: web_reader — use it to LOAD pages and observe rendered content" });
    }
    customTools.push(
      defineTool({
        name: "submit_verify",
        label: "Submit verify",
        description: "Submit the verification verdict (VERIFY phase milestone). Call EXACTLY ONCE.",
        parameters: ARTIFACT_SCHEMAS.verify,
        execute: async (_id, p) => {
          run.state.artifacts.verify = p;
          emit.event(run.id, "verify", {
            t: "notice",
            s: `verify submitted: ${p.verdict} — ${(p.checks ?? []).filter((c) => c.pass).length}/${(p.checks ?? []).length} checks pass`,
          });
          emit.state(run);
          const rec = reconcileVerify(run, p);
          if (rec.verdict !== "accepted") {
            ctrl.abort();
            run.verifyHandle?.abort();
            return {
              content: [{ type: "text", text: "GAPS RECORDED by the driver — a fix round will run. Do NOT start the audit phase. End your turn NOW." }],
              details: {},
            };
          }
          if (!run.options.audit) {
            ctrl.abort();
            run.verifyHandle?.abort();
            return {
              content: [{ type: "text", text: "VERIFY ACCEPTED — the audit phase is disabled for this run. End your turn NOW." }],
              details: {},
            };
          }
          return {
            content: [{ type: "text", text: `VERIFY ACCEPTED — proceed to the AUDIT phase now. FIRST read ${SKILL_DIRS.auditDeliverables}/SKILL.md (mandatory ordering: re-read the source docs and spec BEFORE consulting your verify results), then call submit_audit exactly once.` }],
            details: {},
          };
        },
      }),
      defineTool({
        name: "submit_audit",
        label: "Submit audit",
        description: "Submit the audit verdict (AUDIT phase milestone). Call EXACTLY ONCE after submit_verify was accepted.",
        parameters: ARTIFACT_SCHEMAS.audit,
        execute: async (_id, p) => {
          run.state.artifacts.audit = p;
          const blocking = (p.findings ?? []).filter((f) => f.blocking);
          emit.event(run.id, "verify", {
            t: "notice",
            s: `audit submitted: ${p.verdict}${blocking.length ? ` — ${blocking.length} blocking finding(s)` : " — no blocking findings"}`,
          });
          emit.state(run);
          ctrl.abort();
          run.verifyHandle?.abort();
          return { content: [{ type: "text", text: "Recorded. End your turn now." }], details: {} };
        },
      }),
    );

    const handle = await openSessionImpl({
      stepId: "verify",
      sessionsDir: sessionsDir(run),
      tools,
      customTools,
      systemPrompt,
      cwd: run.projectPath,
      modelSpec: run.models.verifier ?? "auto",
      modelRuntime,
      thinking: STEP_PROFILES.verify.thinking,
      onEvent: (nodeId, ev) => {
        const s = stepState(run, "verify");
        if (ev.t === "usage" && s) addUsage(s.usage, ev.usage);
        emit.event(run.id, nodeId, ev);
      },
      signal: ctrl.signal,
    });
    run.verifyHandle = handle;
    step.sessionFiles.push(handle.sessionFile);
    emit.state(run);
    try {
      await safePrompt(
        handle,
        verifierPrompt({
          task: run.task,
          workspace: run.projectPath,
          spec: run.spec,
          sourceDocText: sourceDocsFor(run),
          acVerification: run.spec?.ac_verification ?? null,
          plan: run.state.artifacts.plan,
          tasks: tasksWithStatus(run),
          implDelta: run.state.artifacts.implDelta,
          mechanicalResults: run.state.mechanicalChecks?.checks ?? null,
          remotePolicy: remoteCiPolicy(run),
          remoteResults: run.state.remoteChecks,
          fixRound: round,
        }),
        () => run.cancelRequested || run.state.artifacts.verify,
      );
      if (!run.cancelRequested && !run.state.artifacts.verify) {
        emit.event(run.id, "verify", { t: "notice", s: "turn ended without submit_verify — nudging once" });
        await handle.prompt("You ended your turn without calling submit_verify. Call it NOW with the structured verdict. Do nothing else first.");
      }
    } finally {
      handle.close();
      run.verifyHandle = null;
    }
  }

  // --- Step 4: security -----------------------------------------------------------

  function runScannerSuite(run) {
    const r = spawnSync(process.execPath, [SCANNER_SCRIPT, run.projectPath], {
      timeout: 300_000,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    });
    try {
      return JSON.parse(r.stdout ?? "");
    } catch {
      return {
        scanners: [{ id: "suite", status: "skip", evidence: `scanner suite unparseable (exit ${r.status})` }],
      };
    }
  }

  async function securityRound(run, round) {
    beginStep(run, "security");
    const step = stepState(run, "security");
    step.sessionFiles = step.sessionFiles ?? [];
    emit.event(run.id, "security", { t: "notice", s: "scanner suite: running (driver-deterministic)" });
    const scannerResults = scannerImpl(run);
    run.state.scannerResults = { round, at: new Date().toISOString(), ...scannerResults };
    for (const s of scannerResults.scanners ?? []) {
      emit.event(run.id, "security", { t: "notice", s: `scanner: ${s.id} — ${s.status}${s.status === "fail" ? `: ${String(s.evidence).slice(0, 240)}` : ""}` });
    }
    emit.state(run);

    const ctrl = run.current.get("security");
    let systemPrompt = securitySystem({ skillDirs: SKILL_DIRS, vapt: run.options.security === "scan+vapt" });
    const ctx = loadStepContext(run.projectPath, "security", (f) =>
      emit.event(run.id, "security", { t: "notice", s: `context injected: ${f.name} (${f.chars} chars)` }),
    );
    if (ctx) systemPrompt += `\n\n${ctx}`;

    const handle = await openSessionImpl({
      stepId: "security",
      sessionsDir: sessionsDir(run),
      tools: [...STEP_PROFILES.security.tools],
      customTools: [
        defineTool({
          name: "run_scanners",
          label: "Run scanners",
          description: "Re-run the deterministic scanner suite (for post-fix re-checks). Returns structured JSON.",
          parameters: Type.Object({}),
          execute: async () => {
            const out = scannerImpl(run);
            return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }], details: {} };
          },
        }),
        defineTool({
          name: "submit_security",
          label: "Submit security findings",
          description: "Submit the security verdict (SECURITY milestone). Call EXACTLY ONCE.",
          parameters: MILESTONE_SCHEMAS.security,
          execute: async (_id, p) => {
            run.state.artifacts.security = p;
            emit.event(run.id, "security", {
              t: "notice",
              s: `security submitted: ${p.verdict} — ${(p.findings ?? []).length} finding(s)`,
            });
            emit.state(run);
            ctrl.abort();
            run.securityHandle?.abort();
            return { content: [{ type: "text", text: "Recorded. End your turn now." }], details: {} };
          },
        }),
      ],
      systemPrompt,
      cwd: run.projectPath,
      modelSpec: run.models.security ?? "auto",
      modelRuntime,
      thinking: STEP_PROFILES.security.thinking,
      onEvent: (nodeId, ev) => {
        const s = stepState(run, "security");
        if (ev.t === "usage" && s) addUsage(s.usage, ev.usage);
        emit.event(run.id, nodeId, ev);
      },
      signal: ctrl.signal,
    });
    run.securityHandle = handle;
    step.sessionFiles.push(handle.sessionFile);
    emit.state(run);
    try {
      await safePrompt(
        handle,
        securityPrompt({
          task: run.task,
          workspace: run.projectPath,
          scannerResults: run.state.scannerResults,
          vapt: run.options.security === "scan+vapt",
          priorReports: { verify: run.state.artifacts.verify, implDelta: run.state.artifacts.implDelta },
        }),
        () => run.cancelRequested || run.state.artifacts.security,
      );
      if (!run.cancelRequested && !run.state.artifacts.security) {
        emit.event(run.id, "security", { t: "notice", s: "turn ended without submit_security — nudging once" });
        await handle.prompt("You ended your turn without calling submit_security. Call it NOW with the structured findings. Do nothing else first.");
      }
    } finally {
      handle.close();
      run.securityHandle = null;
    }
  }

  function securityBlocking(run) {
    const sec = run.state.artifacts.security;
    if (!sec) return { fixable: [], unfixable: [] };
    const blocking = (sec.findings ?? []).filter((f) => SEVERITY_GATE.includes(f.severity));
    return {
      fixable: blocking.filter((f) => f.fixable_in_scope),
      unfixable: blocking.filter((f) => !f.fixable_in_scope),
    };
  }

  // --- execute: the state machine ----------------------------------------------------

  function assembleFailureReasons(run) {
    const reasons = [];
    const vf = (run.state.artifacts.verify?.checks ?? []).filter((c) => {
      if (c.pass) return false;
      if (/^\s*not verifiable/i.test(c.evidence ?? "")) return false;
      const env = matchAcVerification(run.spec?.ac_verification, c.criterion);
      return !((env === "remote" || env === "human") && ENV_LIMIT_RE.test(c.evidence ?? ""));
    });
    if (vf.length) reasons.push(`verify: ${vf.length} failing check(s) — ${vf.map((c) => c.criterion).slice(0, 3).join(" | ")}`);
    const mf = (run.state.mechanicalChecks?.checks ?? []).filter((c) => c.status === "fail");
    if (mf.length) reasons.push(`checks: ${mf.length} mechanical failure(s) — ${mf.map((c) => c.id).slice(0, 3).join(" | ")}`);
    if (run.state.remoteChecks?.status === "fail") {
      reasons.push(`remote CI: failed — ${String(run.state.remoteChecks.evidence).slice(0, 160)}`);
    }
    const ab = auditBlocking(run);
    if (ab.length) reasons.push(`audit: ${ab.length} blocking finding(s) — ${ab.map((f) => f.issue).slice(0, 3).join(" | ")}`);
    const sb = securityBlocking(run);
    if (sb.fixable.length + sb.unfixable.length > 0) {
      reasons.push(`security: ${sb.fixable.length + sb.unfixable.length} critical/high finding(s) — ${(sb.fixable.concat(sb.unfixable)).map((f) => f.title).slice(0, 3).join(" | ")}`);
    }
    return reasons.length
      ? reasons.join(" ;; ").slice(0, 600)
      : null;
  }

  // Every exit path MUST settle: persist the terminal state, unblock waiters,
  // and release the project slot. (V12 owner run caught the missing settle on
  // the failure early-returns — state.json stayed "running" forever.)
  function settle(run) {
    run.state.finishedAt = Date.now();
    run.done.promiseSettled = true;
    emit.state(run);
    run.done.box.promiseSettled = true;
    try {
      run.done.resolve(run.state.status);
    } catch {
      /* already resolved */
    }
    try {
      run.onSettled?.(run.state.status);
    } catch {
      /* observer errors never break the run */
    }
  }

  async function execute(run) {
    try {
      // Git-on runs ALWAYS execute on their own branch (v1 resume safety).
      if (run.git?.enabled) {
        try {
          await git.checkout(run.projectPath, run.git.runBranch);
        } catch (e) {
          throw new Error(
            `git: could not restore run branch ${run.git.runBranch} (${e?.message ?? e}) — resolve the working tree (clean or stash) and resume again`,
          );
        }
      }
      // Resume after cancel-at-plan-gate: the plan artifact was persisted at
      // submit time — re-present the SAME plan for approval (no model re-plan)
      // BEFORE any build work (v1 FIX-REPORT regression, kept fixed).
      const pendingGate = run.state.pendingPlanGate;
      if (pendingGate && !run.state.artifacts.implDelta) {
        emit.event(run.id, "build", { t: "notice", s: "resume: re-presenting the stored plan for approval — the builder will NOT re-plan" });
        run.state.gate =
          pendingGate.type === "divergence"
            ? { type: "divergence", nodeId: "build", divergence: pendingGate.plan.divergence }
            : {
                type: "plan-approval",
                nodeId: "build",
                plan: {
                  task_summary: pendingGate.plan.task_summary,
                  approach: pendingGate.plan.approach,
                  files: (pendingGate.plan.files ?? []).map((f) => f.path),
                  acceptance_criteria: pendingGate.plan.acceptance_criteria ?? [],
                },
              };
        emit.state(run);
        const decision = await new Promise((resolve) => {
          run.gateResolver = resolve;
        }).finally(() => {
          run.gateResolver = null;
          run.state.gate = null;
          emit.state(run);
        });
        if (decision === "cancel" || decision?.action === "cancel" || run.cancelRequested) throw new Error("cancelled at gate");
        if (pendingGate.type === "plan-approval" && decision?.action === "reject") {
          run.state.pendingPlanGate = null;
          emit.state(run);
          // rejection comments go back through the SAME session — the builder revises
          await buildTurn(run, {
            feedback: {
              round: 0,
              source: "owner plan rejection",
              gaps: [`The owner REJECTED your plan${decision.comments ? `: ${decision.comments}` : ""} — produce a revised plan and call submit_plan again.`],
            },
          });
        } else {
          // approved (or divergence accepted): the stored plan STANDS — the
          // builder continues from its own context straight to task breakdown.
          run.state.pendingPlanGate = null;
          emit.state(run);
          await buildTurn(run, "plan-approved");
        }
      }

      // STEP 1 — clarify.
      if (run.options.clarify && !run.spec) {
        const spec = await clarifyPhase(run);
        run.spec = spec;
        run.state.artifacts.spec = spec;
        run.sourceDocCache = undefined; // re-resolve against the real spec
        emit.state(run);
      }

      // Queue mode (stopAfterClarify): the spec is locked — park here as
      // "clarified". The ticket queue later promotes this run into the
      // build/verify/security phases when the project's tree is free.
      if (run.options.stopAfterClarify) {
        run.holdsTree = false;
        run.state.status = "clarified";
        emit.event(run.id, "_run", {
          t: "notice",
          s: run.spec
            ? "clarification complete — spec locked; run parked as clarified (awaiting queue promotion)"
            : "clarify disabled — run parked as clarified (awaiting queue promotion)",
        });
        await integrate(run, false);
        settle(run);
        return;
      }

      // STEP 2 — build (initial turn only when no impl-delta milestone yet;
      // fix-round feedback turns arrive from the verify/security loops below).
      if (!run.state.artifacts.implDelta) {
        await buildTurn(run, "initial");
        if (run.cancelRequested) throw new Error("cancelled");
        if (!run.state.artifacts.plan) throw new Error("build ended without an approved plan");
        if (!run.state.artifacts.tasks) throw new Error("build ended without a task breakdown");
        if (!run.state.artifacts.implDelta) throw new Error("build ended without an impl-delta report");
      }

      // STEP 3 — verify loop (bounded fix rounds; feedback resumes the build session).
      let accepted = false;
      for (let round = run.state.round ?? 0; round <= run.options.maxFixRounds; round++) {
        run.state.round = round;
        emit.state(run);
        await verifyRound(run, round);
        if (run.cancelRequested) break;
        const rec = reconcileVerify(run, run.state.artifacts.verify);
        const ab = auditBlocking(run);
        if (rec.verdict === "accepted" && ab.length === 0) {
          accepted = true;
          endStep(run, "verify");
          break;
        }
        const gaps = [
          ...rec.gatingChecks.map((c) => `${c.criterion}: ${c.evidence ?? ""}`),
          ...rec.mechFailing.map((c) => `[mechanical] ${c.title}: ${c.evidence}`),
          ...rec.remoteFailing.map(
            (c) => `[remote-ci] ${c.criterion}: ${c.evidence}\n  → the failed-log excerpt names the cause — fix it, including files OUTSIDE the original task assignments if the log points there`,
          ),
          ...ab.map((f) => `[audit/${f.category}]${f.file ? ` ${f.file}:` : ""} ${f.issue}${f.fix ? ` (fix: ${f.fix})` : ""}`),
        ];
        if (round < run.options.maxFixRounds) {
          emit.event(run.id, "verify", { t: "notice", s: `gaps-found — fix round ${round + 1} (resuming the build session)` });
          await buildTurn(run, { feedback: { round: round + 1, source: "verification", gaps } });
          if (run.cancelRequested) break;
          if (!run.state.artifacts.implDelta) throw new Error(`fix round ${round + 1} ended without a new impl-delta`);
          run.state.artifacts.verify = null;
          run.state.artifacts.audit = null;
        }
        // else: rounds exhausted — loop ends, failure reasons assembled below.
      }
      if (run.cancelRequested) throw new Error("cancelled");
      if (!accepted) {
        endStep(run, "verify", { status: "failed", error: "gates not accepted" });
        if (run.options.security !== "off") endStep(run, "security", { status: "cancelled", error: "skipped — verify failed" });
        run.state.status = "failed";
        run.state.error =
          `gates still failing after ${run.options.maxFixRounds} fix round(s): ${assembleFailureReasons(run) ?? "verification did not accept"}`;
        emit.event(run.id, "_run", { t: "notice", s: `run failed: ${run.state.error}` });
        await integrate(run, false);
        return;
      }

      // STEP 4 — security (optional; own bounded fix round + owner override).
      if (run.options.security !== "off") {
        for (let round = run.state.securityRound ?? 0; round <= SECURITY_FIX_ROUNDS; round++) {
          run.state.securityRound = round;
          emit.state(run);
          await securityRound(run, round);
          if (run.cancelRequested) break;
          const { fixable, unfixable } = securityBlocking(run);
          if (fixable.length === 0) {
            if (unfixable.length > 0) {
              emit.event(run.id, "security", {
                t: "notice",
                s: `${unfixable.length} unfixable critical/high finding(s) — owner override required`,
              });
              run.state.gate = {
                type: "security-override",
                nodeId: "security",
                findings: unfixable.map((f) => ({ severity: f.severity, title: f.title, evidence: String(f.evidence).slice(0, 300), fix: f.fix ?? null })),
              };
              emit.state(run);
              const decision = await new Promise((resolve) => {
                run.gateResolver = resolve;
              }).finally(() => {
                run.gateResolver = null;
                run.state.gate = null;
                emit.state(run);
              });
              if (decision === "cancel" || decision?.action === "cancel" || run.cancelRequested) throw new Error("cancelled at security gate");
              run.state.securityAccepted = { at: new Date().toISOString(), findings: unfixable.map((f) => f.id) };
              emit.event(run.id, "security", { t: "notice", s: "owner accepted the security risk — recording and continuing" });
            }
            endStep(run, "security");
            break;
          }
          if (round < SECURITY_FIX_ROUNDS) {
            const gaps = fixable.map(
              (f) => `[security/${f.severity}]${f.file ? ` ${f.file}:` : ""} ${f.title} — ${f.evidence}${f.fix ? ` (fix: ${f.fix})` : ""}`,
            );
            emit.event(run.id, "security", { t: "notice", s: `${fixable.length} fixable critical/high finding(s) — security fix round (resuming the build session)` });
            await buildTurn(run, { feedback: { round: round + 1, source: "security", gaps } });
            if (run.cancelRequested) break;
            if (!run.state.artifacts.implDelta) throw new Error(`security fix round ended without a new impl-delta`);
            run.state.artifacts.security = null;
          } else {
            endStep(run, "security", { status: "failed", error: "findings not fixed" });
            run.state.status = "failed";
            run.state.error = `security findings not fixed after ${SECURITY_FIX_ROUNDS} round(s): ${assembleFailureReasons(run) ?? fixable.map((f) => f.title).join("; ")}`;
            emit.event(run.id, "_run", { t: "notice", s: `run failed: ${run.state.error}` });
            await integrate(run, false);
            settle(run);
            return;
          }
        }
        if (run.cancelRequested) throw new Error("cancelled");
      }

      run.state.status = "completed";
      if (run.state.deferredChecks?.length) {
        emit.event(run.id, "_run", {
          t: "notice",
          s: `deferred to owner (${run.state.deferredChecks.length}): ${run.state.deferredChecks.map((d) => `[${d.env}] ${String(d.criterion).slice(0, 80)}`).join("; ")}`,
        });
      }
      const sec = run.state.artifacts.security;
      if (sec?.findings?.length) {
        emit.event(run.id, "_run", {
          t: "notice",
          s: `recorded security findings (non-blocking): ${sec.findings.map((f) => `[${f.severity}] ${f.title}`).slice(0, 5).join("; ")}`,
        });
      }
      await integrate(run, true);
    } catch (err) {
      if (run.finalized) {
        run.done.promiseSettled = true;
        run.done.box.promiseSettled = true;
        try {
          run.done.resolve(run.state.status);
        } catch {
          /* already resolved */
        }
        return;
      }
      gateClose(run);
      for (const st of run.state.steps) {
        if (st.status === "running") endStep(run, st.id, { status: "failed", error: String(err?.message ?? err).slice(0, 200) });
      }
      await integrate(run, false);
      if (run.cancelRequested) {
        run.state.status = "cancelled";
      } else {
        run.state.status = "failed";
        run.state.error = String(err?.message ?? err);
        emit.event(run.id, "_run", { t: "notice", s: `run failed: ${err.message}` });
      }
    }
    settle(run);
  }

  // --- controller API ---------------------------------------------------------------

  return {
    activeRunFor(projectName) {
      for (const run of runs.values()) {
        if (run.projectName === projectName && !run.done.promiseSettled) return run.id;
      }
      return null;
    },

    async start({
      id,
      task,
      project,
      models,
      clarify,
      requireQuestions,
      maxFixRounds,
      git: gitRequested,
      audit: auditRequested,
      approvePlan,
      remoteChecks: remoteChecksRequested,
      security: securityRequested,
      stopAfterClarify,
      ticketId,
      onSettled,
    }) {
      const options0 = { stopAfterClarify: !!stopAfterClarify };
      // Phase-aware tree lock: clarify-only runs (stopAfterClarify) are
      // read-only — many may overlap; only tree-holding runs exclude each other.
      for (const other of runs.values()) {
        if (other.projectPath !== project.path || other.done.promiseSettled) continue;
        if (!options0.stopAfterClarify && other.holdsTree) {
          throw new Error(
            `a run is already active on project "${project.name}" (${other.id}) and holds the working tree — wait for it to finish or cancel it`,
          );
        }
      }
      let gitInfo = null;
      if (gitRequested) {
        if (!(await git.isRepo(project.path))) {
          throw new Error("git is enabled but the project folder is not a git repository");
        }
        await git.assertClean(project.path);
        gitInfo = {
          enabled: true,
          baseBranch: await git.currentBranch(project.path),
          runBranch: `nano-cycle/${id}`,
        };
        await git.createBranch(project.path, gitInfo.runBranch, gitInfo.baseBranch);
      }
      const securityMode = ["off", "scan", "scan+vapt"].includes(securityRequested) ? securityRequested : "off";
      const options = {
        stopAfterClarify: !!stopAfterClarify,
        clarify: !!clarify,
        requireQuestions: clarify && requireQuestions === true,
        maxFixRounds: Number.isFinite(maxFixRounds) ? Math.min(Math.max(maxFixRounds, 0), 5) : MAX_FIX_ROUNDS,
        git: !!gitInfo,
        audit: auditRequested !== false,
        approvePlan: approvePlan !== false,
        remoteCi: remoteChecksRequested === true && !!gitInfo,
        security: securityMode,
        ticketId: ticketId ?? null,
      };
      const state = {
        version: 2,
        id,
        task,
        project: project.name,
        status: "running",
        createdAt: new Date().toISOString(),
        finishedAt: null,
        gateWaitMs: 0,
        gateSince: null,
        git: gitInfo ? { ...gitInfo, commits: [], merged: false, mergeError: null } : null,
        models,
        options,
        steps: [
          ...(options.clarify ? ["clarify"] : []),
          "build",
          "verify",
          ...(securityMode !== "off" ? ["security"] : []),
        ].map((sid) => ({
          id: sid,
          status: "queued",
          usage: { input: 0, output: 0, cacheRead: 0 },
          retries: 0,
          durationMs: 0,
          startedAt: null,
          endedAt: null,
          error: null,
          ...(sid === "build" ? { sessionFile: null, rounds: 0 } : {}),
          ...(["verify", "security"].includes(sid) ? { sessionFiles: [] } : {}),
        })),
        round: 0,
        securityRound: 0,
        qa: [],
        artifacts: {},
        gate: null,
        pendingPlanGate: null,
        pendingQuestions: null,
        deferredChecks: [],
        mechanicalChecks: null,
        remoteChecks: null,
        scannerResults: null,
        error: null,
      };
      const run = {
        id,
        task,
        projectName: project.name,
        projectPath: project.path,
        options,
        models,
        spec: null,
        sourceDocCache: undefined,
        state,
        current: new Map(),
        buildHandle: null,
        verifyHandle: null,
        securityHandle: null,
        gateResolver: null,
        answersResolver: null,
        cancelRequested: false,
        finalized: false,
        ciCapability: undefined,
        holdsTree: !options.stopAfterClarify,
        onSettled: typeof onSettled === "function" ? onSettled : null,
        git: gitInfo,
        __emit: emit,
        done: (() => {
          const d = promiseExternals();
          d.promiseSettled = false;
          return d;
        })(),
      };
      runs.set(id, run);
      emit.state(run);
      if (gitInfo) {
        emit.event(id, "_run", {
          t: "notice",
          s: `git: branch ${gitInfo.runBranch} created from ${gitInfo.baseBranch} — milestone commits, ff-merge on accepted verdict`,
        });
      } else {
        emit.event(id, "_run", {
          t: "notice",
          s: "git: OFF — all work will be uncommitted (one rm -rf from loss; audits score this as process debt). Enable Git, and Remote CI with a remote, for durable CI-proven runs",
        });
      }
      if (remoteChecksRequested === true && !gitInfo?.enabled) {
        emit.event(id, "_run", { t: "notice", s: "remote CI: requested but git is disabled for this run — remote CI verification off" });
      }
      if (securityMode !== "off") {
        emit.event(id, "_run", {
          t: "notice",
          s: `security step enabled: ${securityMode}${securityMode === "scan+vapt" ? " (scanners + running-app VAPT)" : " (scanner triage)"}`,
        });
      }
      execute(run).catch(() => {}); // execute() never throws — it finalizes state
      return state;
    },

    setStepModel(id, step, model) {
      const run = runs.get(id);
      if (!run) return { ok: false, error: "unknown run" };
      const s = stepState(run, step);
      if (!s) return { ok: false, error: "unknown step" };
      if (s.status === "running" || s.status === "done") {
        return { ok: false, error: `step "${step}" already ${s.status} — model swaps apply to queued steps only (one persistent session must not change models mid-context)` };
      }
      const spec = String(model ?? "auto");
      const role = { clarify: "clarify", build: "builder", verify: "verifier", security: "security" }[step];
      run.models[role] = spec;
      run.state.models = { ...run.models };
      emit.event(id, step, { t: "notice", s: `model set → ${spec}` });
      emit.state(run);
      return { ok: true };
    },

    answer(id, answers) {
      const run = runs.get(id);
      if (!run?.answersResolver) return false;
      const r = run.answersResolver;
      run.answersResolver = null;
      r(answers ?? {});
      return true;
    },

    gate(id, action, comments) {
      const run = runs.get(id);
      if (!run?.gateResolver) return false;
      const r = run.gateResolver;
      run.gateResolver = null;
      if (action === "cancel") run.cancelRequested = true;
      r(action === "reject" ? { action: "reject", comments: String(comments ?? "") } : action);
      return true;
    },

    cancel(id) {
      const run = runs.get(id);
      if (!run) return false;
      if (run.done.promiseSettled && ["completed", "failed", "cancelled"].includes(run.state.status)) {
        return false;
      }
      if (run.gateResolver) {
        const r = run.gateResolver;
        run.gateResolver = null;
        r("cancel");
      }
      if (run.answersResolver) {
        const r = run.answersResolver;
        run.answersResolver = null;
        r("cancel");
      }
      const first = finalizeCancel(run);
      if (first) {
        emit.event(run.id, "_run", { t: "notice", s: "cancel requested — stopping sessions and run processes" });
        try {
          const res = killRunProcesses({ cwdPrefix: run.projectPath });
          const n = res.terminated.length + res.killed.length;
          if (n > 0) {
            emit.event(run.id, "_run", {
              t: "notice",
              s: `terminated ${n} run process(es) (pids ${[...res.terminated, ...res.killed].join(", ")})`,
            });
          }
        } catch {
          /* best-effort only */
        }
        integrate(run, false).catch(() => {}).finally(() => emit.state(run));
      }
      return true;
    },

    resume(id) {
      const run = runs.get(id);
      if (!run) return { ok: false, error: "run not active in this server session — use resumeFromDisk for restart recovery" };
      if (!["cancelled", "failed"].includes(run.state.status)) {
        return { ok: false, error: "only cancelled or failed runs can be resumed" };
      }
      if (!run.done.promiseSettled) {
        return { ok: false, error: "run is still winding down — try again in a moment" };
      }
      let requeued = 0;
      for (const s of run.state.steps) {
        if (["cancelled", "failed", "running"].includes(s.status)) {
          s.status = "queued";
          s.error = null;
          s.startedAt = null;
          s.endedAt = null;
          requeued += 1;
        }
      }
      return restartExecute(run, `resumed by owner — ${requeued} step(s) requeued, milestones/artifacts kept (build session resumes from disk)`);
    },

    // v3: continue a "clarified" run (queue mode) into build/verify/security.
    // Rejects while another run holds the project's working tree.
    promote(id, onSettled) {
      const run = runs.get(id);
      if (!run) return { ok: false, error: "run not active in this server session" };
      if (run.state.status !== "clarified") {
        return { ok: false, error: `run status is "${run.state.status}" — only clarified runs can be promoted` };
      }
      if (!run.done.promiseSettled) {
        return { ok: false, error: "run is still settling — try again in a moment" };
      }
      const holder = [...runs.values()].find(
        (r) => r !== run && r.projectPath === run.projectPath && !r.done.promiseSettled && r.holdsTree,
      );
      if (holder) {
        return { ok: false, error: `the working tree is held by run ${holder.id} — the queue will retry when it finishes` };
      }
      run.holdsTree = true;
      run.options.stopAfterClarify = false; // persists via state.options (same object)
      if (typeof onSettled === "function") run.onSettled = onSettled; // build-phase callback replaces the clarify one
      return restartExecute(run, "promoted by the ticket queue — continuing into build/verify/security");
    },

    // v3: does any active run hold this project's working tree?
    treeLockHolder(projectPath) {
      for (const r of runs.values()) {
        if (r.projectPath === projectPath && !r.done.promiseSettled && r.holdsTree) return r.id;
      }
      return null;
    },

    // Restart recovery: rebuild the controller from runs/<id>/state.json. The
    // build session reopens from its persisted file (amendment 1); milestones
    // already recorded are never re-done.
    //
    // opts.promote (queue): a run parked as "clarified" on disk (its server
    // session is gone) continues into build/verify/security — the same law as
    // promote(), from disk. opts.onSettled wires the queue's settle callback.
    resumeFromDisk(id, project, opts = {}) {
      if (runs.has(id)) return { ok: false, error: "run is still active in this server session" };
      let state = null;
      try {
        state = JSON.parse(fs.readFileSync(path.join(runDir(id), "state.json"), "utf8"));
      } catch {
        return { ok: false, error: "unknown run (no state on disk)" };
      }
      if (state.version !== 2) {
        return { ok: false, error: "legacy (v1) run — not resumable by the step engine" };
      }
      const allowed = ["cancelled", "failed", "interrupted", ...(opts.promote ? ["clarified"] : [])];
      if (!allowed.includes(state.status)) {
        return { ok: false, error: `run status is "${state.status}" — only ${allowed.join("/")} runs can be resumed` };
      }
      let projectPath = project?.path;
      if (!projectPath) {
        // resolve from the registry by name; fall back to the sandbox
        try {
          projectPath = resolveProject(state.project).path;
        } catch {
          return { ok: false, error: `cannot resolve project "${state.project}" — register it first` };
        }
      }
      // Phase-aware lock (same law as promote): only a tree-HOLDING run blocks.
      for (const other of runs.values()) {
        if (other.projectPath === projectPath && !other.done.promiseSettled && other.holdsTree) {
          return { ok: false, error: `the working tree is held by run ${other.id} — the queue will retry when it finishes` };
        }
      }
      for (const s of state.steps) {
        if (["cancelled", "failed", "interrupted"].includes(s.status) || s.status === "running") {
          s.status = "queued";
          s.error = null;
        }
      }
      if (opts.promote) state.options.stopAfterClarify = false; // persists via state.options
      const run = {
        id,
        task: state.task,
        projectName: state.project,
        projectPath,
        options: state.options,
        models: state.models,
        spec: state.artifacts.spec ?? null,
        sourceDocCache: undefined,
        state,
        current: new Map(),
        buildHandle: null,
        verifyHandle: null,
        securityHandle: null,
        gateResolver: null,
        answersResolver: null,
        cancelRequested: false,
        finalized: false,
        ciCapability: undefined,
        pendingPlanGate: null,
        pendingQuestions: null,
        holdsTree: true, // a resumed run continues building — it owns the tree
        onSettled: typeof opts.onSettled === "function" ? opts.onSettled : null,
        git: state.git?.enabled ? state.git : null,
        __emit: emit,
        done: (() => {
          const d = promiseExternals();
          d.promiseSettled = false;
          return d;
        })(),
      };
      if (run.git?.enabled) run.git = { ...run.git };
      runs.set(id, run);
      return restartExecute(
        run,
        opts.promote
          ? "promoted from disk by the ticket queue — continuing into build/verify/security"
          : "resumed from disk after restart — milestones kept, build session reopens from its file",
      );
    },
  };

  function restartExecute(run, notice) {
    run.cancelRequested = false;
    run.finalized = false;
    run.buildHandle = null; // reopened lazily from step.sessionFile
    run.state.status = "running";
    run.state.finishedAt = null;
    run.state.error = null;
    run.state.gate = null;
    run.gateResolver = null;
    run.answersResolver = null;
    const d = promiseExternals();
    d.promiseSettled = false;
    run.done = d;
    emit.state(run);
    emit.event(run.id, "_run", { t: "notice", s: notice });
    execute(run).catch(() => {}); // execute() never throws — it finalizes state
    return { ok: true };
  }
}
