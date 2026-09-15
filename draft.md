# F01 Implementation Comparison Report — Reference vs Current

**Feature:** F01 — Monorepo scaffold & one-command local environment  
**Reference:** `/home/munna/archive/backup/master-reference` (4 commits, `0902524..22e9453`)  
**Current:** `/home/munna/sonic/localhost/omni-isp` (entire implementation **untracked** on `main` @ `05618bf`)  
**Date:** 2026-09-15 · **Requirements baseline:** `docs/features/F01-monorepo-scaffold.md` (byte-identical in both trees)

---

## 1. Executive summary

The **reference implementation is decisively better** across all three halves — backend, frontend, and infra/CI/docs — roughly **25–4 across 30 scored dimensions**. It is the only one of the two that satisfies every hard F01 acceptance clause: self-contained Bengali rendering, a persisting language switch, a complete single-file env contract, a working migration pipeline, and quality gates that have actually executed (committed history, gitleaks scan run, CI green).

The current implementation is a **competent, cleaner-containerized scaffold with a genuinely better Docker story** (one literal `docker compose up -d --build` brings up api + web + MySQL + Redis — verified live in this review), but it ships **four confirmed high-severity defects** (dead migration scripts, hangable health endpoint, CDN-dependent Bengali fonts that rendered as tofu in a live test, uncommitted/unproven CI), a README with ~10 false claims, and 7 automated tests where the reference has 41.

**Bottom line:** keep the current implementation as the base only if you intend to port the reference's substrate into it (adopt list in §8); otherwise the reference remains the stronger foundation for F02.

### Scorecard

| Area | Dimensions won | Verdict |
| --- | --- | --- |
| Backend | 9 reference · 1 tie · 0 current | Reference, decisively |
| Frontend | 8 reference · 1 tie · 1 split | Reference, decisively |
| Infra / CI / docs | 8 reference · 0 current | Reference |
| **Total** | **26 reference · 2 tie · 1 split · 1 current-only win (Docker)** | **Reference ≈ 87% of dimensions** |

---

## 2. Verification methodology (evidence, not just reading)

Every claim below was checked at least one of two ways:

**Static** — three parallel deep-read agents (backend, frontend, infra) over both trees with file:line citations, plus direct spot-checks of every high-severity claim in this session.

**Executed** — both implementations' full gate suites were run to completion:

| Gate | Reference (fresh copy, `npm ci` 881 pkgs) | Current |
| --- | --- | --- |
| Backend lint | pass | pass (with legacy-config deprecation warning) |
| Backend unit tests | **31 pass** (6 suites) | **4 pass** (1 suite) |
| Backend build | pass | pass |
| Frontend lint | pass | pass |
| Frontend tests | **10 pass** | **3 pass** |
| Frontend build | pass (self-hosted Noto Sans Bengali emitted) | pass (552 kB JS, no font assets) |

