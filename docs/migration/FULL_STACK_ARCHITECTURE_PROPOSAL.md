# Full-stack Node.js platform architecture proposal

**Status:** Draft for review — **proposal only; no server/frontend architecture has been replaced yet.**
**Scope:** the requested single-deployment Node monolith, Vanilla JS public site, React/Vite SPA, PWA, and Capacitor native apps.
**Working branch:** `arena/01a10951-ai` · **Target hosting:** cPanel + MySQL/MariaDB.

## 1. Recommended shape

Build one deployable Node.js application that owns the public site, authenticated SPA API, and existing product modules. Use the Node core HTTP server rather than Express or Fastify. Keep `server.js` as the single listener/bootstrap entry point, but keep route handling, authentication, persistence, and business domains in separate internal modules; “monolith” should describe one product/deployment boundary, not one unmaintainable source file.

```text
Browser / PWA                         Capacitor iOS / Android
  Vanilla public site                   Shared React/Vite SPA
  React/Vite member SPA                Native shell + secure storage
             \                              /
              \------ HTTPS, same API -----/
                            |
                   Node.js >=22.20 <25
                 server.js + node:http
       static files | /api/v1 | short-lived CLI jobs
                            |
        MySQL/MariaDB on the cPanel target (baseline)
        Optional PostgreSQL only if separately required
```

Proposed URL map:

- `/` and public paths: built, semantic HTML/CSS and Vanilla JS for the public website and SEO pages.
- `/app/*`: the React SPA, served as static build output with a safe SPA fallback.
- `/api/v1/*`: versioned JSON endpoints served by the same Node process and origin.
- `/manifest.webmanifest`, `/service-worker.js`, and versioned public assets: PWA install/offline shell.
- Capacitor apps: the same React/Vite build, with an explicit HTTPS API base URL. Native app code must never call `localhost` to reach the server.

The PHP application remains deployable and authoritative while ports, imports, and rollback are tested. This proposal does not authorize production deployment, database changes, or a cutover.

## 2. Dependency boundary — important feasibility limit

“Dependency-free” is achievable for the **HTTP/router/application shell**, but not literally for the complete system under the selected cPanel/MySQL and legacy-account requirements:

| Layer | Proposal | Why |
|---|---|---|
| HTTP listener, routing, static files, input limits, response handling | Node core (`http`, `fs`, `path`, `crypto`) plus internal project code; no Express/Fastify | Meets the no-Express, core-server goal. `server.js` owns listener/startup; internal modules keep it testable. |
| MySQL/MariaDB persistence on cPanel | A maintained MySQL driver is required (the current foundation uses `mysql2`) | Node core does not include a MySQL client. `pg` cannot connect to MySQL. Supporting MySQL while allowing only `pg` is not feasible without writing and maintaining a database wire-protocol client. |
| Existing PHP password hashes | Retain a bcrypt verifier (current foundation uses `bcryptjs`) during migration | Node core crypto does not verify PHP `$2y$` bcrypt hashes. Removing this dependency requires a separately approved forced-password-reset/hash-migration plan; do not silently lock out imported users. |
| Optional PostgreSQL | `pg@8.16.3` only if PostgreSQL is an actual supported deployment target | It is not needed for the selected cPanel/MySQL baseline. If both engines are required, both drivers and database-parity tests are required. |
| React/Vite browser build | React, React DOM and Vite in the frontend/build workspace | These packages are needed to build the requested SPA, but need not be server-side runtime dependencies. The compiled browser assets are served by the monolith. |
| Capacitor | Capacitor CLI/core, platform packages, and any approved native plugins in the native workspace | These are build/native dependencies, not dependencies of the Node HTTP server. Android/iOS SDKs are also required to produce signed apps. |

**Recommended interpretation:** dependency-light Node server with no Express/Fastify, a MySQL driver and bcrypt compatibility as long-lived runtime dependencies, and isolated frontend/native build toolchains. Treat optional PostgreSQL as unresolved and out of the baseline until a host and use case are named. If “only production dependency is `pg@8.16.3`” is mandatory, it conflicts with cPanel/MySQL and legacy bcrypt login; resolve those constraints before implementation.

## 3. Repository impact map

