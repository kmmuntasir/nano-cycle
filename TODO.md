# nano-cycle fix — TODO

Tracking the approved plan (`~/.claude/plans/drifting-giggling-toucan.md`; analysis in `PIPELINE-VS-REFERENCE-ROOT-CAUSE-ANALYSIS.md` §6 Track 2).

## 1. host/config.mjs
- [x] Replace CODING_RULES with IMPLEMENT_RULES (implement profile only); remove rules from verify/audit
- [x] Thinking levels: plan/implement/clarify medium, verify high
- [x] implement schema + `notes` (impl-delta)
- [x] spec schema + `ac_verification` (local/remote/human)

## 2. host/rules.mjs
- [x] testing-rules.md + git-guidelines.md into implement lanes; git-guidelines into verify/audit

## 3. host/prompts.mjs
- [x] implementPrompt: ACs verbatim, planCriteria, sourceDocText, nodeFeedback, previousArtifact
- [x] implementSystem alignment; verifySystem browser + env-classification guidance
- [x] verifyPrompt: acVerification + mechanicalResults blocks
- [x] auditPrompt: mechanicalResults (informational)
- [x] clarifySystem: ac_verification tagging + delivery-shape questions

## 4. host/checks.mjs (new)
- [x] Module + walk/withTimeout/NANO_CHECKS plumbing
- [x] secrets-gitleaks · deps-declared · no-cdn-fonts · i18n-parity · env-wiring · readme-commands
- [x] Fixture-tree test (fail/skip behavior)

## 5. host/pipeline.mjs
- [x] start() plumbing: approvePlan, new state fields (feedbackByNode, writtenFiles, deferredChecks, mechanicalChecks), run.round
- [x] Contract injection: sourceDocsFor memo + promptFor work-node + fallback branch
- [x] Hot-file serialization: trackWrittenFiles + effectiveFilesOf in packParallel
- [x] Plan-approval gate: planApprovalPayload + planPhase gate + pendingPlanApproval re-check in execute()
- [x] Targeted fix rounds: ownersForGap/planFixRound/fileKey + requeue-set + feedbackByNode + fallback notice
- [x] Mechanical gate: runMechanicalGate hooked before every verify; reconciliation merge (mechFailing + deferredChecks + matchAcVerification)
- [x] Browser for verify: web_reader attach + notice
- [x] writeSpecFile: verification-environments section

## 6. host/server.mjs
- [x] approvePlan passthrough

## 7. Web GUI
- [x] api.ts: gate union + plan payload + RunState fields + start opts
- [x] GatePanel.tsx: plan-approval banner + panel branches
- [x] StartForm.tsx + App.tsx: approvePlan toggle + payload
- [x] Workbench.tsx: checks:mechanical / checks:deferred pseudo-artifacts
- [x] npm run build

