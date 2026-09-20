# nano-cycle v3 — Ticket Queue: backlog → batch clarification → sequential delivery

**Status:** approved direction; implementation plan (sequenced TODOs at the end)
**Builds on:** v2.0.0 (four-step workflow — `docs/PLAN-v2-step-workflow.md`, fully owner-validated)
**Branch:** `v3-ticket-queue`

---

## 1. What we are building and why

v2 runs **one ticket's lifecycle** with driver-owned gates: clarify → build → verify → security.
v3 turns the surrounding loop into product: a **per-project ticket backlog** whose tickets flow
through a **two-phase scheduler** with minimal human involvement:

```txt
            ┌──────────── CLARIFY WAVE (parallel, read-only) ────────────┐
            │  PM runs for many tickets at once, one Inbox for the owner │
            └──────────────────────┬─────────────────────────────────────┘
                                   ▼  specs locked
                     ★ RELEASE GATE — the ONE human moment:
                       review all locked specs in a batch, release the queue
                                   ▼
            ┌──────────── BUILD QUEUE (sequential, per project) ─────────┐
            │  promote → build → verify → security → merge → next        │
            │  gates PARK tickets, never the queue                       │
            └────────────────────────────────────────────────────────────┘
```

**The differentiator** (guard it against scope creep): a ticket's definition-of-done is
*mechanically enforced* — spec contract, adversarial verify, driver ground truth, security
gates, verdict-gated git merge. JIRA/Trello never had that. We are not building a JIRA:
no assignees, sprints, labels, comments, or workflows beyond the states below.

### Design principles (decided up front)

1. **Gates park tickets, not the queue.** Any gate failure (fix rounds exhausted, divergence,
   security override, stale spec) moves that ticket to `blocked` with a reason; the queue keeps
   moving; `dependsOn` chains block transitively; independent tickets proceed.
2. **The clarify phase IS the human gate.** Queue mode runs with plan-approval OFF — the owner
   gates on **specs in batch** (short, reviewable) at the release gate, not on N plans.
   Divergence still halts (it's rare by design).
3. **Failure isolation via git** (already built): a failed ticket's branch never merges; the
   queue continues on a clean base. Later tickets' verify runs the whole suite — a free
   regression net across the backlog.
4. **The queue sits ABOVE the engine.** `queue.mjs` orchestrates the existing, battle-tested
   engine API (`start/answer/gate/cancel/resume/promote`). Engine changes are surgical, not
   structural.
5. **Spec staleness is caught, not assumed away.** Specs are written before earlier tickets
   are built; the build phase's planner treats repo-vs-spec contradictions as **divergence**
   (park → re-clarify), making the existing gate the staleness detector.
6. **Tickets live outside target repos** (the v1 §14 lesson). The ONLY write into a repo is
   code + commits — including the one deliberate backlog status-flip commit on completion.

## 2. Architecture

### 2.1 New modules

| Module | Owns |
|---|---|
| `host/tickets.mjs` | per-project ticket store (`tickets/<project>.json`): CRUD, import (markdown/JSON), persistence, transitions |
| `host/queue.mjs` | the two-phase scheduler: clarify waves, release gate, build pump, park policy, dependency cascade, crash recovery, per-project queue config |
| `host/backlog.mjs` | `docs/features.md` parsing (import) + status flip (🟢) committed on completion |

Engine (`host/engine.mjs`) changes are **additive and small** (§4). GUI gains a Tickets view,
the PM Inbox, and a Queue panel (§7).

### 2.2 Ticket lifecycle

```txt
draft ──clarify wave──▶ clarifying ──spec locked──▶ clarified
                                                        │ (owner releases — batch spec review)
                                                        ▼
                          queued ──pump (tree free, deps done)──▶ running
                          ▲   ▲                                     │
                          │   └── re-clarify (stale spec) ◀─────────┤ settle:
                          │            (fresh clarify run)          ├─▶ done      (merged, backlog flipped)
                          └── retry (resume parked run)  ◀──────────┴─▶ blocked   (parked, reason recorded)
                                                                      {gates-exhausted | divergence |
                                                                       stale-spec | security-override |
                                                                       provider-failures}
```

- `blocked` tickets are the JIRA "blocked column": the owner reviews at leisure and either
  **retry** (resume the parked run — existing machinery) or **re-clarify** (fresh clarify run
  seeded with the old spec + the reason).
- `running` tickets hold the project's **tree lock**; `clarifying` tickets never do (read-only).

### 2.3 Ticket schema (`tickets/<project>.json`)

```jsonc
{
  "project": "omni-isp",
  "config": {                       // queue-mode run defaults (GUI-editable)
    "models": { "clarify": "…", "builder": "…", "verifier": "…", "security": "…" },
    "options": { "git": true, "audit": true, "security": "scan", "maxFixRounds": 2,
                 "remoteChecks": false, "approvePlan": false }   // approvePlan forced false in queue mode
  },
  "tickets": [
    {
      "id": "F02",                          // slug (F## / OMNI-### from import, or auto)
      "title": "Sign-in flow",
      "description": "…full ticket text…",  // becomes the run task + is injected as source doc
      "sourceDoc": "docs/features.md#F02",  // provenance for the status flip (or null)
      "dependsOn": ["F01"],
      "order": 2,                           // manual ordering within the ready set
      "status": "queued",
      "blockedReason": null,
      "runId": "20260922-…",                // current (or last) run
      "history": [{ "at": "…", "from": "queued", "to": "running", "runId": "…" }],
      "createdAt": "…", "updatedAt": "…"
    }
  ],
  "queue": { "state": "idle|clarifying|awaiting-release|running|paused", "pausedAt": null }
}
```

Specs are NOT copied into the ticket — they live in the run's `state.json` (the proven store,
served by the existing spec machinery); the ticket links by `runId` and the GUI pulls specs
from runs. One source of truth.

