# JavaScript / Node.js / cPanel migration status

**Updated:** 2026-10-06 · **Branch:** `arena/9643b72f-ai`

## Decision and safety boundary

The migration is the whole WINDELS AI WORKFORCE platform, not just the PHP front end. Proceed side-by-side, module by module, with MySQL/MariaDB, Passenger-compatible Node.js, parity/security evidence, and rollback. Keep PHP authoritative until the complete replacement is explicitly accepted. Never enable live trading, alter production data, deploy, or cut over traffic without approval.

The implementation slice now follows the requested Node-core HTTP + Vanilla public site + React/Vite SPA + PWA + Capacitor-shell shape. The user selected MySQL/MariaDB as the database target. Therefore `mysql2` remains necessary and `pg@8.16.3` is not installed: `pg` cannot connect to MySQL. The legacy PHP bcrypt verifier also remains until an explicitly approved password-reset or hash-migration decision.

## Confirmed decisions (2026-10-06, branch `arena/9643b72f-ai`)

A feasibility review of the target shape — dependency-light Node monolith, Vanilla JS public site, React/Vite SPA, PWA, Capacitor native apps — was requested with "`pg@8.16.3` as the only production dependency". Two decisions were taken and are recorded here as authoritative.

**1. MySQL/MariaDB is retained; `pg@8.16.3` is out of scope.** The production schema is MySQL/MariaDB DDL: `database/production.sql` is 1,159 lines defining 79 tables, all 79 `ENGINE=InnoDB`, with 39 `AUTO_INCREMENT`, 36 `LONGTEXT` and 80 `utf8mb4` occurrences, targeting cPanel. `pg` implements the PostgreSQL wire protocol and cannot connect to MySQL, so "only `pg`" is not satisfiable against this baseline. No PostgreSQL rewrite is authorized. The only `pg` reference in the repository remains `apps/api/package.json` at `8.15.6`, which is unrelated to this platform.

**2. Legacy passwords move to lazy rehash on next login.** `bcryptjs` is retained now and becomes removable only after the rollout completes. This is a **new feature that does not yet exist**; the following gaps were verified rather than assumed:

- `verifyPassword` normalizes PHP `$2y$` to `$2b$` before comparing, so legacy login works.
- **Update (2026-10-09):** the store surface is no longer seven methods — `src/persistence/contract.js` defines 30, `updatePasswordHash` included, and both adapters implement it under contract assertion at boot. Lazy bcrypt→scrypt rehash remains **deliberately deferred**: re-hashing live credentials is a security decision that needs approval, a rollback path and its own tests. It is the only item from this list still open.

## Verified state of the foundation (2026-10-06)

Re-run on Node v22.22.3 in this branch, not carried forward from an earlier claim:

- `npm run check` (`apps/workforce-platform`): **43 passed, 0 failed** at that date. Replaced by the Phase 2 measurement below (85 tests). These use deterministic test stores and do not prove real MySQL behavior.
- `npm run build` (`client/`): Vite transformed **16 modules** to `public/app/`, 231.19 kB JS / **72.20 kB gzip**. Build output is generated and git-ignored.
- Live server on `0.0.0.0:3000`: `/`, `/manifest.webmanifest`, `/service-worker.js`, `/site.js`, `/styles.css`, `/robots.txt` all returned **200**; `/api/v1/health/live` **200**; `/api/v1/health/ready` **503** with `{"status":"not_ready","database":false,"schema":false}` in the absence of MySQL.
- `public/index.html` contains **0** React references, confirming the public site is genuinely Vanilla JS.
- Security headers observed on `/`: full CSP, `x-frame-options: DENY`, `cross-origin-opener-policy: same-origin`, `x-content-type-options: nosniff`, `referrer-policy: no-referrer`, `permissions-policy`, `x-request-id`.
- Path traversal `/../etc/passwd` returned **404**.
- The `/app/*` SPA fallback is content-negotiated by design (`src/app.js:220-222`): requests sending `Accept: text/html` receive the SPA shell (**200** for `/app/deep/link`), while requests without it correctly stay **404** so missing assets are not masked. This is intended behavior, not a defect.
- Runtime production dependencies are exactly `bcryptjs@^3.0.2` and `mysql2@^3.24.5`; every other import in `server.js` and `src/` is `node:*` or local project code.

