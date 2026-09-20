# v3 implementation audit — plan vs code

**Date:** 2026-09-21  
**Auditor:** Claude (post-implementation review, branch `v3-ticket-queue` @ `cdb1ef2`)  
**Subject:** `docs/PLAN-v3-ticket-queue.md` (all TODOs 1–19 marked done) vs the actual code  
**Method:** line-by-line read of `host/engine.mjs`, `host/queue.mjs`, `host/tickets.mjs`, `host/backlog.mjs`, `host/server.mjs`, `web/src/App.tsx`, `web/src/api.ts`, `web/src/components/TicketsView.tsx`, prompts/skills, and all four test suites (36/36 green at audit time), each checked against the plan's §2–§7 contracts.

**Verdict:** the architecture matches the plan (two-phase scheduler over the engine, park-don't-block, spec staleness via divergence, tickets outside repos) and the unit suites genuinely cover what they claim. But **six flows that the live validation W1–W8 depends on are broken end-to-end**, plus several §7 GUI contracts were never built. The gaps below are ordered by severity; each was fixed on this branch after this document was committed (fix commits reference the gap ids).

**Outcome (same day, after the fixes):** every gap below marked FIXED is fixed on this branch — commits `14ebdca` (A1), `926170c` (A2, A3), `09858c8` (A4), `a8a76ae` (A5), `e59401e` (A6, C1, C2), `0e278ba` (B1, C3, C6), `b550e49` (C5), `3418da7` (B2–B7, C4). Suites grew from 36 to **47 checks** (19 engine + 3 watchdog + 6 tickets + 7 backlog + 12 queue), all green; GUI rebuilt. W1–W8 owner validation still pending, as the plan requires.

## A. Broken end-to-end flows

### A1 — Import creates nothing (W1 fails at step 1)

`POST /api/tickets/:project/import` (`host/server.mjs`) only **parses** and returns the ticket list; nothing ever calls `createTicket`. The GUI shows "Imported N ticket(s)" and refreshes an unchanged store — `TicketsView.tsx`'s import buttons never POST the parsed tickets either. Consequences:

- W1 step 1 (import a 3-ticket features doc) is a no-op; the whole queue flow can't start from an import.
- Plan §5's "🟢 imports as `done`" has no path — `createTicket` only creates drafts.
- Plan §7's `{ path?, markdown?, json? }` contract: `json` is not accepted.

### A2 — Any server restart strands the queue (W6, and the plain restart-then-release flow)

`engine.promote()` only works for runs in the in-memory `runs` map. Clarified runs live on disk (`runs/<id>/state.json`, status `clarified` — the boot sweep correctly leaves them alone), so after a restart:

- `release()` → `pump()` → promote → `run not active in this server session` → "promotion deferred" → the ticket sits `queued` forever with queue state `running`. Nothing re-pumps.
- `recoverProject()` requeues interrupted builds but never resumes them — `pump` hits the same dead end.
- `engine.resumeFromDisk()` rejects status `clarified` (only `cancelled|failed|interrupted`), so there is no engine path to continue a parked clarify run after a restart.

Plan §2.4/§6: "boot reconciliation requeues … build sessions resume from disk". The requeue half exists; the resume half does not.

### A3 — `retry` breaks the queue loop

`queue.retry()` → `engine.resumeFromDisk()` builds the run object **without `onSettled`**. The retried run completes and nobody tells the queue: the ticket stays `running` forever, dependents never unblock, the pump never advances. Two adjacent defects in `resumeFromDisk`:

- the run object never sets `holdsTree` — a resumed build does not register in `treeLockHolder`, so a second run could start and trample the same tree (a W8-class hole);
- it rejects while **any** run is active on the project, including read-only clarify runs — stricter than the phase-aware lock law everywhere else.

### A4 — Owner hard-cancel of a queue run never fires `onSettled`

`finalizeCancel()` (the `engine.cancel()` out-of-band path) resolves the done-promise but never invokes `run.onSettled`; `execute()`'s catch then returns early because `finalized` is set, so `settle()` never runs either. A queue-owned ticket whose run the owner cancels from the run page is stranded in `running` forever. TODO 4's claim "callback fires on every terminal path" is only harness-true for the in-band gate-cancel path — the hard-cancel path was never exercised.

### A5 — A completed ticket never un-blocks its dependents

The cascade (`blockedOn`) blocks transitively on failure, but nothing reverses it: when a blocked ticket is retried and completes, dependents parked with `depends on <id>` stay blocked. W2's pass criteria promise the opposite ("if it passes, F11 unblocks (pump)"). `release()` only re-queues `clarified` tickets, so the blocked dependents can never run again without hand-editing `tickets/<project>.json`.

### A6 — Backlog flip: writes before the tree check; commit races the next promote

`flipBacklog()` in `host/queue.mjs`:

- `fs.writeFileSync` happens **before** the `treeLockHolder` check — if another run holds the tree, the flip is written into whatever branch that run has checked out (the running ticket's branch), never landing on base as §3 requires ("the flip commit lands on the base branch");
- the commit is fire-and-forget while `onBuildSettled` synchronously calls `pump()` — the next ticket's promote can `git checkout` a new branch while the flip commit is still staging, carrying the uncommitted doc change onto the run branch (or failing the commit).

Also: the flip notice event is emitted under a bogus runId `"queue"` (creates a stray `runs/queue/` events dir).

## B. Plan-§7 contracts never built

| Id | Missing | Plan text |
| --- | --- | --- |
| B1 | `reclarify` starts a plain fresh run — the old spec and the park reason are NOT appended to the task | §2.2 / TODO 12: "fresh clarify run seeded with the old spec + the reason" |
| B2 | `POST /api/runs` ignores `ticketId` and `stopAfterClarify`; no per-ticket "Run now" in the GUI | §7 route contract; §6 "Direct Run now" |
| B3 | No queue-config editor in the GUI (models only, via the wave dialog). Fix Rounds / Security / Git / Audit / Remote CI are uneditable — W2 requires "Fix Rounds: 0" via the GUI | §2.3 "queue-mode run defaults (GUI-editable)" |
| B4 | No ticket edit UI (title/description/deps/order) and no reorder UI. Server `PATCH` and the `reorder` action exist unused — W5's "edit F33's order to 0" requires hand-editing the JSON store | §7 "Create/edit inline"; §6 "Reorder" |
| B5 | Release is a bare button — no batch spec review, no checkboxes, no per-ticket selection | §7 "Release button with the batch spec review (each clarified ticket's spec rendered …, checkboxes, 'Release N tickets →')" |
| B6 | Inbox has no empty state (the block is simply hidden) | §7 "Empty state: 'no questions pending'" |
| B7 | GUI ignores the `queue`/`tickets` WS broadcasts; TicketsView relies on 4 s polling only | §3 "every transition broadcasts a queue snapshot over the existing WebSocket" (server side ✓, GUI consumption ✗) |

## C. Correctness nits

- **C1** — `backlog.flipStatus()` with `done=true` on a heading **without** a 🔴 marker replaces the whole line via `HEAD_RE`, dropping the `## ` / `**` markup — the flip demotes the heading in the doc.
- **C2** — flip commit message is `chore: mark F02 done (queue)`; §5 specifies `chore: mark F02 done (F02)` (the F## commit-suffix convention the rest of the engine follows).
- **C3** — a wave whose every start throws (provider down), or an empty wave, leaves queue state stuck at `clarifying` — only a settle callback reaches `awaiting-release`.
- **C4** — server applies `setQueueConfig` **after** `startClarifyWave` in the `clarify` action, so models passed in that request apply to the *next* wave (the GUI works around it by pre-saving via `config`, but the API contract is inverted).
- **C5** — every `failed` build settle is classified `gates-exhausted`; provider-type failures (watchdog aborts, rate limits) should classify `provider-failures` per §2.4 ("classify blockedReason from state.error/artifacts") and §6.
- **C6** — the clarify allowlist includes `"failed"` in both `queue.mjs` and `TicketsView.tsx` — not a ticket status; dead branch.

## D. Deliberate deviations (documented, no fix needed)

- `PATCH /api/tickets/:id` does not do raw status transitions — transitions go through queue actions, which own legality (the safer reading of §7; semantics preserved).
- Default `config.options.security` is `off` where the plan's schema example shows `"scan"` — a safer default for a fresh queue; editable once B3 lands.
- Ticket create in the GUI offers no explicit `id` field (auto ids; the API accepts `id`). §7's `create {id?, …}` remains satisfied server-side.

## Test-coverage blind spots (why the suites stayed green)

- The queue fake's `resumeFromDisk` returns `{ok:true}` without wiring any callback — A3 was untestable by construction.
- The engine harness cancels only via gates (`autoGate: ["cancel"]`), never `engine.cancel()` — A4 never ran.
- No test releases, restarts, retries, un-cascades, or imports-then-reads-the-store — A1/A2/A5 invisible.
- `flipStatus` is unit-tested only on marker-bearing lines — C1 invisible.

## Fix plan (executed after this file was committed)

| Fix | Gaps | Status |
| --- | --- | --- |
| 1. Import creates tickets (done-flag aware, skip existing, `json` accepted) | A1 | FIXED — `14ebdca` |
| 2. Promote/resume across restarts: `resumeFromDisk({onSettled, promote})`, pump fallback, retry wiring, `holdsTree`, phase-aware check | A2, A3 | FIXED — `926170c` |
| 3. `finalizeCancel` fires `onSettled` | A4 | FIXED — `09858c8` |
| 4. Completion un-blocks dependents (dependency-blocked whose deps are all done → `queued`) | A5 | FIXED — `a8a76ae` |
| 5. Flip safety: tree check before write, pump waits for the commit, heading preserved, `(F##)` suffix, real runId for notices | A6, C1, C2 | FIXED — `e59401e` |
| 6. Re-clarify seeds old spec + reason; wave can't stick at `clarifying`; drop dead `failed` status | B1, C3, C6 | FIXED — `0e278ba` |
| 7. `POST /api/runs` passthrough + per-ticket Run now | B2 | FIXED — `3418da7` |
| 8. GUI: queue-config editor, batch spec review at release, inline edit + reorder, Inbox empty state, WS-driven refresh; server: config before wave, release ticket filter | B3, B4, B5, B6, B7, C4 | FIXED — `3418da7` |
| 9. Provider-failure classification for failed builds | C5 | FIXED — `b550e49` |

W1–W8 remain deferred to the owner exactly as the plan states — but with these fixes the runbook's steps are now actually executable (import creates tickets; reorder/edit/config exist in the GUI; retry unblocks the cascade; a restart no longer strands the queue).
