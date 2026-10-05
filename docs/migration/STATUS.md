# JavaScript / Node.js / cPanel migration status

**Updated:** 2026-10-05 · **Branch:** `arena/01a10951-ai`

## Decision and safety boundary

The migration is the whole WINDELS AI WORKFORCE platform, not just the PHP front end. Proceed side-by-side, module by module, with MySQL/MariaDB, Passenger-compatible Node.js, parity/security evidence, and rollback. Keep PHP authoritative until the complete replacement is explicitly accepted. Never enable live trading, alter production data, deploy, or cut over traffic without approval.

## Current implementation slice — Node foundation only

`apps/workforce-platform/` is a new JavaScript ES-module Fastify 5 modular-monolith foundation. It currently implements:

- Environment validation and a bounded MySQL connection pool.
- Checksum-versioned schema migrations and isolated `wf_*` identity/session/RBAC/audit tables. A dry-run-first, single-use legacy identity importer now validates bcrypt hashes, identity uniqueness and RBAC relations, records an import ledger, and fails closed on target conflicts; **it has not been run against real data**.
- cPanel Passenger startup entry, health/readiness endpoints, safe error handling, request IDs, security headers, request validation, and per-process rate limits.
- Username/email/6-digit-UID login verification compatible with PHP bcrypt hashes, opaque hashed server-side session identifiers, HttpOnly/Secure host-only production cookies, session-bound CSRF, audit events, and deny-by-default permission checks.
- cPanel staging, environment, cron, Apache, health-check, and rollback documentation under `deploy/cpanel/`.

This slice is **not** a production replacement. No Node UI or migrated business module is accepted; accounts and permissions are not imported; there is no production MySQL integration test or actual cPanel/Passenger host verification. The root route explicitly reports `productionReplacement: false`. Do not point live traffic at it.

## Proposed full-stack architecture — pending review

The user requested a single-deployment Node platform with a core `http` server, Vanilla JS public site, React/Vite SPA, PWA, and Capacitor apps. They selected cPanel/MySQL, a dependency-free server layer (frontend/native build tools separate), `server.js` as the entry point with internal modules, and **architecture drafting before implementation**. See [`FULL_STACK_ARCHITECTURE_PROPOSAL.md`](FULL_STACK_ARCHITECTURE_PROPOSAL.md). No architecture code has been changed. The MySQL driver and legacy bcrypt verifier remain practical server runtime dependencies; optional `pg@8.16.3` is not a MySQL driver and remains an open decision.

## Migration inputs still to consolidate

- `application/`: PHP/CodeIgniter platform, still the rollback target.
- `apps/api/` + `apps/web/` + `packages/shared/`: Scout, currently Fastify/TypeScript + Next.js/TypeScript and PostgreSQL/Redis; planned target requires a deliberate MySQL persistence migration and JavaScript-runtime decision.
- `apps/football-predictions/`: independent Express/JavaScript/MySQL app with its own schema and cPanel notes; not yet consolidated or first-run deployment-verified.
- `python-services/mt5-bridge/`: Python/FastAPI and Windows-only MetaTrader dependency; remains a separate migration dependency until a safe Node replacement/adapter is designed and tested.
- `runtime/`: PHP-WASM developer/test runtime, not a production Node target.

## Next phases

1. Use [`UNFINISHED_MODULES.md`](UNFINISHED_MODULES.md) as the migration backlog and refresh the complete route/schema/dependency inventory for the current tree.
2. Add real MySQL/MariaDB integration coverage for both migrations, the single-use identity import ledger, uniqueness conflicts, and restore behavior; the importer is unit-tested only and has not run against source data.
3. Validate the minimal Passenger deployment and clean production packaging on a real or faithful cPanel host.
4. Accept identity/shared-platform parity after a reviewed import rehearsal, then migrate each business module one at a time using `docs/migration/NODEJS_CPANEL_MIGRATION_MASTER_PLAN.md` gates.
5. Consolidate Scout, Football Predictions, and the MT5 bridge only after their distinct persistence/provider/runtime constraints are mapped.
6. Rehearse full data import, rollback, cPanel resource limits, and cutover; decommission PHP only with separate approval.

See [`IDENTITY_IMPORT.md`](IDENTITY_IMPORT.md) for the one-time importer contract and dry-run/apply procedure.

## Test evidence from this implementation turn

- Node foundation + identity-import planning/adapters: **35 passed, 0 failed** (`npm run check --workspace=@windels/workforce-platform`).
- Scout contracts: **12 passed, 0 failed** (`npm run test:contracts`).
- Scout/shared TypeScript typecheck: **clean** (`npm run typecheck`).
- Football Predictions: **29 passed, 0 failed** (`npm test --workspace=windels-football-predictions`).
- Existing PHP/WASM suite: **367 passed, 0 failed** (`npm --prefix runtime test`).
- MT5 bridge fake-terminal contract suite: **9 passed** (`pytest python-services/mt5-bridge/test_bridge.py -q`, Python 3.11 venv); one upstream Starlette/httpx deprecation warning.
- Root lockfile: regenerated; both full `npm ci` and the workspace-only production install completed successfully.

No MySQL server, production data migration, real provider, production broker, or cPanel host was exercised in these tests.
