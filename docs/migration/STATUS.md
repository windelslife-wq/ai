# JavaScript / Node.js / cPanel migration status

**Updated:** 2026-10-09 · **Branch:** `arena/774d9e70-ai`

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
F-11/F-12 await approval-gated decisions; F-15 cannot be closed without a staging
database. F-09/F-10 (PWA/SEO) were deferred to Phase 3 and are closed there — see the
next section.

---

## Phase 3 — public site, SEO/PWA shell and contact intake (2026-10-09, branch `arena/774d9e70-ai`)

**This section supersedes the route counts, the public-site description and the PWA
description above.** Full record: [`PHASE3_PUBLIC_SITE.md`](PHASE3_PUBLIC_SITE.md).

- **30 API routes** (28 from Phase 2 plus `POST /api/v1/site/contact` and
  `GET /api/v1/admin/inquiries`) and **22 rendered document routes** — 8 marketing pages,
  9 legacy aliases/redirects, `robots.txt`, `sitemap.xml`, `manifest.webmanifest`,
  `service-worker.js`, and `POST /contact/submit`. The two ledgers are asserted disjoint.
- **F-10 closed**: every legacy `Site`/`Seo` route is answered, page copy is compared
  heading-for-heading against `application/views/site/*.php`, metadata comes from one
  validated `SITE_*` surface, robots keeps all six legacy disallow rules (plus three
  Node-only private prefixes), and the sitemap refuses to publish relative URLs.
- **F-09 closed**: a real PNG icon set (192, 512, maskable-512, apple-touch-180) rendered
  by `tools/generate-icons.mjs` and proven byte-reproducible; a service worker whose cache
  name is derived from the shell's content hash; hashed build assets cache-first, unhashed
  shell never cache-first; `/api/`, uploads, private and data paths never cached; and a
  waiting-worker **Reload / Not now** prompt in both the vanilla site and the SPA.
- **Generated documents replaced static files**: `public/index.html`, `public/robots.txt`,
  `public/sitemap.xml`, `public/manifest.webmanifest` and `public/service-worker.js` are
  deleted from the tree and rendered per request; `verify:install` fails if any returns.
- **Contact intake**: `wf_contact_inquiries` (migration `004_public_site.sql`, additive),
  a 26-character ULID receipt reference, an HMAC-SHA256 client fingerprint instead of a raw
  IP, the `CONTACT_INQUIRY` audit entry, a per-address throttle (3/hour default), a signed
  one-shot `wf_flash` cookie for the no-script path, and `mail.sent:false` in every response
  because no outbound transport exists. Repository contract: **32** methods.
- **SPA slice**: typed `ApiError` client, an exact-path history router, permission-gated
  navigation, loading/empty/error/offline states, and register / account / admin-users /
  contact-inbox / platform-status views — so the `/login` and `/register` redirects land on
  real surfaces. Client build green: 20 modules, 265.27 kB JS (79.47 kB gzip).
- **Deliberate divergences** are recorded in `PHASE3_PUBLIC_SITE.md` §5, including the two
  that keep `publicSite` at `partial`: the legacy public chat widget is not ported, and the
  legacy announcement-bar default copy (which advertises the unported AI Language Teacher)
  is not reproduced.

Measured in this sandbox on 2026-10-09: **103** app tests passing (18 new in
`test/site.test.js`, which reads the legacy PHP as its oracle), **30/30** install checks,
**4/4** icon checks, **367** legacy runtime tests, **12** Scout contract tests, **29**
football-prediction tests — **511** passed, 0 failed — plus a live `curl` rehearsal of every
document route, both contact paths, the admin listing and its 401/403 boundaries on the file
adapter. **Not** exercised: a real MySQL server (migration 004 has never been applied by one),
a cPanel/Passenger host, a real browser (no Lighthouse or install-prompt observation),
outbound mail, any provider, any native build, any cutover.


## Phase 4 — market data and provider health (2026-10-09, branch `arena/774d9e70-ai`)

**This section supersedes the route count and the market-data status above.** Full record:
[`PHASE4_MARKET_DATA.md`](PHASE4_MARKET_DATA.md). App version is now **0.5.0**.

