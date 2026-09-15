# Why the deterministic pipeline falls short of the Claude workflow — root-cause analysis and a path forward

**Feature under test:** F01 — Monorepo scaffold & one-command local environment  
**Reference:** `/home/munna/archive/backup/master-reference` — Claude Code workflow (`.claude/` skills + agents + rules), implemented F01 twice (first run: 4 tickets, 22 commits on `feature/F01-monorepo-scaffold`; rebuild: 4 commits `0902524..22e9453`)  
**Pipeline:** nano-cycle (pi SDK) — 5 implementation attempts on `/home/munna/sonic/localhost/omni-isp`, 2026-09-14 → 09-15  
**Prior audit:** `draft.md` — reference wins ≈ 87% of 30 scored dimensions; current tree ships 4 High defects (dead migration scripts, hangable health endpoint, CDN Bengali fonts → live tofu, uncommitted/unproven CI)  
**Date:** 2026-09-15 · **Method:** three parallel deep-read investigations (reference governance, reference F01 execution artifacts, run forensics over `runs/*/state.json` + `events.jsonl`), direct code reading of `host/*.mjs`, live repo inspection, and web research on multi-agent architecture evidence

---

## 0. Executive summary — the ten findings

The question was "what are we doing wrong?" The evidence says it is **not one thing, and the biggest things are not where you were looking**:

1. **The gates are not the problem — they worked.** Your verify/audit nodes empirically caught most of what `draft.md` later found (broken i18n persistence proven by a scratch test, dead migration scripts, ERESOLVE lockfile desync, undeclared deps proven by clean-room `npm ci`, tests covering unrouted components). Run 4 passed both gates outright.
2. **A natural experiment you already ran says the builder model is the dominant factor.** The only attempt with all-coder nodes on the strong model (`glm-5.3`, run 4) is the only one that converged to both gates green. Every attempt with coders on free-tier/flash models (`muse-spark-1.3-contributor-free`, `mimo-v2.5-free`, `glm-5.3-flash`) produced the "sloppy substrate" defect class and whack-a-mole fix rounds.
3. **You compared the reference against your worst tree, not your best one.** Run 4's gate-passing implementation (8 commits on `feature/OMNI-001-monorepo-scaffold`) was discarded before run 5; run 5 was forbidden to commit ("do not commit anything"), cancelled 7 seconds into its final fix round, and *that* half-finished tree is what `draft.md` audited. Three complete implementations were thrown away across five runs.
4. **A structurally unverifiable acceptance criterion burned the fix budget.** "CI blocks merge on GitHub / pipeline under 10 min hosted" can't be verified without a GitHub remote — no run had one. It failed runs 3 and 5 in every round, consuming fix rounds no coder could spend productively. The reference solved the same tension with a `❓ deferred (owner override)` verdict *and actually had `gh` + a remote, so its CI claims were observed, not assumed.*
5. **Coders are blind to the contract.** `implementPrompt` passes the spec *summary* and *decisions* and a file list — never the acceptance criteria, never the source doc, never the design guideline. The reference dispatches every coder with the ticket body + verbatim ACs + findings digest + named files.
6. **Coders never see the testing rules.** `rules.mjs` injects `testing-rules.md` into verify/audit only. Your coders produced 7 tests where the reference produced 41, and e2e with stubbed DB — exactly what `testing-rules.md` forbids ("The database is never mocked") — because the coders never read that file. The reference's coder agent files embed the full testing contract.
7. **The built-in coder rule actively suppresses quality.** `config.mjs` injects "Keep it minimal — implement exactly the task, nothing extra" into every implement node — the exact opposite of the reference coder's "Implement the task fully. Every artifact it needs… No stubs, no TODOs" plus a 60-line engineering rulebook. Combined with `thinking: "low"`, you get scaffold-shaped output.
8. **Context is relayed as thin, one-shot JSON between fresh sessions.** Each node is a brand-new context whose only inheritance is a `task_summary` string and file lists. The reference workflow evolved in the *opposite direction* (its own WORKFLOW-AUDIT §9 Tier 2): keep plan/tasks synthesis in one fat, prompt-cached context and spawn only isolated coders. Cognition's "Don't Build Multi-Agents" principles call nano-cycle's shape the anti-pattern: condensed subtask handoffs, parallel writers making independent implicit decisions in one tree.
9. **Fix rounds requeue everything with a feedback blob.** All coder nodes re-run from scratch each round (run 3 executed ~20 coder sessions across 4 passes), previously-fixed work can regress, and emergent hot files collide (four different nodes each edited `LanguageSwitcher.tsx` in one round). The reference writes a minimal fix-tasks file — one task per gap, AC quoted — and dispatches only those.
10. **Determinism was applied to the wrong layer.** You mechanized sequencing, spawning, and prompts (fine) while starving judgment nodes of context; the reference mechanized the boundaries (branching, commits, gates, CI watch, watchdog) and kept judgment fat. The fix is not more determinism or less — it's determinism at the gates, context at the desk.

