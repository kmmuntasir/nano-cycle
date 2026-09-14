// Pipeline engine — compiles plans into work graphs and executes them.
// Policy is code: readiness from dependsOn, N parallel coder lanes packed by
// file-disjointness, divergence gates, bounded fix rounds, counterpart-rule
// validation at compile time, per-node context injection from the project.
import fs from "node:fs";
import path from "node:path";
import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import {
  ARTIFACT_SCHEMAS,
  TIERS,
  MAX_FIX_ROUNDS,
  CLARIFY_PROFILE,
  profileFor,
  roleOf,
  LEGAL_SINGLE_SIDES,
} from "./config.mjs";
import { loadContext } from "./rules.mjs";
import {
  planSystem,
  planPrompt,
  planCapsSystem,
  planCapsPrompt,
  implementSystem,
  implementPrompt,
  verifySystem,
  verifyPrompt,
  clarifySystem,
  clarifyPrompt,
} from "./prompts.mjs";
import { runNode, makeTool, addUsage } from "./runner.mjs";
import * as git from "./git.mjs";
import { killRunProcesses } from "./prockill.mjs";
import { loadRun as loadRunFromDisk } from "./state.mjs";

const SYSTEM_FOR = {
  plan: planSystem,
  planCaps: planCapsSystem,
  implement: implementSystem,
  verify: verifySystem,
};

const pathKey = (p) => path.normalize(p).toLowerCase();
const disjoint = (a, b) => !a.some((x) => b.includes(x));

// Requirements are durable: the finalized spec lands inside the project it describes.
function writeSpecFile(run, emit) {
  try {
    const spec = run.spec;
    const dir = path.join(run.projectPath, ".nano-cycle");
    fs.mkdirSync(dir, { recursive: true });
    const md = [
      `# Spec — ${run.task}`,
      "",
      `Run: ${run.id} · Tier: ${run.tier} · Date: ${run.state.createdAt}`,
      "",
      "## Summary",
      "",
      spec.summary,
      "",
      "## Locked decisions",
      "",
      ...((spec.decisions ?? []).map((d) => `- **${d.topic}**: ${d.decision}`) || ["- (none)"]),
      "",
      "## Acceptance criteria",
      "",
      ...((spec.acceptance_criteria ?? []).map((c) => `- [ ] ${c}`) || ["- (none)"]),
      ...(spec.out_of_scope?.length ? ["", "## Out of scope", "", ...spec.out_of_scope.map((o) => `- ${o}`)] : []),
      "",
    ].join("\n");
    fs.writeFileSync(path.join(dir, `spec-${run.id}.md`), md);
    emit.event(run.id, "clarify", { t: "notice", s: `spec written: .nano-cycle/spec-${run.id}.md` });
  } catch (e) {
    emit.event(run.id, "clarify", { t: "notice", s: `spec file write failed: ${e.message}` });
  }
}

