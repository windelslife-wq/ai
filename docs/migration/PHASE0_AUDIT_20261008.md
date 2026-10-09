# Phase 0 — Full-tree audit and migration-risk report (2026-10-08)

**Audited commit:** `92c602a55e48796dd3e47fce29113d552a9a5122` (`main`, merged PR #7) · **Working branch:** `arena/c204b9d0-ai`
**Method:** every top-level tree was read; every test suite in the repository was **executed** in this environment; every status claim inherited from earlier `docs/migration/*.md` was re-verified against the code and either confirmed, corrected or marked stale. No application code was modified while producing this report.
**Environment:** Node `v22.22.3`, npm `10.9.8`, Python `3.11.2`. No native PHP, no MySQL/MariaDB server, no PostgreSQL, no Redis, no Docker, no Android/iOS SDK. Network limited to the npm registry, PyPI and GitHub.

Supersedes nothing — it complements `INVENTORY.md` (2026-10-05 snapshot), `STATUS.md` (2026-10-06) and `RISK_REGISTER.md` by re-measuring the current tree and adding 15 new findings.

---

## 1. Verified baseline — actual results, this branch, this machine

| # | Suite | Command actually run | Result |
|---:|---|---|---|
| 1 | AEGIS PHP application suite (real CI3 stack on WASM PHP 8.2 + `pdo_sqlite`) | `npm ci --prefix runtime && node runtime/run-tests.mjs` | **367 passed, 0 failed** in 17.2 s (`TESTS-RESULT: 0`) |
| 2 | Node platform (`apps/workforce-platform`) | `npm run check --prefix apps/workforce-platform` | **43 passed, 0 failed** |
| 3 | Scout/TypeScript strict typecheck | `npm run typecheck` | **clean** (exit 0) |
| 4 | Scout contract tests | `npm run test:contracts` | **12 passed, 0 failed** |
| 5 | Football predictions | `npm test --workspace=windels-football-predictions` | **29 passed, 0 failed** |
| 6 | MT5 bridge contract (fake terminal) | `python3 -m venv && pytest python-services/mt5-bridge/test_bridge.py -q` | **9 passed, 0 failed** (1 Starlette/httpx deprecation warning) |
| 7 | Root install reproducibility | `npm ci` | **succeeds** (291 packages) — historical risk **R-04 is resolved** in this tree |
| 8 | React/Vite SPA production build | `npm --prefix apps/workforce-platform/client run build` | **passes**: 16 modules → `public/app/`, 231.19 kB JS / 72.20 kB gzip, `asset-manifest.json` emitted |
| 9 | Capacitor config validation | `npm run check:config --prefix apps/workforce-platform/native` | **passes** (`capacitor.config.json` parsed, `webDir: ../public/app`) |
| 10 | Native API-origin guard | `VITE_API_BASE_URL=http://localhost:3000 npm run build:native` | **correctly rejected**: "must be a clean, non-local HTTPS origin…" |
| 11 | Live HTTP smoke (`0.0.0.0:3123`) | `node server.js` + curl | `/`, `/app/<deep>` (HTML accept), `/api/v1/health/live` → 200; `/api/v1/health/ready` → 503 `{"database":false,"schema":false}`; `/../etc/passwd` → 404; full security-header set present; `x-request-id` present |
| 12 | Vulnerability scan | `npm audit` | **13 vulnerabilities (2 moderate, 10 high, 1 critical)** — see F-11 |

**Total: 460 automated tests green.** All CI steps in `.github/workflows/ci.yml` were reproduced locally and pass, except the GitHub-hosted PHP/Python *install* environment differences.

Correction to inherited docs: `BASELINE_TESTS.md` records 357 PHP tests and "root `npm ci` fails"; the current tree runs **367** and `npm ci` **passes**. `INVENTORY.md`'s "253 files in `application/`" is now **259**; "67 case files" is now **69** (the duplicate `28-` numbering persists).

---

## 2. What this repository actually is

**Not one application — six runtimes sharing one repo and one brand** (WINDELS AI WORKFORCE; internal code name "AEGIS"):

| # | Component | Runtime / stack | Storage | Maturity | Size |
|---:|---|---|---|---|---|
| 1 | **AEGIS platform** — `index.php`, `application/`, `system/` | PHP 8.1–8.3, CodeIgniter 3.1.13 (vendored, no Composer) | MySQL/MariaDB (`mysqli`); SQLite (`pdo`) for dev | Production source of truth, 367 tests | 259 files, 32,068 LOC app + 206 CI3 core files; 63 view files; **291 explicit routes**; 79 tables |
| 2 | **Scout / Lead Discovery** — `apps/api`, `apps/web`, `packages/shared` | **Fastify 5 + TypeScript** API; **Next.js 16**/React 19/Tailwind UI | **PostgreSQL + Redis**, JWT + rotating refresh tokens | Implemented, 12 tests; `npm start` runs via `tsx` (dev dep) | 2,286 LOC TS/TSX, 34 routes, 4 PG migrations |
| 3 | **Football Predictions** — `apps/football-predictions` | **Express 5** + helmet + express-rate-limit, vanilla JS UI | MySQL (`mysql2`), own `fp_*` tables | 29 tests; self-declared "staging validation required" | 2,709 LOC, 23 routes, 19 tables |
| 4 | **Node migration target** — `apps/workforce-platform` | Node-core `http`, Vanilla public site, React/Vite SPA, PWA shell, Capacitor wrapper | MySQL (`mysql2`) — **required to boot** | Foundation only: **7 API routes**, 43 tests | `src/` ≈ 1,100 LOC, 10 `wf_*` tables |
| 5 | **MT5 bridge** — `python-services/mt5-bridge` | Python FastAPI + `MetaTrader5` (Windows-only for a real terminal) | none (stateless) | 9 contract tests vs a **fake** terminal | 540 LOC |
| 6 | **Dev bridge** — `runtime/` | Node + `@php-wasm/node` 3.1.50 hosting the CI3 app | SQLite | dev/test only, not production | 442 LOC |

### 2.1 Legacy surface that must be preserved (component 1)

Route distribution of the 291 explicit CI3 rules: **186 `/api/…`** (60 `/api/v1/*` language learning, 34 sports, 30 lottery, 11 accounts, 9 trading, 5 execution, 4 strategies, 3 each notifications/market-data/brokers/backtesting/auth/analysis, 2 each system/risk/portfolio/journal/events/analytics/agents, 1 chat), **32 `/app/languages/*`**, and ~73 page routes (public site, auth, account, admin, workspace, paper, execution, risk, strategy, sports, brokers, portfolio, journal, notifications, leads, SEO).

Controller method counts (top): `Api_lang_learning` 38, `Api_sports` 34, `Lang_learn` 32, `Api_lottery` 31, `Api_system` 24, `Api_lead_discovery` 16, `Auth` 15, `Api_paper` 11, `Site` 9, `Tools` 8, `Paper` 8 — 287 public controller methods in total across 32 controllers. Convention routing additionally exposes any public method as `/controller/method`, so the route list is a **lower bound**.

Table families in `database/production.sql` (79): sports 18, lottery 13, paper 5, lead 4, users/auth/RBAC 8, trading/execution/audit 5, language learning 16, journal/backtests/strategies/analysis 4, platform/notifications/collections/ci_sessions 6, other.

Safety invariants (must survive 1:1): ordered **15-step Execution Supervisor**, Risk Engine veto on actual order volume, kill-switch-first semantics, strategy lifecycle gates (`APPROVED` needs ≥10 closed paper trades with PF>1), automation envelope, synthetic-provenance labeling with `allowSyntheticPaperData` default-off, `ANALYSIS_ONLY` default, agents structurally unable to reach connectors, deny-by-default RBAC (8 roles / 10 permissions), CSRF on every authenticated mutation, and the lottery "these are historical observations, never predictions" honesty contract.

### 2.2 What the Node target already has

- `server.js` (40 lines) → `src/app.js` (497 lines) core-`http` app: static allow-list with `realpath` containment, W-etag/immutable caching, `Accept`-negotiated `/app/*` SPA fallback, bounded 16 kB JSON body, security headers + CSP + HSTS in production, request IDs, per-IP rate limiting (120/min global + per-route), `Sec-Fetch-Site`/origin rejection for cross-site mutations, timeouts, graceful shutdown; `src/config.js` env validation incl. Node-version gate `>=22.20 <25`; `src/security/` bcrypt verify (`$2y$`→`$2b$` normalization), hashed opaque sessions, HMAC session-bound CSRF, constant-time compare; `src/db/` bounded `mysql2` pool, checksum-verifying migrator, `wf_*` identity/session/RBAC/audit store, dry-run-first one-shot legacy identity importer; **7 API routes** (`/api/v1/health/live|ready`, `/auth/login|me|csrf|logout`, `/admin/identity/users`).
- `public/` Vanilla site (150-line landing page, 186-line CSS, 31-line JS), manifest, static-only service worker, `robots.txt`.
- `client/` React 19 + Vite 8 SPA (217-line `App.jsx`) with sign-in + readiness + permission display and six honest "Not yet ported to Node" module cards.
- `native/` Capacitor 8.5.2 config with HTTPS-origin build guard; Android/iOS projects not generated; **native sign-in disabled**.

**Port coverage: 7 of ~348 documented endpoints (≈2%).** Identity/session only. Zero business modules.

---

## 3. Dependency audit (measured, not assumed)

| Component | Production deps | Dev deps | vs. instructed policy |
|---|---|---|---|
| `apps/workforce-platform` | `bcryptjs@^3.0.2`, `mysql2@^3.24.5` | — | Backend is **not** built-ins-only; `pg@8.16.3` absent; no `pg@` at all |
| `apps/api` (Scout) | `fastify@5.12.1`, `@fastify/jwt`, `@fastify/cors`, `pg@8.15.6`, `ioredis@5.6.1`, `bcryptjs`, `zod` | `@types/pg` | Framework-based, non-`pg`-pinned, **Redis required** — contradicts §1/§3 for any target that inherits it |
| `apps/web` (Scout) | `next@16.3.2`, `react@19.1.0`, `react-dom` | tailwind, postcss, autoprefixer | Next.js SSR, not the instructed React+Vite SPA |
| `apps/football-predictions` | `express@^5.2.1`, `helmet`, `express-rate-limit`, `mysql2` | — | Express — prohibited in the target backend |
| `packages/shared` | `zod@3.24.4` | — | fine as build-time contract |
| root | — | `typescript@5.8.3`, `tsx@4.19.3`, `@types/node@22.15.3` | dev-only, correct |
| `runtime/` | `@php-wasm/*` | — | dev-only, correct |
| `native/` | `@capacitor/{core,android,ios}@8.5.2` | `@capacitor/cli` | isolated from backend, correct |

Semver ranges are `^` in three packages (`mysql2`, `bcryptjs`, `express`, …) while workspaces root pins exact versions — pinning is inconsistent (F-12).

---

## 4. Findings

Severity: 🔴 blocks cutover/production · 🟠 must be fixed inside the phase that owns it · 🟡 track. "New" = not present in `RISK_REGISTER.md`.

| ID | Sev | Area | Finding (evidence) |
|---|---|---|---|
| **F-01** | 🔴 **New** | Backend/API | The Node server **cannot run without MySQL**: `loadConfig` hard-requires `DB_HOST/DB_NAME/DB_USER/DB_PASSWORD` (`src/config.js:33,62`) and `server.js` always builds a pool. Missing vars throw at boot. No storage adapter abstraction, so "run where the configured adapter permits" is unmet, and no local/dev or test path exists without a database. |
| **F-02** | 🔴 **New** | Error contract | Every DB failure surfaces as **500 `INTERNAL_ERROR`**. Live check: `POST /api/v1/auth/login` with no MySQL → `500`, server log `errorCode:"ECONNREFUSED"`. No `SERVICE_UNAVAILABLE` mapping, no `Retry-After`, no circuit awareness — a client cannot distinguish "down" from "bug". |
| **F-03** | 🟠 **New** | REST contract | The router registers **GET and POST only** (`src/app.js:289-305`). No `PUT/PATCH/DELETE/OPTIONS`, no path params, no query parsing, no pre-flight handling. The instructed "REST API with versioning, pagination, filtering, sorting, search" and any consolidation of Scout/Football (which use `PUT`) are unreachable without extending the core. |
| **F-04** | 🟠 **New** | Validation | `validateSchema` (`src/app.js:64-84`) validates only `type:object`, `required`, `additionalProperties:false`, and `string` `minLength/maxLength`. No number/boolean/array/enum/pattern/format/nullable support, no query/body coercion, no field-level error detail. Acceptable for a login form; unsafe as the validation layer for ~340 endpoints. |
| **F-05** | 🟠 **New** | Security headers/CORS | No CORS surface at all (`grep -i cors apps/workforce-platform/src` → empty): only same-origin equality against `PUBLIC_BASE_URL` + `Sec-Fetch-Site`. The SPA is same-origin today, but native/second-origin clients and the instruction's "CORS controls" need an explicit allow-list config, and there is currently no way to grant it. |
| **F-06** | 🟠 **New** | Uploads | No upload/download implementation: JSON-only body parsing with a 16 kB cap, no multipart, no file-type or size policy, no authorization on files, no `/uploads` route, no migration of PHP avatar files. **Additionally:** `serveStatic` resolves any file under `public/`, so a future `public/uploads/` would be **publicly readable without auth** — uploads must land outside the static root with an authorized download route. PHP's avatar path (`assets/uploads/`, gitignored) has no Node equivalent. |
| **F-07** | 🟠 **New** | RBAC parity | Node migration 001 seeds **2 roles / 3 permissions** (`identity.users.view|manage`, `system.health.view`); the legacy matrix (`tools/rbac.php`) is **8 roles / 10 permissions** (`system.super_admin`, `trading.*`, `sports.*`, `lottery.*`). The importer copies legacy rows, but nothing in Node consumes or verifies the legacy permission vocabulary, and `system.authenticated` (lead discovery) is absent. Parity checks and a documented mapping are required before any protected module is ported. |
| **F-08** | 🟠 **New** | Rate limiting / DoS | Rate limiter is process-local with lazy eviction only above 10,000 keys (`src/app.js:120-133`): unbounded memory growth under distributed probing, no per-account lockout (PHP had none either, but bcrypt cost 12 makes account-targeted work expensive), no back-off on the DB path, and nothing shared across workers. Multi-process Passenger = multiplier on every limit. |
| **F-09** | 🟠 **New** | PWA | Installability/updates are weak: the manifest declares **only one SVG icon** (`sizes:"any"`, `purpose:"any maskable"`) — no 192/512 PNG maskable set, which Android/Chrome expect for install; `service-worker.js` uses a **static cache name** (`windels-public-shell-v1`) and **cache-first for unhashed `/styles.css` and `/site.js`**, so an updated public shell can stay stale until the SW file itself changes; there is no update prompt/`skipWaiting` UX beyond install time, and no automated PWA test. The instruction's "reliable update mechanism that does not trap users on an obsolete version" is not yet satisfied. |
| **F-10** | 🟠 **New** | SEO parity | Node serves one landing page + `robots.txt`; **no `/sitemap.xml`**, no canonical URLs, no about/services/how-it-works/locations/safety/faq/contact(+submit) pages (PHP `Site`/`Seo` cover 10 views), and no metadata config (PHP `application/config/seo.php`). Public-site parity is ~1/10 of the surface. |
| **F-11** | 🟠 | Supply chain | `npm audit` at root: **13 vulnerabilities (10 high, 1 critical)**. Direct: `next@16.3.2` (**critical**, ≤16.3.7), `fastify` (high), `postcss` (high), `tailwindcss` (high) — all inside the Scout stack; the `workforce-platform` server package itself reports none. STATUS.md's "10 vulnerabilities" is stale. |
| **F-12** | 🟡 **New** | Reproducibility | Pinning is inconsistent (`^` ranges in `apps/workforce-platform`, `apps/football-predictions`; exact in `apps/api`, root). The workforce server package has **no lockfile of its own** and relies on root hoisting; `runtime/`, `client/`, `native/` each ship their own. Instruction §3 "lock dependency versions" needs a decision: one root lockfile vs per-package. |
| **F-13** | 🟡 **New** | Ops | No `process.on("uncaughtException"/"unhandledRejection")` handler, no request log line for static/unknown paths, no structured request completion log, no `/health` for connections/pool saturation, no `maxRequestsPerClient`, no query timeout on the pool, no backup/restore/data-integrity tooling on the Node side (`deploy/cpanel/ROLLBACK.md` is PHP-oriented). |
| **F-14** | 🟡 **New** | Configuration | `apps/workforce-platform/.env.example` is headed "Development example only" but sets `NODE_ENV=production` (which forces `__Host-` cookies, HTTPS `PUBLIC_BASE_URL` and HSTS); it omits `LEGACY_DB_*` needed by the importer CLI, upload/session paths, rate-limit knobs and logging level defaults. No `.env` loader is provided by design (documented), which is dev friction worth an explicit `--env-file` convention. |
| **F-15** | 🔴 | Data | **No real-MySQL verification exists anywhere in the Node path.** All 43 tests use fake pools; migrator, importer, session and audit SQL are unproven against MariaDB/MySQL (JSON columns, `DATETIME(3)`, FK cascade, collations, `ON DUPLICATE KEY`); `runtime/` proves the PHP suite on **SQLite**, not the MySQL production path (R-14 still open). This sandbox has no MySQL server, so this gate cannot be closed here — only by a staging host or an approved container. |
| **F-16** | 🔴 | Legacy | R-03 **re-confirmed and still open**: `application-deployment.zip` (2026-08-24, 573 files) differs from the tree in **30 of 226** PHP files compared, and `application/controllers/Api_portfolio.php` is **missing from the zip entirely** — while `README.md:107` and `docs/CPANEL_DEPLOYMENT.md:14` instruct users to upload that zip. R-08 **still open**: the seeded `admin@example.com` bcrypt hash remains at `database/production.sql:925`. |
| **F-17** | 🟠 | Documentation | R-06 **still open**: `README.md` carries two contradictory status tables ("**367 automated tests**" at line 64 vs a stale "**57 automated tests**" table at line 86). `docs/migration/BASELINE_TESTS.md` under-reports (357). |
| **F-18** | 🟠 | Architecture | Two lead-discovery implementations remain live with incompatible identity/storage models (F-18 ≡ R-02): CI3 MySQL module (11 tables, `org-<n>`/32-hex ids, session+CSRF) vs Scout PostgreSQL (13 tables, UUIDs, JWT+refresh). Consolidation still needs the id-mapping + column-diff decision before either is touched. |

---

## 5. Direct conflicts with the instruction's mandated requirements

These are **contradictions in the requirements themselves** when applied to this repository — surfaced per the instruction's own rule ("If any requirement is incomplete or ambiguous, identify it explicitly rather than guessing"):

| # | Instruction says | Repository reality | Status |
|---|---|---|---|
| C-1 | "PostgreSQL must be optional, using `pg@8.16.3` as the **only** production npm dependency" | Production schema is **MySQL/MariaDB**: 1,159 lines / 79 tables, all `ENGINE=InnoDB`, `LONGTEXT`, `utf8mb4`, deployed to cPanel phpMyAdmin. `pg` speaks the PostgreSQL wire protocol and **cannot connect to MySQL**. | Prior decision (2026-10-06) recorded **MySQL retained, `pg` out of scope**, keeping `mysql2`. Awaiting confirmation or reversal. |
| C-2 | "Core modules only for the HTTP platform" / "Node.js built-ins only" for the backend | A bcrypt verifier is required to log in existing `$2y$` users (`password_hash(PASSWORD_DEFAULT)`); Node core has no bcrypt. `bcryptjs` is in use. | Needs either retention (current) or an approved **forced password reset / scrypt-argon rehash program** with user communication. |
| C-3 | "Do not introduce additional production npm packages without explicit approval" | `apps/api` additionally ships `fastify`, `@fastify/jwt`, `@fastify/cors`, `ioredis`, `zod`; `apps/football-predictions` ships `express`, `helmet`, `express-rate-limit`; `apps/web` ships Next.js SSR — three runtimes that violate the target policy if left as-is. | Needs a disposition decision per app (consolidate / isolate-as-legacy / retire). |
| C-4 | "Primary entry point: `server.js`" | No root `server.js`; the entry is `apps/workforce-platform/server.js` (cPanel/Passenger starts `passenger-start.cjs` there). Root `index.php` is the live production entry. | Needs a decision: promote a root `server.js` facade vs keep the workspace path. |
| C-5 | "Do not require Docker, Redis, a process manager, or an external service" | Scout requires PostgreSQL **and** Redis (own compose file); its `start` script runs `tsx` (a dev dependency) at runtime. | Blocking for consolidation; either port Scout to MySQL/no-Redis or declare it out of the monolith. |
| C-6 | "Migrate the actual repository, preserving existing features" | Full parity ≈ 348 endpoints, 108 tables across three storage engines, 63 PHP views, 8 job pipelines, 5 external provider families, and safety invariants with 367 oracle tests. Realistically **multiple weeks of staged work**, and real-MySQL/cPanel/native-SDK gates cannot be closed in this sandbox (F-15). | Needs scope authorization per session (see §7). |
| C-7 | "Preserve existing PHP application and its data" | PHP app is intact and green; **it stays authoritative**. Nothing here authorizes import, deploy or cutover. | Aligned — no decision needed, stated for the record. |

---

## 6. Proposed target structure (Phase 1 output, pending approval)

Keep `apps/workforce-platform` as the monolith (it already satisfies the "modular monolith, not a dumping ground" rule) and make the layering explicit:

```text
apps/workforce-platform/
  server.js                     # only listener + graceful lifecycle (unchanged role)
  src/
    http/    router.js static.js body.js errors.js      # verbs incl. PUT/PATCH/DELETE, path params, query
    security/ headers.js csrf.js sessions.js passwords.js ratelimit.js uploads.js
    config/  env.js (validated, .env-file supported)   # CORS allow-list, storage adapter, limits
    persistence/
      mysql/    pool.js store.js migrate.js     # existing, hardened (query timeouts, error mapping)
      file/     store.js                        # durable JSONL+fsync adapter: dev/test only, honest limits
      index.js  # adapter selection + capability report
    modules/  identity/ account/ notifications/ audit/ health/
              marketdata/ analysis/ strategies/ backtest/ risk/ paper/ execution/ brokers/
              portfolio/ sports/ lottery/ langlearn/ leaddiscovery/ chat/
    jobs/     cron.js (short-lived, idempotent, DB-locked)
  public/                       # Vanilla site + PWA assets (React-free), sitemap, canonical
  client/                       # React 19 + Vite 8 SPA → served at /app, separate package
  native/                       # Capacitor 8 shell over the same SPA build
  scripts/    backup.js restore.js verify-install.js verify-data.js
docs/migration/ … (parity ledger per module)
```

Rules carried forward: one origin `/api/v1/*`; no framework middleware; every module owns `routes.js / service.js / repository.js / contracts.js`; **parity test with the PHP oracle is the gate for each module**; `application/` + `system/` untouched until cutover approval; no production write path enabled by default.

---

## 7. Phased plan with acceptance gates and sizing

Sizing is honest engineering effort, not marketing. "Session" = a bounded, verifiable increment I can complete and test here.

| Phase | Work | Gate (all must pass) | Effort |
|---|---|---|---|
| **0. Audit** *(this document)* | full-tree audit + verified baseline | every claim executable; 460 tests recorded | done |
| **1. Decisions** | resolve C-1…C-6; write ADRs; refresh `STATUS.md` | written decision + risk register updated | 1 turn |
| **2. Backend hardening** | F-01…F-05, F-08, F-13, F-14: full-verb router + path params + query parsing; real validator; DB-error→status mapping (503 + `Retry-After`); capability-reporting storage adapter with durable file fallback for dev/test; CORS allow-list config; rate-limit eviction + optional account lockout; startup/shutdown/exception handlers; `pg@8.16.3` **only if** C-1 says yes | new unit+HTTP tests; existing 43 stay green; `node --check`; no server dep added beyond the approved set | 1–2 sessions |
| **3. Persistence & ops** | real-MySQL migration/backup/restore/verify scripts + `LEGACY_DB` docs; pool query timeouts; data-integrity checks; cPanel/Passenger deploy notes with the unverified parts named | scripts run in CI against SQLite/file adapter; MySQL job marked **blocked here** (needs staging host) | 1–2 sessions |
| **4. Frontends** | Vanilla site: 7 public pages + contact submit + `/sitemap.xml` + canonical/metadata from a config module (F-10); SPA: API client with typed error handling, auth-aware router, permission-gated nav, loading/empty/error/offline states, reusable components; PWA: PNG icon set, hashed-asset cache + update flow, offline banner (F-09) | builds green; Lighthouse-style manual checks recorded; no private response cached; `robots` keeps `/app/` out | 2 sessions |
| **5. Module parity (iterative)** | ordered: identity+accounts → notifications/audit → market data → analysis/agents → strategies/backtest → portfolio optimizer → paper trading → risk → execution supervisor → brokers → sports → lottery → language learning → lead discovery consolidation → chat/misc | per module: endpoint parity tests vs the PHP oracle, RBAC/CSRF parity, ownership isolation, negative bypass tests for safety invariants, `UNFINISHED_MODULES.md` row flipped to "ported" | ~1 session per module; **≈15 sessions** for full parity |
| **6. Native + security hardening** | native token/refresh/revocation contract, Keychain/Keystore storage, deep links, `cap add android/ios` config checks, upload security tests, secret/dependency scans | `cap doctor`-equivalent checks; native sign-in stays disabled until storage flow is accepted; SDK builds **blocked here** | 1–2 sessions |
| **7. Cutover package** | importer rehearsal plan, delta/backup/restore/rollback runbook, deployment doc, final audit vs this report | explicit human approval before any production change | 1 session |

**Realistic near-term proposal:** Phases 1–4 plus Phase 5's first module (identity/accounts: register, forgot-password, account self-service, admin users, avatar upload with authorization) — i.e. close every 🔴/🟠 platform finding that can be closed in this sandbox, and prove the module-parity *methodology* end-to-end once. Full business parity is not achievable in one session and I will not represent it as done.

---

## 8. Migration checklist — live status

| State | Modules |
|---|---|
| **Completed (foundation-level, tested)** | Node-core HTTP listener + static/PWA serving + security headers + request IDs + timeouts + graceful shutdown; env validation incl. Node version gate; opaque hashed sessions + rotation; CSRF; deny-by-default RBAC primitives; checksum-verified migrations; bounded `mysql2` pool; one-shot legacy identity importer (dry-run-first); Vanilla landing page; React/Vite SPA shell; Capacitor config + HTTPS-origin guard; CI running all five suites |
| **Partially complete** | Public site (1 of ~8 pages, no sitemap), PWA (no PNG icons, stale-asset/invalidation gaps, no offline writes by design), SPA (auth shell only), persistence (no adapter abstraction, no file/dev mode), uploads (absent, and a public-dir trap), native (config only, sign-in disabled) |
| **Blocked here (environment, not code)** | Real MySQL/MariaDB integration, cPanel/Passenger deployment, Android/iOS SDK builds and signing, real MT5 demo-terminal verification, licensed market-data/sports/lottery providers, SMTP delivery, production data volumes |
| **Not started** | All business modules: trading (analysis, agents, strategies, backtest, optimizer, paper, risk, execution, brokers, portfolio), sports, lottery, language learning, lead discovery + Scout consolidation, notifications, audit browser, chat, admin/users, jobs/cron, backup/restore tooling, parity-test harness |

---

## 9. Explicitly out of scope until approved

Running the identity importer against any real data; deploying to or modifying cPanel/production; enabling live trading, real broker routing or provider credentials; deleting/renaming `application/`, `system/`, `runtime/` or either legacy app; changing PHP behavior; publishing signed native apps; `npm audit fix --force` on the Scout stack (breaking).

---

## 10. Closure status after Phase 2 (2026-10-09, branch `arena/c204b9d0-ai`)

Every finding that could be closed in code, in this sandbox, without touching
production or inventing a dependency, is closed — each with a named test, not a
claim. Detail, including the bugs the tests exposed and the deliberate contract
changes, is in [`PHASE2_IDENTITY.md`](PHASE2_IDENTITY.md).

| ID | Severity | Status | Evidence |
|---|---|---|---|
| **F-01** | 🔴 | **Closed** — `STORAGE_ADAPTER=file\|mysql\|auto`; the server boots and serves with no DB configured | `test/platform_findings.test.js`: `F-01 the server boots, serves and signs in with no database configured at all` (+2 more) |
| **F-02** | 🔴 | **Closed** — `AppError` taxonomy, 503 + `Retry-After` on dependency failure, status/route surface honest | `F-02 readiness reports the adapter…503 with Retry-After…`, `F-02 the status surface is honest…` |
| **F-03** | 🟠 | **Closed** — `src/http/router.js`: 7 verbs, params, 405 + `Allow`, query parsing, admin pagination/search/sort | `F-03 the router is method-exact…`, `F-03 every verb is declared explicitly…`, `F-03 administration is paginated…` |
| **F-04** | 🟠 | **Closed** — `src/http/validation.js` (numbers, booleans, arrays, enums, pattern, format, nullable, coercion, per-field issues) | `F-04 the validator enforces…`, `F-04 a rejected request answers 400 with field-level detail…` |
| **F-05** | 🟠 | **Closed** — exact-origin credentialed CORS allow-list, `Vary: Origin` on success/error/204, `*` refused at boot | `F-05 CORS is opt-in…` (+2) |
| **F-06** | 🟠 | **Closed** — multipart, size/type policy, signature sniffing, uploads outside the static root, owner-or-admin download | `F-06 body limits…`, `F-06 an avatar is identified by its bytes…`, `F-06 the avatar route stores, serves and removes…` |
| **F-07** | 🟠 | **Closed** — migration 003 + `src/db/platform-baseline.js` seed the legacy 8 roles / 14 permissions incl. `system.super_admin`; the two are asserted against each other | `test/seed-platform.test.js`: `F-07 …identical role and permission vocabulary` (+2); `F-07 migration 003…` |
| **F-08** | 🟠 | **Closed** — bounded key set with eviction, per-account lockout (never per-IP), independent per-route limits, switchable | `F-08 the login guard locks…` (+4) |
| **F-09** | 🟠 | Open — Phase 3 (PWA icons, hashed shell, update UX) | deferred, listed in `PHASE2_IDENTITY.md` §5 |
| **F-10** | 🟠 | Open — Phase 3 (sitemap, canonical, 10 public pages, SEO config) | deferred |
| **F-11** | 🟠 | Open — Scout-stack advisories only; workforce server package reports none | needs an approval-gated upgrade pass |
| **F-12** | 🟡 | Open — pinning/lockfile decision still unmade | decision, not code |
| **F-13** | 🟡 | **Mostly closed** — request log line, `uncaughtException`/`unhandledRejection`, pool-aware health, backup/verify/restore, `migrate:status`, `verify:install`, `verify:data`, `seed:platform` | `test/backup.test.js` (4 `F-13` tests); pool saturation metrics still open |
| **F-14** | 🟡 | **Closed** — `.env.example` documents all 38 variables (enforced by a `verify:install` check) and no longer sets `NODE_ENV=production` | `F-14 the example environment documents every variable…` |
| **F-15** | 🔴 | **Open, cannot close in this sandbox** — no MySQL server exists here; the SQL paths remain unit-covered against fake pools only | blocking on a staging host; stated plainly in the status surface |
| **F-16** | 🔴 | **Open** — zip still in tree and still stale (re-verified: `routes.php` differs, `Api_portfolio.php` absent from the archive). The deployment docs now warn at the point of use instead of sending users to it | deleting/rebuilding the artefact is a production action, needs approval |
| **F-17** | 🟠 | **Closed** — the contradictory "57 automated tests" table is removed from `README.md`; both READMEs now state the current slice and the real test counts | `README.md`, `apps/workforce-platform/README.md`, `PHASE2_IDENTITY.md` |
| **F-18** | 🟠 | Open by decision — consolidation gated on the id-mapping/column-diff decision | `RISK_REGISTER.md` R-02 |

Measured here: **85** app tests (`apps/workforce-platform`), **367** legacy runtime
tests, **21/21** install checks, `verify:data` clean on a seeded store and failing (exit 1)
on an unseeded one. No production host, real database, provider or signed native build
was touched.

## 11. Closure status after Phase 3 (2026-10-09, branch `arena/774d9e70-ai`)

Public site, SEO documents, PWA shell and contact intake. Full record with the parity tables,
the divergences and the rehearsal log: [`PHASE3_PUBLIC_SITE.md`](PHASE3_PUBLIC_SITE.md).

| ID | Severity | Status | Evidence |
|---|---|---|---|
| **F-09** | 🟠 | **Closed** — generated PNG icon set (192/512/maskable-512/apple-touch-180) reproducible from `tools/generate-icons.mjs`; service worker generated per request with a content-hash cache name (`windels-shell-<sha256[:16]>`), hashed build assets cache-first, unhashed shell no longer cache-first, `/api/`, `/uploads/`, `/private/`, `/data/`, the worker itself and `/contact/submit` never cached; update prompt (Reload / Not now → `SKIP_WAITING`, reload on `controllerchange`) in both `public/site.js` and the SPA; offline banner; worker served `no-cache` | `test/site.test.js`: `F-09 the icon set is real PNGs at the sizes install prompts require, reproducible from the generator`, `F-09 the service worker is generated, versioned by shell content, and its policy is data` (the generated source is **compiled** in the test); `test/http.test.js` worker assertions; `verify:install` checks 22–25 (icons present) and 28 (icons byte-identical to the generator) |
| **F-10** | 🟠 | **Closed** — all 8 legacy public pages + 3 aliases + 6 auth/workspace redirects rendered, `robots.txt` (6 legacy disallow rules + 3 Node-only prefixes, conditional `Sitemap:`), `sitemap.xml` (8 paths, refuses relative `<loc>`), `manifest.webmanifest`, canonical/Open Graph/twitter/theme metadata from one validated `SITE_*` surface, contact intake stored + audited + throttled with a signed one-shot flash. `publicSite` still reports **`partial`**: the legacy chat widget is deliberately not ported | `test/site.test.js`: 6 `F-10` tests, the first of which parses `application/config/routes.php` and asserts every legacy site rule is answered; heading parity is compared against `application/views/site/*.php` with entities decoded |
| **F-13** | 🟡 | **Further closed** — `MAX_REQUESTS_PER_CLIENT` concurrency ceiling (429 `TOO_MANY_CONCURRENT_REQUESTS` + `Retry-After: 1`) landed, the last item from this finding that was implementable without a database. Pool-saturation metrics still open | `test/site.test.js`: `F-13 the concurrency ceiling refuses parallel slow requests from one address` |
| **F-14** | 🟡 | **Still closed, re-verified** — `.env.example` documents **45** variables including the new `SITE_*`, `THEME_COLOR`, `ROBOTS`, `CONTACT_*` and `MAX_REQUESTS_PER_CLIENT` | `verify:install` check 25 |
| **F-11** | 🟠 | Open — unchanged | needs an approval-gated upgrade pass |
| **F-12** | 🟡 | Open — decision, not code. **The gate was not triggered:** Phase 3 added no package to any manifest (server dependencies remain exactly `bcryptjs` + `mysql2`; client `devDependencies` unchanged). Recommendation recorded for approval: per-package lockfiles, starting with `npm install --package-lock-only` inside `apps/workforce-platform/`, because a cPanel install runs per application directory and root hoisting is unavailable there | `PHASE3_PUBLIC_SITE.md` §10 |
| **F-15** | 🔴 | **Open, cannot close here** — migration `004_public_site.sql` and `src/db/site-repository.js` are unit-covered against a fake pool only; no MySQL server exists in this sandbox, so `wf_contact_inquiries` has never been created by one | blocking on a staging host |
| **F-16** | 🔴 | Open — unchanged | production action, needs approval |
| **F-17** | 🟠 | **Closed** — `BASELINE_TESTS.md` re-counted for Phase 3 (this was the remaining item) | `BASELINE_TESTS.md`, Phase 3 section |
| **F-18** | 🟠 | Open by decision — unchanged | `RISK_REGISTER.md` R-02 |

Measured here: **103** app tests (18 new), **30/30** install checks, **4/4** icon checks,
**367** legacy runtime tests, **12** Scout contract tests, **29** football-prediction tests —
**511** passed, 0 failed — plus a green client build (20 modules, 265.27 kB JS / 79.47 kB gzip)
and a live `curl` rehearsal of every document route on the file adapter. `application/` and
`system/` are unchanged; no production host, real database, provider, browser or signed native
build was touched.

## 12. Closure status after Phase 4 (2026-10-09, branch `arena/774d9e70-ai`)

Market data and provider health — the first module in the master plan's dependency order, because
analysis, strategies and paper trading all consume it. Full record with the parity tables, the
divergences and the rehearsal log: [`PHASE4_MARKET_DATA.md`](PHASE4_MARKET_DATA.md).

| ID | Severity | Status | Evidence |
|---|---|---|---|
| **F-02** | 🟠 | **Extended to a real external dependency** — market data is the first module that calls a third party, and a provider failure answers `503` + `Retry-After` with `MARKET_DATA_UNAVAILABLE` / `SYNTHETIC_DATA_DISABLED` instead of the legacy `502` + bare `{error}`. The provider's own message is preserved in `error.details.reason` | `test/market_data.test.js`: `a host that refuses synthetic data returns an outage, never invented candles` (asserts the status, the code, `details.syntheticAllowed:false`, a positive `Retry-After` and the absence of a candle array) |
| **F-14** | 🟡 | **Still closed, re-verified** — `.env.example` documents **53** variables including the 8 new `MARKET_DATA_*` / `BINANCE_API_BASE` / `FRANKFURTER_API_BASE` and the `AEGIS_*_DATA_*` licensed-feed family (read through a computed key, so documented by hand) | `verify:install` check 25 |
| **F-12** | 🟡 | Open — decision, not code. **The gate was not triggered again:** Phase 4 added no package to any manifest; `fetch`, `AbortSignal` and `URLSearchParams` are platform built-ins, so server dependencies remain exactly `bcryptjs` + `mysql2` | `PHASE4_MARKET_DATA.md` §1 |
| **F-15** | 🔴 | **Open, unchanged but narrowed** — this phase added no schema and no migration (market data persists only an audit row through the existing repository contract), so there is nothing new for a real MySQL server to prove. The four existing migrations remain unexercised against one | `PHASE4_MARKET_DATA.md` §9 |
| **F-11**, **F-16**, **F-17**, **F-18** | — | Open — unchanged; none was touched by this phase | `PHASE4_MARKET_DATA.md` §10 |
| **F-24** (new) | 🟡 | **Open** — *provider health is per-process.* Circuit breakers, the failure log and the TTL caches live inside one Node process, so under Passenger's multi-process model each worker keeps its own view and `/api/v1/market-data/providers` can answer `UP` from one worker and `DOWN` from another. Acceptable while PHP is authoritative | `PHASE4_MARKET_DATA.md` §10; needs a shared health store or a single prober before market data is trusted operationally |
| **F-25** (new) | 🟡 | **Open** — *nothing in CI ever calls a real provider.* Every provider test injects a transport, and this sandbox has no egress, so a silent upstream API change (a renamed field, a new error envelope) would be caught by a user rather than by a build | `PHASE4_MARKET_DATA.md` §9–§10; wants a scheduled probe on a host with outbound HTTPS |
| **F-26** (new) | 🟡 | **Open** — *the ported numeric algorithms are not diffed against PHP output.* Both suites are green, but the golden constants in `test/market_data.test.js` (synthetic candles, `hashString`, PRNG and Gaussian sequences) were produced by the Node port; an attempt to extract the same values from WASM PHP timed out in this sandbox. A pure-function comparison — no database, no network — would close it | `PHASE4_MARKET_DATA.md` §9 item 2; cutover prerequisite |
| **R-24**, **R-25** (new) | 🟠 / 🟡 | **Recorded** in `RISK_REGISTER.md`: external market-data dependency (egress, vendor drift, rate limits, no licensed feed) and the risk that labelled synthetic data is consumed as if it were real by a later module | `RISK_REGISTER.md`, "Additions after Phase 4" |

Measured here: **137** app tests (34 new), **30/30** install checks, **367** legacy PHP/WASM oracle tests
(all eleven `tests/cases/02-providers.php` cases among them, passing on both sides of the migration),
**12** Scout contract tests, **29** football-prediction tests and a clean `npm run typecheck` — **545
passed, 0 failed** — plus a live `curl` rehearsal of all three endpoints, their 401/400 boundaries, the
provider registry and the audit trail on the file adapter. **Not** measured: a live upstream provider (no
egress — both real providers reported `DOWN` and the chain fell back to labelled synthetic data), a
licensed feed, a value-for-value diff of PHP versus Node numeric output (F-26), a real MySQL server, any
market-data UI, or any cutover. `application/` and `system/` are unchanged.