Still outstanding and unchanged: only 7 API routes are ported (5 auth, 2 health) against 32 PHP controllers; no real MySQL server, production import, cPanel/Passenger host, native SDK build or traffic cutover has been exercised.

---

## Phase 2 — identity, accounts and the platform core (2026-10-09, branch `arena/c204b9d0-ai`)

**This section supersedes the route counts, the dependency story and the "no storage
adapter" gaps above.** Full record: [`PHASE2_IDENTITY.md`](PHASE2_IDENTITY.md); finding
by finding: [`PHASE0_AUDIT_20261008.md`](PHASE0_AUDIT_20261008.md) §10.

- **28 API routes** across identity, accounts, administration, health and the status
  surface — listed by `GET /api/v1/system/routes`, mirrored in `docs/migration/ROUTE_MAP.md`.
- **Storage adapters**: `STORAGE_ADAPTER=mysql|file|auto` behind one 30-method
  repository contract, asserted before the server listens. The file adapter exists so
  the platform runs where no database is reachable; it is refused in production unless
  `ALLOW_FILE_STORE_IN_PRODUCTION=1` is set deliberately.
- **Platform core rebuilt**: 7-verb router with path params and 405/`Allow`, full
  validation with field-level issues, multipart + upload policy with signature sniffing,
  exact-origin CORS, bounded rate limits with per-account lockout, `AppError` taxonomy
  (dependency outage = 503 + `Retry-After`, never 500), request logging, fatal-error
  handlers, static serving that distinguishes document/asset/SPA route.
- **RBAC parity**: migration `003_account_management.sql` plus
  `src/db/platform-baseline.js` seed the legacy 8 roles / 14 permissions including
  `system.super_admin`; a test asserts the SQL and the code agree key for key.
- **Operations**: `verify:install` (21 checks), `verify:data`, `seed:platform`,
  `backup` / `restore` (sha256 manifest, `mysqldump --single-transaction`, password in a
  `0600` defaults file), `migrate:status` / `migrate:dry-run`.
- **Dependencies unchanged**: `mysql2` + `bcryptjs`, nothing else, no `devDependencies`;
  tests are `node:test`. `.env.example` documents all 38 config variables and a check
  keeps it true.

Measured in this sandbox on 2026-10-09: **85** app tests passing, **367** legacy runtime
tests passing, **21/21** install checks, `verify:data` exit 1 on an unseeded store and
exit 0 after `seed:platform`, backup → verify → wipe → restore round trip proven by test.
**Not** exercised: a real MySQL server, production data, a cPanel/Passenger host, any
provider, any native build, any cutover.

Unchanged and still true: the PHP application is the source of truth and the rollback
target; `application-deployment.zip` remains stale and the deployment docs now say so;
F-09/F-10 (PWA/SEO) belong to Phase 3; F-11/F-12 await approval-gated decisions; F-15
cannot be closed without a staging database.


## Current implementation slice — foundation only

`apps/workforce-platform/` now contains:

- **Node.js `>=22.20.0 <25`** and a top-level `server.js` using Node's `http` module. The internal router, bounded JSON parser, static allow-list, security headers, request IDs, request timeouts, generic errors, rate limits and graceful shutdown are implemented with core modules and local project code. Fastify, Express and Fastify plugins are not runtime dependencies of this server.
- **MySQL identity foundation:** the existing bounded `mysql2` pool, checksum-versioned migrations, isolated `wf_*` identity/session/RBAC/audit tables, and dry-run-first one-time identity importer are retained. The importer has **not** been run against production or source user data.
- **Authentication/security slice:** username/email/6-digit-UID login compatible with PHP bcrypt hashes, opaque hashed server-side sessions, host-only `HttpOnly`/`Secure` production cookies, session rotation, session-bound CSRF, audit events and deny-by-default permission checks.
- **Vanilla public site:** semantic HTML/CSS/JavaScript at `/`, with no React hydration or third-party runtime asset calls.
- **React/Vite SPA:** source in `client/`, built and served under `/app/`. It has the initial sign-in/readiness shell; non-authenticated product domains are plainly marked as not yet migrated.
- **PWA shell:** manifest and service worker. Only the public shell and compiled static assets are eligible for caching; `/api/`, uploads and private paths bypass the worker. Offline writes and sensitive-operation queuing are not implemented.
- **Capacitor wrapper:** Android/iOS project configuration and HTTPS API-origin validation. Native sign-in is intentionally disabled: a native token/refresh/revocation contract, API-origin policy and audited Keychain/Android Keystore storage plugin still need design and tests. Native SDK builds, signing and store releases have not been verified.
- **Separate dependency boundary:** the server package has `mysql2` and `bcryptjs` as its production dependencies. React/Vite and Capacitor dependencies live in their own client/native packages and are build-time/native dependencies; they are not loaded by the HTTP server.

