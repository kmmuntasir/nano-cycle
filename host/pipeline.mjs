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
  auditSystem,
  auditPrompt,
  clarifySystem,
  clarifyPrompt,
} from "./prompts.mjs";
import { runNode, makeTool, addUsage } from "./runner.mjs";
import { runMechanicalChecks } from "./checks.mjs";
import { detectCiCapability, watchRunsForSha } from "./ci.mjs";
import * as git from "./git.mjs";
import { killRunProcesses } from "./prockill.mjs";
import { loadRun as loadRunFromDisk } from "./state.mjs";

const SYSTEM_FOR = {
  plan: planSystem,
  planCaps: planCapsSystem,
  implement: implementSystem,
  verify: verifySystem,
  audit: auditSystem,
};

const pathKey = (p) => path.normalize(p).toLowerCase();
const disjoint = (a, b) => !a.some((x) => b.includes(x));

// Normalize a possibly-absolute, possibly :line-suffixed path reference (from
// verify evidence, audit findings, or artifacts) to a project-relative key.
function fileKey(run, p) {
  let s = String(p).trim().replace(/:\d+$/, "");
  if (path.isAbsolute(s)) {
    const rel = path.relative(run.projectPath, s);
    if (!rel.startsWith("..")) s = rel;
  }
  return path.normalize(s).replace(/^\.\//, "").toLowerCase();
}

// Spec acceptance-criteria verification environments: exact → normalized →
// substring match (the verifier's criterion text need not be byte-identical).
function matchAcVerification(acVerification, criterion) {
  const list = Array.isArray(acVerification) ? acVerification : [];
  const norm = (s) => String(s ?? "").toLowerCase().replace(/\s+/g, " ").trim();
  const target = norm(criterion);
  if (!target) return null;
  let hit = list.find((a) => norm(a.criterion) === target);
  if (!hit) {
    hit = list.find(
      (a) => norm(a.criterion).includes(target) || target.includes(norm(a.criterion)),
    );
  }
  return hit?.env ?? null;
}

// Evidence that smells of an environment limit rather than a real defect.
const ENV_LIMIT_RE =
  /not verifiable|no (github )?remote|branch protection|hosted (service|ci|runtime)|cannot (access|observe|verify)|can't (access|observe|verify)|needs? (a )?(human|person|owner|manual)|external (service|system)|manual(ly)? (check|verif)|not observable/i;

// Extract plausible file-path tokens from gap text (criterion + evidence or an
// audit finding). Short bare filenames without a slash are noise (index.ts).
const PATH_TOKEN_RE = /(?:[.~\/]?[\w@.-]+\/)*[\w@.-]+\.[A-Za-z]{1,8}(?::\d+)?/g;
function pathTokensIn(text) {
  const out = [];
  for (const m of String(text ?? "").matchAll(PATH_TOKEN_RE)) {
    const raw = m[0].replace(/:\d+$/, "");
    if (!raw.includes("/") && raw.length < 6) continue; // e.g. "a.ts" noise
    out.push(raw);
  }
  return out;
}

// Commit suffix honors the project git-guidelines convention: cite the ticket
// id the task names (OMNI-###, F##, ###); fall back to the run id.
const COMMIT_ID_RE = /\b(OMNI-\d{1,4}|F\d{1,3}|#\d+)\b/i;
function commitSuffixFor(task, runId) {
  const m = String(task ?? "").match(COMMIT_ID_RE);
  return m ? `(${m[1].toUpperCase()})` : `(nano ${runId})`;
}

// Exported for unit testing (fix-round targeting + AC-env matching are the
// two behaviors most worth locking down as the pipeline evolves).
export const __internals = { fileKey, matchAcVerification, ENV_LIMIT_RE, pathTokensIn, commitSuffixFor };

// Source-doc loader: the spec's source_docs paths are resolved inside the
// project and their raw text is handed to verify/audit so the ORIGINAL
// requirements gate the run — closing the lossy spec-translation hole.
// Missing/unreadable files degrade to a notice, never a crash.
function loadSourceDocs(run, emit) {
  const docs = run.spec?.source_docs;
  if (!Array.isArray(docs) || docs.length === 0) return null;
  const parts = [];
  for (const rel of docs.slice(0, 5)) {
    const abs = path.resolve(run.projectPath, String(rel));
    if (!abs.startsWith(path.resolve(run.projectPath))) continue; // stay in the project
    try {
      let content = fs.readFileSync(abs, "utf8");
      if (content.length > 30_000) content = content.slice(0, 30_000) + "\n(truncated)";
      parts.push(`--- ${rel} ---\n${content}`);
    } catch {
      emit.event(run.id, "_run", { t: "notice", s: `source doc unreadable: ${rel}` });
    }
  }
  return parts.length ? parts.join("\n\n") : null;
}

// Source docs are run inputs — read once per run and shared by every node
// (verify/audit already had them; coders get them too now).
function sourceDocsFor(run, emit) {
  if (run.sourceDocCache === undefined || run.sourceDocCache === null) {
    run.sourceDocCache = loadSourceDocs(run, emit) ?? "";
  }
  return run.sourceDocCache || null;
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
    if (id === "verify" || id.startsWith("verify-")) return SYSTEM_FOR.verify();
    if (id === "audit") return SYSTEM_FOR.audit();
    if (id === "plan") return run.tier === "L" ? SYSTEM_FOR.planCaps() : SYSTEM_FOR.plan();
    return SYSTEM_FOR.implement(profileFor(id).lane);
  }

  async function execNode(run, id, prompt) {
    // Never start a fresh node session against a cancelled run (the plan-retry
    // loop used to relaunch the planner after a cancel-at-gate).
    if (run.cancelRequested) throw new Error("cancelled");
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
        // Verify gets a real browser when obscura is available — rendering
        // criteria (fonts, layout, visible strings) are invisible to curl.
        // Tool names must appear in the allowlist to be reachable (SDK contract).
        const nodeTools = [...profile.tools];
        const nodeCustomTools = [reportTool];
        if ((id === "verify" || id.startsWith("verify-")) && webTools?.reader) {
          nodeTools.push("web_reader");
          nodeCustomTools.push(webTools.reader);
          emit.event(run.id, id, {
            t: "notice",
            s: "browser tool attached: web_reader — use it to LOAD pages and observe rendered content",
          });
        }
        const artifact = await runNode({
          nodeId: id,
          tools: nodeTools,
          customTools: nodeCustomTools,
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
        throw new Error(
          `capability "${c.id}" lists zero files — every capability MUST list its files in "backend" and/or "frontend" (the only two lanes). ` +
          `CI workflows, compose files, Dockerfiles, .env.example, README and docs belong in "backend" with "single_side_class": "devops". Resubmit the full plan corrected.`,
        );
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

  function ensureNode(run, id) {
    if (nodeState(run, id)) return;
    run.state.nodes.push({
      id,
      status: "queued",
      usage: { input: 0, output: 0, cacheRead: 0 },
      retries: 0,
      durationMs: 0,
      startedAt: null,
      endedAt: null,
      error: null,
    });
  }

  // Topological order over capability deps (cycles already rejected by
  // validateCapabilities' DFS — this DFS re-checks defensively).
  function topoCaps(caps) {
    const byId = new Map(caps.map((c) => [c.id, c]));
    const order = [];
    const mark = {};
    const visit = (id) => {
      if (mark[id] === 2) return;
      if (mark[id] === 1) throw new Error(`capability dependency cycle at "${id}"`);
      mark[id] = 1;
      for (const d of byId.get(id).dependsOn ?? []) visit(d);
      mark[id] = 2;
      order.push(byId.get(id));
    };
    for (const c of caps) visit(c.id);
    return order;
  }

  // L-tier compilation: capabilities become TICKETS, verified one at a time in
  // dependency order — each ticket's coders run, then its own verify gate
  // (verify-<capId>) accepts or drives scoped fix rounds BEFORE the next
  // ticket starts. A final cross-ticket verify (+ audit) sweeps at the end.
  // Sequencing is deliberately sequential (the reference workflow's cadence):
  // small, deeply-verified diffs beat wide, shallowly-verified ones.
  function compileTickets(run, plan) {
    const caps = topoCaps(plan.capabilities);
    const tickets = [];
    for (const c of caps) {
      const implIds = [];
      if (c.backend?.length) {
        implIds.push(`impl-${c.id}-be`);
        run.nodeWork[`impl-${c.id}-be`] = { lane: "backend", title: c.title, files: c.backend };
      }
      if (c.frontend?.length) {
        implIds.push(`impl-${c.id}-fe`);
        run.nodeWork[`impl-${c.id}-fe`] = { lane: "frontend", title: c.title, files: c.frontend };
      }
      const verifyId = `verify-${c.id}`;
      tickets.push({ id: c.id, title: c.title, implIds, verifyId, dependsOn: c.dependsOn ?? [] });
      for (const id of [...implIds, verifyId]) ensureNode(run, id);
    }
    run.tickets = tickets;
    run.state.tickets = tickets.map((t) => ({
      id: t.id,
      title: t.title,
      implIds: t.implIds,
      verifyId: t.verifyId,
    }));
    emit.event(run.id, "_run", {
      t: "notice",
      s: `compiled ticket pipeline: ${tickets.map((t) => `${t.id} [${t.implIds.join(" ∥ ")} → ${t.verifyId}]`).join(" → ")} → final verify`,
    });
    emit.state(run);
  }

  // The sub-graph runDag walks while one ticket is active.
  function ticketGraph(ticket) {
    const nodes = [];
    for (const id of ticket.implIds) nodes.push({ id, dependsOn: ["plan"] });
    nodes.push({ id: ticket.verifyId, dependsOn: [...ticket.implIds] });
    return nodes;
  }

  // Final cross-ticket sweep graph: every impl node (all done by now) feeds
  // the full "verify" node.
  function finalGraph(run) {
    ensureNode(run, "verify");
    const implIds = (run.tickets ?? []).flatMap((t) => t.implIds);
    const nodes = [{ id: "plan", dependsOn: [] }];
    for (const id of implIds) nodes.push({ id, dependsOn: ["plan"] });
    nodes.push({ id: "verify", dependsOn: implIds });
    return nodes;
  }

  // Owner-facing projection of a compiled plan for the approval gate: file
  // paths (not {path, purpose} objects), capability deps, and the criteria.
  function planApprovalPayload(run, plan) {
    const base = {
      tier: run.tier,
      task_summary: plan?.task_summary ?? "",
      acceptance_criteria: plan?.acceptance_criteria ?? [],
    };
    if (Array.isArray(plan?.capabilities)) {
      return {
        ...base,
        capabilities: plan.capabilities.map((c) => ({
          id: c.id,
          title: c.title,
          backend: (c.backend ?? []).map((f) => f.path),
          frontend: (c.frontend ?? []).map((f) => f.path),
          dependsOn: c.dependsOn ?? [],
          single_side_class: c.single_side_class ?? null,
        })),
      };
    }
    return {
      ...base,
      backend: (plan?.backend ?? []).map((f) => f.path),
      frontend: (plan?.frontend ?? []).map((f) => f.path),
    };
  }

  // Present the compiled plan for owner approval before any coder runs. The
  // payload is also stashed on the run so a resume after cancel-at-gate can
  // re-present it (the plan node is already done — runDag would skip planPhase
  // and coders would run unapproved).
  async function planApprovalGate(run, plan) {
    run.pendingPlanApproval = planApprovalPayload(run, plan);
    run.state.gate = { type: "plan-approval", nodeId: "plan", plan: run.pendingPlanApproval };
    emit.event(run.id, "plan", {
      t: "notice",
      s: "plan compiled — owner approval required before coders run (plan-approval gate)",
    });
    emit.state(run);
    await waitGate(run); // throws on cancel
    run.pendingPlanApproval = null;
  }

  async function planPhase(run, tier) {
    const dynamic = tier === "L";
    const spec = run.spec;
    const prompt =
      (dynamic ? planCapsPrompt(run.task, run.projectPath) : planPrompt(run.task, run.projectPath)) +
      (spec ? `\n\n${specIntoPrompt(spec)}\n\nYour plan's acceptance_criteria MUST include every spec acceptance criterion verbatim (you may add more precise implementation-level criteria).` : "");
    let lastRejection = null;
    // Dynamic (L) plans get an extra attempt: capability graphs are the most
    // failure-prone artifact and each rejection teaches the model the compiler.
    const maxAttempt = dynamic ? 2 : 1;
    for (let attempt = 0; attempt <= maxAttempt; attempt++) {
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
          compileTickets(run, plan);
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
            for (const n of nodes) ensureNode(run, n.id);
            run.dynamicGraph = nodes;
            emit.event(run.id, "_run", {
              t: "notice",
              s: `compiled work graph: ${halves.join(" ∥ ") || "no coder"} → verify`,
            });
          }
        }
        if (run.approvePlan) await planApprovalGate(run, plan);
        return plan;
      } catch (err) {
        // A cancel at the divergence/plan-approval gate throws "cancelled at
        // gate" — that must propagate, not masquerade as a compiler rejection
        // (which would re-run the plan node against a cancelled run).
        if (run.cancelRequested) throw err;
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
        // Conventional format with the task's ticket id (OMNI-### / F## when
        // the task names one) — the project git-guidelines convention; a
        // fix-round re-run of this node types the commit `fix:`. The TITLE is
        // capped so the whole line stays ≤72 chars WITHOUT ever truncating
        // the type prefix or the ticket suffix.
        const title = String(run.nodeWork[nodeId]?.title ?? nodeId).replace(/\s+/g, " ").trim();
        const type = run.state.feedbackByNode?.[nodeId] ? "fix" : "feat";
        const suffix = commitSuffixFor(run.task, run.id);
        const maxTitle = Math.max(16, 72 - type.length - 2 - suffix.length - 1);
        const subject = `${type}: ${title.slice(0, maxTitle)} ${suffix}`;
        const hash = await git.commit(run.projectPath, subject);
        run.state.git.commits.push({ node: nodeId, hash, files, subject });
        emit.event(run.id, nodeId, {
          t: "notice",
          s: `git: committed ${files.length} file(s) (${hash.slice(0, 7)}) on ${run.git.runBranch} — "${subject}"`,
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
      ...(spec.source_docs?.length
        ? [`Source docs (their requirements OUTRANK this spec): ${spec.source_docs.join(", ")} — read them if available`]
        : []),
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

  function auditPromptFor(run) {
    return auditPrompt({
      task: run.task,
      workspace: run.projectPath,
      spec: run.spec,
      plan: run.state.artifacts.plan,
      implementReports: implementReports(run),
      verifyArtifact: run.state.artifacts.verify,
      sourceDocText: sourceDocsFor(run, emit),
      mechanicalResults: run.state.mechanicalChecks?.checks ?? null,
      remoteResults: run.state.remoteChecks,
    });
  }

  // The verify/audit prompts must KNOW the owner's remote-CI policy: enabled
  // (cite the driver's observations), degraded (skip recorded), or disabled
  // (do not even reason about hosted CI — record and defer).
  function remoteCiPolicy(run) {
    if (!run.remoteCi) {
      return "REMOTE CI VERIFICATION IS DISABLED for this run (owner opt-out). Do NOT attempt to reason about hosted CI behavior. For remote-tagged criteria, record the check with evidence beginning \"not verifiable from this environment: remote CI verification disabled for this run\" — the driver defers those instead of gating on them.";
    }
    const rc = run.state.remoteChecks;
    if (!rc) {
      return "Remote CI verification is enabled: the driver pushes the run branch and watches the hosted Actions runs before the final verify — cite the DRIVER-OBSERVED REMOTE CI RESULTS block whenever it is present.";
    }
    if (rc.status === "skipped") {
      return `Remote CI verification was attempted but skipped: ${String(rc.evidence).slice(0, 300)} — treat hosted-CI criteria as deferred unless the results block shows an observation.`;
    }
    return "Remote CI verification is enabled and observed by the driver — hosted-CI criteria (runs executing and passing) are evidenced by the DRIVER-OBSERVED REMOTE CI RESULTS block; branch-protection SETTINGS remain remote.";
  }

  function promptFor(run, n) {
    if (n.id === "audit") return auditPromptFor(run);
    if (n.id.startsWith("verify")) {
      const base = {
        task: run.task,
        plan: run.state.artifacts.plan,
        workspace: run.projectPath,
        spec: run.spec,
        sourceDocText: sourceDocsFor(run, emit),
        acVerification: run.spec?.ac_verification ?? null,
        mechanicalResults: run.state.mechanicalChecks?.checks ?? null,
        remotePolicy: remoteCiPolicy(run),
        remoteResults: run.state.remoteChecks,
      };
      // Per-ticket verify: scope reports + expectations to ONE capability.
      const ticket = (run.tickets ?? []).find((t) => t.verifyId === n.id);
      if (ticket) {
        const reports = {};
        for (const id of ticket.implIds) {
          const a = run.state.artifacts[id];
          if (a) reports[id] = a;
        }
        const files = ticket.implIds.flatMap(
          (id) => (run.nodeWork[id]?.files ?? []).map((f) => f.path),
        );
        return verifyPrompt({
          ...base,
          implementReports: reports,
          ticketScope: { id: ticket.id, title: ticket.title, files },
        });
      }
      return verifyPrompt({ ...base, implementReports: implementReports(run) });
    }
    const work = run.nodeWork[n.id];
    const sourceDocText = sourceDocsFor(run, emit);
    const planCriteria = run.state.artifacts.plan?.acceptance_criteria ?? null;
    const nodeFeedback = run.state.feedbackByNode?.[n.id] ?? null;
    if (work) {
      return implementPrompt({
        task: run.task,
        workspace: run.projectPath,
        lane: work.lane,
        title: work.title,
        files: work.files,
        spec: run.spec,
        sourceDocText,
        planCriteria,
        nodeFeedback,
        // a re-run of this node: its previous artifact is the starting point
        previousArtifact: nodeFeedback ? run.state.artifacts[n.id] ?? null : null,
        // global blob only when this node has no targeted feedback of its own
        feedback: nodeFeedback ? null : run.feedback,
      });
    }
    return implementPrompt({
      task: run.task,
      workspace: run.projectPath,
      feedback: run.feedback,
      planJson: run.state.artifacts.plan,
      spec: run.spec,
      sourceDocText,
      planCriteria,
    });
  }

  // Effective file set of a node: planned ∪ actually-written (across rounds).
  // Planned-vs-written counts too: a node whose planned file another node
  // already wrote is a collision waiting to happen.
  function effectiveFilesOf(run, id) {
    return [
      ...new Set([
        ...(run.nodeWork[id]?.files ?? []).map((f) => pathKey(f.path)),
        ...(run.state.writtenFiles?.[id] ?? []).map((p) => pathKey(p)),
      ]),
    ];
  }

  // A ticket's file footprint — planned ∪ written across all its coder nodes.
  function ticketFiles(run, ticket) {
    return new Set(ticket.implIds.flatMap((id) => effectiveFilesOf(run, id)));
  }

  // Greedy lane packing: nodes whose effective file sets overlap must
  // serialize — they chain within one lane; disjoint nodes go to separate
  // lanes and run parallel. Verify-shaped nodes ALWAYS serialize against each
  // other regardless of files: parallel verifies would race compose stacks,
  // test runs, and dev servers in the one working tree.
  function packParallel(run, ready) {
    const isVerifyish = (id) => id.startsWith("verify");
    const lanes = [];
    for (const n of ready) {
      const f = effectiveFilesOf(run, n.id);
      let conflictLane = null;
      for (const lane of lanes) {
        const clashes =
          (isVerifyish(n.id) && lane.some((m) => isVerifyish(m.id))) ||
          lane.some((m) => !disjoint(effectiveFilesOf(run, m.id), f));
        if (clashes) {
          conflictLane = lane;
          break;
        }
      }
      if (conflictLane) conflictLane.push(n);
      else lanes.push([n]);
    }
    return lanes;
  }

  // Files each coder actually wrote, accumulated across rounds — persisted so
  // resume keeps the hot-file picture.
  function trackWrittenFiles(run, nodeId, artifact) {
    const written = artifact?.files_written ?? [];
    if (written.length === 0) return;
    const prev = new Set(run.state.writtenFiles?.[nodeId] ?? []);
    for (const f of written) prev.add(f);
    run.state.writtenFiles = { ...(run.state.writtenFiles ?? {}), [nodeId]: [...prev] };
    emit.state(run);
  }

  // Deterministic checks run in the driver right before EVERY verify pass
  // (round 0 included): gitleaks, undeclared deps, CDN fonts, i18n parity,
  // env wiring, README command truth. Failures gate; skips never do.
  async function runMechanicalGate(run) {
    emit.event(run.id, "_run", { t: "notice", s: "mechanical checks: running (driver-deterministic)" });
    const checks = await runMechanicalChecks({ projectPath: run.projectPath, runId: run.id, emit, task: run.task });
    run.state.mechanicalChecks = { round: run.round ?? 0, at: new Date().toISOString(), checks };
    for (const c of checks) {
      emit.event(run.id, "_run", {
        t: "notice",
        s: `checks: ${c.id} — ${c.status}${c.status === "fail" ? `: ${String(c.evidence).slice(0, 300)}` : c.status === "skipped" ? ` (${String(c.evidence).slice(0, 120)})` : ""}`,
      });
    }
    emit.state(run);
  }

  // Owner-opted remote CI verification: push the run branch and watch the
  // hosted GitHub Actions runs it triggers. Runs-of-record land in
  // state.remoteChecks and gate exactly like a mechanical check — a red hosted
  // CI run is ground truth no model verdict can overrule. Capability (gh +
  // auth + origin) is probed once per run; any gap degrades to a recorded skip.
  async function runRemoteCiGate(run) {
    if (!run.remoteCi) return;
    if (run.ciCapability === undefined) {
      run.ciCapability = await detectCiCapability(run.projectPath);
      if (!run.ciCapability.ok) {
        run.state.remoteChecks = {
          round: run.round ?? 0,
          at: new Date().toISOString(),
          status: "skipped",
          evidence: `remote CI unavailable: ${run.ciCapability.reason}`,
          runs: [],
        };
        emit.event(run.id, "_run", {
          t: "notice",
          s: `remote CI: skipped — ${run.ciCapability.reason} (owner opted in; degrading to recorded skip)`,
        });
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
        round: run.round ?? 0,
        at: new Date().toISOString(),
        status: "skipped",
        evidence: `push failed: ${String(e?.message ?? e).slice(0, 300)}`,
        runs: [],
      };
      emit.event(run.id, "_run", { t: "notice", s: `remote CI: push failed — recorded skip (${String(e?.message ?? e).slice(0, 160)})` });
      emit.state(run);
      return;
    }
    const sha = await git.headSha(run.projectPath);
    const result = await watchRunsForSha({
      cwd: run.projectPath,
      sha,
      emit: (ev) => emit.event(run.id, "_run", ev),
    });
    run.state.remoteChecks = { round: run.round ?? 0, at: new Date().toISOString(), ...result };
    emit.event(run.id, "_run", {
      t: "notice",
      s: `remote CI: ${result.status}${result.status !== "pass" ? `: ${String(result.evidence).slice(0, 300)}` : ` — ${String(result.evidence).slice(0, 220)}`}`,
    });
    emit.state(run);
  }

  async function runDag(run) {
    const done = (id) => nodeState(run, id)?.status === "done";
    while (!run.cancelRequested) {
      // Resolved per-iteration: for M/L the compile happens mid-round (right
      // after plan), and the running loop must pick the graph up immediately.
      const graph = run.dynamicGraph ?? TIERS[run.tier];
      // The audit gate runs explicitly in execute() after verify accepts — it
      // never joins the DAG waves, so a failing verify can't drag audit along.
      const ready = graph.filter(
        (n) =>
          n.id !== "audit" &&
          nodeState(run, n.id)?.status === "queued" &&
          n.dependsOn.every(done),
      );
      if (ready.length === 0) break;

      // Ground truth first: the verify prompt carries the driver's own checks.
      // Remote CI (when opted in) runs only for the FINAL verify — after all
      // coders/tickets, so each push carries complete, committed work.
      // (Per-ticket "verify-<capId>" nodes get the local mechanical checks only.)
      if (ready.some((n) => n.id === "verify")) await runRemoteCiGate(run);
      if (run.cancelRequested) break;
      if (ready.some((n) => n.id.startsWith("verify"))) await runMechanicalGate(run);
      if (run.cancelRequested) break;

      if (ready.some((n) => n.id === "plan")) {
        await planPhase(run, run.tier);
        continue;
      }

      const execCoder = async (n) => {
        const artifact = await execNode(run, n.id, promptFor(run, n));
        if (n.id.startsWith("impl")) {
          trackWrittenFiles(run, n.id, artifact);
          await commitCoderOutput(run, n.id, artifact);
        }
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

  // Which impl nodes own a gap? Match file-path tokens from the gap text
  // (verify criterion/evidence, audit finding) against each node's planned
  // files AND the files it already wrote — substring both directions, so a
  // cited absolute path or a subpath still lands on the right owner.
  function ownersForGap(run, text, scope) {
    const tokens = pathTokensIn(text);
    if (tokens.length === 0) return [];
    const scopeSet = scope ? new Set(scope) : null;
    const owners = new Set();
    for (const n of run.state.nodes) {
      if (!n.id.startsWith("impl")) continue;
      if (scopeSet && !scopeSet.has(n.id)) continue; // per-ticket fix rounds stay inside the ticket
      const files = [
        ...(run.nodeWork[n.id]?.files ?? []).map((f) => pathKey(f.path)),
        ...(run.state.writtenFiles?.[n.id] ?? []).map((p) => pathKey(p)),
      ];
      if (files.length === 0) continue;
      for (const tok of tokens) {
        const k = fileKey(run, tok);
        if (files.some((f) => f.includes(k) || k.includes(f))) {
          owners.add(n.id);
          break;
        }
      }
    }
    return [...owners];
  }

  function formatGap(text, owners) {
    const lines = [`- GAP: ${text.split("\n")[0]}`];
    if (owners?.length) lines.push(`  owning files → this node's assignment`);
    lines.push(`  → fix this gap only; do not refactor unrelated code.`);
    return lines.join("\n");
  }

  // Targeted fix round: map gaps to owning coder nodes, requeue only those,
  // hand each node only ITS gaps. Returns the requeue list — the caller owns
  // where it persists (per-ticket for wave tickets, run.fixRequeue for the
  // final loop). Fallback (no gap has any owner): requeue every coder in
  // scope; scoped fallbacks distribute the blob per-node so concurrent
  // tickets never leak feedback into each other.
  function planFixRound(run, gaps, sourceNode, round, scope) {
    const implIds = scope
      ? run.state.nodes.filter((n) => scope.includes(n.id)).map((n) => n.id)
      : run.state.nodes.filter((n) => n.id.startsWith("impl")).map((n) => n.id);
    if (implIds.length === 0)
      implIds.push(...run.state.nodes.filter((n) => n.id.startsWith("impl")).map((n) => n.id));
    const ownersByGap = gaps.map((text) => ({ text, owners: ownersForGap(run, text, scope) }));
    const allOwners = new Set(ownersByGap.flatMap((g) => g.owners));
    if (allOwners.size === 0) {
      const blob = gaps
        .map((t) => `- GAP: ${t.split("\n")[0]}\n  → fix this gap only; do not refactor unrelated code.`)
        .join("\n");
      if (scope) {
        // Scoped fallback: every node in scope gets the full blob per-node —
        // concurrent tickets must not share run.feedback. MERGE — replacing
        // the map would wipe a concurrent ticket's entries.
        run.state.feedbackByNode = {
          ...(run.state.feedbackByNode ?? {}),
          ...Object.fromEntries(implIds.map((id) => [id, blob])),
        };
      } else {
        run.feedback = blob;
        run.state.feedbackByNode = {};
      }
      emit.event(run.id, sourceNode, {
        t: "notice",
        s: `fix round ${round + 1}: no gap matched a coder's files — requeueing all coders (${implIds.length})`,
      });
      emit.state(run);
      return { requeue: [...implIds] };
    }
    run.feedback = scope ? run.feedback : null;
    const byNode = Object.fromEntries([...allOwners].map((id) => [id, []]));
    for (const { text, owners } of ownersByGap) {
      const targets = owners.length ? owners : [...allOwners]; // unowned → every requeued node
      for (const id of targets) {
        byNode[id].push(
          owners.length
            ? formatGap(text, owners)
            : `- GAP (unowned — fix only if it touches your files): ${text.split("\n")[0]}`,
        );
      }
    }
    // Merge, not replace — see the scoped-fallback note above.
    run.state.feedbackByNode = {
      ...(run.state.feedbackByNode ?? {}),
      ...Object.fromEntries(Object.entries(byNode).map(([id, parts]) => [id, parts.join("\n")])),
    };
    emit.event(run.id, sourceNode, {
      t: "notice",
      s: `fix round ${round + 1}: targeted — requeueing ${[...allOwners].join(", ")}`,
    });
    emit.state(run);
    return { requeue: [...allOwners] };
  }

  // Deferred = a remote/human-tagged criterion that failed for environment
  // reasons: recorded for the owner, never burns another fix round.
  function recordDeferred(run, check, env) {
    const list = (run.state.deferredChecks ??= []);
    if (list.some((d) => d.criterion === check.criterion)) return;
    list.push({ criterion: check.criterion, env, evidence: String(check.evidence ?? "").slice(0, 400) });
    emit.event(run.id, "verify", {
      t: "notice",
      s: `needs ${env} verification (recorded, non-gating): ${String(check.criterion).slice(0, 120)}`,
    });
  }

  // Shared verdict reconciliation for every verify-shaped node (final "verify"
  // and per-ticket "verify-<capId>"): checks over summary verdicts, mechanical
  // failures gate regardless of the model's opinion, remote/human-tagged
  // environment-limited failures defer instead of gating.
  function reconcileVerify(run, verifyArtifact, sourceNode = "verify") {
    const failingChecks = (verifyArtifact?.checks ?? []).filter((c) => !c.pass);
    const mechFailing = (run.state.mechanicalChecks?.checks ?? []).filter((c) => c.status === "fail");
    // A red hosted CI run is driver-observed ground truth — gates like a
    // mechanical failure. Skips never gate.
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
      emit.event(run.id, sourceNode, {
        t: "notice",
        s: `${nonGating.length} check(s) not verifiable from this environment — recorded, non-gating: ${nonGating.map((c) => String(c.criterion).slice(0, 60)).join("; ")}`,
      });
    }
    let verdict = verifyArtifact?.verdict ?? "gaps-found";
    if (verdict === "accepted" && (gatingChecks.length > 0 || mechFailing.length > 0 || remoteFailing.length > 0)) {
      verdict = "gaps-found";
      emit.event(run.id, sourceNode, {
        t: "notice",
        s: `verdict overridden: "accepted" despite ${gatingChecks.length} failing check(s)${mechFailing.length ? ` and ${mechFailing.length} mechanical check failure(s)` : ""}${remoteFailing.length ? " and a failed remote CI run" : ""}`,
      });
    }
    return { verdict, gatingChecks, mechFailing, remoteFailing };
  }

  // L-tier ticket pipeline, WAVE-scheduled. A ticket is ADMITTED when its
  // dependency tickets are all accepted AND its effective file set (planned ∪
  // written) is disjoint from every in-flight ticket's. Admitted tickets share
  // one graph — runDag packs their coder nodes into parallel lanes exactly as
  // within a ticket (verify gates always serialize against each other) — and
  // each ticket keeps its OWN verify gate, scoped fix-round feedback, and
  // round budget. Small deeply-verified diffs, no artificial serialization of
  // independent work. A ticket that exhausts its rounds fails the run with its
  // reasons; resume re-admits it for another pass.
  async function runTickets(run) {
    const pending = [...(run.tickets ?? [])];
    const byId = new Map(pending.map((t) => [t.id, t]));
    const acceptedArtifact = (ticketId) => {
      const t = byId.get(ticketId);
      return t ? run.state.artifacts[t.verifyId]?.verdict === "accepted" : false;
    };
    const active = []; // tickets in flight (mixed fix-round states allowed)

    const requeueTicketNodes = (ticket, ids) => {
      const set = new Set([...(ids ?? []), ticket.verifyId]);
      for (const n of run.state.nodes) {
        if (set.has(n.id)) {
          n.status = "queued";
          n.startedAt = null;
          n.endedAt = null;
        }
      }
    };

    while (pending.length > 0 || active.length > 0) {
      if (run.cancelRequested) throw new Error("cancelled");

      // --- admission: deps accepted + files disjoint from the in-flight wave
      const inFlightFiles = new Set();
      for (const t of active) for (const f of ticketFiles(run, t)) inFlightFiles.add(f);
      const admitted = [];
      for (let i = 0; i < pending.length; i++) {
        const t = pending[i];
        if (!(t.dependsOn ?? []).every(acceptedArtifact)) continue;
        const files = ticketFiles(run, t);
        let conflicts = false;
        for (const f of files) {
          if (inFlightFiles.has(f)) {
            conflicts = true;
            break;
          }
        }
        if (conflicts) continue; // serialized by file overlap, not by policy
        for (const f of files) inFlightFiles.add(f);
        // Fresh pass: a resume (or an earlier wave) may have left this
        // ticket's verify done-but-unaccepted — requeue its nodes.
        if (nodeState(run, t.verifyId)?.status === "done") requeueTicketNodes(t, t.implIds);
        t.round = 0;
        t.requeue = null;
        active.push(t);
        pending.splice(i, 1);
        i--;
        admitted.push(t);
        emit.event(run.id, "_run", {
          t: "notice",
          s: `ticket ${t.id} (${t.title}) — ${t.implIds.join(" ∥ ")} → ${t.verifyId}`,
        });
      }
      if (admitted.length > 1) {
        emit.event(run.id, "_run", {
          t: "notice",
          s: `wave: ${admitted.length} independent tickets admitted in parallel (${admitted.map((t) => t.id).join(" + ")}) — deps ok, files disjoint`,
        });
      }
      if (active.length === 0) {
        // Unreachable with topo order + fail-fast; guard loudly anyway.
        throw new Error(`ticket scheduler stalled: ${pending.map((t) => t.id).join(", ")} blocked`);
      }

      // --- one shared graph for the whole wave; a single runDag pass
      // (parallel lanes inside; no double-scheduling).
      run.dynamicGraph = active.flatMap((t) => ticketGraph(t));
      await runDag(run);
      if (run.cancelRequested) throw new Error("cancelled");

      // --- reconcile every active ticket whose verify gate completed
      for (const t of [...active]) {
        if (nodeState(run, t.verifyId)?.status !== "done") continue;
        const rec = reconcileVerify(run, run.state.artifacts[t.verifyId], t.verifyId);
        if (rec.verdict === "accepted") {
          active.splice(active.indexOf(t), 1);
          emit.event(run.id, "_run", { t: "notice", s: `ticket ${t.id} verified — accepted` });
          continue;
        }
        if (t.round < run.maxFixRounds) {
          const gaps = [
            ...rec.gatingChecks.map((c) => `${c.criterion}: ${c.evidence ?? ""}`),
            ...rec.mechFailing.map((c) => `[mechanical] ${c.title}: ${c.evidence}`),
            ...rec.remoteFailing.map((c) => `[remote-ci] ${c.criterion}: ${c.evidence}`),
          ];
          const { requeue } = planFixRound(run, gaps, t.verifyId, t.round, t.implIds);
          t.requeue = requeue;
          t.round += 1;
          requeueTicketNodes(t, requeue);
          emit.event(run.id, t.verifyId, {
            t: "notice",
            s: `ticket ${t.id}: gaps-found — fix round ${t.round}`,
          });
          continue;
        }
        // Rounds exhausted — fail the run with this ticket's reasons.
        const reasons = [];
        if (rec?.gatingChecks?.length) {
          reasons.push(
            `verify: ${rec.gatingChecks.length} failing check(s) — ${rec.gatingChecks.map((c) => c.criterion).slice(0, 3).join(" | ")}`,
          );
        }
        if (rec?.mechFailing?.length) {
          reasons.push(`checks: ${rec.mechFailing.length} mechanical failure(s) — ${rec.mechFailing.map((c) => c.id).slice(0, 3).join(" | ")}`);
        }
        run.state.error =
          `ticket ${t.id} (${t.title}) failed verification after ${run.maxFixRounds} fix round(s)` +
          (reasons.length ? `: ${reasons.join(" ;; ")}` : "") +
          " — resume the run to retry this ticket".slice(0, 600);
        return false;
      }
      emit.state(run);
      // loop: admission may now unblock dependents; fix-round tickets re-run
    }
    run.dynamicGraph = finalGraph(run);
    emit.event(run.id, "_run", {
      t: "notice",
      s: `all tickets verified — final cross-ticket verify${run.audit ? " + audit" : ""}`,
    });
    return true;
  }

  async function execute(run) {
    try {
      // Git-on runs must ALWAYS execute on their own branch. After a
      // failed/cancelled run settles, integrate() checks out the base branch —
      // without this, a resume would commit straight onto main. The checkout
      // also restores the branch's committed files into the working tree for
      // the resumed coders.
      if (run.git?.enabled) {
        try {
          await git.checkout(run.projectPath, run.git.runBranch);
        } catch (e) {
          throw new Error(
            `git: could not restore run branch ${run.git.runBranch} (${e?.message ?? e}) — resolve the working tree (clean or stash) and resume again`,
          );
        }
      }
      // Resume after cancel-at-plan-gate: the plan node is already done, so
      // runDag would skip planPhase entirely — re-present the approval gate
      // BEFORE any coder runs. Without this, resume bypasses approval.
      if (run.pendingPlanApproval) {
        run.state.gate = { type: "plan-approval", nodeId: "plan", plan: run.pendingPlanApproval };
        emit.state(run);
        await waitGate(run);
        run.pendingPlanApproval = null;
      }

      // Step 1 — clarify (PM loop): ask → answers → repeat → spec.
      // Skipped when a spec is already locked (resume after cancel).
      if (run.clarify && !run.spec) {
        const spec = await clarifyPhase(run);
        run.spec = spec;
        run.state.artifacts.spec = spec;
      }

      // Step 2 — build: plan → parallel coders → verify → audit, verdict-gated.
      // L tier: drive the plan phase FIRST (planPhase compiles the tickets and
      // runs the approval gate inside runDag), then run the ticket pipeline;
      // the generic loop below is the final cross-ticket verify (+ audit).
      if (run.tier === "L") {
        if (nodeState(run, "plan")?.status !== "done") {
          run.dynamicGraph = TIERS.L; // [plan]
          await runDag(run);
          if (run.cancelRequested) throw new Error("cancelled");
        } else if (!run.tickets && run.state.artifacts.plan?.capabilities) {
          // defensive resume edge: plan artifact exists but was never compiled
          validateCapabilities(run.state.artifacts.plan);
          compileTickets(run, run.state.artifacts.plan);
        }
        if (Array.isArray(run.tickets)) {
          const ok = await runTickets(run);
          if (!ok) throw new Error(run.state.error ?? "a ticket failed its verification");
        }
      }
      let verdict = null;
      for (let round = 0; round <= run.maxFixRounds; round++) {
        run.round = round;
        if (round > 0) {
          // Targeted requeue: only the coder nodes that own the failing gaps
          // (planFixRound's set); fallback = all coders. The plan and compiled
          // graph stand; untouched coders keep their done status + artifacts.
          const requeueSet = new Set(run.fixRequeue ?? []);
          for (const n of run.state.nodes) {
            if (requeueSet.has(n.id)) {
              n.status = "queued";
              n.startedAt = null;
              n.endedAt = null;
            }
          }
          if (nodeState(run, "verify")) nodeState(run, "verify").status = "queued";
          if (run.audit && nodeState(run, "audit")) nodeState(run, "audit").status = "queued";
          emit.state(run);
        }
        await runDag(run);
        if (run.cancelRequested) break;
        // --- verify gate: mechanical reconciliation -----------------------------
        // Never trust the model's summary verdict over its own checks, never
        // let environment-unverifiable criteria gate the run, and never let
        // the model talk its way past a driver-observed mechanical failure.
        const rec = reconcileVerify(run, run.state.artifacts.verify);
        verdict = rec.verdict;
        if (verdict !== "accepted") {
          const gaps = [
            ...rec.gatingChecks.map((c) => `${c.criterion}: ${c.evidence ?? ""}`),
            ...rec.mechFailing.map((c) => `[mechanical] ${c.title}: ${c.evidence}`),
            ...rec.remoteFailing.map(
              (c) =>
                `[remote-ci] ${c.criterion}: ${c.evidence}\n  → the failed-log excerpt names the cause — fix it, including creating/modifying files OUTSIDE your original assignment if the log points there`,
            ),
          ];
          if (round < run.maxFixRounds) {
            const { requeue } = planFixRound(run, gaps, "verify", round);
            run.fixRequeue = requeue;
            emit.event(run.id, "verify", { t: "notice", s: `gaps-found — fix round ${round + 1}` });
          } else {
            run.feedback = gaps.map((t) => `- GAP: ${t.split("\n")[0]}`).join("\n");
          }
          continue;
        }
        // Verify accepted → audit gate (conformity + quality), unless disabled.
        if (run.audit && nodeState(run, "audit")) {
          const auditArtifact = await execNode(run, "audit", auditPromptFor(run));
          const blocking = (auditArtifact?.findings ?? []).filter((f) => f.blocking);
          let auditOk = auditArtifact?.verdict === "accepted";
          if (auditOk && blocking.length > 0) {
            auditOk = false;
            emit.event(run.id, "audit", {
              t: "notice",
              s: `verdict overridden: "accepted" despite ${blocking.length} blocking finding(s)`,
            });
          }
          if (auditOk) {
            verdict = "accepted";
            break;
          }
          verdict = "gaps-found";
          const src = blocking.length ? blocking : (auditArtifact?.findings ?? []);
          if (round < run.maxFixRounds) {
            planFixRound(
              run,
              src.map((f) => `[${f.category}]${f.file ? ` ${f.file}:` : ""} ${f.issue}${f.fix ? ` (fix: ${f.fix})` : ""}`),
              "audit",
              round,
            );
            emit.event(run.id, "audit", {
              t: "notice",
              s: `audit: ${blocking.length} blocking finding(s) — fix round ${round + 1}`,
            });
          } else {
            run.feedback = src
              .map((f) => `- [${f.category}]${f.file ? ` ${f.file}:` : ""} ${f.issue}${f.fix ? ` (fix: ${f.fix})` : ""}`)
              .join("\n");
          }
          continue;
        }
        verdict = "accepted";
        break;
      }
      run.state.status = verdict === "accepted" ? "completed" : "failed";
      if (run.state.deferredChecks?.length) {
        emit.event(run.id, "_run", {
          t: "notice",
          s: `deferred to owner (${run.state.deferredChecks.length}): ${run.state.deferredChecks.map((d) => `[${d.env}] ${String(d.criterion).slice(0, 80)}`).join("; ")}`,
        });
      }
      if (run.state.status === "failed" && !run.state.error) {
        // Gates exhausted — say WHY, in the state the GUI shows and the feed.
        const reasons = [];
        const vf = (run.state.artifacts.verify?.checks ?? []).filter((c) => {
          if (c.pass) return false;
          if (/^\s*not verifiable/i.test(c.evidence ?? "")) return false;
          const env = matchAcVerification(run.spec?.ac_verification, c.criterion);
          return !((env === "remote" || env === "human") && ENV_LIMIT_RE.test(c.evidence ?? ""));
        });
        if (vf.length) {
          reasons.push(`verify: ${vf.length} failing check(s) — ${vf.map((c) => c.criterion).slice(0, 3).join(" | ")}`);
        }
        const mf = (run.state.mechanicalChecks?.checks ?? []).filter((c) => c.status === "fail");
        if (mf.length) {
          reasons.push(`checks: ${mf.length} mechanical failure(s) — ${mf.map((c) => c.id).slice(0, 3).join(" | ")}`);
        }
        if (run.state.remoteChecks?.status === "fail") {
          reasons.push(`remote CI: failed — ${String(run.state.remoteChecks.evidence).slice(0, 160)}`);
        }
        const ab = (run.state.artifacts.audit?.findings ?? []).filter((f) => f.blocking);
        if (ab.length) {
          reasons.push(
            `audit: ${ab.length} blocking finding(s) — ${ab.map((f) => f.issue).slice(0, 3).join(" | ")}`,
          );
        }
        run.state.error =
          reasons.length > 0
            ? `gates still failing after ${run.maxFixRounds} fix round(s): ${reasons.join(" ;; ")}`.slice(0, 600)
            : `gates still failing after ${run.maxFixRounds} fix round(s)`;
        emit.event(run.id, "_run", { t: "notice", s: `run failed: ${run.state.error}` });
      }
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

    async start({ id, task, tier, project, models, clarify, requireQuestions, maxFixRounds, git: gitRequested, audit: auditRequested, approvePlan, remoteChecks: remoteChecksRequested }) {
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
          // The audit gate runs explicitly after verify accepts — never in DAG waves.
          { id: "audit", dependsOn: ["verify"] },
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
        feedbackByNode: {},
        writtenFiles: {},
        deferredChecks: [],
        mechanicalChecks: null,
        remoteChecks: null,
      };
      // Audit gate (conformity + quality) runs after verify accepts. On by
      // default; the owner can switch it off per run from the GUI.
      const auditEnabled = auditRequested !== false;
      if (!auditEnabled) {
        const a = state.nodes.find((n) => n.id === "audit");
        if (a) {
          a.status = "cancelled";
          a.error = "audit step disabled for this run";
        }
      }
      const run = {
        id,
        task,
        tier,
        projectPath: project.path,
        models,
        clarify: !!clarify,
        audit: auditEnabled,
        // Owner gate on the compiled plan (M/L only) before any coder runs.
        approvePlan: approvePlan !== false && (tier === "M" || tier === "L"),
        pendingPlanApproval: null,
        round: 0,
        fixRequeue: null,
        sourceDocCache: undefined,
        // Remote CI verification (owner opt-in): the driver pushes the run
        // branch and watches the hosted Actions runs before the final verify.
        remoteCi: remoteChecksRequested === true && !!gitInfo?.enabled,
        ciCapability: undefined,
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
      } else {
        // The process debt both F01 audits scored hardest: uncommitted work.
        emit.event(id, "_run", {
          t: "notice",
          s: "git: OFF — all work will be uncommitted (one rm -rf from loss; audits score this as process debt). Enable Git, and Remote CI with a remote, for durable CI-proven runs",
        });
      }
      if (remoteChecksRequested === true && !gitInfo?.enabled) {
        emit.event(id, "_run", {
          t: "notice",
          s: "remote CI: requested but git is disabled for this run — remote CI verification off (enable Git to use it)",
        });
      } else if (run.remoteCi) {
        emit.event(id, "_run", {
          t: "notice",
          s: `remote CI verification enabled — ${gitInfo.runBranch} will be pushed to origin before the final verify to trigger and watch hosted Actions runs`,
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
        // All nodes finished but the run failed → the GATES are what failed
        // (fix rounds exhausted). Resume = requeue the build for another
        // gates pass: coders + verify + audit; clarify/plan/artifacts stand.
        if (run.state.status !== "failed") {
          return { ok: false, error: "nothing to resume — every node already finished" };
        }
        // L tier: only tickets whose verify gate did not accept get re-run —
        // accepted tickets' coders must not re-run during the final sweep.
        const unacceptedTicketImplIds = new Set(
          (run.tickets ?? [])
            .filter((t) => run.state.artifacts[t.verifyId]?.verdict !== "accepted")
            .flatMap((t) => t.implIds),
        );
        for (const n of run.state.nodes) {
          const isImpl = n.id.startsWith("impl");
          const requeueGeneral =
            n.id !== "plan" &&
            n.id !== "clarify" &&
            ((isImpl && (unacceptedTicketImplIds.size === 0 || unacceptedTicketImplIds.has(n.id))) ||
              n.id === "verify" ||
              n.id === "audit");
          // L tier: also requeue per-ticket verify gates that did NOT accept —
          // runTickets must retry the failing ticket, not skip it as done.
          const requeueTicketVerify =
            n.id.startsWith("verify-") && n.status === "done" && run.state.artifacts[n.id]?.verdict !== "accepted";
          if (requeueGeneral || requeueTicketVerify) {
            n.status = "queued";
            n.error = null;
            n.startedAt = null;
            n.endedAt = null;
          }
        }
        emit.event(run.id, "_run", {
          t: "notice",
          s: "resume: all nodes had finished — requeued coders + verify + audit for another gates pass (plan/spec/artifacts kept)",
        });
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
      // A plan marked done without its artifact means the compiler rejected
      // it (artifacts are deleted on rejection) — let the planner try again
      // instead of resuming into a graph that was never compiled.
      const planNode = nodeState(run, "plan");
      if (planNode?.status === "done" && !run.state.artifacts.plan) {
        planNode.status = "queued";
        planNode.error = null;
        planNode.startedAt = null;
        planNode.endedAt = null;
        requeued += 1;
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
