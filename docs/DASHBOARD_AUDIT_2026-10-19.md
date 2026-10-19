# Repository-wide dashboard audit — 2026-10-19

## Status

A broad source, route, contract, regression-test, production-build, and HTTP-rendering audit was completed across the repository's main web dashboards and supporting mobile shell. **This is not a completed end-to-end acceptance sign-off:** real database/provider integration and interactive desktop/mobile browser testing remain blocked by this environment. No production or staging deployment was performed.

The checkout is on `arena/fe0dc4ba-ai`. No mock business records or fake provider responses were introduced into application code.

## Applications covered

| Surface | Verification completed | Result and boundary |
|---|---|---|
| Scout / standalone Lead Discovery (`apps/web`, `apps/api`) | Root and web TypeScript checks; 21 shared/API/web contract tests; optimized Next production build (17 routes); standalone HTTP smoke test for 12 routes and a JavaScript asset using a preview-style Host header | All listed routes/assets returned HTTP 200. Auth refresh, logout, organization-scoped member lookup, admin user authorization, and role-change rules were exercised by tests (with test DB/Redis adapters). The preview's `/api/v1/auth/me` returned HTTP 500 because the API is not running. Interactive auth, database/provider data operations, and browser behavior are not verified. |
| Football Predictions public/admin UI and API (`apps/football-predictions`) | `node --check` on both browser scripts; `npm test` | **35/35 tests passed**, including six new client-script regressions for history error/retry, duplicate pagination requests, administrator-only sign-in, bootstrap error visibility/retry, non-admin denial, and generation-polling failures. These are script-level tests, not a real browser session. MySQL-backed live auth and provider synchronization remain unverified. |
| Workforce Platform dashboard/client (`apps/workforce-platform`) | Full test suite; production Vite build; dependency audit | **1,397/1,397 tests passed** and client build succeeded. Vite reports a 675.27 kB minified JS chunk (175.04 kB gzip), above its 500 kB advisory threshold. There was no interactive browser/device verification or staging database. |
| Legacy AEGIS dashboard/PHP application (`runtime`) | `node runtime/run-tests.mjs` (PHP-WASM/SQLite harness) | **367/367 tests passed**; installer verified 65 tables in the test SQLite environment. Native PHP, production MySQL, and browser-based dashboard flows were unavailable. |
| Workforce Capacitor native shell (`apps/workforce-platform/native`) | `cap config`; native build guard; dependency audit | Capacitor configuration loads. The native web build correctly refuses to proceed without a configured absolute HTTPS `VITE_API_BASE_URL`. Native sign-in remains intentionally disabled pending a secure token/refresh/revocation contract and keystore-backed storage. No Android/iOS SDK build or device test was possible. |
| MT5 bridge service | `pytest` bridge tests | **9/9 passed**. No live terminal/broker connection was available. |

### Commands/results

- `npm run typecheck` — passed.
- `npm run test:contracts` — **21/21 passed**.
- `npm run typecheck --workspace=@lead-discovery/web` — passed.
- `npm run build --workspace=@lead-discovery/web` — passed; 17 routes generated.
- Standalone preview smoke: `/`, `/login`, `/admin/login`, `/account`, `/app/leads`, `/app/lead-pipeline`, `/collections`, `/intelligence`, `/admin`, `/manifest.webmanifest`, `/robots.txt`, `/sitemap.xml`, and a built JavaScript asset — HTTP 200. `/api/v1/auth/me` — HTTP 500 because no API process/database configuration is available.
- `node --check public/js/app.js && node --check public/js/admin.js && npm test` in `apps/football-predictions` — syntax checks passed; **35 tests passed**.
- `npm test --workspace=@windels/workforce-platform` — **1,397 passed, 0 failed**.
- `npm run build:workforce-client` — passed, with the chunk-size warning above.
- `node runtime/run-tests.mjs` — **367 passed, 0 failed**.
- `python-services/mt5-bridge/.venv/bin/python -m pytest -q python-services/mt5-bridge/test_bridge.py` — **9 passed**.
- `npm audit --omit=dev` — **0 production dependency vulnerabilities** in the root workspace after dependency updates.

