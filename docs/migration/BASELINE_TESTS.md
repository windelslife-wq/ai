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
| Node platform — market data (providers, normalization, breakers, HTTP client, endpoints), public site, identity, HTTP core, uploads, RBAC, backups | `cd apps/workforce-platform && npm run verify:install` then `npm test` | **30/30 installation checks**, then **140 passed, 0 failed** (13 test files, 28.7 s) |
| Icon reproducibility | `cd apps/workforce-platform && npm run check:icons` | **4/4 verified** (unchanged this phase) |
| AEGIS PHP/WASM (the parity oracle) | `node runtime/run-tests.mjs` (repo root) | **367 passed, 0 failed**, 18.6 s — including all eleven `tests/cases/02-providers.php` cases, which the Node suite ports 1:1 |
| Scout + shared contract tests | `npm run test:contracts` | **12 passed, 0 failed** |
| Football Predictions | `cd apps/football-predictions && npm test` | **29 passed, 0 failed** |
| TypeScript typecheck | `npm run typecheck` (`tsc -p tsconfig.json --noEmit`) | **exit 0, no diagnostics** — `typescript` *is* present in the root tree now, so the Phase 3 note that `tsc` could not run no longer applies |
| Client (React/Vite) production build | `cd apps/workforce-platform && npm run build:client` | **exit 0** — unchanged output, same hashes as Phase 3 (`index-Ci3bygYZ.js` 265.27 kB / 79.47 kB gzip, `index-B-xBd6Ec.css` 18.12 kB / 4.82 kB gzip); no client source changed in this phase |

**Total executed in this sandbox for this phase: 548 passed, 0 failed.**

**CI caught what this sandbox could not.** The first push of this phase failed the `javascript` job at
`npm run check --workspace=@windels/workforce-platform`. Cause: one market-data test asserted that a host
refusing synthetic data answers `503`, while leaving the real providers enabled. In this sandbox there is
no egress, so Binance fails and the assertion holds; on a runner **with** egress Binance serves the
candles and the endpoint correctly answers `200`. The test's outcome depended on the runner's network.
Reproduced locally by stubbing `globalThis.fetch` for the provider hosts only — a blanket stub hijacks
`app.inject`, which is itself `fetch` against `127.0.0.1`, and produces six unrelated failures. Fixed by
making the suite hermetic (refusal case with real providers off; "providers unreachable" and "providers
reachable" cases at service level with injected transports) and re-verified **37/37 with simulated egress
and 37/37 without**. Recorded as defect **D-6** in `PHASE4_MARKET_DATA.md` §6. The market-data suite now
makes no outbound network call, which is also what finding **F-25** asserts.

How the counts moved, and why:

- **103 → 140 app tests** is +37 in `test/market_data.test.js`: the eleven legacy `02-providers` cases
  (with `fx_candles()` and `FakeProvider` ported as `fxCandles` / `fakeProvider` so the fixtures are the
  same series from the same seeded PRNG), plus normalizer clamping and rejection rules, the timeframe and
  market-class vocabulary, `hashString` / `seededRandom` / `gaussian` determinism, the manager's
  synthetic-refusal, timeframe-capable ordering, `DEGRADED` promotion, no-probe health, TTL reuse and
  bounded eviction, staleness, the four licensed-adapter states and their payload rejections, Binance's
  allow-list / ragged-row / host-mirror behaviour, the retry-backoff budget, and the HTTP surface
  (401, seven validation refusals, labelled synthetic success, registry + policy, 503 refusal with
  `Retry-After`, the `PROVIDER_FALLBACK` audit row, status/features/route-inventory), the full
  seven-provider registry order with honest health, and a reachable real provider winning over the
  synthetic fallback without writing a fallback audit row.
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

## Re-measured 2026-10-09 — Phase 5 (analysis engines, agents, consensus, risk veto gate), branch `arena/774d9e70-ai`, Node v22.22.3

| Suite | Exact command | Result |
|---|---|---|
| Node platform — analysis (indicators, regimes, seven agents, debate, consensus, risk veto, engine, endpoints, persistence), market data, public site, identity, HTTP core, uploads, RBAC, backups | `cd apps/workforce-platform && npm run verify:install` then `npm test` | **30/30 installation checks**, then **235 passed, 0 failed** (15 test files, ~36 s) |
| Icon reproducibility | `cd apps/workforce-platform && npm run check:icons` | **4/4 verified** (unchanged this phase) |
| AEGIS PHP/WASM (the parity oracle) | `node runtime/run-tests.mjs` (repo root) | **367 passed, 0 failed**, 19.3 s — including the 38 cases in `01-indicators`, `03-agents`, `04-risk-engine`, `08-engine-journal` and `34-agent-debate`, of which the Node suite ports **36** (the two it does not are the backtester and journal-analytics cases, which belong to unported modules) |
| Scout + shared contract tests | `npm run test:contracts` | **12 passed, 0 failed** |
| Football Predictions | `cd apps/football-predictions && npm test` | **29 passed, 0 failed** |
| TypeScript typecheck | `npm run typecheck` (`tsc -p tsconfig.json --noEmit`) | **exit 0, no diagnostics** |
| Client (React/Vite) production build | `npm run build:workforce-client` | **exit 0**, built in ~170 ms — `index-DSbqgd7N.js` 265.20 kB, `index-B-xBd6Ec.css` 18 123 bytes. **No client source changed** (`git diff HEAD -- …/client` is empty for both Phase 5 commits) and the build is **deterministic** (two consecutive builds, identical bytes), but the JS hash is **not** the `index-Ci3bygYZ.js` (265.27 kB) that Phases 3–4 recorded: dependencies were re-installed without a lockfile, so unpinned *transitive* versions drifted by 78 bytes of output. Reproducible from a given `node_modules`, **not** from the repository alone — F-12/R-04 observed in the wild. Detail in `PHASE5_ANALYSIS.md` §9.1 |
| Hermeticity | `node --test --import /tmp/egress-shim.mjs test/*.test.js` | **235 passed, 0 failed** — identical to the unshimmed run, so no test in the suite makes an outbound call |

**Total executed in this sandbox for this phase: 643 passed, 0 failed** (235 app + 367 oracle + 12
contracts + 29 football).

How the counts moved, and why:

- **140 → 235 app tests** is **+95** across two new files:
  - `test/analysis.test.js` (**71**) — the pure layer: the eleven legacy `01-indicators` cases, the eight
    legacy `03-agents` cases, the seven legacy `34-agent-debate` cases, the eight legacy `04-risk-engine`
    cases (the legacy fixtures transferred unchanged because the Node candle key is `timestamp`, the same
    key `fx_candles()` produced), plus indicator warm-up/Wilder/true-range/stochastic-masking edges,
    PHP-compatible rounding and both number formats, agent applicability by market class, the
    `dataQuality` ladder, the ±0.15 vote threshold, a **licensed sentiment feed voting** and every
    validator rejection, fundamentals abstention, abstainer exclusion, quality weighting, **all seven
    regime labels from deterministic single-branch fixtures**, setup nulls and complete self-consistent
    proposals, scenarios, debate monotonicity and the minor-objection cap, and the frozen risk-limit table.
  - `test/analysis_http.test.js` (**24**) — the two legacy `08-engine-journal` engine cases against the
    durable file adapter, plus stale-data downgrade, the live-data path where the kill switch is the only
    remaining veto, an agent that throws, an injected sentiment feed, a provider outage, which reference
    legs are fetched per market class, persistence and audit attribution, the CSRF and 401 surfaces, the
    validation matrix, history ordering and bounds, 404 vs 400, static-route precedence, consensus bounds,
    the 503 + `Retry-After` contract, upsert-not-duplicate, the status surface and the route inventory.
- **Installation checks stay at 30/30 and `.env.example` stays at 53 variables** — this phase adds **no
  configuration**. Agent weights, the vote threshold, the candle limit and the risk limits are code
  constants on purpose: they are safety parameters, and making them environment variables would let a host
  silently weaken a veto.
- **33 → 38 API routes** (`POST /api/v1/analysis/run`, `GET /api/v1/analysis/history`,
  `GET /api/v1/analysis/agents`, `POST /api/v1/analysis/consensus`, `GET /api/v1/analysis/:runId`);
  document routes stay at 22; the repository contract grows **32 → 35** methods and the migration set
  **001–004 → 001–005** (`wf_analysis_runs`).
- **Modules reported `ported` by `/api/v1/system/features`: 2 → 3** (`identity`, `marketData`,
  `analysis`); `partial` 2 → 3 (`publicSite`, `audit`, **`risk`** — only the veto gate is ported);
  `not-ported` 11 → 9.

One flake found and removed rather than re-run until green: an engine-level test asserted the newest audit
row **by position** while its own harness settled provider calls to zero, so two runs could share a
millisecond and the store's stable sort would return the older row. Rows are now located by run id, and the
history test additionally asserts descending `completedAt`. Recorded as defect **D-11** in
[`PHASE5_ANALYSIS.md`](PHASE5_ANALYSIS.md) §6. Five consecutive full-suite runs and two runs under CPU
contention (two suites at once on 2 cores) passed with zero failures.

Not executed here, and therefore not claimed:

- **Any live upstream data.** No egress, so every analysis in this phase ran on the synthetic provider or
  on an injected test double, and says so in `provenance`. The engine's live path (`synthetic:false`,
  `stale:false`) is covered only by a double that relabels deterministic candles: the arithmetic is proven,
  the vendor payload shapes are not (F-25 unchanged).
