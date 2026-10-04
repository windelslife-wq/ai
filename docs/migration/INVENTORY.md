# Phase 0 — Repository Inventory (Read-Only Audit)

**Audit date:** 2026-10-05
**Audited commit:** `675a05c` ("docs: add full Node.js and cPanel migration master plan"), branch `arena/01a10934-ai` (includes `migration/javascript-node-cpanel`)
**Method:** full inspection of every tracked file and directory in `windelslife-wq/ai` (690 tracked files), cross-checked against README claims, with every test suite executed (see `BASELINE_TESTS.md`). No application code was modified during this audit.

This document is the deliverable required by the migration master plan (§11 Phase 0): what exists, where, and whether it is actually implemented versus planned/scaffolded. Companion documents: `ROUTE_MAP.md`, `DATA_DICTIONARY.md`, `RISK_REGISTER.md`, `BASELINE_TESTS.md`.

---

## 1. Executive summary

The repository is **not a single application**. It contains **four independent runtime applications plus one development-only runtime**, sharing one repository and one product brand (WINDELS AI WORKFORCE; internal code name "AEGIS" is deliberately retained in code, env vars and table names — see README header note):

| # | Application | Runtime | Storage | Status | Approx. size |
|---|---|---|---|---|---|
| 1 | **AEGIS platform** (main product: trading intelligence, sports, lottery, language learning, lead discovery, auth/admin, public site) | PHP 8.1–8.3, CodeIgniter 3.1.13 (framework vendored in `system/`, no Composer) | MySQL/MariaDB via `mysqli` (production) / SQLite via `pdo_sqlite` (dev) | Production target; **357 automated tests green** | 253 files in `application/`, 30,820 LOC + 206 CI3 core files (67,050 LOC, unmodified) |
| 2 | **Scout / Lead Discovery** (standalone) | Node.js, Fastify 5 + TypeScript (API), Next.js 16 / React 19 / Tailwind (web) | **PostgreSQL + Redis** (JWT auth + refresh tokens) | Implemented; **12 contract tests green**; typecheck clean | `apps/api` + `apps/web` + `packages/shared`, ~2,266 LOC TS/TSX |
| 3 | **Football Predictions** (Over 1.5 goals) — added 2026-10-04 via PR #2 | Node.js 22, Express 5, vanilla-JS front end | MySQL/MariaDB (`mysql2`), session auth (`fp_sessions`) | Implemented; **29 tests green**; **explicitly "staging validation required", not production-verified** (own `docs/FINAL_AUDIT.md`) | `apps/football-predictions/`, 2,709 LOC JS, 19 tracked `fp_*` tables |
| 4 | **MT5 bridge** (broker gateway for app #1) | Python 3, FastAPI + `MetaTrader5` package (**Windows-only** for the real terminal) | In-memory/stateless over the MT5 terminal | Implemented + **9 contract tests green against a FAKE terminal**; never verified against a real MetaTrader terminal | `python-services/mt5-bridge/`, 540 LOC |
| 5 | **Offline dev runtime** (dev/demo only, *not* part of production) | Node.js + `@php-wasm/node` 3.1.50 (WASM PHP 8.2) | SQLite (dev driver) + marker-file simulated MT5 bridge on loopback :8790 | Dev-only bridge that hosts app #1 and runs its test suite without native PHP | `runtime/`, 442 LOC + `tools/` (installer, RBAC matrix, sports indexes) |

**Total automated tests executed in this audit: 407 — all passing** (357 PHP + 12 Scout/TS + 29 football + 9 bridge). Exact commands and evidence: `BASELINE_TESTS.md`.

**Important scope finding:** the master plan's module list (§3) does **not** mention the Football Predictions app (`apps/football-predictions`), which was merged after the plan was drafted. Per the plan's own rule ("Search all route declarations… for modules not listed here. Add them to the inventory before implementation"), it has been added to this inventory (§3.12) and to `RISK_REGISTER.md` (R-01).

---

## 2. Top-level repository map

| Path | Purpose | Phase-0 notes |
|---|---|---|
| `index.php` | CI3 front controller (+ dev-bridge URI adapter for the WASM runtime) | Single entry point; `.htaccess` rewrites everything to it |
| `.htaccess` | Apache rules | Disables indexes; **blocks HTTP access to `database/`, `tools/`, `tests/`, `runtime/`**; denies `.env`/`.env.example`; rewrites to `index.php` |
| `application/` | The AEGIS PHP application (config, controllers, models, libraries, views, SQL schemas) | See §3 |
| `system/` | CodeIgniter 3.1.13 core, vendored, unmodified | No Composer manifests anywhere — zero external PHP dependencies |
| `apps/api`, `apps/web`, `packages/shared` | Scout lead-discovery platform (Fastify/TS + Next.js + shared zod contracts) | Independent stack: PostgreSQL + Redis (own `docker-compose.lead-discovery.yml`) |
| `apps/football-predictions` | Isolated Over-1.5 football prediction app (Express 5 + MySQL + vanilla UI) | Own migration, CLI jobs, admin UI, tests, full docs set incl. cPanel guide |
| `python-services/mt5-bridge/` | FastAPI MT5 bridge (`app.py`, `test_bridge.py`, requirements, README) | Bearer-token auth; demo-gated; Windows host required for real use |
| `runtime/` | Dev-only WASM PHP server (`server.mjs`) + test runner (`run-tests.mjs`) | Not production; README states this explicitly |
| `tools/` | `install.php` (schema installer, mysqli or sqlite), `rbac.php` (shared RBAC seed matrix), `sports_indexes.php` | CLI entry points under `php index.php tools …` |
| `tests/` | `framework.php` (zero-dependency micro test framework) + `cases/` (**67 case files**, numbered `01-…-66`, incl. two files numbered `28`) | 357 tests through the real CI3 stack |
| `database/production.sql` | 86 KB production import for cPanel phpMyAdmin | 79 tables + seed data — **includes initial administrator account with committed bcrypt hash** (R-08) |
| `application-deployment.zip` | 2.4 MB committed deployment snapshot (573 files, dated 2026-08-24) | **Stale vs. current tree — 29+ files differ** (R-03) |
| `docs/` | `CPANEL_DEPLOYMENT.md`, `LEAD_DISCOVERY.md`, `SPORTS_INTELLIGENCE_ARCHITECTURE.md`, `SPORTS_PRODUCTION_REVIEW.md`, `UI_AUDIT_REPORT.md`, `migration/NODEJS_CPANEL_MIGRATION_MASTER_PLAN.md` | Current PHP cPanel flow + sports integration plan + UI audit (2026-08-24) |
| `assets/` | Public assets: 3 CSS, 4 JS (`aegis-chat.js`, `app-shell.js`, `public.js`, `speech-provider.js`), images | No CDN dependencies (self-contained) |
| `docker-compose.yml` | Legacy AEGIS stack (php:8.2-apache + MariaDB 11) — **never exercised in the dev sandbox** (stated in file header) | Dev/host convenience only |
| `docker-compose.lead-discovery.yml` | Scout stack (PostgreSQL 16 + Redis 7) | Dev convenience only |
| `package.json` / `package-lock.json` / `tsconfig.json` (root) | npm workspaces root (`packages/*`, `apps/*`) + Scout typecheck/test scripts | **Lockfile out of sync — `npm ci` fails** (R-04) |
| `.env.example` | Full production environment template (VP_*/AEGIS_*, SMTP, MT5 bridge, provider scaffolds, Scout vars) | Documents every configuration knob; loaded by `application/config/env.php` |
| `data/` | Empty (gitkeep) | Legacy output dir |

Git history (GitHub): PR #1 "Import Windels AI Workforce application" → PR #2 "isolated Over 1.5 football predictions (staging validation required)" → PR #3 migration plan. The local clone is shallow (2 commits) — full history lives on GitHub.

---

## 3. Module inventory (implemented vs. scaffolded/planned)

Status legend: **TESTED** = implemented with passing automated tests executed in this audit; **IMPLEMENTED (unverified)** = code complete but not verifiable in this environment (needs external service/host); **SCAFFOLD** = provider-neutral boundary exists, disabled by default, no real provider; **PLANNED** = documented intent only.

### 3.1 Core platform & identity (PHP app)

| Capability | Location | Status | Notes |
|---|---|---|---|
| Auth: login (username, email **or 6-digit User ID**), register, forgot-password (mailer), logout (POST + CSRF), account self-service (username/email/password/avatar) | `application/controllers/Auth.php`, `views/auth/*`, `Aegis/Identity.php` | **TESTED** (cases 63, 66) | `password_verify` + `password_hash(PASSWORD_DEFAULT)` (= bcrypt, `$2y$10$`). Sessions: CI3 `files` driver in production, `database` (`ci_sessions` table) in dev bridge. Unique per-user 6-digit UID. |
| RBAC: roles/permissions/user_roles tables, seeded matrix | `tools/rbac.php`, `Tools::seedAccessControls`, `MY_Controller` | **TESTED** (31, 49) | 7 seeded roles, 10 seeded permissions (trading.view/control/execute, sports.*, lottery.*, system.super_admin). Deny-by-default; server-side checks on every protected route. |
| Admin console | `controllers/Admin.php`, `views/admin/` | **TESTED** (63) | User create/toggle, test email. |
| Workspace dashboard / app shell | `controllers/Workspace.php`, `Welcome.php`, `views/workspace|welcome`, `assets/js/app-shell.js` | **TESTED** (65 UI audit click-through) | Sidebar/profile/logout audited. |
| Notifications (risk alerts, approvals, executions, broker events, kill switch; unread dedupe) | `controllers/Notifications.php`, `Api_system`, `Aegis/Notifications/Notifier.php`, `notifications` table | **TESTED** (29) | Badge-per-issue until acknowledged. |
| Audit log | `audit_logs` table + `Aegis/Persistence/…/AuditRepository` | **TESTED** | Every order/proposal/execution/cron/governance action audited. |
| Public site & SEO | `controllers/Site.php`, `Seo.php`, `views/site/*`, `config/seo.php` | **TESTED** (65) | about/services/how-it-works/locations/safety/faq/contact (+submit), robots.txt, sitemap.xml; dashboards excluded from indexing. |
| Chat assistant | `controllers/Api_chat.php`, `Aegis/ChatAssistant.php`, `assets/js/aegis-chat.js`, `views/partials/chat_widget.php` | **TESTED** | Safe built-in product guide by default; optional real OpenAI-compatible provider via server-side env only. |
| Mailer (SMTP) | `Aegis/Mailer.php`, `config/email.php`, `.env.example` | **IMPLEMENTED (unverified here)** | cPanel mail host expected; disabled until configured. |
| Feature/status honesty matrix | `GET /api/system/features` | **TESTED** (62) | Scaffolds render as PLANNED, never as live. |

### 3.2 Market data & providers (PHP app)

| Capability | Location | Status |
|---|---|---|
| Provider abstraction: health checks, retry, timeout, circuit breaker, cache, fallback, provenance, market-class routing | `Aegis/ProviderManager.php`, `CircuitBreaker.php`, `Http.php` | **TESTED** (02) |
| Real providers: Binance (crypto), Frankfurter/ECB (forex) | `Aegis/Providers/BinanceProvider.php`, `FrankfurterProvider.php` | **TESTED** (02) — live network calls verified only insofar as tests exercise the code path (tests run offline with deterministic fixtures) |
| Labeled synthetic demo provider | `Aegis/Providers/SyntheticProvider.php` | **TESTED** — `provenance.synthetic` flows end-to-end |
| Candle normalization, timeframes, indicators, math utils | `CandleNormalizer.php`, `Timeframes.php`, `Indicators.php`, `MathUtils.php` | **TESTED** (01) |
| Fundamentals feed boundary (abstains until licensed feed) | `Providers/FundamentalsFeed.php` | **TESTED** (11) — abstention behavior |
| Sentiment feed contract (provenance + 1h freshness floor, abstains otherwise) | `Providers/SentimentFeed.php` | **TESTED** (52) |
| Licensed asset market data (stock/ETF/futures/options) | `Providers/LicensedAssetMarketDataProvider.php` | **SCAFFOLD** — disabled by default, requires URL+license+token+symbol allow-list (case 62 pins the disabled behavior) |

### 3.3 Analysis engines & AI agents (PHP app)

| Capability | Location | Status |
|---|---|---|
| Regime detection + trade-setup generator | `Aegis/Analysis.php` | **TESTED** (03) |
| Specialized agents: Technical, MarketStructure, Forex, Crypto, Sentiment, Fundamentals (abstaining), TradingIntelligence | `Aegis/Agents/*` (7 files) | **TESTED** (03, 11) |
| Consensus engine + adversarial debate (bull/bear advocates, skeptic, risk critic; verdicts can only reduce bias) | `Agents/AgentDebate.php`, `AgentHelper.php` | **TESTED** (34) — debate transcript ships with every analysis run |
| Analysis history persistence | `analysis_runs` table, `Api_analysis.php` | **TESTED** |
| Agents never touch brokers or connectors | Enforced structurally (agents receive `AnalysisContext` only) | **TESTED** (negative tests) |

### 3.4 Strategies, backtesting, optimization (PHP app)

| Capability | Location | Status |
|---|---|---|
| Strategy registry + versioning + evidence-gated lifecycle (DRAFT→BACKTESTED→VALIDATED→RISK_REVIEWED→PAPER_TRADING→APPROVED; APPROVED requires ≥10 closed paper trades, PF>1, positive expectancy) | `Aegis/Strategies/StrategyRegistry.php`, `BuiltinStrategies.php` | **TESTED** (05) |
| 4 built-in strategies (trend-following, mean-reversion, breakout, momentum) — seeded DRAFT | `BuiltinStrategies.php`, `database/production.sql` | **TESTED** |
| Backtester: next-bar fills, cost model, pessimistic stop-first rule, look-ahead guard | `Aegis/Backtest/{Backtester,Metrics}.php`, `Strategies/SeriesView.php` | **TESTED** (06) |
| Strategy optimizer: grid search on first 70%, **out-of-sample verification** on last 30%; winners become `source=ai` DRAFT versions requiring human sign-off | `Aegis/Optimization/StrategyOptimizer.php` | **TESTED** (33) |
| Journal + analytics + confidence calibration | `Aegis/Journal/Analytics.php`, `Api_journal.php` | **TESTED** (08) |

### 3.5 Paper trading, risk, execution, brokers (PHP app) — trading-safety core

| Capability | Location | Status |
|---|---|---|
| Paper engine: accounts, orders (market/limit), fills, positions, ticks, strategy deployments; full governance chain before every fill | `Aegis/Paper/PaperTradingEngine.php`, `Api_paper.php`, `Paper.php` | **TESTED** (07) |
| Risk Engine: independent veto — exposure, drawdown, daily/weekly loss, notional/leverage/risk%/RR on **actual order volume** | `Aegis/RiskEngine.php` | **TESTED** (04) |
| **Trade Execution Supervisor — ordered 15-step pipeline** (kill switch → mode → strategy → broker connection (bridge-verified) → market session → data freshness → duplicates → symbol permissions → margin → risk engine + automation envelope → human approval → place → confirm → audit → portfolio snapshot) | `Aegis/ExecutionSupervisor.php` (31.7 KB; pipeline enumerated in file header and code) | **TESTED** (10) |
| Execution modes HUMAN_APPROVAL / SEMI_AUTONOMOUS / FULLY_AUTOMATED + automation envelope (max notional, daily cap, risk %, approved symbols) | `ExecutionSupervisor.php`, `Api_system::execution_*` | **TESTED** |
| Durable proposals, approval records, proposal expiry, duplicate protection, immutable audit | `trade_proposals`, `trade_executions`, `audit_logs` | **TESTED** (10, 30) |
| Kill switch: boot state ACTIVE + `ANALYSIS_ONLY` default; checked first and re-verified at routing | `platform_state` seed, supervisor, paper engine | **TESTED** |
| Portfolio risk monitor: HIGH_EXPOSURE, EXCESSIVE_LEVERAGE, CORRELATED_POSITIONS (disclosed static groups, labeled heuristic), MAX_DRAWDOWN_WARNING, DAILY_LOSS_WARNING, BROKER_DISCONNECTED | `Aegis/Portfolio/PortfolioRiskMonitor.php` | **TESTED** (28) |
| Broker connector contracts + data normalizer | `Aegis/Brokers/{BrokerConnector,TradingConnector,BrokerDataNormalizer,ConfiguredTradingConnectors,DemoBridgeConfig}.php` | **TESTED** (09) |
| MT5 connector: full trading surface (account/quote/candles/positions/orders/history + place/modify/cancel/close) via HTTP bridge | `Aegis/Brokers/Mt5BridgeConnector.php` | **TESTED** (simulated bridge only — 32; real terminal unverified) |
| MT4 / crypto exchanges / stock brokers (Binance, Bybit, OKX, Coinbase, Kraken, IB, Alpaca, OANDA) | `ConfiguredTradingConnectors.php` | **SCAFFOLD** — provider-neutral boundary, disabled by default (case 62) |
| Python MT5 bridge service | `python-services/mt5-bridge/app.py` (11 endpoints: health, account, quotes, candles, positions, orders GET/POST, modify, cancel, close, history) | **IMPLEMENTED (unverified)** — 9 contract tests pass against a **fake terminal**; requires Windows host + demo terminal |

### 3.6 Sports intelligence (PHP app)

Full pipeline: 31 service classes under `Aegis/Sports/` (prediction pipeline, feature engineering, value engine, confidence engine, calibration engine, odds freshness, data quality, match intelligence, decision recorder, result verification + persisted-result verifier, ticket governance/optimizer/settlement, daily ticket service, sports backtester, model drift monitor, model performance, performance analytics, provider health monitor, sync service, normalizers, risk engine, correlation engine, configuration service, cron service) + `Api_sports.php` (~35 routes) + `Sports.php`/`Sports.php` pages + 18 `sports_*` tables.

- **Status: TESTED** — cases 12–22, 40–51 (foundation, identity/RBAC, sync, match intelligence, prediction, value/risk, ticket optimizer, decision recorder, results + normalizer, performance, configuration, calibration, providers, daily-ticket E2E, settlement, backtester, model monitoring, provider health, pipeline gates, RBAC, dashboard UI, production review).
- `docs/SPORTS_PRODUCTION_REVIEW.md`: code-level review complete, both findings remediated and pinned by tests; **process-level cutover items remain**.
- Provider reality: only "manual / approved source" seeded; no live sports data provider is configured (honest `DISABLED_NO_PROVIDER`-style behavior elsewhere in the codebase sets the pattern).

### 3.7 Lottery intelligence (PHP app, EuroMillions first)

| Capability | Location | Status |
|---|---|---|
| Rules engine (5/1–50 + 2/1–12, Tue/Fri 21:00 UTC), DB-updatable | `Aegis/Lottery/LotteryRules.php`, `lottery_rules` | **TESTED** (53) |
| Provider abstraction: `UnavailableLotteryProvider` default + env-gated `SandboxLotteryProvider`; official feeds | `LotteryProvider.php`, `OfficialLotteryProvider.php` | **TESTED** (54, 62) / official feed **SCAFFOLD** |
| Ingestion: validation (count/range/dup/date/source), idempotent imports, verified draws never silently overwritten, conflict audit | `LotteryResultValidator.php`, sync runs | **TESTED** (54) |
| Statistics engine (frequency/gaps/hot-cold windows/distribution/pairs), combination analyzer (labelled BALANCE SCORE N/100, non-probability) | `LotteryStatisticsEngine.php`, `CombinationAnalyzer.php` | **TESTED** (55) |
| 5-mode generator (RANDOM/BALANCED/HISTORICAL/DIVERSIFIED/ANTI-POPULAR) with lock/exclude, seeded reproducibility, AI decision reports | `CombinationGenerator.php` | **TESTED** (57) |
| Diversification engine (exact overlap math, DIVERSITY SCORE N/100) | `DiversificationEngine.php` | **TESTED** (58) |
| System builder (C(N,5)×C(S,2), lazy enumeration, >10k lines queued to idempotent cron) | `SystemBuilder.php` | **TESTED** (59) |
| Tickets (user-scoped, per-line validation, official-tier checking, amounts never stored), backtesting with mandatory RANDOM_BASELINE + same-period comparison, model versioning (immutable), separated performance overview | `lottery_tickets*`, `LotteryBacktester.php` | **TESTED** (60, 61, 56 governance E2E) |
| Honesty contract (independence disclaimers, no "due" numbers, no fabricated prizes/costs) | throughout + tests | **TESTED** |

### 3.8 Language learning / AI teacher (PHP app)

20-language registry (incl. Dutch, Spanish, Yoruba, Igbo, Hausa, Swahili, Zulu…), learner profiles with strict ownership isolation, adaptive staircase assessments over authored item banks (levels capped at bank ceiling; listening/speaking/writing honestly "not assessed" in assessment), CEFR learning paths with checkpoint quizzes (≥75%), lessons (teach→examples→practice→grade), conversation drills, guided writing (original text preserved), grammar with simpler explanations, 10-word-per-language vocabulary bank + real spaced repetition (1→3→7→14→30→90 days), listening via browser speechSynthesis (feature-detected, honest fallback), speaking via browser SpeechRecognition (no pronunciation/fluency scores ever), adaptive weakness detection citing evidence, daily plans from real state, full history.

- Location: `Aegis/LangLearn/*` (12 services), `controllers/{Api_lang_learning,Lang_learn}.php`, `views/langlearn/*` (16 views), 16 `language_*`/vocab tables, ~35 `/api/v1/language-learning` routes + ~30 `/app/languages` page routes.
- **Status: TESTED** — cases 35–39 (learning, teacher, vocabulary, listening+speaking, adaptive) — all five phases complete per README and test evidence.

### 3.9 Lead discovery — ⚠️ two parallel implementations

| Implementation | Stack | Auth | Storage | Status |
|---|---|---|---|---|
| **A. Native CI3 module** — `Api_lead_discovery.php` (20 routes `/api/v1/lead-discovery/*`), `libraries/LeadDiscovery/*` (Google Places provider, dedup, registry), `Leads.php` pages (`/leads`, `/lead-pipeline`), 11 MySQL `lead_*`/`collection*` tables | Part of the AEGIS PHP app | CI3 session + RBAC (`system.authenticated`), org resolved only from memberships (client org IDs never trusted), CSRF on mutations | MySQL (canonical `production.sql`) | **TESTED** — cases 23–28 (schema, organization isolation, provider, dedup, pipeline, coverage) |
| **B. Standalone Scout platform** — `apps/api` (Fastify 5 + TS), `apps/web` (Next.js 16), `packages/shared` (zod contracts) | Independent service | **JWT + refresh tokens** (`refresh_tokens` table, bcryptjs) | **PostgreSQL + Redis** (`docker-compose.lead-discovery.yml`) | **TESTED** (12 contract tests with in-memory DB/Redis stubs; typecheck clean). UI is a full Next.js app (login, leads, pipeline, collections, intelligence, admin, account). |

Both expose the same API namespace (`/api/v1/lead-discovery/*`) with **different identifier schemes** (MySQL: `org-<userId>` varchar IDs, 32-hex row IDs; Scout: UUIDs) and different persistence semantics. This is the single most important architecture decision input for the migration (see R-02 and `ROUTE_MAP.md` §6).

### 3.10 Notifications, scheduled jobs, CLI (PHP app)

- `Tools` CLI controller: `install`, `bootstrap_admin`, `cron` (portfolio risk scan + broker transitions + proposal expiry, audits `CRON_RUN` — designed for every-minute cron), `sports_cron [job]` (fixtures|odds|results|quality|ticket|settlement|performance|monitoring|cleanup — every 15 min), `lottery_cron [job]` (sync|health|statistics|systems|tickets|backtests|cleanup — execution-key idempotent), `tests`.
- All cron jobs are idempotent and audited; none can generate/publish content that requires human action elsewhere in the platform.

### 3.11 Views / UI (PHP app)

61 server-rendered views: layout (header/footer), site (8 public pages), auth (7), workspace, welcome dashboard + SVG chart partials, strategy, paper (2), execution, brokers, risk, journal, sports (2), langlearn (16), leads (2), notifications, admin, errors (CLI + HTML), announcement bar + chat widget. Assets: 3 CSS files, 4 JS files, images. No CDN dependency; responsive; audited by case 65 (headless-Chromium click-through) and `docs/UI_AUDIT_REPORT.md` (2026-08-24).

### 3.12 Football predictions (⚠️ not listed in the master plan)

- **Isolated Node.js 22 / Express 5 / mysql2 / vanilla-JS app** under `apps/football-predictions/` — merged 2026-10-04 (PR #2, "staging validation required").
- Scope: Over-1.5-Goals accumulator tickets only; bookmaker odds exclusively from API-Football (backend); combined target odds 2.00–4.00; **admin-authenticated generation and separate publication actions; no cron can create a ticket; empty qualifying set ⇒ "NO QUALIFYING TICKET"**.
- Surfaces: public pages (index/history/ticket/login) + admin dashboard; API `/api/auth/*`, `/api/fixtures`, `/api/odds`, `/api/predictions`, `/api/ticket/today`, `/api/tickets/*`, `/api/admin/*` (dashboard, generate-ticket, generation-report, publish/unpublish, settings GET/PUT, system-logs, api-status, analytics, predictions, tickets). Helmet + express-rate-limit + CSRF on admin mutations; `fp_sessions` cookie auth.
- Data: own MySQL database, 19–20 `fp_*` tables (own migration `server/migrate.js`); CLI sync jobs (fixtures/odds/statistics/results/freshness/health).
- Tests: 29/29 green (deterministic unit + HTTP contract; **no DB/E2E tests** — per its own `docs/FINAL_AUDIT.md`).
- Status: **IMPLEMENTED, first-run MySQL migration / live API-Football / cPanel flow NOT verified** (staging validation required; 9 documented acceptance risks in `docs/FINAL_AUDIT.md`).
- Migration disposition options (decision required in Phase 1): keep as isolated cPanel Node app (it already matches the Node + MySQL + cPanel target profile) vs. fold into the modular monolith. Its self-declared isolation boundary (PR #2) must be respected either way.

### 3.13 Cross-cutting honesty/safety behavior (all PHP modules)

- Synthetic data provenance (`provenance.synthetic`) flows through analysis → backtest → order → fill → UI; `allowSyntheticPaperData` is a persisted, audited flag (default off) and the Risk Engine vetoes synthetic-data trades when off.
- `GET /api/system/features` renders the real provider matrix; scaffolds are PLANNED, never live.
- Boot state: `ANALYSIS_ONLY` + kill switch ACTIVE (seeded in `platform_state`).

---

## 4. Implemented vs. planned/scaffolded — summary

**Implemented and tested (357-test suite green):** everything in §3.1–§3.11 above, with the exceptions noted.

**Implemented but unverifiable in this environment (needs external service/host):**
- Real Binance/Frankfurter network calls in production (code tested with deterministic fixtures).
- SMTP mail delivery (Mailer configured via env, disabled until configured).
- MT5 bridge against a real MetaTrader terminal (Windows host + demo account required).
- MySQL/`mysqli` production path (tests here run the identical code on `pdo_sqlite`; README documents the DDL parity).
- Scout against live PostgreSQL/Redis (contract tests use in-memory stubs).
- Football predictions against live MySQL + API-Football + cPanel (29 isolated tests only).

**Scaffolded (real boundaries, disabled by default, no real provider):** LicensedAssetMarketDataProvider (stock/ETF/futures/options), OfficialLotteryProvider (licensed EuroMillions feeds), MT4 + 8 crypto/stock broker connectors, AI chat real-provider mode (env-gated).

**Documented as planned:** real-provider verification for all scaffolds; sports process-level cutover items; lottery admin controls UI / security E2E; portfolio optimization; on-chain/options sentiment providers; football staging validation.

**Contradictions found (recorded, not reconciled — see RISK_REGISTER):** README contains two different status tables (current: Phases 1–5 complete, 351 tests; stale leftover: Phase 4/5 PLANNED, 57 tests); README says "63 case files, 351 tests" vs. actual 67 files / 357 tests; `application-deployment.zip` predates current code (R-03).

---

## 5. Dependency map

### 5.1 Inside the PHP app (layering is clean and enforced)

```text
controllers (29) ──▶ MY_Controller / Api_controller (auth, RBAC, CSRF, JSON base)
        │                     │
        ▼                     ▼
   Aegis\Platform (service container, wired from Aegis_model) ◀── helpers/aegis_helper.php (view-safe access)
        │
        ├─▶ domain libraries (Aegis\*) — NO SQL, no CI3 framework dependency
        │        Agents / Analysis / Strategies / Backtest / Paper / RiskEngine /
        │        ExecutionSupervisor / Portfolio / Providers / Brokers / Sports\* /
        │        Lottery\* / LangLearn\* / Notifications / Journal / Optimization
        │
        └─▶ Aegis_model (THE only place SQL lives) ──▶ CI3 query builder ──▶ mysqli | pdo_sqlite
                 └─ implements Aegis\Persistence\*Repository interfaces (typed repositories)
```

- Only `ExecutionSupervisor` holds a `TradingConnector` (agents structurally cannot route orders).
- `tools/rbac.php` is shared by installer and controller seeding (single source of truth).

### 5.2 Between applications

```text
AEGIS PHP app ──HTTP+Bearer──▶ python-services/mt5-bridge ──▶ MT5 terminal (Windows)
AEGIS PHP app ──(independent)──▶ its own lead module (MySQL)
Scout web (Next.js) ──server-side rewrite /api/*──▶ Scout api (Fastify) ──▶ PostgreSQL + Redis
Scout api ──▶ Google Places API (only external lead provider)
Football app ──▶ API-Football (backend only) ──▶ its own MySQL schema
runtime/ (dev only) ──▶ hosts the PHP app in WASM + simulated MT5 bridge on 127.0.0.1:8790 (marker-file gated)
```

No application calls another application's database. The two lead-discovery implementations are fully independent (R-02).

### 5.3 External dependencies

- **PHP app: zero external packages** (CI3 vendored; no composer.json). PHP 8.1–8.3 with `mysqli` + `mbstring`.
- **Scout:** fastify 5.12, @fastify/jwt, @fastify/cors, pg 8.15, ioredis 5.6, zod 3.24, bcryptjs; web: next 16.3, react 19.1, tailwind 3.4.
- **Football:** express 5.2, express-rate-limit 8.7, helmet 8.3, mysql2 3.24.
- **Bridge:** fastapi, uvicorn, pydantic, MetaTrader5 (win32 marker).
- **Dev runtime:** @php-wasm/node + @php-wasm/universal 3.1.50.
- Root `package.json` declares workspaces but the lockfile is stale (R-04).

---

## 6. Runtime entry points (migration must account for each)

| Entry point | Command / mechanism |
|---|---|
| Web (PHP) | Apache + `.htaccess` → `index.php` (cPanel document root) |
| CLI (PHP) | `php index.php tools {install\|bootstrap_admin\|cron\|sports-cron [job]\|lottery-cron [job]\|tests}` |
| Cron (PHP) | `* * * * *` tools cron (portfolio scan + expiry); every 15 min sports-cron; lottery-cron per README |
| Scout API | `tsx src/server.ts` (PORT 3001) with `migrate.ts` + `bootstrap.ts` |
| Scout web | `next build && next start` (rewrites `/api/*` to `LEAD_API_INTERNAL_URL`) |
| Football | `node server.js` (PORT 3000) + `node server/migrate.js` + `node server/jobs/cli.js {fixtures\|odds\|statistics\|results\|freshness\|health}` + `node server/create-admin.js` |
| Bridge | `uvicorn app:app` on Windows host (port 8787) |
| Dev runtime | `node runtime/server.mjs` (:8080) + `node runtime/run-tests.mjs` |

---

## 7. What this means for the Node.js migration (Phase 1 inputs)

1. **The Aegis domain layer is already framework-independent** (`Aegis\*` libraries take constructor-injected repository interfaces). This is the single biggest de-risking factor: the Node port can replicate the domain layer 1:1 behind the same repository contracts, with a new MySQL implementation replacing `Aegis_model`.
2. **All SQL lives in one file** (`Aegis_model.php`, 1,217 LOC, 12 typed repository groups) plus raw DDL — a bounded, enumerable translation surface.
3. **The 15-step supervisor pipeline, risk gates, lifecycle gates and honesty rules are pinned by tests** (357) — these tests are the parity specification for the Node port.
4. **Scout is already Node** — the open question is consolidation (Fastify + PG/Redis vs. the cPanel MySQL-only baseline), not a rewrite.
5. **Football predictions is already Node + MySQL + cPanel-shaped** — decide keep-isolated vs. absorb (R-01).
6. **The MT5 bridge stays Python** unless/until a Node bridge is contract-tested against a real demo terminal (master plan §3 agrees; treat as documented migration exception).
7. **Three auth stacks** (CI3 sessions; Scout JWT; football sessions) must be unified or deliberately kept separate in the target design.

— End of Phase 0 inventory.