- **33 API routes** (the 30 from Phase 3 plus `GET /api/v1/market-data/candles`,
  `/quote` and `/providers`); the 22 rendered document routes are unchanged. All three new
  routes require a session and no permission, matching `Api_marketdata` — none of them is in
  the legacy `Api_controller::PUBLIC_ACTIONS` list.
- **The provider chain is ported**: priority ordering (Binance 10 → Frankfurter/ECB 20 →
  licensed stock/ETF/futures/options 30–33 → synthetic 999), capability and market-class
  filtering, timeframe-capable-first ordering, circuit breakers (5 failures / 60 s window /
  30 s cooldown, a failed probe re-opens), bounded TTL caches, retries with
  `min(1000, 300×2^attempt)` ms backoff, `DEGRADED` health promotion, provenance
  (`source`, `synthetic`, `live`, `delayed`, `dataAgeMs`, `stale`, `fallbackChain`) and
  candle validation (`ok`, `droppedCount`, `gapCount`, issues).
- **Honesty rules are enforced, not documented**: synthetic output is always labelled and
  registered last; `MARKET_DATA_ALLOW_SYNTHETIC=0` refuses it outright with
  `503 SYNTHETIC_DATA_DISABLED` and no candle array; a provider returning an error envelope,
  a zero/inverted bid-ask, fewer than 30 valid candles or invalid OHLCV **fails** instead of
  being repaired into a chart; ECB reference rates serve `1d` only with a real `volume: 0.0`;
  every fallback writes the audited `PROVIDER_FALLBACK` event; the four licensed adapters stay
  `DISABLED`/`NOT_CONFIGURED` and cannot be selected while inert.
- **Two hardenings over the legacy manager**, both recorded as divergences: a per-request
  deadline (`MARKET_DATA_DEADLINE_MS`, 15 s default; health probes 5 s) and bounded in-process
  caches (500 entries) — the legacy version had neither, and a Node process is long-lived.
- **Public status surface stays cheap**: `/api/v1/system/status` reports the registry, the
  synthetic policy and cached provider health, but **never probes** an external host, so an
  unauthenticated caller cannot make the server fan out to third parties.
- **No new dependency, no new table, no migration.** `fetch`/`AbortSignal` are platform
  built-ins; the module persists only the fallback audit event; migrations stay at 001–004.
  Eight new environment variables are documented in `.env.example` (53 total).

Measured in this sandbox on 2026-10-09: **140** app tests passing (37 new in
`test/market_data.test.js`, which ports the eleven `tests/cases/02-providers.php` cases 1:1
and makes no outbound network call), **30/30** install checks, **367** legacy PHP/WASM oracle
tests — the eleven provider cases passing on **both** sides of the migration — **12** Scout
contract tests, **29** football-prediction tests and a clean `npm run typecheck`: **548
passed, 0 failed**, plus a live `curl` rehearsal of all three endpoints, their 401/400
boundaries, the provider-health registry and the audit trail on the file adapter. CI caught
one network-dependent test that this sandbox could not (no egress): with real providers
reachable, the synthetic-refusal endpoint answers 200 rather than 503. It is fixed and
recorded as defect **D-6** in `PHASE4_MARKET_DATA.md` §6, and the suite is now asserted green
under both network conditions.
**Not** exercised: a live upstream provider (this sandbox has no egress to Binance or
Frankfurter — both reported `DOWN` and the chain fell back to labelled synthetic data, which
is the correct honest behaviour), a licensed feed of any kind, a value-for-value diff of PHP
versus Node numeric output (new finding **F-26**), a real MySQL server, a market-data user
interface, or any cutover.

## Phase 5 — analysis engines, agents, consensus and the risk veto gate (2026-10-09, branch `arena/774d9e70-ai`)

**This section supersedes the route count, the module counts and the analysis/risk status above.** Full
record: [`PHASE5_ANALYSIS.md`](PHASE5_ANALYSIS.md). App version is now **0.6.1** — `0.6.0` was Phase 5 as
delivered, and the patch release is the hardening pass below, which added no route, no module and no
dependency.

- **38 API routes** (the 33 from Phase 4 plus `POST /api/v1/analysis/run`, `GET /api/v1/analysis/history`,
  `GET /api/v1/analysis/agents`, `POST /api/v1/analysis/consensus` and `GET /api/v1/analysis/:runId`); the
  22 rendered document routes are unchanged. All five require a session and **no permission**, matching
  `Api_analysis` — none is in the legacy `Api_controller::PUBLIC_ACTIONS` list. The two mutations also
  require the session CSRF token; this is the first ported module with an authenticated unsafe method.
