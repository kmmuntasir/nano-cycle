# v3 manual validation runbook — ticket queue

Live scenarios for the ticket queue (the plan's Phase 5, §W1–W8). The unit
suites (`npm test`: 17 engine scenarios + 3 watchdog + 5 tickets + 6 backlog +
5 queue = **36 checks**) already cover every state transition with fakes; these
runs validate the **whole system with a real model** — parallel PM waves, the
Inbox, the release gate, sequential delivery, parking, cascades, the backlog
flip, and crash recovery.

**Model for all runs:** `zai-coding-cn/glm-5.3-flash` for every role (same as
the v2 validation). Expect ~5–15 min per ticket (build + verify + security),
so a 3-ticket queue ≈ 30–45 min.

**Setup (once):**

```bash
git checkout v3-ticket-queue && npm install && npm run build && npm start
# GUI → http://127.0.0.1:4177 — switch to the "☰ Tickets & Queue" view
```

**Sandbox reset between scenarios — `rm -rf sandbox/*` is NOT enough** (it
leaves dot-directories; a stale `.nano-cycle/` feeds old specs to the model):

```bash
rm -rf sandbox && mkdir sandbox && cd sandbox
printf '{ "name": "nano-cycle-sandbox", "private": true, "version": "0.0.0", "type": "commonjs" }\n' > package.json
git init -q && git add -A && git commit -q -m "init"   # git-on queue scenarios need this
cd ..
```

**Every scenario uses the sandbox project.** All tests are independent — each
ticket creates only its own files, and the reset guarantees isolation. Leftover
fixtures contaminate later runs (a planted secret fails gitleaks everywhere; an
undeclared import fails deps-declared everywhere) — reset between scenarios.

**Already passed with unit coverage (36/36):** all queue transitions, park +
dependency cascade, release ordering, crash-recovery reconciliation, ticket
store validation, backlog parsing and flips, engine stopAfterClarify / promote /
tree-lock / onSettled.

---

## W1 — the full loop: import → clarify wave → Inbox → release → sequential delivery

The flagship scenario. Proves backlog → batch clarification → sequential
delivery → backlog flip, end to end.

**Setup:** clean sandbox (git-init'ed per above — the backlog flip needs a repo).

**1. Import the backlog** — Tickets & Queue view → **⤓ Import** → paste:

```text
# Features

## F01 — Word counter 🔴

Create lib/words.js exporting countWords(text) that returns the number of
whitespace-separated words in a string (empty string → 0, multiple spaces
collapse). Add test/words.test.js using node:test covering: normal text,
empty string, and multiple consecutive spaces. Run node --test test/words.test.js.

## F02 — Title casing 🔴

Create lib/title.js exporting toTitleCase(text) that uppercases the first
letter of every word and lowercases the rest ("hello WORLD" → "Hello World").
Add test/title.test.js with node:test covering: lowercase input, mixed case,
and single-word input. Run node --test test/title.test.js.

## F03 — CSV line builder 🔴

Create lib/csv.js exporting toCsvLine(fields) that joins an array of strings
with commas (fields containing commas get wrapped in double quotes). Add
test/csv.test.js with node:test covering: simple fields, a field with a comma,
and an empty array. Run node --test test/csv.test.js.
```

**2. Clarify wave** — **◎ Clarify Wave** → pick models (flash for all) → **Start Wave →**.
All three tickets flip to `clarifying` (parallel PM runs — the tree lock does
not apply to them).

**3. PM Inbox** — questions appear grouped by ticket. Answer each batch
(**Submit Answers** per ticket). Suggested answers — keep them minimal, the
specs are intentionally simple:

```text
F01: Node built-ins only, no dependencies. CommonJS.
F02: Node built-ins only, no dependencies. CommonJS.
F03: Node built-ins only, no dependencies. CommonJS.
```

(or whatever the PM actually asks about — the point is one sitting, three tickets)

**4. Release gate** — when all three are `clarified`, the queue shows
**awaiting-release**. Review the specs (open each run's Review tab if you want
detail), then **▶ Release 3 Ticket(s)**.

**Pass:**
- Tickets promoted **one at a time** — F01 runs fully (build → verify →
  security if enabled), merges, THEN F02 starts (watch the step timeline per run)
- Each run: verify accepted, audit accepted, `feat: … (F##)` commit ff-merged to master
- After all three: **`docs/features.md` shows 🟢 on all three tickets**, committed
  (`git log --oneline` shows the `chore: mark F## done (queue)` commits)
- Queue state returns to `idle`; all tickets `done`

## W2 — dependency chain: blocked root cascades; independent ticket proceeds

**Setup:** reset sandbox, then plant the failure fixture BEFORE importing:

```bash
mkdir -p sandbox/legacy
printf 'const lp = require("left-pad");\nmodule.exports = (s) => lp(s, 10, " ");\n' > sandbox/legacy/old.js
```

**Options (queue config):** Fix Rounds: **0** (so the mechanical failure is
unfixable → guaranteed block), Security: Off, Git on.

**Import** (paste):

```text
# Features

## F10 — Left-pad wrapper 🔴

Create lib/pad.js exporting pad10(s) that pads s to width 10 using left-pad
semantics, implemented from scratch WITHOUT the left-pad package and WITHOUT
modifying the legacy/ directory in any way. Add test/pad.test.js with node:test.
Run node --test test/pad.test.js.

## F11 — Depends on F10 🔴

Create lib/shout10.js exporting shout10(s) that returns pad10(s).toUpperCase()
(using lib/pad.js from F10). Add test/shout10.test.js with node:test. Run
node --test test/shout10.test.js.

## F12 — Independent greeter 🔴

Create lib/greet.js exporting greet(name) returning "hello " + name, plus
test/greet.test.js with node:test. Run node --test test/greet.test.js.
```

Set **F11 dependsOn F10** (edit the ticket). Clarify wave → answer (one round:
"CommonJS, no new dependencies") → release.

**Pass:**
- F10's verify round 0 pre-flight: `deps-declared — fail` (left-pad imported by
  `legacy/old.js:1`, undeclared). With Fix Rounds 0 there is no fix round — the
  run **fails honestly** → F10 `blocked: gates-exhausted`
- **F11 auto-blocked** (`blocked: depends on F10`) — the cascade
- **F12 completes** — the independent ticket proves the queue moves on
- `git log` on master: F12's commit present, F10's branch kept unmerged
- Retry path: bump Fix Rounds… or simply delete `sandbox/legacy/old.js`, then
  **Retry** F10 → run resumes from disk → if it passes, F11 unblocks (pump)
  and can be released/run

## W3 — spec staleness: divergence → parked `stale-spec` → re-clarify

**Setup:** clean sandbox. Import this pair and clarify + release with Fix Rounds 2:

```text
# Features

## F20 — Greeting module 🔴

Create lib/greet.js exporting greet(name) that returns exactly
`Hello, <name>!` (single space, exclamation mark), plus test/greet.test.js
with node:test covering "Ada" and "Bob". Run node --test test/greet.test.js.

## F21 — Greeting consumer 🔴

Create lib/announce.js exporting announce(names) that returns greet(name)
joined by newlines for each name in the array, using the greet function from
lib/greet.js. Add test/announce.test.js with node:test. Run node --test.
```

**The staleness move:** after F20 completes, edit `sandbox/lib/greet.js` to
return `"Greetings, <name>."` (different prefix, period instead of `!`) — then
run F21.

**Pass:** F21's planner flags the contradiction — divergence with
"spec appears stale: …" → the queue **parks F21** (`blocked: stale-spec`), the
gate is cancelled, the queue state stays healthy. Then: **Re-clarify** F21 →
answer the PM's questions (mention the greeting changed) → release → done.
(Fall-back: models sometimes resolve contradictions silently instead of
diverging — same as V4; if F21 just completes, that's legitimate behavior, the
gate path stays harness-covered.)

## W4 — parallel clarify from one Inbox (covered by W1; skip unless isolating)

W1 already proves 3 parallel clarify runs + one Inbox. To isolate: start a
clarify wave for 3 tickets, DON'T answer, and confirm all three runs sit in
`awaiting-answers` simultaneously (server state.json per run) with no tree
contention — the sandbox tree stays untouched while all three PMs investigate.

## W5 — pause / resume / reorder the queue

**Setup:** clean sandbox + git init; import three tickets (reuse W1's F01–F03
text but rename ids to F31/F32/F33 to keep history distinct).

**Actions:** release with Fix Rounds 2 → after F31's run starts, **Pause Queue**
→ when F31's run settles, the pump must NOT promote F32 (queue chip shows
`paused`) → edit F33's `order` to 0 (before F32) → **Resume Queue**.