- **A value-for-value PHP↔Node numeric diff (F-26, unchanged and still a cutover prerequisite).** The 36
  ported legacy cases were re-derived by hand and pinned as goldens, but `Indicators.php`, `MathUtils.php`,
  `Analysis.php` and the agent set have not been diffed against PHP output.
- **Real MySQL.** Migration `005` and `analysis-repository.js` are verified by the readiness probe, the
  contract check and SQL-text assertions, not by executing against a server (F-15, narrowed).
- **The risk engine's approve path over HTTP.** It is unit-tested by passing `killSwitchActive:false`, and
  those tests pin exact sizing — but it is unreachable from any route on this platform, because the kill
  switch is engaged at boot and no ported code path releases it. No test claims otherwise.
- **Any portfolio state.** Equity, peak equity, open positions and open risk are platform defaults, so the
  drawdown, daily/weekly-loss, exposure and correlation gates are exercised only by unit tests that supply
  a context; on the HTTP surface they are vacuous and `riskContext.note` says so in every run.
- **MT5-bridge `pytest` (9 tests)** — unchanged, unrelated to analysis; last recorded result 9 passed.
- **Anything needing a cPanel/Passenger host, a real browser, outbound SMTP, provider credentials, a
  licensed sentiment/fundamentals vendor or a native SDK.**

Operational rehearsal alongside the tests (file adapter, `MARKET_DATA_REAL_PROVIDERS=0`, server on
`0.0.0.0:3000`): `POST /api/v1/analysis/run` for BTCUSDT 1h answered **200** with `NEUTRAL` at 0.27 →
`HOLD`, regime `UNKNOWN`, 5 agents, 9 signals, 3 scenarios, a 4-round debate with no sustained objections,
`provenance.synthetic:true`; EURUSD 1h answered **200** with 6 agents (forex applies to a major pair),
`macro.available:false`, synthetic currency strength carrying its own warning, session `Asia`, and a
`BOS SELL` **confirmed by a close** where the crypto run's wick break was not; a 7-symbol
`POST /api/v1/analysis/consensus` scan completed and every run was readable back by id (27 payload keys),
with `analysis.run.completed`, `analysis.signal.proposed` and `risk.decision.rejected` audit rows — the
kill-switch veto firing exactly as designed. Anonymous calls to all five routes answered **401**, and a
cookie session posting without its CSRF token answered **403 `CSRF_INVALID`**. The full log is in
[`PHASE5_ANALYSIS.md`](PHASE5_ANALYSIS.md) §4.3.

## Re-measured 2026-10-09 — Phase 5 hardening pass (F-27, R-26, R-27, F-28), branch `arena/774d9e70-ai`, Node v22.22.3

The section above is the record of Phase 5 **as delivered** (0.6.0). This one re-measures the same
commands after the hardening pass (0.6.1) that closed the three findings that phase opened, plus one it
exposed. Both records are kept, per the "never silently reconcile" rule: the numbers above were true when
they were taken.

| Suite | Exact command | Result |
|---|---|---|
| Node platform (16 files, incl. the new `test/retention.test.js`) | `cd apps/workforce-platform && npm run verify:install` then `npm test` | **30/30 install checks**; **257 passed, 0 failed** (~33 s) |
| Analysis pure layer | `node --test test/analysis.test.js` | **75 passed, 0 failed** (was 71) |
| Analysis HTTP/engine/persistence | `node --test test/analysis_http.test.js` | **26 passed, 0 failed** (was 24) |
| Retention (R-27, both adapters + CLI) | `node --test test/retention.test.js` | **14 passed, 0 failed** (new file) |
| Config | `node --test test/config.test.js` | **7 passed, 0 failed** (was 6) |
| Backup (F-28) | `node --test test/backup.test.js` | **5 passed, 0 failed** (was 4) |
| Platform findings | `node --test test/platform_findings.test.js` | **32 passed, 0 failed** (unchanged count; three pins moved) |
| Market data | `node --test test/market_data.test.js` | **37 passed, 0 failed** — untouched by this pass |
| Icon reproducibility | `npm run check:icons` | **4/4 verified** |
| AEGIS PHP/WASM (the parity oracle) | `node runtime/run-tests.mjs` | **367 passed, 0 failed**, 19.2 s — **cannot move: no legacy PHP was edited** |
| Scout + shared contract tests | `npm run test:contracts` | **12 passed, 0 failed** |
| Football Predictions | `cd apps/football-predictions && npm test` | **29 passed, 0 failed** |
| TypeScript typecheck | `npm run typecheck` | **exit 0, no diagnostics** |
| Client (React/Vite) production build | `npm run build:workforce-client` | **exit 0** — `index-DSbqgd7N.js` 265.20 kB, `index-B-xBd6Ec.css` 18 123 bytes; no client source changed |
| Hermeticity | `node --import /tmp/egress-shim.mjs --test test/*.test.js` | **257 passed, 0 failed**, shim reporting *"no outbound requests attempted"* for all 16 files |
| Retention CLI, driven as an operator would | `node tools/prune-analysis-runs.mjs [--apply] [--json] [--days N]` against a seeded file store | dry run measured **3 of 5** runs (200/120/91 days old) and deleted **0**; `--apply` deleted **3** in 1 batch; a reopen from disk showed **2** rows, so the write-ahead log replays the deletions; a second run found nothing; `--days 200` matched **0**, proving the comparison is *strictly* older; `ANALYSIS_RETENTION_DAYS=0 --apply` deleted **nothing** and said why; `--nope`, `--days -5`, `--batch 99999`, `--now garbage` each exited **1** with the reason and the usage line on stderr; `--json` printed exactly one document in both the success and failure paths |