- **The analysis pipeline is ported**: 300 candles per symbol, `detectRegime` with all seven legacy labels,
  a seven-agent panel (technical, market structure, forex, crypto, sentiment, fundamentals, trading
  intelligence) with the legacy weights (1.0 / 0.9 / 0.9 / 0.9 / 0.5) and the ±0.15 vote threshold,
  weighted consensus with agreement, conflicts, confluence and the two hard gates, a four-round
  adversarial debate whose transcript is persisted, setup generation with 1.5/2.5/3.5 R targets, three
  scenarios per run, and `RiskEngine::evaluate` as the veto gate. Forex and commodity runs also fetch the
  seven legacy reference legs (60 candles each) for currency strength.
- **Nothing can be approved on this platform.** `DEFAULT_TRADING_STATE` is frozen with the kill switch
  **engaged** and `tradingMode: ANALYSIS_ONLY`, and no ported code path releases it — the kill-switch
  control surface, the portfolio monitor and the limits API are still legacy-only, which is why
  `/api/v1/system/features` reports `risk` as **`partial`**, not `ported`. Every run carries
  `riskContext.note` stating that the portfolio gates are evaluated against an empty portfolio.
- **Honesty rules are enforced, not documented**: the synthetic label is carried from market data into the
  run payload, the persisted row (as a column), the audit details and the risk veto; freshness is graded
  (live 1.0 / synthetic 0.5 / stale 0.2) and stale data is sustained as a **critical** objection that
  forces `NO_TRADE` and drops the proposal; sentiment and fundamentals abstain through a *computed*
  validator (`votes: false`, excluded from the panel) and vote when a licensed feed is injected; price is
  never relabelled as sentiment, fundamentals or on-chain data; a wick beyond a swing never confirms a
  break of structure; and the debate can only reduce confidence.
- **One table, one migration, and no *engine* configuration.** `wf_analysis_runs` (migration `005`) stores
  the summary columns, `synthetic`/`source` promoted out of the payload so a query can find every run built
  on labelled synthetic data, and the full run as the audit copy. The repository contract grows
  **32 → 35** methods as delivered, then **35 → 36** with the hardening pass (`pruneAnalysisRuns`). The
  engine adds **no environment variable** — agent weights, thresholds and risk limits stay code constants,
  because they are safety parameters, not deployment knobs — but the hardening pass added **six operational
  ones** (R-26 limits, R-27 retention), so `.env.example` goes **53 → 59**. See the hardening subsection
  below, which supersedes both figures here.
- **Six defects found and closed while porting** (`PHASE5_ANALYSIS.md` §6), including a JS
  operator-precedence bug in the open-risk reduction, body schemas written in the query dialect (which made
  the run route answer `400` *before* authentication), the engine's injectable clock not reaching the feed
  agents' freshness check, a hard store requirement that broke the documented store-less boot, and a
  position-based audit assertion that was a latent flake in the test itself.

Measured in this sandbox on 2026-10-09: **257** app tests passing (**+117** for Phase 5 and its hardening
pass, across `test/analysis.test.js`, `test/analysis_http.test.js` and the new `test/retention.test.js`,
which port **36 of the 38** legacy cases in `01-indicators`, `03-agents`, `04-risk-engine`,
`34-agent-debate` and `08-engine-journal` — the two it does not are the backtester and journal-analytics
cases, which belong to unported modules), **30/30** install checks, **367** legacy PHP/WASM oracle tests,
**12** Scout contract tests, **29** football-prediction tests and a clean `npm run typecheck`:
**665 passed, 0 failed** (`node:test` cases; 257 + 367 + 12 + 29). The suite is hermetic — **257/257 with
and without** a whole-suite egress interceptor, which reports *"no outbound requests attempted"* for all 16
files. As delivered, before the hardening pass in §13 of `PHASE5_ANALYSIS.md`, these figures were 235 app
tests and 643 total. No client *source* changed, but the rebuilt bundle hash moved
(`index-Ci3bygYZ.js` → `index-DSbqgd7N.js`, 78 bytes smaller) purely because dependencies were re-installed
without a lockfile — the build is deterministic for a given `node_modules`, just not reproducible from the
repository alone. That is **F-12/R-04** observed in the wild, and it is recorded in
`PHASE5_ANALYSIS.md` §9.1 rather than papered over as "unchanged".
**Not** exercised: any live upstream data (no egress; every run here is labelled synthetic or comes from an
injected double), a value-for-value PHP↔Node numeric diff (**F-26**, still a cutover prerequisite), real
MySQL, the risk engine's approve path over HTTP (unit-tested only, unreachable by design), any portfolio
state, an analysis user interface, or any cutover.