export function createPipeline({ modelRuntime, emit, webTools }) {
  const runs = new Map(); // runId -> controller

  const nodeState = (run, id) => run.state.nodes.find((n) => n.id === id);

  function beginNode(run, id) {
    const n = nodeState(run, id);
    n.status = "running";
    n.startedAt = Date.now();
    run.current.set(id, new AbortController());
    emit.state(run);
  }

  function endNode(run, id, patch = {}) {
    const n = nodeState(run, id);
    n.status = patch.status ?? "done";
    n.endedAt = Date.now();
    // Duration accumulates across fix-round re-runs of the same node.
    if (n.startedAt) n.durationMs = (n.durationMs ?? 0) + Math.max(0, n.endedAt - n.startedAt);
    Object.assign(n, patch);
    run.current.delete(id);
    emit.state(run);
  }

  // Hard cancel finalization: runs synchronously inside cancel() so the GUI
  // reflects "cancelled" immediately even if an in-flight model turn takes a
  // while to settle. execute()'s own finalization becomes a guarded no-op via
  // run.finalized. Finished nodes + artifacts are left untouched so a later
  // resume() can continue from the last queued/running nodes.
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
    const now = Date.now();
    for (const n of run.state.nodes) {
      if (n.status === "running") {
        if (n.startedAt) n.durationMs = (n.durationMs ?? 0) + Math.max(0, now - n.startedAt);
        n.status = "cancelled";
        n.endedAt = now;
        n.error = reason;
      }
    }
    gateClose(run);
    run.gateResolver = null;
    run.answersResolver = null;
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
    return true;
  }

  // Gate-wait accounting: time spent at human gates is excluded from "working time".
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

  function systemFor(run, id) {
    if (id === "verify") return SYSTEM_FOR.verify();
    if (id === "plan") return run.tier === "L" ? SYSTEM_FOR.planCaps() : SYSTEM_FOR.plan();
    return SYSTEM_FOR.implement(profileFor(id).lane);
  }

  async function execNode(run, id, prompt) {
    let profile = profileFor(id);
    if (id === "plan" && run.tier === "L") {
      profile = { ...profile, schema: ARTIFACT_SCHEMAS.plan_caps };
    }
    const node = nodeState(run, id);
    beginNode(run, id);
    // Context injection — the node's system prompt is assembled by the driver
    // from the project's conventional files; nothing is discovered at runtime.
    let systemPrompt = systemFor(run, id);
    const ctx = loadContext(run.projectPath, id, (f) =>
      emit.event(run.id, id, { t: "notice", s: `context injected: ${f.name} (${f.chars} chars)` }),
    );
    if (profile.rules) systemPrompt += `\n\n${profile.rules}`;
    if (ctx) systemPrompt += `\n\n${ctx}`;

    let lastErr = null;
    for (let attempt = 0; attempt <= 1; attempt++) {
      node.startedAt = Date.now();
      // Per-attempt resolution: a queued node picks up a model change made while
      // it waited; a running node restarts when the owner swaps its model.
      const modelSpec = run.nodeModels?.[id] ?? run.models[roleOf(id)] ?? "auto";
      try {
        const store = { artifacts: [] };
        const reportTool = makeTool({
          name: "report_artifact",
          label: "Report artifact",
          description:
            "Report the structured result of this pipeline node. Call it EXACTLY ONCE when your work is done.",
          schema: profile.schema,
          onCall: (p) => store.artifacts.push(p),
        });
        const artifact = await runNode({
          nodeId: id,
          tools: profile.tools,
          customTools: [reportTool],
          artifactStore: store,
          thinking: profile.thinking,
          systemPrompt,
          prompt,
          cwd: run.projectPath,
          modelSpec,
          modelRuntime,
          signal: run.current.get(id)?.signal,
          onEvent: (nodeId, ev) => {
            if (ev.t === "usage") addUsage(node.usage, ev.usage);
            emit.event(run.id, nodeId, ev);
          },
        });
        if (run.cancelRequested) {
          // Lost the race with cancel(): never publish post-cancel output.
          endNode(run, id, { status: "cancelled", error: "cancelled by owner" });
          throw new Error("cancelled");
        }
        run.state.artifacts[id] = artifact;
        run.state.prompts[id] = prompt;
        endNode(run, id);
        return artifact;
      } catch (err) {
        lastErr = err;
        if (run.cancelRequested) break;
        if (run.modelRestart.has(id)) {
          // the owner swapped this node's model mid-flight — restart fresh, the
          // attempt budget resets with the new model
          run.modelRestart.delete(id);
          attempt = -1;
          emit.event(run.id, id, { t: "notice", s: `restarting with ${run.nodeModels?.[id] ?? "auto"}` });
          continue;
        }
        node.retries += 1;
        emit.event(run.id, id, { t: "notice", s: `attempt failed: ${err.message}` });
        emit.event(run.id, id, { t: "notice", s: (err.stack ?? "").split("\n").slice(0, 6).join(" | ") });
      }
    }
    endNode(run, id, {
      status: run.cancelRequested ? "cancelled" : "failed",
      error: String(lastErr?.message ?? lastErr),
    });
    throw lastErr ?? new Error(`${id} failed`);
  }

  // --- L-tier plan → graph compiler -------------------------------------------

  function validateCapabilities(plan) {
    const caps = plan?.capabilities;
    if (!Array.isArray(caps) || caps.length === 0) throw new Error("plan has no capabilities");
    const ids = new Set(caps.map((c) => c.id));
    for (const c of caps) {
      if (!c.id || !ids.has(c.id)) throw new Error("capability without id");
      const be = c.backend ?? [];
      const fe = c.frontend ?? [];
      if (be.length === 0 && fe.length === 0) {
        throw new Error(`capability "${c.id}" has no files on either side`);
      }
      const oneSide = be.length === 0 || fe.length === 0;
      if (oneSide && !LEGAL_SINGLE_SIDES.includes(c.single_side_class)) {
        throw new Error(
          `capability "${c.id}" is single-sided (backend:${be.length}, frontend:${fe.length}) without a legal class — counterpart rule`,
        );
      }
      for (const d of c.dependsOn ?? []) {
        if (!ids.has(d)) throw new Error(`capability "${c.id}" depends on unknown "${d}"`);
        if (d === c.id) throw new Error(`capability "${c.id}" depends on itself`);
      }
    }
    // cycle check (DFS)
    const state = {};
    const visit = (id) => {
      if (state[id] === 2) return;
      if (state[id] === 1) throw new Error(`capability dependency cycle at "${id}"`);
      state[id] = 1;
      for (const d of caps.find((c) => c.id === id).dependsOn ?? []) visit(d);
      state[id] = 2;
    };
    for (const c of caps) visit(c.id);
  }

  function compileGraph(run, plan) {
    validateCapabilities(plan);
    const caps = plan.capabilities;
    const halves = (capId) => {
      const c = caps.find((x) => x.id === capId);
      const out = [];
      if (c.backend?.length) out.push(`impl-${capId}-be`);
      if (c.frontend?.length) out.push(`impl-${capId}-fe`);
      return out;
    };
    const nodes = [{ id: "plan", dependsOn: [] }];
    for (const c of caps) {
      const deps = ["plan", ...(c.dependsOn ?? []).flatMap((d) => halves(d))];
      if (c.backend?.length) nodes.push({ id: `impl-${c.id}-be`, dependsOn: deps });
      if (c.frontend?.length) nodes.push({ id: `impl-${c.id}-fe`, dependsOn: deps });
    }
    const implIds = nodes.filter((n) => n.id.startsWith("impl-")).map((n) => n.id);
    nodes.push({ id: "verify", dependsOn: implIds });

    // per-node coder assignments
    for (const c of caps) {
      if (c.backend?.length) {
        run.nodeWork[`impl-${c.id}-be`] = { lane: "backend", title: c.title, files: c.backend };
      }
      if (c.frontend?.length) {
        run.nodeWork[`impl-${c.id}-fe`] = { lane: "frontend", title: c.title, files: c.frontend };
      }
    }
    // dynamic nodes appear in state + GUI
    for (const n of nodes) {
      if (!nodeState(run, n.id)) {
        run.state.nodes.push({
          id: n.id,
          status: "queued",
          usage: { input: 0, output: 0, cacheRead: 0 },
          retries: 0,
          durationMs: 0,
          startedAt: null,
          endedAt: null,
          error: null,
        });
      }
    }
    emit.state(run);
    return nodes;
  }

  async function planPhase(run, tier) {
    const dynamic = tier === "L";
    const spec = run.spec;
    const prompt =
      (dynamic ? planCapsPrompt(run.task, run.projectPath) : planPrompt(run.task, run.projectPath)) +
      (spec ? `\n\n${specIntoPrompt(spec)}\n\nYour plan's acceptance_criteria MUST include every spec acceptance criterion verbatim (you may add more precise implementation-level criteria).` : "");
    let lastRejection = null;
    for (let attempt = 0; attempt <= 1; attempt++) {
      const extra = lastRejection
        ? `\n\nYour previous plan was REJECTED by the compiler: ${lastRejection}\nProduce a corrected plan.`
        : "";
      const plan = await execNode(run, "plan", prompt + extra);
      try {
        if (plan?.divergence) {
          run.state.gate = { type: "divergence", nodeId: "plan", divergence: plan.divergence };
          emit.event(run.id, "plan", { t: "notice", s: `divergence: ${plan.divergence}` });
          await waitGate(run); // throws if cancelled at the gate
          continue; // user approved despite divergence — accept the plan as-is
        }
        if (spec) {
          // spec contract check — the owner's criteria must survive planning
          const planCrit = (plan.acceptance_criteria ?? []).map((c) => c.toLowerCase().trim());
          const missing = (spec.acceptance_criteria ?? []).filter(
            (c) => !planCrit.some((p) => p.includes(c.toLowerCase().trim()) || c.toLowerCase().trim().includes(p)),
          );
          if (missing.length) {
            emit.event(run.id, "plan", {
              t: "notice",
              s: `spec contract warning: ${missing.length} spec criteria not carried verbatim into the plan — the verifier still gates on the spec`,
            });
          } else {
            emit.event(run.id, "plan", {
              t: "notice",
              s: `spec contract ok: all ${(spec.acceptance_criteria ?? []).length} spec criteria carried into the plan`,
            });
          }
        }
        if (dynamic) {
          validateCapabilities(plan);
          run.dynamicGraph = compileGraph(run, plan);
          emit.event(run.id, "_run", {
            t: "notice",
            s: `compiled work graph: ${run.dynamicGraph.filter((n) => n.id.startsWith("impl-")).length} coder nodes from ${plan.capabilities.length} capabilities`,
          });
        } else {
          // static tiers: the v1 plan is one slice — wire coder assignments
          run.nodeWork["implement"] = {
            title: plan?.task_summary,
            files: [...(plan?.backend ?? []), ...(plan?.frontend ?? [])],
          };
          run.nodeWork["implement-be"] = { lane: "backend", title: "backend half", files: plan?.backend ?? [] };
          run.nodeWork["implement-fe"] = { lane: "frontend", title: "frontend half", files: plan?.frontend ?? [] };

          // M: compile ONLY the halves that have files — no wasted coder spawns.
          if (tier === "M") {
            const halves = [];
            if (plan?.backend?.length) halves.push("implement-be");
            if (plan?.frontend?.length) halves.push("implement-fe");
            if (halves.length === 0) throw new Error("plan has no work on either side");
            const nodes = [{ id: "plan", dependsOn: [] }];
            for (const h of halves) nodes.push({ id: h, dependsOn: ["plan"] });
            nodes.push({ id: "verify", dependsOn: [...halves] });
            for (const n of nodes) {
              if (!nodeState(run, n.id)) {
                run.state.nodes.push({
                  id: n.id,
                  status: "queued",
                  usage: { input: 0, output: 0, cacheRead: 0 },
                  retries: 0,
                  durationMs: 0,
                  startedAt: null,
                  endedAt: null,
                  error: null,
                });
              }
            }
            run.dynamicGraph = nodes;
            emit.event(run.id, "_run", {
              t: "notice",
              s: `compiled work graph: ${halves.join(" ∥ ") || "no coder"} → verify`,
            });
          }
        }
        return plan;
      } catch (err) {
        lastRejection = String(err?.message ?? err);
        emit.event(run.id, "plan", { t: "notice", s: `plan rejected: ${lastRejection}` });
        emit.event(run.id, "plan", { t: "notice", s: (err.stack ?? "").split("\n").slice(0, 5).join(" | ") });
        delete run.state.artifacts.plan;
      }
    }
    throw new Error(`plan rejected after retry: ${lastRejection}`);
  }

  // Git: commit one coder node's files on the run branch. Serialized through
  // the run's commit chain so parallel lanes never race the index.
  function commitCoderOutput(run, nodeId, artifact) {
    if (!run.git?.enabled) return Promise.resolve();
    const files = (artifact?.files_written ?? [])
      .map((f) => path.resolve(run.projectPath, f))
      .filter((abs) => abs.startsWith(run.projectPath));
    if (files.length === 0) return Promise.resolve();
    const next = run.commitChain.then(async () => {
      try {
        for (const abs of files) {
          await git.stagePath(run.projectPath, path.relative(run.projectPath, abs));
        }
        if (!(await git.hasStaged(run.projectPath))) {
          emit.event(run.id, nodeId, { t: "notice", s: "git: nothing staged to commit" });
          return;
        }
        const title = run.nodeWork[nodeId]?.title ?? nodeId;
        const hash = await git.commit(run.projectPath, `feat: ${title} (nano ${run.id})`);
        run.state.git.commits.push({ node: nodeId, hash, files });
        emit.event(run.id, nodeId, {
          t: "notice",
          s: `git: committed ${files.length} file(s) (${hash.slice(0, 7)}) on ${run.git.runBranch}`,
        });
        emit.state(run);
      } catch (e) {
        emit.event(run.id, nodeId, { t: "notice", s: `git commit failed: ${e.message}` });
      }
    });
    run.commitChain = next.catch(() => {});
    return next;
  }

  // Verdict-gated integration: ff-merge the run branch into the base branch and
  // delete it. A rejected verdict keeps the branch (with its commits) around.
  async function integrate(run, accepted) {
    const g = run.git;
    if (!g?.enabled) return;
    try {
      await git.checkout(run.projectPath, g.baseBranch);
    } catch (e) {
      emit.event(run.id, "_run", { t: "notice", s: `git: checkout ${g.baseBranch} failed: ${e.message}` });
      return;
    }
    if (!accepted) {
      run.state.git.mergeError = "verdict not accepted — branch kept unmerged";
      emit.event(run.id, "_run", {
        t: "notice",
        s: `git: verdict not accepted — branch ${g.runBranch} kept with its commits for inspection`,
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

  // --- clarify (PM) phase — Step 1: ask → answers → repeat → spec ----------------

  function specIntoPrompt(spec) {
    return [
      "REQUIREMENTS SPEC (owner-locked — honor exactly):",
      `Summary: ${spec.summary}`,
      ...(spec.decisions?.length
        ? [`Locked decisions:\n${spec.decisions.map((d) => `- ${d.topic}: ${d.decision}`).join("\n")}`]
        : []),
      ...(spec.acceptance_criteria?.length
        ? [`Acceptance criteria (THE contract — the verifier gates on these):\n${spec.acceptance_criteria.map((c) => `- ${c}`).join("\n")}`]
        : []),
      ...(spec.out_of_scope?.length ? [`Out of scope: ${spec.out_of_scope.join("; ")}`] : []),
    ].join("\n");
  }

  async function clarifyPhase(run) {
    const rounds = [];
    let emptyRounds = 0;
    let round = 0;
    // UNCAPPED: the PM decides when nothing essential remains unknown. The
    // owner can cancel from the GUI at any point.
    while (true) {
      round += 1;
      const history = rounds.map((r, i) => ({
        round: i + 1,
        qna: r.questions.map((q) => ({ question: q.question, answer: r.answers[q.id] ?? "(no answer)" })),
      }));
      let prompt = clarifyPrompt(run.task, history, run.projectPath);
      if (emptyRounds > 0) {
        prompt += `\n\nYou have called ask_questions with no questions ${emptyRounds} time(s). Do NOT do that again — either ask real questions via ask_questions, or finalize via finalize_spec.`;
      }
      // Owner policy: at least one question round before the spec may be locked
      // (structural — the finalize tool is withheld until questions were asked).
      const mode = run.requireQuestions && rounds.length === 0 ? "questions-only" : "both";
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

      // questions → human answers gate
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
      run.state.gate = null;
      run.state.status = "running";
      emit.state(run);
    }
  }

  // PM-side analyst: the model decides WHEN to investigate; the driver owns the
  // spawned read-only session. Capped per clarify phase to bound cost.
  function makeInvestigateTool(run) {
    let calls = 0;
    return defineTool({
      name: "investigate",
      label: "Investigate",
      description:
        "Spawn a read-only analyst session to research a question about this project (code, " +
        "structure, conventions, data). Returns a concise evidence-backed digest with file paths.",
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
        await runNode({
          nodeId: "analyst",
          tools: ["read", "grep", "find", "ls"],
          customTools: [],
          requireArtifact: false,
          thinking: "low",
          systemPrompt:
            "You are a read-only ANALYST. Investigate the project and answer with a concise, " +
            "evidence-backed digest citing file paths. You have no write tools.",
          prompt: String(params.question),
          cwd: run.projectPath,
          modelSpec: run.models.clarify ?? run.models.plan ?? "auto",
          modelRuntime,
          signal: run.current.get("clarify")?.signal,
          onEvent: (_id, ev) => {
            if (ev.t === "text") digest += ev.s;
            if (ev.t === "usage") addUsage(usage, ev.usage);
            emit.event(run.id, "analyst", ev);
          },
        });
        const cs = nodeState(run, "clarify");
        if (cs) addUsage(cs.usage, usage);
        return { content: [{ type: "text", text: digest.trim() || "(analyst returned nothing)" }], details: {} };
      },
    });
  }

  async function clarifyNode(run, prompt, mode) {
    const node = nodeState(run, "clarify");
    beginNode(run, "clarify");
    const store = { result: null };
    // Asking questions is a HARD pause: the ask tool aborts the model's turn so
    // it can never self-answer and finalize in the same breath.
    const ctrl = new AbortController();
    const cancelSignal = run.current.get("clarify")?.signal;
    if (cancelSignal) cancelSignal.addEventListener("abort", () => ctrl.abort(), { once: true });
    const tools = [];
    if (mode !== "finalize-only") {
      tools.push(
        makeTool({
          name: "ask_questions",
          label: "Ask questions",
          description:
            "Ask the owner up to 5 high-leverage clarification questions. Call this when essential decisions are still unknown.",
          schema: ARTIFACT_SCHEMAS.questions,
          onCall: (p) => {
            store.result = { type: "questions", questions: p.questions ?? [] };
            ctrl.abort(); // hard pause — the owner answers in the GUI
          },
        }),
      );
    }
    tools.push(
      makeTool({
        name: "finalize_spec",
        label: "Finalize spec",
        description:
          "Finalize the requirements spec. Call this when nothing essential remains unknown.",
        schema: ARTIFACT_SCHEMAS.spec,
        onCall: (p) => store.result = { type: "spec", spec: p },
      }),
    );
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    byName.investigate = makeInvestigateTool(run);
    if (webTools?.search) byName.web_search = webTools.search;
    if (webTools?.reader) byName.web_reader = webTools.reader;
    const available = Object.keys(byName);
    emit.event(run.id, "clarify", { t: "notice", s: `tools available: ${available.join(", ")}` });
    let lastErr = null;
    for (let attempt = 0; attempt <= 1; attempt++) {
      try {
        await runNode({
          nodeId: "clarify",
          tools: available,
          customTools: available.map((n) => byName[n]),
          artifactStore: { artifacts: [] },
          requireArtifact: false, // clarify decides via ask/finalize tools, not report_artifact
          thinking: CLARIFY_PROFILE.thinking,
          systemPrompt: clarifySystem(),
          prompt: attempt === 0 ? prompt : prompt + "\n\nIMPORTANT: respond ONLY by calling the ask_questions tool or the finalize_spec tool — do not write your answer as text.",
          cwd: run.projectPath,
          modelSpec: run.models.clarify ?? run.models.plan ?? "auto",
          modelRuntime,
          signal: ctrl.signal,
          onEvent: (nodeId, ev) => {
            if (ev.t === "usage") addUsage(node.usage, ev.usage);
            emit.event(run.id, nodeId, ev);
          },
        });
        if (run.cancelRequested) {
          endNode(run, "clarify", { status: "cancelled", error: "cancelled by owner" });
          throw new Error("cancelled");
        }
        if (store.result) {
          endNode(run, "clarify");
          return store.result;
        }
        throw new Error("clarify node finished without calling ask_questions or finalize_spec");
      } catch (err) {
        if (store.result && !run.cancelRequested) {
          // the abort we issued to pause for the owner — not a failure
          endNode(run, "clarify");
          return store.result;
        }
        lastErr = err;
        if (run.cancelRequested) break;
        node.retries += 1;
        emit.event(run.id, "clarify", { t: "notice", s: `attempt failed: ${err.message}` });
      }
    }
    endNode(run, "clarify", { status: run.cancelRequested ? "cancelled" : "failed", error: String(lastErr?.message ?? lastErr) });
    throw lastErr ?? new Error("clarify failed");
  }

  // --- scheduling ---------------------------------------------------------------

  function implementReports(run) {
    const reports = {};
    for (const [k, v] of Object.entries(run.state.artifacts)) {
      if (k.startsWith("impl")) reports[k] = v;
    }
    return reports;
  }

  function promptFor(run, n) {
    if (n.id === "verify") {
      return verifyPrompt({
        task: run.task,
        plan: run.state.artifacts.plan,
        implementReports: implementReports(run),
        workspace: run.projectPath,
        spec: run.spec,
      });
    }
    const work = run.nodeWork[n.id];
    if (work) {
      return implementPrompt({
        task: run.task,
        workspace: run.projectPath,
        feedback: run.feedback,
        lane: work.lane,
        title: work.title,
        files: work.files,
        spec: run.spec,
      });
    }
    return implementPrompt({
      task: run.task,
      workspace: run.projectPath,
      feedback: run.feedback,
      planJson: run.state.artifacts.plan,
      spec: run.spec,
    });
  }

  // Greedy lane packing: nodes whose file lists OVERLAP must serialize — they
  // chain within one lane; disjoint nodes go to separate lanes and run parallel.
  function packParallel(run, ready) {
    const filesOf = (id) => (run.nodeWork[id]?.files ?? []).map((f) => pathKey(f.path));
    const lanes = [];
    for (const n of ready) {
      const f = filesOf(n.id);
      let conflictLane = null;
      for (const lane of lanes) {
        if (lane.some((m) => !disjoint(filesOf(m.id), f))) {
          conflictLane = lane;
          break;
        }
      }
      if (conflictLane) conflictLane.push(n);
      else lanes.push([n]);
    }
    return lanes;
  }

  async function runDag(run) {
    const done = (id) => nodeState(run, id)?.status === "done";
    while (!run.cancelRequested) {
      // Resolved per-iteration: for M/L the compile happens mid-round (right
      // after plan), and the running loop must pick the graph up immediately.
      const graph = run.dynamicGraph ?? TIERS[run.tier];
      const ready = graph.filter(
        (n) => nodeState(run, n.id)?.status === "queued" && n.dependsOn.every(done),
      );
      if (ready.length === 0) break;

      if (ready.some((n) => n.id === "plan")) {
        await planPhase(run, run.tier);
        continue;
      }

      const execCoder = async (n) => {
        const artifact = await execNode(run, n.id, promptFor(run, n));
        if (n.id.startsWith("impl")) await commitCoderOutput(run, n.id, artifact);
        return artifact;
      };

      if (ready.length === 1) {
        await execCoder(ready[0]);
        continue;
      }
      const lanes = packParallel(run, ready);
      const wave = lanes.map((lane) => lane.map((n) => n.id).join("+"));
      emit.event(run.id, "_run", {
        t: "notice",
        s: `wave: ${lanes.length} parallel lane(s) [${wave.join(" | ")}]`,
      });
      await Promise.all(
        lanes.map(async (lane) => {
          // NOTE: execCoder takes the node only — passing `run` here used to
          // feed the run id into profileFor() and kill every parallel wave
          // with "unknown node: <run-id>".
          for (const n of lane) await execCoder(n);
        }),
      );
    }
    if (run.cancelRequested) throw new Error("cancelled");
  }

  async function waitGate(run) {
    run.state.status = "awaiting-gate";
    gateOpen(run);
    emit.state(run);
    const decision = await new Promise((resolve) => {
      run.gateResolver = resolve;
    });
    run.gateResolver = null;
    gateClose(run);
    if (decision === "cancel") throw new Error("cancelled at gate");
    run.state.status = "running";
    run.state.gate = null;
    emit.state(run);
  }

  async function execute(run) {
    try {
      // Step 1 — clarify (PM loop): ask → answers → repeat → spec.
      // Skipped when a spec is already locked (resume after cancel).
      if (run.clarify && !run.spec) {
        const spec = await clarifyPhase(run);
        run.spec = spec;
        run.state.artifacts.spec = spec;
        writeSpecFile(run, emit);
      }

      // Step 2 — build: plan → parallel coders → verify, verdict-gated.
      let verdict = null;
      for (let round = 0; round <= run.maxFixRounds; round++) {
        if (round > 0) {
          // Requeue coder + verify nodes; the plan (and compiled graph) stands.
          for (const n of run.state.nodes) {
            if (n.id !== "plan" && n.id !== "clarify" && n.id.startsWith("impl")) {
              n.status = "queued";
              n.startedAt = null;
              n.endedAt = null;
            }
          }
          if (nodeState(run, "verify")) nodeState(run, "verify").status = "queued";
          emit.state(run);
        }
        await runDag(run);
        verdict = run.state.artifacts.verify?.verdict ?? "gaps-found";
        if (verdict === "accepted" || run.cancelRequested) break;
        run.feedback = (run.state.artifacts.verify?.checks ?? [])
          .filter((c) => !c.pass)
          .map((c) => `- ${c.criterion}: ${c.evidence ?? ""}`)
          .join("\n");
        if (round < run.maxFixRounds) {
          emit.event(run.id, "verify", { t: "notice", s: `gaps-found — fix round ${round + 1}` });
        }
      }
      run.state.status = verdict === "accepted" ? "completed" : "failed";
      await integrate(run, verdict === "accepted");
    } catch (err) {
      // Already finalized synchronously by cancel(): don't overwrite the
      // persisted cancelled state, just make sure the run settled.
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
      await integrate(run, false);
      if (run.cancelRequested) {
        run.state.status = "cancelled";
      } else {
        run.state.status = "failed";
        run.state.error = String(err?.message ?? err);
        emit.event(run.id, "_run", { t: "notice", s: `run failed: ${err.message}` });
      }
    }
    run.state.finishedAt = Date.now();
    run.done.promiseSettled = true;
    emit.state(run);
    run.done.box.promiseSettled = true;
    run.done.resolve(run.state.status);
  }

  return {
    activeRunFor(projectName) {
      for (const run of runs.values()) {
        if (run.state.project === projectName && !run.done.promiseSettled) return run.id;
      }
      return null;
    },

    async start({ id, task, tier, project, models, clarify, requireQuestions, maxFixRounds, git: gitRequested }) {
      const tierGraph = TIERS[tier];
      if (!tierGraph) throw new Error(`unknown tier ${tier}`);
      // One working tree per project: a second concurrent run on the same
      // project would trample the first run's branch checkout and commits.
      for (const other of runs.values()) {
        if (other.projectPath === project.path && !other.done.promiseSettled) {
          throw new Error(
            `a run is already active on project "${project.name}" (${other.id}) — wait for it to finish or cancel it`,
          );
        }
      }

      // Git integration: fresh branch per run, commits per coder node, ff-merge
      // back on an accepted verdict. Requires a clean tree at start.
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
          commits: [],
          merged: false,
          mergeError: null,
        };
        await git.createBranch(project.path, gitInfo.runBranch, gitInfo.baseBranch);
      }
      const state = {
        id,
        task,
        tier,
        project: project.name,
        status: "running",
        createdAt: new Date().toISOString(),
        finishedAt: null,
        gateWaitMs: 0,
        gateSince: null,
        git: gitInfo
          ? { ...gitInfo, commits: [] }
          : null,
        models,
        gate: null,
        error: null,
        nodes: [
          ...(clarify ? [{ id: "clarify", dependsOn: [] }] : []),
          ...tierGraph.map((n) => ({ ...n })),
        ].map((n) => ({
          id: n.id,
          status: "queued",
          usage: { input: 0, output: 0, cacheRead: 0 },
          retries: 0,
          durationMs: 0,
          startedAt: null,
          endedAt: null,
          error: null,
        })),
        artifacts: {},
        prompts: {},
        nodeModels: {},
      };
      const run = {
        id,
        task,
        tier,
        projectPath: project.path,
        models,
        clarify: !!clarify,
        // Optional owner policy: force >=1 question round (finalize tool
        // withheld on round 1). Default off — prompt quality drives asking.
        requireQuestions: clarify && requireQuestions === true,
        git: gitInfo,
        commitChain: Promise.resolve(),
        nodeModels: {},
        modelRestart: new Set(),
        maxFixRounds: Number.isFinite(maxFixRounds) ? Math.min(Math.max(maxFixRounds, 0), 5) : MAX_FIX_ROUNDS,
        spec: null,
        state,
        current: new Map(),
        gateResolver: null,
        answersResolver: null,
        cancelRequested: false,
        finalized: false,
        feedback: null,
        nodeWork: {}, // nodeId → {lane, title, files}
        dynamicGraph: null,
        done: (() => { const d = promiseExternals(); d.promiseSettled = false; return d; })(),
      };
      runs.set(id, run);
      emit.state(run);
      if (gitInfo) {
        emit.event(id, "_run", {
          t: "notice",
          s: `git: branch ${gitInfo.runBranch} created from ${gitInfo.baseBranch} — commits per coder node, ff-merge on accepted verdict`,
        });
      }
      execute(run).catch(() => {}); // execute() never throws — it finalizes state
      return state;
    },

    setNodeModel(id, node, model) {
      const run = runs.get(id);
      if (!run) return { ok: false, error: "unknown run" };
      if (!nodeState(run, node)) return { ok: false, error: "unknown node" };
      const spec = String(model ?? "auto");
      run.nodeModels[node] = spec;
      run.state.nodeModels = { ...run.nodeModels };
      const st = nodeState(run, node);
      if (st.status === "running") {
        run.modelRestart.add(node);
        run.current.get(node)?.abort();
        emit.event(id, node, { t: "notice", s: `model changed → restarting with ${spec}` });
      } else {
        emit.event(id, node, { t: "notice", s: `model set → ${spec}` });
      }
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

    gate(id, action) {
      const run = runs.get(id);
      if (!run?.gateResolver) return false;
      const r = run.gateResolver;
      run.gateResolver = null;
      if (action === "cancel") run.cancelRequested = true;
      r(action);
      return true;
    },

    cancel(id) {
      const run = runs.get(id);
      if (!run) return false;
      if (run.done.promiseSettled && ["completed", "failed", "cancelled"].includes(run.state.status)) {
        return false; // already terminal — nothing to stop
      }
      // Resolve pending human gates as cancelled so waiters wake up.
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
        // Best-effort: kill stray child processes (dev servers, watchers,
        // test runners) the run's bash tool left behind.
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
        // Leave the tree on a clean branch state without merging.
        integrate(run, false).catch(() => {}).finally(() => emit.state(run));
      }
      return true;
    },

    resume(id) {
      const run = runs.get(id);
      if (!run) {
        let disk = null;
        try {
          disk = loadRunFromDisk(id);
        } catch {
          /* not on disk either */
        }
        if (disk) {
          return {
            ok: false,
            error: `run is not active in this server session (status: ${disk.state.status}) — resume is unavailable after a restart`,
          };
        }
        return { ok: false, error: "unknown run" };
      }
      if (!["cancelled", "failed"].includes(run.state.status)) {
        return { ok: false, error: "only cancelled or failed runs can be resumed" };
      }
      if (!run.done.promiseSettled) {
        return { ok: false, error: "run is still winding down — try again in a moment" };
      }
      if (!run.state.nodes.some((n) => n.status === "queued" || n.status === "cancelled" || n.status === "failed")) {
        return { ok: false, error: "nothing to resume — every node already finished" };
      }
      // Requeue whatever never finished; done nodes keep status + artifacts.
      let requeued = 0;
      for (const n of run.state.nodes) {
        if (n.status === "cancelled" || n.status === "failed") {
          n.status = "queued";
          n.error = null;
          n.startedAt = null;
          n.endedAt = null;
          requeued += 1;
        }
      }
      run.cancelRequested = false;
      run.finalized = false;
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
      emit.event(run.id, "_run", {
        t: "notice",
        s: `resumed by owner — ${requeued} node(s) requeued, finished nodes kept`,
      });
      execute(run).catch(() => {}); // execute() never throws — it finalizes state
      return { ok: true };
    },
  };
}

function promiseExternals() {
  const box = { promiseSettled: false };
  const promise = new Promise((r) => {
    box.resolve = r;
  });
  return { promise: box.promise, resolve: box.resolve, box };
}