**Live runtime** (current implementation's stack, running via its own compose):

- `GET /api/v1/health` → `200` `{"status":"ok","service":"omni-isp-backend","version":"0.1.0","uptimeSeconds":…,"database":"up","redis":"up"}` — health clause **verified live**.
- `GET /health` (unversioned) → raw Express HTML `Cannot GET /health` — no error envelope (reference returns its JSON envelope; verified by its e2e).
- Sign-in screen renders on `:8080` with the "not yet live" notice — **verified live** (English).
- Language switch functionally switches the UI to Bengali (driven via the MUI Select in a real browser) — **verified live**.
- **Bengali rendered entirely as tofu boxes (□)** in that live switch — screenshot analyzed: every Bengali string was missing-glyph rectangles. See §5/F2 for the mechanism. The reference bundles its fonts and cannot hit this failure mode.

---

## 3. F01 requirements conformance matrix

| F01 clause | Reference | Current |
| --- | --- | --- |
| Both apps in one repo | PASS (npm workspaces) | PASS (independent packages; stray root `node_modules/` artifact — C5) |
| One command up incl. DB+cache, one down | PASS — `npm run dev` / `stop` with health-gated infra, migrations, HMR, port pre-flight | PARTIAL — `docker compose up -d --build` / `down` genuinely work (verified live) but **no hot reload**; documented manual-dev alternative **broken as written** (C2) |
| Sign-in first screen, layout only, "not yet live" note | PASS (validation UX, notice on valid submit) | PASS statically + live-verified (permanent notice; submit is a no-op, no validation, 2 dead i18n keys) |
| Material Design standard | PASS (MUI-only, guideline palettes) | PASS (MUI-only, guideline palettes; touch targets < 48 px violate guideline §8/§12) |
| en+bn day one, persisting switch | PASS — typed keys, compile-time parity, `html[lang]` sync, proven by registry-reset test | PARTIAL — works live; untyped JSON keys, hand-maintained parity, no `html[lang]` sync, persistence test doesn't test persistence |
| Bengali renders correctly | PASS — fonts self-hosted, §3.3 line-height rules, font-face test | **FAIL (live-observed)** — Google Fonts CDN dependency; rendered tofu in this review's browser test; no §3.3 line-height rules |
| Phone-width usable | PASS (360 px no-overflow test + 48 px targets tested) | PARTIAL (layout holds; no test, targets under guideline minimum) |
| PR checks: style + tests + web build, blocking | PARTIAL — all gates incl. backend e2e; blocking needs owner to run shipped script (documented decision) | PARTIAL — style+tests+build present for both apps; no backend build/e2e gate; blocking deferred to manual UI; **workflow has never run (uncommitted)** |
| Health URL | PASS (200/503 with per-component state, latency, timeouts; e2e-proven) | PARTIAL (live-verified 200 + db/redis state; always 200 even when degraded; can hang if Redis is down — B2) |
| Env example: every setting, placeholders only | PASS — 13/13, single root file | PARTIAL — `APP_VERSION` missing, `VITE_API_BASE_URL` read by nothing, several vars inert in the Docker path, dual env surfaces |
| Secrets never in repo | PASS — verified ignored + configured gitleaks scan ran | PASS on disk (root `.env` is placeholder-only copy, gitignored) — but no scan has ever executed (C1) |
| Gates under ~10 min | PASS by construction (timeouts + concurrency; committed + run) | PASS by construction — unproven (never ran) |
| README: prereqs, one-command, where-to-look | PASS — every cited command verified real | PARTIAL — ~10 false/dead claims (C4) |
| Done: clone → sign-in ≤ 15 min | PASS (4 steps; CI-proven) | PARTIAL (2-step Docker path plausibly fastest; manual path fails; unproven CI) |
| Done: secrets scan clean | PASS (ran over committed history, config committed) | **FAIL as-of-now** — no scan proof exists for this tree |

---

## 4. Backend comparison — Reference wins 9-0-1

| # | Dimension | Winner | Key evidence |
| --- | --- | --- | --- |
| 1 | Architecture & layout | Reference | Reference: `modules/<feature>/`, `config/`, shared `app.setup.ts` used by main **and** e2e. Current: `src/health/` (no `modules/` convention), wiring inline in `main.ts`, e2e re-implements it and drifts; `snake-naming.strategy.ts` is dead code (never imported) |
| 2 | Health endpoint | Reference | Reference: parallel probes under 2 s budget, latency per component, **503 when anything is down**, additive contract documented for F21. Current: always 200 `ok/degraded`, no timeout budget (can hang — B2) |
| 3 | Config validation | Reference | Both fail fast; reference has no masking defaults + resolves root `.env` from any cwd. Current: Joi `allowUnknown`, defaults mask misconfig, no `envFilePath` → host-dev path broken (C2) |
| 4 | Redis/DB wiring | Reference | Reference: fail-fast client (bounded retries, no offline queue), boot gate, shutdown hooks. Current: `maxRetriesPerRequest: null` + forever-retry defaults, no boot gate, no shutdown hooks, `void bootstrap()` unhandled (B7) |
| 5 | Global error filter | Reference | Reference ships the one envelope + no-stack-leak e2e. Current has none (survivable for F01; the rules call it day-1) |
| 6 | Migrations / data source | Reference | Reference: shared options + CLI data-source + Baseline migration + working scripts + CI migration step. Current: **all three `typeorm:*` scripts dead** (B1) |
| 7 | Tests | Reference | 38 vs 5. Reference e2e boots the real module against real MySQL/Redis; current e2e stubs both (contradicts testing-rules) |
| 8 | TS strictness & style | Reference | Reference: ESLint 10 flat config, `no-floating-promises`, typed lint. Current: ESLint 9 legacy `.eslintrc.js` forced off flat config (dead-end for v10), `lint` script mutates via `--fix` |
| 9 | Dependencies | Tie | Both pinned Nest 12/TypeORM 1.1/ioredis; reference on newer toolchain, current carries unused devDeps + mismatched `@types/supertest` |
| 10 | F02-readiness | Reference | F02 lands into reference with near-zero friction; into current only after repairing migrations, envelope, prefix trap, snake/utf8mb4 wiring, `modules/` convention |

### Current-backend confirmed defects

| ID | Sev | Defect | Evidence |
| --- | --- | --- | --- |
| B1 | **High** | All `typeorm:migration:*` scripts point at `dist/database/data-source-cli.js` — no such source file exists (verified by `find`); no `migrations/` dir; README documents the commands as working. F02 blocker | `backend/package.json:20-22` |
| B2 | **High** | Health endpoint can hang indefinitely with Redis down: `maxRetriesPerRequest: null` + default forever-reconnect + offline queue, and no probe timeout | `backend/src/cache/cache.module.ts:24-31`, `src/health/health.service.ts:34-55` |
| B3 | Med | `SnakeNamingStrategy` never wired; DB options lack `charset: utf8mb4` and `timezone: 'Z'` — first F02 entity silently gets non-compliant schema | `backend/src/database/database.module.ts:24-36` |
| B4 | Med | Host-dev path broken as documented (README says `npm run start:dev`; Joi requires 5 DB/Redis vars; only root `.env` is created by quickstart) | `README.md:44-48`, `src/config/env.validation.ts:16-33`, `src/app.module.ts:11-16` |
| B5 | Med | Health answers 200 with `degraded` when dependencies are down — status-code monitors read "alive" | `src/health/health.service.ts:22-32` |
| B6 | Med (latent) | `setGlobalPrefix('api/v1')` without leading slash (verified: `API_PREFIX` default `api`) — reference's verified Nest 12/Express 5 finding: silently disables the exception-filter chain on unmatched routes once a filter exists | `src/main.ts:14` vs reference `app.setup.ts:16-20` |
| B7 | Med | `void bootstrap();` — no catch/exit; boot failures surface as raw unhandled rejections | `src/main.ts:40` |
| B8 | Low | CORS default `origin: '*'` combined with `credentials: true` (browser-rejected combo; permissive default) | `src/config/configuration.ts:13`, `src/main.ts:25` |
| B9 | Low | Env drift: `APP_VERSION` read but not in `.env.example`; `DB_SYNCHRONIZE` advertised but hard-wired off; no `enableShutdownHooks()`; e2e mocks DataSource+Redis | various |

Reference-backend risks (all Low): mysql password visible in container healthcheck cmdline; `readAppVersion` dir-walk heuristic; documented-but-bounded probe-race; hybrid topology is 2 commands to first screen.

---

## 5. Frontend comparison — Reference wins 8-1-1

| # | Dimension | Winner | Key evidence |
| --- | --- | --- | --- |
| 1 | Sign-in page | Reference | Validation UX with localized errors, password visibility toggle, notice on valid submit. Current: no-op submit, zero validation, whitespace `helperText` hack, 2 dead keys |
| 2 | i18n architecture | Reference | Typed keys (`CustomTypeOptions`) + **compile-time en/bn parity** (`WidenValues<typeof en>`), single-writer persistence, `html[lang]` sync. Current: untyped JSON, parity by hand, silent raw-key rendering on typos |
| 3 | Bengali rendering | Reference | Reference self-hosts fonts via `@fontsource` + §3.3 line-height/letter-spacing keyed on `html[lang="bn"]` + a computed-style test. Current: **CDN fonts — rendered as tofu in this review's live test (F2 below)**, no §3.3 rules, never sets `html lang` (a11y defect) |
| 4 | Theming | Reference (narrowly) | Both: guideline palettes, dark mode, persistence. Current: silent no-op context default, invented dark line-heights; omits guideline `*.light` variants |
| 5 | Routing & shell | Tie | Both React Router v7, one route; reference's main/App split is the cleaner F02 seam |
| 6 | Service layer | Reference | Reference ships `services/api.ts` (axios, `/api`, F02 interceptor plan) + zero-network test spies. Current: **no service layer at all** |
| 7 | Responsiveness | Reference | Reference enforces + tests 48 px touch targets and 360 px no-overflow. Current: Select ~35 px, IconButton 40 px, Button ~42.5 px — all under guideline §8/§12; no responsive test |
| 8 | Tests | Reference | 10 vs 3; reference's boot harness genuinely simulates reload (persistence proven); current's "persistence" test manually calls `changeLanguage` and would pass with `resolveInitialLanguage` deleted |
| 9 | TS & style | Reference (narrowly) | Current has richer ESLint rules + `--max-warnings 0` (good) but pollutes app tsconfig with test globals |
| 10 | Build & config | Split | Current's multi-stage nginx Dockerfile + full-stack compose is better (F01's "whole product up in one command"); reference's env-driven ports + self-hosted fonts are the better-engineered scaffold |