**Bottom line:** the pipeline is maybe six concrete changes away from reference-class output *with the models you already pay for* (§6, Track 2), and there is a zero-code Track 0 (stop discarding gate-passing work; give runs a remote so CI criteria are observable) that would have changed the last audit's verdict on its own.

---

## 1. Evidence base

| Source | What it yielded |
| --- | --- |
| `runs/20260914-{160010704,170531968,190712755,224521066}` + `runs/20260915-210945251` `state.json`/`events.jsonl` | Verbatim task strings, per-role models, specs (AC lists quoted), plan capabilities, coder artifacts/retries/durations, verify checks + evidence, audit findings, fix-round traces, token usage, cancel-time state |
| `host/{pipeline,runner,prompts,config,rules}.mjs` | Contract flow (what each node actually receives), fix-loop mechanics, tool allowlists, thinking levels, rules injection matrix, git integration |
| `master-reference/.claude/**` + `WORKFLOW-AUDIT.md` (247 lines) | Full governance inventory: plan/task/digest/verify artifact formats, P1–P5 design principles, Tier 1–4 redesign history, defect-class guard matrix |
| Reference F01 execution artifacts (`pm-cycle-2026-09-07-21-01-15`, `OMNI-200..203` tickets/plans/tasks/findings/impl-delta/verify reports, git `0902524..22e9453`) | The 4 owner clarification answers that shaped the reference, per-ticket commit cadence, verify report format, human-gate trail |
| `omni-isp` tree + `.pi/`, `.opencode/`, `.kilo/`, `.context/` | Current tree provenance (run 5), the unused pi port of the reference toolchain, discarded branches |
| Web: Cognition, Anthropic, SDK docs | Architecture principles and alternative tooling (§5, §8) |

---

## 2. The two systems, mechanism by mechanism