### Phase 5 hardening pass (0.6.0 → 0.6.1) — F-27, R-26 and R-27 closed

Phase 5 opened three findings about itself, and the instruction was to close all three **before** porting
another module. It added no route, no module and no dependency: **+2 056 / −139 lines across 27 files**
(git-measured; code 18 files, docs 9). Every one of its five commits was verified green on its own tree
state in a separate worktree — **235 → 242 → 256 → 257 → 257** — so the branch stays bisectable.

* **F-27 closed in Node, recorded as divergence DV-10.** The legacy risk engine approves a proposal when
  equity is `0`, because every portfolio gate sits behind `equity > 0` and the notional and leverage checks
  then clear trivially. The Node engine now vetoes zero, negative and non-finite equity before sizing, and
  the test that pinned the legacy approval was **inverted** rather than deleted — it now covers all three
  cases plus a positive-equity control that must not trip the veto. **The legacy PHP is untouched**, so the
  oracle is still 367/367 and the two engines disagree on purpose until cutover; no legacy case exercises
  it (`04-risk-engine` uses equity 100 and 10 000), so the 36-of-38 parity is unchanged.
* **R-26 closed.** Per-route window limits on both POST routes (12 runs / 4 scans per 10 minutes per
  address, charged *before* validation so a malformed body still costs budget) plus a per-session
  in-flight cap (`createAnalysisRunGate`, default 2, `0` disables, released in `finally`). Keyed by
  **session**, not address, so a shared office NAT cannot let one colleague's scan starve another's.
  `429 TOO_MANY_CONCURRENT_ANALYSES` is deliberately distinct from `RATE_LIMITED`, because the remedy
  differs. Worst case per window: **≤ 416** upstream series instead of 120 requests/min × 80 calls.
* **R-27 closed.** `ANALYSIS_RETENTION_DAYS` (default 90, `0` keeps forever) plus
  `tools/prune-analysis-runs.mjs` / `npm run prune:analysis`, backed by `pruneAnalysisRuns` on both
  adapters — repository contract **35 → 36**. Dry run is the default and reports the matching count, the
  oldest and newest affected timestamps and the reclaimable bytes before deleting anything; MySQL deletes
  in clamped, `ORDER BY`-deterministic batches for a shared host. **No HTTP route can delete analysis
  history**, pinned by a test.
* **F-28 found and fixed on the way (🟠).** Implementing retention meant an operator had to be able to
  prove row counts around a prune, which exposed `tools/backup.mjs`: its MySQL counts came from a
  hardcoded list that omitted `wf_contact_inquiries`, `wf_data_imports` and `wf_analysis_runs`, and counted
  **`wf_user_files` — a table nothing in this repository creates** (avatars live in
  `wf_user_profiles.profile_image`). On MySQL that made `npm run backup` **fail outright** with
  `ER_NO_SUCH_TABLE`. No test caught it, because the backup suite drives the file adapter only. The list is
  now derived from `src/db/migrations/*.sql`, so the drift is impossible by construction.
* Six new env vars (`.env.example` **53 → 59**), all operational; the engine's safety parameters remain
  code constants. `verify:install` still **30/30**.

Full detail, including what the pass deliberately did **not** do (no PHP diff, no real MySQL, no cron
entry on any host, no load test — this sandbox has no egress, so any throughput figure would have been
invented): `PHASE5_ANALYSIS.md` §13.

## Current implementation slice — foundation only

`apps/workforce-platform/` now contains:

