// Queue manager unit tests — v3 + v3.1 (single-PM waves). Run: node tests/queue.test.mjs
import { tickets as TICKETS_DIR, runs as RUNS_DIR } from "./_test-dirs.mjs"; // FIRST: isolate stores
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert";
import { createQueueManager } from "../host/queue.mjs";

const results = [];
const test = async (name, fn) => {
  try { await fn(); results.push([name, true]); console.log(`PASS  ${name}`); }
  catch (e) { results.push([name, false]); console.log(`FAIL  ${name}\n      ${String(e?.message ?? e).split("\n").slice(0, 8).join("\n      ")}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const store = async (project) => (await import("../host/tickets.mjs")).loadTickets(project);

// Fixture helper: a run state on disk (the source of truth the queue reads).
function seedRunState(runId, state) {
  fs.mkdirSync(path.join(RUNS_DIR, runId), { recursive: true });
  fs.writeFileSync(path.join(RUNS_DIR, runId, "state.json"), JSON.stringify({ id: runId, status: "clarified", ...state }));
}

// A wave fixture: run state on disk with per-ticket specs (v3.1 wave shape).
function seedWaveRun(runId, specsByTicket, extra = {}) {
  seedRunState(runId, {
    wave: { ticketIds: Object.keys(specsByTicket) },
    artifacts: { specs: Object.fromEntries(Object.entries(specsByTicket).map(([id, s]) => [id, typeof s === "string" ? { summary: s, decisions: [], acceptance_criteria: [`AC ${id}`] } : s])) },
    ...extra,
  });
}

function fakeEngine() {
  const runs = new Map();
  const gateCancels = [];
  const starts = []; // every engine.start opts — the queue now SEEDS builds
  const disk = new Map(); // runId -> { status } — what a restart left behind
  return {
    runs,
    gateCancels,
    starts,
    disk,
    async start(opts) {
      starts.push(opts);
      const r = { id: opts.id, opts, status: "running", holdsTree: opts.clarify === false, settled: false };
      runs.set(opts.id, r);
      return { id: opts.id, status: "running" };
    },
    resume(id) {
      const r = runs.get(id);
      if (!r) return { ok: false, error: "run not active in this server session" };
      if (!["cancelled", "failed"].includes(r.status)) {
        return { ok: false, error: `only cancelled or failed runs can be resumed (status ${r.status})` };
      }
      r.status = "running";
      r.settled = false;
      return { ok: true };
    },
    // mirrors the real engine's restart recovery
    resumeFromDisk(id, project, opts = {}) {
      if (runs.has(id)) return { ok: false, error: "run is still active in this server session" };
      const d = disk.get(id);
      if (!d) return { ok: false, error: "unknown run (no state on disk)" };
      if (!["cancelled", "failed", "interrupted"].includes(d.status)) return { ok: false, error: `run status is "${d.status}"` };
      const holder = [...runs.values()].find((x) => x.holdsTree && !x.settled);
      if (holder) return { ok: false, error: `the working tree is held by run ${holder.id}` };
      runs.set(id, { id, status: "running", holdsTree: true, settled: false, opts: { onSettled: opts.onSettled ?? (() => {}) } });
      return { ok: true };
    },
    treeLockHolder() {
      for (const r of runs.values()) if (r.holdsTree && !r.settled) return r.id;
      return null;
    },
    gate(id, action) {
      gateCancels.push([id, action]);
      const r = runs.get(id);
      if (r && !r.settled) {
        r.settled = true;
        r.status = "cancelled";
        queueMicrotask(() => r.opts.onSettled?.("cancelled"));
      }
    },
    async finishBuild(id, status) {
      const r = runs.get(id);
      r.settled = true;
      r.status = status;
      r.holdsTree = false;
      await r.opts.onSettled?.(status);
      await sleep(20);
    },
    // a clarify-stage (wave) run settles — same mechanics, distinct name for readability
    async settleWave(runId, status) {
      const r = runs.get(runId);
      r.settled = true;
      r.status = status;
      await r.opts.onSettled?.(status);
      await sleep(20);
    },
  };
}

function makeManager(engine, projectDir) {
  const snapshots = [];
  const emitter = {
    state: (run) => {}, // replaced by the manager's watcher wrapper
    event: () => {},
  };
  const mgr = createQueueManager({
    engine,
    emit: emitter,
    resolveProject: (name) => ({ name, path: projectDir ?? "/tmp/does-not-exist" }),
    git: {},
    broadcast: (msg) => { if (msg.type === "queue") snapshots.push(msg.state); },
  });
  return { mgr, snapshots, emitter };
}

async function seedProject(project, tickets, queueState = "idle") {
  fs.mkdirSync(TICKETS_DIR, { recursive: true });
  const full = tickets.map((t, i) => ({
    sourceDoc: null, runId: null, blockedReason: null, status: "draft",
    dependsOn: [], order: i, history: [],
    createdAt: `2026-01-01T00:00:0${i}Z`, updatedAt: null,
    ...t,
  }));
  fs.writeFileSync(path.join(TICKETS_DIR, `${project}.json`), JSON.stringify({
    project, config: { models: {}, options: {} }, tickets: full, queue: { state: queueState },
  }, null, 2));
}

// --- Q1: wave — ONE run for the whole batch --------------------------------------

await test("Q1: a wave starts ONE PM run; settling it clarifies every ticket", async () => {
  const engine = fakeEngine();
  const { mgr } = makeManager(engine, null);
  await seedProject("q1", [
    { id: "F0", title: "zero", description: "d0", status: "done" },
    { id: "F1", title: "one", description: "d1", dependsOn: ["F0"] },
    { id: "F2", title: "two", description: "d2", dependsOn: ["F1"] },
    { id: "F3", title: "three", description: "d3" },
  ]);
  const out = await mgr.startClarifyWave("q1", ["F1", "F2", "F3"]);
  assert.strictEqual(out.ok, true, JSON.stringify(out.errors ?? out));
  assert.strictEqual(engine.starts.length, 1, "exactly one engine.run for the wave");
  const opts = engine.starts[0];
  assert.deepStrictEqual(opts.waveTickets.map((t) => t.id), ["F1", "F2", "F3"]);
  assert.ok(opts.stopAfterClarify && opts.clarify, "wave runs clarify-only");
  assert.match(opts.task, /WAVE of 3 feature/);
  assert.match(opts.task, /F0 — zero/, "brief lists built features");
  assert.match(opts.task, /Depends on F0 \(already built\)/, "dependency context marks built deps");
  assert.match(opts.task, /F1 — one[\s\S]*F2 — two[\s\S]*F3 — three/, "brief lists wave features");
  const st = await store("q1");
  const waveRunId = st.tickets.find((t) => t.id === "F1").runId;
  assert.ok(st.tickets.filter((t) => t.id !== "F0").every((t) => t.status === "clarifying" && t.runId === waveRunId), "all WAVE tickets clarifying on the one wave run");
  assert.strictEqual(st.tickets.find((t) => t.id === "F0").status, "done", "done tickets untouched");
  assert.strictEqual(st.queue.state, "clarifying");
  await engine.settleWave(waveRunId, "clarified");
  const st2 = await store("q1");
  assert.ok(st2.tickets.filter((t) => t.id !== "F0").every((t) => t.status === "clarified" && t.runId === waveRunId), "settle → all clarified");
  assert.strictEqual(st2.queue.state, "awaiting-release");
});

// --- Q2: release → sequential SEEDED builds ---------------------------------------

await test("Q2: release seeds one build run per ticket, sequentially, each with its wave spec", async () => {
  const engine = fakeEngine();
  const { mgr } = makeManager(engine, null);
  const waveRunId = "run-q2-wave";
  await seedProject("q2", [
    { id: "F1", title: "one", description: "d", status: "clarified", runId: waveRunId },
    { id: "F2", title: "two", description: "d", status: "clarified", runId: waveRunId },
    { id: "F3", title: "three", description: "d", status: "clarified", runId: waveRunId },
  ], "awaiting-release");
  seedWaveRun(waveRunId, { F1: "spec one", F2: "spec two", F3: "spec three" });
  const rel = mgr.release("q2");
  assert.strictEqual(rel.released, 3);
  await sleep(30);
  assert.strictEqual(engine.starts.length, 1, "pump promotes only the first; next on settle");
  assert.strictEqual(engine.starts[0].ticketId, "F1");
  assert.strictEqual(engine.starts[0].seedSpec.summary, "spec one", "build seeded with ITS ticket's spec");
  assert.strictEqual(engine.starts[0].clarify, false);
  const st = await store("q2");
  const f1BuildRunId = st.tickets.find((t) => t.id === "F1").runId;
  assert.notStrictEqual(f1BuildRunId, waveRunId, "ticket now points at its BUILD run (D4)");
  await engine.finishBuild(f1BuildRunId, "completed");
  await sleep(10);
  assert.strictEqual(engine.starts.length, 2, "F2 builds after F1 settles");
  assert.strictEqual(engine.starts[1].ticketId, "F2");
  assert.strictEqual(engine.starts[1].seedSpec.summary, "spec two");
  await engine.finishBuild(engine.starts[1].id, "completed");
  await engine.finishBuild(engine.starts[2].id, "completed");
  const st2 = await store("q2");
  assert.ok(st2.tickets.every((t) => t.status === "done"));
  assert.strictEqual(st2.queue.state, "idle");
});

// --- Q3: park + cascade ----------------------------------------------------------

await test("Q3: divergence gate parks the ticket; dependents cascade; independent proceeds", async () => {
  const engine = fakeEngine();
  const { mgr, emitter } = makeManager(engine, null);
  const waveRunId = "run-q3-wave";
  await seedProject("q3", [
    { id: "F1", title: "one", description: "d", status: "clarified", runId: waveRunId },
    { id: "F2", title: "two", description: "d", dependsOn: ["F1"], status: "clarified", runId: waveRunId },
    { id: "F3", title: "three", description: "d", status: "clarified", runId: waveRunId },
  ], "awaiting-release");
  seedWaveRun(waveRunId, { F1: "s1", F2: "s2", F3: "s3" });
  mgr.release("q3");
  await sleep(30);
  assert.strictEqual(engine.starts.length, 1);
  const f1BuildRunId = engine.starts[0].id;
  // F1's promoted build opens a divergence gate → watcher parks + cancels
  emitter.state({ id: f1BuildRunId, state: { status: "awaiting-gate", gate: { type: "divergence" }, ticketId: "F1", project: "q3" } });
  await sleep(40);
  const st = await store("q3");
  const byId = Object.fromEntries(st.tickets.map((t) => [t.id, t]));
  assert.strictEqual(byId.F1.status, "blocked");
  assert.strictEqual(byId.F1.blockedReason, "stale-spec");
  assert.strictEqual(byId.F2.status, "blocked", "dependent cascades to blocked");
  assert.match(byId.F2.blockedReason, /depends on F1/);
  assert.strictEqual(byId.F3.status, "running", "independent ticket proceeds after the park settles");
  assert.strictEqual(engine.gateCancels.length, 1, "parked run cancelled (branch/session kept)");
});

// --- Q4: recovery -----------------------------------------------------------------

await test("Q4: recovery — interrupted BUILD runs requeue AND resume; clarify runs go back to draft", async () => {
  const engine = fakeEngine();
  const { mgr } = makeManager(engine, null);
  const buildRunId = `recover-${Date.now()}`;
  const waveRunId = `wrec-${Date.now()}`;
  seedRunState(buildRunId, { status: "interrupted", artifacts: { implDelta: { summary: "partial" } } }); // build was under way
  seedWaveRun(waveRunId, { F2: "s2" }, { status: "interrupted" }); // the wave itself was interrupted mid-clarify
  engine.disk.set(buildRunId, { status: "interrupted" });
  await seedProject("q4", [
    { id: "F1", title: "t", description: "d", runId: buildRunId, status: "running" },
    { id: "F2", title: "u", description: "d", runId: waveRunId, status: "clarifying" },
  ], "running");
  mgr.recoverProject("q4");
  const st = await store("q4");
  assert.strictEqual(st.tickets[0].status, "running", "interrupted build requeued AND auto-resumed by the pump");
  assert.strictEqual(st.tickets[0].runId, buildRunId, "resumed in place — milestones kept, never re-seeded");
  assert.strictEqual(st.tickets[1].status, "draft", "clarify-stage runs go back to draft for a re-wave");
  assert.strictEqual(engine.starts.length, 0, "no NEW run started for the resumed build");
});

// --- Q5: backlog flip -------------------------------------------------------------

await test("Q5: backlog flip on completion (file write, commit skipped without a repo)", async () => {
  const projDir = fs.mkdtempSync("/tmp/nano-queue-flip-");
  fs.mkdirSync(path.join(projDir, "docs"), { recursive: true });
  fs.writeFileSync(path.join(projDir, "docs", "features.md"), "## F1 — thing 🔴\nbody\n");
  const engine = fakeEngine();
  const { mgr } = makeManager(engine, projDir);
  const waveRunId = "flip-wave";
  await seedProject("q5", [
    { id: "F1", title: "thing", description: "d", sourceDoc: "docs/features.md", status: "queued", runId: waveRunId },
  ], "running");
  seedWaveRun(waveRunId, { F1: "s1" });
  mgr.pump("q5"); // seeds the build run
  await sleep(20);
  const buildRunId = engine.starts[0].id;
  await engine.finishBuild(buildRunId, "completed");
  const doc = fs.readFileSync(path.join(projDir, "docs", "features.md"), "utf8");
  assert.ok(doc.includes("🟢"), "status flipped to done");
  fs.rmSync(projDir, { recursive: true, force: true });
});

// --- Q6: release after a restart (the wave run exists only on disk) ---------------

await test("Q6: release after a restart — seeded builds from the wave run's on-disk specs", async () => {
  const engine = fakeEngine();
  const { mgr } = makeManager(engine, null);
  // the wave ran BEFORE the restart — no in-memory run, only state.json
  const waveRunId = "run-q6-wave";
  seedWaveRun(waveRunId, { F1: "disk spec 1", F2: "disk spec 2" });
  await seedProject("q6", [
    { id: "F1", title: "one", description: "d", status: "clarified", runId: waveRunId },
    { id: "F2", title: "two", description: "d", status: "clarified", runId: waveRunId },
  ], "awaiting-release");
  const rel = mgr.release("q6");
  assert.strictEqual(rel.released, 2);
  await sleep(30);
  assert.strictEqual(engine.starts.length, 1);
  assert.strictEqual(engine.starts[0].seedSpec.summary, "disk spec 1", "spec read from the on-disk wave run");
  await engine.finishBuild(engine.starts[0].id, "completed");
  await engine.finishBuild(engine.starts[1].id, "completed");
  const st = await store("q6");
  assert.ok(st.tickets.every((t) => t.status === "done"), "restarts never strand the queue");
  assert.strictEqual(st.queue.state, "idle");
});

// --- Q7: retry re-enters the queue loop (build-phase park) -------------------------

await test("Q7: retry resumes a parked BUILD run from disk and the queue learns the settle", async () => {
  const engine = fakeEngine();
  const { mgr } = makeManager(engine, null);
  const buildRunId = `run-q7-${Date.now()}`;
  seedRunState(buildRunId, { status: "failed", artifacts: { implDelta: { summary: "x" } } }); // build-phase park
  await seedProject("q7", [
    { id: "F1", title: "one", description: "d", status: "blocked", blockedReason: "gates-exhausted", runId: buildRunId },
  ], "idle");
  engine.disk.set(buildRunId, { status: "failed" });
  const out = mgr.retry("q7", "F1");
  assert.strictEqual(out.ok, true, out.error);
  assert.ok(engine.runs.has(buildRunId), "run controller rebuilt with the queue's settle callback");
  await sleep(10);
  await engine.finishBuild(buildRunId, "completed");
  const st = await store("q7");
  assert.strictEqual(st.tickets[0].status, "done", "the retried run's settle reached the queue");
});

await test("Q7b: retry on a clarify-stage park points at re-clarify", async () => {
  const engine = fakeEngine();
  const { mgr } = makeManager(engine, null);
  const waveRunId = "run-q7b-wave";
  seedWaveRun(waveRunId, { F1: "s1" });
  await seedProject("q7b", [
    { id: "F1", title: "one", description: "d", status: "blocked", blockedReason: "stale-spec", runId: waveRunId },
  ], "idle");
  const out = mgr.retry("q7b", "F1");
  assert.strictEqual(out.ok, false);
  assert.match(out.error, /re-clarify/);
});

// --- Q8: the dependency cascade reverses on completion ---------------------------

await test("Q8: completing a blocked ticket un-blocks its dependents (the cascade reverses)", async () => {
  const engine = fakeEngine();
  const { mgr } = makeManager(engine, null);
  const f1Run = `run-q8-f1-${Date.now()}`;
  const f2Wave = "run-q8-wave";
  seedRunState(f1Run, { status: "failed", artifacts: { implDelta: { summary: "x" } } });
  seedWaveRun(f2Wave, { F2: "s2", F3: "s3" });
  await seedProject("q8", [
    { id: "F1", title: "one", description: "d", status: "blocked", blockedReason: "gates-exhausted", runId: f1Run },
    { id: "F2", title: "two", description: "d", dependsOn: ["F1"], status: "blocked", blockedReason: "depends on F1", runId: f2Wave },
    { id: "F3", title: "three", description: "d", status: "blocked", blockedReason: "stale-spec", runId: f2Wave },
  ], "idle");
  engine.disk.set(f1Run, { status: "failed" });
  const out = await mgr.retry("q8", "F1");
  assert.strictEqual(out.ok, true, out.error);
  await sleep(10);
  await engine.finishBuild(f1Run, "completed");
  const st = await store("q8");
  const byId = Object.fromEntries(st.tickets.map((t) => [t.id, t]));
  assert.strictEqual(byId.F1.status, "done");
  assert.strictEqual(byId.F2.status, "running", "dependency-blocked dependent requeued AND pumped once the blocker completed");
  assert.strictEqual(byId.F2.blockedReason, null);
  assert.strictEqual(byId.F3.status, "blocked", "own-gate blocks stay parked for the owner");
  assert.strictEqual(byId.F3.blockedReason, "stale-spec");
  await engine.finishBuild(engine.starts.find((s) => s.ticketId === "F2").id, "completed");
  const st2 = await store("q8");
  assert.ok(st2.tickets.filter((t) => t.id !== "F3").every((t) => t.status === "done"));
  assert.strictEqual(st2.queue.state, "idle", "blocked-but-not-pumpable work parks the TICKET, never the queue");
});

// --- Q9: flip guard — never write the doc while a run holds the tree -------------

await test("Q9: backlog flip skipped while another run holds the tree (the doc stays untouched)", async () => {
  const projDir = fs.mkdtempSync("/tmp/nano-queue-flip2-");
  fs.mkdirSync(path.join(projDir, "docs"), { recursive: true });
  fs.writeFileSync(path.join(projDir, "docs", "features.md"), "## F1 — thing 🔴\nbody\n");
  const engine = fakeEngine();
  const { mgr } = makeManager(engine, projDir);
  const waveRunId = "flip9-wave";
  await seedProject("q9", [
    { id: "F1", title: "thing", description: "d", sourceDoc: "docs/features.md", status: "queued", runId: waveRunId },
  ], "running");
  seedWaveRun(waveRunId, { F1: "s1" });
  mgr.pump("q9"); // seeds the build run (tree free at pump time)
  await sleep(20);
  const buildRunId = engine.starts[0].id;
  // a direct run grabs the tree before the build settles
  engine.runs.set("direct-run", { id: "direct-run", status: "running", holdsTree: true, settled: false, opts: {} });
  await engine.finishBuild(buildRunId, "completed");
  const doc = fs.readFileSync(path.join(projDir, "docs", "features.md"), "utf8");
  assert.ok(doc.includes("🔴"), "flip skipped — the doc was NOT written into the direct run's branch");
  assert.ok(!doc.includes("🟢"), "no partial flip");
  fs.rmSync(projDir, { recursive: true, force: true });
});

// --- Q10: re-clarify seeding (spec fallback + park reason) -------------------------

await test("Q10: re-clarify is a single-ticket wave seeded with the old spec + park reason", async () => {
  const engine = fakeEngine();
  const { mgr } = makeManager(engine, null);
  const waveRunId = `recl-${Date.now()}`;
  seedWaveRun(waveRunId, { F1: "old summary spec" });
  await seedProject("q10", [
    { id: "F1", title: "one", description: "d", status: "blocked", blockedReason: "stale-spec", runId: waveRunId },
  ], "idle");
  const out = await mgr.reclarify("q10", "F1");
  assert.strictEqual(out.ok, true, JSON.stringify(out.errors ?? out));
  await sleep(20);
  assert.strictEqual(engine.starts.length, 1);
  const opts = engine.starts[0];
  assert.deepStrictEqual(opts.waveTickets.map((t) => t.id), ["F1"]);
  assert.match(opts.task, /RE-CLARIFICATION CONTEXT/);
  assert.match(opts.task, /stale-spec/);
  assert.match(opts.task, /old summary spec/, "seed reads the PER-TICKET spec from the wave run (D6 fallback)");
});

await test("Q11: a wave whose starts fail can't stick the queue at 'clarifying'", async () => {
  const engine = fakeEngine();
  const { mgr } = makeManager(engine, null);
  await seedProject("q11", [
    { id: "F1", title: "one", description: "d", status: "done" },
  ], "idle");
  const out = await mgr.startClarifyWave("q11", ["F1"]); // done tickets can't clarify
  assert.strictEqual(out.ok, false);
  await sleep(10);
  assert.strictEqual((await store("q11")).queue.state, "idle", "state advanced instead of sticking");
});

// --- Q12: failed-build classification from the run's error record ------------------

await test("Q12: gates failures vs provider failures classify differently (§2.4)", async () => {
  const engine = fakeEngine();
  const { mgr } = makeManager(engine, null);
  const waveRunId = "run-q12-wave";
  await seedProject("q12", [
    { id: "F1", title: "gates", description: "d", status: "queued", runId: waveRunId },
    { id: "F2", title: "provider", description: "d", status: "queued", runId: waveRunId },
  ], "running");
  seedWaveRun(waveRunId, { F1: "s1", F2: "s2" });
  const aRun = `run-q12-a-${Date.now()}`;
  const bRun = `run-q12-b-${Date.now()}`;
  seedRunState(aRun, { status: "failed", error: "gates still failing after 2 fix round(s): verify: 1 failing check(s)" });
  seedRunState(bRun, { status: "failed", error: "provider stall detected — aborting the session" });
  mgr.pump("q12"); // seeds F1's build
  await sleep(20);
  const a = engine.starts.find((s) => s.ticketId === "F1");
  await engine.finishBuild(a.id, "failed");
  // F2's build: rewrite ITS run-state error before failing it
  const f2Dir = path.join(RUNS_DIR, engine.starts.find((s) => s.ticketId === "F2").id);
  fs.mkdirSync(f2Dir, { recursive: true });
  fs.writeFileSync(path.join(f2Dir, "state.json"), JSON.stringify({ status: "failed", error: "provider stall detected — aborting the session" }));
  await engine.finishBuild(engine.starts.find((s) => s.ticketId === "F2").id, "failed");
  const st = await store("q12");
  const byId = Object.fromEntries(st.tickets.map((t) => [t.id, t]));
  assert.strictEqual(byId.F1.blockedReason, "gates-exhausted", "a gate verdict parks as gates-exhausted");
  assert.strictEqual(byId.F2.blockedReason, "provider-failures", "a provider-type error parks as provider-failures");
});

// --- Q13: queue state derives from tickets (re-clarify during a build) ---------

await test("Q13: re-clarify mid-build doesn't corrupt the queue state chip", async () => {
  const engine = fakeEngine();
  const { mgr } = makeManager(engine, null);
  const waveRunId = `run-q13-wave-${Date.now()}`;
  await seedProject("q13", [
    { id: "F1", title: "building", description: "d", status: "queued", runId: waveRunId },
    { id: "F2", title: "parked", description: "d", status: "blocked", blockedReason: "stale-spec", runId: waveRunId },
  ], "running");
  seedWaveRun(waveRunId, { F1: "s1", F2: "s2" });
  mgr.pump("q13"); // F1 build runs
  await sleep(20);
  assert.strictEqual((await store("q13")).tickets[0].status, "running");
  const out = await mgr.reclarify("q13", "F2"); // single-ticket wave
  assert.strictEqual(out.ok, true, JSON.stringify(out.errors ?? out));
  await engine.settleWave(engine.starts[engine.starts.length - 1].id, "clarified"); // the re-clarify wave settles
  await sleep(20); // → old code flipped the chip to awaiting-release here
  const st = await store("q13");
  assert.strictEqual(st.queue.state, "running", "a build is still in flight — the chip must not say awaiting-release");
  assert.strictEqual(st.tickets.find((t) => t.id === "F2").status, "clarified");
  await engine.finishBuild(engine.starts.find((s) => s.ticketId === "F1").id, "completed");
  const st2 = await store("q13");
  assert.strictEqual(st2.queue.state, "awaiting-release", "builds drained → awaiting-release");
});

// --- Q14: a direct run settling re-pumps a deferred queue -------------------------

await test("Q14: direct run settles → the queue pump that deferred on its tree lock resumes", async () => {
  const engine = fakeEngine();
  const { mgr, emitter } = makeManager(engine, null);
  const waveRunId = "run-q14-wave";
  await seedProject("q14", [
    { id: "F1", title: "one", description: "d", status: "queued", runId: waveRunId },
  ], "running");
  seedWaveRun(waveRunId, { F1: "s1" });
  // a direct run holds the tree — release/pump defers
  engine.runs.set("direct-q14", { id: "direct-q14", status: "running", holdsTree: true, settled: false, opts: {} });
  mgr.pump("q14");
  await sleep(10);
  assert.strictEqual((await store("q14")).tickets[0].status, "queued", "promotion deferred while the direct run holds the tree");
  // the direct run (no ticketId) completes → its terminal state broadcast re-pumps
  // (the real engine releases the tree BEFORE emitting the terminal state)
  const direct = engine.runs.get("direct-q14");
  direct.settled = true;
  direct.holdsTree = false;
  emitter.state({ id: "direct-q14", state: { status: "completed", project: "q14" } });
  await sleep(30);
  const st = await store("q14");
  assert.strictEqual(st.tickets[0].status, "running", "queue seeded a build once the tree freed");
  await engine.finishBuild(engine.starts[0].id, "completed");
  assert.strictEqual((await store("q14")).queue.state, "idle");
});

process.on("exit", () => { try { fs.rmSync(TICKETS_DIR, { recursive: true, force: true }); fs.rmSync(RUNS_DIR, { recursive: true, force: true }); } catch {} });
