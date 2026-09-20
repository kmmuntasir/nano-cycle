// Queue manager — the v3 two-phase scheduler that sits ABOVE the engine
// (docs/PLAN-v3-ticket-queue.md §2.4). Owns: clarify waves (parallel
// clarify-only runs), the release gate, the sequential build pump, the
// park-don't-block policy, dependency cascade, and crash recovery.
//
// Design law: GATES PARK TICKETS, NOT THE QUEUE. A ticket that fails its
// gates (or needs an owner decision) becomes `blocked` with a reason; the
// queue keeps delivering independent tickets. `dependsOn` blocks transitively.
//
// Gate detection is event-driven: the manager wraps the server's emit.state —
// a queue-owned run whose state shows an owner-gate (divergence /
// security-override / answers during a non-inbox phase) parks the ticket and
// cancels the run (branch + session kept for retry/resume).
import { loadTickets, saveTickets, setTicketStatus, setQueueState, setQueueConfig } from "./tickets.mjs";
import { flipStatus } from "./backlog.mjs";
import { newRunId } from "./state.mjs";
import fs from "node:fs";
import path from "node:path";

const GATE_PARK_REASONS = {
  divergence: "stale-spec",
  "security-override": "security-override",
};

export function createQueueManager({ engine, emit, resolveProject, git, broadcast }) {
  const watching = new Set(); // runIds this manager has parked (avoids double-cancel)
  let watcherInstalled = false;

  function projectIds() {
    const dir = path.join(path.resolve(import.meta.dirname, ".."), "tickets");
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, ""));
  }

  function snapshot(project) {
    return loadTickets(project);
  }

  function broadcastQueue(project) {
    try {
      broadcast?.({ type: "queue", project, state: loadTickets(project) });
    } catch {
      /* broadcast optional */
    }
  }

  // Wrap emit.state once: watch queue-owned runs for parked conditions.
  function installStateWatcher() {
    if (watcherInstalled) return;
    watcherInstalled = true;
    const orig = emit.state;
    emit.state = (run) => {
      orig(run);
      try {
        if (run.state.status === "awaiting-gate" && run.state.ticketId) {
          const store = loadTickets(run.state.project);
          const t = store.tickets.find((x) => x.id === run.state.ticketId);
          if (t?.status === "running" && !watching.has(run.id)) {
            const reason = GATE_PARK_REASONS[run.state.gate?.type];
            if (reason) {
              watching.add(run.id);
              console.error('[watcher] parking', t.id, 'reason', reason);
              setTicketStatus(run.state.project, t.id, "blocked", { reason, runId: run.id });
              emit.event(run.id, "_run", {
                t: "notice",
                s: `queue: ticket ${t.id} parked (${reason}) — gate awaits the owner; the queue moves on`,
              });
              broadcastQueue(run.state.project);
              engine.gate(run.id, "cancel"); // release the run; branch + session kept for retry
            }
          }
        }
      } catch {
        /* watcher must never break a run */
      }
    };
  }

  // --- clarify wave ------------------------------------------------------------

  async function startClarifyWave(project, ticketIds) {
    const store = loadTickets(project);
    const cfg = store.config;
    let projectRef;
    try {
      projectRef = resolveProject(project);
    } catch (e) {
      return { ok: false, error: String(e?.message ?? e) };
    }
    const started = [];
    const errors = [];
    setQueueState(project, { state: "clarifying" }); // before the loop — settles may arrive within the same tick
    for (const id of ticketIds) {
      const t = store.tickets.find((x) => x.id === id);
      if (!t) { errors.push(`unknown ticket "${id}"`); continue; }
      if (!["draft", "blocked", "clarified", "failed"].includes(t.status)) {
        errors.push(`ticket "${id}" is ${t.status} — only draft/blocked/clarified/failed tickets can (re-)clarify`);
        continue;
      }
      // newRunId() has millisecond precision — a wave loop can start two runs
      // within one tick, so suffix the ticket id to keep runs/<id> unique.
      const runId = `${newRunId()}-${String(id).toLowerCase().replace(/[^\w-]/g, "")}`;
      setTicketStatus(project, id, "clarifying", { runId });
      const task = [t.title, t.description].filter(Boolean).join("\n\n");
      try {
        await engine.start({
          id: runId,
          task,
          project: projectRef,
          models: cfg.models,
          clarify: true,
          requireQuestions: false,
          maxFixRounds: cfg.options.maxFixRounds ?? 2,
          git: cfg.options.git === true,
          audit: cfg.options.audit !== false,
          approvePlan: false, // queue law: the spec is the owner's gate, the plan is not
          remoteChecks: cfg.options.remoteChecks === true,
          security: cfg.options.security ?? "off",
          stopAfterClarify: true,
          ticketId: id,
          onSettled: (status) => onClarifySettled(project, id, runId, status),
        });
        started.push({ id, runId });
      } catch (e) {
        setTicketStatus(project, id, "blocked", { reason: "provider-failures", note: String(e?.message ?? e) });
        errors.push(`${id}: ${e?.message ?? e}`);
      }
    }
    broadcastQueue(project);
    return { ok: errors.length === 0, started, errors };
  }

  function onClarifySettled(project, ticketId, runId, status) {
    const store = loadTickets(project);
    const t = store.tickets.find((x) => x.id === ticketId);
    if (!t || t.runId !== runId) return; // a newer run owns this ticket
    if (status === "clarified") setTicketStatus(project, ticketId, "clarified", { runId });
    else if (status === "cancelled") setTicketStatus(project, ticketId, "draft", { runId });
    else setTicketStatus(project, ticketId, "blocked", { reason: "provider-failures", runId, note: `clarify run ${status}` });
    // Wave done? → awaiting-release
    const fresh = loadTickets(project);
    if (!fresh.tickets.some((x) => x.status === "clarifying") && fresh.queue.state === "clarifying") {
      setQueueState(project, { state: "awaiting-release" });
    }
    broadcastQueue(project);
  }

  // --- release + build pump ------------------------------------------------------

  function release(project) {
    const store = loadTickets(project);
    const clarified = store.tickets.filter((t) => t.status === "clarified");
    for (const t of clarified) setTicketStatus(project, t.id, "queued");
    setQueueState(project, { state: "running" });
    broadcastQueue(project);
    pump(project);
    return { released: clarified.length };
  }

  function nextReady(store) {
    const byId = new Map(store.tickets.map((t) => [t.id, t]));
    const done = (id) => byId.get(id)?.status === "done";
    return store.tickets
      .filter((t) => t.status === "queued" && (t.dependsOn ?? []).every(done))
      .sort((a, b) => (a.order ?? 999) - (b.order ?? 999) || String(a.createdAt).localeCompare(String(b.createdAt)));
  }

  function pump(project) {
    const store = loadTickets(project);
    if (store.queue.state === "paused") return;
    if (engine.treeLockHolder(resolveProject(project).path)) return; // a build is in flight; onSettled re-pumps
    const ready = nextReady(store);
    if (ready.length === 0) {
      const busy = store.tickets.some((t) => ["queued", "running", "clarifying"].includes(t.status));
      if (!busy) setQueueState(project, { state: "idle" });
      broadcastQueue(project);
      return;
    }
    const t = ready[0];
    if (!t.runId) {
      // clarified without a run (imported/stale store) — cannot promote
      setTicketStatus(project, t.id, "blocked", { reason: "provider-failures", note: "clarified ticket has no run — re-clarify" });
      broadcastQueue(project);
      return pump(project);
    }
    const out = promoteRun(project, t);
    if (!out.ok) {
      // Holder appeared between checks (a direct run, another queue) — the
      // next settle re-pumps. Leave the ticket queued.
      emit.event?.(t.runId, "_run", { t: "notice", s: `queue: promotion deferred (${out.error})` });
      return;
    }
    setTicketStatus(project, t.id, "running", { runId: t.runId });
    setQueueState(project, { state: "running" });
    broadcastQueue(project);
  }

  // Promote a ticket's clarified run into build. In-session first; when the
  // server restarted since the wave (the run exists only on disk), continue it
  // from disk with promote semantics — restarts must not strand the queue.
  function promoteRun(project, t) {
    const cb = (status) => onBuildSettled(project, t.id, t.runId, status);
    let out = engine.promote(t.runId, cb);
    if (!out.ok && /not active in this server session/.test(String(out.error ?? ""))) {
      out = engine.resumeFromDisk(t.runId, resolveProject(project), { promote: true, onSettled: cb });
    }
    return out;
  }

  function onBuildSettled(project, ticketId, runId, status) {
    const store = loadTickets(project);
    const t = store.tickets.find((x) => x.id === ticketId);
    if (!t || t.runId !== runId) return;
    let flip = Promise.resolve();
    if (status === "completed") {
      setTicketStatus(project, ticketId, "done", { runId });
      unblockDependents(project);
      // The flip's write+commit must land on the base branch BEFORE the pump
      // promotes the next ticket — its branch checkout would race the commit.
      flip = flipBacklog(project, t);
    } else if (status === "failed") {
      setTicketStatus(project, ticketId, "blocked", { reason: "gates-exhausted", runId });
    } else if (status === "cancelled") {
      // Cancelled by the park watcher (gate) or by the owner — either way the
      // ticket is blocked/parked for review; retry resumes the run from disk.
      if (t.status !== "blocked") setTicketStatus(project, ticketId, "blocked", { reason: "gates-exhausted", runId });
    }
    const finish = () => {
      // Cascade: dependents of a non-done ticket cannot run — mark them blocked
      // (transitively) so the columns tell the truth.
      const fresh = loadTickets(project);
      const blockedOn = (id, seen = new Set()) => {
        const dependents = fresh.tickets.filter(
          (x) => (x.dependsOn ?? []).includes(id) && !["done", "blocked"].includes(x.status),
        );
        for (const d of dependents) {
          if (seen.has(d.id)) continue;
          seen.add(d.id);
          setTicketStatus(project, d.id, "blocked", { reason: `depends on ${id}` });
          blockedOn(d.id, seen);
        }
      };
      if (status !== "completed") blockedOn(ticketId);
      broadcastQueue(project);
      pump(project);
    };
    Promise.resolve(flip).catch(() => {}).finally(finish);
  }

  // A completed ticket releases its dependents: dependency-blocked tickets
  // whose deps are ALL done return to queued (their own gates never failed —
  // the blocker did). Own-gate blocks (stale-spec, gates-exhausted, …) stay
  // parked for the owner. The pump that follows picks them up in order.
  function unblockDependents(project) {
    const store = loadTickets(project);
    const byId = new Map(store.tickets.map((x) => [x.id, x]));
    for (const x of store.tickets) {
      if (x.status !== "blocked" || !String(x.blockedReason ?? "").startsWith("depends on")) continue;
      if ((x.dependsOn ?? []).every((d) => byId.get(d)?.status === "done")) {
        setTicketStatus(project, x.id, "queued", { runId: x.runId });
      }
    }
  }

  // Flip the ticket's backlog marker (🔴→🟢) and commit it on the base branch.
  // NEVER while another run holds the tree (its branch is checked out — the
  // flip would land there instead of base). Returns a promise so the caller can
  // sequence the pump after the commit; never rejects.
  function flipBacklog(project, ticket) {
    const note = (s) => {
      if (ticket.runId) emit.event?.(ticket.runId, "_run", { t: "notice", s });
    };
    if (!ticket.sourceDoc) return Promise.resolve();
    let projectPath;
    try { projectPath = resolveProject(project).path; } catch { return Promise.resolve(); }
    const abs = path.resolve(projectPath, ticket.sourceDoc.split("#")[0]);
    if (!abs.startsWith(path.resolve(projectPath)) || !fs.existsSync(abs)) return Promise.resolve();
    if (engine.treeLockHolder(projectPath)) {
      note(`backlog: flip skipped for ${ticket.id} — the working tree is held by another run; flip ${ticket.sourceDoc} manually`);
      return Promise.resolve();
    }
    try {
      const text = fs.readFileSync(abs, "utf8");
      const flipped = flipStatus(text, ticket.id, true);
      if (!flipped || flipped === text) return Promise.resolve();
      fs.writeFileSync(abs, flipped);
      return (async () => {
        try {
          if (!(await git.isRepo(projectPath))) return;
          await git.commitFile(projectPath, path.relative(projectPath, abs), `chore: mark ${ticket.id} done (${ticket.id})`);
          note(`backlog: ${ticket.id} marked done in ${ticket.sourceDoc}`);
        } catch (e) {
          note(`backlog: flip commit failed for ${ticket.id} (${String(e?.message ?? e).slice(0, 160)}) — doc flipped, commit not landed`);
        }
      })();
    } catch {
      return Promise.resolve(); // flip is best-effort
    }
  }

  // --- owner actions -------------------------------------------------------------

  function retry(project, ticketId) {
    const store = loadTickets(project);
    const t = store.tickets.find((x) => x.id === ticketId);
    if (!t) return { ok: false, error: `unknown ticket "${ticketId}"` };
    if (t.status !== "blocked") return { ok: false, error: `ticket "${ticketId}" is not blocked` };
    if (!t.runId) return { ok: false, error: `ticket "${ticketId}" has no run to retry — re-clarify instead` };
    // Resume the parked run (gates/branch/session kept). In-session first (the
    // settle callback from its promote is still wired); after a restart the
    // controller is rebuilt from disk WITH the queue's settle callback.
    let out = engine.resume(t.runId);
    if (!out.ok && !/only cancelled or failed runs can be resumed|still winding down/.test(String(out.error ?? ""))) {
      out = engine.resumeFromDisk(t.runId, resolveProject(project), {
        onSettled: (status) => onBuildSettled(project, ticketId, t.runId, status),
      });
    }
    if (out.ok) setTicketStatus(project, ticketId, "running", { runId: t.runId });
    return out;
  }

  function reclarify(project, ticketId) {
    const store = loadTickets(project);
    const t = store.tickets.find((x) => x.id === ticketId);
    if (!t) return { ok: false, error: `unknown ticket "${ticketId}"` };
    return startClarifyWave(project, [ticketId]);
  }

  function pause(project) {
    setQueueState(project, { state: "paused", pausedAt: new Date().toISOString() });
    broadcastQueue(project);
    return { ok: true };
  }

  function resume(project) {
    setQueueState(project, { state: "running", pausedAt: null });
    broadcastQueue(project);
    pump(project);
    return { ok: true };
  }

  function reorder(project, orderedIds) {
    const store = loadTickets(project);
    orderedIds.forEach((id, i) => {
      const t = store.tickets.find((x) => x.id === id);
      if (t && t.status === "queued") t.order = i;
    });
    saveTickets(project, store);
    broadcastQueue(project);
    return { ok: true };
  }

  // --- crash recovery -------------------------------------------------------------

  function recoverAll() {
    for (const project of projectIds()) {
      try {
        recoverProject(project);
      } catch {
        /* a broken store must not break the boot */
      }
    }
  }

  function recoverProject(project) {
    const store = loadTickets(project);
    let touched = false;
    let projectPath = null;
    try { projectPath = resolveProject(project).path; } catch { /* project unregistered */ }
    for (const t of store.tickets) {
      if (!t.runId) continue;
      const runFile = path.join(path.resolve(import.meta.dirname, ".."), "runs", t.runId, "state.json");
      if (!fs.existsSync(runFile)) continue;
      let rs = null;
      try { rs = JSON.parse(fs.readFileSync(runFile, "utf8")); } catch { continue; }
      if (t.status === "running" && ["interrupted", "running"].includes(rs.status)) {
        // interrupted build: requeue — resume restores the session from disk
        setTicketStatus(project, t.id, "queued", { runId: t.runId });
        touched = true;
      } else if (t.status === "clarifying" && ["interrupted", "running"].includes(rs.status)) {
        // clarify rounds are ephemeral sessions — back to draft for a re-wave
        setTicketStatus(project, t.id, "draft", { runId: t.runId });
        touched = true;
      }
    }
    if (touched || ["running", "clarifying"].includes(store.queue.state)) {
      setQueueState(project, { state: "running" });
    }
    if (projectPath) pump(project);
    broadcastQueue(project);
  }

  installStateWatcher();

  return {
    startClarifyWave,
    release,
    pump,
    retry,
    reclarify,
    pause,
    resume,
    reorder,
    recoverAll,
    recoverProject,
    snapshot,
  };
}