- **Node.js `>=22.20.0 <25`** and a top-level `server.js` using Node's `http` module. The internal router, bounded JSON parser, static allow-list, security headers, request IDs, request timeouts, generic errors, rate limits and graceful shutdown are implemented with core modules and local project code. Fastify, Express and Fastify plugins are not runtime dependencies of this server.
- **MySQL identity foundation:** the existing bounded `mysql2` pool, checksum-versioned migrations, isolated `wf_*` identity/session/RBAC/audit tables, and dry-run-first one-time identity importer are retained. The importer has **not** been run against production or source user data.
- **Authentication/security slice:** username/email/6-digit-UID login compatible with PHP bcrypt hashes, opaque hashed server-side sessions, host-only `HttpOnly`/`Secure` production cookies, session rotation, session-bound CSRF, audit events and deny-by-default permission checks.
- **Vanilla public site:** 8 semantic server-rendered pages plus `robots.txt`, `sitemap.xml`, `manifest.webmanifest` and `service-worker.js`, all generated per request from validated `SITE_*` config — no React hydration, no third-party runtime asset calls, no inline script or style, and no committed static copy of any generated document.
- **React/Vite SPA:** source in `client/`, built and served under `/app/`. Sign-in, registration, workspace overview, account management, admin user directory, the contact inbox and the platform-status view, behind an exact-path router with permission-gated navigation and loading/empty/error/offline states; non-ported product domains are plainly marked as not yet migrated.
- **PWA shell:** generated manifest with a real PNG icon set (including a maskable 512) and a generated service worker whose cache name is derived from the shell's content hash. Hashed build assets are cache-first, the unhashed shell is not, and `/api/`, `/uploads/`, `/private/`, `/data/`, the worker itself and the contact form bypass caching entirely. Update flow offers Reload / Not now instead of swapping silently. Offline writes and sensitive-operation queuing are not implemented; no real browser has been used to observe an install prompt.
- **Capacitor wrapper:** Android/iOS project configuration and HTTPS API-origin validation. Native sign-in is intentionally disabled: a native token/refresh/revocation contract, API-origin policy and audited Keychain/Android Keystore storage plugin still need design and tests. Native SDK builds, signing and store releases have not been verified.
- **Separate dependency boundary:** the server package has `mysql2` and `bcryptjs` as its production dependencies. React/Vite and Capacitor dependencies live in their own client/native packages and are build-time/native dependencies; they are not loaded by the HTTP server.

This is **not** a production replacement. The Node API covers health/readiness, identity/accounts/administration and the public site with contact intake; no business (product) module has been ported and accepted. No production database integration test, real import rehearsal, cPanel/Passenger host test, provider/broker validation or traffic cutover has been performed. The PHP application remains intact as the source of truth and rollback target.

## Migration inputs still to consolidate

- `application/`: PHP/CodeIgniter platform; authoritative and preserved as rollback target.
- `apps/api/` + `apps/web/` + `packages/shared/`: Scout, currently Fastify/TypeScript + Next.js/TypeScript and PostgreSQL/Redis; requires a deliberate MySQL persistence and product/API parity migration.
- `apps/football-predictions/`: independent Express/JavaScript/MySQL app with its own auth, migrations and tests; not yet consolidated or first-run deployment-verified.
- `python-services/mt5-bridge/`: Python/FastAPI and Windows-only MetaTrader dependency; remains an explicit adapter/migration decision until safely replaced and tested.
- `runtime/`: PHP-WASM developer/test runtime; not part of the production Node target.

## Phase 6 — Strategy Lab, backtesting, lifecycle gates and confidence calibration (2026-10-10, branch `arena/774d9e70-ai`)

Row 8 of [`UNFINISHED_MODULES.md`](UNFINISHED_MODULES.md) and item 3 in the master plan's
module order. Six code commits plus this record, `b3c5d35..HEAD`, 30 files, **+10 124 −16**.
Full record: [`PHASE6_STRATEGIES.md`](PHASE6_STRATEGIES.md). App version is now **0.7.0**.

Ported: `SeriesView.php`, `BuiltinStrategies.php`, `Metrics.php`, `Backtester.php`,
`StrategyOptimizer.php`, `StrategyRegistry.php`, `Journal/Analytics.php` and the
`Api_strategies`/`Api_journal` controllers. **Eleven** endpoints under `/api/v1/strategies`,
`/api/v1/backtesting` and `/api/v1/journal` (platform route count 38 → 49), persisted in
three new tables from migration `006` (platform tables 12 → 15, repository contract
36 → 46 methods, file-store entities 10 → 13).

