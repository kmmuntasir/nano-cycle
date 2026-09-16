# F01 Implementation Comparison — master-reference vs current re-implementation

| | |
| --- | --- |
| **Date** | 2026-09-16 |
| **Feature** | F01 — Monorepo scaffold & one-command local environment (`docs/features/F01-monorepo-scaffold.md`) |
| **Tree A ("reference")** | `/home/munna/archive/backup/master-reference` — branch `feature/F01-monorepo-scaffold-rebuild` @ `22e9453` (4 F01 commits; a 2nd-generation rebuild of the proven OMNI-200→203 branch, byte-identical code paths) |
| **Tree B ("current")** | `/home/munna/sonic/localhost/omni-isp` — working tree, **entire F01 change set uncommitted** (~90 files untracked/modified on `main` @ `05618bf`) |
| **Method** | Two parallel read-only analyst digests + first-hand review of every decisive artifact (READMEs, CI, compose, lifecycle scripts, sign-in screens, config validation, health module) + **live verification of both trees on this machine** (install, lint, unit tests, builds, e2e against real MySQL/Redis, full `npm run dev` → `npm run stop` cycles, font-loading harness, 360 px screenshots) |

---

## 1. Executive summary

Both trees are **high-quality, peer-grade implementations of F01** that pass every check this review could run against them. They share the same stack (NestJS 12, TypeORM 1.1.1, React 19, MUI 9.4, Vite 8, Node 24, npm workspaces) and the same rulebook, and they satisfy all ten F01 requirements to within caveats. They are **not** copies of each other: nearly every architectural decision was taken independently and differently — lifecycle orchestration, env contract, health contract shape, CI topology, i18n enforcement mechanism, font delivery, even the compose port strategy.

Where they differ materially:

- **Reference** wins on *lifecycle engineering depth* (a 191-line `dev.mjs` with port pre-flight, readiness races, auto-migrations), *backend test depth* (31 unit + 7 e2e incl. both degraded paths), *merge-blocking machinery* (committed branch-protection script, `.gitleaks.toml` with a documented fail-proof), and *process discipline* (4 clean conventional commits).
- **Current** wins on *security defaults* (`127.0.0.1`-only port bindings vs the reference's LAN-exposed stack, `engines` field, production-strict env schema with a `DB_SYNCHRONIZE` ban), *developer experience* (zero-config boot — no `cp .env.example .env` step), *frontend structure and test granularity* (22 tests, extracted `AuthLayout`/`LanguageToggle`, mechanical en/bn key-parity test), *test-DB provisioning* (initdb creates `omni_isp_test` locally), and *README operational depth*.

The single largest gap is not code quality: **the current F01 work is entirely uncommitted**, while the reference landed as four reviewable, conventional commits. Everything else in the current tree is recoverable with small fixes (§9).

**Overall: reference ≈ 4.5 / current ≈ 4.2 out of 5** — with the current tree's deficit concentrated in process and CI wiring, not implementation quality.

### Dimension scorecard

| Dimension | Reference | Current | Notes |
| --- | --- | --- | --- |
| One-command lifecycle | **5** | 4 | Reference's `dev.mjs` is best-in-class; current is simpler, zero-config, but teardown is blunt |
| Config architecture | 4 | **4.5** | Current's prod-strict Joi branch + synchronize ban is a genuine advance; dented locally by the stale root `/.env` (D1) |
| Health endpoint | **4.5** | 4 | Reference contract richer (per-check latency, timestamp); current simpler + `isInitialized` guard |
| CI machinery | **4** | 3 | Neither has ever run on GitHub; current misses Prettier + backend-build gates and a gitleaks config |
| i18n | **5** | **5** | Compile-typed keys (ref) vs mechanical parity test + locked detection (cur) — different, equally serious |
| Sign-in UI | **4.5** | 4 | Reference demos validation + dark mode; current's disabled CTA is more inert but reads "broken-ish" |
| Backend code quality | **5** | 4.5 | Both exemplary; reference shares app wiring with e2e, current repeats it manually |
| Frontend code quality | 4.5 | **4.5** | Component extraction + version surface (cur) vs dark-mode + touch-target rigor (ref) |
| Test suites | **4.5** | 4.5 | 49 tests (ref, BE-heavy) vs 40 (cur, FE-heavy); both behavior-first, real-DB e2e |
| Security posture | 3.5 | **4.5** | LAN-exposed compose ports (ref) is the worst single finding on either side |
| Documentation | 4.5 | **5** | Both excellent; current's "When it fails" section is the more operational of the two |
| Process / git state | **4.5** | 2 | Reference: committed, auditable lineage. Current: one uncommitted blob, no ticket trail |

---

## 2. Live verification evidence (both trees, this machine, 2026-09-16)

Every row below was executed, not inferred. All green on both trees.

| Check | Reference (copy @ `/tmp/f01-ref`) | Current (working tree) |
| --- | --- | --- |
| `npm ci` (root, workspaces) | ✓ 881 pkgs / 7 s | n/a (already installed) |
| `npm run lint` (both apps) | ✓ clean | ✓ clean |
| Backend unit tests | ✓ 6 suites / **31 tests** | ✓ 3 suites / **16 tests** |
| Frontend unit tests | ✓ 1 file / **10 tests** | ✓ 3 files / **22 tests** |
| Frontend production build | ✓ 522.55 kB (gzip 165.89) | ✓ 541.88 kB (gzip 171.60) |
| Backend e2e (real MySQL 8.4 + Redis 8.4) | ✓ 2 suites / **7 tests** | ✓ 1 suite / **2 tests** |
| `npm run dev` end-to-end | ✓ web :5173 → 200, `/api/docs` → 200, `/api/v1/health` → 200 JSON | ✓ web :5173 → 200, health 200 in ~12 s, `/api/docs` → 200 |
| `npm run stop` | ✓ compose down, volumes kept | ✓ processes + compose down, zero leftover listeners |
| Bengali webfont in clean Chromium | ✓ `@fontsource` Noto Sans Bengali 400/600 load; `fonts.check('…','আমার')` = true | ✓ bundled woff2 subsets load; same check = true |
| 360 px phone-width layout (headless Chrome + visual review) | ✓ card fits, no overflow, tappable targets | ✓ card fits, no overflow, tappable targets |

Notes from the runs:

- Health bodies observed live — reference: `{"status":"ok","checks":{"api":{"status":"up"},"database":{"status":"up","latencyMs":1},"cache":{"status":"up","latencyMs":1}},"version":"0.0.0","timestamp":"…"}`; current: `{"status":"ok","service":"omni-isp-backend","version":"0.1.0","uptimeSeconds":1.41,"database":"up","redis":"up"}`.
- Running both compose stacks simultaneously collides on ports 8081/8082 (both reserve them for phpMyAdmin/RedisInsight). Individually each stack is clean; the collision is an artifact of this side-by-side review.
- A vision-model pass at the Bengali screenshot claimed "tofu" — disproven objectively by the font harness (both bundles load real Noto Sans Bengali with full Bengali coverage). The claim was the vision model's own Bengali blind spot, not an app defect.

---

## 3. Requirement-by-requirement conformance

Requirements as written in `docs/features/F01-monorepo-scaffold.md` (identical in both trees).

| # | Requirement | Reference | Current |
| --- | --- | --- | --- |
| 1 | Monorepo, minimal sharing | **MET** — workspaces; only shared surface is root `.env` + lifecycle scripts | **MET** — workspaces; shared surface is root lockfile + `concurrently`/`prettier` only |
| 2 | One command up / one command down, no manual pre-steps | **MET*** — `dev.mjs`: daemon check → compose `--wait` 300 s → migrations → both apps with readiness gating. *Requires `cp .env.example .env` first (documented) | **MET** — compose `--wait` 180 s `&&` concurrently; genuinely zero-config (schema defaults). Migrations are a documented manual step after a fresh volume (no F01 impact — baseline is empty) |
| 3 | Sign-in layout only + visible not-live note | **MET** — localized notice on valid submit; zero-network proven by test | **MET** — persistent info Alert + inert disabled submit; zero-network proven by test |
| 4 | Standard Material look, no custom design system | **MET** — all-MUI, theme 1:1 from guideline §16 | **MET** — all-MUI + `sx` only, theme from guideline tokens |
| 5 | EN + BN day one, every string, persisting switch, correct Bengali | **MET** — compile-typed keys, bn/en parity type-enforced, single-writer persistence, `html[lang]` sync, self-hosted fonts (fontsource) | **MET** — JSON catalogs with a mechanical key-parity test, locked detection (localStorage → `en`), live theme rebuild for Bengali line-height, self-hosted woff2 subsets (ZWJ/ZWNJ ranges included) |
| 6 | Every screen works on a phone | **MET** — 48 px targets, 360 px test, verified visually here | **MET** — mobile-first `AuthLayout`, 48 px targets, verified visually here |
| 7 | PR checks (style + tests + web build) block merges, <10 min | **PARTIAL** — 4-job CI complete; branch protection scripted but **deliberately unapplied** (OMNI-203 owner decision); workflow has never run on GitHub | **MET with caveats** — 3-job CI; blocking relies on a documented manual protection setup; **Prettier `format:check` and a backend build/type gate are missing**; never run on GitHub |
| 8 | Health page answering | **MET** — `GET /api/v1/health`, nested per-component checks + latency + UTC timestamp, 200/503, public-by-design documented for F02 | **MET** — same route, flat shape + `service`/`uptimeSeconds`, 503 rides the error envelope with failing checks in `details`, Swagger-documented both ways |
| 9 | Example env file, placeholders only | **MET** — single root `.env.example`, every var annotated with its consumer | **MET** — three templates (`backend/.env.example`, `.env.test.example`, `frontend/.env.example`) + typed `vite-env.d.ts`; nit: 3 agent-toolchain vars the app never reads |
| 10 | No secrets; automated scan confirms | **MET locally** — gitleaks 8.30.1 via action, `.gitleaks.toml` (`useDefault` + allowlists), planted-secret fail-proof historically proven; CI scan never run on GitHub | **MET locally** — gitleaks 8.24.3 pinned binary (no license dependency), history + working tree, `--redact`; **no config file** (placeholder-password false-positive risk unverified); CI never run on GitHub |

Shared conformance gaps: in **both** trees `docs/features.md:11` still marks F01 🔴, and in **neither** tree has the CI workflow ever executed on GitHub — so "checks block merges" is machinery-true but unproven end-to-end in both.

---

## 4. Implementation strategy comparison

### 4.1 One-command lifecycle

| Aspect | Reference | Current |
| --- | --- | --- |
| Mechanism | `scripts/dev.mjs` (191 lines) + `scripts/stop.mjs` (74 lines), Node | Root `package.json` script one-liners (`package.json:15-17`) |
| Wait-for-DB | compose `--wait` + migrations run before apps | compose `--wait` + TypeORM default retry as cushion |
| Migrations | **Auto-applied** in the dev flow (idempotent) | Manual post-fresh-volume (documented in README) |
| Docker-off handling | Explicit daemon probe with actionable message | compose error surfaces (README troubleshooting covers it) |
| Port conflicts | **Pre-flight abort** naming the squatter + `.env` override; readiness probe races process death | Vite `strictPort: true` fails fast; backend dies on busy port; README documents `lsof` |
| Readiness | Polls both URLs, prints all access URLs on success | None (apps print their own output via `concurrently`) |
| Env required | Root `.env` **required** (script aborts without it) | **None** — Joi schema ships compose-matching dev defaults |
| Stop | `compose down`, volumes kept; warns about (does not kill) lingering listeners | Workspace `stop` no-op → `pkill -f` patterns → `fuser -k` ports → `compose down` |
| Robustness verdict | Best-in-class for a scaffold | Works (verified), but `pkill` substrings can collateral-damage; the `vite` pattern misses the real `vite.js` process and `fuser -k` is the actual mechanism (SIGKILL by port) |

### 4.2 Environment contract

- **Reference** — one root `.env` is the single contract for compose + backend + ports. class-validator DTO, every variable required, boot fails naming each missing var. No production special-casing (missing var = failure, everywhere). Ports default 3307/6380 to dodge the owner's personal MySQL/Redis.
- **Current** — split per-app templates; **dev-safe defaults inside the Joi schema** with a `when('NODE_ENV')` construct that makes every connection var required in production and **bans `DB_SYNCHRONIZE=true` there** (`backend/src/config/env.validation.ts:14-19,36-55`), with unit contract tests for both regimes. Single sanctioned `process.env` reader. Standard ports 3306/6379, bound to loopback.
- **Finding (D1, current)**: a stale root `/.env` leftover (references a nonexistent `docker-compose.yml`, sets `MYSQL_PASSWORD=change-me`) sits in the working tree. Compose auto-loads it, so a **fresh volume** would initialize MySQL with `change-me` while everything else defaults to `omni_dev_password` — first-boot auth failure. Gitignored (won't be committed), but it breaks the flagship one-command contract locally. Delete it.

### 4.3 Health endpoint

- **Reference** — `{status, checks:{api, database{latencyMs}, cache{latencyMs}}, version, timestamp}`; probes parallel under a 2 s budget; explicit ioredis `wait`/`end` state handling so a recovered Redis reports `up`; 503 set via passthrough `@Res()` with a written rationale (throwing would let the global envelope destroy the shape); "intentionally public, must stay unguarded in F02" documented in code.
- **Current** — `{status, service, version, uptimeSeconds, database, redis}`; `isInitialized` short-circuit; 3 s timeout with both promise sides attached (no unhandled rejections); degraded → `ServiceUnavailableException` whose payload rides the error envelope's `details` (so 503 still identifies the failing check); constants module for status vocabulary; Swagger documents 200 and 503.
- Both are dependency-light and e2e-tested with **genuinely degraded** dependencies (reference: Redis-down and DB-down paths; current: both dependencies dialed to reserved port 1).

### 4.4 CI pipeline

| Aspect | Reference | Current |
| --- | --- | --- |
| Jobs | 4: `backend`, `backend-e2e` (separate, service containers), `frontend`, `secrets-scan` | 3: `backend` (lint + migrations + unit + e2e in one job, service containers), `frontend`, `gitleaks` |
| Style gate | ESLint (Prettier not gated either) | ESLint (**`format:check` script exists but is not wired in** — D4) |
| Build gate | Frontend build (its `tsc -b`) | Frontend build (double `tsc --noEmit` + vite) — **no backend build/type gate** (D5) |
| Secret scan | gitleaks-action@v2, v8.30.1, `fetch-depth: 0` + `.gitleaks.toml` (default rules extended, `.env.example` allowlisted, one documented historic fake-key allowlist) | Pinned gitleaks binary 8.24.3, history **and** working tree, `--redact`, no license dependency (friendlier to private repos); **no `.gitleaks.toml`** — committed placeholder passwords could false-positive the gate (D6, unverified) |
| Merge blocking | `scripts/apply-branch-protection.sh` — idempotent full-replace PUT, `--dry-run`, admins enforced… **intentionally unrun** (OMNI-203) | README click-through instructions (correct, manual, less auditable) |
| Hygiene | `concurrency` cancel, npm cache, `contents: read` | Same, plus per-job timeouts 8/6/3 min |

### 4.5 i18n and fonts

- **Reference** — catalogs as TS modules; **translation keys are compile-checked** (`CustomTypeOptions` from the `en` tree) and bn/en parity is type-enforced; single-writer localStorage persistence; `html[lang]` synced from `resolvedLanguage` driving Bengali typography (font swap + 1.65 line-height) via `GlobalStyles`; fonts via `@fontsource` (self-hosted through the bundler); **plus a full dark-mode system** (beyond F01 scope) with its own persistence.
- **Current** — catalogs as JSON with a **recursive key-parity unit test**; detection locked to localStorage → `en` (a test pins "never auto-detects the browser language"); `useSyncExternalStore` on `languageChanged` rebuilds the theme so Bengali line-height applies live without reload; fonts as curated woff2 subsets committed to `public/fonts/` (bengali + latin subsets, `unicode-range` including ZWJ/ZWNJ `200C-200D`, OFL license files committed); dark-mode tokens recorded in a comment for later (scope discipline).
- Both verified end-to-end in a clean Chromium (fonts load, coverage checks pass). The two enforcement mechanisms (compile-time types vs test-time parity) are equally defensible; JSON catalogs are friendlier to non-dev translators, typed catalogs fail faster.

### 4.6 Compose stack

| Aspect | Reference | Current |
| --- | --- | --- |
| Version pinning | **Exact** (mysql 8.4.11, redis 8.4.6, phpMyAdmin 5.2.3, RedisInsight 3.8.0) | Major tags (mysql 8.4, redis 8.4, phpMyAdmin 5.2) + **RedisInsight `latest` (unpinned — drift risk)** |
| Port exposure | 3307/6380 (owner-machine rationale documented) but **bound to all interfaces** — LAN-reachable placeholder-credentialed MySQL/Redis (worst security finding on either side) | Standard 3306/6379 **bound `127.0.0.1` only** |
| Test DB | Not provisioned locally (CI-only via `MYSQL_DATABASE`) | **`docker/mysql/initdb/01-create-test-db.sql` creates `omni_isp_test` + grants on first volume init** |
| MySQL healthcheck | Password interpolated at compose-parse time (works, brittle if overridden mid-life) | `$$`-deferred expansion — always matches the container's actual password (documented) |
| Redis posture | AOF + `noeviction` (BullMQ rules cited) | AOF `everysec` + `noeviction` (rules cited) — equal |

---

## 5. Code quality findings

Both trees: zero `any` leakage, zero stray `console.*` (outside justified CLI/boot uses), strict TS, controller→service layering, one error envelope, Swagger from day 1, `synchronize: false` + baseline migration, comments that cite sources (`OMNI-xxx`, PRD §, rules files), no barrel files, no hardcoded user-facing strings (the `Omni-ISP` wordmark is a documented deliberate non-translation in both).

### Reference defect list

| Severity | Finding |
| --- | --- |
| MAJOR (conformance) | Merge-blocking unproven: branch protection deliberately unapplied (OMNI-203 decision) and the workflow has never run on GitHub — "failing checks block merges" and the 10-minute budget are locally simulated only |
| MINOR (security) | Compose publishes MySQL/Redis/phpMyAdmin/RedisInsight on all interfaces — no `127.0.0.1:` prefix on any port mapping |
| MINOR | No `engines` field in any `package.json` while `dev.mjs` uses Node-≥20.12-only APIs (`.nvmrc` is advisory) |
| MINOR | Rebuild branch dropped the OMNI-200→203 ticket docs and its own T5 verification report was never written; `docs/features.md` F01 status stale |
| MINOR | gitleaks-action on a private repo may require a `GITLEAKS_LICENSE` for some account shapes — the current tree's pinned-binary approach avoids this class entirely |
| NIT | `readAppVersion` walks 6 parent dirs; `checks.api` is tautological; healthcheck password visible in `docker inspect`; no `prefers-color-scheme`; CI hardcodes 3307/6380; one order-dependent test (emotion-head accumulation) |

### Current defect list

| Severity | Finding |
| --- | --- |
| MAJOR (local env) | **D1 — stale root `/.env`**: `change-me` values contradict compose defaults; a fresh volume initializes MySQL with credentials nothing else uses → first-boot failure. Gitignored, so a repo-hygiene issue only for this machine; delete it |
| MINOR | D2 — `npm run stop` starts with a workspace `stop` fan-out that no workspace defines (dead scaffolding) |
| MINOR | D3 — teardown by unanchored `pkill -f` substrings + `fuser -k` (SIGKILL by port): collateral potential; the `vite` pattern misses the real process, `fuser` is the actual killer |
| MINOR | D4 — Prettier `format:check` exists but is not a CI gate (style gate is ESLint-only) |
| MINOR | D5 — CI never compiles the backend (`nest build`/`tsc --noEmit` absent); backend type errors surface only incidentally via ts-jest |
| MINOR | D6 — no `.gitleaks.toml`; committed placeholder passwords (`omni_dev_password`, `omni_ci_password`) are a plausible false-positive source for the scan gate (unverified) |
| MINOR | D7 — migrations not applied by `npm run dev` (manual step; harmless for the empty F01 baseline, friction from F02) |
| MINOR | D8 — `.nano-cycle/spec-*.md` untracked and un-ignored (sweep risk; `.prettierignore` implies it is meant to be committed) |
| NIT | D9 HealthModule leans on implicit global providers; D10 three agent-toolchain vars dilute `backend/.env.example`; D11 fonts committed twice (docs mirror + app bundle; the docs copy alone carries an unused material-icons font); D12 hardcoded `<title>`; plus `CORS_ORIGINS` defaults to `*` while `enableCors` sets `credentials: true` (browsers reject that combination for credentialed calls — latent, unused in F01) |

---

## 6. Test suite comparison

| | Reference | Current |
| --- | --- | --- |
| Backend unit | 31 tests / 6 suites — config validation, health DTO state derivation, probe + timeout helpers (incl. unhandled-rejection regression), ioredis `wait`/`end` state matrix, controller 200/503 shapes | 16 tests / 3 suites — health service (incl. fake-timer hanging-probe test), env validation **contract tests for both dev-default and production-strict regimes**, Redis retry strategy |
| Backend e2e | 7 tests / 2 suites — healthy shape, semver + UTC timestamp, latency budget, Swagger publication, **Redis-down 503 and DB-down 503 as separate real scenarios**, 404 envelope with no stack leak | 2 tests / 1 suite — healthy 200 full shape, degraded 503 envelope with genuinely unreachable dependencies (reserved port 1); harness has `*_test` DB-name guardrails + per-scenario truncation |
| Frontend | 10 tests / 1 file — en render, persisted-bn boot, full-string switch + persistence + `html lang`, Bengali font/line-height computed styles, dark-mode toggle + persistence, validation + notice in both languages, **zero network calls**, 360 px structure, 48 px targets | 22 tests / 3 files — everything the reference covers for its screen plus: storage degradation, invalid-stored-value fallback, **never-auto-detect-browser-language pin**, recursive **en/bn key-tree parity**, toggle no-deselect semantics, translated version string, inert-submit contract |
| Character | Behavior-first throughout, both trees; no snapshot-only tests; adapters/nobody mocked where a real service was reachable (real MySQL/Redis in e2e) | Same |
| Verdict | Deeper backend coverage (helper-level + two degraded e2e paths + envelope 404) | Deeper frontend/i18n coverage; env-contract tests are a pattern worth keeping forever |

---

## 7. Security posture

- **Committed secrets: none, either tree.** All credentials anywhere in committed files are documented dev placeholders. `.env*` gitignored with template negations — verified with `git check-ignore` in the current tree and `git ls-files` in the reference.
- **Scan machinery**: reference ships a configured scanner (`.gitleaks.toml`, `useDefault` load-bearing comment, allowlists with written rationale, historically proven by a planted fake key); current ships a simpler, license-free scanner with no config (false-positive risk unverified). Neither has run on GitHub yet.
- **Network exposure**: current binds everything to `127.0.0.1`; reference publishes to all interfaces. On a laptop in a café this is the difference between "local dev stack" and "LAN-reachable MySQL with a placeholder root password".
- **Production hardening**: current's env schema refuses to boot in production with missing connection vars or `synchronize=true`; reference has no production branch (strict-required everywhere achieves the same by a different route).
- **Error hygiene**: both envelopes leak no stacks/internals to clients (e2e-asserted in the reference; filter-reviewed + 503-tested in the current).

---

## 8. Process, git, and documentation state

- **Reference** — 4 conventional commits (`chore: restore root workspace…`, `feat: nestjs backend scaffold…`, `feat: bilingual material sign-in screen…`, `ci: quality gates workflow…`), each scoped, all citing `(F01)`; produced through the repo's plan/tickets pipeline with a written rebuild plan. Weakness: the rebuild branch dropped the original OMNI-200→203 verification reports and never recorded its own.
- **Current** — the whole feature is **uncommitted** (`?? backend/`, `?? frontend/`, `?? docker-compose.dev.yml`, `?? .github/`, `M .gitignore`, `M README.md`, …), there is no ticket/plan artifact for F01 anywhere (`.context/` holds only a watchdog log), and `docs/features.md` still shows F01 🔴. One accidental `git clean` loses ~90 files of verified work. This is the single highest-priority action item.
- **READMEs** — both are honest and complete (prerequisites, ports, troubleshooting). Current's adds a 9-scenario "When it fails" section, the env-file matrix, package-manager policy, and standing business constants (BDT, Asia/Dhaka, MUI-only). Reference's adds the `.env`-overridable ports table and the branch-protection section. Current's is the more operational document; reference's documents its (unapplied) protection machinery more rigorously.

---

## 9. Recommendations for the current tree

Ordered by leverage:

1. **Commit the work now**, in the reference's shape: root/workspace+infra, backend scaffold, frontend sign-in, CI — four `feat`/`chore`/`ci` commits citing `(F01)`. Everything else is secondary to getting ~90 verified files out of the untracked void.
2. **Delete the stale root `/.env`** (D1) — or rewrite it to match `docker-compose.dev.yml` defaults if a compose-override surface is wanted. Also fix its comment referencing the nonexistent `docker-compose.yml`.
3. **Wire `npm run format:check` into CI** (D4) and **add a backend build/type gate** (`npm run build -w backend`) to the backend job (D5) — both are one-line additions to `ci.yml`.
4. **Prove the gitleaks gate**: run `gitleaks detect --no-git` locally against the tree; if the placeholder passwords trip it, add a `.gitleaks.toml` (copy the reference's `useDefault` + `.env.example`-allowlist pattern).
5. **Pin RedisInsight** (`redis/redisinsight:3.8.0` or newer fixed tag) instead of `latest` (drift risk; the reference pinned deliberately).
6. **Soften `stop:apps`** (D2/D3): drop the dead workspace fan-out, anchor the pkill patterns (or adopt the reference's `dev.mjs`-style process-group handling), and replace `fuser -k` SIGKILL with a TERM-then-KILL sequence.
7. **Decide on auto-migrations** (D7): either fold `typeorm:migration:run` into `npm run dev` after compose-up (reference's approach — recommended once F02 adds real schema) or keep the manual step and say so on the sign-in README path.
8. **Ignore or commit `.nano-cycle/`** (D8) — it is currently sweepable ambiguity.
9. **Update `docs/features.md` F01 → 🟢** once the branch-protection setup section has been followed and the first PR has actually run the three checks green.
10. Optional polish: tighten `CORS_ORIGINS` default away from `*` (or drop `credentials: true` until cookies exist); move the three agent-toolchain vars out of `backend/.env.example` into wherever the env-wiring check is configured.

---

## 10. Final verdict

Two independent, high-craft implementations of the same brief, both **fully working as verified end-to-end on this machine**, both lint-clean, both suites green, both booting and tearing down with one command each. The reference is the more *battle-engineered* tree (lifecycle script, deeper backend tests, configured secret scanning, committed history); the current tree is the *better-foundation* tree (safer defaults, zero-config DX, production-strict config, stronger frontend/i18n tests, better operational README).

Adopting the current tree as the going-forward base is sound — **after** committing it and closing the D1/CI gaps above, which are hours, not days. The reference remains worth mining for three specific things: its `dev.mjs` lifecycle patterns (port pre-flight, readiness race, auto-migrations), its `.gitleaks.toml` allowlist pattern, and its degraded-path e2e coverage (Redis-down and DB-down as separate scenarios) — all three would slot cleanly into the current tree.
