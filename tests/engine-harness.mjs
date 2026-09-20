// Engine unit harness — drives createEngine with fake step sessions (the plan's
// Phase 6 "done when"). Run: node tests/engine-harness.mjs
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert";
import { createEngine } from "../host/engine.mjs";

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

// --- harness ------------------------------------------------------------------------

async function runEngine({ scripts, autoGate = ["approve"], mechanical, security = "off", approvePlan = true, maxFixRounds = 2, project = "sandbox", adaptersOverride }) {
  const events = [];
  const state = { latest: null };
  const emit = {
    state: (run) => {
      state.latest = run.state;
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
      runNode: adaptersOverride?.runNode ?? (async () => {}),
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
  });
  const deadline = Date.now() + 20_000;
  while (!["completed", "failed", "cancelled"].includes(st.status) && Date.now() < deadline) {
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
    console.log(`FAIL  ${name}\n      ${String(e?.message ?? e).split("\n")[0]}`);
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
  const scripts = {
    build: [
      async ({ tools }) => {
        const t = await callTool(tools, "submit_plan", PLAN);
        if (/cancelled/i.test(t)) return;
        await callTool(tools, "submit_tasks", TASKS);
        await callTool(tools, "submit_impl_delta", IMPL_DELTA);
      },
      // turn 1 = the resumed run's re-driven initial turn (context intact, plan re-submitted)
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
  const buildOpens = openCalls.filter((c) => c.stepId === "build");
  assert.strictEqual(buildOpens.length, 2, "build session reopened on resume");
  assert.strictEqual(buildOpens[1].resumed, true, "reopened FROM the persisted session file");
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

// --- summary ---------------------------------------------------------------------------

const failed = results.filter(([, ok]) => !ok);
console.log(`\n${results.length - failed.length}/${results.length} engine scenarios passed`);
fs.rmSync(FIXTURE, { recursive: true, force: true });
process.exit(failed.length ? 1 : 0);
