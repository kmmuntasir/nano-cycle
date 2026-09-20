# v2 manual validation runbook

Live scenarios for the four-step workflow (the plan's Phase 9, §V1–V12). The
unit harness (`npm test`, 13/13) already covers the engine's state-machine
paths; these runs validate the **whole system with a real model** — skills
loading, gate UX, session persistence across fix rounds, git, security.

**Recommended model for all runs (as tested during development):**
`zai-coding-cn/glm-5.3-flash` for every role (fast, cheap; strong enough to
follow the milestone contracts). `zai-coding-cn/glm-5.3` for the builder if you
want reference-class output.

**Already validated during development (2026-09-20, glm-5.3-flash):**

- ✅ V1 happy path (run `20260920-154407664`) — plan→tasks→impl→verify 7/7→audit accepted; all 5 skills observed loaded; sandbox tests green.
- ✅ V2 clarify loop (run `20260920-155539141`) — 3 real owner questions (missing-name policy, multi-name, invocation wiring), answers via GUI, spec locked, all gates green.
- ✅ Security scan surfaced an out-of-scope planted secret, classified it honestly `fixable_in_scope:false`, override gate worked (run `20260920-161038752`).

**Fixture lesson:** plant violations INSIDE the project dir (`sandbox/…`), not
next to it — files outside the project are invisible to mechanical checks (by
design) and land in the security-override path instead of a fix round.

**Setup for every run:**

```bash
git checkout v2-step-workflow && npm install && npm run build && npm start
# GUI http://127.0.0.1:4177 — or the curl one-liners below against a fresh server
```

Reset the sandbox between runs: `rm -rf sandbox/* && printf '{ "name": "nano-cycle-sandbox", "private": true, "version": "0.0.0", "type": "commonjs" }\n' > sandbox/package.json`

---

## V3 — plan gate reject-with-comments (live)

Start a run (clarify off, approvePlan on). When the **Plan Ready** gate appears:

1. Type comments in the reject box (e.g. "also handle the empty-name case") → **Reject ↓**
2. **Pass:** the SAME build session revises and resubmits (Console shows the revision continuing `build` — no new session), the gate re-appears → Approve → run completes.

## V4 — divergence (harness-covered; live optional)

Ask for something contradictory ("add a dependency on package X while never modifying package.json"). **Pass:** divergence gate appears; Approve-anyway continues, Cancel stops cleanly. (Note: weak models sometimes fill the optional divergence field with "none" — the driver now filters that; if you see a spurious divergence gate, that's a model-quality issue, file it.)

## V5 — mechanical failure → fix round resumes the build session

```bash
mkdir -p sandbox/legacy
printf 'const lp = require("left-pad");\nmodule.exports = (s) => lp(s, 10, " ");\n' > sandbox/legacy/old.js
```

Start a run whose task does NOT touch `legacy/` (e.g. "Add lib/str.js exporting
ellipsize(s, n) with node:test tests"). **Pass:**

1. Verify round 0: `deps-declared` FAILS (left-pad undeclared) → `gaps-found — fix round 1 (resuming the build session)`.
2. The builder fixes it IN THE SAME SESSION — check `state.json`: `steps[build].sessionFile` unchanged, `steps[build].rounds: 1`.
3. Round 1 verify green → completed.

## V6 — audit blocking finding → fix round

Give the spec an AC the builder will plausibly miss (clarify ON; answer a
question narrowly, e.g. force "empty input returns the literal string '(empty)'
— exactly"). **Pass:** audit emits a blocking requirement-conformity finding →
fix round → accepted. (If the builder nails it first try, plant drift: answer
"ALL output must be uppercase" and watch audit catch lowercase output.)

## V7 — security: fixable critical → fix round → re-scan

```bash
printf 'AWS_SECRET_ACCESS_KEY=9dX4mQ7pL2wRtY8uK3jHfZ6vB1nM5cA0sD7gE4iO\n' > sandbox/deploy.env
```

Start a run with **Security: Scan**, task unrelated to `deploy.env`. **Pass:**
gitleaks FAILS in the scanner pre-flight → security session flags critical +
fixable → build-session fix round → re-scan PASS → completed. `artifacts.security.verdict`
should end `pass` (or only non-gating findings).

## V8 — security: unfixable → owner override

Use a project with a lockfile; introduce a high vuln you can't fix in scope (or
mark V7's variant: a finding whose fix needs a major rewrite). **Pass:** the
**Security Override** gate lists findings → **Accept Risk & Continue** →
completed with `state.securityAccepted` recorded; **Cancel** → run fails with
the findings as reason.

## V9 — cancel mid-build → resume with session continuity

Start any run; while `build` is running (Console streaming), **Cancel Run**.
**Pass:** status `cancelled` immediately. Then **Resume**:

- the build session REOPENS FROM DISK (`build session resumed from disk (context intact)` in the feed);
- it does NOT restart from zero (continues milestones already recorded);
- run completes.

## V10 — cancel at plan gate → resume re-presents the gate (regression)

Cancel while the **Plan Ready** gate is showing. **Pass:** resume re-presents
the SAME gate before any further model work; approve → completes. (This was a
v1 bug — FIX-REPORT — and must stay fixed.)

## V11 — git-on run (needs a scratch repo)

```bash
git init /tmp/v2-git-fixture && cd /tmp/v2-git-fixture && git commit --allow-empty -m "init"
# add it as a project in the GUI, enable Git + a small task
```

**Pass:** branch `nano-cycle/<id>` created; `feat:` commit at impl-delta
(citing the task's ticket id when present); on accept → ff-merge to main +
branch deleted; on failure → branch kept. Cancel-then-resume never commits to
main directly.

## V12 — maxFixRounds exhaustion

V5's task with `maxFixRounds: 0`. **Pass:** run fails with assembled reasons in
`state.error` (`gates still failing after 0 fix round(s): …`), status `failed`,
branch kept (git on).

---

## What to check in every completed run

```bash
python3 - << 'EOF'
import json, sys
st = json.load(open(f"runs/<id>/state.json"))
print("status:", st["status"], "| steps:", [(s["id"], s["status"]) for s in st["steps"]])
print("artifacts:", sorted(st["artifacts"].keys()))          # plan/tasks/implDelta always; +verify/audit; +security
v = st["artifacts"].get("verify", {}); a = st["artifacts"].get("audit", {})
print("verify:", v.get("verdict"), "| audit:", a.get("verdict"))
print("build session file persisted:", bool([s for s in st["steps"] if s["id"]=="build"][0].get("sessionFile")))
EOF
```

Events live in `runs/<id>/events.jsonl` (skill loads appear as `tool` events
with `SKILL.md` in args; gate/fix-round/resume notices as `notice` events).
