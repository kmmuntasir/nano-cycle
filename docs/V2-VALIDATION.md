# v2 manual validation runbook

Live scenarios for the four-step workflow (the plan's Phase 9, §V1–V12). The
unit harness (`npm test`, 13/13) already covers the engine's state-machine
paths; these runs validate the **whole system with a real model** — skills
loading, gate UX, session persistence across fix rounds, git, security.

**Model for all runs (as used during development):** `zai-coding-cn/glm-5.3-flash`
for every role (set it once via the master picker). Expect ~3–8 min per run
(build is the long step).

**Every scenario's Options line states ALL seven start toggles** — Clarify ·
Security · Git · Remote CI · Audit · Plan Approval · Fix Rounds — so a table
row is a complete run configuration. Models are as above unless a row says
otherwise.

**Setup (once):**

```bash
git checkout v2-step-workflow && npm install && npm run build && npm start
# GUI → http://127.0.0.1:4177
```

**Reset the sandbox between tests — note `rm -rf sandbox/*` is NOT enough**
(it leaves dot-directories like a stale `.nano-cycle/` full of old v1 specs,
which the model will read as project context). Use:

```bash
rm -rf sandbox && mkdir sandbox && printf '{ "name": "nano-cycle-sandbox", "private": true, "version": "0.0.0", "type": "commonjs" }\n' > sandbox/package.json
```

**Validated — development runs (2026-09-20, glm-5.3-flash):**

- ✅ **V1** happy path (run `20260920-154407664`) — plan→tasks→impl→verify 7/7→audit accepted; all 5 skills observed loaded; sandbox tests green.
- ✅ **V2** clarify loop (dev run `20260920-155539141`) — 3 real owner questions, answers via GUI, spec locked, all gates green.
- ⚠️→✅ **V2 owner run `20260920-201117278`** failed at the plan gate: approving after >5 min at the gate tripped the stall watchdog (it treated the in-tool gate wait as a provider stall). **Fixed** — stall detection now pauses while any tool execution is in flight (gates, coder subagents, analysts); regression-tested in `tests/watchdog.test.mjs`.
- ✅ **V2** owner re-run after the fix (run `20260920-204148298`) — completed; 4 real PM questions; spec locked (7 ACs, 7 decisions, all env-tagged); 0 spec ACs missing from the plan; verify 7/7; audit clean; all 5 skills in phase order.
- ✅ **V3** plan reject-with-comments (run `20260920-210752155`) — owner rejection fed back into the SAME build session; plan resubmitted with the null-handling criterion; final code + tests cover `shout(null)`; verify 6/6, audit clean.
- ✅ **V5** mechanical→fix round (owner run `20260920-213826032`) — `deps-declared` failed at round 0 with file:line precision (`legacy/old.js:1`); fix round resumed the SAME build session (`rounds: 1`, one session file); the builder declared the dep and left `legacy/` intact; impl-delta notes confirm untouched files stayed byte-identical; round 1 green → completed.
- ⚠️→🔧 **V6 first attempt** (run `20260920-215309256`) — PM locked the spec without asking anything (legitimate for this task text); no round to steer → audit had nothing to block on → completed 7/7. Led to the **PM Must Ask** GUI toggle + the discovery that `requireQuestions` was a v1 no-op (finalize was never structurally withheld — fixed + regression-tested).
- ✅ **V10** cancel at plan gate → resume (owner run `20260921-001538062`) — 19 min at the gate pre-cancel with NO watchdog abort (fix confirmed under real conditions); on resume the gate was re-presented before any model work; both approvals honored; completed.
- ✅ **V9** cancel mid-build → resume (owner run `20260920-231317629`) — cancelled 13s into the build (mid-investigation), resumed 3s later: "build session resumed from disk (context intact)", SAME session file reused, plan→tasks→impl continued, verify 5/5 → completed.
- ✅ **V7** security scan (owner run `20260920-225451373`) — the planted secret was caught EARLIER than predicted: by the mechanical gitleaks gate at verify round 0 (not the security step — defense in depth: gitleaks runs at both layers). Fix round resumed the build session; the builder replaced the credential with a placeholder instead of deleting the pre-existing file; security step then passed cleanly with two honest manual LOW findings (placeholder note, 0777 modes). Completed.
- ✅ **V6** owner re-run with PM Must Ask (run `20260920-222041658`) — the fix held: the PM asked 4 real questions (incl. non-numeric policy + README scope); the steering text entered the spec as 3 explicit ACs; the builder shipped ALL 10 ACs (null handling in code, `## Usage` in README) → verify 10/10, audit clean, no fix round needed. The audit-blocking→fix-round path remains harness-covered — a builder this diligent leaves audit nothing to block.
- ✅ **V4** divergence (run `20260920-211555646`) — outcome worth reading: the builder did NOT declare divergence; it resolved the contradiction (from-scratch, API-compatible left-pad semantics — dependency-free), the plan made both sides explicit criteria, and verify probed BOTH (semantics match + no deps + no vendored code) → 7/7. A model of this class prefers resolving over escalating — the divergence GATE path remains harness-covered; to force it live you'd need a genuinely impossible constraint.
- ✅ Security override gate (part of run `20260920-161038752`) — out-of-scope secret classified honestly `fixable_in_scope:false`, routed to the owner.

**Validated — owner manual runs:**

- ✅ **V1** happy path (run `20260920-194320256`, 2026-09-20, glm-5.3-flash) — completed; verify accepted **11/11** with observed probe evidence; audit accepted (0 findings); all 5 skills loaded in phase order; plan-approval gate exercised; build session persisted.

**Fixture lesson:** plant violations INSIDE `sandbox/` — files outside the
project are invisible to mechanical checks (by design) and land in the
security-override path instead of a fix round.

---

## V1 — happy path ✅ (dev run `20260920-154407664` + owner run `20260920-194320256`)

| | |
|---|---|
| **Options** | Clarify off · Security: Off · Git off · Remote CI off · Audit on · Plan Approval on · Fix Rounds: 2 |
| **Fixture** | clean sandbox |
| **Actions** | Approve the plan gate |

**Task:**

```text
Add a small date utility library: create lib/dates.js exporting addDays(date, n)
that returns a new Date n days later (never mutates the input), plus
test/dates.test.js using node:test covering: same-date return, positive n,
negative n, and no-mutation. Run the tests with node --test and make sure they
pass.
```

**Pass:** completed; artifacts `plan, tasks, implDelta, verify, audit`; verify
verdict accepted with every check evidenced by observed commands; Console shows
the builder loading `planning` → `task-breakdown` → `implementation` and the
verifier loading `verification` → `audit-deliverables`.

## V2 — clarify loop ✅ (dev run `20260920-155539141` + owner run `20260920-204148298` after the watchdog fix)

| | |
|---|---|
| **Options** | Clarify **on** · Security: Off · Git off · Remote CI off · Audit on · Plan Approval on · Fix Rounds: 2 |
| **Fixture** | clean sandbox |
| **Actions** | Answer the PM's questions in the Q&A tab; Approve the plan gate |

**Task:**

```text
Build a tiny CLI greeting tool: tool/greet.js that takes a name argument and
prints a greeting. Also add a README.md section documenting usage.
```

**Pass:** ≥1 question round appears (real owner decisions, not codebase
questions); after your answers the spec locks (6-ish ACs, tagged
local/remote/human); run completes; spec ACs appear verbatim in the plan.

## V3 — plan gate: reject with comments → in-session revision ✅ (owner run `20260920-210752155`)

| | |
|---|---|
| **Options** | Clarify off · Security: Off · Git off · Remote CI off · Audit on · Plan Approval **on** · Fix Rounds: 2 |
| **Fixture** | clean sandbox |
| **Actions** | At the **Plan Ready** gate: type the reject comment below → **Reject ↓** → gate re-appears → **Approve & Continue** |

**Reject comment to paste:**

```text
Also handle null input: shout(null) must return an empty string. Add a test
case for it.
```

**Task:**

```text
Add lib/text.js exporting shout(s) that returns the input trimmed and
uppercased, plus test/text.test.js with node:test cases for basic input,
already-uppercase input, and surrounding-whitespace input. Run
node --test test/text.test.js and make sure the tests pass.
```

**Pass:** the Console shows the SAME build session revising (no new session —
check `steps[build].sessionFile` unchanged in state.json) and a resubmitted
plan that includes the null-handling criterion; after approval the run
completes; the final impl-delta/tests cover null input.

## V4 — divergence gate (owner run `20260920-211555646`: the model RESOLVED the contradiction instead of diverging — gate path stays harness-covered)

| | |
|---|---|
| **Options** | Clarify off · Security: Off · Git off · Remote CI off · Audit on · Plan Approval on · Fix Rounds: 2 |
| **Fixture** | clean sandbox |
| **Actions** | At the **Divergence** gate: **Approve & Continue** (or Cancel Run — run stops cleanly) |

**Task (a deliberate contradiction):**

```text
Pad numbers to a fixed width of 10 characters using the left-pad npm package,
but the sandbox must remain completely dependency-free: no installing packages,
no node_modules, and no vendored third-party code.
```

**Pass:** the builder signals divergence via the plan (cannot use left-pad
while remaining dependency-free) → divergence gate appears with its reasoning.
Note: weaker models sometimes fill the optional divergence field with literal
"none" — the driver filters that; if a divergence gate still appears
spuriously, file it as a model-quality issue, not an engine bug.

## V5 — mechanical failure → fix round resumes the build session ✅ (owner run `20260920-213826032`)

| | |
|---|---|
| **Options** | Clarify off · Security: Off · Git off · Remote CI off · Audit on · Plan Approval off · Fix Rounds: **2** |
| **Fixture** | see below (undeclared import planted INSIDE sandbox) |
| **Actions** | none — the loop is fully autonomous |

**Fixture:**

```bash
mkdir -p sandbox/legacy
printf 'const lp = require("left-pad");\nmodule.exports = (s) => lp(s, 10, " ");\n' > sandbox/legacy/old.js
```

**Task:**

```text
Add lib/rng.js exporting rollDie(sides) that returns a random integer between
1 and sides inclusive (using Math.random only), plus test/rng.test.js asserting
that 1000 rolls of a 6-sided die all land in 1..6. Do not touch the legacy/
directory. Run node --test test/rng.test.js and make sure the tests pass.
```

**Pass:** verify round 0 pre-flight shows `deps-declared — fail` (left-pad
undeclared) → `gaps-found — fix round 1 (resuming the build session)` → the
builder fixes it in the SAME session (`steps[build].sessionFile` unchanged,
`steps[build].rounds: 1`) → round 1 mechanical green → completed.

## V6 — audit blocking finding → fix round ✅* (owner run `20260920-222041658` — see note: builder nailed all 10 ACs; blocking-finding path stays harness-covered)

> **Owner finding (run `20260920-215309256`):** with Clarify merely ON, the PM
> judged this task self-contained and locked the spec WITHOUT asking anything —
> no round to steer, audit had nothing to block on, run completed 7/7. That's
> legitimate PM behavior; the counter is the **PM Must Ask** toggle (forces ≥1
> question round by withholding finalize — engine option `requireQuestions`,
> now in the GUI). Use it below.

| | |
|---|---|
| **Options** | Clarify **on** · **PM Must Ask on** · Security: Off · Git off · Remote CI off · Audit **on** · Plan Approval on · Fix Rounds: 2 |
| **Fixture** | clean sandbox |
| **Actions** | The PM now MUST ask ≥1 round. Whatever it asks, also paste the steering text below into one of the answers; Approve the plan gate |

**Steering text to paste into an answer (the null + README requirements are what audit should block on):**

```text
toF and toC must return null for non-numeric input, and README.md must gain a
"## Usage" section documenting both functions including the null behavior.
```

**Task:**

```text
Build a tiny temperature converter: lib/temp.js exporting toF(c) and toC(f)
returning numbers rounded to 1 decimal, plus test/temp.test.js with node:test
cases for both directions. Run node --test test/temp.test.js.
```

**Pass:** verify passes on behavior, then audit flags a BLOCKING
requirement-conformity finding (most likely the missing/under-specified README
Usage section — the classic miss) → fix round → accepted. Fallback: builders
sometimes nail everything; if the first run completes with zero blocking
findings, that's a legitimate pass for the engine (the loop mechanics are
harness-covered) — re-run once if you want to observe a real blocking finding.

