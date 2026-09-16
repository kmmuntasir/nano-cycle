# nano-cycle fix report — Track 2 of the root-cause analysis

**Date:** 2026-09-16 · **Plan:** `~/.claude/plans/drifting-giggling-toucan.md` (approved) · **Analysis:** `PIPELINE-VS-REFERENCE-ROOT-CAUSE-ANALYSIS.md` · **Checklist:** `TODO.md` (all items ticked)

Implemented all 9 in-scope fixes from the analysis's Track 2. Ticketization and mechanical remote-CI verification remain deferred (agreed). One new bug was found and fixed during live verification (§3).

## 1. What changed, file by file

### `host/config.mjs`
- **`CODING_RULES` → `IMPLEMENT_RULES`** for implement nodes only. The old "Keep it minimal — implement exactly the task, nothing extra" is gone; the new mandate mirrors the reference coder: implement fully, no stubs/TODOs, run lint/tests before reporting, fix only your gaps on fix rounds, report honestly (summary + files + notes). **Verify/audit no longer receive coding rules** (they were role-blind injections).
- **Thinking levels raised:** plan/implement `low→medium`, verify `low→high`, clarify `low→medium` (audit stays `high`). Valid per pi's `ThinkingLevel` union (`off|minimal|low|medium|high|xhigh|max`).
- **Schemas:** `implement` gains optional `notes` (impl-delta: decisions/deviations); `spec` gains optional `ac_verification: [{criterion, env: local|remote|human}]`.

### `host/rules.mjs`
- `testing-rules.md` + `git-guidelines.md` now inject into **all implement nodes** (previously verify/audit only — coders never saw the testing contract, which is why past runs shipped 7 tests with stubbed e2e where the reference shipped 41 with real-DB e2e). `git-guidelines.md` added to verify/audit.

### `host/prompts.mjs`
- **`implementPrompt`** now carries the full contract: spec acceptance criteria **verbatim** ("ACCEPTANCE CRITERIA — THE CONTRACT"), the plan's own implementation-level criteria (previously coders never saw these either), source-doc text, the node's previous artifact on re-runs ("build on it; do not undo what already passes"), and per-node fix-round feedback (replacing the global blob when present).
- **`verifySystem`**: browser guidance (LOAD pages and observe RENDERED content — "a CDN font link that satisfies curl can still render tofu") + verification-environment guidance (remote/human-tagged criteria → `not verifiable from this environment:` evidence, driver defers; local defects behind a remote criterion still gate).
- **`verifyPrompt`**: renders `VERIFICATION ENVIRONMENTS (driver-classified)` and `DRIVER-OBSERVED MECHANICAL CHECK RESULTS` ("deterministic — treat as ground truth… do NOT mark a driver-failed check passing").
- **`auditPrompt`**: mechanical results as informational context.
- **`clarifySystem`**: tag every criterion's verification environment (`ac_verification`, criterion text copied exactly, when-in-doubt-local) + delivery-shape questions (dev topology host-vs-containers, hot reload, port policy — ask when source docs are silent; the unasked-topology gap is what produced the reference-vs-pipeline "strategy mismatch" in the original audit).

### `host/checks.mjs` — NEW
Six deterministic checks, each degrading to `skipped` (never gating) when preconditions are absent; `NANO_CHECKS=off` or a comma list disables ids; evidence capped:

| Check | What it catches |
| --- | --- |
| `secrets-gitleaks` | real secrets (gitleaks binary → pinned docker `zricethezav/gitleaks:v8.24.3` → skip) |
| `deps-declared` | bare imports/config references to packages no `package.json` declares — each manifest governs its subtree minus deeper manifests (monorepo guard), tsconfig `paths` aliases honored |
| `no-cdn-fonts` | `fonts.googleapis.com`/`fonts.gstatic.com` references — the tofu failure mode |
| `i18n-parity` | `en.json`/`bn.json` pairs with differing key sets, both directions |
| `env-wiring` | `.env.example` keys vs `process.env`/`import.meta.env` reads, both directions, public-prefix-tolerant |
| `readme-commands` | README `npm run <x>` / `./scripts/<y>` mentions that don't resolve |