### 2.4 The queue state machine (`host/queue.mjs`)

```txt
startClarifyWave(project, ticketIds)
  for each ticket: engine.start({ task: <title + description>, ticketId, clarify: true,
                                  stopAfterClarify: true, models, options })   → clarifying
  (N parallel read-only runs are safe; the engine's tree lock does not apply to them)

owner answers via the PM Inbox (per-run answers API — unchanged)
  each wave run settles → status "clarified" → ticket clarified

release(project)                        ← the ONE deliberate human moment
  all clarified tickets → queued; queue.state = running

pump(project)                           — runs whenever a run settles or release happens
  while tree free:
    ready = queued tickets whose dependsOn are all done, ordered by (order, createdAt)
    if none: queue.state = idle; break
    engine.promote(ready[0].runId)      → ticket running (acquires the tree lock)

onRunSettled(runId, status)
  done    → ticket done; backlog status flip (§5); cascade-check dependents; pump
  failed  → classify blockedReason from state.error/artifacts (gates-exhausted |
            divergence | security-override); ticket blocked; dependents blocked
            (transitively); pump   — the queue itself NEVER stops for a ticket
  interrupted-by-restart → recovery pass requeues (§6)
```

Crash recovery on boot: for every project, reconcile `tickets/*.json` against `runs/*/state.json`
— tickets `running` whose run is `interrupted` → requeue (the engine's resume-from-disk handles
the session); tickets `clarifying` likewise re-enter their answers gates via the Inbox.

## 3. Contracts

| Boundary | Flows |
|---|---|
| ticket → run | `task = title + "\n\n" + description`; `ticketId` metadata on the run; queue-mode options (approvePlan forced off) |
| run → ticket | settle status + `state.error` / artifacts → ticket status + blockedReason |
| ticket → backlog | on `done`: if `sourceDoc` names a features doc, the flip commit lands on the base branch |
| Inbox → runs | aggregated view of every live `answers` gate for the project; answers post through the existing per-run API |
| queue → GUI | every transition broadcasts a queue snapshot over the existing WebSocket (`{type:"queue", project, state}`) |

