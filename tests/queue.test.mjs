// Queue manager unit tests — TODOs 8–10. Run: node tests/queue.test.mjs
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert";
import { createQueueManager } from "../host/queue.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const results = [];
const test = async (name, fn) => {
  try { await fn(); results.push([name, true]); console.log(`PASS  ${name}`); }
  catch (e) { results.push([name, false]); console.log(`FAIL  ${name}\n      ${String(e?.message ?? e).split("\n").slice(0, 8).join("\n      ")}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const store = async (project) => (await import("../host/tickets.mjs")).loadTickets(project);
const saveStore = async (project, s) => (await import("../host/tickets.mjs")).saveTickets(project, s);

function fakeEngine() {
  const runs = new Map();
  const gateCancels = [];
  const promotes = [];
  const disk = new Map(); // runId -> { status } — what a restart leaves behind
  return {
    runs,
    gateCancels,
    promotes,
    disk,
    async start(opts) {
      const r = { id: opts.id, opts, status: "running", holdsTree: !opts.stopAfterClarify, settled: false };
      runs.set(opts.id, r);
      if (opts.stopAfterClarify) {
        r.status = "clarified";
        r.settled = true;
        queueMicrotask(() => opts.onSettled?.("clarified"));
      }
      return { id: opts.id };
    },
    promote(id, onSettled) {
      const r = runs.get(id);
      if (!r) return { ok: false, error: "run not active in this server session" };
      if (r.status !== "clarified") return { ok: false, error: `status ${r.status}` };
      const holder = [...runs.values()].find((x) => x !== r && x.holdsTree && !x.settled);
      if (holder) return { ok: false, error: `the working tree is held by run ${holder.id}` };
      promotes.push(id);
      r.status = "running";
      r.holdsTree = true;
      r.settled = false; // the run is ACTIVE again after promotion (real engine: new done box)
      if (typeof onSettled === "function") r.opts.onSettled = onSettled; // build-phase callback replaces the clarify one
      return { ok: true };
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
    // mirrors the real engine's restart recovery (incl. promote-from-disk)
    resumeFromDisk(id, project, opts = {}) {
      if (runs.has(id)) return { ok: false, error: "run is still active in this server session" };
      const d = disk.get(id);
      if (!d) return { ok: false, error: "unknown run (no state on disk)" };
      const allowed = ["cancelled", "failed", "interrupted", ...(opts.promote ? ["clarified"] : [])];
      if (!allowed.includes(d.status)) return { ok: false, error: `run status is "${d.status}"` };
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
    async failBuildWithGate(id, gateType, project, ticketId) {
      // simulate: a promoted run opens an owner gate (divergence etc.)
      emitState({ id, state: { status: "awaiting-gate", gate: { type: gateType }, ticketId, project } });
    },
  };

  function emitState(run) {
    wrappedEmit?.state(run);
  }
  let wrappedEmit = null;
  // expose the wrapped emitter to tests once the manager installs it
  Object.defineProperty(this, "wrappedEmit", { get: () => wrappedEmit, configurable: true });
  // the manager replaces .state on the object we pass — keep a handle:
  this.setEmitter = (e) => { wrappedEmit = e; };
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
  fs.mkdirSync(path.join(ROOT, "tickets"), { recursive: true });
  const full = tickets.map((t, i) => ({
    sourceDoc: null, runId: null, blockedReason: null, status: "draft",
    dependsOn: [], order: i, history: [],
    createdAt: `2026-01-01T00:00:0${i}Z`, updatedAt: null,
    ...t,
  }));
  fs.writeFileSync(path.join(ROOT, "tickets", `${project}.json`), JSON.stringify({
    project, config: { models: {}, options: {} }, tickets: full, queue: { state: queueState },
  }, null, 2));
}

// --- Q1: wave ------------------------------------------------------------------

await test("Q1: clarify wave — parallel starts, all settle → clarified, awaiting-release", async () => {
  const engine = fakeEngine();
  const { mgr } = makeManager(engine, null);
  await seedProject("q1", [
    { id: "F1", title: "one", description: "d1" },
    { id: "F2", title: "two", description: "d2" },
    { id: "F3", title: "three", description: "d3" },
  ]);
  const out = await mgr.startClarifyWave("q1", ["F1", "F2", "F3"]);
  assert.strictEqual(out.ok, true, JSON.stringify(out.errors ?? out));
  await sleep(20);
  const st = await store("q1");
  assert.ok(st.tickets.every((t) => t.status === "clarified"), JSON.stringify(st.tickets.map((t) => t.status)));
  assert.strictEqual(st.queue.state, "awaiting-release");
  assert.ok(st.tickets.every((t) => t.runId && t.runId.length > 10));
});

// --- Q2: release → sequential pump ---------------------------------------------

await test("Q2: release → sequential pump in order → all done → idle", async () => {
  const engine = fakeEngine();
  const { mgr } = makeManager(engine, null);
  await seedProject("q2", [
    { id: "F1", title: "one", description: "d", status: "clarified", runId: "run-q2-F1" },
    { id: "F2", title: "two", description: "d", status: "clarified", runId: "run-q2-F2" },
    { id: "F3", title: "three", description: "d", status: "clarified", runId: "run-q2-F3" },
  ], "awaiting-release");
  const runIds = Object.fromEntries((await store("q2")).tickets.map((x) => [x.id, x.runId]));
  for (const rid of Object.values(runIds)) {
    engine.runs.set(rid, { id: rid, status: "clarified", holdsTree: false, settled: true, opts: { onSettled: () => {} } });
  }
  const rel = mgr.release("q2");
  assert.strictEqual(rel.released, 3);
  await sleep(20);
  assert.deepStrictEqual(engine.promotes, [runIds.F1], "pump promotes only the first; next on settle");
  await engine.finishBuild(runIds.F1, "completed");
  assert.deepStrictEqual(engine.promotes, [runIds.F1, runIds.F2]);
  await engine.finishBuild(runIds.F2, "completed");
  await engine.finishBuild(runIds.F3, "completed");
  const st = await store("q2");
  assert.ok(st.tickets.every((t) => t.status === "done"));
  assert.strictEqual(st.queue.state, "idle");
});

// --- Q3: park + cascade ----------------------------------------------------------

await test("Q3: divergence gate parks the ticket; dependents cascade; independent proceeds", async () => {
  const engine = fakeEngine();
  const { mgr, emitter } = makeManager(engine, null);
  await seedProject("q3", [
    { id: "F1", title: "one", description: "d", status: "clarified", runId: "run-q3-F1" },
    { id: "F2", title: "two", description: "d", dependsOn: ["F1"], status: "clarified", runId: "run-q3-F2" },
    { id: "F3", title: "three", description: "d", status: "clarified", runId: "run-q3-F3" },
  ], "awaiting-release");
  for (const t of (await store("q3")).tickets) {
    if (t.runId) engine.runs.set(t.runId, { id: t.runId, status: "clarified", holdsTree: false, settled: true, opts: { onSettled: () => {} } });
  }
  mgr.release("q3");
  await sleep(20);
  const f1Run = (await store("q3")).tickets.find((x) => x.id === "F1").runId;
  assert.deepStrictEqual(engine.promotes, [f1Run]);
  const st1 = await store("q3");
  const f1RunId = st1.tickets.find((t) => t.id === "F1").runId;
  // F1's promoted run opens a divergence gate → watcher parks + cancels
  emitter.state({ id: f1RunId, state: { status: "awaiting-gate", gate: { type: "divergence" }, ticketId: "F1", project: "q3" } });
  await sleep(40);
  const st = await store("q3");
  const byId = Object.fromEntries(st.tickets.map((t) => [t.id, t]));
  assert.strictEqual(byId.F1.status, "blocked");
  assert.strictEqual(byId.F1.blockedReason, "stale-spec");
  assert.strictEqual(byId.F2.status, "blocked", "dependent cascades to blocked");
  assert.match(byId.F2.blockedReason, /depends on F1/);
  assert.strictEqual(byId.F3.status, "running", "independent ticket proceeds");
  assert.strictEqual(engine.gateCancels.length, 1, "parked run cancelled (branch/session kept)");
});

// --- Q4: recovery -----------------------------------------------------------------

await test("Q4: recovery — interrupted runs requeue on boot", async () => {
  const engine = fakeEngine();
  const { mgr } = makeManager(engine, null);
  const rid = `recover-${Date.now()}`;
  fs.mkdirSync(path.join(ROOT, "runs", rid), { recursive: true });
  fs.writeFileSync(path.join(ROOT, "runs", rid, "state.json"), JSON.stringify({ id: rid, status: "interrupted" }));
  await seedProject("q4", [
    { id: "F1", title: "t", description: "d", runId: rid, status: "running" },
  ], "running");
  mgr.recoverProject("q4");
  const st = await store("q4");
  assert.strictEqual(st.tickets[0].status, "queued", "interrupted run requeued");
  assert.strictEqual(st.queue.state, "running");
  fs.rmSync(path.join(ROOT, "runs", rid), { recursive: true, force: true });
});

// --- Q5: backlog flip -------------------------------------------------------------

await test("Q5: backlog flip on completion (file write, commit skipped without a repo)", async () => {
  const projDir = fs.mkdtempSync("/tmp/nano-queue-flip-");
  fs.mkdirSync(path.join(projDir, "docs"), { recursive: true });
  fs.writeFileSync(path.join(projDir, "docs", "features.md"), "## F1 — thing 🔴\nbody\n");
  const engine = fakeEngine();
  const { mgr } = makeManager(engine, projDir);
  await seedProject("q5", [
    { id: "F1", title: "thing", description: "d", sourceDoc: "docs/features.md", status: "queued", runId: "flip-run" },
  ], "running");
  engine.runs.set("flip-run", { id: "flip-run", status: "clarified", holdsTree: false, settled: true, opts: { onSettled: () => {} } });
  mgr.pump("q5"); // the QUEUE promotes and registers its own build-settle callback
  await sleep(10);
  await engine.finishBuild("flip-run", "completed");
  const doc = fs.readFileSync(path.join(projDir, "docs", "features.md"), "utf8");
  assert.ok(doc.includes("🟢"), "status flipped to done");
  fs.rmSync(projDir, { recursive: true, force: true });
});

// --- Q6: promote from disk (restart between wave and release) -------------------

await test("Q6: release after a restart promotes clarified runs from disk", async () => {
  const engine = fakeEngine();
  const { mgr } = makeManager(engine, null);
  // the wave ran BEFORE the restart — the runs exist only on disk
  engine.disk.set("run-q6-F1", { status: "clarified" });
  engine.disk.set("run-q6-F2", { status: "clarified" });
  await seedProject("q6", [
    { id: "F1", title: "one", description: "d", status: "clarified", runId: "run-q6-F1" },
    { id: "F2", title: "two", description: "d", status: "clarified", runId: "run-q6-F2" },
  ], "awaiting-release");
  const rel = mgr.release("q6");
  assert.strictEqual(rel.released, 2);
  await sleep(20);
  assert.ok(engine.runs.has("run-q6-F1"), "controller rebuilt from disk (promote fallback)");
  assert.strictEqual((await store("q6")).tickets.find((t) => t.id === "F1").status, "running");
  await engine.finishBuild("run-q6-F1", "completed");
  await engine.finishBuild("run-q6-F2", "completed");
  const st = await store("q6");
  assert.ok(st.tickets.every((t) => t.status === "done"), "queue learned every settle from the disk-resumed runs");
  assert.strictEqual(st.queue.state, "idle");
});

// --- Q7: retry re-enters the queue loop -------------------------------------------

await test("Q7: retry resumes the parked run from disk and the queue learns the settle", async () => {
  const engine = fakeEngine();
  const { mgr } = makeManager(engine, null);
  await seedProject("q7", [
    { id: "F1", title: "one", description: "d", status: "blocked", blockedReason: "gates-exhausted", runId: "run-q7-F1" },
  ], "idle");
  engine.disk.set("run-q7-F1", { status: "failed" }); // parked before the restart
  const out = mgr.retry("q7", "F1");
  assert.strictEqual(out.ok, true, out.error);
  assert.ok(engine.runs.has("run-q7-F1"), "run controller rebuilt with the queue's settle callback");
  await sleep(10);
  await engine.finishBuild("run-q7-F1", "completed");
  const st = await store("q7");
  assert.strictEqual(st.tickets[0].status, "done", "the retried run's settle reached the queue");
});

// --- Q8: the dependency cascade reverses on completion ---------------------------

await test("Q8: completing a blocked ticket un-blocks its dependents (the cascade reverses)", async () => {
  const engine = fakeEngine();
  const { mgr } = makeManager(engine, null);
  await seedProject("q8", [
    { id: "F1", title: "one", description: "d", status: "blocked", blockedReason: "gates-exhausted", runId: "run-q8-F1" },
    { id: "F2", title: "two", description: "d", dependsOn: ["F1"], status: "blocked", blockedReason: "depends on F1", runId: "run-q8-F2" },
    { id: "F3", title: "three", description: "d", status: "blocked", blockedReason: "stale-spec", runId: "run-q8-F3" },
  ], "idle");
  // the runs exist on disk (a restart happened since the cascade)
  engine.disk.set("run-q8-F1", { status: "failed" });
  engine.disk.set("run-q8-F2", { status: "clarified" });
  engine.disk.set("run-q8-F3", { status: "clarified" });
  const out = await mgr.retry("q8", "F1");
  assert.strictEqual(out.ok, true, out.error);
  await sleep(10);
  await engine.finishBuild("run-q8-F1", "completed");
  const st = await store("q8");
  const byId = Object.fromEntries(st.tickets.map((t) => [t.id, t]));
  assert.strictEqual(byId.F1.status, "done");
  assert.strictEqual(byId.F2.status, "running", "dependency-blocked dependent requeued AND pumped once the blocker completed");
  assert.strictEqual(byId.F2.blockedReason, null);
  assert.strictEqual(byId.F3.status, "blocked", "own-gate blocks stay parked for the owner");
  assert.strictEqual(byId.F3.blockedReason, "stale-spec");
  await engine.finishBuild("run-q8-F2", "completed");
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
  await seedProject("q9", [
    { id: "F1", title: "thing", description: "d", sourceDoc: "docs/features.md", status: "queued", runId: "flip9" },
  ], "running");
  engine.runs.set("flip9", { id: "flip9", status: "clarified", holdsTree: false, settled: true, opts: { onSettled: () => {} } });
  mgr.pump("q9"); // promotes flip9 (tree free at pump time)
  await sleep(10);
  // a direct run grabs the tree before flip9's build settles
  engine.runs.set("direct-run", { id: "direct-run", status: "running", holdsTree: true, settled: false, opts: {} });
  await engine.finishBuild("flip9", "completed");
  const doc = fs.readFileSync(path.join(projDir, "docs", "features.md"), "utf8");
  assert.ok(doc.includes("🔴"), "flip skipped — the doc was NOT written into the direct run's branch");
  assert.ok(!doc.includes("🟢"), "no partial flip");
  fs.rmSync(projDir, { recursive: true, force: true });
});

// --- Q10/Q11: re-clarify seeding + wave-state guard ---------------------------------

await test("Q10: re-clarify seeds the old spec + park reason into the fresh run's task", async () => {
  const engine = fakeEngine();
  const { mgr } = makeManager(engine, null);
  const rid = `recl-${Date.now()}`;
  fs.mkdirSync(path.join(ROOT, "runs", rid), { recursive: true });
  fs.writeFileSync(path.join(ROOT, "runs", rid, "state.json"), JSON.stringify({
    artifacts: { spec: { summary: "old summary", decisions: [{ topic: "style", decision: "CommonJS" }], acceptance_criteria: ["lib/greet.js exists"] } },
  }));
  await seedProject("q10", [
    { id: "F1", title: "one", description: "d", status: "blocked", blockedReason: "stale-spec", runId: rid },
  ], "idle");
  const out = await mgr.reclarify("q10", "F1");
  assert.strictEqual(out.ok, true, JSON.stringify(out.errors ?? out));
  await sleep(20);
  const started = engine.runs.get(out.started[0].runId);
  assert.match(started.opts.task, /RE-CLARIFICATION CONTEXT/);
  assert.match(started.opts.task, /stale-spec/);
  assert.match(started.opts.task, /old summary/);
  assert.match(started.opts.task, /lib\/greet\.js exists/);
  fs.rmSync(path.join(ROOT, "runs", rid), { recursive: true, force: true });
});

await test("Q11: a wave whose starts all fail can't stick the queue at 'clarifying'", async () => {
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

process.on("exit", () => { try { fs.rmSync(path.join(ROOT, "tickets"), { recursive: true, force: true }); } catch {} });

const failed = results.filter(([, ok]) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} queue tests passed`);
process.exit(failed ? 1 : 0);