**Total executed in this sandbox for the hardening pass: 665 passed, 0 failed** (257 app + 367 oracle + 12
contracts + 29 football; the 4 icon checks and the client build are assertions, not `node:test` cases, which
is why this is 665 and not 669).

How the counts moved, and why:

- **235 → 257 app tests** is **+22**: four `createAnalysisRunGate` unit tests (cap, per-session isolation,
  release on failure, and the disabled cases — `max` of `0`, `-1`, `NaN`, `Infinity`, or no tracker at all),
  two HTTP limit tests (the run window limit charged *before* validation, and a scan's tighter budget), one
  config test (the shipped defaults and their relationship, plus out-of-range refusals), one backup pin
  (F-28), and the 14-test `retention.test.js`.
- **`test/analysis.test.js` 71 → 75** with one test **inverted, not added**: the case that pinned the legacy
  zero-equity approval now asserts the veto (DV-10) for zero, negative and non-finite equity, plus a
  positive-equity control that must *not* trip it.
- **Installation checks stay 30/30; `.env.example` goes 53 → 59.** The Phase 5 claim "this phase adds no
  configuration" remains true of the *engine* — agent weights, the vote threshold, the candle limit and the
  risk limits are still code constants, because they are safety parameters. The six new variables are
  operational (four R-26 limit knobs, one concurrency cap, one retention window), which is the category an
  operator has to be able to tune per host without a code change.
- **Routes stay at 38** and document routes at 22: retention is deliberately CLI-only, and a test asserts
  the analysis module registers **no `DELETE` verb**. The repository contract grows **35 → 36**
  (`pruneAnalysisRuns`), which moved three pins — `platform_findings` (method count and its group tally),
  the inline store in `test/helpers.js` (which documents that it mirrors the durable adapters) and
  `verify:install`'s documented-variable count.
- **Module states are unchanged**: 3 ported, 3 partial, 9 not-ported. Hardening adds no surface.
- **`npm run prune:analysis`** joined the documented operational commands, so the pin in
  `platform_findings.test.js` now enumerates nine scripts and reports *which* are missing rather than only
  a count.

Two things this pass corrected in the ledger rather than leaving to be discovered:

1. **The client bundle hash claim.** Phase 5 recorded the SPA as `index-Ci3bygYZ.js` (265.27 kB); rebuilding
   produced `index-DSbqgd7N.js` (265.20 kB). No client source changed (`git diff HEAD -- …/client` is empty
   for both Phase 5 commits) and the build is deterministic (two consecutive builds, identical bytes) — the
   difference is that dependencies were re-installed **without a lockfile**, so unpinned *transitive*
   versions drifted by 78 bytes of output. Reproducible from a given `node_modules`, **not** from the
   repository alone: F-12/R-04 observed in the wild. Detail in `PHASE5_ANALYSIS.md` §9.1. The Phase 4 row
   above it is left exactly as measured, because it was accurate for the tree that existed then.
2. **F-28 — MySQL backups never worked.** `tools/backup.mjs` counted a hardcoded table list that omitted
   `wf_contact_inquiries`, `wf_data_imports` and `wf_analysis_runs`, and counted `wf_user_files`, a table
   nothing in this repository creates. On MySQL, `SELECT COUNT(*) FROM wf_user_files` throws
   `ER_NO_SUCH_TABLE`, so `npm run backup` failed outright on the adapter production uses. No test caught it
   because the backup suite drives the file adapter only and this sandbox has no MySQL. The list is now
   derived from `src/db/migrations/*.sql`. This is still **not** executed against a real server — it is
   pinned as a derivation plus SQL-text assertions, and F-15 stays open.

Still not executed here, and therefore still not claimed: any live upstream data (no egress), a
value-for-value PHP↔Node numeric diff (**F-26**; DV-10 must appear in it as an *expected* difference), real
MySQL — now including the batched `DELETE … ORDER BY … LIMIT`, so **F-15 stays re-widened** — any load test
of the R-26 limits (they are proven to fire and to release, not measured against a real provider under real
concurrency; any throughput number here would be invented), a retention cron entry on any host, MT5-bridge
`pytest` (9, unrelated, last recorded 9 passed), and anything needing a cPanel/Passenger host, a real
browser, outbound SMTP, provider credentials or a native SDK.

---

## Re-measured 2026-10-10 — Phase 6 (Strategy Lab, backtesting, lifecycle gates, calibration), branch `arena/774d9e70-ai`, Node v22.22.3

Same machine, same sandbox limits as the Phase 5 rows above: no MySQL/MariaDB server, no
outbound egress, no cPanel/Passenger host, no real browser, no SMTP, two CPUs. Everything
below was executed; nothing is inherited from an earlier row.

| Suite | Exact command | Result |
|---|---|---|
| Node platform (**20** files, was 16) | `cd apps/workforce-platform && npm test` | **428 passed, 0 failed** (~45 s) — was 257, **+171** |
| Install verification | `npm run verify:install -- --require-bundle` | **30/30 checks**, **64** documented env vars (was 59, +5) |
| TypeScript | `node_modules/.bin/tsc --noEmit -p tsconfig.json` | clean, exit 0 |
| Client production build | `npm run build:workforce-client` | 20 modules; `index-BEWWTqRR.js` **265.73 kB** (gzip 79.66), `index-CuzqXBFB.css` 18.15 kB |
| AEGIS PHP/WASM (the parity oracle) | `cd runtime && node run-tests.mjs` | **367 passed, 0 failed**, 18.2 s — unchanged, and `application/`, `system/` and `tests/` are verifiably untouched (`git diff --name-only b3c5d35..HEAD` returns no path under them) |
| Football predictions | `cd apps/football-predictions && node --test tests/*.test.js` | **29 passed, 0 failed** |
| Contracts (`packages/shared` + `@lead-discovery/api`) | `npm run test:contracts` | **12 passed, 0 failed** — 3 from `packages/shared/test/*.test.ts` and 9 from `apps/api/test/*.test.ts`, measured separately as well as together |

**Total executed in this sandbox for this phase: 836 passed, 0 failed** (428 app + 367 oracle
+ 29 football + 12 contracts). Composition stated because these are four different runners and
a bare total invites double-counting.

New and changed files in the platform suite:

| File | Cases | Note |
|---|---|---|
| `test/strategies.test.js` | **86** (new) | 61 prefixed `legacy:`, ported 1:1 from `05-strategies.php`, `06-backtester.php` and `33-optimizer.php` on the same `fx_candles`/`fx_noise_range`/`opt_series`/`flat`/`bt_req` fixtures, so both editions assert the same numbers against the same inputs |
| `test/strategies_store.test.js` | **27** (new) | Both adapters against one contract; the file side executed for real including WAL replay of the composite strategy key, the MySQL side pinned on SQL text and bound values |
| `test/strategies_http.test.js` | **27** (new) | Route surface, session and CSRF gating, vocabulary rejections, both rate-limit windows independently, the concurrency gate, and the evidence chain that unlocks `BACKTESTED` |
| `test/journal_analytics.test.js` | **30** (new) | Includes `08-engine-journal.php` ported 1:1 on the same forty-entry fixture |
| `test/config.test.js` | **8** (was 7) | The shipped Strategy Lab limits and the relationship between them |
| `test/backup.test.js` | 5 | Table list **12 → 15**; `tablesFromMigrations()` picked 006 up automatically, which is the point of the F-28 fix |
| `test/platform_findings.test.js` | 32 | Contract **36 → 46** methods; file-store `stats()` keys **10 → 13** |
| `test/store.test.js` | 5 | Readiness now requires six ordered migrations |
| `test/retention.test.js` | 14 | The shared contract pin moved 36 → 46 |

**A correction to this section as first committed in `c5b7a2b`.** It stated that
`@lead-discovery/api` was "not re-run" and that an earlier row's "contracts 12" suite "does not
correspond to anything runnable". Both claims were false, and the second one "corrected" a true
statement into a false one — the worse direction to be wrong in.

There is no *workspace* named `@windels/contracts`, which is what I checked, but the root script
**`npm run test:contracts`** is very real and runnable: it is
`node --import tsx --test packages/shared/test/*.test.ts apps/api/test/*.test.ts`, it is step 6
of the CI `javascript` job, and it reports exactly the 12 cases the earlier row recorded.
`@lead-discovery/api` is `apps/api`, so its 9 tests run as part of that script and were executed
here. A narrow true observation (no workspace by that name) was written up as a broad false one
(nothing runnable by that name), and the total was understated by 12 as a result. Both are
corrected above and the total is now 836.

Not re-run here, and therefore still not claimed: the MT5-bridge `pytest` suite (9 cases,
unrelated to this phase, last recorded 9 passed — and green in CI on every run of this branch,
including the failed one, which is worth noting because it means the CI failure below was not
it).

Still not executed here, and therefore still not claimed: **real MySQL** — now including
migration `006`, all ten methods of `strategy-repository.js`, the two new integrity checks in
the MySQL branch of `verify-data.mjs`, and backup's three new table counts, all pinned on SQL
text and bound values through a recording fake pool (**F-15 stays open and is wider than it
was**); any live upstream data, so every backtest in every test ran on synthetic candles and
asserts that it did; a value-for-value PHP↔Node numeric diff (**F-26**); any load test of the
new Strategy Lab rate limits or the per-session concurrency cap — they are proven to fire, to
return `retry-after`, and to release in `finally`, not measured against a real provider under
real concurrency, so any throughput number here would be invented; the `APPROVED` lifecycle
stage end-to-end, which needs `source: "paper"` journal rows that only row 10 (paper trading)
can produce; a retention cron entry on any host (**R-28** is recorded, not implemented);
MT5-bridge `pytest` (9, unrelated, last recorded 9 passed); and anything needing a
cPanel/Passenger host, a real browser — so the F-29 client change is verified by a successful
production build and by `verify-install`'s bundle-reference check, **not** by rendering —
outbound SMTP, provider credentials or a native SDK.

## Re-measured 2026-10-11 — Phase 9 (operator notifications), branch `arena/8de8de2e-ai`, Node v22.22.3

Same machine, same sandbox limits as the rows above: no MySQL/MariaDB server, no outbound
egress, no cPanel/Passenger host, no real browser, no SMTP, two CPUs. Everything below was
executed for this phase; nothing is inherited from an earlier row.

| Suite | Exact command | Result |
|---|---|---|
| Node platform (**30** files, was 27) | `cd apps/workforce-platform && npm test` | **522 passed, 0 failed** (~58 s) — was 482, **+40** |
| Install verification | `npm run verify:install` | **29/29 checks**, **64** documented env vars (unchanged — this phase adds no configuration). The migration check now lists `009_notifications.sql` and reports `store requires 9` |
| AEGIS PHP/WASM (the parity oracle) | `node runtime/run-tests.mjs` | **367 passed, 0 failed**, 18.3 s — unchanged, and `git status --porcelain` returns no path under `application/`, `system/` or `tests/` |

**Total executed in this sandbox for this phase: 889 passed, 0 failed** (522 app + 367 oracle).
Composition stated because these are two different runners and a bare total invites
double-counting. Scout (12), football-predictions (29) and the MT5-bridge `pytest` suite were
**not** re-run: Phase 9 touches no path they exercise.

New files in the platform suite:

| File | Cases | Note |
|---|---|---|
| `test/notifications_store.test.js` | **8** (new) | Both adapters against one contract. The file side is executed for real, including WAL replay of a notification across close/reopen and the global dedupe check afterwards; the MySQL side is pinned on SQL text and bound values through a recording executor, asserting that `(user_id IS NULL OR user_id = ?)` is the visibility predicate, that `LIMIT` is a bounded interpolation, that `markRead` is conditional on `read_at IS NULL`, and that the dedupe check contains no `user_id` at all |
| `test/notifications_service.test.js` | **20** (new) | The legacy `Notifier` rules — unread-dedupe, re-arming on acknowledgement, broadcast/targeted visibility, severity coercion to `info`, 200-character title truncation that does not split a surrogate pair — plus the Node-side bounds: payload size/depth/entry truncation is *stated in the row*, and a function, symbol, circular reference and non-finite number cannot reach storage. Also asserts a failing write is reported as `created:false` with a reason instead of breaking the publisher |
| `test/notifications_http.test.js` | **12** (new) | The three endpoints over HTTP, and the publishers that make them carry real events. Asserts the *complete* list of registered `/api/v1/notifications*` mutations so a publish route cannot be added quietly; that a targeted alert cannot be read — or discovered — through another operator's session; that CSRF applies to cookie mutations; that engaging the kill switch raises one deduped critical broadcast with the legacy key while re-affirming the boot state raises nothing; and that the governance action **still commits** when the notification write throws |

Ledger assertions updated because the counts they pin genuinely changed, not to make a failure
pass: `REPOSITORY_METHODS` **72 → 78** (`platform_findings`, `retention`, `strategies_store`),
migration placeholders **8 → 9** (`store`), migration-created tables **22 → 23** and the
entity→table map (`backup`), last migration file (`migrator`), file-store `stats()` shapes
(`platform_findings`, `strategies_store`), and the module-state ledger **ported 6 → 7 /
not-ported 6 → 5** (`platform_findings`).

One defect found by this phase's own tests and fixed before the row was written, rather than
re-run until green: publishing from inside `store.withPaperTransaction` **deadlocked** the file
adapter, whose single mutation queue is held for the whole transaction. The suite hung past a
600 s timeout instead of failing, which is the only reason it was caught. Recorded as **D-12**
in [`PHASE9_NOTIFICATIONS.md`](PHASE9_NOTIFICATIONS.md); every call site now queues the alert
inside the transaction and publishes it after commit, and both publish helpers carry the rule
in a comment. The same tests caught the inbox filter being destructured as `unreadOnly` while
the route contract and the legacy query string name it `unread`, so `?unread=1` silently
returned an unfiltered page.

Still not executed here, and therefore still not claimed: **real MySQL** — now including
migration `009` and all six methods of `notification-repository.js`, pinned on SQL text and
bound values through a recording executor (**F-15 stays open and is wider than it was**); any
**delivery** channel, since none exists (`emailDeliveryAvailable: false`, `deliveryChannels:
[]`) and the module says so in its own status snapshot; the console **UI**
(`views/notifications/index.php`, `/notifications`), so **F-29** still stands — no ported
module has a workspace console; **retention** for `wf_notifications`, which is unbounded with
no delete path, the same open question as R-27/R-28 and needing one decision rather than three;
a value-for-value **PHP↔Node diff** of notification behaviour (**F-26**) — the rules were ported
by reading the PHP and asserting them in Node, not by comparing outputs from both runtimes;
cross-worker **contention** on the conditional `UPDATE`, which is argued from the SQL rather
than observed; and anything needing a cPanel/Passenger host, a real browser, outbound SMTP,
provider credentials or a native SDK.

## Re-measured 2026-10-11 — Phase 10 (audit browser), branch `arena/8de8de2e-ai`, Node v22.22.3

Same machine, same sandbox limits as the rows above: no MySQL/MariaDB server, no outbound
egress, no cPanel/Passenger host, no real browser, no SMTP, two CPUs. Everything below was
executed for this phase; nothing is inherited from an earlier row.

| Suite | Exact command | Result |
|---|---|---|
| Node platform (**31** files, was 30) | `cd apps/workforce-platform && npm test` | **532 passed, 0 failed** (~64 s) — was 522, **+10** |
| Install verification | `npm run verify:install` | **29/29 checks**, **64** documented env vars — unchanged. This phase adds **no configuration and no migration**, so the migration check still reports `store requires 9` |
| AEGIS PHP/WASM (the parity oracle) | `node runtime/run-tests.mjs` | **367 passed, 0 failed**, 19.0 s — unchanged, and `git status --porcelain` reports **0** modified paths under `application/`, `system/` or `tests/` |

**Total executed in this sandbox for this phase: 899 passed, 0 failed** (532 app + 367 oracle).
Composition stated because these are two different runners and a bare total invites
double-counting. Scout (12), football-predictions (29) and the MT5-bridge `pytest` suite were
**not** re-run: Phase 10 touches no path they exercise.

New file in the platform suite:

| File | Cases | Note |
|---|---|---|
| `test/audit_browser.test.js` | **10** (new) | Attribution, authority and immutability rather than filter mechanics alone. Asserts every event carries a resolved actor and that a system event says `kind:"system"` instead of borrowing an identity; that a deleted actor keeps its id with a null username; that the endpoint needs `identity.users.view` where legacy needed only a signed-in user (**AV-1**); that `/account/activity` did **not** widen (a member's own view still has exactly one distinct actor while the browser over the same store has two); that an unparseable or inverted window is a 400; and — against the *whole route inventory*, not a written-down path list — that every route matching `/audit` or `/account/activity` is a `GET` and that no non-`GET` route anywhere matches `audit` |

The adapter-parity case in that file executes the file store for real (including WAL replay of
an audited event across close/reopen, with attribution **re-resolved** after replay rather than
stored as a stale copy) and pins the SQL adapter on a recording double that applies the `WHERE`
clause and the `ORDER BY` it is handed — asserting `e.actor_user_id IS NULL` for `actor=system`
binds nothing, that `from`/`to` bind as `Date` rather than as text, and that attribution comes
from a `LEFT JOIN wf_users`.

Ledger assertions updated because the counts they pin genuinely changed: admin routes **6 → 7**
and the module-state ledger **ported 7 → 8 / partial 3 → 2** (`platform_findings`), the latter
with a new assertion that the `audit` label still names both of its gaps — `no console screen`
and `no retention policy` — so `ported` cannot be read as a finished workstream.
`REPOSITORY_METHODS` stays at **78** and the migration set at **001–009**: this phase extends an
existing method's options and projection rather than adding surface.

Two defects found by this phase's own tests and fixed before the row was written, rather than
relaxing the assertions to match the code. **D-13:** the first window guard used
`Number.isFinite(Date.parse(value))`, and `Date.parse("12345")` is the **year 12345**, so
`?from=12345` was accepted and silently produced an empty window that looked like a filter
working; replaced by a canonical-UTC validator that also refuses a `+01:00` offset, because
`created_at` is `DATETIME(3)` with no timezone and the two adapters would otherwise disagree
about the same window (**AV-2**). **D-14:** the parity double returned every row regardless of
the `WHERE` clause and in insertion order, so the adapters "agreed" for reasons unrelated to the
code under test and then disagreed about ordering — it now applies the filters and the ordering
it is handed, which is what made the comparison mean anything.

Still not executed here, and therefore still not claimed: **real MySQL** — the extended
`listAuditEvents` is pinned on SQL text and bound values through a recording executor and has
never run against a server (**F-15 unchanged**), so the `LEFT JOIN wf_users` and the selectivity
of `ix_wf_audit_entity` are unmeasured and the index is *used by the query text*, not proven
selective; any **console screen** (`views/admin/index.php` unported, so **F-29 still stands** —
the SPA's existing `/app/account` activity list is unaffected because it reads named fields and
the `actor` projection is additive); a **retention policy** for `wf_audit_events`, unbounded with
no delete path, which is correct for evidence but leaves row 5's retention item undecided and
needing one policy covering audit, notifications, R-27 and R-28 rather than four; a
value-for-value **PHP↔Node diff** (**F-26**), where **AV-5** means the legacy `audit_logs`
(`type`/`summary`/`actor VARCHAR(8)`) and Node `wf_audit_events` (nullable actor FK) hold
different data models, so a row-level diff would not be meaningful; any **legacy `audit_logs`
import**, so a cutover starts the Node trail empty unless row 22 covers it; any **load
measurement** of pagination, which is proven bounded rather than measured under a large trail;
and anything needing a cPanel/Passenger host, a real browser, outbound SMTP, provider
credentials or a native SDK.

## Re-measured 2026-10-11 — Phase 11 (research-only portfolio optimization), branch `arena/8de8de2e-ai`, Node v22.22.3

Same machine, same sandbox limits as the rows above: no MySQL/MariaDB server, no outbound
egress, no cPanel/Passenger host, no real browser, no SMTP, no licensed market-data feed, two
CPUs. Everything below was executed for this phase; nothing is inherited from an earlier row.

| Suite | Exact command | Result |
|---|---|---|
| Node platform (**33** files, was 31) | `cd apps/workforce-platform && npm test` | **582 passed, 0 failed** (~74 s) — was 532, **+50** |
| Install verification | `npm run verify:install` | **29/29 checks**, **67** documented env vars (was 64 — the three new portfolio rate-limit variables are in `.env.example`). No new migration, so the migration check still reports `store requires 9` |
| AEGIS PHP/WASM (the parity oracle) | `node runtime/run-tests.mjs` | **367 passed, 0 failed**, 18.8 s — unchanged, and `git status --porcelain` reports **0** modified paths under `application/`, `system/` or `tests/` |

**Total executed in this sandbox for this phase: 949 passed, 0 failed** (582 app + 367 oracle).
Composition stated because these are two different runners and a bare total invites
double-counting. Scout (12), football-predictions (29) and the MT5-bridge `pytest` suite were
**not** re-run: Phase 11 touches no path they exercise.

Three new files, **50** cases:

| File | Cases | Note |
|---|---|---|
| `test/portfolio_optimizer.test.js` | **19** (new) | The pure numeric core. Asserts properties that make the output *trustworthy* rather than reproducing a number: every published allocation satisfies the constraints the report advertises (fully invested within 1e-9, long-only, within the cap) including the degenerate zero-variance case; minimum variance beats equal weight on volatility **and** favours the calmer of two assets; maximum Sharpe beats equal weight on the sample it was given; a cap below the concentration the optimum wants is respected and the best asset sits at it; the same input produces the same weights **exactly** (`deepEqual`, not a tolerance, so a future nondeterminism source cannot hide); a flat series yields the analytically derivable ridge artifact `sqrt(EPSILON·252)/√2 ≈ 1.581e-5` rather than `NaN`; alignment excludes unmatched timestamps and discloses it; duplicate timestamps are counted per symbol with first-row-wins; invalid candles are skipped and too few survivors is a refusal naming the symbol; the 12-asset maximum universe completes inside the iteration budget |
| `test/portfolio_service.test.js` | **18** (new) | The orchestration ported from `Platform::optimizePortfolio()`, against a fake speaking the real `marketData.candles({...})` seam. Both synthetic gates (all-synthetic refused until a **strict-boolean** opt-in, and then still labelled `SIMULATION:`; a **mixed** universe refused with no override — asserted across `undefined`/`false`/`true`); annualization inferred for one calendar and refused for a mixed universe; an explicit `periodsPerYear` overriding the inference; assets fetched with normalized symbol/class and the requested timeframe and limit; an unsupported `marketClass` refused **before any provider call**; a provider failure surfaced rather than swallowed into a smaller universe; no provider chain at all answering 503 rather than fabricating prices; the audit event carrying actor, objective, universe, selected weights and the legacy action key; an audit failure logged and never costing the caller a valid report |
| `test/portfolio_http.test.js` | **13** (new) | Authority (401 anonymous, 403 without `trading.view`, 403 `CSRF_INVALID` for a cookie session with a missing or wrong token); the legacy `{optimization: …}` envelope; the all-synthetic 422 → opted-in 200 transition; a host with `MARKET_DATA_ALLOW_SYNTHETIC=0` answering **503 `SYNTHETIC_DATA_DISABLED`** with a positive `Retry-After` where the flag cannot override it; `execute`/`amount`/`orderId`/`accountId`/`notional` each refused **by name** as `UNKNOWN_PROPERTY` at the top level and inside an asset; thirteen bound cases at 400; a `maxWeight` too small to be fully invested refused with a message naming the asset count; both objectives selecting the allocation they name; the per-session concurrency gate answering **429 `TOO_MANY_CONCURRENT_OPTIMIZATIONS`** and releasing its slot after both a refusal and a failure; the run visible in the Phase 10 audit browser at `?action=portfolio`; and a **refused** run recording nothing |
| — | **+1** | `the window limit is charged before validation, so malformed requests still count` — pinned separately because it is a cost-control property, not a convenience: garbage must not buy unlimited free requests just because it never reaches the provider chain |

Ledger assertions updated because the counts they pin genuinely changed: ported **8 → 9** and
modules **15 → 16** (`platform_findings`), plus three new label regexes requiring the
`portfolioOptimizer` label to keep saying `research-only`, `no console screen` and `no saved
reports`, so `ported` cannot be read as a finished workstream. `REPOSITORY_METHODS` stays at
**78** and the migration set at **001–009**: this phase adds no storage surface.

**A latent defect in shared infrastructure was found and fixed (D-15).**
`src/http/validate.js` threw a `TypeError` on any object-typed array item, surfacing as a 500:
the array branch forced `required: true` onto the item schema to mark the item mandatory, and the
object branch then read `schema.required` as the list of mandatory *keys* and called `.includes()`
on that boolean. It was **latent, not live** — every `items` node in the platform was a string
(`analysis/contracts.js` consensus symbols) until this phase declared the first object-typed one.
It is fixed rather than worked around, because a validator that crashes on a valid schema shape is
worse than one that rejects it, and the next nested-object schema would have hit the same 500.
Verified against eight schema shapes (valid, valid-with-options, `null` item, item missing
`symbol`, item missing `marketClass`, unknown item key, too-few items, no `assets`) **and by the
full 582-test suite**, since `validate.js` backs every route in the platform — that the count went
up rather than sideways is the evidence the fix did not weaken an existing contract.

Two further defects found by this phase's own tests and fixed before the row was written, rather
than relaxing the assertions. **D-16:** three locals in `optimizePortfolio` shadowed the
module-level solver functions of the same name, so `const f = f(...)` was a runtime
`ReferenceError` that took down 18 of 19 tests at once — `node --check` cannot see a
temporal-dead-zone error, only a syntax error. **D-17:** the service called
`marketData.getCandleSeries(...)`, which exists on the market-data **manager** but not on the
market-data **service** every other module consumes, so every request answered 503 "no provider
chain configured" on a host that had one; switched to `marketData.candles({...})`, the house seam
used by analysis, Strategy Lab and paper, which delegates to the same manager method and returns
the identical `{candles, provenance, validation}` shape while also applying the symbol floor and
market-class inference.

Still not executed here, and therefore still not claimed: **real market data** — every HTTP test
ran with `MARKET_DATA_REAL_PROVIDERS=0` and `MARKET_DATA_ALLOW_SYNTHETIC=1`, so no claim is made
that a licensed feed produces a well-conditioned covariance, and row 6's provider gaps are what
stop this module optimizing a real equity universe; a **numerical parity check against the PHP
implementation** (**F-26**) — the two were ported instruction-for-instruction and the constraints
are asserted, but no test runs the same candles through both engines and compares weights, which
is where F-26 bites hardest because divergence **PO-1** (keeping the legacy bisection projection
rather than the closed-form water filling) exists precisely to hold the numbers aligned and
nothing currently verifies that it does; a **console screen** (`views/portfolio/optimizer.php`
unported, so **F-29 still stands** — this is the third ported API with no screen, after
notifications and the audit browser); **saved reports** — a run is returned, never persisted, so
there is no history endpoint and a caller cannot read back what the platform told them last week,
only the audit event records that a run happened; a real **MySQL** server (**F-15 unchanged**,
though this phase adds no new SQL, writing only to the existing audit table); any **load
measurement**, the 12-asset bound (20 s on two cores) being a guard against a future change making
the inner loop quadratic rather than a performance benchmark; and anything needing a
cPanel/Passenger host, a real browser, outbound SMTP, provider credentials or a native SDK.

## Re-measured 2026-10-11 — Phase 12 (scheduled jobs, DB-backed lock, operations CLI), branch `arena/8de8de2e-ai`, Node v22.22.3

Same machine, same sandbox limits as the rows above, with one addition that matters for this
phase specifically: **no crontab and no Passenger**. Everything below was executed for this
phase; nothing is inherited from an earlier row.

| Suite | Exact command | Result |
|---|---|---|
| Node platform (**35** files, was 34) | `cd apps/workforce-platform && npm test` | **609 passed, 0 failed** (~78 s) — was 582, **+27** |
| Install verification | `npm run verify:install` | **29/29 checks**, **67** documented env vars (unchanged — the job’s knobs are CLI flags, not environment variables). Migration list now reports **10** required, `010_job_locks.sql` present on disk |
| AEGIS PHP/WASM (the parity oracle) | `node runtime/run-tests.mjs` | **367 passed, 0 failed**, 19.9 s — unchanged, and `git status --porcelain` reports **0** modified paths under `application/` or `tests/cases/` |
| Operations CLI (manual, not in `npm test`) | `STORAGE_DIR=… node tools/scheduled-jobs.mjs` then `--apply` twice | Dry run exit 0 writing nothing; apply exit 0 with the lock acquired and released; second apply exit 0 with 0 expired. All three printed the file-adapter warning that its lock is single-process only |

**Total executed in this sandbox for this phase: 976 passed, 0 failed** (609 app + 367 oracle).
Composition stated because these are two different runners and a bare total invites
double-counting. Scout (12), football-predictions (29) and the MT5-bridge `pytest` suite were
**not** re-run: Phase 12 touches no path they exercise.

Counting note, recorded rather than left to contradict the row above: the Phase 11 block says
**33** test files, and `git ls-tree eeb4b80 apps/workforce-platform/test/` counts **34** `.test.js`
files at that commit. The 34 is correct; the earlier row undercounted by one. This row counts
from the working tree, so 34 + `test/scheduled_jobs.test.js` = **35**.

One new file, **26** cases:

| File | Cases | Note |
|---|---|---|
| `test/scheduled_jobs.test.js` | **26** (new) | Locks (acquire / refuse / release / extend, expiry takeover, the overrun run being unable to release, durability across close/reopen); job state (the `'global'` governance key refused in both directions, the governance document byte-identical afterwards including `updatedByUserId`); the expiry sweep (dry run writing nothing, cross-owner expiry with per-proposal dedupe keys, idempotency, storage-failure and ownerless-row isolation); the risk sweep (a **real** `VALUATION_UNAVAILABLE` breach from the real paper service producing a keyed classified alert, per-owner isolation, ownerless accounts, edge-triggered transitions across three runs, clearing and re-raising, the persisted report dropping `key` and `classified`); the run (concurrent skip with no writes, the legacy `CRON_RUN` sentence and system actor, dry run taking no lock, `finally` releasing on a throwing stage); **no HTTP route** exposing any of it; and the MySQL SQL shapes, bindings and bounds against a recording executor |
| `test/migrator.test.js` | **+1** | Migration 010 creates exactly one statement and one table, keyed by `job_name`, with VARCHAR(32) canonical-UTC timestamps, the expiry index, and **no** `ALTER TABLE`, no `INSERT` and no live/broker/trading/paper/execution table |
| — | **2 tripwires moved** | `test/store.test.js` readiness now expects **10** placeholders and `010_job_locks` in the list; `test/migrator.test.js`’s last-migration pin moved `009_notifications.sql` → `010_job_locks.sql` |
| — | **6 counts moved** | Contract **84 → 86** (three pinned assertions); `stats()` deep-equal maps in `strategies_store` and `platform_findings` gained `jobLocks`; `backup.test.js` gained `jobLocks → wf_job_locks` and its F-13 table count moved **23 → 24**; `platform_findings` moved ledger rows **16 → 17** and partial **2 → 3**, and its `operational` script list gained `jobs` and `jobs:apply` |

Two of the 26 exist because they caught defects, and both are recorded as such in the phase
record: **D-18** (the two adapters returned different shapes for a job lock — `lock.expiresAt`
was a string on MySQL and `undefined` on the file store) and **D-19** (the scheduled expiry
audited the *owner* where legacy audited `'system'`). Neither was found by reading the code.

Still not executed here, and therefore still not claimed: **the lock against real MySQL**
(**F-15 unchanged**, and this phase is the first to make that gap consequential — mutual
exclusion is proven on the file adapter and the SQL is proven against a recording executor,
but no two real connections have raced for a row, so the duplicate-key arbiter is reasoned
rather than observed); **cPanel cron itself** — no crontab was installed, so the documented
line, the absolute `node` path and the `cd` are reasoned from the host’s behaviour, and the
requirement that the cron line source the same environment as the web app (`SESSION_SECRET`,
`DB_*`) because `loadConfig` is one gate for the whole platform was **discovered by running
the CLI** and seeing it refuse, not by deploying it; an **overlapping run produced by two real
processes** (the skip path is driven by holding the lock directly); the **500/5 000 batch
ceilings** (fixtures are small, so `exhausted: false` is asserted only through the SQL bound);
an **end-to-end run over a populated portfolio**, so the wall-clock duration — and therefore
whether the default 10-minute TTL is genuinely generous — is reasoned, not measured; and
anything needing a real browser, outbound SMTP, provider credentials or a native SDK.

## Re-measured 2026-10-12 — Phase 13 (Execution Supervisor reconciliation, blocked-routing evidence), branch `arena/8de8de2e-ai`, Node v22.22.3

Same machine, same sandbox limits as the rows above. Everything below was executed for this
phase; nothing is inherited from an earlier row.

| Suite | Exact command | Result |
|---|---|---|
| Node platform (**36** files, was 35) | `cd apps/workforce-platform && npm test` | **616 passed, 0 failed** (~87 s) — was 609, **+7** |
| Install verification | `cd apps/workforce-platform && npm run verify:install` | **29/29 checks**, **67** documented env vars (unchanged). Migration list still reports **10** required — `001`–`010`, no new file |
| AEGIS PHP/WASM (the parity oracle) | `node runtime/run-tests.mjs` | **367 passed, 0 failed**, 20.7 s — unchanged, and `git status --porcelain application/ tests/cases/` reports **0** modified paths |

**Total executed in this sandbox for this phase: 983 passed, 0 failed** (616 app + 367 oracle).
Composition stated because these are two different runners and a bare total invites
double-counting. Scout (12), football-predictions (29) and the MT5-bridge `pytest` suite were
**not** re-run: Phase 13 touches no path they exercise.

One new file, **7** cases, and **no change to any count the suite pins** — no migration, no
contract method, no route, no table, no ledger row:

| File | Cases | Note |
|---|---|---|
| `test/execution_governance.test.js` | **7** (new) | An approval granted while the platform was live cannot become an order after the kill switch is thrown, and the paper engine is never reached; the blocked attempt leaves **exactly one** audit event — not zero (rolled back with the transaction) and not two; **three** refusals on one UTC day produce **one** broadcast alert and the next UTC day produces another, while every attempt is still individually audited; a trading-mode flip blocks identically; **recovery** — the same proposal submits once governance is restored and reaches the paper engine exactly once; owner scoping — a foreign owner gets the owner-scoped **404**, not a governance answer, and records no blocked-submission evidence; and a broken audit writer plus a broken notifier each still surface the real 409 |
| `test/execution_service.test.js` | **+0** cases, **assertions strengthened** | The pinned audit-action sequence moved **4 → 7** because the three refusals this test already provokes are now recorded. It also asserts each blocked event's `legacyAction`, `code`, `orderCreated: false`, `retryable: true` and `actor_user_id`, and that no `ROUTING_BLOCKED` was published for caller-state refusals |
| `test/execution_http.test.js` | **+0** cases, **assertions strengthened** | Sequence moved **4 → 5** for the deterministic `pendingSubmit` 409. A **non-vacuity guard** (`assert.ok(inbox.length > 0)`) was added before the "no `ROUTING_BLOCKED` in the inbox" assertion, because an empty inbox would have made that assertion pass for the wrong reason |
| `test/platform_findings.test.js` | **+0** cases, **assertions added** | The `execution` label is now pinned to `/blocked-submission evidence/`, `/broker-bound/`, `/no live route/` and `/no automated mode/`, matching the convention already applied to `audit`, `portfolioOptimizer` and `scheduledJobs`. `partial` must keep saying *what* is missing, not just hedge |

The label change in `src/modules/platform/health.js` is why `platform_findings` needed touching
at all; the state stayed **`partial`** and the ledger stayed at 9 ported / 3 partial /
5 not-ported across 17 modules.

Still not executed here, and therefore still not claimed: **no broker-bound supervisor step was
exercised**, because none was ported — steps 4–9 and 12–15 have no Node code path, so nothing
in this row is evidence about them; **the daily dedupe is proven on the file adapter only**
(`hasUnreadNotificationDedupe` is Phase 9 machinery, pinned on MySQL by a recording executor
and never run against a server — **F-15 unchanged**); **concurrency was simulated, not raced** —
the "concurrent submit" case gates one submission in `PAPER_SUBMITTING` and attempts another
inside a single process, so two real Passenger workers claiming one proposal remains untested
(**F-24** is the same unresolved question elsewhere); **no legacy `trade_executions` import**,
because no Node equivalent exists; and **the reconciliation itself is a reading, not a
differential test** (**F-26 stands**) — every verdict in the Phase 13 step table was reached by
reading both implementations, not by running one intent through PHP and Node and comparing.

Reproducibility note for this sandbox: `node_modules` does not persist between sessions, so
`npm ci --no-audit --no-fund` at the repository root (291 packages) and a separate
`npm ci` inside `runtime/` (29 packages) were both required before the two runners above would
start. A previously-green test failing with `ERR_MODULE_NOT_FOUND` on `bcryptjs` is that
condition, not a regression.

## Re-measured 2026-10-12 — Phase 14 (Broker Center: connector boundary, health and demo gates), branch `arena/8de8de2e-ai`, Node v22.22.3

Same machine, same sandbox limits as the rows above. Everything below was executed for this
phase; nothing is inherited from an earlier row.

| Suite | Exact command | Result |
|---|---|---|
| Node platform (**39** files, was 36) | `cd apps/workforce-platform && npm test` | **689 passed, 0 failed** (~105 s) — was 616, **+73** |
| Install verification | `cd apps/workforce-platform && npm run verify:install` | **29/29 checks**, **69** documented env vars (was 67). Migration list still reports **10** required — `001`–`010`, no new file |
| AEGIS PHP/WASM (the parity oracle) | `node runtime/run-tests.mjs` | **367 passed, 0 failed**, 23.0 s — unchanged, and `git status --porcelain application/ system/ tests/` reports **0** modified paths |

**Total executed in this sandbox for this phase: 1 056 passed, 0 failed** (689 app + 367 oracle).
Scout (12), football-predictions (29) and the MT5-bridge `pytest` suite were **not** re-run:
Phase 14 touches no path they exercise, and the bridge service itself is unchanged — this phase
ports the *client* of its contract, not the contract.

Three new files, **73** cases. **No new migration, no new contract method, no new table** —
connector state is configuration plus probe results and neither is persisted. The only new
persisted field is `brokerStates` inside the existing `PORTFOLIO_RISK_STATE_KEY` job-state
document, exactly where legacy kept it.

| File | Cases | Note |
|---|---|---|
| `test/brokers.test.js` | **57** (new) | The nine normalized data contracts and every refusal in them (negative account values, inverted quote, candle whose high is below its low, non-positive stop, unknown enum, unparseable timestamp, a present-and-null `symbol`, PHP `array_key_exists` semantics on the account row); the four-state ladder; a **nine-row gate table** each asserting the verdict *and* that `capabilities()` disagrees with it where it should — intent versus permission; **every write refused at every gate with an assertion that no order request reached the transport**; the forced re-probe on writes and the 5-second cache on reads; the health probe carrying **no token** while data reads carry one; secret non-leakage from a status or an error; order-body validation, clamping and the `action` wire key; ticket validation before it becomes a path segment; the manager's routing verdict in five configurations; duplicate-registration refusal; per-connector degradation to an `ERROR` entry; the ten-connector registry performing **zero I/O**; and roster↔config agreement including MT5's irregular variable names |
| `test/brokers_http.test.js` | **6** (new) | The **F-32** permission gate at 401 anonymous / 403 without `trading.view` / 200 with it; the default body — ten `DISABLED` connectors, `routable: false`, nine `PLANNED` rows in legacy's wording — with no token, no loopback address and no `Bearer` anywhere in the serialized response; a route-inventory proof of exactly one broker route, no write route, no simulated-bridge toggle, and **every order-shaped route belonging to `/api/v1/paper`** (scoped with a non-vacuity guard, after an unscoped pattern matched paper's legitimate simulation routes); the probe-free public status surface; a configured-but-unreachable bridge reporting `DOWN` while `routable` stays false; and the config gate refusing a remote plain-HTTP URL, credentials inside a URL, a non-boolean flag and an out-of-range timeout |
| `test/broker_transitions.test.js` | **10** (new) | Ten disabled connectors silent across two runs; `READY → DOWN` audited, broadcast `critical` and joining the alert list with **both dedupe keys asserted distinct** (the alert key is `broker:<id>:BROKER_DISCONNECTED`, the notification key is `broker:<id>:disconnected`); `DOWN → READY` audited and notified `info` with no alert; the one-cycle alert then reported cleared while still down (**BC-13**, pinned across three runs); unread-dedupe suppressing a second disconnect while both are audited; a dry run probing but writing nothing; **exactly one** `allStatus()` call per sweep (**BC-12**); no registry meaning no broker fields at all, so Phase 12's report shape is byte-identical; a throwing registry degrading to `brokerError` and zero alerts rather than a mass disconnect or a failed sweep; and `NOT_CONFIGURED` / `ERROR` / `DISABLED` never counting as a disconnect |

**Four pre-existing assertions were updated, all of them ledger pins rather than behaviour:**
the `trading.reason` regex in `test/platform_findings.test.js` and `test/analysis_http.test.js`
(the reason string now explains that the connector boundary is ported but no order can be
routed, and points at `routable` for the probed answer); the module-status ledger counts
(`partial` 3 → **4**, `not-ported` 5 → **4**, 17 rows unchanged); one "other modules
unaffected" assertion in `test/notifications_http.test.js` re-pointed from `brokers` to
`sports`, because `brokers` is now legitimately `partial`; and four new label pins requiring
the `brokers` label to say *all disabled by default*, *no order routing*, *no adapter verified
against its provider* and *one read-only route*. `adminRoutes.length` stays **7**.

**The strengthened F-33 gate is itself a measurement.** Enumerating prefix × suffix from the
config's exported tables yields **71 composed variable names** (4 licensed-feed prefixes × 7
suffixes, plus 10 broker prefixes × 5 suffixes with MT5's two overrides). **21 of them were
pre-existing undocumented gaps** — `AEGIS_ETF_DATA_*`, `AEGIS_FUTURES_DATA_*`,
`AEGIS_OPTIONS_DATA_*` — which the old literal-text scan could not see. All 71 are now in
`.env.example`. Closing a blind spot in a gate should be expected to report pre-existing
failures; that is the gate working.

**Two defects were found by these tests and fixed before commit**, neither of which was
visible by reading the port:

| | Defect | How the test caught it |
|---|---|---|
| **D-20** | `read()` refused an array `data` payload. Legacy checked PHP's `is_array()`, which is true for a list *and* a map; the four list endpoints return a JSON array as `data` | A test asked for `history` from a bridge answering `{ok: true, data: []}`. The port would have rejected **every successful list read** — positions, orders, history and candles |
| **D-21** | The config composed MT5's trading flags as `AEGIS_MT5_BRIDGE_TRADING_ENABLED`; legacy reads `AEGIS_MT5_TRADING_ENABLED` and `AEGIS_MT5_LIVE_ALLOWED`, **without** the `_BRIDGE` infix that its URL, token and enabled flag carry | A test set the legacy name and asserted the flag took effect. The uniform composition rule would have left the **only connector that can actually work** permanently switched off, with the documented variable silently doing nothing — F-30's shape, in configuration |

**Not exercised, therefore not claimed.** No adapter has spoken to its provider: every gate
test runs against an injected transport, which is how legacy tested its own bridge and is why
the gates are provable here. **No order has been placed by any path** — `placeOrder` is tested
to refuse, and to build a correct body against a fake transport; the one test that configures a
connector points it at loopback port 9, where nothing listens. **Row 13's own acceptance
criterion is unmet and cannot be met in this sandbox:** "verify MT5 against a real demo
terminal before any real-routing claim" needs a Windows host running MetaTrader 5, and **no
real-routing claim is made anywhere in this phase**. The PHP↔Node differential harness still
does not exist (**F-26 stands**), although this phase made it the cheapest it has ever been:
`BrokerDataNormalizer` is pure on both sides, its messages are byte-identical, and its
timestamps now match. Concurrency and multi-process behaviour are unchanged (**F-24**), but
note that broker probing adds an outbound call *inside* the sweep's lock, so a host with slow
bridges now spends more of its lock TTL waiting; 8 s × 10 connectors is bounded but unmeasured
against a real deployment. No real MySQL (**F-15**), unchanged rather than widened — this
phase adds no SQL.

Reproducibility note for this sandbox: `node_modules` does not persist between sessions, so
`npm ci --no-audit --no-fund` at the repository root and a separate `npm ci` inside `runtime/`
were both required before the two runners above would start.
