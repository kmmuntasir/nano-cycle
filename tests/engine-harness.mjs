// Engine unit harness — drives createEngine with fake step sessions (the plan's
// Phase 6 "done when"). Run: node tests/engine-harness.mjs
import "./_test-dirs.mjs"; // FIRST: isolate tickets/runs stores (never the live data)
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert";
import { execFileSync } from "node:child_process";
import { createEngine, runScannerSuite, looksLikeSecretFile } from "../host/engine.mjs";
import { runDir } from "../host/state.mjs";

const FIXTURE = fs.mkdtempSync("/tmp/nano-engine-");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- fake session layer -----------------------------------------------------------

const stepStores = new Map(); // stepId -> { turns: 0, files: [], prompts: [] }
const openCalls = []; // { stepId, resumed, handle, systemPrompt, runId }

// The fake mirrors REAL pi where it matters (a lie here hides the bugs this
// harness exists to catch): abort() makes the in-flight prompt() RESOLVE — it
// never rejects — and the turn's remaining script keeps running detached, like a
// provider stream that has been cut. close() == dispose().
// opts.openDelayMs simulates a slow session load (cancel-during-load tests).
function makeFakeOpen(scripts, { openDelayMs = 0, abortReleasesPrompt = true } = {}) {
  return async function fakeOpenStepSession(opts) {
    const store = stepStores.get(opts.stepId) ?? { turns: 0, files: [], prompts: [] };
    stepStores.set(opts.stepId, store);
    const resumed = !!opts.sessionFile;
    const file = opts.sessionFile ?? path.join(FIXTURE, `${opts.stepId}-${store.files.length}.jsonl`);
    store.files.push(file);
    const delay = typeof openDelayMs === "object" ? openDelayMs[opts.stepId] ?? 0 : openDelayMs;
    if (delay) await sleep(delay);
    const tools = Object.fromEntries((opts.customTools ?? []).map((t) => [t.name ?? t.name, t]));
    let release = null;
    const handle = {
      sessionFile: file,
      resumed,
      session: { messages: [] },
      aborts: 0,
      closed: false,
      abort() {
        handle.aborts += 1;
        if (abortReleasesPrompt) release?.();
      },
      close() {
        handle.closed = true;
      },
      async prompt(text) {
        store.prompts.push(text);
        const script = scripts[opts.stepId];
        const turn = script?.[store.turns];
        store.turns += 1;
        if (!turn) return;
        const aborted = new Promise((r) => {
          release = r;
        });
        const running = Promise.resolve().then(() => turn({ tools, text, store, cwd: opts.cwd }));
        running.catch(() => {}); // a turn that fails AFTER an abort is nobody's problem
        try {
          await Promise.race([running, aborted]);
        } finally {
          release = null;
        }
      },
    };
    openCalls.push({ stepId: opts.stepId, resumed, handle, systemPrompt: opts.systemPrompt, runId: opts.runId, signal: opts.signal, cwd: opts.cwd });
    // a cancel that fired while the session was loading: real openStepSession aborts at once
    if (opts.signal?.aborted) handle.abort();
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

async function runEngine({ scripts, autoGate = ["approve"], mechanical, security = "off", approvePlan = true, maxFixRounds = 2, project = "sandbox", projectPath, adaptersOverride, extraStart = {} }) {
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
    project: { name: project, path: projectPath ?? FIXTURE },
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

await test("provider failure after plan/tasks is preserved, not mistaken for a missing milestone", async () => {
  stepStores.clear(); openCalls.length = 0;
  const providerError = '429: {"code":"1308","message":"five-hour usage limit reached"}';
  const scripts = {
    build: [
      async ({ tools }) => {
        await callTool(tools, "submit_plan", PLAN);
        await callTool(tools, "submit_tasks", TASKS);
        // The plan and tasks already exist, but the provider fails during
        // implementation. safePrompt must NOT swallow this as milestone success.
        throw new Error(providerError);
      },
    ],
  };
  const { state, events } = await runEngine({ scripts, approvePlan: false });
  assert.strictEqual(state.status, "failed", state.error);
  assert.match(state.error ?? "", /429/);
  assert.match(state.error ?? "", /five-hour usage limit/);
  assert.ok(state.artifacts.plan && state.artifacts.tasks, "completed milestones remain available for resume");
  assert.ok(!state.artifacts.implDelta, "no impl-delta is invented after provider failure");
  assert.ok(events.some((e) => e.t === "notice" && /429/.test(e.s ?? "")), "normalized failure notice retains provider error");
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
    verify: [0, 1].map(() => async ({ tools }) => {
      await callTool(tools, "submit_verify", verifyArtifact(true));
      await callTool(tools, "submit_audit", auditArtifact(false));
    }),
    security: [
      async ({ tools }) => {
        await callTool(tools, "submit_security", secFindings(true));
      },
      async ({ tools }) => {
        await callTool(tools, "submit_security", { verdict: "pass", findings: [] });
      },
    ],
  };
  stepStores.clear(); openCalls.length = 0;
  const { state } = await runEngine({ scripts, security: "scan" });
  assert.strictEqual(state.status, "completed", state.error);
  assert.strictEqual(state.artifacts.security.verdict, "pass");
  // #16: the security fix changed the tree after verify accepted it — it is re-verified
  assert.strictEqual(openCalls.filter((c) => c.stepId === "verify").length, 2, "verify re-ran after the security fix round");
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
  fs.mkdirSync(runDir(id), { recursive: true }); // runDir() is read-only now
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
  while ((st.status !== "cancelled" || settled.length === 0) && Date.now() < deadline) await sleep(10);
  assert.strictEqual(st.status, "cancelled");
  assert.deepStrictEqual(settled, ["cancelled"], "out-of-band cancel fires onSettled exactly once (after the git cleanup)");
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
      async ({ tools }) => { await callTool(tools, "submit_impl_delta", IMPL_DELTA); },
      async ({ tools }) => { await callTool(tools, "submit_impl_delta", IMPL_DELTA); },
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

await test("security exhausted → settles 'failed'; fix-resume re-verifies the changed tree, then re-scans with the findings as feedback", async () => {
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
    verify: [0, 1, 2].map(() => async ({ tools }) => { await callTool(tools, "submit_verify", verifyArtifact(true)); await callTool(tools, "submit_audit", auditArtifact(false)); }),
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
  // fix-resume: the fix changed the tree, so verify re-runs ONCE (#16); security re-scans once
  const out = engine.resume(id, { fix: true });
  assert.ok(out.ok, out.error);
  const verifyOpensBefore = openCalls.filter((c) => c.stepId === "verify").length;
  while (!["completed", "failed", "cancelled"].includes(st.status) && Date.now() < deadline) await sleep(10);
  assert.strictEqual(st.status, "completed", st.error);
  assert.strictEqual(openCalls.filter((c) => c.stepId === "verify").length, verifyOpensBefore + 1, "verify re-ran exactly once on the changed tree");
  assert.strictEqual(securityRounds, 3, "security re-scanned exactly once after the fix (2 exhaustion scans + 1)");
  assert.deepStrictEqual(settled, ["failed", "completed"]);
});

await test("leftover hook: undeclared agent edits are swept into a labelled commit at integrate", async () => {
  stepStores.clear(); openCalls.length = 0;
  const repo = fs.mkdtempSync("/tmp/nano-engine-leftover-");
  const g = (args) => execFileSync("git", args, { cwd: repo, stdio: "pipe" }).toString();
  g(["init"]);
  g(["config", "user.email", "test@example.com"]);
  g(["config", "user.name", "test"]);
  fs.writeFileSync(path.join(repo, "README.md"), "base\n");
  g(["add", "."]);
  g(["commit", "-m", "init"]);
  const scripts = {
    build: [
      async ({ tools, cwd }) => {
        assert.match(await callTool(tools, "submit_plan", PLAN), /APPROVED/);
        assert.match(await callTool(tools, "submit_tasks", TASKS), /Tasks accepted/);
        // the agent edits a file it never declares (the F09 shape: its own
        // backlog entry) and never commits it
        fs.writeFileSync(path.join(cwd, "LEFTOVER.md"), "uncommitted agent edit\n");
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
  const { state, events } = await runEngine({ scripts, projectPath: repo, extraStart: { git: true } });
  assert.strictEqual(state.status, "completed", `status=${state.status} err=${state.error}`);
  // status flips to completed just BEFORE integrate() resolves — wait for its
  // notices instead of racing the leftover commit + ff-merge.
  const t0 = Date.now();
  while (!events.some((e) => e.nodeId === "_run" && /ff-merged |leftover working-tree changes|leftover commit failed/.test(String(e.s ?? ""))) && Date.now() - t0 < 15000) await sleep(50);
  assert.strictEqual(g(["status", "--porcelain"]).trim(), "", "tree clean after integrate — no dirt rides onto base");
  assert.match(g(["log", "--oneline", "-3"]), /leftover working-tree changes/, "leftover sweep committed");
  assert.ok(g(["show", "--name-only", "--pretty=format:", "HEAD"]).includes("LEFTOVER.md") ||
    g(["log", "--name-only", "--pretty=format:", "-3"]).includes("LEFTOVER.md"), "the undeclared edit landed in history");
  assert.ok(events.some((e) => /leftover working-tree changes/.test(e.s ?? "")), "the sweep is announced loudly");
  fs.rmSync(repo, { recursive: true, force: true });
});


// ============================================================================
// Engine-correctness scenarios (REWRITE-ANALYSIS §3: E-1…E-10, Q-C2/C3/H6, #11-#21)
// ============================================================================

const MODELS = { clarify: "auto", builder: "auto", verifier: "auto", security: "auto" };
const BASE_OPTS = { clarify: false, maxFixRounds: 2, git: false, audit: true, approvePlan: false, remoteChecks: false, security: "off" };
const TERMINAL = ["completed", "failed", "cancelled"];
const waitFor = async (fn, ms = 15_000) => {
  const d = Date.now() + ms;
  let v = fn();
  while (!v && Date.now() < d) {
    await sleep(10);
    v = fn();
  }
  return v; // evaluated once per poll — fn may have side effects (e.g. resume())
};
const noopEmit = () => ({ state: () => {}, event: () => {} });
function mkEngine(scripts, { emit, adapters = {}, open, openOpts } = {}) {
  return createEngine({
    modelRuntime: {},
    emit: emit ?? noopEmit(),
    webTools: {},
    adapters: {
      openStepSession: open ?? makeFakeOpen(scripts, openOpts),
      runNode: async () => {},
      runMechanicalChecks: async () => [],
      ...adapters,
    },
  });
}
const startRun = (engine, id, extra = {}) =>
  engine.start({ id, task: "t", project: { name: "sandbox", path: extra.path ?? FIXTURE }, models: MODELS, ...BASE_OPTS, ...extra });
const happyBuild = async ({ tools }) => {
  await callTool(tools, "submit_plan", PLAN);
  await callTool(tools, "submit_tasks", TASKS);
  await callTool(tools, "submit_impl_delta", IMPL_DELTA);
};
const happyVerify = async ({ tools }) => {
  await callTool(tools, "submit_verify", verifyArtifact(true));
  await callTool(tools, "submit_audit", auditArtifact(false));
};
function mkRepo(extraFiles = {}) {
  const repo = fs.mkdtempSync("/tmp/nano-engine-repo-");
  const g = (args) => execFileSync("git", args, { cwd: repo, stdio: "pipe" }).toString();
  g(["init", "-q"]);
  g(["config", "user.email", "test@example.com"]);
  g(["config", "user.name", "test"]);
  fs.writeFileSync(path.join(repo, "README.md"), "base\n");
  for (const [f, c] of Object.entries(extraFiles)) fs.writeFileSync(path.join(repo, f), c);
  g(["add", "."]);
  g(["commit", "-q", "-m", "init"]);
  return { repo, g, base: g(["rev-parse", "--abbrev-ref", "HEAD"]).trim() };
}
function writeDeclared(repo) {
  fs.mkdirSync(path.join(repo, "src/health"), { recursive: true });
  fs.writeFileSync(path.join(repo, "src/health/controller.ts"), "export const c = 1;\n");
  fs.writeFileSync(path.join(repo, "src/health/service.ts"), "export const s = 1;\n");
  fs.writeFileSync(path.join(repo, "README.md"), "base\n\n/health documented\n");
}
const cleanup = (...dirs) => dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true }));

await test("E-1: cancel→resume with a WEDGED old loop never runs two loops (old epoch is inert)", async () => {
  stepStores.clear(); openCalls.length = 0;
  let wedge;
  const wedged = new Promise((r) => (wedge = r));
  const scripts = {
    build: [
      async ({ tools }) => {
        await callTool(tools, "submit_plan", PLAN);
        await wedged; // the provider stream is hung: abort() will NOT release this prompt
        await callTool(tools, "submit_tasks", TASKS);
        await callTool(tools, "submit_impl_delta", { ...IMPL_DELTA, notes: "ZOMBIE" });
      },
      async ({ tools }) => {
        await callTool(tools, "submit_tasks", TASKS);
        await callTool(tools, "submit_impl_delta", { ...IMPL_DELTA, notes: "epoch-2" });
      },
    ],
    verify: [happyVerify],
  };
  const engine = mkEngine(scripts, { openOpts: { abortReleasesPrompt: false }, adapters: { cancelGraceMs: 50 } });
  const settled = [];
  const st = await startRun(engine, `e1-${Date.now()}`, { onSettled: (x) => settled.push(x) });
  await waitFor(() => st.artifacts.plan);
  assert.strictEqual(engine.cancel(st.id), true);
  assert.ok(await waitFor(() => settled.length === 1), "cancel observer fired");
  // resume only once the cancel cleanup released the tree
  let out;
  assert.ok(await waitFor(() => (out = engine.resume(st.id)).ok), `resume accepted: ${out?.error}`);
  assert.ok(await waitFor(() => TERMINAL.includes(st.status) && settled.length === 2), `status=${st.status} settled=${settled}`);
  assert.strictEqual(st.status, "completed", st.error);
  wedge(); // the OLD loop's wedged prompt finally comes back, and its script keeps calling tools
  await sleep(150);
  assert.strictEqual(st.status, "completed", "the zombie epoch did not touch the terminal status");
  assert.deepStrictEqual(settled, ["cancelled", "completed"], "exactly one settle per epoch — the old loop never settles under the new one");
  assert.strictEqual(st.artifacts.implDelta.notes, "epoch-2", "zombie tool calls are ignored (inert epoch)");
  assert.strictEqual(openCalls.filter((c) => c.stepId === "verify").length, 1, "one verifier — one loop");
});

await test("E-2/E-9: cancel keeps the tree lock until cleanup finished; observer fires after; kill is scoped by runId", async () => {
  stepStores.clear(); openCalls.length = 0;
  const killed = [];
  const scripts = { build: [async () => { await new Promise(() => {}); }] };
  const engine = mkEngine(scripts, {
    adapters: { killRunProcesses: async (o) => { killed.push(o); await sleep(150); return { terminated: [], killed: [], skipped: [] }; } },
  });
  const settled = [];
  const id = `e2-${Date.now()}`;
  const st = await startRun(engine, id, { onSettled: (x) => settled.push(x) });
  await waitFor(() => openCalls.some((c) => c.stepId === "build"));
  assert.strictEqual(engine.cancel(id), true);
  assert.strictEqual(st.status, "cancelled");
  assert.strictEqual(engine.treeLockHolder(FIXTURE), id, "lock still held while the cancel cleanup is in flight");
  await assert.rejects(() => startRun(engine, `e2-b-${Date.now()}`), /holds the working tree/);
  assert.deepStrictEqual(settled, [], "observer waits for the cleanup");
  assert.ok(await waitFor(() => settled.length === 1));
  assert.strictEqual(engine.treeLockHolder(FIXTURE), null, "lock released after cleanup");
  assert.strictEqual(killed[0]?.runId, id, "process kill is scoped to THIS run (E-9)");
  assert.ok(openCalls.find((c) => c.stepId === "build").handle.closed, "build session disposed on cancel");
});

await test("E-2: a cancel during session load is not lost — no verifier turn runs, the session is closed", async () => {
  stepStores.clear(); openCalls.length = 0;
  const scripts = { build: [happyBuild], verify: [async () => { throw new Error("verifier turn must not run after a cancel"); }] };
  const engine = mkEngine(scripts, { openOpts: { openDelayMs: { verify: 250 } } });
  const settled = [];
  const id = `e2b-${Date.now()}`;
  const st = await startRun(engine, id, { onSettled: (x) => settled.push(x) });
  await waitFor(() => st.steps.find((x) => x.id === "verify")?.status === "running");
  engine.cancel(id); // the verifier session is still loading
  assert.ok(await waitFor(() => settled.length === 1 && openCalls.some((c) => c.stepId === "verify")));
  await sleep(100);
  assert.strictEqual(stepStores.get("verify")?.prompts.length ?? 0, 0, "no verifier turn ran");
  assert.ok(openCalls.find((c) => c.stepId === "verify").handle.closed, "late-loading session was closed");
  assert.strictEqual(st.status, "cancelled");
});

await test("E-3/Q-C3: every gate has its resolver BEFORE emit.state(awaiting-gate); a synchronous park-cancel releases the run", async () => {
  for (const kind of ["plan-approval", "divergence", "security-override"]) {
    stepStores.clear(); openCalls.length = 0;
    const seen = []; // resolver presence at each awaiting-gate emit
    let engine;
    let park = true;
    const emit = {
      state: (run) => {
        if (run.state.status === "awaiting-gate") {
          seen.push({ type: run.state.gate?.type, resolver: !!run.gateResolver });
          // exactly what queue.mjs's watcher does: cancel the gate synchronously, inside the emit
          if (park) engine.gate(run.id, "cancel");
        }
      },
      event: () => {},
    };
    const scripts = {
      build: [
        async ({ tools }) => {
          await callTool(tools, "submit_plan", kind === "divergence" ? { ...PLAN, divergence: "stale spec" } : PLAN);
          if (kind === "security-override") {
            await callTool(tools, "submit_tasks", TASKS);
            await callTool(tools, "submit_impl_delta", IMPL_DELTA);
          }
        },
      ],
      verify: [happyVerify],
      security: [async ({ tools }) => {
        await callTool(tools, "submit_security", { verdict: "findings", findings: [{ id: "d1", source: "scanner", severity: "high", title: "no fix", evidence: "x", fixable_in_scope: false }] });
      }],
    };
    engine = mkEngine(scripts, { emit });
    const settled = [];
    const id = `e3-${kind}-${Date.now()}`;
    const st = await startRun(engine, id, {
      approvePlan: kind !== "security-override",
      security: kind === "security-override" ? "scan" : "off",
      onSettled: (x) => settled.push(x),
    });
    assert.ok(await waitFor(() => TERMINAL.includes(st.status) && settled.length >= 1), `${kind}: status=${st.status}`);
    assert.strictEqual(st.status, "cancelled", `${kind}: the park-cancel released the run (was a no-op before the fix)`);
    assert.ok(seen.length >= 1, `${kind}: an awaiting-gate state was emitted`);
    assert.ok(seen.every((x) => x.resolver), `${kind}: resolver assigned before emit.state: ${JSON.stringify(seen)}`);
    if (kind === "plan-approval") {
      // resumed gate behaves identically to the live one
      park = true;
      seen.length = 0;
      settled.length = 0;
      assert.ok(await waitFor(() => engine.resume(id).ok), "resume accepted");
      assert.ok(await waitFor(() => settled.length === 1), "resumed run settled");
      assert.strictEqual(st.status, "cancelled", "resumed plan gate parked identically");
      assert.deepStrictEqual(seen.map((x) => [x.type, x.resolver]), [["plan-approval", true]], "resumed gate: awaiting-gate status + resolver before emit");
    }
  }
});

await test("Q-C2/Q-H6: a clarify-only wave never switches branches under a build; concurrent starts cannot both take the tree; resume honours the lock", async () => {
  stepStores.clear(); openCalls.length = 0;
  const { repo, g, base } = mkRepo();
  let release;
  const hold = new Promise((r) => (release = r));
  const scripts = { build: [async ({ tools }) => { await callTool(tools, "submit_plan", PLAN); await hold; }] };
  const engine = mkEngine(scripts, {
    adapters: {
      runNode: async (opts) => {
        if (opts.nodeId === "clarify") await (opts.customTools ?? []).find((t) => t.name === "finalize_spec")?.execute("x", { summary: "s", decisions: [], acceptance_criteria: ["AC"] });
      },
    },
  });
  // Q-H6: two concurrent starts → exactly one wins
  const [a, b] = await Promise.allSettled([
    startRun(engine, `qh6-a-${Date.now()}`, { path: repo, git: true }),
    startRun(engine, `qh6-b-${Date.now()}`, { path: repo, git: true }),
  ]);
  const winners = [a, b].filter((r) => r.status === "fulfilled");
  assert.strictEqual(winners.length, 1, "exactly one concurrent start acquired the tree");
  assert.match([a, b].find((r) => r.status === "rejected").reason.message, /holds the working tree/);
  const build = winners[0].value;
  await waitFor(() => build.artifacts.plan);
  assert.strictEqual(g(["rev-parse", "--abbrev-ref", "HEAD"]).trim(), base, "build run works in its worktree — the owner's checkout stays on base");
  assert.strictEqual(execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: build.git.worktree }).toString().trim(), build.git.runBranch, "the worktree is on the run branch");
  // Q-C2: a clarify-only wave starts while the build holds the tree
  const wave = await startRun(engine, `qc2-${Date.now()}`, {
    path: repo, git: true, clarify: true, stopAfterClarify: true, waveTickets: [{ id: "F1" }],
    adapters: undefined,
  });
  await waitFor(() => wave.status === "clarified" || TERMINAL.includes(wave.status), 5000);
  assert.strictEqual(g(["rev-parse", "--abbrev-ref", "HEAD"]).trim(), base, "checkout was NOT switched by the clarify run");
  assert.ok(!g(["branch", "--list", `nano-cycle/${wave.id}`]).trim(), "no wave branch was created in the shared checkout");
  assert.strictEqual(wave.git, null, "clarify-only run carries no git state");
  // Q-H6: in-session resume honours the lock
  engine.cancel(build.id);
  assert.ok(await waitFor(() => engine.treeLockHolder(repo) === null));
  assert.strictEqual(g(["rev-parse", "--abbrev-ref", "HEAD"]).trim(), base, "cancel never moved the owner's checkout");
  assert.ok(fs.existsSync(build.git.worktree), "cancelled run keeps its worktree for resume");
  const holder = await startRun(engine, `qh6-c-${Date.now()}`, { path: repo, git: true });
  const out = engine.resume(build.id);
  assert.strictEqual(out.ok, false, "resume must not steal a held tree");
  assert.match(out.error, /working tree is held/);
  release();
  engine.cancel(holder.id);
  await waitFor(() => engine.treeLockHolder(repo) === null);
  cleanup(repo);
});

await test("E-5: a fix round MUST land a new impl-delta (stale one is cleared at round start)", async () => {
  stepStores.clear(); openCalls.length = 0;
  const scripts = {
    build: [happyBuild, async () => { /* the builder 'fixes' nothing and never calls submit_impl_delta */ }],
    verify: [async ({ tools }) => { await callTool(tools, "submit_verify", verifyArtifact(false)); }],
  };
  const { state } = await runEngine({ scripts });
  assert.strictEqual(state.status, "failed");
  assert.match(state.error ?? "", /fix round 1 ended without a new impl-delta/);
});

await test("E-7/E-8: milestone commit is awaited and tolerant of ignored paths; leftover sweep skips secrets; never commits after cancel", async () => {
  stepStores.clear(); openCalls.length = 0;
  const { repo, g, base } = mkRepo({ ".gitignore": "src/health/service.ts\n" });
  let logAtToolReturn = "";
  const scripts = {
    build: [
      async ({ tools, cwd }) => {
        await callTool(tools, "submit_plan", PLAN);
        await callTool(tools, "submit_tasks", TASKS);
        writeDeclared(cwd);
        fs.writeFileSync(path.join(cwd, ".env"), "API_KEY=sk-live-123\n"); // un-ignored secret
        fs.writeFileSync(path.join(cwd, "notes.md"), "undeclared but harmless\n");
        await callTool(tools, "submit_impl_delta", IMPL_DELTA);
        logAtToolReturn = execFileSync("git", ["log", "--oneline"], { cwd }).toString(); // E-8: the commit exists by the time the tool returned
      },
    ],
    verify: [happyVerify],
  };
  const { state, events } = await runEngine({ scripts, projectPath: repo, extraStart: { git: true } });
  assert.strictEqual(state.status, "completed", `${state.status} ${state.error}`);
  assert.match(logAtToolReturn, /feat: /, "milestone commit awaited before the tool returned");
  const tracked = g(["ls-files"]).split("\n");
  assert.ok(tracked.includes("src/health/controller.ts"), "declared file committed despite an ignored sibling");
  assert.ok(!tracked.includes("src/health/service.ts"), "ignored path not force-added");
  assert.ok(events.some((e) => /milestone commit skipped/.test(e.s ?? "") && /service\.ts/.test(e.s)), "the skipped ignored path is announced");
  assert.ok(tracked.includes("notes.md"), "leftover sweep still lands ordinary undeclared edits");
  assert.ok(!tracked.includes(".env"), "secret-looking file is NEVER committed by the sweep");
  assert.ok(fs.existsSync(path.join(state.git.worktree, ".env")), "...and it was left on disk (the worktree is KEPT because of it, not deleted)");
  assert.ok(!fs.existsSync(path.join(repo, ".env")), "...and never reached the owner's checkout");
  assert.strictEqual(state.git.worktreeKept, true);
  assert.ok(events.some((e) => /left 1 file\(s\) uncommitted on purpose.*\.env/.test(e.s ?? "")), "the refusal is loud");
  assert.strictEqual(g(["rev-parse", "--abbrev-ref", "HEAD"]).trim(), base);
  cleanup(repo);
  // pure classifier
  for (const f of [".env", ".env.local", "config/.env.production", "deploy/id_rsa", "certs/server.pem", "a/b/credentials.json", "my-service-account-prod.json"]) {
    assert.ok(looksLikeSecretFile(f), `${f} looks secret`);
  }
  for (const f of [".env.example", "src/env.ts", "README.md", "environment.md", "keys.md", "id_rsa.pub.md"]) {
    assert.ok(!looksLikeSecretFile(f), `${f} is fine`);
  }
});

await test("E-7: cancel never commits — dirt is parked in a stash, the tree is clean, resume restores it", async () => {
  stepStores.clear(); openCalls.length = 0;
  const { repo, g, base } = mkRepo();
  const scripts = {
    build: [
      async ({ tools, cwd }) => {
        await callTool(tools, "submit_plan", PLAN);
        await callTool(tools, "submit_tasks", TASKS);
        fs.writeFileSync(path.join(cwd, "DIRT.md"), "half-written\n");
        await new Promise(() => {}); // mid-implementation when the owner cancels
      },
      async ({ tools, text, cwd }) => {
        assert.match(text, /continue the IMPLEMENT phase/, "resume continues implementation instead of re-planning (#13)");
        assert.doesNotMatch(text, /Begin the PLAN phase/);
        assert.ok(fs.existsSync(path.join(cwd, "DIRT.md")), "parked work restored before the builder continues");
        writeDeclared(cwd);
        await callTool(tools, "submit_impl_delta", IMPL_DELTA);
      },
    ],
    verify: [happyVerify],
  };
  const engine = mkEngine(scripts);
  const settled = [];
  const id = `e7c-${Date.now()}`;
  const st = await startRun(engine, id, { path: repo, git: true, onSettled: (x) => settled.push(x) });
  fs.writeFileSync(path.join(repo, "OWNER-WIP.md"), "the owner's own uncommitted work\n"); // dirty owner checkout
  const wt = st.git.worktree;
  const wg = (args) => execFileSync("git", args, { cwd: wt, stdio: "pipe" }).toString();
  await waitFor(() => st.artifacts.tasks && fs.existsSync(path.join(wt, "DIRT.md")));
  engine.cancel(id);
  assert.ok(await waitFor(() => settled.length === 1));
  assert.strictEqual(g(["rev-parse", "--abbrev-ref", "HEAD"]).trim(), base, "owner's checkout stayed on base");
  assert.strictEqual(g(["status", "--porcelain"]).trim(), "?? OWNER-WIP.md", "the owner's tree is exactly as they left it — nothing stashed or swept from it");
  assert.strictEqual(wg(["status", "--porcelain"]).trim(), "", "the WORKTREE was cleaned by the stash");
  assert.ok(!fs.existsSync(path.join(wt, "DIRT.md")), "dirt left the worktree");
  assert.ok(!g(["log", "--all", "--oneline"]).includes("leftover"), "nothing was committed after the cancel");
  assert.match(g(["stash", "list"]), new RegExp(`nano-cycle cancel ${id}`), "dirt parked in a labelled stash");
  let out;
  assert.ok(await waitFor(() => (out = engine.resume(id)).ok), out?.error);
  assert.ok(await waitFor(() => TERMINAL.includes(st.status) && settled.length === 2), `status=${st.status}`);
  assert.strictEqual(st.status, "completed", st.error);
  assert.ok(g(["ls-files"]).includes("DIRT.md"), "restored work rode through to the merge");
  assert.ok(fs.existsSync(path.join(repo, "OWNER-WIP.md")), "the owner's uncommitted file survived the whole run + merge");
  cleanup(repo);
});

await test("#21: 'completed' only after the merge landed — a conflicting moved base reads failed (branch+worktree kept); resume retries just the merge", async () => {
  stepStores.clear(); openCalls.length = 0;
  const { repo, g, base } = mkRepo();
  let oldBase;
  const scripts = {
    build: [async (ctx) => { writeDeclared(ctx.cwd); await happyBuild(ctx); }],
    verify: [
      async ({ tools }) => {
        // base moves under the run (someone else landed work touching the SAME
        // file the run edited): the rebase conflicts, ff-only can never succeed
        oldBase = g(["rev-parse", base]).trim();
        fs.writeFileSync(path.join(repo, "README.md"), "base\n\nsomeone else's edit\n");
        g(["commit", "-qam", "diverge"]);
        await happyVerify({ tools });
      },
    ],
  };
  const statuses = new Set();
  const emit = { state: (run) => statuses.add(run.state.status), event: () => {} };
  const engine = mkEngine(scripts, { emit });
  const settled = [];
  const id = `n21-${Date.now()}`;
  const st = await startRun(engine, id, { path: repo, git: true, onSettled: (x) => settled.push(x) });
  assert.ok(await waitFor(() => TERMINAL.includes(st.status) && settled.length === 1), `status=${st.status}`);
  assert.strictEqual(st.status, "failed");
  assert.match(st.error ?? "", /ff-merge/);
  assert.ok(!statuses.has("completed"), "the run never read 'completed' while the merge was pending/failed");
  assert.strictEqual(st.git.merged, false);
  assert.ok(g(["branch", "--list", st.git.runBranch]).trim(), "run branch kept");
  assert.ok(fs.existsSync(st.git.worktree), "worktree kept");
  assert.strictEqual(execFileSync("git", ["status", "--porcelain"], { cwd: st.git.worktree }).toString().trim(), "", "failed rebase was aborted — worktree not left mid-rebase");
  assert.strictEqual(g(["status", "--porcelain"]).trim(), "", "owner's checkout untouched by the failed merge");
  // owner fixes the base, resumes: gates are NOT re-run, the merge is retried
  g(["reset", "--hard", oldBase]);
  const verifyOpens = openCalls.filter((c) => c.stepId === "verify").length;
  let out;
  assert.ok(await waitFor(() => (out = engine.resume(id)).ok), out?.error);
  assert.ok(await waitFor(() => settled.length === 2), `status=${st.status}`);
  assert.strictEqual(st.status, "completed", st.error);
  assert.strictEqual(st.git.merged, true);
  assert.strictEqual(openCalls.filter((c) => c.stepId === "verify").length, verifyOpens, "no re-verification — merge only");
  assert.ok(!fs.existsSync(st.git.worktree ?? "/nonexistent") && !g(["branch", "--list", `nano-cycle/${id}`]).trim(), "landed run: worktree removed, branch deleted");
  cleanup(repo);
});

// ---- one git worktree per run -------------------------------------------------------

const gitIn = (cwd, args) => execFileSync("git", args, { cwd, stdio: "pipe" }).toString();

await test("worktree: agent cwd/checks/scanner == the worktree from a pinned base; owner's checkout + dirty files untouched; node_modules linked + never committed; merge lands and cleans up", async () => {
  stepStores.clear(); openCalls.length = 0;
  const { repo, g, base } = mkRepo({ ".gitignore": "node_modules/\n", "OTHER.md": "tracked\n" });
  fs.mkdirSync(path.join(repo, "node_modules/dep"), { recursive: true });
  fs.writeFileSync(path.join(repo, "node_modules/dep/index.js"), "module.exports = 1;\n");
  fs.mkdirSync(path.join(repo, "web/node_modules"), { recursive: true });
  fs.writeFileSync(path.join(repo, "web/package.json"), "{}\n");
  g(["add", "web/package.json"]);
  g(["commit", "-qm", "web"]);
  const baseSha = g(["rev-parse", "HEAD"]).trim();
  // the owner's checkout is DIRTY at start and must stay exactly so
  fs.writeFileSync(path.join(repo, "OTHER.md"), "tracked\nowner edit\n");
  fs.writeFileSync(path.join(repo, "scratch.txt"), "owner scratch\n");
  const seen = {};
  const scripts = {
    build: [
      async (ctx) => {
        const { cwd } = ctx;
        seen.buildCwd = cwd;
        assert.notStrictEqual(cwd, repo);
        assert.strictEqual(gitIn(cwd, ["rev-parse", "HEAD"]).trim(), baseSha, "worktree starts at the pinned base sha");
        assert.strictEqual(fs.readFileSync(path.join(cwd, "OTHER.md"), "utf8"), "tracked\n", "owner's uncommitted edit is not in the run");
        assert.ok(!fs.existsSync(path.join(cwd, "scratch.txt")), "owner's untracked file is not in the run");
        assert.ok(fs.lstatSync(path.join(cwd, "node_modules")).isSymbolicLink(), "root node_modules is a symlink");
        assert.ok(fs.lstatSync(path.join(cwd, "web/node_modules")).isSymbolicLink(), "workspace node_modules is a symlink");
        assert.ok(fs.existsSync(path.join(cwd, "node_modules/dep/index.js")), "...that resolves to the owner's dependencies");
        assert.ok(!/node_modules/.test(gitIn(cwd, ["status", "--porcelain"])), "the symlinks are invisible to git status (excluded)");
        writeDeclared(cwd);
        await happyBuild(ctx);
      },
    ],
    verify: [async (ctx) => { seen.verifyCwd = ctx.cwd; await happyVerify(ctx); }],
  };
  const mech = [];
  const engine = mkEngine(scripts, {
    adapters: {
      runMechanicalChecks: async (o) => { mech.push(o.projectPath); return []; },
      runScannerSuite: async (r) => { mech.push(`scan:${r.git.worktree}`); return { scanners: [] }; },
    },
  });
  const id = `wt1-${Date.now()}`;
  const settled = [];
  const st = await startRun(engine, id, { path: repo, git: true, security: "scan", onSettled: (x) => settled.push(x) });
  assert.strictEqual(st.git.baseSha, baseSha, "base sha pinned in state.git");
  assert.strictEqual(st.git.worktree, path.join(runDir(id), "wt"));
  assert.strictEqual(g(["rev-parse", "--abbrev-ref", "HEAD"]).trim(), base, "owner's checkout never switched");
  assert.ok(await waitFor(() => TERMINAL.includes(st.status) && settled.length === 1), `status=${st.status} ${st.error}`);
  assert.strictEqual(st.status, "completed", st.error);
  assert.strictEqual(seen.buildCwd, path.join(runDir(id), "wt"));
  assert.strictEqual(seen.verifyCwd, seen.buildCwd, "verifier works in the same worktree");
  assert.ok(mech.includes(seen.buildCwd), "mechanical checks ran in the worktree");
  assert.ok(openCalls.every((c) => c.cwd === seen.buildCwd), "every session cwd is the worktree");
  assert.strictEqual(g(["rev-parse", "--abbrev-ref", "HEAD"]).trim(), base);
  assert.match(g(["log", "--format=%s", "-5"]), /feat: /, "merge landed on base");
  assert.ok(g(["ls-files"]).includes("src/health/controller.ts"));
  assert.ok(!g(["ls-files"]).includes("node_modules"), "node_modules symlinks never committed");
  assert.strictEqual(fs.readFileSync(path.join(repo, "OTHER.md"), "utf8"), "tracked\nowner edit\n", "owner's dirty tracked file untouched");
  assert.strictEqual(fs.readFileSync(path.join(repo, "scratch.txt"), "utf8"), "owner scratch\n", "owner's untracked file untouched");
  assert.ok(fs.statSync(path.join(repo, "node_modules")).isDirectory() && !fs.lstatSync(path.join(repo, "node_modules")).isSymbolicLink() && fs.existsSync(path.join(repo, "node_modules/dep/index.js")), "owner's node_modules intact (symlink removal did not follow it)");
  assert.ok(!fs.existsSync(seen.buildCwd), "worktree removed after the merge");
  assert.strictEqual(gitIn(repo, ["worktree", "list"]).trim().split("\n").length, 1, "no worktree registration left");
  assert.ok(!g(["branch", "--list", st.git.runBranch]).trim(), "run branch deleted");
  cleanup(repo);
});

await test("worktree: a dependency dir the project does NOT ignore is excluded via info/exclude (symlinks never show in status)", async () => {
  stepStores.clear(); openCalls.length = 0;
  const { repo } = mkRepo(); // no .gitignore at all
  fs.mkdirSync(path.join(repo, "node_modules"), { recursive: true });
  fs.writeFileSync(path.join(repo, "node_modules/x.js"), "1\n");
  let status;
  const scripts = {
    build: [async (ctx) => { status = gitIn(ctx.cwd, ["status", "--porcelain"]); writeDeclared(ctx.cwd); await happyBuild(ctx); }],
    verify: [happyVerify],
  };
  const { state } = await runEngine({ scripts, projectPath: repo, extraStart: { git: true } });
  assert.strictEqual(state.status, "completed", state.error);
  assert.strictEqual(status.trim(), "", "symlink not reported as untracked");
  assert.ok(!gitIn(repo, ["ls-files"]).includes("node_modules"), "never committed");
  cleanup(repo);
});

await test("worktree: base branch NOT checked out anywhere → merge advances the ref (update-ref), the owner's checkout is untouched", async () => {
  stepStores.clear(); openCalls.length = 0;
  const { repo, g, base } = mkRepo();
  const scripts = {
    build: [async (ctx) => { writeDeclared(ctx.cwd); await happyBuild(ctx); }],
    verify: [async (ctx) => { g(["checkout", "-q", "-b", "elsewhere"]); await happyVerify(ctx); }], // owner moves off base mid-run
  };
  const { state } = await runEngine({ scripts, projectPath: repo, extraStart: { git: true } });
  assert.strictEqual(state.status, "completed", state.error);
  assert.strictEqual(g(["rev-parse", "--abbrev-ref", "HEAD"]).trim(), "elsewhere", "owner's checkout left alone");
  assert.match(g(["log", "--format=%s", base, "-3"]), /feat: /, "base ref advanced to the run's work");
  assert.ok(!fs.existsSync(path.join(repo, "src/health/controller.ts")), "owner's working tree on 'elsewhere' has no run files");
  cleanup(repo);
});

await test("worktree: base moved (tree changes) → rebase, RE-VERIFY the rebased tree, then land; pure ff and tree-neutral base moves skip re-verify", async () => {
  stepStores.clear(); openCalls.length = 0;
  const { repo, g, base } = mkRepo();
  const verifyPrompts = [];
  const scripts = {
    build: [async (ctx) => { writeDeclared(ctx.cwd); await happyBuild(ctx); }],
    verify: [
      async (ctx) => { fs.writeFileSync(path.join(repo, "UNRELATED.md"), "other work\n"); g(["add", "."]); g(["commit", "-qm", "unrelated"]); await happyVerify(ctx); },
      async (ctx) => { verifyPrompts.push(gitIn(ctx.cwd, ["ls-files"])); await happyVerify(ctx); },
    ],
  };
  const { state, events } = await runEngine({ scripts, projectPath: repo, extraStart: { git: true } });
  assert.strictEqual(state.status, "completed", state.error);
  assert.ok(events.some((e) => /rebasing nano-cycle\//.test(e.s ?? "")), "rebase announced");
  assert.ok(events.some((e) => /re-verifying before the merge/.test(e.s ?? "")), "re-verify announced");
  assert.strictEqual(openCalls.filter((c) => c.stepId === "verify").length, 2, "verifier ran again on the rebased tree");
  assert.ok(/UNRELATED\.md/.test(verifyPrompts[0] ?? "") && /controller\.ts/.test(verifyPrompts[0] ?? ""), "the second verify saw base's new commit AND the run's work");
  const files = g(["ls-files"]);
  assert.ok(files.includes("UNRELATED.md") && files.includes("src/health/controller.ts"), "both lines of work are on base");
  assert.strictEqual(g(["rev-list", "--merges", "--count", base]).trim(), "0", "linear history");
  cleanup(repo);

  // pure ff: no movement → one verify only
  stepStores.clear(); openCalls.length = 0;
  const r2 = mkRepo();
  let out = await runEngine({ scripts: { build: [async (ctx) => { writeDeclared(ctx.cwd); await happyBuild(ctx); }], verify: [happyVerify] }, projectPath: r2.repo, extraStart: { git: true } });
  assert.strictEqual(out.state.status, "completed", out.state.error);
  assert.strictEqual(openCalls.filter((c) => c.stepId === "verify").length, 1, "pure ff: verified once");
  cleanup(r2.repo);

  // base moved by an EMPTY commit: the rebased tree equals the verified one → no re-verify
  stepStores.clear(); openCalls.length = 0;
  const r3 = mkRepo();
  out = await runEngine({
    scripts: { build: [async (ctx) => { writeDeclared(ctx.cwd); await happyBuild(ctx); }], verify: [async (ctx) => { r3.g(["commit", "-q", "--allow-empty", "-m", "noop"]); await happyVerify(ctx); }] },
    projectPath: r3.repo, extraStart: { git: true },
  });
  assert.strictEqual(out.state.status, "completed", out.state.error);
  assert.strictEqual(openCalls.filter((c) => c.stepId === "verify").length, 1, "tree-neutral base move: verified once");
  cleanup(r3.repo);
});

await test("worktree: re-verification after a rebase that FAILS fails the run (branch + worktree kept, nothing merged)", async () => {
  stepStores.clear(); openCalls.length = 0;
  const { repo, g, base } = mkRepo();
  const scripts = {
    build: [async (ctx) => { writeDeclared(ctx.cwd); await happyBuild(ctx); }],
    verify: [
      async (ctx) => { fs.writeFileSync(path.join(repo, "UNRELATED.md"), "x\n"); g(["add", "."]); g(["commit", "-qm", "unrelated"]); await happyVerify(ctx); },
      async ({ tools }) => { await callTool(tools, "submit_verify", verifyArtifact(false)); },
    ],
  };
  const r = await runEngine({ scripts, projectPath: repo, maxFixRounds: 0, extraStart: { git: true } });
  assert.strictEqual(r.state.status, "failed");
  assert.match(r.state.error ?? "", /after rebasing onto the moved/);
  assert.strictEqual(r.state.git.merged, false);
  assert.ok(!g(["ls-files"]).includes("src/health/controller.ts"), "unverified rebased tree never reached base");
  assert.ok(fs.existsSync(r.state.git.worktree) && g(["branch", "--list", r.state.git.runBranch]).trim(), "branch + worktree kept");
  assert.strictEqual(r.state.gatesPassed === true, false, "a failed re-verify never resumes as 'merge only'");
  cleanup(repo);
});

await test("worktree: dirty base checkout — merge refused BEFORE touching it when dirty paths overlap (named, Resume retries); no overlap merges", async () => {
  stepStores.clear(); openCalls.length = 0;
  const { repo, g } = mkRepo({ "OTHER.md": "tracked\n" });
  const scripts = {
    build: [async (ctx) => { writeDeclared(ctx.cwd); await happyBuild(ctx); }],
    verify: [async (ctx) => {
      // the owner edits README.md (which the run also changed) and drops an untracked file that collides with a run file
      fs.writeFileSync(path.join(repo, "README.md"), "owner wip\n");
      fs.mkdirSync(path.join(repo, "src/health"), { recursive: true });
      fs.writeFileSync(path.join(repo, "src/health/service.ts"), "owner untracked\n");
      fs.writeFileSync(path.join(repo, "OTHER.md"), "tracked\nowner edit\n"); // not touched by the run
      await happyVerify(ctx);
    }],
  };
  const engine = mkEngine(scripts);
  const settled = [];
  const id = `dirty-${Date.now()}`;
  const st = await startRun(engine, id, { path: repo, git: true, onSettled: (x) => settled.push(x) });
  assert.ok(await waitFor(() => settled.length === 1), `status=${st.status}`);
  assert.strictEqual(st.status, "failed");
  assert.match(st.error ?? "", /README\.md/);
  assert.match(st.error ?? "", /src\/health\/service\.ts/);
  assert.match(st.error ?? "", /commit\/stash these in .*then Resume to retry the merge/);
  assert.strictEqual(fs.readFileSync(path.join(repo, "README.md"), "utf8"), "owner wip\n", "owner's file untouched");
  assert.ok(fs.existsSync(st.git.worktree) && g(["branch", "--list", st.git.runBranch]).trim(), "branch + worktree kept");
  // owner resolves: stash everything, resume → merge only
  g(["stash", "push", "--include-untracked", "-m", "owner"]);
  const verifyOpens = openCalls.filter((c) => c.stepId === "verify").length;
  let res;
  assert.ok(await waitFor(() => (res = engine.resume(id)).ok), res?.error);
  assert.ok(await waitFor(() => settled.length === 2), `status=${st.status}`);
  assert.strictEqual(st.status, "completed", st.error);
  assert.strictEqual(openCalls.filter((c) => c.stepId === "verify").length, verifyOpens, "merge only");
  assert.ok(g(["ls-files"]).includes("src/health/controller.ts"));
  cleanup(repo);
});

await test("worktree: gitignored .env / .env.* are COPIED (not linked, not templates, not committed), removed with the worktree", async () => {
  stepStores.clear(); openCalls.length = 0;
  const { repo, g } = mkRepo({ ".gitignore": ".env\n.env.*\n!.env.example\nnode_modules/\n", ".env.example": "KEY=\n" });
  fs.mkdirSync(path.join(repo, "web"));
  fs.writeFileSync(path.join(repo, "web/package.json"), "{}\n");
  g(["add", "."]);
  g(["commit", "-qm", "web"]);
  fs.writeFileSync(path.join(repo, ".env"), "KEY=secret\n");
  fs.writeFileSync(path.join(repo, ".env.local"), "LOCAL=1\n");
  fs.writeFileSync(path.join(repo, "web/.env"), "WEB=1\n");
  fs.writeFileSync(path.join(repo, "web/.env.sample"), "WEB=\n"); // template (untracked, not ignored): never copied
  fs.writeFileSync(path.join(repo, "notes.secret"), "not an env file\n");
  fs.writeFileSync(path.join(repo, "README.local"), "x\n");
  let cwdSeen, statusSeen;
  const scripts = {
    build: [async (ctx) => {
      cwdSeen = ctx.cwd;
      assert.strictEqual(fs.readFileSync(path.join(ctx.cwd, ".env"), "utf8"), "KEY=secret\n");
      assert.ok(fs.lstatSync(path.join(ctx.cwd, ".env")).isFile() && !fs.lstatSync(path.join(ctx.cwd, ".env")).isSymbolicLink(), "a copy, not a link");
      assert.ok(fs.existsSync(path.join(ctx.cwd, ".env.local")) && fs.existsSync(path.join(ctx.cwd, "web/.env")));
      assert.ok(fs.existsSync(path.join(ctx.cwd, ".env.example")), "tracked template is there because it is tracked");
      assert.ok(!fs.existsSync(path.join(ctx.cwd, "web/.env.sample")), "templates are never copied");
      assert.ok(!fs.existsSync(path.join(ctx.cwd, "notes.secret")) && !fs.existsSync(path.join(ctx.cwd, "README.local")), "nothing else is copied");
      fs.appendFileSync(path.join(ctx.cwd, ".env"), "EDIT=in-worktree\n");
      statusSeen = gitIn(ctx.cwd, ["status", "--porcelain"]);
      writeDeclared(ctx.cwd);
      await happyBuild(ctx);
    }],
    verify: [happyVerify],
  };
  const { state } = await runEngine({ scripts, projectPath: repo, extraStart: { git: true } });
  assert.strictEqual(state.status, "completed", state.error);
  assert.strictEqual(statusSeen.trim(), "", "env copies are invisible to git status");
  const tracked = g(["ls-files"]);
  assert.ok(!/(^|\n)(web\/)?\.env(\.local)?(\n|$)/.test(tracked), "env files never committed");
  assert.strictEqual(fs.readFileSync(path.join(repo, ".env"), "utf8"), "KEY=secret\n", "the owner's .env was not modified by the run's edit of its copy");
  assert.ok(!fs.existsSync(cwdSeen), "copies removed with the worktree");
  cleanup(repo);
  // an env file that is NOT gitignored is not the driver's to copy
  stepStores.clear(); openCalls.length = 0;
  const r2 = mkRepo();
  fs.writeFileSync(path.join(r2.repo, ".env"), "UNIGNORED=1\n");
  let had;
  const out = await runEngine({ scripts: { build: [async (ctx) => { had = fs.existsSync(path.join(ctx.cwd, ".env")); writeDeclared(ctx.cwd); await happyBuild(ctx); }], verify: [happyVerify] }, projectPath: r2.repo, extraStart: { git: true } });
  assert.strictEqual(out.state.status, "completed", out.state.error);
  assert.strictEqual(had, false, "un-ignored env file is not copied");
  cleanup(r2.repo);
});

await test("worktree: resume after the worktree DIRECTORY was deleted re-adds it on the existing branch (milestones kept); removeWorktree() cleans a kept one", async () => {
  stepStores.clear(); openCalls.length = 0;
  const { repo, g } = mkRepo();
  const scripts = {
    build: [
      async (ctx) => { writeDeclared(ctx.cwd); await happyBuild(ctx); },
    ],
    verify: [async () => { await new Promise(() => {}); }, happyVerify], // first verifier hangs until the owner cancels
  };
  const events = [];
  const engine = mkEngine(scripts, { emit: { state: () => {}, event: (r, n, ev) => events.push(ev) } });
  const settled = [];
  const id = `wt-resume-${Date.now()}`;
  const st = await startRun(engine, id, { path: repo, git: true, onSettled: (x) => settled.push(x) });
  const wt = st.git.worktree;
  await waitFor(() => st.git.commits.length > 0);
  engine.cancel(id);
  assert.ok(await waitFor(() => settled.length === 1));
  assert.ok(fs.existsSync(wt), "kept after cancel");
  // lose the directory behind git's back
  fs.rmSync(wt, { recursive: true, force: true });
  let out;
  assert.ok(await waitFor(() => (out = engine.resume(id)).ok), out?.error);
  assert.ok(await waitFor(() => settled.length === 2), `status=${st.status}`);
  assert.strictEqual(st.status, "completed", st.error);
  assert.ok(events.some((e) => /worktree re-attached/.test(e.s ?? "")), "re-add announced");
  assert.ok(g(["ls-files"]).includes("src/health/controller.ts"), "the milestone commit survived and merged");
  assert.ok(!fs.existsSync(wt), "removed again after the merge");
  // a failed run WITH unmerged commits: removeWorktree drops the worktree, prunes, keeps the branch (safe -d refuses)
  stepStores.clear(); openCalls.length = 0;
  const scripts2 = { build: [async (ctx) => { writeDeclared(ctx.cwd); fs.writeFileSync(path.join(ctx.cwd, "README.md"), "second run\n"); await happyBuild(ctx); }], verify: [async () => { throw new Error("boom"); }] };
  const e2 = mkEngine(scripts2);
  const settled2 = [];
  const id2 = `wt-del-${Date.now()}`;
  const st2 = await startRun(e2, id2, { path: repo, git: true, onSettled: (x) => settled2.push(x) });
  assert.ok(await waitFor(() => settled2.length === 1));
  assert.strictEqual(st2.status, "failed");
  assert.ok(fs.existsSync(st2.git.worktree), "failed run keeps its worktree");
  assert.deepStrictEqual(await e2.removeWorktree(id2), { ok: true, removed: true, keptBranch: st2.git.runBranch, reason: "unmerged" });
  assert.ok(!fs.existsSync(st2.git.worktree));
  assert.strictEqual(gitIn(repo, ["worktree", "list"]).trim().split("\n").length, 1, "worktree unregistered");
  assert.ok(g(["branch", "--list", st2.git.runBranch]).trim(), "the unmerged branch is kept");
  // a failed run with NOTHING unmerged: the branch is deleted (safe -d)
  stepStores.clear(); openCalls.length = 0;
  const e3 = mkEngine({ build: [async () => { throw new Error("boom"); }] });
  const settled3 = [];
  const id3 = `wt-del2-${Date.now()}`;
  const st3 = await startRun(e3, id3, { path: repo, git: true, onSettled: (x) => settled3.push(x) });
  assert.ok(await waitFor(() => settled3.length === 1));
  const out3 = await e3.removeWorktree(id3);
  assert.strictEqual(out3.deletedBranch, st3.git.runBranch);
  assert.ok(!g(["branch", "--list", st3.git.runBranch]).trim(), "fully-merged (empty) branch deleted with -d");
  cleanup(repo);
});

await test("worktree: a dirty owner checkout at start no longer blocks; git-off runs keep cwd == project path; detached HEAD is refused", async () => {
  stepStores.clear(); openCalls.length = 0;
  const { repo, g } = mkRepo();
  fs.writeFileSync(path.join(repo, "README.md"), "owner edit in progress\n"); // tracked + modified
  const eng = mkEngine({ build: [async () => { await new Promise(() => {}); }] });
  const settledD = [];
  const st = await startRun(eng, `wt-dirty-${Date.now()}`, { path: repo, git: true, onSettled: (x) => settledD.push(x) });
  assert.ok(st.git.worktree && fs.existsSync(st.git.worktree), "run started on a dirty checkout");
  assert.strictEqual(g(["status", "--porcelain"]).trim(), "M README.md", "owner's edit untouched");
  eng.cancel(st.id);
  assert.ok(await waitFor(() => settledD.length === 1));
  // git off: unchanged behaviour
  stepStores.clear(); openCalls.length = 0;
  await runEngine({ scripts: { build: [happyBuild], verify: [happyVerify] } });
  assert.ok(openCalls.length >= 2 && openCalls.every((c) => c.cwd === FIXTURE), "git-off runs keep cwd = project path");
  // detached HEAD: no base branch to merge into
  g(["checkout", "-q", "--detach"]);
  await assert.rejects(() => startRun(mkEngine({}), `wt-det-${Date.now()}`, { path: repo, git: true }), /detached HEAD/);
  cleanup(repo);
});

await test("#14: a missing submit_audit is never a pass — nudged once, then the audit step fails", async () => {
  stepStores.clear(); openCalls.length = 0;
  // (a) never calls submit_audit
  let scripts = {
    build: [happyBuild],
    verify: [async ({ tools }) => { await callTool(tools, "submit_verify", verifyArtifact(true)); }],
  };
  let r = await runEngine({ scripts });
  assert.strictEqual(r.state.status, "failed", "accepted verify + absent audit must not complete");
  assert.match(r.state.error ?? "", /audit step failed/);
  assert.ok(stepStores.get("verify").prompts.some((p) => /AUDIT phase is owed/.test(p)), "nudged once");
  // (b) the nudge works
  stepStores.clear(); openCalls.length = 0;
  scripts = {
    build: [happyBuild],
    verify: [
      async ({ tools }) => { await callTool(tools, "submit_verify", verifyArtifact(true)); },
      async ({ tools }) => { await callTool(tools, "submit_audit", auditArtifact(false)); },
    ],
  };
  r = await runEngine({ scripts });
  assert.strictEqual(r.state.status, "completed", r.state.error);
  assert.strictEqual(r.state.artifacts.audit.verdict, "accepted");
});

await test("#15: verifier system prompt has no undefined skill paths; #dispose: every session is closed when the run ends", async () => {
  stepStores.clear(); openCalls.length = 0;
  const { state } = await runEngine({ scripts: { build: [happyBuild], verify: [happyVerify] } });
  assert.strictEqual(state.status, "completed", state.error);
  const vsp = openCalls.find((c) => c.stepId === "verify").systemPrompt;
  assert.ok(!/undefined/.test(vsp), "no 'undefined' in the verifier system prompt");
  assert.match(vsp, /audit-deliverables\/SKILL\.md/);
  assert.ok(openCalls.length >= 2 && openCalls.every((c) => c.handle.closed), "build + verify sessions were disposed");
  assert.ok(openCalls.every((c) => typeof c.runId === "string" && c.runId), "sessions are tagged with the run id (prockill scoping)");
});

await test("#12/#13: plan-gate resume — reject-with-comments revises without a 'fix:' commit label; approved plan is not re-planned", async () => {
  stepStores.clear(); openCalls.length = 0;
  const { repo, g } = mkRepo();
  let planCalls = 0;
  const scripts = {
    build: [
      async ({ tools }) => { planCalls += 1; await callTool(tools, "submit_plan", PLAN); }, // cancelled at the gate
      async ({ tools, text, cwd }) => {
        assert.match(text, /REJECTED your plan: add a timeout/);
        planCalls += 1;
        writeDeclared(cwd);
        assert.match(await callTool(tools, "submit_plan", { ...PLAN, approach: "revised" }), /APPROVED/);
        await callTool(tools, "submit_tasks", TASKS);
        await callTool(tools, "submit_impl_delta", IMPL_DELTA);
      },
    ],
    verify: [happyVerify],
  };
  const emit = noopEmit();
  const engine = mkEngine(scripts, { emit });
  const id = `n13-${Date.now()}`;
  const st = await startRun(engine, id, { path: repo, git: true, approvePlan: true });
  await waitFor(() => st.gate?.type === "plan-approval");
  engine.gate(id, "cancel");
  await waitFor(() => st.status === "cancelled");
  let out;
  assert.ok(await waitFor(() => (out = engine.resume(id)).ok), out?.error);
  await waitFor(() => st.gate?.type === "plan-approval" && st.status === "awaiting-gate");
  engine.gate(id, "reject", "add a timeout");
  await waitFor(() => st.gate?.type === "plan-approval" && st.artifacts.plan?.approach === "revised");
  engine.gate(id, "approve");
  assert.ok(await waitFor(() => TERMINAL.includes(st.status)), `status=${st.status}`);
  assert.strictEqual(st.status, "completed", st.error);
  assert.strictEqual(planCalls, 2, "one original plan + one revision");
  const subjects = g(["log", "--format=%s", "-8"]);
  assert.match(subjects, /feat: /, "first implementation commit is labelled feat:");
  assert.doesNotMatch(subjects, /fix: /, "plan rejection is not a fix round");
  cleanup(repo);
});

await test("#18: unanswered clarify questions survive a restart — re-presented with zero model turns", async () => {
  stepStores.clear(); openCalls.length = 0;
  const qs = [{ id: "q1", question: "Which DB?", why: "storage", options: [], recommended: null }];
  let clarifyTurns = 0;
  const askRunNode = async (opts) => {
    if (opts.nodeId !== "clarify") return;
    clarifyTurns += 1;
    await (opts.customTools ?? []).find((t) => t.name === "ask_questions")?.execute("x", { questions: qs });
  };
  const e1 = mkEngine({}, { adapters: { runNode: askRunNode } });
  const id = `n18-${Date.now()}`;
  const st = await startRun(e1, id, { clarify: true });
  await waitFor(() => st.status === "awaiting-answers");
  assert.strictEqual(st.gate?.type, "answers");
  // simulate the server dying here: only state.json survives, status marked interrupted
  const onDisk = JSON.parse(JSON.stringify(st));
  onDisk.status = "interrupted";
  fs.mkdirSync(runDir(id), { recursive: true });
  fs.writeFileSync(path.join(runDir(id), "state.json"), JSON.stringify(onDisk));
  const turnsBefore = clarifyTurns;
  const latest = { s: null };
  const e2 = mkEngine({}, {
    emit: { state: (run) => { latest.s = run.state; }, event: () => {} },
    adapters: {
      runNode: async (opts) => {
        if (opts.nodeId !== "clarify") return;
        clarifyTurns += 1;
        await (opts.customTools ?? []).find((t) => t.name === "finalize_spec")?.execute("x", { summary: "s", decisions: [], acceptance_criteria: ["AC"] });
      },
    },
  });
  const out = e2.resumeFromDisk(id, { name: "sandbox", path: FIXTURE });
  assert.ok(out.ok, out.error);
  await waitFor(() => latest.s?.status === "awaiting-answers");
  assert.deepStrictEqual(latest.s.gate?.questions, qs, "the SAME pending questions are re-presented");
  assert.strictEqual(clarifyTurns, turnsBefore, "no model turn was spent re-asking");
  assert.strictEqual(e2.answer(id, { q1: "Postgres" }), true);
  await waitFor(() => latest.s.artifacts.spec);
  assert.ok(latest.s.artifacts.spec, "run continued after the answer");
  e2.cancel(id);
  fs.rmSync(runDir(id), { recursive: true, force: true });
});

await test("#16: a security fix that breaks verification fails the run (no unverified code ships)", async () => {
  stepStores.clear(); openCalls.length = 0;
  const finding = { verdict: "findings", findings: [{ id: "s1", source: "scanner", severity: "critical", title: "secret in .env", evidence: "x", file: ".env:1", fix: "remove", fixable_in_scope: true }] };
  const scripts = {
    build: [happyBuild, async ({ tools }) => { await callTool(tools, "submit_impl_delta", { ...IMPL_DELTA, notes: "security fix" }); }],
    verify: [happyVerify, async ({ tools }) => { await callTool(tools, "submit_verify", verifyArtifact(false)); }],
    security: [async ({ tools }) => { await callTool(tools, "submit_security", finding); }],
  };
  const { state } = await runEngine({ scripts, security: "scan", maxFixRounds: 0 });
  assert.strictEqual(state.status, "failed", state.error);
  assert.match(state.error ?? "", /verification failed after the security fix round/);
  assert.notStrictEqual(state.artifacts.security?.verdict, "pass");
});

await test("E-6: the scanner suite is async and abortable (never blocks the event loop)", async () => {
  const empty = fs.mkdtempSync("/tmp/nano-scan-");
  let ticks = 0;
  const timer = setInterval(() => (ticks += 1), 5);
  const ac = new AbortController();
  const p = runScannerSuite({ projectPath: empty }, ac.signal);
  setTimeout(() => ac.abort(), 30);
  const res = await p;
  clearInterval(timer);
  assert.ok(ticks >= 3, `event loop kept turning during the scan (ticks=${ticks})`);
  assert.ok(Array.isArray(res.scanners) && res.scanners.length >= 1, "always returns a structured result");
  const pre = new AbortController();
  pre.abort();
  const res2 = await runScannerSuite({ projectPath: empty }, pre.signal);
  assert.match(res2.scanners[0].evidence, /aborted/);
  cleanup(empty);
});

// --- summary ---------------------------------------------------------------------------

const failed = results.filter(([, ok]) => !ok);
console.log(`\n${results.length - failed.length}/${results.length} engine scenarios passed`);
fs.rmSync(FIXTURE, { recursive: true, force: true });
process.exit(failed.length ? 1 : 0);
