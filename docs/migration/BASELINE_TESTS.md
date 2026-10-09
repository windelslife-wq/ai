# Phase 0 — Test Baseline (Executed Results)

**Execution date:** 2026-10-05 · **Audited commit:** `675a05c`
Every test suite in the repository was **actually executed** during this audit, in this environment, with the results recorded below. Per master plan §13: no test is ever claimed passing without execution evidence.

---

## 1. Execution environment

| Component | Version / availability |
|---|---|
| Date | 2026-10-05 (UTC) |
| Node.js | v22.22.3 |
| npm | 10.9.8 |
| Python | 3.11.2 (pip 23.0.1) |
| Native PHP | **not installed** — the PHP suite runs on the repository's own WASM PHP 8.2 runtime (`@php-wasm/node` 3.1.50) |
| MySQL / MariaDB server | not available in this environment (see caveats) |
| PostgreSQL / Redis server | not available (Scout tests stub them in memory) |
| Docker | not available (compose files were never exercised — noted in their headers) |
| Network | npm registry + PyPI reachable |

## 2. Result summary

| # | Suite | Command | Result | Time |
|---|---|---|---|---|
| 1 | **AEGIS PHP application suite** (real CodeIgniter stack on WASM PHP 8.2 + `pdo_sqlite`) | `cd runtime && npm ci && node run-tests.mjs` | **357 passed, 0 failed** (`TESTS-RESULT: 0`, exit 0) | 18.2 s |
| 2 | Scout + shared **TypeScript typecheck** (strict) | `npm run typecheck` | **clean** (exit 0, no diagnostics) | ~5 s |
| 3 | Scout + shared **contract/unit tests** (9 files) | `npm run test:contracts` | **12 passed, 0 failed** | 3.9 s |
| 4 | **Football predictions** tests (6 files) | `cd apps/football-predictions && npm ci && npm test` | **29 passed, 0 failed** | 2.9 s |
| 5 | **MT5 bridge** contract tests (fake terminal) | `cd python-services/mt5-bridge && python3 -m pip install fastapi uvicorn pydantic pytest httpx && python3 -m pytest test_bridge.py -q` | **9 passed, 0 failed** (1 environment-specific deprecation warning from Starlette/httpx) | 0.43 s |

**Total: 407 automated tests — 407 passed, 0 failed.**

Setup caveat for suites 2–3: root `npm ci` **fails** (stale lockfile — R-04); a plain `npm install` installs only the football workspace's tree (also R-04). The recorded workaround used for this baseline: `npm install --no-package-lock` (installs root devDeps + all workspaces, does not touch the lockfile). Reproduce exactly:

```bash
cd /home/user/ai
npm install --no-package-lock        # workaround for R-04; do NOT commit the regenerated lock
npm run typecheck                    # suite 2
npm run test:contracts               # suite 3
cd apps/football-predictions && npm ci && npm test   # suite 4
```

## 3. Suite 1 — AEGIS PHP application suite (the migration oracle)

- **What it is:** `tests/framework.php` (zero-dependency micro framework: `test()`, `assert_*` helpers) + **67 case files** in `tests/cases/` (numbered `01`–`66`; two files share the number `28`: `28-lead-coverage.php` and `28-portfolio-monitor.php`).
- **How it runs:** `runtime/run-tests.mjs` boots WASM PHP 8.2, installs all SQLite schemas into a **throwaway database** (`application/data/aegis-test.sqlite`, deleted before each run so state can never leak), then invokes the real CodeIgniter CLI entry `php index.php tools tests`. Every test therefore exercises the genuine stack (CI3 + DB + domain libraries).
- **Native-host equivalent:** `php index.php tools tests` (any PHP 8.1–8.3 host with the app installed).
- **Observed output (tail):** `============` / `357 passed, 0 failed in 18.2s` / `TESTS-RESULT: 0` — final case `66-account-management.php` (unique usernames, 6-digit UIDs, login by username/email/UID, self-service editing stability) all `[ OK ]`.
- **Coverage map (case file → module):**