| Mechanism | Claude reference workflow | nano-cycle | Verdict |
| --- | --- | --- | --- |
| Requirements intake | PM subagent, 1–4 question batches *written to files*, owner answers inline; 13 flagged assumptions; hard cap 4 batches | Clarify node, ≤5 questions/round in GUI, uncapped rounds; spec JSON written to `.nano-cycle/` | Parity (nano-cycle's is good; spec traceability to source docs arrived run 3+) |
| Requirements → work items | Tickets with **verbatim ACs** ("Never rewrite acceptance criteria — they are the contract"), sizes S/M/L, dependency order, **owner approves the batch before any code** | Plan JSON (capabilities + file lists + ACs) → compiled into coder nodes; **no approval gate** unless the plan declares divergence | Reference |
| Investigation | 2–3 parallel read-only analysts per ticket, **one investigation per ticket**, persisted findings digest with `path:line`, reused by plan/tasks/coders/verify | Plan node investigates itself (`thinking: low`); coders re-explore their neighborhood every pass, every fix round | Reference |
| Work-unit size | One ticket = one independently shippable slice, each with its **own verify pass, own commits, own integration** | Whole feature = one plan → N coders → **one verify at the end** over the entire greenfield diff | Reference |
| Coder context | Ticket body + verbatim ACs + digest excerpts + exact files + full rules + "neighborhood wins"; same-module tasks batched into one spawn | Task string + spec summary + decisions + file list + lane rules; ACs, source doc, design guideline, testing rules **not included** | Reference |
| Coder mandate | "Implement the task fully. Every artifact it needs… No stubs" + layering/migrations/envelope/testing rulebook | "Keep it minimal — implement exactly the task, nothing extra" + `thinking: low` | Reference |
| Parallelism | Parallel only for **read-only** analysts; coders sequential in one tree (same-module batched) | Parallel **writers** in one tree, packed by file-overlap heuristic; collisions observed | Reference |
| Verification | Per-ticket, tiered S/M/L, checks both links (deliverable→impl AND plan→impl), runs lint/tests/e2e by default, `❓ unverifiable` verdict with owner override, ≤2 analysts fan-out | Single verify (later + audit) over whole diff, adversarial red-team prompt, runs compose/tests/lint/build, mechanical verdict reconciliation — **no browser, no plan-conformance link, `❓` handled by brittle string prefix** | Reference on coverage; nano-cycle's mechanical reconciliation is genuinely better engineering |
| Fix loop | Minimal fix-tasks file (one task per gap, AC quoted), targeted dispatch, ≤2 rounds, then **user gate** | Requeue **all** coder nodes with a concatenated feedback blob, ≤N rounds, then run fails | Reference |
| Integration | Commit per task (explicit paths), verdict-gated push/ff-merge, CI monitored via `gh`, watchdog | Branch/commit/ff-merge machinery exists — **disabled in every omni-isp run**; run 5 forbade commits | Reference (by configuration, not capability) |
| Meta-evolution | WORKFLOW-AUDIT.md: measured token economics, 9 redundancy hotspots, P1–P5 principles, tiered redesign | Iterating between runs (source-doc traceability, audit gate, verdict reconciliation) — but each iteration re-tested on a from-scratch F01 | Reference discipline, nano-cycle direction |

---

## 3. Root causes, ranked by evidence strength

### RC1 — Builder model class (dominant; clean natural experiment)

The five runs form a controlled comparison by accident:

| Run | Coder models | Verify/audit | Rounds to converge | Outcome |
| --- | --- | --- | --- | --- |
| 1 | `muse-spark-1.3-contributor-free` | `glm-5.3-flash` / none | 1 fix round | Verify accepted 8/8 — but spec had **invented** `apps/server`+`apps/web` against the repo's stated layout; no audit |
| 2 | `muse-spark` → (429s) → `glm-5.3-flash` | `glm-5.3` | 3 verify passes | Accepted 15/15 + audit 0 blocking — after coders burned retries on free-tier rate limits |
| 3 | `glm-5.3-flash` | `glm-5.3` | 3 + audit rounds | Failed: deps undeclared, ERESOLVE, i18n persistence — audit kept finding new blockers each round |
| 4 | **`glm-5.3`** | `glm-5.3` | 3 fix rounds | **Verify accepted 13/13 + audit 0 blocking** (recorded "failed" only by the `let verdict` shadowing bug, fixed in `5c57cf6`) |
| 5 | `glm-5.3-flash` | `glm-5.3` | 3 + resume + cancel | Failed/cancelled: `mysql2` missing, format gate that cannot fail, CI criterion unobservable |

The flash/free coders' signature defects — undeclared dependencies masked by a stray root `node_modules/`, `Vite 6.4.3` installed where rules pin Vite 8 *("the implementer even flagged it")*, two parallel i18n scaffolds, dead `apiClient.ts`, tests against unrouted components — are capability artifacts, not pipeline artifacts. Run 4 with the same pipeline, same rules injection, same gates and the strong model on coders closed all of it. The reference, for its part, was built by frontier-class Claude agents under Claude Code.

Two force multipliers sit on top of raw capability: coder `thinking` is configured `low` (`config.mjs` NODE_PROFILES), and the injected CODING_RULES say "Keep it minimal — implement exactly the task, nothing extra" — an instruction to skip exactly the substrate (error envelope, migration toolchain, typed i18n, service layer, deep tests) that separates the reference from a scaffold.

### RC2 — Run-environment churn destroyed more quality than the pipeline lacked

Forensics on the omni-isp repo:

- Run 2 committed its work to `feature/OMNI-001-f01-scaffold`; run 4 committed 8 commits to `feature/OMNI-001-monorepo-scaffold` and passed both gates. **Neither branch exists today.** Run 5's spec records the starting state as "only dist/ output exists."
- Run 5's task string was `Implement feature F01, do not commit anything.` — so the audited tree is 100% untracked *by instruction*, which `draft.md` then scored as High defect C1 ("one `rm -rf` from zero") and made the secrets-scan "Done when" unmeasurable.
- Run 5 was cancelled **7 seconds after** its post-failure resume began a fresh fix round — the tree is a snapshot mid-repair, not a finished attempt.
- The `.nano-cycle/spec-*.md` files were deleted after run 5.

So the comparison in `draft.md` is: *reference, best-of-2 executions, committed, CI-green* vs *pipeline, worst-of-5, uncommitted, cancelled mid-round*. Run 4's discarded tree would not have scored at reference level either — but it had already cleared both gates, and several of the audit's High findings (C1 untracked, C3 no migration step in CI) are artifacts of run 5's configuration, not of pipeline capability. **The pipeline has had git integration (branch per run, per-node commits, verdict-gated ff-merge — `pipeline.mjs` `start()`/`commitCoderOutput()`/`integrate()`) since before these runs; it was switched off in all five.**

### RC3 — The unverifiable-criterion trap (structural, mechanical)

Run 5's failing check, verbatim: "ci.yml triggers on pull_request… every job has timeout-minutes: 10. All steps verified green locally… However, merge-blocking (branch protection…) are GitHub repo settings — not verifiable from this environment — no GitHub remote." That check failed **every round** — after `mysql2` and the env pre-step were fixed — because no coder node can fix the absence of a remote. Run 3 died the same way. The `a2b53bb` non-gating escape hatch requires the evidence string to *literally begin* with `not verifiable` — a string-match contract the model satisfies inconsistently.

The reference workflow handled the identical requirement three ways nano-cycle didn't:

1. It **had** a remote and `gh` — branch protection was applied programmatically (owner answer Q3), CI runs were watched (`gh run watch`, 20-min cap) and failures routed back as a "priority pre-task."
2. Its verify verdict vocabulary includes `❓ unverifiable — state exactly what to check manually` as a *first-class, accepted-with-caveat* outcome, not a failure.
3. The owner override was recorded in state ("ACs 2–4 deferred (owner override)") instead of burning rounds.

An acceptance criterion that cannot be observed from the run environment is a **spec-time classification error**, and clarify should be made to catch it (see §6 Track 2, item 5).

### RC4 — Builders are blind to the contract (code-level, still present)

`host/prompts.mjs` `implementPrompt()` sends coders: task string, workspace, spec `summary`, locked `decisions`, assignment (title + `{path, purpose}` files), and on fix rounds a feedback blob. It does **not** send: `spec.acceptance_criteria`, the source doc text, the design guideline, or the plan's own criteria. `loadSourceDocs()` is wired into verify and audit prompts only (`promptFor()`).

Consequences visible in the runs: run 1's coders happily built `apps/server`/`apps/web` because their assignment said so (the spec contradicted the repo; nobody downstream of the spec could see it); the "Bengali must render correctly" clause reached the verifier but never the frontend coder deciding between `@fontsource` bundling and a Google Fonts CDN link.

The reference dispatches every coder with "the ticket body + acceptance criteria + the files named in the ticket" and the orchestrator injects digest excerpts plus exact paths. The information is the same on both sides — nano-cycle simply drops it at the last hop, then pays fix rounds to rediscover it.

### RC5 — Coders never see the testing rules (and other rules starvation)

`host/rules.mjs` STACK_RULES injects into coders: `backend-development-rules.md` + `security-rules.md` (backend lane), `frontend-development-rules.md` (frontend lane). It injects `testing-rules.md` into **verify and audit only**. `persona.md`, `git-guidelines.md`, `context-cache.md` are injected nowhere. `docs/design-docs/design_guideline.md` — the normative source for palettes, Bengali line-height (§3.3), touch targets (§8/§12) — is injected nowhere, and nothing instructs coders to read it (the frontend rules reference it by path, which a flash-tier coder with `thinking: low` does not chase).

This single wiring choice explains three `draft.md` findings at once: 7 tests vs the reference's 41; e2e suites that stub MySQL and Redis ("contradicts testing-rules" — the coders never saw the rule); missing substrate breadth in tests. The reference's coder agent files each embed the testing contract directly ("every behavior ships tested… e2e for endpoints… fake adapters bound via DI… run lint, test, test:e2e").

### RC6 — Context relay is thin, one-shot JSON between fresh sessions

Every nano-cycle node is a fresh pi session (`SessionManager.inMemory`) whose entire inheritance is the driver-assembled prompt. The plan artifact is a `task_summary` string plus file lists. Coder artifacts are `summary` + `files_written`. This is the "condensed subtask description" pattern Cognition's *Don't Build Multi-Agents* names as the core failure mode: *"Share context, and share full agent traces, not just individual messages"* and *"Actions carry implicit decisions, and conflicting decisions carry bad results."* Your parallel coders in one working tree are precisely the second principle's violation — four nodes editing `LanguageSwitcher.tsx` in one fix round is the observed collision.

The counterintuitive part: **the reference workflow already ran this experiment and moved away from it.** Its WORKFLOW-AUDIT.md documents near-100% accuracy at a ~15× token multiplier, then a redesign (P1–P5, Tiers 1–3) whose Tier 2 explicitly keeps "plan+tasks synthesis in this cached context instead of a fresh skill chain" — one fat, prompt-cached main context doing coordination, with spawns reserved for isolated coding (P2: "fewer, bigger spawns"; P4: "Cut redundancy, never isolation or verification"). nano-cycle re-introduced per-phase fresh sessions — the architecture the reference measured and abandoned — while also running on smaller models. The two decisions compound: a fat context makes a mid-tier model behave like a stronger one; a starved context makes a mid-tier model behave like a weaker one.

### RC7 — Fix-loop mechanics: requeue-all + feedback blob

`pipeline.mjs` `execute()` requeues **every** `impl-*` node each fix round and hands each the same concatenated `run.feedback`. Observed costs:

- Run 3 ran 5 coder nodes × 4 passes ≈ 20 coder sessions; run 5 re-ran all three coders to fix a single-file i18n label (four nodes converged on `LanguageSwitcher.tsx`).
- Each re-run is a fresh session re-reading the workspace — no cache carry-over, no memory of *why* a previous round's choices were made, free license to rewrite files that were already correct (run 4's `backend-frontend-scaffold-fe` wrote 13 files initially, 1 in its final pass — churn, not progress).
- The feedback blob strips the failing check's context: the coder gets the criterion text and evidence but not the verify/audit reasoning, the fix constraint (fix *this*, don't touch *that*), or which files own the gap.

