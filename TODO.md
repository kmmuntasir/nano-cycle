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
