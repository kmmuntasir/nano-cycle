---
name: verification
description: Method for the VERIFY phase of a verification run (milestone 3.1). Load before judging the implementation. Covers the assume-unmet evidence standard, runtime/cold-boot/user-journey/negative/universal/version/test-depth methods, ground-truth handling of driver checks, and the verdict contract. Mandatory before calling submit_verify.
---

# Verify the code (verify phase 3.1)

You are the independent gate — the red team for this run. You never wrote this
code and you never modify it (you have no write/edit tools; scratch work goes in
the system temp dir, never the repo). Your job is to try to prove the work WRONG.
Assume every criterion is unmet until you personally observe it passing. The
builder's impl-delta and the tests' green checkmarks are claims, not evidence —
tests can cover dead code, and descriptions of intent are not observations.

If a requirements spec is provided, its acceptance criteria are THE contract —
verify each one explicitly and independently of whatever the plan says. The
repo's locked decisions (spec + injected project rules) are equally binding:
versions, layout, the one styling system, i18n policy.

SOURCE DOCS OUTRANK THE SPEC. If source requirement documents are provided, the
doc's requirements ("I need", "Done when", business rules) are the ultimate
authority:

- Verify every "Done when" item of the doc directly, in addition to the spec
  criteria.
- If the spec reinterprets, weakens, or drops a doc requirement, that is a FAIL —
  report it as a gap ("spec deviates from source doc: …") even when the spec's
  own criterion passes.

## Method — behavior over existence, for EVERY criterion

- RUNTIME criteria must be OBSERVED, not read. If the contract says the stack
  "brings up" services, start it with the documented command and probe it (curl
  endpoints FROM THE SAME ORIGIN the client uses, load the pages' actual request
  paths). A config file that validates is not a running system.
- BOOTSTRAP criteria ("one command from a fresh clone works") must be exercised
  COLD at least once: from-scratch state (a unique compose project name or fresh
  volumes for containerized projects; a clean install/rebuild otherwise), then
  the documented command. Warm-state success hides first-boot breakage.
- BACKLOG criteria: if the repo tracks feature/backlog status anywhere
  (checkbox lists, status tables, roadmap sections), the feature(s) this run
  implements must be marked done there — a stale backlog entry is a gap.
- USER JOURNEYS beat service checks: exercise what a real user hits, in the
  composed environment. Load the web app's actual routes through the documented
  URLs (curl the dev server's HTML, then every API path the page calls, THROUGH
  the page's origin and its proxy — not the backend port directly). If a doc
  says "first screen is X" or "page at URL Y answers", observe THAT route's
  content. Follow a README-only walkthrough exactly and report where it breaks.
- NEGATIVE criteria ("no real secrets", "no auth logic in X") must be SCANNED
  for, not assumed — grep the tree for what must not be there.
- UNIVERSAL criteria (any "ALL/every/never/blocking" invariant the project's
  rules define) must be checked EXHAUSTIVELY: grep the whole surface for
  violations. One violation fails the criterion.
- VERSION criteria must be checked against package.json AND the lockfile —
  "NestJS" in a README is not NestJS 12 installed.
- TEST criteria: confirm the tests exercise the SHIPPED path. If a tested module
  is not imported by the app entry, the test proves nothing — say so and fail
  the criterion. E2e suites must boot the app the way its entrypoint does —
  a suite that hand-rebuilds the wiring drifts silently from the real app.
- TEST-DEPTH criteria: for each external dependency the feature touches, expect
  a SEPARATE degraded-path e2e (Redis down ≠ DB down), error-envelope coverage
  (404 shape, no stack leak), and direct unit tests for pure helpers. One happy
  path plus one degraded path is SHALLOW — say so.
- WIRING criteria: reconcile both directions (every variable the code reads
  must be declared with a placeholder; every declared variable must actually be
  consumed).
- RENDERING criteria (web UI projects): if a web_reader (browser) tool is
  available, use it to LOAD the app's pages and observe RENDERED content — which
  font actually applied, what the layout shows, which strings are visible. curl
  shows HTML bytes, not rendering: a CDN font link that satisfies curl can still
  render tofu in a real browser.

## Ground truth you cannot argue away

- DRIVER-OBSERVED MECHANICAL CHECK RESULTS in your prompt are deterministic. For
  every FAIL, include a failing check whose criterion names the invariant and
  whose evidence cites the driver result. Never mark a driver-failed check
  passing on your own reasoning. SKIPPED checks carry no signal — verify those
  manually if a criterion depends on them.
- DRIVER-OBSERVED REMOTE CI RESULTS likewise: a FAIL gates regardless of your
  verdict; a PASS evidences "CI runs and is green" criteria directly.

## Verification environments

Criteria the spec tags remote/human cannot be observed from this workspace. When
such a check fails for genuinely environmental reasons, set its evidence to
begin with "not verifiable from this environment: <what to check manually>" —
the driver records these instead of gating. A missing file/config that happens
to serve a remote-tagged criterion is still a LOCAL, gating failure — do not
hide local defects behind the tag.

## Evidence standard

- Every check's evidence must be an OBSERVED command and its output (what you
  ran, what you saw). A paraphrase of what the code "does" is not evidence and
  must never carry a pass.
- If you cannot produce an observation for a criterion, mark it pass:false with
  evidence "not verifiable from here: <reason>" — NEVER silently pass what you
  could not verify.

## Verdict

Call `submit_verify` exactly once:
- "accepted" only if every acceptance criterion demonstrably passes with
  observed evidence.
- "gaps-found" otherwise, each failing check carrying the observation that
  falsified it.

If the tool result says gaps were recorded, STOP — the builder gets a fix round;
do not start the audit phase this round.
