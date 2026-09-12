// Pipeline engine — compiles plans into work graphs and executes them.
// Policy is code: readiness from dependsOn, N parallel coder lanes packed by
// file-disjointness, divergence gates, bounded fix rounds, counterpart-rule
// validation at compile time, per-node context injection from the project.
import path from "node:path";
import { ARTIFACT_SCHEMAS, TIERS, MAX_FIX_ROUNDS, profileFor, roleOf, LEGAL_SINGLE_SIDES } from "./config.mjs";
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
} from "./prompts.mjs";
import { runNode, addUsage } from "./runner.mjs";

const SYSTEM_FOR = {
  plan: planSystem,
  planCaps: planCapsSystem,
  implement: implementSystem,
  verify: verifySystem,
};

const pathKey = (p) => path.normalize(p).toLowerCase();
const disjoint = (a, b) => !a.some((x) => b.includes(x));

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
      try {
        const artifact = await runNode({
          nodeId: id,
          profile,
          systemPrompt,
          prompt,
          cwd: run.projectPath,
          modelSpec: run.models[roleOf(id)] ?? "auto",
          modelRuntime,
          signal: run.current.get(id)?.signal,
          onEvent: (nodeId, ev) => {
            if (ev.t === "usage") addUsage(node.usage, ev.usage);
            emit.event(run.id, nodeId, ev);
          },
        });
        run.state.artifacts[id] = artifact;
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
    const prompt = dynamic ? planCapsPrompt(run.task, run.projectPath) : planPrompt(run.task, run.projectPath);
    const schemaName = dynamic ? "plan_caps" : "plan";
    let lastRejection = null;
    for (let attempt = 0; attempt <= 1; attempt++) {
      const extra = lastRejection
        ? `\n\nYour previous plan was REJECTED by the compiler: ${lastRejection}\nProduce a corrected plan.`
        : "";
      const plan = await execNode(run, "plan", prompt + extra);
      try {
        if (plan?.divergence) {
          run.state.gate = { nodeId: "plan", divergence: plan.divergence };
          emit.event(run.id, "plan", { t: "notice", s: `divergence: ${plan.divergence}` });
          await waitGate(run); // throws if cancelled at the gate
          continue; // user approved despite divergence — accept the plan as-is
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
        }
        return plan;
      } catch (err) {
        lastRejection = String(err?.message ?? err);
        emit.event(run.id, "plan", { t: "notice", s: `plan rejected: ${lastRejection}` });
        delete run.state.artifacts.plan;
      }
    }
    throw new Error(`plan rejected after retry: ${lastRejection}`);
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
      });
    }
    return implementPrompt({
      task: run.task,
      workspace: run.projectPath,
      feedback: run.feedback,
      planJson: run.state.artifacts.plan,
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
    const graph = run.tier === "L" ? (run.dynamicGraph ?? TIERS.L) : TIERS[run.tier];
    const done = (id) => nodeState(run, id)?.status === "done";
    while (!run.cancelRequested) {
      const ready = graph.filter(
        (n) => nodeState(run, n.id)?.status === "queued" && n.dependsOn.every(done),
      );
      if (ready.length === 0) break;

      if (ready.some((n) => n.id === "plan")) {
        await planPhase(run, run.tier);
        continue;
      }

      if (ready.length === 1) {
        await execNode(run, ready[0].id, promptFor(run, ready[0]));
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
          for (const n of lane) await execNode(run, n.id, promptFor(run, n));
        }),
      );
    }
    if (run.cancelRequested) throw new Error("cancelled");
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
    try {
      let verdict = null;
      for (let round = 0; round <= MAX_FIX_ROUNDS; round++) {
        if (round > 0) {
          // Requeue coder + verify nodes; the plan (and compiled graph) stands.
          for (const n of run.state.nodes) {
            if (n.id !== "plan" && n.id.startsWith("impl")) {
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
      const tierGraph = TIERS[tier];
      if (!tierGraph) throw new Error(`unknown tier ${tier}`);
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
        nodes: tierGraph.map((n) => ({
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
        nodeWork: {}, // nodeId → {lane, title, files}
        dynamicGraph: null,
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

function promiseExternals() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
