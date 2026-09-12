# nano-cycle

A deterministic agent pipeline with a live monitoring GUI. The script owns sequencing,
spawning, context, tool allowlists, and structured outputs — the model only makes
judgment calls inside a node. Built on the [pi SDK](https://pi.dev/docs/latest/sdk).

## The two-step flow

**Step 1 — Clarify (PM loop).** Toggle *Clarify first* on a run. The clarify node
inspects the project (read-only + `investigate` analyst sessions + optional web tools),
asks the owner high-leverage questions in batches (answered in the GUI), and repeats
until it locks a **spec**: refined summary, decisions, and acceptance criteria. The spec
is written to `<project>/.nano-cycle/spec-<runid>.md` and is THE contract.

**Step 2 — Build.** plan → parallel coders → verify, fully autonomous. The spec's
acceptance criteria flow verbatim into the plan and the verifier gates on them.
Verify rejects → coder nodes re-run with the failing checks as feedback
(`maxFixRounds`, default 2) → accepted or honestly `failed`.

## Web research (optional)

Clarify nodes can use `web_search` (SearXNG) and `web_reader` (obscura) when available:

```bash
docker run -d -p 8888:8080 searxng/searxng   # then:
NANO_SEARXNG_URL=http://127.0.0.1:8888 npm start
```

`web_reader` needs `obscura` on PATH. Without these, clarify runs fine on project
context alone.

## Run

Works on **any local project, any language**: register a folder, pick a tier and
per-node models, watch every node stream live.

## Run

```bash
npm install
npm run build      # builds the web GUI into web-dist/
npm start          # http://127.0.0.1:4177
```

1. **Add a project** — an absolute path to any local folder (a built-in `sandbox/`
   exists for scratch work).
2. **Pick a tier + per-node models** — any model your pi auth can reach
   (`provider/model` or `provider/model:thinking`).
3. **Start** — watch text, tool calls, and token usage stream per node.

## Tiers

```txt
demo  plan → implement → verify                                (+fix rounds, divergence gate)
S     implement → verify                                       (no planning)
M     plan → implement-be ∥ implement-fe → verify              (one slice, two parallel lanes)
L     plan → [cap₁-be ∥ cap₁-fe] → [cap₂ …] → verify           (dynamic work graph)
```

**L is graph-shaped.** The plan decomposes the task into 2–6 *capabilities* with
capability-level dependencies; the engine compiles each into backend/frontend coder
nodes — any number of parallel coders per side — and schedules waves greedily: nodes
whose file lists overlap serialize within a lane, disjoint nodes run concurrently.
A dependency between capabilities (shared module before its consumers) is respected
by the DAG.

The **counterpart rule is a compiler check**: a capability with only one side must
declare why it legally has no counterpart (`plumbing` / `devops` / `qa` /
`no-counterpart`) or the plan is rejected and the planner retries with the reason.
Verify is an independent gate that must run the code before it may accept.

Model selection is **role-based** — `plan`, `backend`, `frontend`, `verify` — so a
dynamic graph with any number of coder nodes inherits the right model per role.

## How nodes are constrained

| Layer | Mechanism |
|---|---|
| Spawning | the graph walks nodes; the model cannot spawn anything |
| Tools | per-node allowlists (`plan`/`verify` are read-only) |
| Context | driver-assembled system prompt; zero runtime discovery |
| Outputs | schema'd `report_artifact` tool call, validated by the driver |
| Models | per-node `provider/model:thinking` from run config (GUI picker) |
| Resume/cancel | `session.abort()` per node; run state persists under `runs/` |

## Project context (optional, conventional)

Projects teach nano-cycle about themselves through files — all optional, injected when
present, discovered at runtime never:

```txt
<project>/AGENTS.md | CLAUDE.md                        → every node
<project>/.claude/rules/backend-development-rules.md   → implement-be (with security-rules.md)
<project>/.claude/rules/frontend-development-rules.md  → implement-fe
<project>/.claude/rules/testing-rules.md               → verify
```

A project with none of these simply runs on the built-in minimal rules.

## Layout

```txt
host/
  server.mjs     HTTP + WebSocket + static GUI; owns ModelRuntime + project registry
  pipeline.mjs   the state machine: tier DAG, gates, fix rounds, parallel lanes
  runner.mjs     one pi SDK AgentSession per node (createAgentSession)
  prompts.mjs    per-node prompt assembly
  rules.mjs      per-project, per-node context resolution (conventional files)
  projects.mjs   project registry (projects.json, gitignored)
  config.mjs     node profiles (tools, thinking, artifact schemas) + tiers
  state.mjs      runs/<id>/state.json + events.jsonl (GUI replay)
web/             React 19 + Vite + MUI monitoring GUI
```

## License

GPL-3.0 — see [LICENSE](LICENSE).
