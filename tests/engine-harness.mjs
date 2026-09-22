// Engine unit harness — drives createEngine with fake step sessions (the plan's
// Phase 6 "done when"). Run: node tests/engine-harness.mjs
import "./_test-dirs.mjs"; // FIRST: isolate tickets/runs stores (never the live data)
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert";
import { createEngine } from "../host/engine.mjs";
import { runDir } from "../host/state.mjs";

const FIXTURE = fs.mkdtempSync("/tmp/nano-engine-");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- fake session layer -----------------------------------------------------------

const stepStores = new Map(); // stepId -> { turns: 0, files: [], prompts: [] }
const openCalls = []; // { stepId, resumed }

function makeFakeOpen(scripts) {
  return async function fakeOpenStepSession(opts) {
    const store = stepStores.get(opts.stepId) ?? { turns: 0, files: [], prompts: [] };
    stepStores.set(opts.stepId, store);
    const resumed = !!opts.sessionFile;
    const file = opts.sessionFile ?? path.join(FIXTURE, `${opts.stepId}-${store.files.length}.jsonl`);
    store.files.push(file);
    openCalls.push({ stepId: opts.stepId, resumed });
    const tools = Object.fromEntries((opts.customTools ?? []).map((t) => [t.name ?? t.name, t]));
    const handle = {
      sessionFile: file,
      resumed,
      session: { messages: [] },
      abort() {},
      close() {},
      async prompt(text) {
        store.prompts.push(text);
        const script = scripts[opts.stepId];
        const turn = script?.[store.turns];
        store.turns += 1;
        if (turn) await turn({ tools, text, store });
      },
    };
    return handle;
  };
}

async function callTool(tools, name, params) {
  const t = tools[name];
  assert.ok(t, `tool ${name} present in fake session`);
  const out = await t.execute("call-1", params);
  return out.content?.[0]?.text ?? "";
}

// --- artifacts the fake builder submits ---------------------------------------------

const PLAN = {
  task_summary: "Add a health endpoint",
  approach: "Nest module with probes",
  files: [
    { path: "src/health/controller.ts", purpose: "endpoint", task: "health-api" },
    { path: "src/health/service.ts", purpose: "probes", task: "health-api" },
    { path: "README.md", purpose: "document", task: "docs" },
  ],
  acceptance_criteria: ["GET /health returns 200 JSON", "README documents /health"],
};
const TASKS = {
  tasks: [
    { id: "health-api", title: "Health API", description: "endpoint + probes", files: ["src/health/controller.ts", "src/health/service.ts"], acceptance_criteria: ["200 on GET /health"], dependsOn: [], size: "M" },
    { id: "docs", title: "Docs", description: "README section", files: ["README.md"], acceptance_criteria: ["README mentions /health"], dependsOn: ["health-api"], size: "S" },
  ],
};
const IMPL_DELTA = {
  summary: "health endpoint + docs",
  files_written: ["src/health/controller.ts", "src/health/service.ts", "README.md"],
  notes: "none",
  task_completion: [{ task: "health-api", status: "done" }, { task: "docs", status: "done" }],
};
const verifyArtifact = (pass) => ({
  verdict: pass ? "accepted" : "gaps-found",
  checks: [
    { criterion: "GET /health returns 200 JSON", pass, evidence: pass ? "curl observed 200" : "curl observed 404" },
  ],
});
const auditArtifact = (blocking) => ({
  verdict: blocking ? "gaps-found" : "accepted",
  findings: blocking
    ? [{ category: "requirement-conformity", blocking: true, file: "README.md", issue: "criterion not honored as written", fix: "rewrite section" }]
    : [],
});
// Fails on round 0 only — the "one criterion short" shape the fix-resume flow targets.
const failingOnce = (n) => ({
  verdict: "gaps-found",
  checks: [{ criterion: "filler check to fail once", pass: n >= 1, evidence: n >= 1 ? "fixed after the resume turn" : "always broken" }],
});

// --- harness ------------------------------------------------------------------------

