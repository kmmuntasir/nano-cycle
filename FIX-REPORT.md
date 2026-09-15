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
