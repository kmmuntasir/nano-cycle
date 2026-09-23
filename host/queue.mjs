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
import { loadTickets, saveTickets, setTicketStatus, setQueueState, setQueueConfig, ticketsDir } from "./tickets.mjs";
import { flipStatus } from "./backlog.mjs";
import { newRunId, runsDir } from "./state.mjs";
import fs from "node:fs";
import path from "node:path";

const GATE_PARK_REASONS = {
  divergence: "stale-spec",
  "security-override": "security-override",
};

export function createQueueManager({ engine, emit, resolveProject, git, broadcast, pumpRetryMs = 60_000 }) {
  const watching = new Set(); // runIds this manager has parked (avoids double-cancel)
  let watcherInstalled = false;
  // Deferred promotions (tree held / dirty at promote time) MUST NOT stall the
  // queue: nothing is running, so no future settle would ever re-pump. Retry
  // on a timer instead — one pending retry per project, cleared on pause.
  const pumpRetryTimers = new Map();
  function schedulePumpRetry(project) {
    if (pumpRetryTimers.has(project)) return;
    const delay = Math.max(1000, Number(pumpRetryMs) || 60_000);
    const timer = setTimeout(() => {
      pumpRetryTimers.delete(project);
      pump(project);
    }, delay);
    timer.unref?.();
    pumpRetryTimers.set(project, timer);
  }
  function clearPumpRetry(project) {
    const timer = pumpRetryTimers.get(project);
    if (timer) {
      clearTimeout(timer);
      pumpRetryTimers.delete(project);
    }
  }

  function projectIds() {
    if (!fs.existsSync(ticketsDir())) return [];
    return fs.readdirSync(ticketsDir()).filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, ""));
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

  // --- clarify wave (v3.1: ONE PM conversation for the whole batch) --------------

  // The wave brief (plan §3): one PM, the full picture — what's already built,
  // the wave's features in build order with dependency context, what's later.
  function composeWaveBrief(store, waveTickets) {
    const byId = new Map(store.tickets.map((t) => [t.id, t]));
    const waveIds = new Set(waveTickets.map((t) => t.id));
    const done = store.tickets.filter((t) => t.status === "done");
    const later = store.tickets.filter((t) => !waveIds.has(t.id) && t.status !== "done");
    const depNote = (t) => {
      const parts = (t.dependsOn ?? []).map((d) => {
        if (byId.get(d)?.status === "done") return `${d} (already built)`;
        if (waveIds.has(d)) return `${d} (also in this wave, ${waveTickets.findIndex((x) => x.id === d) < waveTickets.findIndex((x) => x.id === t.id) ? "earlier" : "later"})`;
        return `${d} (outside this wave)`;
      });
      return parts.length ? `Depends on ${parts.join(", ")}.` : "No dependencies.";
    };
    const sections = [];
    if (done.length > 0) {
      sections.push(`## Already built (present in the working tree — investigate these, don't re-ask about them)\n${done.map((t) => `- ${t.id} — ${t.title}`).join("\n")}`);
    }
    sections.push(
      `## This wave — lock ONE spec per feature (they will be BUILT SEQUENTIALLY in this order)\n` +
        waveTickets.map((t) => `### ${t.id} — ${t.title}\n${depNote(t)}\n\n${t.description ?? ""}`).join("\n\n"),
    );
    if (later.length > 0) {
      sections.push(`## Later (NOT part of this wave — do not spec these)\n${later.map((t) => `- ${t.id} — ${t.title}`).join("\n")}`);
    }
    return [
      `You are the PRODUCT MANAGER for a WAVE of ${waveTickets.length} feature(s) of this project.`,
      `Ask questions ONCE for shared concerns (stack, style, conventions), resolve cross-feature decisions coherently,`,
      `then call finalize_spec once per feature (ticket_id) until every wave ticket has a spec.`,
      ``,
      sections.join("\n\n"),
    ].join("\n");
  }

  async function startClarifyWave(project, ticketIds, { taskSuffix = "" } = {}) {
    const store = loadTickets(project);
    const cfg = store.config;
    let projectRef;
    try {
      projectRef = resolveProject(project);
    } catch (e) {
      return { ok: false, error: String(e?.message ?? e) };
    }
    const errors = [];
    const waveTickets = [];
    for (const id of ticketIds ?? []) {
      const t = store.tickets.find((x) => x.id === id);
      if (!t) { errors.push(`unknown ticket "${id}"`); continue; }
      if (!["draft", "blocked", "clarified"].includes(t.status)) {
        errors.push(`ticket "${id}" is ${t.status} — only draft/blocked/clarified tickets can (re-)clarify`);
        continue;
      }
      waveTickets.push(t);
    }
    if (waveTickets.length === 0) {
      syncQueueState(project);
      broadcastQueue(project);
      return { ok: false, started: [], errors: errors.length > 0 ? errors : ["no tickets to clarify"] };
    }
    setQueueState(project, { state: "clarifying" }); // eager — settles may arrive within the same tick
    const waveRunId = `${newRunId()}-wave`;
    const waveIds = waveTickets.map((t) => t.id);
    for (const t of waveTickets) setTicketStatus(project, t.id, "clarifying", { runId: waveRunId });
    try {
      await engine.start({
        id: waveRunId,
        task: composeWaveBrief(store, waveTickets) + taskSuffix,
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
        waveTickets: waveTickets.map((t) => ({ id: t.id, title: t.title })),
        ticketId: null, // the wave run belongs to no single ticket
        onSettled: (status) => onWaveSettled(project, waveRunId, waveIds, status),
      });
    } catch (e) {
      for (const t of waveTickets) setTicketStatus(project, t.id, "blocked", { reason: "provider-failures", note: String(e?.message ?? e) });
      errors.push(`wave start failed: ${e?.message ?? e}`);
    }
    // A wave whose start failed never produces a settle — sync here so the
    // queue can't stick at 'clarifying'.
    syncQueueState(project);
    broadcastQueue(project);
    return { ok: errors.length === 0, started: [{ runId: waveRunId, tickets: waveIds }], errors };
  }

  function onWaveSettled(project, waveRunId, waveIds, status) {
    for (const id of waveIds) {
      const t = loadTickets(project).tickets.find((x) => x.id === id);
      if (!t || t.runId !== waveRunId) continue; // a newer run owns this ticket
      if (status === "clarified") setTicketStatus(project, id, "clarified", { runId: waveRunId });
      else if (status === "cancelled") setTicketStatus(project, id, "draft", { runId: waveRunId });
      else setTicketStatus(project, id, "blocked", { reason: "provider-failures", runId: waveRunId, note: `clarify wave ${status}` });
    }
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

  const pumpInFlight = new Set();
  function pump(project) {
    if (pumpInFlight.has(project)) return; // the fresh-start await is in flight
    pumpInFlight.add(project);
    Promise.resolve(pumpOnce(project)).catch(() => {}).finally(() => pumpInFlight.delete(project));
  }

  async function pumpOnce(project) {
    const store = loadTickets(project);
    if (store.queue.state === "paused") return;
    if (engine.treeLockHolder(resolveProject(project).path)) {
      // A build is in flight; its settle re-pumps — but if that settle never
      // comes (stuck run, lost callback), the retry is the backstop.
      schedulePumpRetry(project);
      return;
    }
    const ready = nextReady(store);
    if (ready.length === 0) {
      syncQueueState(project);
      broadcastQueue(project);
      return;
    }
    const t = ready[0];
    if (!t.runId) {
      // clarified without a run (imported/stale store) — cannot build
      setTicketStatus(project, t.id, "blocked", { reason: "provider-failures", note: "clarified ticket has no run — re-clarify" });
      broadcastQueue(project);
      return pump(project);
    }
    const out = await startOrResumeBuildRun(project, t);
    if (!out.ok) {
      if (out.park) {
        setTicketStatus(project, t.id, "blocked", { reason: "provider-failures", note: String(out.error ?? "cannot start") });
        broadcastQueue(project);
        return pump(project);
      }
      // Holder appeared between checks (a direct run, another queue) or the
      // tree is dirty — the next settle re-pumps AND a timed retry backstops
      // it. Leave the ticket queued.
      emit.event?.(t.runId, "_run", {
        t: "notice",
        s: `queue: promotion of ${t.id} deferred (${out.error}) — the queue retries automatically; fix the tree (commit/stash) or resume the queue to hurry it`,
      });
      broadcastQueue(project);
      schedulePumpRetry(project);
      return;
    }
    setTicketStatus(project, t.id, "running", { runId: out.runId });
    syncQueueState(project);
    broadcastQueue(project);
  }

  function readRunState(runId) {
    if (!runId) return null;
    try {
      return JSON.parse(fs.readFileSync(path.join(runsDir(), runId, "state.json"), "utf8"));
    } catch {
      return null;
    }
  }

  // D6: the ticket's spec — wave runs keep a per-ticket map; legacy clarified
  // runs keep a single spec. Disk is the source of truth (restart-safe).
  function specForTicket(t) {
    const rs = readRunState(t.runId);
    return rs?.artifacts?.specs?.[t.id] ?? rs?.artifacts?.spec ?? null;
  }

  // v3.1: the pump SEEDS a fresh build run per ticket (its wave spec rides
  // along) — except when a BUILD run already exists (interrupted/failed/
  // cancelled), which is resumed with milestones kept, never re-seeded.
  async function startOrResumeBuildRun(project, t) {
    const rs = readRunState(t.runId);
    const isClarifyStage = !rs || rs.status === "clarified" || (rs.wave?.ticketIds?.length ?? 0) > 0;
    if (!isClarifyStage) {
      // the runId never changes on resume — the closure stays valid
      const cb = (status) => onBuildSettled(project, t.id, t.runId, status);
      let out = engine.resume(t.runId);
      if (!out.ok && /not active in this server session/.test(String(out.error ?? ""))) {
        out = engine.resumeFromDisk(t.runId, resolveProject(project), { onSettled: cb });
      }
      return { ok: out.ok === true, runId: t.runId, error: out.error };
    }
    const spec = specForTicket(t);
    if (!spec) return { ok: false, park: true, error: "no spec on the clarify run — re-clarify" };
    const store = loadTickets(project);
    const cfg = store.config;
    let projectRef;
    try {
      projectRef = resolveProject(project);
    } catch (e) {
      return { ok: false, error: String(e?.message ?? e) };
    }
    // newRunId() has millisecond precision — suffix the ticket id to keep
    // runs/<id> unique.
    const buildRunId = `${newRunId()}-${String(t.id).toLowerCase().replace(/[^\w-]/g, "")}`;
    // the settle callback MUST carry the BUILD run id — the ticket's runId
    // changes to it (D4), and onBuildSettled joins on (ticketId, runId).
    const cb = (status) => onBuildSettled(project, t.id, buildRunId, status);
    try {
      await engine.start({
        id: buildRunId,
        task: [t.title, t.description].filter(Boolean).join("\n\n"),
        project: projectRef,
        models: cfg.models,
        clarify: false,
        requireQuestions: false,
        maxFixRounds: cfg.options.maxFixRounds ?? 2,
        git: cfg.options.git === true,
        audit: cfg.options.audit !== false,
        approvePlan: false, // queue law: the spec is the owner's gate, the plan is not
        remoteChecks: cfg.options.remoteChecks === true,
        security: cfg.options.security ?? "off",
        seedSpec: spec,
        ticketId: t.id,
        onSettled: cb,
      });
    } catch (e) {
      return { ok: false, error: String(e?.message ?? e) };
    }
    return { ok: true, runId: buildRunId };
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
      const runFile = path.join(runsDir(), runId, "state.json");
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
  //
  // The commit is attempted even when the markers are already flipped: the
  // builder often edits its own sourceDoc entry (flip + Done note) and leaves
  // it uncommitted, and that leftover dirt rides checkout+merge onto the base
  // branch — where the next promote's assertClean would choke and stall the
  // queue. Landing it here keeps the tree clean for the pump.
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
    let wroteFlip = false;
    try {
      const text = fs.readFileSync(abs, "utf8");
      const flipped = flipStatus(text, ticket.id, true);
      if (flipped && flipped !== text) {
        fs.writeFileSync(abs, flipped);
        wroteFlip = true;
      }
      return (async () => {
        try {
          if (!(await git.isRepo(projectPath))) return;
          const sha = await git.commitFile(projectPath, path.relative(projectPath, abs), `chore: mark ${ticket.id} done (${ticket.id})`);
          if (sha) {
            note(
              wroteFlip
                ? `backlog: ${ticket.id} marked done in ${ticket.sourceDoc}`
                : `backlog: landed uncommitted ${ticket.sourceDoc} edit for ${ticket.id} (${String(sha).slice(0, 7)}) — the tree stays clean for the next ticket`,
            );
          }
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
    // Resuming a clarify-stage (wave) run makes no sense for one ticket —
    // park-phase at clarify means re-clarify.
    const rs = readRunState(t.runId);
    if (!rs || rs.status === "clarified" || (rs.wave?.ticketIds?.length ?? 0) > 0) {
      return { ok: false, error: "ticket is parked at the clarify stage — use re-clarify" };
    }
    // Resume the parked BUILD run (gates/branch/session kept). A gates-failed
    // run with a verify report resumes in FIX mode: one build turn against the
    // last report, no wasted re-verify. In-session first (its settle callback
    // is still wired); after a restart the controller is rebuilt from disk
    // WITH the queue's settle callback.
    const hasVerify = !!readRunState(t.runId)?.artifacts?.verify;
    let out = engine.resume(t.runId, { fix: hasVerify });
    if (!out.ok && !/only cancelled or failed runs can be resumed|still winding down/.test(String(out.error ?? ""))) {
      out = engine.resumeFromDisk(t.runId, resolveProject(project), {
        onSettled: (status) => onBuildSettled(project, ticketId, t.runId, status),
        fix: hasVerify,
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
        const st = readRunState(t.runId);
        const spec = st?.artifacts?.specs?.[t.id] ?? st?.artifacts?.spec;
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
    clearPumpRetry(project);
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
      const runFile = path.join(runsDir(), t.runId, "state.json");
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