async function runEngine({ scripts, autoGate = ["approve"], mechanical, security = "off", approvePlan = true, maxFixRounds = 2, project = "sandbox", adaptersOverride, extraStart = {} }) {
  const events = [];
  const state = { latest: null };
  const emit = {
    state: (run) => {
      state.latest = run.state;
      state.lastSnapshot = JSON.parse(JSON.stringify(run.state)); // what would hit disk
      saveStateCapture(run.state);
    },
    event: (runId, nodeId, ev) => events.push({ runId, nodeId, ...ev }),
  };
  let saved = null;
  function saveStateCapture(s) {
    saved = s;
  }
  const mechState = { round: 0 };
  const engine = createEngine({
    modelRuntime: {},
    emit,
    webTools: {},
    adapters: {
      openStepSession: makeFakeOpen(scripts),
      runNode: adaptersOverride?.runNode ?? (async (opts) => {
        if (opts.nodeId === "clarify") {
          const fin = (opts.customTools ?? []).find((t) => t.name === "finalize_spec");
          await fin?.execute("x", { summary: "s", decisions: [], acceptance_criteria: ["AC"] });
        }
      }),
      runMechanicalChecks: async () => {
        const checks = mechanical ? mechanical(mechState.round) : [];
        mechState.round += 1;
        return checks;
      },
      runScannerSuite: () => ({ scanners: [{ id: "secrets-gitleaks", title: "Secrets scan", status: "pass", evidence: "none" }] }),
    },
  });
  const id = `test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  // gate auto-policy: shift through the list per gate encountered
  const gateQueue = [...autoGate];
  const poll = setInterval(async () => {
    const st = state.latest;
    if (st?.gate && st.id === id) {
      const action = gateQueue.length > 1 ? gateQueue.shift() : gateQueue[0];
      if (action) await engine.gate(id, action.action ?? action, action.comments);
      // avoid double-resolving the same gate
      state.latest = { ...st, gate: null, id };
    }
  }, 5);
  const st = await engine.start({
    id,
    task: "Implement F99 (OMNI-99) health endpoint",
    project: { name: project, path: FIXTURE },
    models: { clarify: "auto", builder: "auto", verifier: "auto", security: "auto" },
    clarify: false,
    maxFixRounds,
    git: false,
    audit: true,
    approvePlan,
    remoteChecks: false,
    security,
    ...extraStart,
  });
  const deadline = Date.now() + 20_000;
  while (!["completed", "failed", "cancelled", "clarified"].includes(st.status) && Date.now() < deadline) {
    await sleep(10);
  }
  clearInterval(poll);
  return { engine, id, state: st, events, getState: () => state.latest };
}

const results = [];
const test = async (name, fn) => {
  try {
    await fn();
    results.push([name, true]);
    console.log(`PASS  ${name}`);
  } catch (e) {
    results.push([name, false]);
    console.log(`FAIL  ${name}\n      ${String(e?.message ?? e).split("\n").slice(0, 6).join("\n      ")}`);
  }
};

// --- scenarios ------------------------------------------------------------------------

await test("happy path: plan→tasks→impl→verify+audit accepted", async () => {
  stepStores.clear(); openCalls.length = 0;
  const scripts = {
    build: [
      async ({ tools }) => {
        assert.match(await callTool(tools, "submit_plan", PLAN), /APPROVED/);
        assert.match(await callTool(tools, "submit_tasks", TASKS), /Tasks accepted/);
        await callTool(tools, "submit_impl_delta", IMPL_DELTA);
      },
    ],
    verify: [
      async ({ tools }) => {
        const t = await callTool(tools, "submit_verify", verifyArtifact(true));
        assert.match(t, /VERIFY ACCEPTED/);
        await callTool(tools, "submit_audit", auditArtifact(false));
      },
    ],
  };
  const { state } = await runEngine({ scripts });
  assert.strictEqual(state.status, "completed", `status=${state.status} err=${state.error}`);
  assert.ok(state.artifacts.spec === undefined || state.artifacts.spec === null); // clarify off, no spec
  assert.ok(state.artifacts.plan && state.artifacts.tasks && state.artifacts.implDelta);
  assert.strictEqual(state.artifacts.verify.verdict, "accepted");
  assert.strictEqual(openCalls.filter((c) => c.stepId === "build").length, 1, "one build session");
});

await test("plan gate: owner reject-with-comments → in-session revision → approve", async () => {
  stepStores.clear(); openCalls.length = 0;
  let revised = false;
  const scripts = {
    build: [
      async ({ tools }) => {
        const t1 = await callTool(tools, "submit_plan", PLAN);
        if (/REJECTED BY OWNER/.test(t1)) {
          revised = true;
          assert.match(await callTool(tools, "submit_plan", { ...PLAN, approach: "revised: module + timeout" }), /APPROVED/);
          await callTool(tools, "submit_tasks", TASKS);
          await callTool(tools, "submit_impl_delta", IMPL_DELTA);
        } else {
          throw new Error("expected owner rejection first, got: " + t1);
        }
      },
    ],
    verify: [
      async ({ tools }) => {
        await callTool(tools, "submit_verify", verifyArtifact(true));
        await callTool(tools, "submit_audit", auditArtifact(false));
      },
    ],
  };
  const { state } = await runEngine({ scripts, autoGate: [{ action: "reject", comments: "add a timeout" }, "approve"] });
  assert.ok(revised, "revision happened");
  assert.strictEqual(state.status, "completed");
});

await test("driver validation: malformed tasks rejected in-session, corrected resubmit", async () => {
  stepStores.clear();
  const bad = { tasks: [{ ...TASKS.tasks[0], files: [] }] };
  let corrected = false;
  const scripts = {
    build: [
      async ({ tools }) => {
        await callTool(tools, "submit_plan", PLAN);
        const t = await callTool(tools, "submit_tasks", bad);
        assert.match(t, /REJECTED by the driver/);
        corrected = true;
        await callTool(tools, "submit_tasks", TASKS);
        await callTool(tools, "submit_impl_delta", IMPL_DELTA);
      },
    ],
    verify: [
      async ({ tools }) => {
        await callTool(tools, "submit_verify", verifyArtifact(true));
        await callTool(tools, "submit_audit", auditArtifact(false));
      },
    ],
  };
  const { state } = await runEngine({ scripts });
  assert.ok(corrected);
  assert.strictEqual(state.status, "completed");
});

await test("verify gaps → fix round RESUMES the build session → round 1 accepted", async () => {
  stepStores.clear(); openCalls.length = 0;
  const buildPrompts = [];
  const scripts = {
    build: [
      async ({ tools }) => {
        await callTool(tools, "submit_plan", PLAN);
        await callTool(tools, "submit_tasks", TASKS);
        await callTool(tools, "submit_impl_delta", IMPL_DELTA);
      },
      async ({ tools, text }) => {
        buildPrompts.push(text);
        assert.match(text, /FIX ROUND 1/, "feedback turn is a fix round");
        assert.match(text, /GET \/health returns 200 JSON/, "gap text present");
        await callTool(tools, "submit_impl_delta", { ...IMPL_DELTA, notes: "fixed 404" });
      },
    ],
    verify: [
      async ({ tools }) => {
        const t = await callTool(tools, "submit_verify", verifyArtifact(false));
        assert.match(t, /GAPS RECORDED/);
      },
      async ({ tools }) => {
        await callTool(tools, "submit_verify", verifyArtifact(true));
        await callTool(tools, "submit_audit", auditArtifact(false));
      },
    ],
  };
  const { state } = await runEngine({ scripts });
  assert.strictEqual(state.status, "completed", state.error);
  const buildOpens = openCalls.filter((c) => c.stepId === "build");
  assert.strictEqual(buildOpens.length, 1, `build session opened once (resumed for fix), got ${buildOpens.length}`);
  assert.strictEqual(buildOpens[0].resumed, false);
  assert.strictEqual(state.round, 1);
});

await test("audit blocking finding → fix round → accepted", async () => {
  stepStores.clear();
  const scripts = {
    build: [
      async ({ tools }) => {
        await callTool(tools, "submit_plan", PLAN);
        await callTool(tools, "submit_tasks", TASKS);
        await callTool(tools, "submit_impl_delta", IMPL_DELTA);
      },
      async ({ tools, text }) => {
        assert.match(text, /audit\/requirement-conformity/);
        await callTool(tools, "submit_impl_delta", { ...IMPL_DELTA, notes: "rewrote README section" });
      },
    ],
    verify: [
      async ({ tools }) => {
        await callTool(tools, "submit_verify", verifyArtifact(true));
        await callTool(tools, "submit_audit", auditArtifact(true));
      },
      async ({ tools }) => {
        await callTool(tools, "submit_verify", verifyArtifact(true));
        await callTool(tools, "submit_audit", auditArtifact(false));
      },
    ],
  };
  const { state } = await runEngine({ scripts });
  assert.strictEqual(state.status, "completed", state.error);
});

await test("mechanical failure gates round 0 → fixed round 1", async () => {
  stepStores.clear();
  const mech = (round) => (round === 0 ? [{ id: "deps-declared", title: "Deps declared", status: "fail", evidence: "express undeclared" }] : [{ id: "deps-declared", title: "Deps declared", status: "pass", evidence: "ok" }]);
  const scripts = {
    build: [
      async ({ tools }) => {
        await callTool(tools, "submit_plan", PLAN);
        await callTool(tools, "submit_tasks", TASKS);
        await callTool(tools, "submit_impl_delta", IMPL_DELTA);
      },
      async ({ tools, text }) => {
        assert.match(text, /\[mechanical\] Deps declared/);
        await callTool(tools, "submit_impl_delta", { ...IMPL_DELTA, notes: "declared dep" });
      },
    ],
    verify: [
      async ({ tools }) => {
        // round 0: model says accepted, but mechanical failed → driver overrides
        await callTool(tools, "submit_verify", verifyArtifact(true));
      },
      async ({ tools }) => {
        await callTool(tools, "submit_verify", verifyArtifact(true));
        await callTool(tools, "submit_audit", auditArtifact(false));
      },
    ],
  };
  const { state } = await runEngine({ scripts, mechanical: mech });
  assert.strictEqual(state.status, "completed", state.error);
  assert.ok(state.events === undefined); // events not on state (they're in the feed)
});

await test("rounds exhausted → honest failure with reasons", async () => {
  stepStores.clear();
  const scripts = {
    build: [
      async ({ tools }) => {
        await callTool(tools, "submit_plan", PLAN);
        await callTool(tools, "submit_tasks", TASKS);
        await callTool(tools, "submit_impl_delta", IMPL_DELTA);
      },
      async ({ tools }) => {
        await callTool(tools, "submit_impl_delta", { ...IMPL_DELTA, notes: "attempt 2" });
      },
      async ({ tools }) => {
        await callTool(tools, "submit_impl_delta", { ...IMPL_DELTA, notes: "attempt 3" });
      },
    ],
    verify: [0, 1, 2].map(() => async ({ tools }) => {
      await callTool(tools, "submit_verify", verifyArtifact(false));
    }),
  };
  const { state } = await runEngine({ scripts, maxFixRounds: 2 });
  assert.strictEqual(state.status, "failed");
  assert.match(state.error, /failing check/);
});

await test("security: fixable critical → build fix round → re-scan pass", async () => {
  stepStores.clear();
  const secFindings = (fixable) => ({
    verdict: "findings",
    findings: [{ id: "sec-1", source: "scanner", severity: "critical", title: "secret in .env", evidence: "observed", file: ".env:1", fix: "remove", fixable_in_scope: fixable }],
  });
  const scripts = {
    build: [
      async ({ tools }) => {
        await callTool(tools, "submit_plan", PLAN);
        await callTool(tools, "submit_tasks", TASKS);
        await callTool(tools, "submit_impl_delta", IMPL_DELTA);
      },
      async ({ tools, text }) => {
        assert.match(text, /\[security\/critical\]/);
        await callTool(tools, "submit_impl_delta", { ...IMPL_DELTA, notes: "removed secret" });
      },
    ],
    verify: [
      async ({ tools }) => {
        await callTool(tools, "submit_verify", verifyArtifact(true));
        await callTool(tools, "submit_audit", auditArtifact(false));
      },
    ],
    security: [
      async ({ tools }) => {
        await callTool(tools, "submit_security", secFindings(true));
      },
      async ({ tools }) => {
        await callTool(tools, "submit_security", { verdict: "pass", findings: [] });
      },
    ],
  };
  const { state } = await runEngine({ scripts, security: "scan" });
  assert.strictEqual(state.status, "completed", state.error);
  assert.strictEqual(state.artifacts.security.verdict, "pass");
});

await test("security: unfixable high → owner override gate → completed with risk recorded", async () => {
  stepStores.clear();
  const scripts = {
    build: [
      async ({ tools }) => {
        await callTool(tools, "submit_plan", PLAN);
        await callTool(tools, "submit_tasks", TASKS);
        await callTool(tools, "submit_impl_delta", IMPL_DELTA);
      },
    ],
    verify: [
      async ({ tools }) => {
        await callTool(tools, "submit_verify", verifyArtifact(true));
        await callTool(tools, "submit_audit", auditArtifact(false));
      },
    ],
    security: [
      async ({ tools }) => {
        await callTool(tools, "submit_security", {
          verdict: "findings",
          findings: [{ id: "dep-1", source: "scanner", severity: "high", title: "vuln no fix", evidence: "observed", fix: "none upstream", fixable_in_scope: false }],
        });
      },
    ],
  };
  const { state } = await runEngine({ scripts, security: "scan", autoGate: ["approve"] });
  assert.strictEqual(state.status, "completed", state.error);
  assert.ok(state.securityAccepted, "override recorded");
});

await test("divergence gate: owner approves despite divergence", async () => {
  stepStores.clear();
  const scripts = {
    build: [
      async ({ tools }) => {
        const t = await callTool(tools, "submit_plan", { ...PLAN, divergence: "task contradicts the pinned stack" });
        assert.match(t, /approved despite the divergence/);
        await callTool(tools, "submit_tasks", TASKS);
        await callTool(tools, "submit_impl_delta", IMPL_DELTA);
      },
    ],
    verify: [
      async ({ tools }) => {
        await callTool(tools, "submit_verify", verifyArtifact(true));
        await callTool(tools, "submit_audit", auditArtifact(false));
      },
    ],
  };
  const { state } = await runEngine({ scripts });
  assert.strictEqual(state.status, "completed");
});

await test("cancel at plan gate → run cancelled; resume re-presents gate and completes", async () => {
  stepStores.clear(); openCalls.length = 0;
  const buildPrompts = [];
  let submitPlanCalls = 0;
  const scripts = {
    build: [
      async ({ tools }) => {
        const t = await callTool(tools, "submit_plan", PLAN);
        submitPlanCalls += 1;
        if (/cancelled/i.test(t)) return;
        await callTool(tools, "submit_tasks", TASKS);
        await callTool(tools, "submit_impl_delta", IMPL_DELTA);
      },
      // turn 1 = the resumed synthetic turn: plan is already approved and
      // stored — the builder must go STRAIGHT to tasks, never re-plan.
      async ({ tools, text }) => {
        buildPrompts.push(text);
        assert.match(text, /APPROVED your submitted plan/, "synthetic approval turn");
        assert.match(text, /Do NOT investigate again and do NOT re-plan/, "re-plan forbidden");
        await callTool(tools, "submit_tasks", TASKS);
        await callTool(tools, "submit_impl_delta", IMPL_DELTA);
      },
    ],
    verify: [
      async ({ tools }) => {
        await callTool(tools, "submit_verify", verifyArtifact(true));
        await callTool(tools, "submit_audit", auditArtifact(false));
      },
    ],
  };
  const { engine, id, state } = await runEngine({ scripts, autoGate: ["cancel"] });
  assert.strictEqual(state.status, "cancelled", `status=${state.status}`);
  const out = engine.resume(id);
  assert.strictEqual(out.ok, true, out.error);
  // The first runEngine's poller is gone — resolve gates manually as they appear.
  const deadline = Date.now() + 15_000;
  while (!["completed", "failed", "cancelled"].includes(state.status) && Date.now() < deadline) {
    if (state.gate) await engine.gate(id, "approve");
    await sleep(10);
  }
  assert.strictEqual(state.status, "completed", `after resume: ${state.status} ${state.error ?? ""}`);
  assert.strictEqual(submitPlanCalls, 1, `plan submitted exactly ONCE (stored, not re-planned) — got ${submitPlanCalls}`);
  const buildOpens = openCalls.filter((c) => c.stepId === "build");
  assert.strictEqual(buildOpens.length, 2, "build session reopened on resume");
  assert.strictEqual(buildOpens[1].resumed, true, "reopened FROM the persisted session file");
});

await test("requireQuestions: finalize_spec structurally withheld on round 1", async () => {
  stepStores.clear();
  const seen = { tools: null, custom: null };
  const scripts = { build: [async () => {}], verify: [async () => {}] };
  const { engine, id, state } = await runEngine({
    scripts,
    adaptersOverride: {
      runNode: async (opts) => {
        if (opts.nodeId === "clarify") {
          seen.tools = opts.tools;
          seen.custom = (opts.customTools ?? []).map((t) => t.name);
        }
        throw new Error("fake clarify stops here");
      },
    },
  });
  // start a clarify run manually (runEngine starts with clarify off — do a raw start)
  const id2 = `test-cq-${Date.now()}`;
  const events = [];
  const eng2 = createEngine({
    modelRuntime: {},
    emit: { state: () => {}, event: (rid, n, ev) => events.push(ev) },
    webTools: {},
    adapters: { runNode: async (opts) => {
      if (opts.nodeId === "clarify") {
        seen.tools = opts.tools;
        seen.custom = (opts.customTools ?? []).map((t) => t.name);
      }
      throw new Error("stop");
    } },
  });
  await eng2.start({
    id: id2, task: "t", project: { name: "sandbox", path: FIXTURE },
    models: { clarify: "auto", builder: "auto", verifier: "auto", security: "auto" },
    clarify: true, requireQuestions: true, maxFixRounds: 0, git: false, audit: true, approvePlan: false, remoteChecks: false, security: "off",
  });
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(seen.custom, "clarify session was created");
  assert.ok(seen.custom.includes("ask_questions"), "ask_questions available");
  assert.ok(!seen.custom.includes("finalize_spec"), "finalize_spec WITHHELD on round 1 (structural)");
  console.log("   tools seen:", seen.custom?.join(", "));
});

await test("setStepModel: queued step ok, running/done rejected", async () => {
  stepStores.clear();
  const scripts = {
    build: [
      async ({ tools }) => {
        await callTool(tools, "submit_plan", PLAN);
        await callTool(tools, "submit_tasks", TASKS);
        await callTool(tools, "submit_impl_delta", IMPL_DELTA);
      },
    ],
    verify: [
      async ({ tools }) => {
        await callTool(tools, "submit_verify", verifyArtifact(true));
        await callTool(tools, "submit_audit", auditArtifact(false));
      },
    ],
  };
  const { engine, id, state } = await runEngine({ scripts });
  assert.strictEqual(state.status, "completed");
  const r1 = engine.setStepModel(id, "verify", "x/y");
  assert.strictEqual(r1.ok, false, "done step rejected");
});

await test("dispatch_coder: spawns a scoped child, merges its report into the turn", async () => {
  stepStores.clear();
  const childCalls = [];
  const scripts = {
    build: [
      async ({ tools }) => {
        await callTool(tools, "submit_plan", PLAN);
        await callTool(tools, "submit_tasks", TASKS);
        // dispatch one task, then report
        const t = await callTool(tools, "dispatch_coder", { task_id: "health-api" });
        assert.match(t, /Subagent report for health-api/);
        await callTool(tools, "dispatch_coder", { task_id: "nope" }); // unknown → graceful text
        await callTool(tools, "submit_impl_delta", IMPL_DELTA);
      },
    ],
    verify: [
      async ({ tools }) => {
        await callTool(tools, "submit_verify", verifyArtifact(true));
        await callTool(tools, "submit_audit", auditArtifact(false));
      },
    ],
  };
  const { state } = await runEngine({ scripts, adaptersOverride: { runNode: async (opts) => { childCalls.push(opts); } } });
  assert.strictEqual(state.status, "completed", state.error);
  assert.strictEqual(childCalls.length, 1, "one child session spawned");
  const cp = childCalls[0].prompt;
  assert.match(cp, /Task health-api — Health API/);
  assert.match(cp, /src\/health\/controller\.ts/);
  assert.match(cp, /200 on GET \/health/, "task ACs in child prompt");
  assert.ok(childCalls[0].tools.includes("write"), "child has write tools");
});

await test("v3: stopAfterClarify settles 'clarified' with the spec; no build session", async () => {
  stepStores.clear(); openCalls.length = 0;
  const scripts = { build: [async () => { throw new Error("build must not run before promotion"); }] };
  const { state } = await runEngine({
    scripts,
    extraStart: { clarify: true, stopAfterClarify: true },
  });
  assert.strictEqual(state.status, "clarified", `status=${state.status}`);
  assert.ok(state.artifacts.spec, "spec artifact present");
  assert.strictEqual(openCalls.filter((c) => c.stepId === "build").length, 0, "no build session created");
});

await test("v3: promote continues into build→verify→completed; onSettled fires on both settles", async () => {
  stepStores.clear(); openCalls.length = 0;
  const scripts = {
    build: [
      async ({ tools }) => {
        await callTool(tools, "submit_plan", PLAN);
        await callTool(tools, "submit_tasks", TASKS);
        await callTool(tools, "submit_impl_delta", IMPL_DELTA);
      },
    ],
    verify: [
      async ({ tools }) => {
        await callTool(tools, "submit_verify", verifyArtifact(true));
        await callTool(tools, "submit_audit", auditArtifact(false));
      },
    ],
  };
  const emit = { state: () => {}, event: () => {} };
  const clarifyRunNode = async (opts) => {
    if (opts.nodeId === "clarify") {
      const fin = (opts.customTools ?? []).find((t) => t.name === "finalize_spec");
      await fin?.execute("x", { summary: "s", decisions: [], acceptance_criteria: ["AC1"] });
      return;
    }
    throw new Error("unexpected clarify child");
  };
  const engine = createEngine({
    modelRuntime: {}, emit, webTools: {},
    adapters: { openStepSession: makeFakeOpen(scripts), runNode: clarifyRunNode, runMechanicalChecks: async () => [] },
  });
  const id = `v3p-${Date.now()}`;
  const settledStatuses = [];
  const st = await engine.start({
    id, task: "t", project: { name: "sandbox", path: FIXTURE },
    models: { clarify: "auto", builder: "auto", verifier: "auto", security: "auto" },
    clarify: true, maxFixRounds: 2, git: false, audit: true, approvePlan: false, remoteChecks: false, security: "off",
    stopAfterClarify: true, onSettled: (status) => settledStatuses.push(status),
  });
  const deadline = Date.now() + 15_000;
  while (st.status !== "clarified" && Date.now() < deadline) await sleep(10);
  assert.strictEqual(st.status, "clarified");
  assert.deepStrictEqual(settledStatuses, ["clarified"]);
  const out = engine.promote(id);
  assert.strictEqual(out.ok, true, out.error);
  while (!["completed", "failed", "cancelled"].includes(st.status) && Date.now() < deadline) await sleep(10);
  assert.strictEqual(st.status, "completed", st.error);
  assert.deepStrictEqual(settledStatuses, ["clarified", "completed"], "onSettled fired on both settles");
  assert.strictEqual(openCalls.filter((c) => c.stepId === "build").length, 1, "one build session across promote");
});

await test("v3: tree lock — tree-holding run blocks starts/promotes; released after settle", async () => {
  stepStores.clear(); openCalls.length = 0;
  let releaseHolder;
  const holderGate = new Promise((r) => (releaseHolder = r));
  const scripts = {
    build: [
      async ({ tools }) => {
        await callTool(tools, "submit_plan", PLAN);
        await callTool(tools, "submit_tasks", TASKS);
        await callTool(tools, "submit_impl_delta", IMPL_DELTA);
      },
      async ({ tools }) => {
        await callTool(tools, "submit_plan", PLAN);
        await callTool(tools, "submit_tasks", TASKS);
        await callTool(tools, "submit_impl_delta", IMPL_DELTA);
      },
    ],
    verify: [
      async ({ tools }) => {
        await holderGate; // holder parked mid-verify until released
        await callTool(tools, "submit_verify", verifyArtifact(true));
        await callTool(tools, "submit_audit", auditArtifact(false));
      },
      async ({ tools }) => {
        await callTool(tools, "submit_verify", verifyArtifact(true));
        await callTool(tools, "submit_audit", auditArtifact(false));
      },
    ],
  };
  const emit = { state: () => {}, event: () => {} };
  const clarifyRunNode = async (opts) => {
    if (opts.nodeId === "clarify") {
      const fin = (opts.customTools ?? []).find((t) => t.name === "finalize_spec");
      await fin?.execute("x", { summary: "s2", decisions: [], acceptance_criteria: ["AC2"] });
      return;
    }
    throw new Error("stop");
  };
  const engine = createEngine({
    modelRuntime: {}, emit, webTools: {},
    adapters: { openStepSession: makeFakeOpen(scripts), runNode: clarifyRunNode, runMechanicalChecks: async () => [] },
  });
  const holder = await engine.start({
    id: "lock-holder", task: "t", project: { name: "sandbox", path: FIXTURE },
    models: { clarify: "auto", builder: "auto", verifier: "auto", security: "auto" },
    clarify: false, maxFixRounds: 2, git: false, audit: true, approvePlan: false, remoteChecks: false, security: "off",
  });
  const deadline = Date.now() + 15_000;
  while (engine.treeLockHolder(FIXTURE) !== "lock-holder" && Date.now() < deadline) await sleep(10);
  assert.strictEqual(engine.treeLockHolder(FIXTURE), "lock-holder", "holder holds the tree");
  await assert.rejects(
    () => engine.start({ id: "lock-c", task: "t", project: { name: "sandbox", path: FIXTURE }, models: { clarify: "auto", builder: "auto", verifier: "auto", security: "auto" }, clarify: false, maxFixRounds: 0, git: false, audit: false, approvePlan: false, remoteChecks: false, security: "off" }),
    /holds the working tree/,
  );
  const second = await engine.start({
    id: "lock-b", task: "t2", project: { name: "sandbox", path: FIXTURE },
    models: { clarify: "auto", builder: "auto", verifier: "auto", security: "auto" },
    clarify: true, maxFixRounds: 2, git: false, audit: true, approvePlan: false, remoteChecks: false, security: "off",
    stopAfterClarify: true,
  });
  while (second.status !== "clarified" && Date.now() < deadline) await sleep(10);
  assert.strictEqual(second.status, "clarified", "clarify-only run settles alongside the holder");
  const rejected = engine.promote("lock-b");
  assert.strictEqual(rejected.ok, false, "promote rejected while tree held");
  assert.match(rejected.error, /working tree is held/);
  releaseHolder();
  while (!["completed", "failed", "cancelled"].includes(holder.status) && Date.now() < deadline) await sleep(10);
  assert.strictEqual(holder.status, "completed", holder.error);
  const out = engine.promote("lock-b");
  assert.strictEqual(out.ok, true, out.error);
  while (!["completed", "failed", "cancelled"].includes(second.status) && Date.now() < deadline) await sleep(10);
  assert.strictEqual(second.status, "completed", second.error);
});

await test("v3: promote-from-disk — a clarified run continues across a restart and holds the tree", async () => {
  stepStores.clear(); openCalls.length = 0;
  const scripts = {
    build: [
      async ({ tools }) => {
        await callTool(tools, "submit_plan", PLAN);
        await callTool(tools, "submit_tasks", TASKS);
        await callTool(tools, "submit_impl_delta", IMPL_DELTA);
      },
    ],
    verify: [
      async ({ tools }) => {
        await callTool(tools, "submit_verify", verifyArtifact(true));
        await callTool(tools, "submit_audit", auditArtifact(false));
      },
    ],
  };
  const clarifyRunNode = async (opts) => {
    if (opts.nodeId === "clarify") {
      const fin = (opts.customTools ?? []).find((t) => t.name === "finalize_spec");
      await fin?.execute("x", { summary: "s3", decisions: [], acceptance_criteria: ["AC3"] });
    }
  };
  const mkEngine = (emit) =>
    createEngine({
      modelRuntime: {}, emit, webTools: {},
      adapters: { openStepSession: makeFakeOpen(scripts), runNode: clarifyRunNode, runMechanicalChecks: async () => [] },
    });
  const models = { clarify: "auto", builder: "auto", verifier: "auto", security: "auto" };
  const id = `pd-${Date.now()}`;
  const engine1 = mkEngine({ state: () => {}, event: () => {} });
  const st = await engine1.start({
    id, task: "t", project: { name: "sandbox", path: FIXTURE }, models,
    clarify: true, maxFixRounds: 2, git: false, audit: true, approvePlan: false, remoteChecks: false, security: "off",
    stopAfterClarify: true, ticketId: "F07",
  });
  const deadline = Date.now() + 15_000;
  while (st.status !== "clarified" && Date.now() < deadline) await sleep(10);
  assert.strictEqual(st.status, "clarified");
  // The gate-park watcher and the Inbox join on TOP-LEVEL state.ticketId — it
  // previously lived only in options, silently disabling gate parking (Q3's
  // fake hid the drift until a real-shape test existed).
  assert.strictEqual(st.ticketId, "F07", "top-level state.ticketId (watcher/Inbox join key)");
  assert.strictEqual(st.options.ticketId, "F07", "options.ticketId provenance kept");
  // persist exactly as the real server would (emit.state → saveState)
  fs.writeFileSync(path.join(runDir(id), "state.json"), JSON.stringify(st));
  // fresh server session: the run exists only on disk
  const latest = { s: null };
  const engine2 = mkEngine({ state: (run) => { latest.s = run.state; }, event: () => {} });
  const settled = [];
  const out = engine2.resumeFromDisk(id, { name: "sandbox", path: FIXTURE }, { promote: true, onSettled: (s) => settled.push(s) });
  assert.ok(out.ok, out.error);
  assert.strictEqual(engine2.treeLockHolder(FIXTURE), id, "resumed run holds the tree");
  await assert.rejects(
    () => engine2.start({ id: "pd-block", task: "x", project: { name: "sandbox", path: FIXTURE }, models, clarify: false, maxFixRounds: 0, git: false, audit: false, approvePlan: false, remoteChecks: false, security: "off" }),
    /holds the working tree/,
  );
  while (latest.s?.status !== "completed" && Date.now() < deadline) await sleep(10);
  assert.strictEqual(latest.s.status, "completed", latest.s?.error);
  assert.strictEqual(latest.s.options.stopAfterClarify, false, "promote-from-disk flips stopAfterClarify");
  assert.deepStrictEqual(settled, ["completed"], "onSettled wired through the disk resume");
  assert.strictEqual(openCalls.filter((c) => c.stepId === "build").length, 1, "one build session for the resumed run");
  fs.rmSync(runDir(id), { recursive: true, force: true });
});

await test("v3: hard cancel (out-of-band, owner) fires onSettled — queue tickets don't strand", async () => {
  stepStores.clear(); openCalls.length = 0;
  let release = () => {};
  const hang = new Promise((r) => (release = r));
  const scripts = {
    build: [
      async () => {
        await hang; // the build turn is mid-flight when the owner cancels
        throw new Error("build must not complete after a cancel");
      },
    ],
  };
  const engine = createEngine({
    modelRuntime: {}, emit: { state: () => {}, event: () => {} }, webTools: {},
    adapters: { openStepSession: makeFakeOpen(scripts), runNode: async () => {}, runMechanicalChecks: async () => [] },
  });
  const settled = [];
  const st = await engine.start({
    id: `hc-${Date.now()}`, task: "t", project: { name: "sandbox", path: FIXTURE },
    models: { clarify: "auto", builder: "auto", verifier: "auto", security: "auto" },
    clarify: false, maxFixRounds: 0, git: false, audit: false, approvePlan: false, remoteChecks: false, security: "off",
    onSettled: (s) => settled.push(s),
  });
  await sleep(100);
  assert.strictEqual(engine.cancel(st.id), true);
  const deadline = Date.now() + 5_000;
  while (st.status !== "cancelled" && Date.now() < deadline) await sleep(10);
  assert.strictEqual(st.status, "cancelled");
  assert.deepStrictEqual(settled, ["cancelled"], "out-of-band cancel fires onSettled exactly once");
  release(); // unhang the fake prompt; execute()'s catch must not fire a second settle
  await sleep(50);
  assert.deepStrictEqual(settled, ["cancelled"], "no duplicate settle after the cancelled turn unwinds");
});

await test("v3.1: seedSpec — a build run starts with its wave spec; clarify skipped", async () => {
  stepStores.clear(); openCalls.length = 0;
  let builderPromptText = null;
  const scripts = {
    build: [
      async ({ tools, text }) => {
        builderPromptText = text;
        assert.match(text, /SEED-SPEC-MARKER/, "builder prompt carries the seeded spec");
        await callTool(tools, "submit_plan", PLAN);
        await callTool(tools, "submit_tasks", TASKS);
        await callTool(tools, "submit_impl_delta", IMPL_DELTA);
      },
    ],
    verify: [
      async ({ tools }) => {
        await callTool(tools, "submit_verify", verifyArtifact(true));
        await callTool(tools, "submit_audit", auditArtifact(false));
      },
    ],
  };
  const emit = { state: () => {}, event: () => {} };
  const engine = createEngine({
    modelRuntime: {}, emit, webTools: {},
    adapters: { openStepSession: makeFakeOpen(scripts), runNode: async () => { throw new Error("clarify must not run for a seeded build"); }, runMechanicalChecks: async () => [] },
  });
  const st = await engine.start({
    id: `seed-${Date.now()}`, task: "t", project: { name: "sandbox", path: FIXTURE },
    models: { clarify: "auto", builder: "auto", verifier: "auto", security: "auto" },
    clarify: false, maxFixRounds: 2, git: false, audit: true, approvePlan: false, remoteChecks: false, security: "off",
    seedSpec: { summary: "SEED-SPEC-MARKER summary", decisions: [{ topic: "style", decision: "CommonJS" }], acceptance_criteria: ["AC-SEED"] },
    ticketId: "F06",
  });
  const deadline = Date.now() + 15_000;
  while (!["completed", "failed", "cancelled"].includes(st.status) && Date.now() < deadline) await sleep(10);
  assert.strictEqual(st.status, "completed", st.error);
  assert.strictEqual(st.artifacts.spec.summary, "SEED-SPEC-MARKER summary", "spec seeded into artifacts");
  assert.ok(builderPromptText.includes("CommonJS"), "seeded decisions flow into the build");
  assert.strictEqual(openCalls.filter((c) => c.stepId === "clarify").length, 0, "no clarify session");
});

await test("v3.1: wave clarify — one PM run locks one spec per ticket; REJECTED on bad ticket_id", async () => {
  stepStores.clear(); openCalls.length = 0;
  const prompts = [];
  let turns = 0;
  const waveRunNode = async (opts) => {
    if (opts.nodeId !== "clarify") return;
    prompts.push(opts.prompt);
    const fin = (opts.customTools ?? []).find((t) => t.name === "finalize_spec");
    turns += 1;
    if (turns === 1) {
      const bad = await fin.execute("x", { ticket_id: "F99", summary: "s", decisions: [], acceptance_criteria: ["AC"] });
      assert.match(bad.content[0].text, /REJECTED.*F99/, "unknown ticket_id rejected with guidance");
      const dup = await fin.execute("x", { ticket_id: "F06", summary: "F06 spec v1", decisions: [], acceptance_criteria: ["AC6"] });
      assert.match(dup.content[0].text, /RECORDED.*1\/2/);
      return;
    }
    // turn 2: overwrite F06 then lock F07 — coverage completes the phase
    const again = await fin.execute("x", { ticket_id: "F06", summary: "F06 spec FINAL", decisions: [], acceptance_criteria: ["AC6b"] });
    assert.match(again.content[0].text, /RECORDED/);
    const last = await fin.execute("x", { ticket_id: "F07", summary: "F07 spec", decisions: [], acceptance_criteria: ["AC7"] });
    assert.match(last.content[0].text, /fully clarified \(2\/2\)/);
  };
  const emit = { state: () => {}, event: () => {} };
  const engine = createEngine({
    modelRuntime: {}, emit, webTools: {},
    adapters: { openStepSession: makeFakeOpen({ build: [async () => { throw new Error("build must not run"); }] }), runNode: waveRunNode, runMechanicalChecks: async () => [] },
  });
  const st = await engine.start({
    id: `wave-${Date.now()}`, task: "WAVE BRIEF", project: { name: "sandbox", path: FIXTURE },
    models: { clarify: "auto", builder: "auto", verifier: "auto", security: "auto" },
    clarify: true, maxFixRounds: 2, git: false, audit: true, approvePlan: false, remoteChecks: false, security: "off",
    stopAfterClarify: true, waveTickets: [{ id: "F06", title: "Refresh-all" }, { id: "F07", title: "Auto-refresh" }],
    ticketId: null,
  });
  const deadline = Date.now() + 15_000;
  while (!["clarified", "failed", "cancelled"].includes(st.status) && Date.now() < deadline) await sleep(10);
  assert.strictEqual(st.status, "clarified", st.error);
  assert.deepStrictEqual(st.wave.ticketIds, ["F06", "F07"], "wave recorded in state");
  assert.strictEqual(st.artifacts.specs.F06.summary, "F06 spec FINAL", "re-finalize overwrites");
  assert.strictEqual(st.artifacts.specs.F07.summary, "F07 spec");
  assert.match(prompts[1] ?? "", /WAVE PROGRESS.*Still to finalize: F07/, "round-2 prompt carries wave progress");
  assert.strictEqual(openCalls.filter((c) => c.stepId === "build").length, 0, "no build session");
  assert.strictEqual(st.artifacts.spec, undefined, "no single run spec on a wave run");
});

await test("v3.1: waveTickets without clarify is rejected", async () => {
  const engine = createEngine({ modelRuntime: {}, emit: { state: () => {}, event: () => {} }, webTools: {}, adapters: {} });
  await assert.rejects(
    () => engine.start({ id: `wv-${Date.now()}`, task: "t", project: { name: "sandbox", path: FIXTURE }, models: {}, clarify: false, maxFixRounds: 0, git: false, audit: false, approvePlan: false, remoteChecks: false, security: "off", waveTickets: [{ id: "F1" }] }),
    /waveTickets requires clarify/,
  );
});

await test("gates exhausted → run settles 'failed' exactly once (V12 second verse)", async () => {
  stepStores.clear(); openCalls.length = 0;
  const failing = (n) => ({
    verdict: "gaps-found",
    checks: [
      { criterion: "GET /health returns 200 JSON", pass: n >= 2, evidence: n >= 2 ? "fixed" : "404" },
      { criterion: "filler check to fail every round", pass: false, evidence: "always broken" },
    ],
  });
  const scripts = {
    build: [
      async ({ tools }) => {
        await callTool(tools, "submit_plan", PLAN);
        await callTool(tools, "submit_tasks", TASKS);
        await callTool(tools, "submit_impl_delta", IMPL_DELTA);
      },
    ],
    verify: [
      async ({ tools }) => { await callTool(tools, "submit_verify", verifyArtifact(true)); await callTool(tools, "submit_audit", auditArtifact(true)); },
      async ({ tools }) => { await callTool(tools, "submit_verify", failing(0)); },
      async ({ tools }) => { await callTool(tools, "submit_verify", failing(1)); },
    ],
    // (maxFixRounds 2 → rounds 0,1,2; three verify sessions)
  };
  const { state, events } = await runEngine({ scripts, maxFixRounds: 2, mechanical: () => [] });
  assert.strictEqual(state.status, "failed", state.error);
  assert.match(state.error ?? "", /gates still failing after 2 fix round/);
  const settled = events.filter((e) => e.t === "notice" && /run failed/.test(e.s ?? ""));
  assert.ok(settled.length >= 1, "failure notice emitted");
  assert.strictEqual(openCalls.filter((c) => c.stepId === "security").length, 0, "security skipped");
});

await test("v3.1: fix-resume — resume({fix}) builds from the LAST verify report, skipping re-verify", async () => {
  stepStores.clear(); openCalls.length = 0;
  const scripts = {
    build: [
      async ({ tools }) => {
        await callTool(tools, "submit_plan", PLAN);
        await callTool(tools, "submit_tasks", TASKS);
        await callTool(tools, "submit_impl_delta", IMPL_DELTA);
      },
      async ({ tools, text }) => {
        // the fix-resume turn: the prompt must carry the LAST verify gaps
        assert.match(text, /verification \(fix-resume\)/);
        assert.match(text, /always broken/, "the still-failing criterion rides as feedback");
        await callTool(tools, "submit_impl_delta", IMPL_DELTA);
      },
    ],
    verify: [
      async ({ tools }) => { await callTool(tools, "submit_verify", failingOnce(0)); },
      async ({ tools }) => { await callTool(tools, "submit_verify", verifyArtifact(true)); await callTool(tools, "submit_audit", auditArtifact(false)); },
    ],
  };
  const emit = { state: () => {}, event: () => {} };
  const engine = createEngine({
    modelRuntime: {}, emit, webTools: {},
    adapters: { openStepSession: makeFakeOpen(scripts), runNode: async () => {}, runMechanicalChecks: async () => [] },
  });
  const id = `fx-${Date.now()}`;
  const settled = [];
  const st = await engine.start({
    id, task: "t", project: { name: "sandbox", path: FIXTURE },
    models: { clarify: "auto", builder: "auto", verifier: "auto", security: "auto" },
    clarify: false, maxFixRounds: 0, git: false, audit: true, approvePlan: false, remoteChecks: false, security: "off",
    onSettled: (s) => settled.push(s),
  });
  const deadline = Date.now() + 15_000;
  while (!["failed", "completed", "cancelled"].includes(st.status) && Date.now() < deadline) await sleep(10);
  assert.strictEqual(st.status, "failed", "round 0 fails with maxFixRounds 0");
  assert.deepStrictEqual(settled, ["failed"], "gates-exhausted settle fires (the bug)");
  // THE FEATURE: fix-resume from the failed run
  const out = engine.resume(id, { fix: true });
  assert.ok(out.ok, out.error);
  assert.strictEqual(st.fixResume, false, "flag consumed by execute()");
  while (!["completed", "failed", "cancelled"].includes(st.status) && Date.now() < deadline) await sleep(10);
  assert.strictEqual(st.status, "completed", st.error);
  assert.deepStrictEqual(settled, ["failed", "completed"], "settle fired on both");
  // ONE build session resumed; the fix turn ran; verify ran exactly once more
  assert.strictEqual(openCalls.filter((c) => c.stepId === "build" && c.resumed).length, 1, "the fix turn reopens the SAME persisted build session");
  assert.strictEqual(openCalls.filter((c) => c.stepId === "verify").length, 2, "verify round 0 + the post-fix re-verify — no extra re-verify");
});

await test("security exhausted → settles 'failed'; fix-resume skips verify and re-scans with the findings as feedback", async () => {
  stepStores.clear(); openCalls.length = 0;
  let secCalls = 0;
  const secFindings = (present) => ({
    verdict: "accepted",
    findings: present
      ? [{ severity: "high", title: "hardcoded secret in config", evidence: "sk=... in source", fix: "use env", fixable_in_scope: true }]
      : [],
  });
  let securityRounds = 0;
  const feedbackTurn = async ({ tools, text }) => {
    // runs for normal security fix rounds AND the fix-resume turn — behave by prompt
    if (/fix-resume/.test(text)) {
      assert.match(text, /hardcoded secret/, "the finding rides as fix-resume feedback");
    }
    await callTool(tools, "submit_impl_delta", IMPL_DELTA);
  };
  const scripts = {
    build: [
      async ({ tools }) => {
        await callTool(tools, "submit_plan", PLAN);
        await callTool(tools, "submit_tasks", TASKS);
        await callTool(tools, "submit_impl_delta", IMPL_DELTA);
      },
      feedbackTurn, feedbackTurn, feedbackTurn, feedbackTurn,
    ],
    verify: [async ({ tools }) => { await callTool(tools, "submit_verify", verifyArtifact(true)); await callTool(tools, "submit_audit", auditArtifact(false)); }],
    security: [
      async ({ tools }) => { securityRounds += 1; secCalls += 1; await callTool(tools, "submit_security", secFindings(secCalls < 3)); },
      async ({ tools }) => { securityRounds += 1; secCalls += 1; await callTool(tools, "submit_security", secFindings(secCalls < 3)); },
      async ({ tools }) => { securityRounds += 1; secCalls += 1; await callTool(tools, "submit_security", secFindings(secCalls < 3)); },
    ],
  };
  const emit = { state: () => {}, event: () => {} };
  const engine = createEngine({
    modelRuntime: {}, emit, webTools: {},
    adapters: { openStepSession: makeFakeOpen(scripts), runNode: async () => {}, runMechanicalChecks: async () => [] },
  });
  const id = `sx-${Date.now()}`;
  const settled = [];
  const st = await engine.start({
    id, task: "t", project: { name: "sandbox", path: FIXTURE },
    models: { clarify: "auto", builder: "auto", verifier: "auto", security: "auto" },
    clarify: false, maxFixRounds: 1, git: false, audit: true, approvePlan: false, remoteChecks: false, security: "scan",
    onSettled: (s) => settled.push(s),
  });
  const deadline = Date.now() + 20_000;
  while (!["failed", "completed", "cancelled"].includes(st.status) && Date.now() < deadline) await sleep(10);
  assert.strictEqual(st.status, "failed", st.error);
  assert.match(st.error ?? "", /security findings not fixed/);
  assert.deepStrictEqual(settled, ["failed"], "security exhaustion settles");
  // fix-resume: verify must NOT re-run; security re-scans exactly once
  const out = engine.resume(id, { fix: true });
  assert.ok(out.ok, out.error);
  const verifyOpensBefore = openCalls.filter((c) => c.stepId === "verify").length;
  while (!["completed", "failed", "cancelled"].includes(st.status) && Date.now() < deadline) await sleep(10);
  assert.strictEqual(st.status, "completed", st.error);
  assert.strictEqual(openCalls.filter((c) => c.stepId === "verify").length, verifyOpensBefore, "verify skipped on security-only fix-resume");
  assert.strictEqual(securityRounds, 3, "security re-scanned exactly once after the fix (2 exhaustion scans + 1)");
  assert.deepStrictEqual(settled, ["failed", "completed"]);
});

// --- summary ---------------------------------------------------------------------------

const failed = results.filter(([, ok]) => !ok);
console.log(`\n${results.length - failed.length}/${results.length} engine scenarios passed`);
fs.rmSync(FIXTURE, { recursive: true, force: true });
process.exit(failed.length ? 1 : 0);