| Cases | Module |
|---|---|
| 01–02 | Indicators, math, candle normalization; market providers (health/retry/circuit breaker/provenance/synthetic labeling) |
| 03–05 | Agents; Risk Engine; strategies + lifecycle gates |
| 06–08 | Backtester (look-ahead guard); paper trading (full governance chain); engine + journal/calibration |
| 09–10 | Broker connectors; **Execution Supervisor 15-step pipeline** (modes, envelope, expiry, routing blocks) |
| 11, 52 | Fundamentals agent abstention; sentiment-feed contract (provenance/freshness) |
| 12–22, 40–51 | Sports intelligence (foundation, identity/RBAC, sync, match intelligence, prediction, value/risk, ticket optimizer, decision recorder, results, performance, configuration, calibration, providers, daily-ticket E2E, settlement, backtester, model monitoring, provider health, pipeline gates, RBAC, dashboard UI, production review) |
| 23–28a | Lead discovery (CI3 module): schema, **organization isolation**, provider, deduplication, pipeline, coverage |
| 28b–31 | Portfolio risk monitor; notifications; cron expiry; **trading RBAC** |
| 32 | Simulated MT5 bridge E2E (demo chain through the real 15-step pipeline, SIMULATION-labeled) |
| 33–34 | Strategy optimizer (out-of-sample gates); agent debate (adversarial review) |
| 35–39 | Language learning: core, teacher, vocabulary/SRS, listening+speaking (honest boundaries), adaptive learning |
| 53–61 | Lottery: rules validation, import idempotency, statistics, governance E2E, generator, diversification, system builder, tickets, backtesting |
| 62 | Unfinished-module scaffolds stay disabled and cannot claim capabilities |
| 63–66 | Auth/admin pages; public-workspace access; **full UI audit** (every route/button/link click-through); account management |

## 4. Suites 2–3 — Scout (lead discovery) TypeScript

- `tsc --noEmit` strict typecheck over `packages/shared/src` + `apps/api/src` (+ tests): **clean**.
- `node --import tsx --test` over 9 files (`apps/api/test/{admin,auth,chat,googlePlaces,leadDiscoveryService,leads,redis,refresh}.test.ts`, `packages/shared/test/leadDiscovery.test.ts`): **12/12 pass** in 3.9 s. Tests stub the PG client and Redis (`RedisClient` interface) in memory and use Fastify `app.inject()` — they verify route logic, JWT issue/verify, **refresh-token rotation with reuse detection**, org scoping, provider normalization (Google Places), dedup/coverage/pipeline services and zod contracts.
- Not covered here: live PostgreSQL/Redis behavior, Next.js web UI, real Google Places calls.

## 5. Suite 4 — Football predictions

- `node --test tests/*.test.js`: **29/29 pass** in 2.9 s (deterministic unit + HTTP-contract tests using an injected fake DB/provider layer).
- Coverage (from test names): exact-decimal odds math; Over-1.5-only acceptance/rejection (1H, CANC, PST, other markets, altered/stale/future odds); no forced combinations; duplicate/team-correlation rejection; bounded search; **failed generation persists nothing**; empty qualifying set ⇒ honest "no qualifying ticket"; **health cron has no generation/publication path**; public routes honest, admin actions authorized; **CSRF + immutable-market-change enforcement**; evidence model deterministic with odds not an input; provider normalization (no substitution/price boost); settlement (2/1/0 goals, cancelled, postponed; no double settlement).
- Not covered (per its own `docs/FINAL_AUDIT.md`): first-run MySQL migration, live API-Football payloads, cPanel SSL/proxy/cron, browser E2E. Staging validation is explicitly required before production.

## 6. Suite 5 — MT5 bridge (Python)

