# nano-cycle v3.1 — Single-PM clarification waves

**Status:** RELEASED in v3.1.0 — owner-validated live on glm-monitor (one PM wave for F06+F07 → batch release → two sequential verified/merged/flipped deliveries).  
**Supersedes:** the wave mechanics of `docs/PLAN-v3-ticket-queue.md` §2.4 (one PM run per ticket). Everything else in v3 — sequential delivery, park-don't-block, dependency cascade, release gate, backlog flip — is unchanged.  
**Evidence:** live glm-monitor wave 2026-09-21 13:44 — F06 and F07 clarified as two isolated PM runs; F07's PM, seeing a tree where F06 doesn't exist yet, asked the owner whether it should build both. Cross-feature decisions were impossible to make coherently; the owner paid for two investigations of the same repo and got a confused question as the dividend.

## 1. What we are building and why

**The owner's model (correct, and now the law):** a clarify wave is **one PM
conversation for the whole batch**. One run investigates the repo once, asks
one batched set of questions (the PM Inbox shows one item for the wave),
resolves cross-feature decisions once, and locks **one spec per ticket**.
After the release gate, the existing machinery takes over unchanged: each
ticket builds/verifies/secures **sequentially in its own run**, one at a time.

```txt
            ┌───────── ONE WAVE RUN (read-only, tree-free) ─────────┐
            │  one PM · one project investigation · one Q&A loop    │
            │  finalize_spec(F06, …) · finalize_spec(F07, …)        │
            │  parks as 'clarified' with artifacts.specs{F06,F07}   │
            └───────────────────────────┬───────────────────────────┘
                                       ▼  release gate (per-ticket spec review)
            ┌──────────── BUILD PUMP (sequential, unchanged) ───────┐
            │  per ticket: NEW build run seeded with its wave spec  │
            │  build → verify → security → merge → next ticket      │
            │  gates PARK tickets, never the queue                  │
            └───────────────────────────────────────────────────────┘
```

Why this is right, beyond taste:

1. **Backlog features are a chain, not a bag.** F07 builds on F06; two PMs
   clarifying them in isolation cannot see each other's decisions. One PM
   makes the chain coherent (shared conventions, no duplicated questions, no
   "should I also build F06?" confusion).
2. **One owner sitting.** The PM Inbox shows one item per wave — the batched
   PM cycle the reference workflow had, which v3's own intro promises.
3. **Cheaper.** One investigation of the repo instead of N. Clarify waves were
   already read-only; now they are also single-session.
4. **Nothing downstream changes.** Specs remain per-ticket artifacts with the
   exact same schema; the build pump, parking, cascade, flip, and recovery
   keep working on per-ticket build runs as they do today.

### Alternatives considered and rejected

- **Keep N parallel PM runs, give each the others' briefs.** Still N
  investigations, still conflicting decisions, still N Inbox items; the owner
  answers overlapping questions anyway. Rejected.
- **Run the wave PM as a bespoke queue-owned session (chat.mjs style).**
  Reimplements the answers-gate plumbing, the Inbox, event streaming, resume,
  and spec persistence that engine runs already have. Rejected — the wave run
  IS an engine run.

## 2. Design decisions (locked)