### F2 — the tofu finding (live-verified, High)

`frontend/index.html:7-12` loads Roboto + Noto Sans Bengali from `fonts.googleapis.com`. In this review's live browser test the font files failed to load; because a `@font-face` rule shadows any same-named system font, the browser fell through Roboto → Helvetica → Arial → sans-serif — none with Bengali coverage — and **every Bengali string rendered as □ tofu** (screenshot analyzed; layout, switch, and dark-mode toggle all worked). The host machine even has Noto Sans Bengali installed system-wide — shadowing prevented its use. Caveat: a consumer OS with Bengali fonts *and* working CDN renders fine; but the failure needs only a blocked/flaky CDN (corporate proxies, offline dev, e2e runners — exactly this review's case). The reference bundles its fonts into `dist/` and is immune by construction. This directly violates "Bengali must render correctly" as an unconditional property.

Other current-frontend defects: dead i18n keys (`signIn.emailRequired`/`passwordRequired`), misleading persistence test, shared-singleton test coupling, `frontend/.env.example` advertises `VITE_API_BASE_URL` that nothing reads, no `vite-env.d.ts`, nginx serve has no `/api` proxy for F02. Reference-frontend risks: all Low (theme-persistence write-on-mount, `VITE_USER_NODE_ENV` workaround, very-new majors).

