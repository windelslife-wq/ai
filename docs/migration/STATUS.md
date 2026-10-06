# JavaScript / Node.js / cPanel migration status

**Updated:** 2026-10-06 · **Branch:** `arena/01a10add-ai`

## Decision and safety boundary

The migration is the whole WINDELS AI WORKFORCE platform, not just the PHP front end. Proceed side-by-side, module by module, with MySQL/MariaDB, Passenger-compatible Node.js, parity/security evidence, and rollback. Keep PHP authoritative until the complete replacement is explicitly accepted. Never enable live trading, alter production data, deploy, or cut over traffic without approval.

The implementation slice now follows the requested Node-core HTTP + Vanilla public site + React/Vite SPA + PWA + Capacitor-shell shape. The user selected MySQL/MariaDB as the database target. Therefore `mysql2` remains necessary and `pg@8.16.3` is not installed: `pg` cannot connect to MySQL. The legacy PHP bcrypt verifier also remains until an explicitly approved password-reset or hash-migration decision.

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