## 4. Engine changes (surgical, additive)

1. **`stopAfterClarify` option** — after the spec locks (or immediately, if clarify off), the
   run settles into status **`clarified`** instead of continuing. Clarify-off + stopAfterClarify
   settles immediately with no spec (queue mode may allow spec-less tickets for trivial work).
2. **`engine.promote(id)`** — continues a `clarified` run into build/verify/security: flips
   `options.stopAfterClarify` off, re-enters `execute()` (which already skips clarify when the
   spec exists and re-checks out the run branch), settles as usual. Rejects if another run
   holds the project's tree.
3. **Phase-aware tree lock** — `activeRunFor` splits: clarify-only runs don't hold the tree;
   promoted/building runs do. `start()` allows N clarify-only runs per project, ≤1 tree-holding.
4. **`onSettled(status)` callback** on `start()` options — the queue's completion signal (the
   done-promise isn't exposed today; a callback keeps the queue decoupled from internals).
5. **`ticketId` passthrough** into run state (GUI joins, commit suffixes already cite F## ids
   from task text — no change needed there).
6. **Spec-freshness framing** (prompt-level): `builderSystem` + the `planning` skill gain a
   paragraph: *the spec may predate recent changes; if the repo contradicts the spec (referenced
   modules/APIs don't exist or changed shape), report it as divergence — "spec appears stale: …"*
   The existing divergence gate then parks the ticket with `stale-spec` classification (queue
   maps divergence during promoted runs to that reason).

Harness additions: stopAfterClarify settles `clarified`; promote continues and completes;
tree-lock split (two parallel clarify-only runs OK, second promote rejected while one builds);
onSettled fires on every terminal path (including the failure paths — the settle() refactor
from V12 makes this trivial to assert).

## 5. Backlog import & auto-status (`host/backlog.mjs`)

- **Import** — parse a project's own `docs/features.md` (the omni-isp pattern): sections
  headed `F##`/`OMNI-###` become tickets (`id`, `title`, body → `description`, doc path →
  `sourceDoc`); existing status markers (🔴/🟢) are read (🟢 imports as `done`) and stripped
  from the description. Also accepts pasted markdown or a JSON array. Lenient regex parsing;
  never modifies the file on import.
- **Status flip** — when a ticket reaches `done` and has a `sourceDoc`: rewrite 🔴 → 🟢 on its
  line in that doc and commit on the base branch: `chore: mark F02 done (F02)`. Safe because
  the queue serializes tree access. The v1 "stale backlog" verify guidance stays — now the
  tool keeps it honest mechanically.

## 6. Failure, recovery, and guardrails

| Condition | Behavior |
|---|---|
| Gates exhausted / divergence / security override | ticket `blocked` (+reason); dependents blocked; queue continues |
| Provider failures (rate limits, credits) over a wave | engine retries already; repeated settle-with-error → ticket `blocked: provider-failures`; queue continues (waves are parallel, so one bad model evening doesn't kill the batch) |
| Server crash / restart mid-queue | boot reconciliation requeues `running`/`clarifying` tickets from persisted state + runs; build sessions resume from disk (V9-proven) |
| Owner pause | `pause` parks the pump between tickets (current run finishes); `resume` restarts |
| Reorder | drag/edit `order` among `queued` tickets (never the running one) |
| Direct "Run now" | a ticket can always be started as a plain v2 run (bypasses the queue; respects the tree lock) |
| Token budget (optional, final phase) | per-queue cumulative cap → queue parks itself with a notice |

## 7. Server API & GUI

**Endpoints** (all under the existing server):

```
GET    /api/tickets/:project                  → ticket store + queue snapshot
POST   /api/tickets/:project                  → create {id?, title, description, dependsOn?}
PATCH  /api/tickets/:project/:id              → edit fields / reorder / status transitions
DELETE /api/tickets/:project/:id
POST   /api/tickets/:project/import           → { path? , markdown? , json? }
POST   /api/queue/:project                    → { action: clarify|release|pause|resume,
                                                   ticketId?, action: retry|reclarify }
GET    /api/inbox/:project                    → every live answers gate across clarify runs
POST   /api/runs                              → gains ticketId + stopAfterClarify passthrough
```

**GUI** (minimal, in the app's current idiom):

- **Tickets view** (new top-level switch: Runs | Tickets, per selected project): a compact
  table — status icon (lucide, same map as steps), id, title, deps, run link, blocked reason.
  Create/edit inline; import dialog (path or paste).
- **PM Inbox**: one screen aggregating all pending question batches, grouped by ticket,
  collapsible; submit per ticket through the existing answers flow. Empty state: "no questions
  pending". This is the clarification-wave UX — answering 10 tickets' PM rounds in one sitting.
- **Queue panel** (top of Tickets view): queue state chip (idle/clarifying/awaiting-release/
  running/paused), **Release** button with the batch spec review (each clarified ticket's spec
  rendered by the existing Review-tab card, checkboxes, "Release N tickets →"), pause/resume,
  and the blocked column with retry / re-clarify actions.
- Run pages unchanged — a queued ticket's run opens the familiar run view (steps, gates,
  artifacts, Review tab).

## 8. What is deliberately OUT of scope

Assignees, sprints, labels, comments/threads, notifications beyond the GUI, due dates,
burndown/charts, multi-assignee workflows, epic hierarchies (use `dependsOn` + id conventions),
permissions (single-owner tool), webhooks. If a future need argues for one of these, it gets
its own plan — none of them is load-bearing for "backlog → gates-enforced delivery".

## 9. Validation plan (live, post-implementation — same discipline as V1–V12)

| # | Scenario | Pass criteria |
|---|---|---|
| W1 | Import a 3-ticket `docs/features.md` into sandbox (git-init'ed); clarify wave; answer Inbox; release | all 3 tickets `done` sequentially; each merged with `feat: … (F##)`; backlog shows 🟢 ×3 |
| W2 | Dependency chain: F2 dependsOn F1; F1 blocked (planted mechanical failure, fix rounds 0) | F1 `blocked`, F2 auto-blocked, F3 independent proceeds and completes; main never contains F1's code |
| W3 | Staleness: F2's spec references a module F1's build renamed | F2's planner divergence "spec appears stale" → parked `stale-spec` → re-clarify → done |
| W4 | Parallel clarify: 3 PM runs at once, one Inbox screen | all three specs locked from one sitting; no tree contention |
| W5 | Pause mid-queue; reorder remaining | current ticket finishes, pump parks; new order respected on resume |
| W6 | Kill server mid-queue; restart | reconciliation requeues; build session resumes from disk; queue finishes |
| W7 | Two projects' queues simultaneously | both run in parallel; per-project serialization holds |
| W8 | Direct Run-now while queue running | rejected with the existing one-active-run guard (tree lock) |

Unit coverage alongside: ticket store CRUD/import/parse, queue transitions with a fake engine
(park, cascade, pump order, release, recovery reconcile), engine harness scenarios for
stopAfterClarify/promote/tree-lock/onSettled.

## 10. TODO — sequenced implementation checklist

> Strictly ordered; each item completes with only the items above it.

### Phase 0 — Groundwork

- [ ] **1. Branch + plan** — `git checkout -b v3-ticket-queue` from `main`; commit this doc.
- [ ] **2. Engine: `stopAfterClarify` + `clarified` status** — settle after spec lock (or
  immediately when clarify off); harness scenario: run settles `clarified` with spec artifact,
  no build session created.
- [ ] **3. Engine: `promote(id)` + phase-aware tree lock** — promote continues a `clarified`
  run through build/verify/security; second promote/tree-holding start rejected while one runs;
  clarify-only starts allowed in parallel. Harness: two parallel clarify-only runs → promote
  one → promote the other rejected → first settles → second promote succeeds.
- [ ] **4. Engine: `onSettled` callback + `ticketId` passthrough** — callback fires on every
  terminal path (completed/failed/cancelled/clarified); ticketId stored in state. Harness
  asserts firing on the failure path specifically (the V12 lesson).

### Phase 1 — Ticket store

- [ ] **5. `host/tickets.mjs`** — store, CRUD, transitions with history, persistence to
  `tickets/<project>.json`, queue config block. Unit tests (fs fixture).
- [ ] **6. `host/backlog.mjs` — parser** — `docs/features.md` → tickets (id/title/description/
  sourceDoc, 🔴/🟢 awareness), lenient headings, JSON import. Unit tests with the omni-isp
  features doc shape + edge cases.
- [ ] **7. Server: ticket CRUD + import endpoints** — the five REST routes above; validation
  errors as 400s. Curl smoke.

### Phase 2 — The queue

- [ ] **8. `host/queue.mjs` — wave + settle bookkeeping** — startClarifyWave (parallel
  clarify-only runs via stopAfterClarify), onSettled → ticket transitions, blockedReason
  classification from run state. Unit harness with a fake engine.
- [ ] **9. Pump + park + dependency cascade** — release, ready-set ordering (order, createdAt),
  tree-lock-aware promote loop, blocked cascade (transitive), retry/reclarify actions. Unit
  harness: W2's dependency scenario against the fake engine.
- [ ] **10. Persistence + crash recovery** — queue snapshot broadcast, boot reconciliation
  (interrupted runs → requeue), pause/resume. Unit: simulate restart by reconstructing the
  manager from disk.
- [ ] **11. Server: queue + inbox endpoints** — actions, snapshots, aggregated Inbox. Curl smoke.

### Phase 3 — Prompts & freshness

- [ ] **12. Spec-freshness framing** — `planning` skill + `builderSystem` staleness paragraph;
  queue maps divergence on promoted runs → `stale-spec`; `reclarify` seeds a fresh clarify run
  with the old spec + reason appended to the task.

### Phase 4 — GUI

- [ ] **13. api.ts + Tickets view** — types, endpoints, Runs|Tickets switch, ticket table with
  status icons, create/edit, import dialog.
- [ ] **14. PM Inbox** — aggregated answers screen (per-ticket groups, GatePanel answer
  rendering reused), submit per ticket.
- [ ] **15. Queue panel** — state chip, Release flow with batch spec review (Review-tab spec
  cards + checkboxes), pause/resume, blocked column with retry/reclarify, WS `queue` messages.
- [ ] **16. Backlog flip integration** — queue posts `chore: mark F## done` on the base branch
  via existing git helpers; W1 verifies the doc actually flips.

### Phase 5 — Validation & ship

- [ ] **17. Unit suites green** — engine harness (new scenarios), queue harness, store/parser
  tests; `npm test` wires them all.
- [ ] **18. Live W1–W8** (§9) on sandbox/git fixtures — owner-run discipline, record results
  in `docs/V3-VALIDATION.md` (same format as V2's).
- [ ] **19. README + docs refresh** — queue mode section, Inbox, tickets, guardrails.
- [ ] **20. Merge + tag** — ff-merge `v3-ticket-queue` → `main`, tag `v3.0.0`, push.

---

## 11. Risks

| Risk | Mitigation |
|---|---|
| Spec staleness corrupts later builds | divergence-as-detector (§4.6), dependency-layered waves as a habit for coupled features, re-clarify action |
| One bad ticket poisons the tree | verdict-gated merge (failed code never lands); whole-suite verify as the regression net |
| Queue logic creeps into the engine | queue = separate module over the engine API; engine changes capped at §4's list |
| GUI complexity creep | two views max (Runs, Tickets); everything else reuses run pages |
| Long-wave token burn | parallel clarify is read-only and bounded (≤1 per ticket); optional budget cap is the last phase, not the first |
| Scope creep toward JIRA | §8 is a contract: anything on that list requires a new plan |

*v3 converges on the reference workflow's proven shape — batch PM cycles, sequential ticket
execution, per-ticket verification — with the v2 improvement that every transition is
driver-owned and every definition-of-done is mechanically enforced.*
