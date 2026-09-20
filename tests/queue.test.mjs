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
  return {
    runs,
    gateCancels,
    promotes,
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
      if (!r) return { ok: false, error: "unknown run" };
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
    resumeFromDisk(id) { return runs.has(id) ? { ok: true } : { ok: false, error: "unknown" }; },
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

process.on("exit", () => { try { fs.rmSync(path.join(ROOT, "tickets"), { recursive: true, force: true }); } catch {} });

const failed = results.filter(([, ok]) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} queue tests passed`);
process.exit(failed ? 1 : 0);
