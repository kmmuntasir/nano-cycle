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

**Step 2 — Build.** plan → *(owner approves the compiled plan — M/L tiers, on by
default)* → parallel coders → verify, fully autonomous. The spec's acceptance
criteria flow **verbatim into the plan AND into every coder's prompt** (with the
source requirement docs and the repo's testing rules) — the builders see the same
contract the verifier gates on. Verify rejects → only the coder nodes that **own
the failing gaps** re-run, each with only its gaps (`maxFixRounds`, default 2) →
accepted or honestly `failed`. Deterministic driver checks (below) run before
every verify pass and cannot be argued away by the model.

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
L     plan → ticket₁(coders → verify) → ticket₂(…) → final verify   (ticket pipeline)
```

**L is ticket-shaped, wave-scheduled.** The plan decomposes the task into 2–6
*capabilities*; the engine compiles them into **tickets**. A ticket is admitted
when its dependency tickets are all **accepted** AND its effective file set
(planned ∪ written) is **disjoint** from every in-flight ticket's — so
independent, non-overlapping tickets run in parallel waves, each ticket keeping
its own verify gate (`verify-<capId>`, scoped to that capability's files) and
scoped fix rounds. Verify gates always serialize against each other (parallel
verifies would race compose stacks and test runs in the one tree). A final
cross-ticket verify (+ audit) sweeps the whole tree at the end. Small,
deeply-verified diffs without artificial serialization; a failing ticket fails
the run with its reasons and is resumable.

The **counterpart rule is a compiler check**: a capability with only one side must
declare why it legally has no counterpart (`plumbing` / `devops` / `qa` /
`no-counterpart`) or the plan is rejected and the planner retries with the reason.
Verify is an independent gate that must run the code before it may accept.

Model selection is **role-based** — `PM (clarify)`, `Plan`, `Backend coder`,
`Frontend coder`, `Verify` — so a dynamic graph with any number of coder nodes inherits
the right model per role. Picks persist in the browser (localStorage) until changed;
a master chooser fills every role at once. Mid-run swaps are live: a queued node picks
up the new model when it starts, a running node stops and restarts with it. Beside
every picker, a second dropdown sets the **thinking level** (`provider/model:level`)
from the levels that model actually supports (via pi's model catalog); "(default)"
uses the node's configured level.

## How nodes are constrained

| Layer | Mechanism |
|---|---|
| Spawning | the graph walks nodes; the model cannot spawn anything |
| Tools | per-node allowlists (`plan`/`verify` are read-only); verify gets a browser (`web_reader`) when obscura is on PATH |
| Context | driver-assembled system prompt; zero runtime discovery |
| Outputs | schema'd `report_artifact` tool call, validated by the driver |
| Models | per-node `provider/model:thinking` from run config (GUI picker) |
| Effort | thinking level `high` for every role |
| Ground truth | driver-side mechanical checks before every verify — the model cannot overrule them |
| Resume/cancel | `session.abort()` per node; run state persists under `runs/` |

## Deterministic ground truth — driver checks (`host/checks.mjs`)

Before **every** verify pass the driver itself runs, in the project tree:

| Check | Catches |
|---|---|
| `secrets-gitleaks` | real secrets in the tree (gitleaks binary → pinned docker → skip) |
| `deps-declared` | imports/configs referencing packages no `package.json` declares (per-manifest scope, tsconfig-alias aware) |
| `no-cdn-fonts` | `fonts.googleapis.com`/`gstatic` references — the tofu failure mode |
| `i18n-parity` | `en.json`/`bn.json` locale pairs with different key sets (both directions) |
| `env-wiring` | `.env.example` keys vs `process.env`/`import.meta.env` reads, both directions |
| `readme-commands` | README-documented `npm run <x>` / `./scripts/<y>` that don't resolve |

Failures gate the run even if the verify model passes the criterion; skips never
gate. Results land in the verify prompt as ground truth, in `state.mechanicalChecks`
(visible in the GUI's Artifacts tab), and in the event feed. Disable with
`NANO_CHECKS=off` (or a comma list of ids); pin the gitleaks image with
`NANO_GITLEAKS_IMAGE`.

## Remote CI verification (opt-in)

The **Remote CI** start toggle (requires **Git** enabled) answers the
"CI blocks merge on GitHub" class of criteria mechanically: before the final
verify, the driver pushes the run branch to `origin` and watches the hosted
GitHub Actions runs it triggers (`gh`, capped at `NANO_CI_TIMEOUT_MS`, default
20 min). Green runs evidence "CI is green" criteria directly; a red run gates
the fix loop with its failed-log excerpt — the next round's coders fix what CI
actually reported, and the re-push re-validates. Results (run URLs,
conclusions, logs) land in `state.remoteChecks`, the verify prompt, and the
GUI's Artifacts tab.

Unchecked — or Git off, or `gh`/origin unavailable (recorded skip) — the
verifier is explicitly instructed NOT to reason about hosted CI: remote-tagged
criteria are recorded as deferred, never gate, and never burn fix rounds.

## Targeted fix rounds

A rejected round maps each failing check / blocking finding to the coder node(s)
whose planned-or-written files it cites (path matching against assignments) and
**requeues only those nodes** — each gets its own gaps plus its previous artifact
("build on it; do not undo what already passes"). If no gap matches any coder's
files, the round falls back to requeueing everyone (the old behavior). Per-node
feedback is persisted in `state.feedbackByNode`; files written so far in
`state.writtenFiles` also feed lane packing — nodes whose effective file sets
(planned ∪ written) overlap always serialize, killing hot-file collisions.

## Verification environments (defers the unfixable)

The clarify phase tags every acceptance criterion `local` / `remote` / `human`
(`spec.ac_verification`). A failing check on a `remote`/`human` criterion whose
evidence indicates an environment limit (no git remote, branch protection,
hosted CI) is recorded in `state.deferredChecks` and surfaced to the owner — it
never burns a fix round no coder could ever fix. Untagged specs keep the legacy
`not verifiable…` evidence-prefix heuristic.

## Project context (optional, conventional)

Projects teach nano-cycle about themselves through files — all optional, injected when
present, discovered at runtime never:

```txt
<project>/AGENTS.md | CLAUDE.md                        → every node
<project>/.claude/rules/backend-development-rules.md   → implement-be (with security-rules.md)
<project>/.claude/rules/frontend-development-rules.md  → implement-fe
<project>/.claude/rules/testing-rules.md               → implement nodes AND verify/audit
<project>/.claude/rules/git-guidelines.md              → implement nodes AND verify/audit
```

Coders also receive the **full contract** in their prompt: the spec's acceptance
criteria verbatim, the plan's own criteria, the raw source requirement documents
(`spec.source_docs`), and — on fix rounds — their previous artifact. The design
goal: builders and verifiers judge against the same law.

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