## V7 — security: fixable secret → caught at the mechanical gate → fix round → security pass ✅ (owner run `20260920-225451373`)

| | |
|---|---|
| **Options** | Clarify off · Security: **Scan** · Git off · Remote CI off · Audit on · Plan Approval off · Fix Rounds: 2 |
| **Fixture** | see below (planted secret INSIDE sandbox, at project root) |
| **Actions** | none — the loop is fully autonomous |

**Fixture:**

```bash
printf 'AWS_SECRET_ACCESS_KEY=9dX4mQ7pL2wRtY8uK3jHfZ6vB1nM5cA0sD7gE4iO\n' > sandbox/deploy.env
```

**Task:**

```text
Add lib/list.js exporting first(arr) returning the first element (null for an
empty array) and rest(arr) returning everything after the first element (empty
array for empty input), plus test/list.test.js with node:test cases. Run
node --test test/list.test.js.
```

**Pass:** scanner pre-flight shows `secrets-gitleaks — fail`; the security
session submits a critical finding with `fixable_in_scope: true`; a security
fix round resumes the build session (builder removes/neutralizes the secret);
re-scan passes; completed with `artifacts.security.verdict: "pass"` (or only
non-gating findings).

## V8 — security: unfixable → owner override gate

| | |
|---|---|
| **Options** | Clarify off · Security: **Scan** · Git off · Remote CI off · Audit on · Plan Approval off · Fix Rounds: 2 |
| **Fixture** | see below (production credential the run must not touch) |
| **Actions** | At the **Security Override** gate: **Accept Risk & Continue** (once also try Cancel — run fails with the findings as reason) |