- `pytest test_bridge.py -q`: **9 passed** in 0.43 s against a `FakeMT5` terminal — verifies the HTTP contract (health, account, quotes, candles, positions, orders, history, place/modify/cancel/close) and the safety gates (trading disabled by default, demo-only unless `MT5_ALLOW_LIVE=1`, bearer auth).
- **Not verified:** any real MetaTrader terminal integration (Windows host + demo account required — R-09).

## 7. Known gaps in the baseline (do not over-claim readiness)

1. **MySQL/`mysqli` production path untested by the suite** — all 357 tests run on `pdo_sqlite` (R-14). MySQL-only semantics (seeds' `ON DUPLICATE KEY UPDATE`, collations, index limits, locking) need real-MySQL integration tests in Phase 1.
2. No CI executes any of this automatically today (R-05).
3. Scout and football suites are contract-level; neither app has been run end-to-end against its real database/provider in this environment.
4. No performance/shared-hosting-limit tests exist yet (plan §10 requires them).
5. Documentation drift vs. reality recorded in R-06: README says "63 case files, 351 tests"; the executed baseline is **67 files / 357 tests** (and a stale second table claims 57).

## 8. Baseline acceptance for the migration

- The 357-test PHP suite is the **behavioral parity oracle** for the Node port (plan §10 "reuse existing tests as behavioral specifications"). Porting order should follow module order in `INVENTORY.md` §3, porting each module's cases to JS alongside the code.
- No phase may be declared complete against a broken baseline: fix R-04/R-05 (lockfile + CI) in Phase 1 so these five commands run green automatically on every push.

## 9. Addendum — current working tree (`arena/01a10951-ai`, 2026-10-05)

The original audit above records commit `675a05c` and remains historical evidence. After subsequent Lottery/Portfolio work, the Node foundation and identity-import slice, and the unfinished-module inventory, the current tree was re-tested:

| Suite | Exact command | Result |
|---|---|---|
| AEGIS PHP/WASM | `npm --prefix runtime test` | **367 passed, 0 failed**, 69 PHP case files |
| Node modular-monolith foundation + identity importer | `npm run check --workspace=@windels/workforce-platform` | **34 passed, 0 failed** |
| Scout + shared contract tests | `npm run test:contracts` | **12 passed, 0 failed** |
| Scout/shared TypeScript typecheck | `npm run typecheck` | **clean** |
| Football Predictions | `npm test --workspace=windels-football-predictions` | **29 passed, 0 failed** |
| MT5 bridge fake-terminal contracts | `python -m pytest python-services/mt5-bridge/test_bridge.py -q` in a Python 3.11 virtual environment | **9 passed**, one upstream Starlette/httpx deprecation warning |

**Total current automated tests: 452 passed, 0 failed.** Root `npm ci --no-audit --no-fund` completed after refreshing `package-lock.json`; `npm ci --workspace=@windels/workforce-platform --include-workspace-root=false --omit=dev --no-audit --no-fund` also completed, followed by a clean full-workspace reinstall. GitHub Actions run `37250571268` for commit `8608333` completed both jobs (`javascript` and `mt5-bridge-contract`) successfully. No real MySQL/MariaDB, live provider, real MetaTrader terminal, production data, or cPanel/Passenger host was available for these tests. The Node migration foundation tests use Fastify injection and fake stores; they are not MySQL integration or deployment evidence.

— End of Phase 0 test baseline.

## Re-measured 2026-10-09 — Phase 2 (identity, accounts, platform core), branch `arena/c204b9d0-ai`, Node v22.22.3

| Suite | Exact command | Result |
|---|---|---|
| Node platform — identity, accounts, HTTP core, uploads, RBAC, backups | `npm run check --workspace=@windels/workforce-platform` | **21/21 install checks**, then **85 passed, 0 failed** |
| AEGIS PHP/WASM | `node runtime/run-tests.mjs` (repo root) | **367 passed, 0 failed** |
| Scout + shared contract tests | `npm run test:contracts` | **12 passed, 0 failed** |
| Football Predictions | `npm test --workspace=windels-football-predictions` | **29 passed, 0 failed** |

**Total in this sandbox: 493 passed, 0 failed.** Not re-run here: the MT5-bridge pytest
suite (it needs its own Python 3.11 virtual environment; unchanged at 9 passed from the
previous measurement).

Two corrections to how the previous section describes this suite:

- It is no longer "Node migration foundation tests … use Fastify injection and fake
  stores". Fastify is not a dependency of this package at all; `test/helpers.js` builds
  the real `node:http` application and drives it through the project's own `inject()`
  transport, and the tests that assert persistence behaviour run against the actual
  append-only file store (temp directories), not an in-memory stub.
- Fake pools are still used for the **MySQL** paths (`src/db/store.js`, migrator,
  importer). That is precisely why F-15 — real MySQL/MariaDB verification — remains
  open: nothing in this suite proves MySQL behaviour, and no MySQL server exists in
  this sandbox.

Operational evidence produced alongside the tests (file adapter, temp roots):
`tools/verify-data.mjs` exits 1 with "the store holds no roles" on an unseeded store,
`tools/seed-platform.mjs` seeds 9 roles / 14 permissions / 29 grants, `verify-data`
then exits 0, `tools/backup.mjs create|verify|restore` round-trips and refuses both a
tampered manifest and a non-empty target without `--force`.

## Re-measured 2026-10-09 — Phase 3 (public site, SEO/PWA shell, contact intake), branch `arena/774d9e70-ai`, Node v22.22.3

| Suite | Exact command | Result |
|---|---|---|
| Node platform — public site, generated SEO documents, PWA shell, contact intake, identity, HTTP core, uploads, RBAC, backups | `cd apps/workforce-platform && npm run verify:install` then `npm test` | **30/30 installation checks**, then **103 passed, 0 failed** (12 test files, 22.6 s) |
| Icon reproducibility | `cd apps/workforce-platform && npm run check:icons` | **4/4 verified** (`icon-192`, `icon-512`, `maskable-512`, `apple-touch-icon`) |
| Client (React/Vite) production build | `cd apps/workforce-platform/client && npm ci && npm run build` | **exit 0** — 20 modules transformed; `index-*.js` 265.27 kB (79.47 kB gzip), `index-*.css` 18.12 kB (4.82 kB gzip) |
| AEGIS PHP/WASM (the parity oracle) | `node runtime/run-tests.mjs` (repo root, after `npm ci` in `runtime/`) | **367 passed, 0 failed**, 19.3 s |
| Scout + shared contract tests | `npm run test:contracts` | **12 passed, 0 failed** |
| Football Predictions | `cd apps/football-predictions && npm ci && npm test` | **29 passed, 0 failed** |

**Total executed in this sandbox for this phase: 511 passed, 0 failed.**

Reproduction warning, learned by hitting it: running `npm ci` **inside** `client/`, `runtime/` or
`apps/football-predictions/` prunes packages hoisted into the repository root `node_modules`
(this phase it removed `bcryptjs`, and the app suite then failed with
`ERR_MODULE_NOT_FOUND: Cannot find package 'bcryptjs'` — 24 passed, 9 failed). Restore the root
tree with `npm install --no-package-lock` (the R-04 workaround; it leaves `package-lock.json`
untouched) and re-run `npm run check` before trusting any count. Measured after restoring:
**30/30 install checks and 103/103 tests again**.

Not executed here, and therefore not claimed:

- **MT5-bridge `pytest` (9 tests)** — needs its own Python 3.11 virtual environment; nothing it
  covers changed in this phase. Last recorded result: 9 passed.
- **`npm run typecheck`** — `typescript` is not installed in this sandbox's root tree, so `tsc`
  cannot run (`sh: 1: tsc: not found`). No TypeScript changed in this phase; the last recorded
  result was clean.
- **Anything needing a real MySQL/MariaDB server, a cPanel/Passenger host, a real browser
  (Lighthouse, install prompt, service-worker update observation), outbound SMTP, provider
  credentials or a native SDK.** Migration `004_public_site.sql` has never been applied by a
  real server; the generated service worker's *source* is compiled inside a test, but its
  runtime behaviour in a browser is not measured.

How the counts moved, and why:

- **85 → 103 app tests** is +18 in `test/site.test.js`. That suite reads the legacy PHP as its
  oracle — it parses the site block of `application/config/routes.php`, compares rendered
  headings against `application/views/site/*.php` (entities decoded), and re-derives the service
  worker's never-cache literals from the same data the generator uses — so the expectations are
  not a restatement of the implementation.
- **21 → 30 installation checks**: the required-file list now covers the site module
  (`pages.js`, `render.js`, `documents.js`), `public/styles.css`, `public/site.js` and the four
  icon PNGs instead of the deleted static `index.html`/`manifest.webmanifest`; plus two new
  gates — the committed icons must be byte-identical to `tools/generate-icons.mjs` output, and
  no static copy of a generated document (`robots.txt`, `sitemap.xml`, `manifest.webmanifest`,
  `service-worker.js`, `index.html`) may exist. `.env.example` coverage is now 45 variables.
- **28 → 30 API routes** (`POST /api/v1/site/contact`, `GET /api/v1/admin/inquiries`) and
  **0 → 22 rendered document routes**; the repository contract grew from 30 to 32 methods.

Operational rehearsal alongside the tests (file adapter, `STORAGE_DIR` outside the repository,
`seed:platform --admin-username demo`): every document route answered as specified (8 pages 200,
3 aliases 301, 6 redirects 302, 4 generated documents 200), `POST /api/v1/site/contact` stored
an inquiry and returned a ULID reference with `mail.sent:false`, `POST /contact/submit` answered
303 with a signed `wf_flash` cookie while the same request carrying an undeclared field answered
400, the super-admin listing returned the stored row with its 64-hex client fingerprint, and the
same listing answered 401 anonymously. The full table is in
[`PHASE3_PUBLIC_SITE.md`](PHASE3_PUBLIC_SITE.md) §9.

## Re-measured 2026-10-09 — Phase 4 (market data and provider health), branch `arena/774d9e70-ai`, Node v22.22.3

| Suite | Exact command | Result |
|---|---|---|
| Node platform — market data (providers, normalization, breakers, HTTP client, endpoints), public site, identity, HTTP core, uploads, RBAC, backups | `cd apps/workforce-platform && npm run verify:install` then `npm test` | **30/30 installation checks**, then **137 passed, 0 failed** (13 test files, 26.8 s) |
| Icon reproducibility | `cd apps/workforce-platform && npm run check:icons` | **4/4 verified** (unchanged this phase) |
| AEGIS PHP/WASM (the parity oracle) | `node runtime/run-tests.mjs` (repo root) | **367 passed, 0 failed**, 18.6 s — including all eleven `tests/cases/02-providers.php` cases, which the Node suite ports 1:1 |
| Scout + shared contract tests | `npm run test:contracts` | **12 passed, 0 failed** |
| Football Predictions | `cd apps/football-predictions && npm test` | **29 passed, 0 failed** |
| TypeScript typecheck | `npm run typecheck` (`tsc -p tsconfig.json --noEmit`) | **exit 0, no diagnostics** — `typescript` *is* present in the root tree now, so the Phase 3 note that `tsc` could not run no longer applies |
| Client (React/Vite) production build | `cd apps/workforce-platform && npm run build:client` | **exit 0** — unchanged output, same hashes as Phase 3 (`index-Ci3bygYZ.js` 265.27 kB / 79.47 kB gzip, `index-B-xBd6Ec.css` 18.12 kB / 4.82 kB gzip); no client source changed in this phase |

**Total executed in this sandbox for this phase: 545 passed, 0 failed.**

How the counts moved, and why:

- **103 → 137 app tests** is +34 in `test/market_data.test.js`: the eleven legacy `02-providers` cases
  (with `fx_candles()` and `FakeProvider` ported as `fxCandles` / `fakeProvider` so the fixtures are the
  same series from the same seeded PRNG), plus normalizer clamping and rejection rules, the timeframe and
  market-class vocabulary, `hashString` / `seededRandom` / `gaussian` determinism, the manager's
  synthetic-refusal, timeframe-capable ordering, `DEGRADED` promotion, no-probe health, TTL reuse and
  bounded eviction, staleness, the four licensed-adapter states and their payload rejections, Binance's
  allow-list / ragged-row / host-mirror behaviour, the retry-backoff budget, and the HTTP surface
  (401, seven validation refusals, labelled synthetic success, registry + policy, 503 refusal with
  `Retry-After`, the `PROVIDER_FALLBACK` audit row, status/features/route-inventory).
- **Installation checks stay at 30/30**; `.env.example` coverage grew from **45 → 53** variables
  (`MARKET_DATA_REAL_PROVIDERS`, `_ALLOW_SYNTHETIC`, `_TIMEOUT_MS`, `_RETRIES`, `_DEADLINE_MS`,
  `_HEALTH_TIMEOUT_MS`, `BINANCE_API_BASE`, `FRANKFURTER_API_BASE`). The `AEGIS_*_DATA_*` licensed-feed
  family is read through a computed key, so the static scanner cannot see it; those seven names are
  documented by hand anyway.
- **30 → 33 API routes** (`GET /api/v1/market-data/{candles,quote,providers}`); document routes stay at
  22; the repository contract stays at **32 methods** and the migration set at **001–004** — market data
  persists only an audit row.
- **Modules reported `ported` by `/api/v1/system/features`: 1 → 2** (`identity`, `marketData`);
  `not-ported` 12 → 11.

Not executed here, and therefore not claimed:

- **Any live upstream provider call.** This sandbox has no egress to `api.binance.com`,
  `data-api.binance.vision`, `api1.binance.com` or `api.frankfurter.dev`. In the live rehearsal both real
  providers reported `DOWN` with the real reason and the chain fell back to the labelled synthetic
  provider — correct behaviour, but it is **not** evidence that the real providers work.
- **A value-for-value diff of PHP versus Node numeric output (new finding F-26).** Both suites are green,
  but the golden constants in the Node suite came from the Node port; an attempt to boot WASM PHP directly
  and dump `MathUtils` / `SyntheticProvider` / `CandleNormalizer` output as JSON timed out here.
- **MT5-bridge `pytest` (9 tests)** — unchanged, unrelated to market data; last recorded result 9 passed.
- **Anything needing a real MySQL/MariaDB server, a cPanel/Passenger host, a real browser, outbound SMTP,
  provider credentials, a licensed market-data vendor or a native SDK.**

Operational rehearsal alongside the tests (file adapter, `STORAGE_DIR=/tmp/wf-store`, server on
`0.0.0.0:3000`, account created through `POST /api/v1/auth/register`): anonymous
`GET /api/v1/market-data/candles` answered **401**; `timeframe=2h` answered **400** naming the allowed
set; `symbol=BTCUSDT&timeframe=1h&limit=40` answered **200** with 40 candles, `validation.ok:true`,
`provenance.source:"synthetic-demo"`, `synthetic:true`, `live:false` and `fallbackChain:["binance"]`;
`quote?symbol=eurusd` answered **200** with `ask > bid` and `fallbackChain:["frankfurter-ecb"]`;
`providers` answered **200** with `binance DOWN`, `frankfurter-ecb DOWN`, the four licensed adapters
`DISABLED`, `synthetic-demo UP` and the registry in legacy priority order 10/20/30/31/32/33/999;
`/api/v1/system/status` reported version `0.5.0`, `modules[marketData].state:"ported"` and a market-data
snapshot whose providers were all `UNKNOWN` because the public route never probes; and two
`marketData.provider.fallback` audit rows were written with `legacyAction:"PROVIDER_FALLBACK"`. The full
log is in [`PHASE4_MARKET_DATA.md`](PHASE4_MARKET_DATA.md) §4.3.