| # | Decision |
| --- | --- |
| D1 | A wave is **one engine run** with `waveTickets: [{id, title, description, dependsOn}]` and `stopAfterClarify: true`. It reuses the whole run machinery (gates, events, Inbox, sessions, disk persistence). |
| D2 | Spec locking is **incremental per ticket**: in wave mode `finalize_spec` carries a `ticket_id` parameter and the existing per-feature schema; the driver records into `state.artifacts.specs` (map by ticket id). Re-finalizing a ticket before wave completion overwrites. The clarify phase completes when **every** wave ticket has a spec. No giant compound artifact — a 22-ticket wave stays human-sized. |
| D3 | Build runs are **seeded, not promoted**: new `engine.start` option `seedSpec` seeds `run.spec` (and `state.artifacts.spec`), clarify never runs, `source_docs` flow into the build as requirements source. The pump starts a fresh run per ticket with `ticketId` + `seedSpec` from the wave run. `engine.promote()` remains a public API (legacy/harness) but the queue no longer calls it. |
| D4 | `ticket.runId` lifecycle: **wave run** while clarifying/clarified (spec provenance + Inbox linkage) → replaced by the **build run** id when the pump starts it. |
| D5 | Pump discriminator (start-fresh vs resume): read `runs/<ticket.runId>/state.json`. `state.wave === true` (or status `clarified` without build milestones) → fresh seeded start. Otherwise (interrupted/failed/cancelled build with milestones kept) → resume the existing build run in-session or from disk (today's retry machinery). `retry()` only resumes build-phase parks; a wave-phase park answers "re-clarify". |
| D6 | **Legacy-compatible by construction**: spec lookup is `artifacts.specs[t.id] ?? artifacts.spec`. Existing clarified runs (F06, F07 on glm-monitor today) release into seeded builds with zero migration. |
| D7 | One PM round minimum stays OFF (`requireQuestions: false` — queue law: the spec is the owner's gate, not a forced question). The wave BRIEF carries the cross-feature duty instead. |

## 3. The wave brief (the PM's task text)

Composed by the queue from the ticket store at wave start:

```txt
You are the PRODUCT MANAGER for a WAVE of N features of project <name>.
The features will be BUILT SEQUENTIALLY in dependency order after this
clarification — your specs are the contract each build gates on.

## Already built (present in the working tree)
<ids + titles of done tickets>            ← investigate these, don't re-ask

## This wave (lock one spec per feature)
### F06 — <title>
<description>
(depends on F05 — built; F08 — NOT in this wave, clarified later)

### F07 — <title>
<description>
(depends on F06 — earlier in THIS wave; assume its spec as locked)

## Later (out of this wave — do not spec)
<ids + titles>

Ask questions ONCE for shared concerns (style, stack, conventions), resolve
cross-feature decisions coherently, then call finalize_spec once per feature.
```

Sections with no tickets are omitted. `reclarify` waves (single ticket) keep
the existing RE-CLARIFICATION CONTEXT suffix (old spec + park reason; the seed
reader gains the `specs[id] ?? spec` fallback).

## 4. Engine changes (surgical, additive — `host/engine.mjs`)

1. **`waveTickets` option on `start()`** → persisted as `state.wave = { ticketIds }`
   (plus the tickets themselves for the clarify loop). Steps list unchanged
   (clarify/build/verify/security): a wave run simply parks after clarify.
2. **Clarify phase, wave mode:**
   - The prompt is the composed wave brief (passed as `task`; `clarifyPrompt`
     machinery unchanged).
   - `finalize_spec` gains `ticket_id` (schema: existing spec schema +
     `ticket_id` literal of a wave ticket). Driver validation, REJECTED-tool-result
     style, mirrors `submit_plan`: unknown/absent ticket id, ticket already
     final and wave complete, empty acceptance criteria. On accept: record
     `state.artifacts.specs[ticket_id]`, emit a per-ticket notice (AC count),
     re-ask nothing.
   - Phase exit: all wave tickets covered → `stopAfterClarify` parks the run
     as `clarified` exactly as today (empty-branch cleanup included). A
     non-wave run keeps today's single-spec behavior byte-for-byte.
3. **`seedSpec` option on `start()`**: `run.spec = seedSpec ?? null`,
   `state.artifacts.spec` seeded, clarify skipped by the existing
   `options.clarify && !run.spec` guard. Works with `clarify: false` (the
   queue's build runs) — the spec is provenance, not a phase.
4. **No other engine surface changes.** Tree lock, onSettled, ticketId
   passthrough, divergence/security gates, fix rounds: untouched. A wave run
   holds no tree (already the law for stopAfterClarify runs).

## 5. Queue changes (`host/queue.mjs`)

1. **`startClarifyWave`** starts ONE run (`<newRunId()>-wave`), sets every
   wave ticket to `clarifying` with `runId` = the wave run, and its single
   `onSettled` maps the settle to ALL wave tickets: `clarified` → all
   `clarified`; `cancelled` → all `draft`; else → all `blocked:
   provider-failures`. `syncQueueState` derivation needs no change.
2. **`specForTicket(t)`**: read `runs/<t.runId>/state.json` →
   `artifacts.specs[t.id] ?? artifacts.spec ?? null`. Disk is the source of
   truth (restart-safe by construction). A clarified ticket with no
   retrievable spec parks `blocked: provider-failures,
   "no spec on the wave run — re-clarify"` (generalizes today's no-runId path).
3. **Pump → `startOrResumeBuildRun(project, t)`** (replaces `promoteRun`):
   - Discriminator per D5. Fresh start: `engine.start({ id: <ts>-<ticketid>,
     task: title + description, seedSpec: specForTicket(t), clarify: false,
     models: cfg.models, git/audit/security/maxFixRounds/remoteChecks: cfg,
     ticketId: t.id, onSettled: buildCallback })`, then
     `setTicketStatus(running, runId: newId)`.
   - Resume branch: today's `engine.resume` → `resumeFromDisk({ onSettled })`
     pair, unchanged.
   - Build-settle handling (`onBuildSettled`), cascade, un-block sweep,
     backlog flip, failure classification: unchanged — they already key on
     per-ticket build runs.
4. **`retry`** guards the run phase: if `runs/<runId>/state.json` says
   `wave`, return `{ ok: false, error: "parked at the clarify stage — use
   re-clarify" }` (resuming a wave run for one ticket is meaningless).
5. **`reclarify`** starts a single-ticket wave (same machinery); its seed
   reader uses the D6 fallback.
6. **Crash recovery** — verify, don't redesign: `clarifying` + interrupted
   wave run → all its tickets `draft` (re-wave); `clarified` tickets keep
   pointing at the wave run on disk (D6); `running` + interrupted build run →
   requeue → pump resumes it (D5). Test each.

## 6. Server, Inbox, GUI, MCP

- **Inbox** (`/api/inbox/:project`): items gain `waveTicketIds:
  st.wave?.ticketIds ?? null`; label shows the wave's ticket ids when
  `ticketId` is null (one item per wave now). Answers post to the wave run —
  flow unchanged.
- **Release gate** (`ReleaseReview`): per-ticket spec fetch dedupes by `runId`
  (N tickets → 1 request) and reads `artifacts.specs[t.id] ?? artifacts.spec`.
- **Run page**: a wave run's Review/artifacts surface shows the specs map —
  minimal addition (a per-ticket spec card list); if generic artifact
  rendering covers maps, nothing to do. Release gate remains the primary
  spec-review surface.
- **Tickets view**: wave button hint → "one PM conversation for every
  selected ticket"; `QUEUE_STATE_HINT.clarifying` wording matches.
- **MCP**: `nano_queue` clarify description updated (single PM run);
  `nano_get_run` already returns state verbatim.
- **Runbook** (`docs/V3-VALIDATION.md`): W4's pass criteria reword — ONE
  `awaiting-answers` run whose Inbox item carries the wave's tickets; W1's
  step 3 shows one batched item.

## 7. What deliberately does NOT change

Sequential delivery, one tree-holding build at a time; park-don't-block and
the dependency cascade; the release gate as the one human moment; verdict-gated
merge; backlog flip; stopAfterClarify/clarified semantics; the four-step
engine; `engine.promote` as a public API; direct "Run now"; per-ticket verify
as the regression net (later tickets run the whole suite on a tree that now
contains earlier wave features — free cross-feature regression coverage).

## 8. Migration & compatibility

- **Live stores today:** glm-monitor F06/F07 are `clarified` with their own
  single-spec runs → D6 fallback releases them into seeded builds unchanged.
  omni-isp drafts → the next wave is automatically single-PM. No store
  migration code.
- **Old wave-era artifacts:** any `clarified` ticket whose run has
  `artifacts.spec` only — same fallback.
- **`tickets/*.json` schema:** unchanged (runId semantics per D4).

## 9. Test plan

Engine harness (new scenarios):

- wave clarify happy path: one run, `finalize_spec` per ticket, coverage
  completes → parks `clarified` with `artifacts.specs{F06,F07}`, no build
  session, empty-branch cleanup.
- finalize validation: unknown ticket id REJECTED; duplicate finalize
  overwrites; wave incomplete → phase continues asking.
- `seedSpec`: build run with `clarify: false + seedSpec` skips clarify,
  builder prompt carries the spec (assert spec text in the recorded build
  turn), `state.artifacts.spec` seeded; source_docs present in builder input.

Queue tests (fake engine extended: records `starts`, `settleBuild(runId)`):

- Q15 wave: TWO tickets → exactly ONE `engine.start` with `waveTickets[2]`;
  settle `clarified` → both tickets `clarified`, both `runId` = wave run;
  queue `awaiting-release`.
- Q16 release: pump starts ticket F06's build with `seedSpec` = F06's spec
  (read from the wave `state.json` fixture) + `ticketId`; on its settle F07's
  build starts; flip/cascade/idle as today.
- Q17 crash mid-build: requeue → pump RESUMES the interrupted build run
  (milestones kept), does not re-seed.
- Q18 release after restart: wave run only on disk → seeded starts (replaces
  today's promote-from-disk queue test; the engine promote-from-disk harness
  scenario stays — public API).
- Rework Q1/Q2/Q5/Q6/Q8/Q9/Q10 fixtures to the new linkage (Q3's watcher
  shape and Q13/Q14 are untouched by construction).

Live validation: W1–W8 re-run; W4's criteria as in §6.

## 10. TODO — sequenced implementation checklist

> Strictly ordered; each item completes with only the items above it.

### Phase 0 — Engine

- [x] **1. `seedSpec` on `start()`** — seed `run.spec`/`state.artifacts.spec`,
      clarify skipped; harness: seeded build carries the spec.
- [x] **2. `waveTickets` + wave clarify loop** — brief-aware finalize_spec
      with `ticket_id`, validation, incremental `artifacts.specs`, coverage
      exit; `state.wave`; harness: happy path + REJECTED/overwrite/continue.

### Phase 1 — Queue

- [x] **3. Single-run waves** — one `engine.start`, all-wave-ticket settle
      mapping; Q15.
- [x] **4. `specForTicket` + `startOrResumeBuildRun`** — pump seeded starts
      vs resume discriminator; no-spec park; Q16, Q18 (rework Q2/Q6).
- [x] **5. retry guard + reclarify seed fallback + recovery verify** — Q17;
      rework Q5/Q8/Q9/Q10 fixtures.

### Phase 2 — Surfaces

- [x] **6. Inbox `waveTicketIds` + label; ReleaseReview spec dedupe/fallback;
      hint texts; run-page wave-specs card (if needed).**
- [x] **7. MCP description + runbook W1/W4 wording; plan-doc amendment note.**

### Phase 3 — Ship gate

- [x] **8. Full suite green (65+ checks), GUI build, headless smoke of a
      2-ticket wave → one Inbox item → release → sequential builds.**
- [x] **9. Owner live validation W1–W8 → then the v3.0.0 merge+tag.**

## 11. Risks

| Risk | Mitigation |
| --- | --- |
| One PM context overload on big waves (omni-isp = 22) | D2 incremental locking (no giant artifact); the brief caps prose; waves stay owner-sized — dependency-layered waves remain available for huge backlogs |
| Cross-ticket spec drift inside one conversation | Same per-ticket schema + validation as today; the release gate reviews EVERY spec before release (unchanged human moment) |
| Seeded builds lose the "spec locked this run" provenance | `state.artifacts.spec` IS the seeded spec — Review tab and `source_docs` outranking work identically |
| Restart between wave and release | Specs live in the wave run's state.json on disk — D6 lookup is disk-based by construction |
| Divergence gate parking a seeded build | Unchanged machinery — the staleness detector (§4.6 of the v3 plan) works identically on seeded specs; park → re-clarify re-waves one ticket |

*v3.1 keeps v3's promise — batch PM cycles, sequential ticket execution,
per-ticket verification — and fixes the one place the implementation
diverged from the imagined workflow: the batch in "batch clarification".*