**Fixture:**

```bash
mkdir -p sandbox/vault
printf '# production database credential — managed by ops, do not edit here\nDB_PASSWORD=Pr0d-Xk92-mQ7p-LwRt\n' > sandbox/vault/prod.env
```

**Task:**

```text
Add lib/counter.js exporting makeCounter() that returns an object with inc()
(increments and returns the new value) and get() (returns the current value),
plus test/counter.test.js with node:test cases for increments and isolation
between two counters. The vault/ directory holds production config — do not
modify it. Run node --test test/counter.test.js.
```

**Pass:** the security session classifies the vault credential
critical/high with `fixable_in_scope: false` (rotating a production credential
is an owner action — exactly the honest call) → **Security Override** gate
lists it → Accept Risk → completed with `state.securityAccepted` recorded.

Note: `DB_PASSWORD=…` is usually a MANUAL finding (the skill's grep-for-real-
credentials pass), not a gitleaks rule — that's fine, both sources gate the
same. If the model misses it entirely, strengthen the fixture with an
AWS-format key (V7's line) inside `vault/prod.env` and keep the "production,
do not touch" framing.

## V9 — cancel mid-build → resume with session continuity ✅ (owner run `20260920-231317629`)

| | |
|---|---|
| **Options** | Clarify off · Security: Off · Git off · Remote CI off · Audit on · Plan Approval off · Fix Rounds: 2 |
| **Fixture** | clean sandbox |
| **Actions** | While `build` is streaming in the Console: **Cancel Run** → later **Resume** |

**Task:**

```text
Add lib/queue.js exporting a simple FIFO queue class with push(item), shift()
(returning the oldest item or null when empty), and size(), plus
test/queue.test.js with node:test cases for order preservation, shift on an
empty queue, and size accounting. Run node --test test/queue.test.js.
```

**Pass:** status flips to `cancelled` immediately; Resume reopens the build
session FROM DISK (`build session resumed from disk (context intact)` in the
feed), continues from the milestones already recorded (does NOT re-plan from
scratch), and the run completes.

## V10 — cancel at plan gate → resume re-presents the gate ✅ (owner run `20260921-001538062`)

| | |
|---|---|
| **Options** | Clarify off · Security: Off · Git off · Remote CI off · Audit on · Plan Approval **on** · Fix Rounds: 2 |
| **Fixture** | clean sandbox |
| **Actions** | At the **Plan Ready** gate: **Cancel Run** → **Resume** → **Approve & Continue** |

**Task:**

```text
Add lib/text.js exporting shout(s) that returns the input trimmed and
uppercased, plus test/text.test.js with node:test cases for basic input,
already-uppercase input, and surrounding-whitespace input. Run
node --test test/text.test.js and make sure the tests pass.
```

**Pass:** resume re-presents the SAME plan approval gate BEFORE any further
model work; approving continues to completion. (This was a v1 bug — it must
stay fixed.)

## V11 — git-on run: branch, milestone commits, ff-merge

| | |
|---|---|
| **Options** | Clarify off · Security: Off · Git **on** · Remote CI off (needs a real origin to enable) · Audit on · Plan Approval on · Fix Rounds: 2 |
| **Fixture** | one-time: make the sandbox its own repo (see below) |
| **Actions** | Approve the plan gate |

**Fixture (one-time — the sandbox must be its OWN repo, not part of nano-cycle's):**

```bash
cd sandbox && git init -q && git add -A && git commit -q -m "init" && cd ..
```

**Task (names a ticket id — the commit should cite it):**

```text
Implement F41: add lib/stack.js exporting a Stack class with push(value),
pop() (null when empty), peek() (null when empty), and isEmpty(), plus
test/stack.test.js with node:test cases for LIFO order, pop/peek on empty, and
isEmpty transitions. Run node --test test/stack.test.js.
```

**Pass:** run branch `nano-cycle/<runId>` created; exactly one `feat:` commit
at the impl-delta milestone whose subject ends `(F41)`; on acceptance the
branch ff-merges into `main` and is deleted (`git log --oneline` in sandbox
shows the feat commit on main). Optional: cancel mid-run → the branch is kept,
and resume never commits to main directly.

## V12 — fix rounds exhausted → honest failure

| | |
|---|---|
| **Options** | Clarify off · Security: Off · Git **on** · Remote CI off · Audit on · Plan Approval off · Fix Rounds: **0** |
| **Fixture** | V5's fixture + V11's git init (fresh commit the planted file first) |
| **Actions** | none |

**Fixture:**

```bash
mkdir -p sandbox/legacy
printf 'const lp = require("left-pad");\nmodule.exports = (s) => lp(s, 10, " ");\n' > sandbox/legacy/old.js
cd sandbox && git add -A && git commit -q -m "plant legacy" && cd ..
```

**Task:**

```text
Add lib/rng.js exporting rollDie(sides) that returns a random integer between
1 and sides inclusive (using Math.random only), plus test/rng.test.js asserting
that 1000 rolls of a 6-sided die all land in 1..6. Do not touch the legacy/
directory. Run node --test test/rng.test.js and make sure the tests pass.
```

**Pass:** status `failed`; `state.error` starts with
`gates still failing after 0 fix round(s):` and names the mechanical failure;
git-on: the run branch is kept (not merged).

---

## What to check in every completed run

```bash
python3 - << 'EOF'
import json
st = json.load(open("runs/<id>/state.json"))
print("status:", st["status"], "| steps:", [(s["id"], s["status"]) for s in st["steps"]])
print("artifacts:", sorted(st["artifacts"].keys()))
v = st["artifacts"].get("verify", {}); a = st["artifacts"].get("audit", {})
print("verify:", v.get("verdict"), "| audit:", a.get("verdict"))
print("build session persisted:", bool([s for s in st["steps"] if s["id"]=="build"][0].get("sessionFile")))
EOF
```

Events live in `runs/<id>/events.jsonl` — skill loads appear as `tool` events
with `SKILL.md` in args; gate / fix-round / resume / scanner notices as
`notice` events. Session transcripts are under `runs/<id>/sessions/`.
