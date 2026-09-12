// Pipeline engine — a generic DAG scheduler. Policy is code: readiness from
// dependsOn, parallel lanes when the plan's halves are disjoint, gates on
// divergence, bounded fix rounds, per-node context injection from the project.
import fs from "node:fs";
import path from "node:path";
import { NODE_PROFILES, TIERS, MAX_FIX_ROUNDS } from "./config.mjs";
import { loadContext } from "./rules.mjs";
import {
  planSystem,
  planPrompt,
  implementSystem,
  implementPrompt,
  verifySystem,
  verifyPrompt,
} from "./prompts.mjs";
import { runNode, addUsage } from "./runner.mjs";

export function createPipeline({ modelRuntime, emit }) {
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
    Object.assign(n, patch);
    run.current.delete(id);
    emit.state(run);
  }

  async function execNode(run, id, prompt) {
    const profile = NODE_PROFILES[id];
    const node = nodeState(run, id);
    beginNode(run, id);
    // Context injection — the node's system prompt is assembled by the driver
    // from the project's conventional files; nothing is discovered at runtime.
    let systemPrompt = SYSTEM_FOR[id]() + (profile.rules ? `\n\n${profile.rules}` : "");
    const ctx = loadContext(run.projectPath, id, (f) =>
      emit.event(run.id, id, { t: "notice", s: `context injected: ${f.name} (${f.chars} chars)` }),
    );
    if (ctx) systemPrompt += `\n\n${ctx}`;
    let lastErr = null;
    for (let attempt = 0; attempt <= 1; attempt++) {
      try {
        const artifact = await runNode({
          nodeId: id,
          profile,
          systemPrompt,
          prompt,
          cwd: run.projectPath,
          modelSpec: run.models[id] ?? "auto",
          modelRuntime,
          signal: run.current.get(id)?.signal,
          onEvent: (nodeId, ev) => {
            if (ev.t === "usage") addUsage(node.usage, ev.usage);
            emit.event(run.id, nodeId, ev);
          },
        });
        run.state.artifacts[profile.artifact] = artifact;
        endNode(run, id);
        return artifact;
      } catch (err) {
        lastErr = err;
        if (run.cancelRequested) break;
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

  function implementReports(run) {
    const reports = {};
    for (const key of ["implement", "implement-be", "implement-fe"]) {
      if (run.state.artifacts[key]) reports[key] = run.state.artifacts[key];
    }
    return reports;
  }

  // Run every queued node whose deps are done; lanes go parallel when disjoint.
  async function runDag(run, graph) {
    const done = (id) => nodeState(run, id)?.status === "done";
    while (!run.cancelRequested) {
      const ready = graph.filter(
        (n) => nodeState(run, n.id).status === "queued" && n.dependsOn.every(done),
      );
      if (ready.length === 0) break;

      // Plan runs alone; a divergence stops at the human gate.
      if (ready.some((n) => n.id === "plan")) {
        const plan = await execNode(run, "plan", planPrompt(run.task, run.projectPath));
        if (plan?.divergence) {
          run.state.gate = { nodeId: "plan", divergence: plan.divergence };
          emit.event(run.id, "plan", { t: "notice", s: `divergence: ${plan.divergence}` });
          await waitGate(run); // throws if cancelled at the gate
        }
        continue;
      }

      const lanes = ready.filter((n) => NODE_PROFILES[n.id].lane);
      const promptFor = (n) =>
        n.id === "verify"
          ? verifyPrompt({
              task: run.task,
              plan: run.state.artifacts.plan,
              implementReports: implementReports(run),
              workspace: run.projectPath,
            })
          : implementPromptFor(run, n.id);
      const parallel = ready.length === 2 && lanes.length === 2 && planDisjoint(run);
      if (parallel) {
        emit.event(run.id, "_run", { t: "notice", s: "lanes parallel — disjoint file lists" });
        await Promise.all(ready.map((n) => execNode(run, n.id, promptFor(n))));
      } else {
        if (lanes.length === 2) {
          emit.event(run.id, "_run", { t: "notice", s: "lanes sequential — overlapping files" });
        }
        for (const n of ready) await execNode(run, n.id, promptFor(n));
      }
    }
    if (run.cancelRequested) throw new Error("cancelled");
  }

  function planDisjoint(run) {
    const plan = run.state.artifacts.plan;
    const paths = (lane) => (plan?.[lane] ?? []).map((f) => path.normalize(f.path).toLowerCase());
    const be = paths("backend");
    const fe = paths("frontend");
    return !be.some((p) => fe.includes(p));
  }

  function implementPromptFor(run, id) {
    const lane = NODE_PROFILES[id].lane;
    return implementPrompt({
      task: run.task,
      plan: run.state.artifacts.plan,
      workspace: run.projectPath,
      feedback: run.feedback,
      lane,
    });
  }

  async function waitGate(run) {
    run.state.status = "awaiting-gate";
    emit.state(run);
    const decision = await new Promise((resolve) => {
      run.gateResolver = resolve;
    });
    run.gateResolver = null;
    if (decision === "cancel") throw new Error("cancelled at gate");
    run.state.status = "running";
    run.state.gate = null;
    emit.state(run);
  }

  async function execute(run) {
    const graph = TIERS[run.tier];
    try {
      let verdict = null;
      for (let round = 0; round <= MAX_FIX_ROUNDS; round++) {
        if (round > 0) {
          // Requeue the implementation and verification nodes; the plan stands.
          for (const n of graph) {
            if (n.id.startsWith("implement") || n.id === "verify") {
              const ns = nodeState(run, n.id);
              ns.status = "queued";
              ns.startedAt = null;
              ns.endedAt = null;
            }
          }
          emit.state(run);
        }
        await runDag(run, graph);
        verdict = run.state.artifacts.verify?.verdict ?? "gaps-found";
        if (verdict === "accepted" || run.cancelRequested) break;
        run.feedback = (run.state.artifacts.verify?.checks ?? [])
          .filter((c) => !c.pass)
          .map((c) => `- ${c.criterion}: ${c.evidence ?? ""}`)
          .join("\n");
        if (round < MAX_FIX_ROUNDS) {
          emit.event(run.id, "verify", { t: "notice", s: `gaps-found — fix round ${round + 1}` });
        }
      }
      run.state.status = verdict === "accepted" ? "completed" : "failed";
    } catch (err) {
      if (run.cancelRequested) {
        run.state.status = "cancelled";
      } else {
        run.state.status = "failed";
        run.state.error = String(err?.message ?? err);
        emit.event(run.id, "_run", { t: "notice", s: `run failed: ${err.message}` });
      }
    }
    emit.state(run);
    run.done.resolve(run.state.status);
  }

  return {
    start({ id, task, tier, project, models }) {
      const graph = TIERS[tier];
      if (!graph) throw new Error(`unknown tier ${tier}`);
      const state = {
        id,
        task,
        tier,
        project: project.name,
        status: "running",
        createdAt: new Date().toISOString(),
        models,
        gate: null,
        error: null,
        nodes: graph.map((n) => ({
          id: n.id,
          status: "queued",
          usage: { input: 0, output: 0, cacheRead: 0 },
          retries: 0,
          startedAt: null,
          endedAt: null,
          error: null,
        })),
        artifacts: {},
      };
      const run = {
        id,
        task,
        tier,
        projectPath: project.path,
        models,
        state,
        current: new Map(),
        gateResolver: null,
        cancelRequested: false,
        feedback: null,
        done: promiseExternals(),
      };
      runs.set(id, run);
      emit.state(run);
      execute(run).catch(() => {}); // execute() never throws — it finalizes state
      return state;
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
      run.cancelRequested = true;
      for (const c of run.current.values()) c.abort();
      if (run.gateResolver) {
        const r = run.gateResolver;
        run.gateResolver = null;
        r("cancel");
      }
      return true;
    },
  };
}

// Base system prompt per node id (project context appended by execNode).
const SYSTEM_FOR = {
  plan: planSystem,
  implement: () => implementSystem(undefined),
  "implement-be": () => implementSystem("backend"),
  "implement-fe": () => implementSystem("frontend"),
  verify: verifySystem,
};

function promiseExternals() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
