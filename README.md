# nano-cycle

A four-step agentic development workflow with a live monitoring GUI, built on the
[pi SDK](https://pi.dev/docs/latest/sdk). One judgment-rich agent session per
step; the driver owns the gates. **Skills own method, the driver owns law.**

## The workflow

**Step 1 — Clarify (optional, default ON).** The PM loop, unchanged in spirit:
a clarify session inspects the project (read-only + `investigate` analysts +
optional web tools), asks the owner high-leverage questions in batches (answered
in the GUI), repeats until it locks a **spec**: refined summary, decisions,
acceptance criteria (each tagged `local` / `remote` / `human` by verification
environment), and source-doc traceability. The spec is THE contract — stored
with the run (`runs/<id>/state.json`), served per project at
`GET /api/specs/<project>` (`?format=md` for markdown), never written into the
target repo.

**Step 2 — Build. ONE persistent agent session** that walks three phases, each
a skill + a milestone tool:

- **2.1 Plan** (`submit_plan`) — investigate first; every file with a purpose;
  every spec criterion carried verbatim. **Owner approval gate** (default ON)
  blocks inside the tool: approve, or reject with comments — the same session
  revises and resubmits. Divergence ("task impossible as specified") is its
  own gate.
- **2.2 Task breakdown** (`submit_tasks`) — 2–8 tasks with per-task ACs and
  files. The driver validates dependencies, cycles, and the **file-overlap ⇒
  dependency** rule (shared files must be ordered). The skill defines when
  `dispatch_coder` subagents are worth it (file-disjoint, substantial tasks).
- **2.3 Implement** (`submit_impl_delta`) — build everything, run lint/tests,
  report honestly (per-task completion). Milestone commit on the run branch.

**Step 3 — Verify. A FRESH session per round** (never the builder's own
context): pre-flighted by the driver's mechanical ground truth, it runs
**3.1 verify** (`submit_verify` — assume every criterion unmet until observed
passing) and, only if accepted, **3.2 audit** (`submit_audit` — deliverables
against requirements; mandated to re-read source docs BEFORE trusting its own
verify results). Gaps (failing checks, blocking findings, mechanical/remote
failures) trigger a fix round that **resumes the build session** with targeted
feedback — the original builder context fixes its own work. Bounded
(`maxFixRounds`, default 2), then honest failure with reasons.

**Step 4 — Security (optional: Off / Scan / Scan+VAPT). A fresh session** over
driver-run deterministic scanners (gitleaks, dependency audit, semgrep/trivy
when present — skips recorded, never silent). The model triages: severity +
`fixable_in_scope` honesty. Critical/high fixable → one security fix round
(resuming the build session); unfixable → **security-override gate**: you
accept the risk (recorded) or cancel. VAPT adds running-app probes (boot the
documented stack, headers/CORS/leakage/authz spot-checks) with observed
evidence.

## The driver owns law (the model cannot overrule)

| Layer | Mechanism |
|---|---|
| Sequencing | four steps + milestones; the model cannot skip ahead (no milestone → no gate opens) |
| Gates | spec answers, plan approval (approve / **reject-with-comments**), divergence, security override — blocking inside milestone tools |
| Ground truth | driver-run mechanical checks before every verify round: gitleaks, deps-declared, no-cdn-fonts, i18n-parity, env-wiring, readme-commands, compose-env/pins |
| Verdicts | reconciliation — checks over self-reported verdicts, blocking findings over verdicts, driver observations over everything |
| Fix rounds | bounded; feedback targets owning tasks; the build session resumes (same context), never respawns |
| Outputs | schema'd milestone tools, validated by the driver (`validatePlan` / `validateTasks` / severity gates) |
| Deferral | remote/human-tagged criteria that fail for environment reasons are recorded, never burn rounds |
| Git | branch per run, milestone commits (conventional format, ticket ids honored), verdict-gated ff-merge |
| Remote CI | opt-in: push + watch hosted Actions before verify rounds — red CI is ground truth |
| Persistence | step sessions stored under `runs/<id>/sessions/`; resume works across server restarts |

## Skills (method, injected per step)

`planning` · `task-breakdown` · `implementation` (build session) — `verification`
· `audit-deliverables` (verify session) — `security-scan` (+`scripts/run-scanners.mjs`)
· `vapt` (security session) — plus `markdown-writer` everywhere. Step system
prompts FORCE loading the phase skill before its milestone tool. Repo-local
skills stay ignored by design; the driver owns context.

## Token hygiene (every agent run)

Every agent session — pipeline steps, clarify/analyst/coder children, and chat
— gets a **token-hygiene** block injected into its system prompt
(`host/token-hygiene.mjs`): **caveman-lite** output discipline (terse, no
filler, technical terms and error strings verbatim; security findings and
irreversible-action warnings stay in full plain prose) adapted from
[JuliusBrussee/caveman](https://github.com/JuliusBrussee/caveman), plus
**rtk** usage when the [rtk](https://github.com/cantrelldev/rtk) CLI is
installed — agents prefer `rtk git status|diff|log|test|…` for read-only,
output-heavy commands so filtered output reaches the context instead of raw
dumps. Milestones and artifacts are structured tool calls; style never touches
machine-parsed output.

## Ticket queue (v3)

Beyond single runs, each project has a **ticket backlog** (the "☰ Tickets & Queue" view):

- **Backlog** — create tickets or import the project's own `docs/features.md`.
  The lenient parser understands both common shapes — heading style
  (`## F01 — Title 🔴`) and checkbox-list style (`- [x] **F00 — Title**` with
  `Builds on: F05.` dependency lines) — with any ticket-id prefix (F##,
  OMNI-###, GM-##…). Tickets live outside the target repo.
- **Clarify wave** — start PM clarification runs for every draft ticket at once;
  answer all of them in one **PM Inbox** screen.
- **Release gate** — review the locked specs in a batch (rendered exactly as
  presented), then release the queue.
- **Sequential delivery** — tickets are promoted one at a time (build → verify
  → security), each on its own branch, verdict-gated ff-merge. Gates **park
  tickets, never the queue**: a ticket that fails its gates becomes `blocked`
  (dependents cascade), independent tickets keep flowing; retry resumes the
  parked run from disk, re-clarify starts fresh PM round seeded with the old spec.
- **Spec staleness** — a spec clarified before earlier tickets were built is
  re-checked by the builder; repo/spec contradictions surface as divergence
  (`stale-spec`) instead of silent adaptation.
- **Completion flip** — a finished ticket's 🔴 → 🟢 in the backlog doc,
  committed to the base branch.

The engine stays a four-step state machine; the queue (`host/queue.mjs`) sits
above it and drives the existing run API.

### Chat — a standalone coding agent per project

The **Chat** tab runs a direct coding-agent session against the selected
project, outside the four-step pipeline: create/resume/delete sessions, pick
model + thinking level, stream text and thinking live, watch each tool call
(with diffs for edits), abort mid-turn. Sessions persist per project (the pi
SDK's session store) — useful for small jobs that don't need the
spec/verify/security law of a full run.

### Agent access — the nano-cycle MCP server

No parser covers every features-doc shape. For anything unusual, let your
agent be the parser: it reads the project's docs with its own file tools,
structures the tickets, and pushes them in — the reliable import path.

```bash
# with the host server running (npm start):
claude mcp add nano-cycle -- node /path/to/nano-cycle/host/mcp-tickets.mjs
# any other MCP client: command `node`, args [<repo>/host/mcp-tickets.mjs]
# base URL: env NANO_CYCLE_URL (default http://127.0.0.1:4177)
```

11 tools: `nano_list_projects`, `nano_get_tickets`, `nano_create_ticket`,
`nano_bulk_create_tickets` (the agent import — arbitrary formats, deps in one
batch, idempotent), `nano_import_features_file` (the lenient parser, by path),
`nano_update_ticket`, `nano_delete_ticket`, `nano_queue` (clarify / release /
pause / resume / retry / reclarify / reorder / config), `nano_inbox`,
`nano_answer`, `nano_get_run` (specs, gates, artifacts). The GUI stays the
primary surface; the MCP makes the same API scriptable.

## Run

```bash
cp .env.example .env   # fill in PI_AUTH_JSON (cat ~/.pi/agent/auth.json from a
                       # logged-in machine, single-quoted) + NANO_PORT/NANO_HOST
scripts/deploy.sh      # credentials → ~/.pi/agent, prereq checks, optional-tool
                       # report (rtk/obscura/gh/scanners), npm install + build
                       # (--systemd also writes a service unit)
npm start
```

Manual alternative:

```bash
npm install
npm run build      # web GUI → web-dist/
npm start          # http://127.0.0.1:4177
npm test           # engine unit harness (fake sessions, 13 scenarios)
```

1. **Add a project** — any local folder (built-in `sandbox/` for scratch — run
   `git init && git add -A && git commit -m init` inside it to enable git features there).
2. **Pick models per step** — PM (clarify), Builder, Verifier, Security — any
   model your pi auth reaches (`provider/model` or `provider/model:level`),
   plus a master chooser. Picks persist in the browser. Swaps apply to queued
   steps (a running step keeps its model — one session, one mind).
3. **Choose options** — Clarify (ON/OFF), Plan approval, Audit, Security
   (Off/Scan/Scan+VAPT), Git, Remote CI, fix rounds.
4. **Start** — live step timeline (four steps, fix-round counters, gate
   banners), streaming console per step, artifacts tab (spec, plan, tasks,
   impl-delta, verify, audit, security, mechanical/remote/scanner results,
   deferred checks, Q&A history).

Optional web research for clarify: `NANO_SEARXNG_URL=http://127.0.0.1:8888 npm start`
(SearXNG docker) + `obscura` on PATH for `web_reader`.

## Project context (optional, conventional)

```txt
<project>/AGENTS.md | CLAUDE.md                        → every step
<project>/.claude/rules/*.md  or  .pi/rules/*.md       → per step:
  backend-development-rules.md + security-rules.md + frontend-development-rules.md
  + testing-rules.md + git-guidelines.md               → build (one context; the lane split is gone) AND verify
  security-rules.md                                    → security
```

`.claude/` wins over `.pi/` per filename; a project with none of these runs on
the built-in minimal rules.

## Environment variables

`NANO_CHECKS` (off / comma list), `NANO_GITLEAKS_IMAGE`, `NANO_EXCLUDE_DIRS`,
`NANO_STALL_TIMEOUT_MS`, `NANO_CI_TIMEOUT_MS` — plus v2:
`NANO_SECURITY_FIX_ROUNDS` (default 1), `NANO_MAX_CODER_SUBAGENTS` (default 4).

## Layout

```txt
host/
  server.mjs     HTTP + WebSocket + static GUI; ModelRuntime + project registry
  engine.mjs     the four-step state machine: milestones, gates, fix loops, reconciliation
  runner.mjs     per-step skill filtering + persistent step sessions (SessionManager)
  prompts.mjs    step system prompts + prompt/feedback-turn builders
  rules.mjs      per-step context resolution (conventional files)
  config.mjs     milestone schemas, step profiles, model roles, validators
  checks.mjs     driver-side mechanical ground truth (unchanged from v1)
  ci.mjs         remote CI capability probe + run watching
  git.mjs        branch / commit / ff-merge integration
  state.mjs      runs/<id>/state.json + events.jsonl (+ sessions/)
skills/          7 workflow skills + markdown-writer (+ scanner script)
tests/           engine unit harness (npm test)
docs/            PLAN-v2-step-workflow.md · SPIKE-NOTES.md · V2-VALIDATION.md
web/             React 19 + Vite + MUI monitoring GUI
```

## Design docs

- `docs/PLAN-v2-step-workflow.md` — the redesign: rationale (RC1–RC10), the
  five agreed amendments, architecture, and the sequenced implementation plan.
- `docs/SPIKE-NOTES.md` — SDK session-persistence proofs the engine rests on.
- `docs/V2-VALIDATION.md` — the manual validation runbook (V1–V12).

## License

GPL-3.0 — see [LICENSE](LICENSE).