## 8. Verification
- [x] node --check all host files; config thinking assertion (medium medium high high medium)
- [x] checks.mjs fixture run (all 6 checks fire correctly; gitleaks via docker fallback)
- [x] Live runs: completed M run 20260916-002302252 (all gates green) + adversarial run 20260916-003417584 (mechanical gate forced a targeted fix round; failed honestly when the free-tier coder didn't comply)
- [x] Assertions on runs/<id>/state.json + events.jsonl — all PASS (AC block + plan criteria + source doc + testing/git rules in coder prompts; notes artifact; mechanical results in verify prompt; browser attach notice)
- [x] Regression: cancel-at-plan-gate → resume re-presents the gate (exposed and fixed a cancel-as-plan-rejection bug first — see FIX-REPORT)

## 9. Docs
- [x] README.md updates (new mechanisms)
- [x] FIX-REPORT.md

## 10. Follow-up round (deferred items, 2026-09-16)
- [x] Thinking levels → high for every role (plan/implement/clarify raised from medium)
- [x] L-tier ticketization: capabilities compile to sequential tickets (coders → verify-<capId> gate → scoped fix rounds) + final cross-ticket verify; resume requeues only non-accepted tickets
- [x] verify-<cap> profiles/roles, ticket-scoped verifyPrompt, GUI "Ticket Gates (L)" lane, state.tickets
- [x] fix: execute() now drives the L plan phase before the ticket loop (first attempt skipped it — run starved on a null graph)
- [x] Live L run verified end-to-end (20260916-005034498, 3 tickets, all gates green, 17/17 assertions)
- [ ] Mechanical remote CI verification (push + gh run watch) — still deferred, needs a configured remote
- [ ] Worktree isolation for parallel coders — still deferred (hot-file serialization is the mitigation)

## 11. Remote CI verification (final deferred item, 2026-09-16)
- [x] Start-of-run toggle "Remote CI" (opt-in, requires Git; GUI + server + start plumbing)
- [x] host/ci.mjs: gh capability probe (binary + auth + repo access, cwd-correct) + watchRunsForSha (push → settle → list → poll to completion, 20-min cap, failed-log excerpts)
- [x] git.mjs: hasRemote / pushBranch / headSha
- [x] runRemoteCiGate before the FINAL verify only; results in state.remoteChecks; red CI gates like a mechanical failure; re-push each fix round re-validates
- [x] Remote policy injected into verify/audit prompts — enabled (cite observations) / degraded (skip recorded) / disabled (agents instructed NOT to reason about hosted CI; remote-tagged criteria defer)
- [x] fix: gh ran in the server's cwd, not the project's (caught by unit test)
- [x] Live e2e on private GitHub test repo (glm-5.3-flash): round 0 CI red → targeted fix round → coder fixed root cause from failed-log excerpt → round 1 CI green → accepted → ff-merged. 8/8 assertions + 2 prompt unit checks
- [ ] Worktree isolation for parallel coders — the only remaining deferred item (hot-file serialization is the mitigation)

## 12. Ticket wave scheduler (2026-09-16)
- [x] runTickets rewritten as a wave scheduler: a ticket is admitted when deps are accepted AND its file set is disjoint from in-flight tickets; admitted tickets share one graph (single runDag — no double-scheduling), each keeps its own verify gate + scoped fix rounds + round budget
- [x] planFixRound returns the requeue list (per-ticket storage); scoped fallback distributes the blob per-node; feedbackByNode MERGES (concurrent tickets never leak feedback)
- [x] Verify-shaped nodes always serialize against each other in lane packing (parallel verifies would race compose/test runs in one tree)
- [x] reconcileVerify notices carry the source verify node id
- [x] Live wave test (isolated server on :4199): 2 independent tickets ran concurrently (overlapping windows), verify gates serialized into one lane, dependent ticket started after both dep verifies, all gates + final verify accepted — 5/5 assertions

## 13. Mechanical-check false-positive fixes (2026-09-16)
- [x] Walk exclusions: .pi/.opencode/.kilo/.claude/.context/not_for_ai_models (toolchain mirrors ≠ product code)
- [x] deps-declared config scan: real import/require + `plugins:` entries only (eslint `ignores:` globs no longer count as imports)
- [x] no-cdn-fonts: docs/**-only hits → non-gating "warn" status (design sources); app-code hits still fail
- [x] Fixture regression + real omni-isp tree verified (the three false-positive classes that burned fix rounds in run 20260916-014301453 are gone)

## 14. Specs out of projects + D1 countermeasures (2026-09-16)
- [x] writeSpecFile removed — nothing is written into target repos; specs persist in runs/ and are served per project via GET /api/specs/:project (?format=md)
- [x] compose-env driver check (warn): project-dir .env auto-loaded by compose → first-boot drift warning (the D1 class)
- [x] verifySystem: COLD-boot guidance for bootstrap criteria (fresh volume/project name — warm-container success hides first-boot breakage)

## 15. Comparison-mined improvements (2026-09-16)
- [x] Test-depth prompts: verifySystem (separate degraded-path e2e per dependency, envelope coverage, helper unit tests; shallow = say so) + implementSystem (failure paths, not just happy)
- [x] e2e-wiring blind spot: verifySystem (e2e boots the app as the entrypoint does) + auditSystem quality list (hand-rebuilt bootstrap = drift risk)
- [x] compose-pins check (warn): floating image refs in compose files (inline + block YAML)
- [x] Git-off startup nudge (process debt warning)
- [x] feature-status check (warn): task's feature id still 🔴 in docs/features.md (both F01 trees shipped stale)
- [x] Observability contract added to clarify delivery-shape questions
- [x] gitleaks.toml allowlist: agreed NOT needed (audits disproved the false-positive risk)
- Verified on fixtures + the real omni-isp tree: the three new warns flag exactly the three open audit items (stale .env, RedisInsight :latest, F01 🔴)

## 16. Git fixes (2026-09-16)
- [x] Fix: resumed git-on runs committed to the base branch — execute() now checks out the run branch first (also restores the branch's committed files into the tree); checkout failure = loud run failure with guidance
- [x] Commit format honors project conventions: `<type>: <subject> (<OMNI-###|F##|#id>)` extracted from the task (fallback `(nano <runId>)`); fix-round re-commits type as `fix:`; 72-char cap never truncates the ticket suffix
- [x] Live-verified on a scratch repo: cancel-during-verify → settled on main + branch kept → resume → branch restored + files back in tree → verify → ff-merge into main; commits read (OMNI-101..104)

## 17. Project-agnosticism pass (2026-09-16)
- [x] rules.mjs: context resolved from .claude/rules AND .pi/rules (.claude wins per filename); .pi/AGENTS.md fallback when no root AGENTS/CLAUDE — .pi-only projects now fully visible to every node
- [x] checks.mjs: deps-declared discovers package.json anywhere (was hardcoded backend/frontend/apps); i18n-parity = any ISO-coded locale SET (was en/bn hardcoded); feature-status check REMOVED (verify-prompt guidance instead); not_for_ai_models dropped, NANO_EXCLUDE_DIRS env added
- [x] prompts: functional lane definitions (backend=system/non-UI incl. CLIs/workers/CI; frontend=UI/client; single-sided normal), conditional web/i18n examples, pointer-following source-doc discovery, backlog-staleness verify guidance, multi-location governance wording
- [x] Verified: .pi-only project resolves full ruleset; .claude precedence; locale sets catch drift in any language pair/triple; bare repo skips cleanly; new project runs deps-declared green