| Existing path | Current role | Proposed disposition |
|---|---|---|
| `apps/workforce-platform/` | Fastify/MySQL modular-monolith foundation, sessions/RBAC, cPanel entry, one-time identity importer | Keep as the target platform. Replace Fastify with a core `http` listener only after this proposal is approved; retain the MySQL data model, security behavior, importer and tests where compatible. |
| `apps/workforce-platform/src/server.js` | Current Fastify server bootstrap | Evolve into the single Node HTTP entry point (`server.js`). Split internal router, static serving, auth, DB adapters, and domain services into modules. No giant all-in-one file. |
| `apps/workforce-platform/public/` (proposed) | Not yet created | Host the compiled public site, `/app` SPA output, manifest, service worker, icons, and static assets; ensure uploads/secrets/source are not web-accessible. |
| `apps/workforce-platform/client/` (proposed) | Not yet created | React/Vite member SPA; source and build dependencies stay separate from the server runtime. Build output is served at `/app`. |
| `apps/workforce-platform/native/` (proposed) | Not yet created | Capacitor wrapper/project configuration referencing the shared SPA build and remote HTTPS API. Keep generated Android/iOS projects out of the server package unless they are committed intentionally. |
| `apps/api/`, `apps/web/`, `packages/shared/` | Scout lead-discovery API (Fastify/TypeScript), Next.js/TypeScript UI, PostgreSQL/Redis | Inventory and port the actual product behavior into the monolith; migrate TypeScript runtime code to JavaScript and replace Next.js with the chosen SPA only after route, auth, organization-ID and persistence parity is mapped. Do not delete these sources during the port. |
| `apps/football-predictions/` | Separate Express/MySQL app with its own auth, migrations and tests | Port its bounded domain/API/UI into the monolith or document a reviewed isolated deployment exception. Preserve its Over-1.5 and admin/CSRF/publication safety contracts. |
| `application/` and `system/` | Production PHP/CodeIgniter application | Keep live and intact as source of truth and rollback target through migration acceptance. |
| `python-services/mt5-bridge/` | Python/FastAPI bridge for Windows MT5 | Keep as a clearly bounded temporary adapter or propose/test a Node replacement; fake-terminal tests do not prove real-terminal readiness. |
| `runtime/` | PHP-WASM development/test harness | Retain for PHP parity tests until the migration has its own accepted test baseline. |
| `docs/migration/UNFINISHED_MODULES.md` | Current Node-port/provider/deployment backlog | Use as the module acceptance checklist; add route-level parity links per module as work begins. |

## 4. Proposed Node server internals

Keep one process and one origin, with small, testable internal modules:

```text
apps/workforce-platform/
  server.js                     # node:http listener, graceful start/stop
  src/
    http/                       # router, request parsing, static allow-list, errors
    security/                   # headers, origin/CSRF, rate limits, session helpers
    auth/                       # session and permission services
    db/                         # pool, migrations, repositories, import tools
    modules/                    # identity, market, strategies, risk, sports, lottery…
    jobs/                       # short-lived idempotent cPanel cron entry points
  public/                       # compiled public site + SPA/PWA assets only
  client/                       # React/Vite source (separate build workspace)
  native/                       # Capacitor wrapper and native project configuration
```

The core listener should enforce bounded request bodies, method/path matching, safe static-path resolution, request timeouts, security headers, generic error responses, request IDs, and graceful shutdown. Implement every boundary with tests before moving route families. Avoid loading/building React or Capacitor on the cPanel server; deploy compiled assets and production server dependencies only.

For browser auth, keep the current opaque, database-backed session model: host-only `HttpOnly`, `Secure`, `SameSite` cookies in production, session rotation, CSRF tokens on cookie-authenticated mutations, deny-by-default RBAC, and audit events. For Capacitor, design an explicit native token transport and revocation/refresh policy; store secrets only in Keychain/Android Keystore via an approved native secure-storage plugin, never `localStorage`. Authenticated API responses must not be cached by the service worker.

## 5. Frontend, PWA and native-app boundaries

### Public website (Vanilla JS)

- Build public pages as plain HTML/CSS/JavaScript, served without React hydration.
- Preserve SEO titles/metadata, robots/sitemap policy, public help/contact flows and safe public chat behavior from the PHP app.
- Keep public assets cacheable by version; keep private account/workspace paths out of public caches and crawlers.

### Member SPA (React + Vite)

