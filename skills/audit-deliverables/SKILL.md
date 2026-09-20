---
name: audit-deliverables
description: Method for the AUDIT phase of a verification run (milestone 3.2). Load only after submit_verify was accepted. Covers the re-read-docs-first ordering, requirement-conformity in both directions, locked decisions, quality and practice findings, and blocking discipline. Mandatory before calling submit_audit.
---

# Audit deliverables against requirements (verify phase 3.2)

Verify already confirmed the work FUNCTIONS; you confirm it is RIGHT and CLEAN.
You never modify files. You receive the spec, the plan, the impl-delta, the
verifier's verdict — and the repo's governance files injected as context
(AGENTS.md / CLAUDE.md / .pi/AGENTS.md, .claude/rules/*, .pi/rules/*). Treat
those governance files as binding law, equal to the spec.

## Ordering — break the anchor BEFORE looking at verify's work

1. FIRST re-read the SOURCE REQUIREMENT DOCUMENTS and the SPEC from your prompt,
   in full. Build your own traceability picture: every doc requirement
   ("I need", "Business rules", "Done when", "Already decided") must be
   satisfiable by the implementation.
2. THEN read the plan, the impl-delta, and the verifier's checks — treating the
   verifier's conclusions as CLAIMS to re-derive, not evidence. Re-check
   anything that smells of paraphrase. The verifier is thorough but it is one
   context; your value is independence from its framing.

SOURCE DOCS OUTRANK THE SPEC. A spec criterion that reinterprets or drops a doc
requirement is itself a finding, and the underlying unmet doc requirement is
BLOCKING.

ESCALATION RULE: when a quality finding (dead code, unused module, missing
surface) corresponds to an unmet source-doc requirement — e.g. an unused API
client that exists because the doc-required page was never built — it is NOT
advisory. Escalate it to a blocking requirement-conformity finding naming the
doc requirement it fails.

## Hunt in four categories, priority order

1. **requirement-conformity** — does the implementation honor every spec
   acceptance criterion AS WRITTEN (not as the builder interpreted it)? Re-read
   criteria literally: words like "ALL", "every", "blocking", "within 15
   minutes" mean what they say. Quote the criterion, then the violating
   file:line.
2. **locked-decision** — does it obey the repo's locked decisions, whatever they
   are? Installed versions in the manifest(s) AND lockfile vs the pinned stack;
   module layout vs the mandated roots; any "one X only" bans (styling system,
   state library, package manager); i18n or other declared policies; forbidden
   patterns from security rules. Version drift of even one major is BLOCKING.
3. **quality** — dead code (modules never imported by the app entry, including
   tests that exercise dead paths), unused dependencies, dead config files,
   duplicated sources of truth (two i18n initializations, three locale
   contracts), test suites that hand-rebuild the app's bootstrap instead of
   reusing its wiring module (drift risk), tautological tests, layering
   violations, naming inconsistencies.
4. **practice** — CI gate coverage (does CI actually run every required gate on
   the real paths?), Docker hygiene (.dockerignore, no host bind-mount writes,
   pinned installers, lockfile-respecting installs), secret handling, boot-time
   env validation (no silent insecure defaults like change-me secrets).

## Method

Read the governance files first, then grep/read the tree adversarially. Run
scans (grep, lockfile inspection, config reads) rather than trusting reports.
Driver-observed mechanical/remote results in your prompt already gated upstream
— treat them as informational, but escalate related practice findings.

## Finding discipline — every finding needs {category, blocking, file, issue, fix}

- blocking:true ONLY for spec violations, locked-decision violations, broken
  behavior, or security problems. These force another fix round — be certain,
  quote file:line.
- blocking:false for hygiene and polish. Record them so the owner sees them,
  but do not hold the run hostage over a favicon.

## Verdict

Call `submit_audit` exactly once:
- "accepted" only if there are zero blocking findings.
- "gaps-found" with the blocking findings enumerated (each with file, issue,
  and fix).
