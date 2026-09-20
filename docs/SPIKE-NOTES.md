# Spike notes — SDK session persistence (TODO 2)

`node spike/session-persistence.mjs zai-coding-cn/glm-5.3-flash` → **8/8 PASS** (2026-09-20, pi-coding-agent 0.85.1).

## Verified facts the engine relies on

| Assumption | Result | API |
|---|---|---|
| (a) Persistent session + path retrieval | ✅ | `SessionManager.create(cwd, sessionDir)` → `mgr.getSessionFile()` returns the `.jsonl` path; file exists on disk after the first turn |
| (b) Resume with full context | ✅ | `SessionManager.open(file)` + `createAgentSession({ sessionManager })` — codeword from the pre-close turn recalled perfectly after reopen |
| (c) Blocking tool mid-turn | ✅ | A custom tool whose `execute` awaits an external promise: the model issues the call, the turn stays open (toolEntered=true, prompt unsettled), and after release the model continues using the tool-result text (`APPROVED-77` reproduced verbatim) |
| (d) Abort during blocked tool | ✅ | `session.abort()` while the tool is blocked → the `prompt()` promise settles cleanly (no hang) |
| (e) systemPromptOverride on resume | ✅ | The system prompt is **derived from the ResourceLoader, not stored in the file** — a fresh `DefaultResourceLoader` with `systemPromptOverride` re-applies it on resumed sessions (role-answer check passed). The engine can even evolve the step system prompt between rounds |

## Engine implications

1. `openStepSession` in `host/runner.mjs`: first call → `SessionManager.create(run.projectPath, runs/<id>/sessions)`; record `getSessionFile()` into step state. Resume → `SessionManager.open(sessionFile)` with the same loader construction.
2. Milestone gates (`submit_plan` approval, divergence, security-override) can block **inside the tool's execute** — the model receives the owner's decision as the tool result and continues in the same turn. This is the cleanest possible gate UX.
3. Cancel-during-gate: `session.abort()` settles the turn, but the blocked `execute` promise itself must also be released — the engine's `finalizeCancel` resolves pending gate promises with `"cancel"` and gate tools race `gate` vs an abort signal so no tool promise leaks.
4. Session files are JSONL under the directory passed as `sessionDir` — `runs/<id>/sessions/` keeps them inside the run's own storage (audit trail + restart resume).