### `host/pipeline.mjs`
- **Mechanical gate:** `runMechanicalGate` runs before **every** verify pass (round 0 included); results persist in `state.mechanicalChecks`, stream as notices, and are injected into the verify prompt. Driver reconciliation treats `fail` as gating regardless of the model's verdict — the model cannot argue them away; `skipped` never gates; a mechanical pass never overrides a model-observed fail.
- **Targeted fix rounds:** failing checks + blocking findings + mechanical failures become gap items; `ownersForGap` matches path tokens from gap text (relative/absolute/`:line`-tolerant, short-bare-name noise filtered) against nodes' planned ∪ written files; only owner nodes requeue, each with only its gaps (`state.feedbackByNode`), each seeing its previous artifact. Fallback when no gap has any owner: requeue all (legacy behavior) + notice; partially-unowned gaps are distributed labeled `UNOWNED GAP`.
- **AC verification environments:** `matchAcVerification` (exact → normalized → substring) + `ENV_LIMIT_RE`; a failing check on a `remote`/`human`-tagged criterion with environment-limited evidence is recorded in `state.deferredChecks` and surfaced ("needs remote/human verification") — it never burns a fix round. Legacy `not verifiable…` evidence prefix remains the fallback for untagged specs. The run's final state lists deferred items.
- **Plan-approval gate:** after an M/L plan compiles, the owner approves the compiled plan (capabilities table / M halves + criteria) before any coder runs; `approvePlan` run option (default on; GUI toggle). `pendingPlanApproval` is re-presented at the top of `execute()` on resume — otherwise a resume-after-cancel-at-gate would silently run coders unapproved (plan node already done, `planPhase` skipped).
- **Browser for verify:** when obscura is on PATH, verify gets `web_reader` in its toolset (+ attach notice; system prompts aren't persisted, so the notice is the observable signal).
- **Hot-file serialization:** `state.writtenFiles[nodeId]` accumulates each coder's outputs across rounds; `packParallel` packs by effective files = planned ∪ written, so planned-vs-written collisions serialize too (kills the `LanguageSwitcher.tsx` four-writers class of collision).
- **Misc:** failure reasons now include mechanical failures; `writeSpecFile` gains a `## Verification environments` section; `start()` initializes the new state fields; module-level helpers exported as `__internals` for unit testing.

### `host/server.mjs`
- `approvePlan: body.approvePlan !== false` passthrough.

### Web GUI (Chakra UI; rebuilt into `web-dist/`)
- `api.ts`: gate type union + `plan-approval` payload; `RunState` gains `feedbackByNode`, `writtenFiles`, `deferredChecks`, `mechanicalChecks`; start opts gain `approvePlan`.
- `GatePanel.tsx`: plan-approval banner ("Plan Ready — Approval Needed") + full panel (task summary, capabilities table with file lists/deps/single-side class, or M backend/frontend lists, acceptance criteria, Approve & Continue / Cancel Run — cancel routes through the existing confirm dialog).
- `StartForm.tsx` / `App.tsx`: "Plan Approval" toggle (default on) in the Plan row; payload wired.
- `Workbench.tsx`: `checks:mechanical` and `checks:deferred` pseudo-artifacts in the Artifacts tab.

### `README.md`
Documented: contract flow into coders, plan-approval gate, driver checks table, targeted fix rounds, verification environments, updated context-injection matrix, thinking levels.

## 2. Verification evidence

**Static + unit (all PASS):** `node --check` on all 12 host modules; config assertion (`medium medium high high medium`, schemas present); rules-matrix assertion; `npm run build` + `tsc` clean; **18 unit checks** on `__internals` — `fileKey` (relative/absolute/`./`), `matchAcVerification` (exact/normalized/substring/miss/empty), `ENV_LIMIT_RE` (matches the real evidence strings from runs 3/5 of the F01 forensics; does NOT match local defects), `pathTokensIn` (relative/absolute paths, `e.g.` noise filtered, no-token case).

**checks.mjs fixture:** a seeded defect tree produced exactly the right fails (undeclared `marked` import, Google-Fonts link, `missing in bn`/`missing in en`, read-but-undeclared + declared-but-unread env keys, unresolvable README commands) and the right passes/skips (gitleaks ran via the **docker fallback**).

**Live run A — completed, all gates green** (`runs/20260916-002302252`, nano-e2e, tier M, clarify on, free-tier coder): spec traced the source doc (10 ACs including "No external font CDN anywhere in the repo" and README-truth clauses, `ac_verification` tagged, `source_docs` recorded); plan-approval gate appeared and approved; the coder prompt contained the AC block + plan criteria + source-doc text; `context injected: testing-rules.md / git-guidelines.md` events fired on the coder node; the coder artifact carried `notes`; all 6 mechanical checks ran (`env-wiring` correctly **skipped** — no `.env.example`) and landed in the verify prompt; browser-attach notice fired; verify accepted 10/10; audit accepted. **The coder fixed all three seeded defects in round 0 — because the contract reached it.** The deliverable: system fonts with a Bengali fallback (no CDN), identical en/bn key sets, truthful README.

**Live run B — adversarial, honest failure** (`runs/20260916-003417584`, nano-e2e-4, seeded defects in files *outside* the coder's assignment, `maxFixRounds: 1`): mechanical checks failed round 0 exactly as seeded (`old.html` CDN link, unread `ABOUT_TITLE`, `npm run nope`); verify obeyed the ground truth and reported them as failing checks; the driver forced a fix round; the requeue was **targeted** (`fix round 1: targeted — requeueing implement-fe`, per-node `feedbackByNode` populated — the index.html-owning node got the gap); the free-tier coder did not fix the unowned defects in its one round; checks re-ran, still failed, and the run **failed honestly** with named reasons ("gates still failing after 1 fix round(s): verify: 4 failing check(s) — …"). This is the gate working as designed: deterministic ground truth cannot be argued away.

**Live regression — cancel-at-plan-gate → resume:** first attempt exposed a real bug (§3); after the fix, cancel at the gate → resume → **gate re-presented, plan node stays `done`** (no zombie re-run).

**Known not-exercised-live (covered by unit tests / unchanged legacy paths):** the clarify answers gate (run A's PM finalized without asking — allowed, `requireQuestions` defaults off; the gate mechanism is unchanged from previous sessions); live deferral of a `remote`-tagged criterion (no such criterion arose; matching regex unit-tested against real F01 evidence strings); multi-coder hot-file lane packing (single coder node per run; packing logic asserted at the unit level).

## 3. Bug found and fixed during verification

Cancel-at-gate used to masquerade as a plan rejection: `waitGate`'s `cancelled at gate` throw landed inside `planPhase`'s rejection-handling `catch`, which deleted the plan artifact and **re-ran the plan node against a cancelled run** (a wasted model session, and after a quick resume, two concurrent `execute()` flows). Fix (2f1376d-era change in this session): `planPhase`'s catch rethrows when `run.cancelRequested`, and `execNode` refuses to start a fresh session on a cancelled run. The divergence gate shared the same latent flaw and is covered by the same fix.

## 4. Operational notes

- The server on `:4177` was restarted to load the new code (the previous instance, running since Sep 15, still had the old modules in memory — worth knowing: **restart the server after changing `host/` code**; Node caches imports).
- The zai provider hit its 5-hour quota cap during testing (reset 04:09); live verification used the opencode free tier (`muse-spark-1.3-contributor-free`), which also 429'd one concurrent run (`mimo-v2.5-free`) — provider quota, not pipeline.
- `projects.json` now contains `nano-e2e`, `nano-e2e-2`, `nano-e2e-3`, `nano-e2e-4` pointing at `/tmp` scratch trees (evidence runs live under `runs/`); harmless to remove.
- Changes are **uncommitted** on `main` — your call (the repo's own git-guidelines apply to itself only by courtesy, but the suggested message: `feat: contract injection, driver checks, targeted fix rounds, plan-approval gate, AC verification environments`).

## 5. What this fixes, mapped to the root causes

| Root cause (analysis §3) | Fix |
| --- | --- |
| RC1 model class + quality-suppressing rules | IMPLEMENT_RULES mandate + medium/high thinking (model choice itself stays per-run in the GUI — run 4 of the F01 forensics showed `glm-5.3` coders converge) |
| RC3 unverifiable-AC trap | `ac_verification` classification + `deferredChecks`; env-limited failures never burn rounds |
| RC4/RC5 contract blindness | ACs, plan criteria, source docs, testing/git rules, guideline docs (via `source_docs`) all reach coders |
| RC6 context starvation between nodes | previous-artifact carryover, per-node feedback, impl-delta notes; hot-file serialization kills parallel-writer collisions |
| RC7 fix-round blob | targeted requeue + per-node gaps + "fix this gap only" |
| RC8 verifier blind spots | browser for verify; six deterministic driver checks that gate regardless of model opinion; plan-approval human gate; deferred checks surfaced |
| RC9 unasked product questions | delivery-shape questions in clarify |

**Deferred follow-ups (agreed):** L-tier ticketization (per-capability verify/commit/integrate), mechanical remote CI verification (push + `gh run watch` — needs a configured remote; `ac_verification` already stops it burning rounds), worktree isolation for parallel coders.


## 6. Follow-up round (2026-09-16, second commit): thinking `high` + L-tier ticketization

**Thinking levels** — every role now runs at `high` (plan/implement/clarify raised from `medium`; verify/audit were already `high`). Model choice stays per-run in the GUI.

**L-tier ticketization** (the big deferred item) — `L` is no longer a wide parallel wave with one end-of-run verify. The plan's capabilities compile into **tickets** that run sequentially in dependency order:

```txt
plan → ticket₁ (coders → verify-<cap₁>) → ticket₂ (…) → … → final cross-ticket verify (+ audit)
```

- Each ticket: its coder nodes (lanes pack by planned ∪ written file overlap), then its **own verify gate** (`verify-<capId>` — same red-team profile, browser tool, driver checks), then **scoped** fix rounds (gap→owner mapping restricted to the ticket's nodes; fallback stays inside the ticket).
- Ticket-scoped verify prompts (`TICKET-SCOPED VERIFICATION` block + only that ticket's implementer reports): "other capabilities' files may not exist yet — do not fail their absence; integration is the final verify's job."
- A failing ticket fails the run with its reasons; **resume retries only non-accepted tickets** (accepted tickets' coders are not re-run).
- Mechanical checks + browser attach fire for every `verify-*` node; `state.tickets` persists the sequence; the GUI gains a "Ticket Gates (L)" lane; `compileGraph` (the old whole-tree wave compiler) is replaced by `compileTickets`/`ticketGraph`/`finalGraph`.

**Bug found and fixed during this round's live test:** the first attempt checked `run.tickets` before `runDag` had run `planPhase` (which compiles the tickets), so the ticket loop was skipped and the run starved on a null graph (failed with empty-gap fix rounds, no coder ever ran). `execute()` now drives the L plan phase explicitly first, then hands off to `runTickets`.

**Live verification** (`runs/20260916-005034498`, 3 capabilities, free-tier models, plan-approval gate exercised): tickets ran strictly sequentially (ticket 2's coder started 1 ms after ticket 1's verify ended), all three ticket gates accepted (5/7/5 checks) with scoped prompts and no foreign implementer reports, final cross-ticket verify accepted, deliverable complete (`pages/about.html`, `pages/contact.html`, `assets/style.css`, matched `locales/`). 17/17 assertions PASS. An earlier aborted attempt (`20260916-004818999`) is kept on disk as the bug's evidence.

**Still deferred:** mechanical remote CI verification (push + `gh run watch` — needs a configured git remote on the target project) and worktree isolation for parallel coders (hot-file serialization remains the mitigation).


## 7. Remote CI verification (2026-09-16, third commit) — the last actionable deferred item

Owner-opted via the **Remote CI** start toggle (default **off**; requires **Git** enabled — pushing to `origin` is exactly what the toggle authorizes):

- **`host/ci.mjs`** (new): one-time capability probe (gh binary + auth + repo access **from the project directory** — an early bug ran gh in the server's cwd and was caught by a unit test) and `watchRunsForSha`: settle ~10 s → `gh run list --commit <sha>` → poll each run to completion (20-min cap, `NANO_CI_TIMEOUT_MS`) → conclusions, run URLs, and `--log-failed` excerpts.
- **`host/git.mjs`**: `hasRemote` / `pushBranch` / `headSha`.
- **Pipeline**: `runRemoteCiGate` fires before the **final** verify only (after all coders/tickets, so each push carries complete committed work — per-ticket pushes remain future work). Red CI gates exactly like a mechanical failure (`remoteFailing` in `reconcileVerify`, in the verdict override, in fix-round gaps with an explicit "the failed-log excerpt names the cause — fix it, including files OUTSIDE your original assignment" hint, and in failure reasons). Each fix round re-pushes and re-watches — CI validates the fix, the reference's takeover pattern made deterministic. Skips (no gh / no origin / push failure / no runs triggered) are recorded, never gate.
- **Agent instruction (the unchecked case)**: verify/audit prompts now carry a REMOTE CI POLICY block — *enabled* (cite the driver's observations), *degraded* (attempted, skip recorded), or *disabled* ("Do NOT attempt to reason about hosted CI behavior… record with evidence `not verifiable from this environment: remote CI verification disabled for this run`") so remote-tagged criteria defer cleanly instead of burning rounds.
- **GUI**: "Remote CI" toggle in the Plan row (disabled without Git), `state.remoteChecks` in the Artifacts tab, wire types.

**Live e2e** on a private GitHub test repo (`kmmuntasir/nano-cycle-ci-e2e`, created for this purpose) with a seeded failing CI check and `glm-5.3-flash` (fresh zai quota): round 0 push → CI **red** → verify failed → **targeted** fix round → the coder's commit *"fix: add docs/ready.md readiness marker so scripts/check.js passes"* (root cause read straight from the failed-log excerpt, file outside its original assignment) → re-push → CI **green** → verify accepted (4 checks) → run branch **ff-merged**. 8/8 assertions + 2 policy-prompt unit checks. An earlier honest-failure run (`20260916-011751004`) is kept on disk — it failed only because the test task text forbade the fix.

**Remaining deferred:** worktree isolation for parallel coders only (hot-file serialization remains the mitigation). The test repo is private and disposable — delete at will.


## 8. Ticket wave scheduler (2026-09-16, fourth commit)

Cross-ticket parallelism for the L tier: `runTickets` is now a wave scheduler. A ticket is **admitted** when (a) its dependency tickets are all accepted and (b) its effective file set (planned ∪ written) is disjoint from every in-flight ticket's — independent, non-overlapping tickets run concurrently; file-overlapping or dependent ones still serialize, by evidence rather than by policy. Admitted tickets share one graph driven by a single `runDag` (no double-scheduling); each ticket keeps its own verify gate, scoped fix rounds, and round budget. **Verify gates always serialize against each other** in lane packing — parallel verifies would race compose stacks, test runs, and dev servers in the one working tree. Supporting changes: `planFixRound` returns its requeue list (per-ticket storage) and scoped fallbacks distribute the blob per-node; `feedbackByNode` merges instead of replacing (concurrent tickets never leak feedback into each other); admission requeues done-but-unaccepted tickets so resume retries cleanly.

Verified on an isolated server instance (:4199, separate `runs/` — the live server on :4177 was untouched): a 3-capability plan (A, B independent; C depends on both) admitted A+B concurrently (overlapping execution windows, `wave: 2 parallel lane(s)`), the two verify gates packed into a single lane (`verify-about-page+verify-usage-guide`), C started 2 ms after both dependency verifies ended, all gates + the final cross-ticket verify accepted — 5/5 assertions. Takes effect on the main server after its next restart.


## 9. Mechanical-check false-positive fixes (2026-09-16, fifth commit)

The 4h47m F01 run analysis (§ "where the time went") showed ~3 of its 7 fix rounds were driven by `checks.mjs` false positives: eslint `ignores: ["dist","coverage"]` globs misparsed as imports (deps-declared), `LOCALAPPDATA` reads inside `.pi/`/`.opencode/` toolchain mirrors (env-wiring), and CDN-font hits in `docs/` design sources (no-cdn-fonts). Fixes: the walker excludes toolchain/state directories (`.pi`, `.opencode`, `.kilo`, `.claude`, `.context`, `not_for_ai_models`); the deps-declared config scan counts only real `import`/`require` statements and `plugins:` array entries; no-cdn-fonts returns a new non-gating `warn` status when hits are confined to `docs/` (design sources), failing only on app code. Verified against a regression fixture and the real omni-isp tree — all three false-positive classes are gone. Side finding: an earlier fix-round coder had obeyed the old false positive by adding `LOCALAPPDATA`/`XDG_CACHE_HOME`/`MD_VALIDATE_NO_INSTALL` to `omni-isp/backend/.env.example:44-46` — junk declarations now correctly flagged by env-wiring; remove them manually.

Run cost note (Z.ai list API prices: GLM-5.3 $1.40/$4.40/$0.26 per M in/out/cached; GLM-5.3-Flash $0.15/$0.50/$0.03): the 4h47m run's 2.00M in / 0.75M out / 49.0M cached ≈ **$8.03** of API value ($6.63 on the glm-5.3 gate sessions, $1.39 on the flash builders; ~$7.33 at OpenRouter's promotional flash rates).


## 10. Specs stored outside projects + D1 countermeasures (2026-09-16, sixth commit)

The `.nano-cycle/spec-*.md` write into target projects is gone — it was never consumed by the pipeline and both audits flagged the tree pollution (D8). Specs live in the runs store and are served per project: `GET /api/specs/<project>` (latest + count; `?format=md` for markdown). No new storage engine: `runs/` already is the per-project spec database. Plus the two D1 countermeasures from the audit discussion: a `compose-env` driver check (warn) that flags a compose-auto-loaded project-dir `.env` — the exact stale-file class that broke fresh-volume first boot — and COLD-boot guidance in the verifier prompt ("bootstrap criteria must be exercised on a fresh volume at least once; warm-container success hides first-boot breakage").


## 11. Git fixes: resume branch restore + conventional commit format (2026-09-16, seventh commit)

**Resume bug (found by inspection during the git-lifecycle walkthrough):** after a failed/cancelled git-on run settles, `integrate()` has checked out the base branch — a resume then committed straight onto the base. `execute()` now checks out the run branch before anything else, which also restores the branch's committed files into the working tree for the resumed coders; a failed checkout (dirty tree, missing branch) fails the run loudly with guidance instead of silently mis-committing.

**Commit format:** `commitCoderOutput` now writes `<type>: <subject> (<ticket>)` — the ticket id (`OMNI-###`, `F##`, `####`) is extracted from the task text per the project git-guidelines convention, falling back to `(nano <runId>)`; fix-round re-runs type the commit `fix:`; the 72-char line cap truncates the subject, never the type prefix or ticket suffix.

**Live verification** (scratch repo, four runs): commits read `(OMNI-101)`…`(OMNI-104)` with the suffix intact under truncation; a run cancelled mid-verify settled on `main` with its branch kept, and its resume checked the branch back out (files restored into the tree), completed, and ff-merged cleanly into `main`.

**Incidental finding (not fixed here):** `GET /api/runs/:id` returns the full state plus the entire event log, and every streamed event does a synchronous `appendFileSync` + state `writeFileSync` — during high-thinking verify streams the REST endpoint can starve for minutes (the GUI is unaffected; it rides the WebSocket). A lean status endpoint or async/throttled persistence is a worthwhile follow-up.
