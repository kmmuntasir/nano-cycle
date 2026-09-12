# nano-cycle

A deterministic agent pipeline with a live monitoring GUI. The script owns sequencing,
spawning, context, tool allowlists, and structured outputs — the model only makes
judgment calls inside a node. Built on the [pi SDK](https://pi.dev/docs/latest/sdk).

```txt
plan → implement-be ∥ implement-fe → verify     (M tier — parallel lanes)
```

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
demo  plan → implement → verify                     (+1 fix round, divergence gate after plan)
S     implement → verify                            (no planning)
M     plan → implement-be ∥ implement-fe → verify   (parallel lanes when disjoint)
```

The **M** tier is the counterpart rule as code: the plan splits work into backend/frontend
halves; when their file lists are disjoint the two implement nodes run as concurrent pi
sessions in the project tree — overlapping lists fall back to sequential automatically.
Verify is an independent gate that must run the code before it may accept.

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