The reference's fix loop: a minimal `.context/tickets/<id>/fix-round-<n>-tasks.md` — "one task per gap, acceptance criterion quoted" — dispatched through the orchestrator to only the relevant coder, then re-verify. Cheaper, targeted, and regression-free by construction.

### RC8 — Verification has structural blind spots and a weighting problem

Credit first (this is the pipeline's strongest subsystem): later-run verify/audit did clean-room `npm ci` proofs, wrote and deleted scratch tests to prove i18n non-persistence, ran the full compose stack and probed endpoints, ran gitleaks over history. That is reference-grade adversarial verification.

The blind spots that survived to `draft.md`:

| Blind spot | Mechanism |
| --- | --- |
| Bengali tofu (F2) | Verify has `read` + `bash` only — no browser, no rendering observation. The AC said "Noto Sans Bengali loaded"; a CDN `<link>` satisfies "loaded" to a curl-level check. (obscura `web_reader` exists in `host/webtools.mjs` and is wired to *clarify only*.) |
| Hangable health endpoint (B2) | No AC demanded a probe timeout/503 semantics; the reference got them from backend rules + owner answer Q2 ("JSON health endpoint with component checks") flowing into design |
| README false claims (C4) | Audit *found* "README drift ~10 false claims" and rated it **non-blocking quality** — the spec didn't carry README truth as a criterion, so the gate couldn't weight it. (Reference guard: persona rule "keep docs in sync with code in the same change" — a file nano-cycle never injects.) |
| Dead migration scripts (B1) | Caught as **blocking** in run 3's audit, **non-blocking** in run 5's — same defect, different day, because spec silence makes it advisory. Reference guard is structural: migrations are generated + committed per task, and e2e runs against a real DB *with migrations applied* — a broken chain fails CI mechanically |
| Touch targets, i18n key parity | In no AC, in no injected rule (design guideline not injected); the reference also had no explicit rule — it won on builder judgment + a 360px/48px test culture |

The pattern: **in nano-cycle, the spec's ACs are law and the rules are advisory; in the reference, the rules are binding for every agent and the verify gate checks test discipline mechanically.** When the spec fails to encode something, nano-cycle has no second line of defense and the audit is forced to under-weight real defects.

### RC9 — The pivotal product questions were never asked

The reference's PM asked four questions; the answers *were* the reference's architecture:

- **Q1 = hybrid topology (infra in Docker, apps on host with HMR)** → the `dev.mjs`/`stop.mjs` lifecycle, hot reload, CI-parity topology that `draft.md` scores as the single biggest strategy win (§7 of the audit).
- Q2 = JSON health endpoint with per-component checks → the 200/503 contract.
- Q3 = branch protection applied programmatically → the committed `apply-branch-protection.sh` (with an owner override deferring its execution).
- Q4 = local-only compose → ports/credentials policy.

nano-cycle's clarify rounds asked good questions (run 3's round 1 settled the `backend/`+`frontend/` layout and discard policy) but never surfaced topology/dev-loop — every spec locked or tolerated compose-only, and "no hot reload" followed mechanically. One unasked question produced an entire §7 "strategy mismatch" in the audit. This is not a pipeline bug; it is clarify-prompt coverage: nothing instructs the PM to enumerate *delivery-shape* decisions (dev loop, HMR, where apps run) as owner questions.

