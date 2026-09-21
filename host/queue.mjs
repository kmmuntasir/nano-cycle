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

  // The queue chip DERIVES from the tickets — no hand-maintained transitions
  // to drift out of sync (a re-clarify during a running build used to flip
  // the state to clarifying → awaiting-release while delivery was mid-flight).
  // `paused` is owner authority: only resume clears it (survives restarts).
  function syncQueueState(project) {
    const store = loadTickets(project);
    if (store.queue.state === "paused") return;
    const next = store.tickets.some((t) => t.status === "clarifying")
      ? "clarifying"
      : store.tickets.some((t) => ["queued", "running"].includes(t.status))
        ? "running"
        : store.tickets.some((t) => t.status === "clarified")
          ? "awaiting-release"
          : "idle";
    if (next !== store.queue.state) setQueueState(project, { state: next });
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
        // A DIRECT (non-queue) run settled: if it held the tree while the pump
        // deferred a promotion (e.g. released mid-manual-run), nothing else
        // would re-pump — do it here. Queue-owned runs drive their own pumps
        // via onBuildSettled (deferring to it also keeps the backlog-flip
        // commit sequenced BEFORE the next promote).
        if (!run.state.ticketId && ["completed", "failed", "cancelled", "clarified"].includes(run.state.status)) {
          pump(run.state.project);
        }
      } catch {
        /* watcher must never break a run */
      }
    };
  }

  // --- clarify wave ------------------------------------------------------------

  async function startClarifyWave(project, ticketIds, { taskSuffix = "" } = {}) {
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
      if (!["draft", "blocked", "clarified"].includes(t.status)) {
        errors.push(`ticket "${id}" is ${t.status} — only draft/blocked/clarified tickets can (re-)clarify`);
        continue;
      }
      // newRunId() has millisecond precision — a wave loop can start two runs
      // within one tick, so suffix the ticket id to keep runs/<id> unique.
      const runId = `${newRunId()}-${String(id).toLowerCase().replace(/[^\w-]/g, "")}`;
      setTicketStatus(project, id, "clarifying", { runId });
      const task = [t.title, t.description].filter(Boolean).join("\n\n") + taskSuffix;
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
    // A wave whose every start failed (or that was empty) never produces a
    // settle — sync here so the queue can't stick at 'clarifying'.
    syncQueueState(project);
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
    syncQueueState(project); // wave done → awaiting-release (or running if builds are mid-flight)
    broadcastQueue(project);
  }

  // --- release + build pump ------------------------------------------------------

  function release(project, onlyIds) {
    const store = loadTickets(project);
    // The batch spec review selects WHICH clarified tickets release (§7);
    // no selection (or an empty one) means all clarified tickets.
    const pick = Array.isArray(onlyIds) && onlyIds.length > 0 ? (t) => onlyIds.includes(t.id) : () => true;
    const clarified = store.tickets.filter((t) => t.status === "clarified" && pick(t));
    for (const t of clarified) setTicketStatus(project, t.id, "queued");
    syncQueueState(project);
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
      syncQueueState(project);
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
    syncQueueState(project);
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
      setTicketStatus(project, ticketId, "blocked", { reason: classifyFailure(runId), runId });
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

  // §2.4: classify the blockedReason from the run's own error record. Gate
  // failures say "gates still failing…" / "security findings not fixed…";
  // provider-type errors (watchdog aborts, rate limits, credit exhaustion)
  // are provider-failures — a different owner decision than a gate verdict.
  const PROVIDER_FAILURE_RE =
    /abort|stall|provider|rate.?limit|credit|quota|timeout|insufficient|overloaded|network|econn|fetch failed|socket|dns|429|503/i;
  function classifyFailure(runId) {
    try {
      const runFile = path.join(path.resolve(import.meta.dirname, ".."), "runs", runId, "state.json");
      const st = JSON.parse(fs.readFileSync(runFile, "utf8"));
      if (PROVIDER_FAILURE_RE.test(String(st.error ?? ""))) return "provider-failures";
    } catch {
      /* no state on disk — default bucket */
    }
    return "gates-exhausted";
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
    return startClarifyWave(project, [ticketId], { taskSuffix: reclarifySeed(t) });
  }

  // The plan's re-clarify contract (§2.2): the fresh PM run is seeded with the
  // OLD spec plus the park reason, so the PM re-validates it against the
  // current tree instead of re-deriving from scratch.
  function reclarifySeed(t) {
    const parts = [];
    if (t.blockedReason) parts.push(`This ticket was previously parked with reason: "${t.blockedReason}".`);
    if (t.runId) {
      try {
        const runFile = path.join(path.resolve(import.meta.dirname, ".."), "runs", t.runId, "state.json");
        const st = JSON.parse(fs.readFileSync(runFile, "utf8"));
        const spec = st.artifacts?.spec;
        if (spec) {
          const digest = [
            `Summary: ${spec.summary ?? ""}`,
            ...((spec.decisions ?? []).map((d) => `Decision — ${d.topic}: ${d.decision}`)),
            ...((spec.acceptance_criteria ?? []).map((c) => `- ${c}`)),
          ].join("\n").slice(0, 4000);
          parts.push(`The PREVIOUS spec follows. It may predate recent repo changes — re-validate every reference against the CURRENT tree before locking:\n\n${digest}`);
        }
      } catch {
        /* no old run/spec on disk — seed with the reason alone */
      }
    }
    return parts.length ? `\n\n--- RE-CLARIFICATION CONTEXT ---\n${parts.join("\n\n")}` : "";
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
    // Assign display order to every listed id (the ready set pumps by it).
    // The running ticket is never displaced — only queued tickets are pumpable.
    orderedIds.forEach((id, i) => {
      const t = store.tickets.find((x) => x.id === id);
      if (t) t.order = i;
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
    syncQueueState(project); // re-derive from reconciled tickets (keeps a owner-set pause)
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
