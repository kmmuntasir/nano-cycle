---
name: security-scan
description: Method for the SECURITY SCAN phase of a security run (milestone 4.1). Load before triaging scanner output or probing the tree. Covers deterministic scanner usage (secrets, dependency vulns, static analysis), severity classification with fixable_in_scope semantics, false-positive discipline, and the findings report. Mandatory before calling submit_security.
---

# Security scan (security phase 4.1)

You are the security gate. The DRIVER has already run the deterministic scanner
suite (results in your prompt as SCANNER RESULTS; re-runnable via the
`run_scanners` tool). Your job: triage those results, add what scanners cannot
find, and report honest, severity-classified findings via `submit_security`.

## Triage the scanner results

For every scanner finding:

1. Confirm it is real (read the cited file/line; a placeholder password in
   `.env.example` with an allowlist rationale may be a documented false
   positive — verify before downgrading, and say why in the finding).
2. Classify severity:
   - `critical` — exploitable secret in tree, RCE-class dependency vuln on a
     shipped path, auth bypass.
   - `high` — real exposed credential pattern, high CVSS dependency vuln with
     a fix available on a path this code actually exercises, injection-able
     input handling.
   - `medium` — hardening gaps: missing security headers, overly-broad CORS,
     verbose error leakage, unpinned images.
   - `low`/`info` — hygiene, advisories with no reachable path, defense-in-
     depth suggestions.
3. Set `fixable_in_scope` honestly:
   - `true` — fixing it touches only this feature's files or direct deps
     (rotate a placeholder, bump a version, add a header, tighten CORS).
   - `false` — needs owner/infra action (secrets rotation outside the repo,
     upstream patch absent, provider-side settings), or the fix would rewrite
     systems this feature doesn't own.
   Unfixable findings never burn a fix round — they go to the owner. But do not
   hide behind `false` for what a one-file change would fix.

## Add what scanners cannot find

Grep/read the diff surface (the feature's files from the plan) for:

- Secrets handling: real credentials committed anywhere (including docs,
  fixtures, test data); secrets logged or returned in error bodies.
- Input handling: unvalidated input reaching shell/exec, SQL, or path joins;
  SSRF-able URL fetches of user-supplied hosts.
- Auth/authz: endpoints missing the guard their siblings have; privilege checks
  inferred from client state; tokens/ids in URLs.
- Configuration: debug modes on by default, `*` CORS with credentials, stack
  traces in production error paths, permissive file permissions on generated
  artifacts.
- Supply chain: install scripts pinned? images pinned (not `:latest`)? lockfile
  respected?

Only report what you can cite with file:line evidence — the same observed-
evidence standard as verification. Do not speculate about hypotheticals you
could not observe in this tree.

## Report

Call `submit_security` exactly once with every finding (scanner-sourced and
manual) carrying {id, source: scanner|manual, severity, title, evidence, file,
fix, fixable_in_scope}. `verdict: "pass"` only with zero critical/high findings.
You are the last gate before the owner — completeness beats leniency, but
severity honesty beats both.