This is **not** a production replacement. The Node API currently covers health/readiness and the initial identity/session slice; no business module has been ported and accepted. No production database integration test, real import rehearsal, cPanel/Passenger host test, provider/broker validation or traffic cutover has been performed. The PHP application remains intact as the source of truth and rollback target.

## Migration inputs still to consolidate

- `application/`: PHP/CodeIgniter platform; authoritative and preserved as rollback target.
- `apps/api/` + `apps/web/` + `packages/shared/`: Scout, currently Fastify/TypeScript + Next.js/TypeScript and PostgreSQL/Redis; requires a deliberate MySQL persistence and product/API parity migration.
- `apps/football-predictions/`: independent Express/JavaScript/MySQL app with its own auth, migrations and tests; not yet consolidated or first-run deployment-verified.
- `python-services/mt5-bridge/`: Python/FastAPI and Windows-only MetaTrader dependency; remains an explicit adapter/migration decision until safely replaced and tested.
- `runtime/`: PHP-WASM developer/test runtime; not part of the production Node target.

## Next phases

1. Add real MySQL/MariaDB integration coverage for Node migrations, sessions, the single-use identity-import ledger, uniqueness conflicts, transaction behavior and restore.
2. Finish native authentication architecture (exact allowed API origin, token lifecycle/revocation, secure-storage plugin, CORS/origin/CSRF tests) before enabling native sign-in or signing an app.
3. Port identity/account management, public/SEO flows, audit/notifications and the shared workspace with route and permission parity.
4. Migrate domain modules one at a time using [`UNFINISHED_MODULES.md`](UNFINISHED_MODULES.md), preserving the trading Risk Engine, ordered 15-step Execution Supervisor, kill switch, lottery honesty rules, provider provenance and tenant/user isolation.
5. Consolidate Scout, Football Predictions and the MT5 bridge only after their separate storage/runtime assumptions are mapped and tested.
6. Rehearse the full data import, backup/restore, cPanel limits, deployment package and rollback; obtain explicit approval before any production cutover.

See [`FULL_STACK_ARCHITECTURE_PROPOSAL.md`](FULL_STACK_ARCHITECTURE_PROPOSAL.md) for the target boundaries and [`IDENTITY_IMPORT.md`](IDENTITY_IMPORT.md) for the one-time importer contract and dry-run/apply procedure.

## Test evidence from this implementation turn

- Node HTTP/auth/database-contract suite: **43 passed, 0 failed** (`npm run check:workforce`). These use deterministic test stores; they do not prove real MySQL behavior.
- React/Vite production build: **passed** (`npm run build:workforce-client` and clean nested `npm ci`). Build output under `apps/workforce-platform/public/app/` is generated and ignored.
- Scout contracts: **12 passed**; TypeScript typecheck clean. Football Predictions: **29 passed**. Existing PHP/WASM suite: **367 passed**.
- Capacitor CLI config validation: **passed**; no Android/iOS platform build or signing was run.
- Live local HTTP smoke check: public site, PWA manifest/service worker, SPA deep link and built JS/CSS assets returned **200**; a missing JS asset returned **404**; liveness returned **200** and readiness returned **503** without MySQL.
- Node version in the sandbox: **v22.22.3**. The configured engine range is `>=22.20.0 <25`.
- Earlier root `npm audit` output reported **10 vulnerabilities (9 high, 1 critical)**; that finding has not been rechecked or addressed in this implementation slice.

No real MySQL server, production data migration, live provider, production broker, native SDK, signed app or cPanel host was exercised. The broader repository suites should continue to run in CI; this foundation does not replace their evidence.