### RC10 — Harness instability contaminated the experiment

Run 2 died twice on `429 FreeUsageLimitError` mid-build (manual resumes); run 3 pre-dates failure-reason recording (`error: null`, log just ends); run 4's gate-passing work was recorded **failed** by the verdict-shadowing bug (fixed `5c57cf6`); several sandbox-era runs died on pipeline bugs (`run is not defined`, `emit is not defined`, `forcedFinalize is not defined`, `unknown node: <run-id>`); two runs were killed by server restarts. The reference ran on a mature harness with a 30-minute watchdog that auto-resumes stalls — its `.context/dev-cycle/watchdog.log` shows exactly that happening during its own F01 window. A pipeline under simultaneous development cannot be evaluated fairly while it is also the thing being debugged; freeze the harness, then measure.

---

## 4. What nano-cycle already does right (keep these)

- **Mechanical verdict reconciliation** (`a2b53bb`): checks over summary verdicts, blocking findings over verdicts — the reference trusts its verify model's summary; nano-cycle verifies the verifier. Genuinely better.
- **Adversarial verify/audit prompting with observed-evidence standard** — the "assume every criterion is unmet until you personally observe it passing" framing produced clean-room proofs and empirical falsifications that would catch most reference defects too.
- **Spec traceability to source docs** (`8732617`): doc text injected raw into verify/audit, "source docs outrank the spec." Runs 3–5 specs carried the F01 doc, rules, and design guideline as `source_docs` — the spec-pipeline leak that killed runs 1–2 (invented `apps/server`) was already fixed.
- **Dynamic capability graph with a compile-time counterpart rule** — deterministic rejection of malformed plans with retry-with-reason is a sound pattern (the reference has no equivalent guard).
- **Operability**: live streaming GUI, per-node model swap mid-run, resumability of gate-failed runs, stall watchdog, process cleanup, run-state persistence.
- **Honest failure recording** (post-`a2b53bb`): failing checks named in `state.error`.