It imports the Phase 4/5 primitives rather than reimplementing them — indicators, `roundTo`,
`timeframeMs`, `seededRandom`, the provider-failure mapping, and deliberately the
`inferMarketClass` that knows `XAUUSD` is a commodity, because the market-data one would
fetch the wrong series for gold.

The mechanics that make a backtest evidence rather than fiction are all carried over: signals
fill at the **next** bar's open, half-spread plus slippage move every fill, fees are charged
both ways, a bar touching both stop and target resolves to the stop, an entry bar can stop out
immediately, and reading a future bar throws `LookAheadError` which **escapes** the run rather
than being recorded as a warning. Cost control is applied at birth rather than discovered
later as R-26 was: an optimization re-runs the backtester ~50 times, so it gets a 2/10-minute
window and a per-session in-flight cap of **1** — lower than the analysis module's 2, because
one strategy slot holds about fifty times the work.

**Eleven divergences** (DV-1…DV-11) are recorded in §5 of the phase record. The two that
matter most: legacy `iso()` emits `2025-08-12T12:00:00Z.123Z`, which is an **Invalid Date** in
JavaScript and is rejected by this repo's own `assertIsoCutoff`, so Node emits well-formed
ISO-8601 (DV-1); and legacy `transition()` returns a hardcoded empty `warnings` array on
success, discarding the advisories its own gates compute at exactly the moment a strategy is
promoted (DV-3).

**Two findings recorded and deliberately not fixed.** No route in either edition can record a
human sign-off or change a strategy's `source`, so an optimizer variant adopted with
`register: true` stops permanently at `VALIDATED` — the "manual human risk sign-off" the
refusal messages promise has no mechanism. Oracle `33-optimizer.php` confirms the path is
unreachable through the API by writing `lifecycle = 'RISK_REVIEWED'` straight to the database.
Adding a sign-off route would widen the surface and weaken a control, so it is left for the
Risk Center row. And **F-29**: no ported module has a workspace console, so the four legacy
document routes and `views/strategy/index.php` remain unported. **R-28** records that
`wf_backtests` grows without bound and that R-27's remedy was *not* copied, because these rows
are evidence for promotions already granted rather than advisory outputs.

Measured in this sandbox on 2026-10-10: app suite **428/428** (**+171**), `tsc --noEmit`
clean, `verify-install --require-bundle` **30/30** with **64** documented environment
variables, and the legacy PHP oracle still **367/367** with `application/`, `system/` and
`tests/` verifiably untouched. No MySQL server exists here, so migration 006, every statement
in `strategy-repository.js` and the MySQL branch of `verify-data.mjs` are pinned on SQL text
and bound values through a recording fake pool and were **never executed** (F-15, unchanged).
Every backtest in every test ran on synthetic candles and asserts that it did.

## Next phases

1. Add real MySQL/MariaDB integration coverage for Node migrations, sessions, the single-use identity-import ledger, uniqueness conflicts, transaction behavior and restore.
2. Finish native authentication architecture (exact allowed API origin, token lifecycle/revocation, secure-storage plugin, CORS/origin/CSRF tests) before enabling native sign-in or signing an app.
3. Port the remaining shared platform — notifications, the audit browser, settings and the domain dashboards — with route and permission parity. Identity/account management (Phase 2), the public site, SEO/PWA shell and contact intake (Phase 3), market data (Phase 4), the analysis engines (Phase 5) and the Strategy Lab with backtesting, lifecycle gates and confidence calibration (Phase 6) are done; the public chat widget, password-reset delivery, outbound mail and **every** module UI surface are not (**F-29** — three ported modules now have APIs and no console).
4. Migrate domain modules one at a time using [`UNFINISHED_MODULES.md`](UNFINISHED_MODULES.md), preserving the trading Risk Engine, ordered 15-step Execution Supervisor, kill switch, lottery honesty rules, provider provenance and tenant/user isolation. Analysis (`Indicators.php`, the agent set, consensus, the debate and the fundamentals/sentiment abstention contracts) is **done** as of Phase 5, importing the Phase 4 normalizer and carrying `provenance.synthetic` forward into its own payloads. **Next in dependency order: the portfolio state that would make the risk gates non-vacuous** (paper trading and the portfolio monitor), which must resolve finding **F-27** deliberately rather than inherit the legacy zero-equity approval, and must not weaken the kill switch to do it.
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