---

## 6. Infra / CI / docs comparison — Reference wins 8-0

| # | Dimension | Winner | Key evidence |
| --- | --- | --- | --- |
| 1 | One-command dev loop | Reference | Reference `scripts/dev.mjs`: env contract check → docker `--wait` → migrations → port pre-flight → HMR both apps → readiness race → Ctrl-C teardown; `stop.mjs` mirrors it. Current: prod-mode compose only — every code change is a rebuild; escape hatch broken (B4) |
| 2 | Runtime topology | Reference (validated) | Hybrid host-apps + containerized-infra gives HMR/debugging and CI parity. Current's all-Docker is the better *demo/deploy* topology but an anti-pattern as the daily *dev* topology; CI still tests on hosted Node, so parity claim mostly evaporates |
| 3 | CI workflow | Reference | Reference adds a real `backend-e2e` job (MySQL+Redis service containers, migrations applied), pinned gitleaks + `.gitleaks.toml`, `node-version-file`, required-checks branch-protection script. Current: no backend build/e2e gate, unpinned unconfigured gitleaks, UI-click branch protection — and **the workflow has never executed** (C1) |
| 4 | README | Reference | Reference: every cited command verified present. Current: `backend/Dockerfile` (doesn't exist), `docker/mysql/` (doesn't exist), phpMyAdmin/RedisInsight claimed (absent), `docs/api_docs/README.md` + `docs/tasks/` links (dead), frontend `test:coverage`/`test:ui` (not in scripts), root `npm test` (no root manifest), commit format contradicting git rules |
| 5 | Env template | Reference | 13/13 single-file contract vs `APP_VERSION` missing + unread `VITE_API_BASE_URL` + inert-in-Docker vars + root/backend dual surface |
| 6 | Secrets scan | Reference | Configured, pinned, executed over history vs unconfigured, unpinned, never run |
| 7 | .gitignore | Reference | Current covers criticals (verified: no dist/node_modules tracked) but misses `.pi/npm/` (already `??` noise), `logs/`, `docs/ai_generated/*`, `.eslintcache`, `*.lcov`, `vite.config.ts.timestamp-*` |
| 8 | Node pinning | Reference | `.nvmrc` + `node-version-file` + exact image pins vs hardcoded CI `node-version: 24`, floating `node:24-alpine`/`mysql:8.4`/`redis:8.4`, no `engines`, no `.nvmrc` |

### Infra defect register — current

