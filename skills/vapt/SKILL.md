---
name: vapt
description: Method for the VAPT phase of a security run (milestone 4.2, only when scan+vapt was selected). Load after the security scan triage. Covers booting the real stack, OWASP-derived local probes (headers, CORS, error leakage, authz, injection spot-checks), scope honesty, and evidence capture into findings.
---

# VAPT — vulnerability assessment & penetration testing (security phase 4.2)

The static scan is triaged. Now test the RUNNING system. This is a LOCAL
vulnerability assessment of a development stack — be honest about what that is:
no production topology, no real user data, no DDoS/social engineering. Scope =
what this feature built and the environment it boots in.

## 1. Boot the stack — the documented way

Use the project's own documented commands (README, package.json scripts,
compose files). If the stack cannot boot, that is itself a critical finding
(the security posture of a system that cannot start is untestable — say
exactly that). Record what is running and on which ports/hosts.

## 2. Probe — OWASP-derived, local-context checklist

Run these with curl (or the browser tool where rendering matters), FROM the
origin a real client would use. Every probe needs recorded evidence (the
command + the observed response).

**Information exposure**
- Security headers on main routes: `Strict-Transport-Security` (https only),
  `X-Content-Type-Options`, `X-Frame-Options`/`frame-ancestors`,
  `Content-Security-Policy` — missing on an internet-facing design is medium;
  on a local-only dev stack, low/info with a note.
- Error behavior: malformed input, unknown routes, forced 500s — do responses
  leak stack traces, internal paths, dependency versions, or SQL fragments?
- Debug/exposed surfaces: `/api/docs`, swagger, debug endpoints, actuator-style
  routes — document what is exposed and whether that is intentional (F01-style
  "health is public by design" is fine when documented).

**Authentication & authorization** (if the feature has any)
- Unauthenticated access to guarded routes (expect 401, not data).
- Privilege boundary spot-checks: user A's id in user B's request (expect 403
  or 404, never data).
- Token handling: tokens in URLs/logs, missing expiry, acceptance of
  malformed/garbage tokens (expect rejection, not 500).

**Input handling** (spot-check, not fuzz campaigns)
- Injection-shaped inputs on the feature's inputs: quotes/semicolons into
  query params and bodies reaching SQL; `` `$(cmd)` ``/`; cmd` into anything
  reaching shell or exec; `../` into path-joined params; `javascript:`/HTML
  into anything rendered back.
- SSRF shape: user-supplied URLs fetched server-side — can they target
  localhost/metadata endpoints?

**Configuration**
- CORS: which origins are allowed; credentials+wildcard combination.
- Cookie flags: `HttpOnly`, `Secure` (https), `SameSite`.
- Compose/network: services bound to 0.0.0.0 vs 127.0.0.1; placeholder
  credentials on LAN-reachable ports.

## 3. Classify honestly

Same severity ladder and `fixable_in_scope` semantics as the security scan
(read that skill's triage section). A finding you cannot reproduce is not a
finding. A hardening gap on a dev-only surface is medium at most — severity
must reflect the actual deployment context you observed, stated in evidence.

## 4. Report

Add VAPT findings to the same `submit_security` call as the scan findings
(`source: "manual"`). If the stack never booted, still submit — with the
boot failure as the finding and every untestable area noted in `notes`.