## Fixes applied

### Scout / Lead Discovery

- Centralized authenticated fetch behavior with single-flight refresh/retry, refreshed-token persistence, local-session cleanup on rejected refresh, and preserved server/API error details.
- Routed admin API calls through that shared auth path; surfaced logout/session-revocation errors rather than silently hiding them.
- Corrected admin/member login destinations and rejected non-admin access to the admin login flow.
- Added validation, duplicate-submit guards, retry/loading/error states, explicit read-only permission states, refresh controls, and clearer organization-managed account copy across Scout workspaces.
- Added an organization-scoped member roster endpoint for lead-owner assignment; it returns only the display fields needed by the picker, not email addresses.
- Prevented an administrator from demoting their own administrator role and prevented changing an organization owner's role at the API boundary; tested that another administrator's role can still be changed.
- Fixed collection-detail loading feedback and prevented overlapping collection opens from presenting an empty state as if it were real data.
- Updated the homepage to distinguish illustrative content from live authenticated actions and corrected route labels/targets.
- Upgraded Next.js to 16.4.2 and patched the production `source-map-js`/PostCSS dependency paths.

### Football Predictions

- Preserved API error codes/messages/status details in public and admin clients, including invalid-response errors.
- Made history loading retryable, prevented overlapping pagination requests, and removed stale inline error notices after a successful retry.
- Kept administrator-only sign-in role-aware and made admin bootstrap distinguish authorization denial from service/connection errors, with a retry action.
- Surfaced generation-polling errors and avoided rerendering a tab after the administrator has navigated away.

## Security/dependency audit

- Root production dependency audit: **0 vulnerabilities** after upgrading Fastify to 5.12.7 and updating affected `fast-jwt`/`fast-uri` transitive versions. Root TypeScript and contract tests passed after that update.
- The full root npm audit still reports **7 development-only advisories (5 high, 2 moderate)** in Tailwind CSS 3's legacy `chokidar`/`micromatch`/`braces`/`postcss-nested`/`postcss-selector-parser` dependency tree. npm's suggested forced fix moves Tailwind to v4, a breaking build/design change; it was not applied without a migration and visual regression plan.
- Capacitor's separate native lockfile reports **3 moderate development-tool advisories** through `@capacitor/cli` → `xcode` → `uuid`; the native production dependency audit reports zero. No forced downgrade/override was applied.
- The Workforce client dependency audit reports zero vulnerabilities.

## Remaining verification blockers

1. **Live Scout integration:** this workspace has no `DATABASE_URL`, `REDIS_URL`, `LEAD_JWT_SECRET`, provider key, or running API/database services; Docker is unavailable. The UI preview is available, but authenticated requests cannot succeed until staging services/configuration are supplied.
2. **Desktop/mobile interaction:** no browser binary or Playwright/Puppeteer installation is available. Production HTML/routes and bundles were smoke-tested, but no real click-through, keyboard/accessibility session, viewport resizing, mobile browser, or native-device run was performed. Do not treat route HTTP 200 as proof that a control works.
3. **Football live behavior:** MySQL credentials and live provider configuration are absent. Test adapters cover route/security logic; live login, CSRF/session flow, provider synchronization, result settlement, and admin actions need staging verification.
4. **AEGIS PHP production parity:** native PHP and production MySQL are not installed/configured here; the 367 tests use the PHP-WASM/SQLite harness.
5. **Native mobile release:** no Android/iOS SDK build or device run; secure native authentication is intentionally not implemented yet. A real HTTPS API origin and accepted auth/key-storage contract are prerequisites.
6. **Staging gate:** no staging verification was possible, so nothing has been deployed. Production deployment must remain blocked until the remaining integration and browser/device checks pass.