- Use a separate Vite build whose static output is served under `/app/`; the API remains same-origin on web/cPanel.
- Port dashboard/navigation, account/admin surfaces and each business module from the backlog only when its API, permission and parity tests are ready.
- Frontend dependencies are build-time/browser dependencies, not Node server runtime dependencies. CI produces the deployable static bundle.

### PWA

- Add a manifest, icons, install metadata and a small service worker.
- Cache only the application shell and explicitly public, versioned static assets. Do not cache session endpoints, private business data, credentials, or trading state.
- Offline mode is read-only shell/clear offline status at first. Do not queue trades, lottery mutations, approvals or other sensitive writes while offline.

### Capacitor native apps

- Reuse the React SPA as Capacitor `webDir`; avoid a second business-logic implementation.
- Configure the production API as a real HTTPS origin at build/release time, never `localhost` or `127.0.0.1`.
- Add secure native token storage and deep-link rules before account screens; isolate native-only code behind a small bridge.
- Treat notifications, biometrics, camera/files, and other native plugins as separately reviewed features. Push needs authorized APNs/FCM setup and is not implied by installing Capacitor.
- Build/sign Android and iOS in CI or platform toolchains; iOS signing requires Apple tooling unavailable on ordinary cPanel.

## 6. Database and migration direction

The chosen baseline is cPanel + MySQL/MariaDB. Keep the Node `wf_*` schema and migration ledger; the current identity import is a one-shot snapshot import, not a full-business-data migration. Before using it, test migrations and all transaction/locking/JSON/collation behavior on a real supported MySQL/MariaDB version. Never run it against production without a reviewed backup, a clean target, explicit approval, and a successful rehearsal.

Scout currently depends on PostgreSQL and Redis; port its persistence semantics to MySQL/MariaDB only after mapping uniqueness, transactions, JSON, organization isolation and refresh-token behavior. Redis is not part of the baseline cPanel design. If PostgreSQL is still needed as an optional target, isolate DB repositories and add a second tested adapter; do not claim that `pg` alone makes the MySQL deployment dependency-free.

No live provider, broker, SMTP, or data import may be represented as ready merely because an API boundary or UI exists. Keep the provider/readiness gates in `UNFINISHED_MODULES.md`.

## 7. Migration sequence and acceptance gates

1. **Architecture review:** approve the dependency boundary, whether `pg` is truly needed, legacy bcrypt treatment, route layout, native auth strategy, and whether Football Predictions remains a module or isolated app.
2. **Core HTTP proof:** implement a throwaway/testable Node-core router and static allow-list on a working branch slice; port health, readiness and the existing auth/security contract. Run negative tests for CSRF, origin, session rotation, path traversal, body limits, headers and RBAC before routing live traffic.
3. **Public site + SPA shell:** add the Vanilla public site and a minimal React/Vite authenticated shell; verify same-origin API and build output on cPanel staging.
4. **PWA + Capacitor shell:** add static-only service worker behavior, native API configuration, secure token storage and deep-link tests. Prove Android/iOS packaging separately from cPanel hosting.
5. **Module parity:** migrate one module at a time using `UNFINISHED_MODULES.md`, preserving the Risk Engine, ordered Execution Supervisor gates, Lottery assertions, Portfolio API auth (`trading.view`), data ownership and provider honesty.
6. **Data/release acceptance:** finish full route/schema/data mapping, MySQL import rehearsal and reconciliation, backup/restore and rollback, cPanel resource/security checks, PWA/native release checks and an agreed stability period. Keep PHP until the owner approves cutover.

## 8. Review decisions still open

- Is PostgreSQL (`pg@8.16.3`) required in addition to the selected cPanel/MySQL baseline, or should it be removed from the baseline proposal?
- For legacy PHP bcrypt passwords, keep the small `bcryptjs` runtime dependency or explicitly require users to reset passwords before Node login?
- Is a separate native token/refresh flow acceptable, with secure-storage plugin dependencies, or must native clients use the same browser-cookie flow?
- Should Football Predictions be merged into this monolith, or remain an isolated Node app during the first release?
- Confirm the actual cPanel provider offers Node `>=22.20.0 <25`, MySQL/MariaDB version, Passenger, HTTPS, cron, outbound network access, and app resource limits.

Until these are reviewed, treat the existing Fastify foundation and current master plan as the implementation baseline; this document is a proposal, not authorization to rewrite the server.