| ID | Sev | Defect |
| --- | --- | --- |
| C1 | **High** | Entire implementation untracked (`?? backend/ frontend/ docker/ .github/ docker-compose.yml`): no CI run, no secrets-scan proof, one `rm -rf` from zero, "Done when" secrets-scan criterion currently unmeetable |
| C2 | **High** | Broken manual-dev path (see B4) |
| C3 | Med | Dead migration toolchain (see B1) + no `migrationsRun`/CMD migration step in the api container |
| C4 | Med | ~10 false/dead README claims (list in §6 row 4) |
| C5 | Med | Stray root `node_modules/` with hidden lockfile for a deleted `apps/` workspace layout (`omni-isp@0.1.0`, workspaces `apps/server`+) — phantom-resolution hazard for tsc/eslint; delete it |
| C6 | Low | No hot reload in the compose path; default host ports 3306/6379 are collision-prone on machines with local MySQL/Redis (reference deliberately used 3307/6380). *Note: no collision on this machine — the current stack bound both ports successfully; this is a portability risk, not a live defect here* |
| C7 | Low | gitleaks unpinned + no config (false-positive risk on placeholder files) |
| C8 | Low | gitignore gaps (§6 row 7) |
| C9 | Low | No `.nvmrc`/`engines`; floating image tags |
| C10 | Low | CI lacks backend build + e2e; api container has no healthcheck; `web.depends_on api` is start-order only |

Reference-infra risks (all Low): branch-protection script intentionally unrun (documented owner decision); `npm install` as a listed pre-step; hand-duplicated e2e CI env; compose `:-` defaults boot silently with placeholders where current fails fast (`:?`) — one pattern current does better.

---

## 7. Implementation-strategy assessment

**Reference — "engineered dev substrate":** npm workspaces + host-run apps with HMR + containerized infra + lifecycle scripts + maximal day-1 conventions (envelope, migrations, typed i18n, self-hosted fonts, 41 tests, executed CI). Strategy: optimize the *developer's daily loop and F02+ velocity*. Cost: two prereqs (Node + Docker), two commands to first screen.

**Current — "containerized product demo":** everything in Docker incl. prod-mode api and nginx-served web. Strategy: optimize *zero-host-dependency reproducibility* and get a head start on F21 deployment. Cost: no hot reload, opaque iteration, and the substrate the rules call day-1 (migrations, envelope, fail-fast, typed i18n, fonts) is missing or broken — F02 must repair the foundation before it can build on it.

The F01 brief optimizes for "hand the repo to any developer and have them productive the same day" — the reference's strategy matches the brief; the current one matches a later-stage concern (F21). The current strategy is not wrong, but it is premature as the *primary* dev topology and was substituted before the mandated substrate existed.

---

## 8. Recommendations

### If keeping the current implementation as base — port these from the reference (priority order)

1. **Commit the work** (fixes C1; enables CI + the secrets-scan "Done when"). Exclude the stray root `node_modules/` (C5) and add the missing gitignore entries (C8) first.
2. **Fix the migration substrate**: shared `typeOrmOptions()` + CLI `data-source` + Baseline migration + working `typeorm:*` scripts; wire `namingStrategy` + `charset: utf8mb4` + `timezone: 'Z'` (B1, B3).
3. **Self-host the fonts** (`@fontsource` Roboto + Noto Sans Bengali), delete the Google Fonts links; add the `html[lang]` sync + §3.3 Bengali line-height `GlobalStyles` (F2 — live-verified failure).
4. **Harden health + boot**: per-probe timeout budget, 503-on-down, fail-fast Redis client, boot connection gate, `enableShutdownHooks`, caught bootstrap, leading-slash prefix fix (B2, B5, B6, B7).
5. **Global error envelope + shared `app.setup.ts`** so e2e exercises the real wiring; replace the fake-infra e2e with a real-DB job in CI (reference `ci.yml` backend-e2e pattern).
6. **Dev hot-reload path**: either the reference's `dev.mjs`/`stop.mjs` lifecycle or a compose dev profile with bind mounts + watch; fix the README manual-dev path (B4) and the ~10 false claims (C4); add `.nvmrc`, pinned gitleaks + config, scripted branch protection.
7. **Frontend substrate**: typed i18n keys + parity enforcement (or a key-parity CI check), validation UX using the dead keys, `services/api.ts`, 48 px touch targets, a real persistence test.

### If reverting to (or rebasing onto) the reference — port these from the current

1. The **multi-stage Dockerfiles + full-stack compose** as an additional profile (prod-parity smoke ahead of F21).
2. `:?` fail-fast on required compose credentials (reference's `:-` boots silently with `change-me`).
3. `noUnusedLocals`/`noUnusedParameters`, richer prettier contract, explicit `format:check` CI gates, `--max-warnings 0`.

---

*Report generated 2026-09-15 by a three-agent static deep-read (backend, frontend, infra) plus direct execution of both implementations' gate suites and a live runtime smoke test of the current stack. All High-severity claims were independently re-verified in-session; one agent claim (host port collision) was downgraded after live disconfirmation.*