The chassis is good. The engine inputs (model, context) and the transmission (fix loop, ticketization, environment) are what need work.

---

## 5. Is pi the problem? Should you use something else?

**No — pi is not the bottleneck, and the evidence is specific:**

- The same pi SDK ran run 4 to both gates green. The SDK's primitives (AgentSession per node, tool allowlists, custom schema'd tools, in-memory sessions, abort signals) did everything asked.
- pi is a deliberately minimal, model-agnostic harness with a first-class TypeScript SDK — the right shape for this project. Its one relevant limitation (no cross-session prompt-cache reuse, since each node is a fresh session) is a property of the *architecture you chose on top of it*, not of pi.

What the model layer actually lacks: **reach and class**. Your pi auth reached `zai-coding-cn/glm-5.3(.3-flash)` and opencode free tiers; the reference ran on Claude. Options, in order of expected fidelity per unit of effort:

| Option | What it buys | Cost/risk |
| --- | --- | --- |
| **Keep pi; put the strongest model you can afford on coders** (run 4 configuration: `glm-5.3` everywhere, `thinking` raised for plan/coders) | Proven to pass your own gates; no code changes | Token cost — but note run 4 was your *cheapest* completed-quality run (379k in / 6.0M cache-read) because it stopped re-doing work |
| **Route pi at Claude or other providers** (pi is model-agnostic; you already run LiteLLM as an MCP server) | Reference-class builder capability if you have Anthropic access | API cost; provider config |
| **Drive the original workflow headlessly instead of reimplementing it** — Claude Agent SDK / `claude -p` with the *existing* skills (or your own `.pi/` port with `@tintinweb/pi-subagents`, already committed in omni-isp: `.pi/skills` mirrors all 10 skills byte-identical, `.pi/agents` adapts the 5 agents) | The exact behavior you are benchmarking against, with determinism added where it belongs (hooks/scripts for gates, CI watch, branch protection) | You already built the pi port and never used it; the workflow is state-driven and resumable by design (`state.md`), so wrapping it in scripts is straightforward |
| Other SDKs (opencode SDK, generic LangGraph-style graphs) | Nothing pi doesn't already give you here | Migration cost, no fidelity gain |

The strategic point: the reference's "probabilistic handoffs" were never actually loose — every handoff is a **file artifact on disk** (state.md, ticket.md, plan, tasks, findings, impl-delta, verify report). The workflow is a state machine whose transitions happen to be executed by a model. Determinism can wrap it (script the invocations, gate the transitions, require artifact existence before advancing — your own `handle-ticket` skill already encodes those preconditions) without rebuilding the judgment in a thinner brain.

---

## 6. Recommendations

### Track 0 — Process discipline, zero code, do today

1. **Never discard gate-passing work again.** A run that passes verify+audit is a keeper branch; re-audit *it*, don't re-implement F01 from scratch. (Run 4 exists nowhere today.)
2. **Run with git on and a real remote.** Branch per run, per-node commits, push, let CI actually execute. This single change converts the run-killer CI criterion into an observed check, satisfies the secrets-scan "Done when," and makes "one `rm -rf` from zero" impossible. The machinery already exists in `pipeline.mjs`.
3. **Freeze the harness before evaluating it.** No mid-experiment pipeline changes; otherwise you're scoring a moving target (runs 1–5 each ran different code).
4. **Match experimental controls when comparing** — same model class on builders as the reference had, or say explicitly that you're benchmarking the pipeline *at flash-tier cost* and expect a delta.

