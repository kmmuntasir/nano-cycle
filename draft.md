
 F01 Fix Report — Unmet Requirements & Defects (Current
 Implementation)

 Feature: docs/features/F01-monorepo-scaffold.md (Monorepo
 scaffold & one-command local environment)
 Status: scaffold is structurally sound and all gates pass today,
 but the items below must be fixed before sign-off. Grouped by the
 requirement each item violates.

 A. Blocking — fails a "Done when" criterion outright

 ### A1. The health page can never report API status (CORS)

 Requirement: "A simple health page (URL) that shows whether the
 product is alive" / Done-when: "The health page answers."
 apps/web/src/pages/HealthPage.tsx:34 fetches
 http://localhost:3000/health cross-origin from the dev origin
 :5173. The server (apps/server/src/main.ts) never calls
 app.enableCors(), so the browser blocks the response and the page
 permanently displays "API: unreachable" even when the API is up.
 Compounding this: vite.config.ts:16-23 already defines a /api
 proxy that would solve it, but no code path uses /api/* — it is
 dead config (and its localhost:3000 target is wrong inside
 Docker, where it must be http://server:3000).
 Fix: route the probe through the existing Vite proxy (preferred),
 or enable CORS on the server. Correct the proxy target for the
 containerized path. Acceptance: on a running stack, /health page
 shows API: ok (N ms).

 ### A2. Health endpoint is a static echo

 Requirement: health must show whether the product is alive.
 apps/server/src/health/health.controller.ts:5-9 unconditionally
 returns {status:"ok"} — no database or cache probe. MySQL-down or
 Redis-down still reports "ok" (Redis is never touched anywhere).
 The only spec (health.controller.spec.ts) asserts the echo — a
 tautology.
 Fix: probe MySQL (SELECT 1) and Redis (PING) — e.g. via
 @nestjs/terminus — and return a degraded/down status (200/503)
 naming the failing component. Add tests that cover the failure
 paths.

 B. Partial — requirement met with gaps

 ### B1. "Every screen, every label, every message" in EN + BN is
 violated

 Requirement: "Two languages from day one… Every screen, every
 label, every message."
 - apps/web/src/pages/HealthPage.tsx hardcodes English: Web: ok
   (:67), API: … (:74), API: ok (N ms) (:78), API: unreachable
   (:81), Unexpected API response (:46).
 - document.documentElement.lang is only set inside the toggle
   handler (SignInPage.tsx:35) — on a fresh load with a saved bn
   locale, the document stays lang="en".

 Fix: route all HealthPage strings through i18n; set document.lang
  from the persisted locale at boot.

 ### B2. Bengali rendering depends on a runtime CDN

 Requirement: "Bengali must render correctly (no broken characters
 or misplaced matras)."
 Bengali glyphs rely on a Google Fonts <link> (index.html:11-14) —
 if the network is unavailable or slow, Bengali silently falls
 back to system fonts and correct rendering is no longer
 guaranteed. Self-host the Bengali (and Latin) fonts so rendering
 is deterministic and offline-safe.

 ### B3. The i18n layer is duplicated and half of it is dead code

 src/i18n/index.ts, src/i18n/locales/{en,bn}.json, and
 src/components/LanguageSwitcher.tsx are never imported by the app
  — only LanguageSwitcher.test.tsx references them. The real
 initialization is a separate inline copy in main.tsx:25-80 with
 its own duplicated resource set. Consequences:
 - The locale JSONs are dead; translation drift between the two
   copies is unenforced.
 - The switcher component's tests validate the unused path; the
   shipped toggle's persistence (SignInPage.tsx:28-36) is
   untested.
 - Three copies of the Locale/STORAGE_KEY contract exist
   (SignInPage.tsx:7-8, i18n/index.ts:4-6, main.tsx:7-10), and
   main.tsx importing a constant from a page component is inverted
   layering.

 Fix: one i18n module, one resource source (the JSONs), one
 Locale/STORAGE_KEY definition; delete or wire the switcher; tests
 must cover the shipped path (toggle → persisted locale →
 re-render).

 ### B4. .env.example is not the true config surface

 Requirement: "Example environment file listing every setting the
 product reads, with placeholder values only."
 - Missing: REDIS_HOST, REDIS_PORT — read at
   apps/server/src/config/configuration.ts:44-45.
 - Declared but never read: VITE_DEFAULT_LOCALE (.env.example:37,
   zero references); TZ (.env.example:8) is inert — compose
   hardcodes TZ: Asia/Dhaka and does not interpolate it.

 Fix: reconcile both directions — every variable read by
 code/compose/scripts appears with a placeholder; every declared
 variable is actually consumed (or removed).

 ### B5. Server silently ignores the README's .env step on host
 runs

 Requirement: one-command start with no manual pre-steps beyond
 the README.
 - ConfigModule.forRoot (apps/server/src/app.module.ts:12-16) has
   no envFilePath, so on host runs the server loads
   ./apps/server/.env (cwd-relative) — the root .env the README
   tells developers to create is never read; the app runs on
   silent defaults.
 - main.ts:8 reads config.get('port') but configuration registers
   under the app namespace (configuration.ts:31) — the namespaced
   app.port value is never consulted; it only works via the raw
   process.env.PORT fallback.

 Fix: point envFilePath at the workspace root .env; read app.port
 via its namespace. A missing/invalid env should fail loudly, not
 default silently (see D3).

 ### B6. Quality gates have coverage holes

 Requirement: "Automated checks on every pull request: code style,
 automated tests, and a production build of the web app."
 - format/format:check (root package.json:10-11) enumerate root
   files + packages/** but exclude apps/** — app source is never
   format-checked.
 - No CI job compiles the server — nest build/tsc for apps/server
   runs nowhere; type/compile errors outside the single spec file
   escape CI.
 - Follow-up outside the repo: merge-blocking requires
   branch-protection rules; document/apply them so failing checks
   actually block (Done-when: "block on failure").

 ### B7. README's "where to look when it fails" and a false claim

 Requirement: "The README states prerequisites, the one-command
 start, and where to look when it fails."
 - Troubleshooting is a single sentence (docker compose ps,
   README:47); make logs / docker compose logs exist
   (Makefile:9-11) but are never mentioned as diagnostics; no
   common-issues section.
 - pnpm dev — "(no Docker)" (README:64) is false: the server
   requires MySQL and dies after its 10×3s retry loop without it.

 Fix: real troubleshooting section (logs, port conflicts,
 reset-volumes, no-Docker path clarified); remove/correct the
 false claim.

 C. Contradicts the repository's own locked decisions

 ### C1. Entire stack is a generation behind
 docs/ai_generated/tech-stack-review.md (version refresh
 2026-09-07)

 The locked decisions (propagated to README + all agent rules) vs
 what shipped:

 ┌──────────────┬───────────────┬────────────────────────────┐
 │ Component    │ Decision      │ Shipped                    │
 ├──────────────┼───────────────┼────────────────────────────┤
 │ NestJS       │ 12            │ 10.4.4                     │
 ├──────────────┼───────────────┼────────────────────────────┤
 │ TypeORM      │ 1.1           │ 0.3.20                     │
 ├──────────────┼───────────────┼────────────────────────────┤
 │ React        │ 19            │ 18.3.1                     │
 ├──────────────┼───────────────┼────────────────────────────┤
 │ Vite         │ 8             │ 5.4.9                      │
 ├──────────────┼───────────────┼────────────────────────────┤
 │ React Router │ v7            │ v6 (react-router-dom@6.27) │
 ├──────────────┼───────────────┼────────────────────────────┤
 │ MUI          │ v9            │ v6.1.6                     │
 ├──────────────┼───────────────┼────────────────────────────┤
 │ Vitest       │ 5             │ 2.1.5                      │
 ├──────────────┼───────────────┼────────────────────────────┤
 │ Node floor   │ 24 LTS        │ >=20, node:20-alpine       │
 ├──────────────┼───────────────┼────────────────────────────┤
 │ Swagger      │ enabled day-1 │ absent                     │
 └──────────────┴───────────────┴────────────────────────────┘

 Every major is behind. Fix: either upgrade to the locked stack or
 amend the decision doc — but the repo, its docs, and its tooling
 rules must agree. Shipping as-is means every subsequent feature
 is built against versions the project has explicitly ruled out.

 D. Hygiene, latent defects, dead weight

 1. Unused dependencies: ioredis (server — zero imports; also
    implies nothing ever exercises Redis), @mui/icons-material
    (web), @testing-library/jest-dom (matchers never loaded —
    setupFiles: [], tests deliberately use plain matchers; wire it
    or drop it).
 2. Dead test config: apps/server/test/jest-e2e.json with zero e2e
    specs — running e2e today fails with "No tests found". Remove
    or add specs.
 3. No env validation at boot (configuration.ts:33-50): every
    variable silently defaults, including JWT_SECRET ??
    'change-me-jwt-secret'. Add schema validation
    (class-validator/Joi) that rejects missing/invalid required
    env at startup.
 4. Compose server service is non-hermetic
    (docker-compose.yml:46-49): node:20-alpine + corepack enable
    && pnpm install --silent && pnpm dev — no packageManager field
    in apps/server/package.json (corepack unpinned; the web
    Dockerfile:14-18 pins pnpm@9.12.0 and documents the exact
    pitfall being ignored here); --silent hides install failures;
    no lockfile reaches /app (root lockfile is outside the bind
    mount) so every container creation re-resolves from the
    registry, diverging from CI's --frozen-lockfile; pnpm install
    writes a stray lockfile into the host bind-mount; anonymous
    /app/node_modules volume (:65) makes restart cycles
    reinstall-heavy.
 5. Production web image 404s on /health
    (apps/web/Dockerfile:48-55): stock nginx:alpine with no
    try_files … /index.html SPA fallback — the client-rendered
    /health route won't resolve in the production target.
 6. No .dockerignore anywhere: COPY . ./ (Dockerfile:24) ships
    host node_modules/, dist/, tsconfig.tsbuildinfo, coverage/
    into the build context.
 7. ESLint has no React rules: flat config is js.recommended +
    tseslint.recommended + prettier only — no
    eslint-plugin-react-hooks (the highest-value React rule set).
 8. Inconsistent package naming: server package is server, web is
    @omni-isp/web.
 9. packages/shared is advertised by the workspace glob but has no
    package.json — pnpm -r silently skips it.
 10. Trivial: favicon 404 (index.html:5 references /vite.svg, no
     public/ dir exists); MuiButton.defaultProps.disableElevation:
     false (theme.ts:31-33) is a no-op default; inputProps on
     TextField is deprecated in MUI v6.

 Suggested fix order

 A1 → A2 → B4 → B5 (config surface & wiring) → B1–B3 (i18n
 consolidation) → C1 (stack decision — do this before any further
 features) → B6–B7 → D.