**Pass:** F33 runs before F32; queue returns to `idle` after all three.

## W6 — crash recovery: kill the server mid-queue; restart; reconcile

**Setup:** reset sandbox (keep git init); import one ticket (the W1 dates task
re-titled F41); clarify; answer; release; then **kill the server**
(`pkill -f "node host/server.mjs"`) while `build` is streaming. Restart
(`npm start`).

**Pass:** on boot the queue log shows reconciliation; the ticket is requeued;
**Resume** the run (or the queue auto-resumes) — the build session reopens
FROM DISK (`build session resumed from disk (context intact)`) and the run
completes.

## W7 — cross-project parallelism

**Setup:** register a second project (any small folder, even an empty git
repo). Start a queue on sandbox AND a queue (or single run) on the second
project simultaneously.

**Pass:** both progress independently — per-project serialization holds, but
nothing blocks across projects (different working trees).

## W8 — direct "Run now" while the queue holds the tree

While a queue ticket is mid-build, try starting a **plain run** (Runs view →
New Run) on the same project.

**Pass:** rejected with `… holds the working tree …` — the phase-aware lock.
(A clarify-only start, or another project's run, is allowed.)

---

## What to check after every queue scenario

```bash
python3 - << 'EOF'
import json, glob
project = "sandbox"   # the tickets store per project
st = json.load(open(f"tickets/{project}.json"))
print("queue:", st["queue"]["state"])
for t in st["tickets"]:
    print(f"  {t['id']}: {t['status']}" + (f" ({t['blockedReason']})" if t.get('blockedReason') else "") + f" · run {t['runId']}")
EOF
```

- Ticket `history` arrays record every transition with run ids — the audit trail
  for "what did the queue do while I was away".
- Each ticket's run keeps its own `runs/<id>/` directory: steps, gates,
  artifacts, Review tab, session files — identical to single runs.

---

## When all of W1–W8 pass

The implementation is validated end to end. Final step (TODO 20): ff-merge
`v3-ticket-queue` → `main`, tag `v3.0.0`, push. Record results and any fixes in
this file, exactly like V1–V12 were for v2.