### Track 1 — Highest-fidelity path: drive the original workflow headlessly

If the goal is "reference-level output, reproducibly": wrap, don't rebuild.

- Use the Claude Agent SDK (or `claude -p` in a script, or your `.pi` port) to execute `/dev-cycle` against `docs/features.md` with `--merge-to-base`.
- Add determinism at the boundaries with hooks/scripts: gate transitions on artifact existence (`state.md` phase, plan file, verify report), run gitleaks/CI-watch/branch-protection as scripts, enforce the two human gates as CLI pauses or GUI gates (nano-cycle's GUI is genuinely good at this — reuse it as the front-end).
- Keep nano-cycle for what it's already best at: the deterministic mechanical gates (§6 Track 2, item 7) can run as a post-verify stage against *any* implementation, reference-built or pipeline-built.

### Track 2 — Fix nano-cycle (priority-ordered, each mapped to its root cause)

1. **Strong model on coders; raise `thinking`** for plan + implement to medium/high (RC1). Keep audit at high.
2. **Give coders the full contract** (RC4, RC5): pass `spec.acceptance_criteria` verbatim and `loadSourceDocs()` text into `implementPrompt`; extend `rules.mjs` to inject `testing-rules.md` into implement nodes (or merge its mandates into the lane rules), plus `git-guidelines.md` when git is on, plus `design_guideline.md` for frontend work. Replace CODING_RULES' "Keep it minimal — nothing extra" with the reference coder's mandate: "Implement the task fully — every artifact the task and rules require; no stubs, no TODOs."
3. **Ticketize the L tier** (RC6, RC7): each capability becomes a ticket with its own ACs, its own verify pass, its own commit(s), integrated before the next ticket starts — the per-ticket cadence is what let the reference verify a 36-file backend slice at depth. Keep the end-of-run audit as the cross-ticket conformity sweep.
4. **Targeted fix rounds** (RC7): map each failing check/finding to the coder node(s) owning the implicated files; requeue only those; format feedback as per-gap blocks — quoted criterion, evidence, owning files, explicit "do not touch anything else." Cap total requeued nodes per round.
5. **Classify every AC by verification environment at spec time** (RC3): clarify must tag each criterion `local-runnable | needs-remote | needs-human`, and the pipeline must route `needs-remote` criteria to *mechanical* steps (push branch, `gh run watch`, record the run URL as evidence) instead of asking a model to imagine GitHub. Kill the `^\s*not verifiable` string-prefix contract.
6. **Give verify a browser** (RC8): wire the existing obscura `web_reader`/screenshot tool into the verify profile so rendering, user journeys, and tofu-class failures are observable. Require font locality phrased observably in ACs: "fonts bundled locally; no external font CDN in the built HTML; a test asserts the computed font-family."
7. **Move deterministic checks into the driver** (RC8) — this is nano-cycle's comparative advantage over the reference, whose residual gaps (CDN fonts, touch targets, i18n key parity) are exactly string/grep-shaped: gitleaks run by the driver after every round; package.json-vs-lockfile-vs-imports dependency check (automate the clean-room proof your audit did by hand); `fonts.googleapis.com`/CDN ban grep; i18n en/bn key-parity script; `.env.example` ↔ consumed-vars reconciliation; `README` command existence check (every documented command resolves to a real script/file). Model judgment for behavior; code for invariants.
8. **Add the plan-approval human gate** (RC9): after the capability plan compiles, show the owner capabilities + sizes + dependency order (nano-cycle's GUI answers gate UI already fits) — the reference's `awaiting-approval` caught topology mistakes before any code existed.
9. **Teach clarify to ask delivery-shape questions** (RC9): dev topology (host apps + container infra vs all-Docker), hot reload, port policy — the F01 doc's silence on HMR is exactly where an owner decision belonged.
10. **Persist and share context** (RC6): have coders write impl-delta notes (files changed + decisions made — the reference's pattern), inject them into later rounds and verify; keep node transcripts on disk (events.jsonl already exists) and let fix-round coders receive the prior round's summary for *their* files.
11. **Stop parallel writers sharing one tree without isolation** (RC6): either serialize same-lane work, or give each coder node a worktree (pi-subagents supports `worktreeIsolation`) with a deterministic merge order — the reference defers exactly this to "Tier 4 (not implemented)" for the same reasons you hit.

### Track 3 — Measure the pipeline like the reference team measured theirs

WORKFLOW-AUDIT.md is the reference's meta-discipline: they measured token economics, found 9 redundancy hotspots, and redesigned with principles. Do the same here:

- Build a scorer that, per run, computes: F01-doc "Done when" coverage (each clause → observed pass/fail via the mechanical checks + browser smoke), gate counts (tests, e2e), defect register from `draft.md`'s B/F/C taxonomy, secrets scan, README claim check, and token/cost totals.
- Run it against the reference implementation to calibrate (it should score ~green), then against each pipeline config change. Five runs of anecdote → one regression harness.
- Keep a `WORKFLOW-CHANGELOG.md` in nano-cycle recording each mechanism change and its measured effect, so the next "why is it still short" question has data.

---

## 7. Defect-by-defect mapping (draft.md → root cause)

| draft.md defect | Root cause(s) |
| --- | --- |
| B1 dead migration scripts (High) | RC1 (flash coders) + RC8 (spec silent → audit under-weights; reference guards structurally via generated+committed migrations and real-DB e2e) |
| B2 hangable health (High) | RC8 (no timeout/503 AC; no fault-injection check) + RC9 (owner Q2 never asked) |
| F2 CDN fonts → tofu (High) | RC4 (AC/doc never reached the coder) + RC8 (no browser in verify; AC phrased as "loaded," satisfied by a CDN link) + Track 2 item 7 (a one-line grep ban catches this deterministically) |
| C1 everything untracked (High) | RC2 (run 5 task forbade commits; git integration disabled; run 4's commits discarded) — configuration, not capability |
| C2/B4 broken manual-dev path | RC9 (topology never asked; compose-only locked) + RC1 |
| C3 dead migration toolchain in CI | RC2 + RC3 (no remote → CI never executed anywhere) |
| C4 ~10 README false claims | RC5 (persona/docs-sync rule never injected) + RC8 (audit found it, rated non-blocking for lack of a spec criterion) |
| B3/B6/B7/B8 (charset, prefix trap, void bootstrap, CORS) | RC1 + RC5 (backend rules carry envelope/strictness mandates, but "keep it minimal" + flash tier = rules as advisory) |
| 7 tests vs 41; e2e with stubs | RC5 (testing-rules injected to verify only — coders never saw "DB is never mocked," "every endpoint ships happy+401+403+400") |
| C5 stray root node_modules | RC2 (discarded runs' debris) — and it *actively masked* missing deps until the audit's clean-room proof (RC8 credit) |
| C6–C10 (ports, pins, gitignore, engines) | RC1 + RC5 (guideline/pinning conventions not encoded as ACs or checks) |

---

## 8. Sources and references

- Cognition, *Don't Build Multi-Agents* — principles quoted in RC6: [cognition.com/blog/dont-build-multi-agents](https://cognition.com/blog/dont-build-multi-agents); follow-up *Multi-Agents: What's Actually Working*: [cognition.com/blog/multi-agents-working](https://cognition.com/blog/multi-agents-working)
- Anthropic, *How we built our multi-agent research system* — parallelism works for read-only fan-out; execution needs coordinated context: [anthropic.com/engineering/multi-agent-research-system](https://www.anthropic.com/engineering/multi-agent-research-system); comparison discussion: [philschmid.de/single-vs-multi-agents](https://www.philschmid.de/single-vs-multi-agents)
- Claude Agent SDK (deterministic orchestration over Claude, subagents, hooks): [augmentcode.com guide](https://www.augmentcode.com/guides/claude-agent-sdk-agent-loops-tool-calls), [hidekazu-konishi.com complete guide](https://hidekazu-konishi.com/entry/claude_agent_sdk_complete_guide.html), community patterns ([alexop.dev](https://alexop.dev/posts/claude-code-workflows-deterministic-orchestration/), [5 spawn patterns](https://medium.com/@hugolu87/5-ways-to-spawn-multi-agents-with-the-claude-sdk-orchestra-swarms-f4816cf7e7b3))
- pi coding agent + SDK: [pi.dev](https://pi.dev/), [pi.dev/docs/latest/sdk](https://pi.dev/docs/latest/sdk)
- Local evidence: `master-reference/WORKFLOW-AUDIT.md` (§4–§11), `master-reference/.claude/**`, `master-reference` git history (`0902524..22e9453`, `origin/feature/F01-monorepo-scaffold`), `master-reference/.context/pm-cycles/pm-cycle-2026-09-07-21-01-15/**` and `.context/tickets/OMNI-200..203/**` (on the F01 branches), `nano-cycle/runs/2026091{4,5}-*/{state.json,events.jsonl}`, `nano-cycle/host/*.mjs`, `omni-isp` tree + `.pi/` port, `draft.md`.

---

*Report generated 2026-09-15 by a three-agent investigation (reference governance, reference F01 execution, run forensics) plus direct code reading and web research. All run-level claims are from `runs/*/state.json` and `events.jsonl`; all workflow-behavior claims are from the referenced skill/agent/rule files; all code claims carry file references.*
