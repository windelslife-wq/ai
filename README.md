<!-- User-facing product name: WINDELS AI WORKFORCE. "AEGIS" below is the
     internal codebase/system identifier (class names, env vars, table prefixes)
     and is intentionally retained for backward compatibility. -->
# AEGIS — Standalone AI Trading Intelligence Platform

> **Product name:** the user-facing application built on this codebase is
> branded **WINDELS AI WORKFORCE** (AI language teacher, market analysis,
> sports/lottery research and lead discovery). The internal system name
> "AEGIS" is kept for class names, environment variables and database
> identifiers and should not be renamed in code.

> **Standalone Lead Discovery update:** the independent Scout platform now lives
> under `apps/api`, `apps/web` and `packages/shared`. It uses Fastify/TypeScript,
> Next.js/React/Tailwind, PostgreSQL and Redis, and does not depend on the AEGIS
> trading services. See [`docs/LEAD_DISCOVERY.md`](docs/LEAD_DISCOVERY.md).

**CodeIgniter 3.1.13 · PHP 8.x · MySQL/MariaDB · Traditional MVC**

A modular trading infrastructure that analyzes markets with a multi-agent AI
stack, runs versioned strategies through an evidence-gated lifecycle, and
governs every broker-bound order through the full execution-supervisor
pipeline (**Phase 4/5: MT5 trading surface + execution governance + portfolio
risk monitoring**).

> **Core principle:** AI can analyze, recommend, and automate within approved
> rules, but it must never bypass market-data validation, risk controls,
> execution governance, broker safeguards, or the kill switch.

```text
MARKET DATA  →  ANALYSIS ENGINES  →  SPECIALIZED AI AGENTS  →  TRADING INTELLIGENCE / CONSENSUS
      →  STRATEGY ENGINE (backtested, validated, risk-reviewed, paper-proven)  →  RISK ENGINE
      →  PAPER TRADING ENGINE  →  TRADE EXECUTION SUPERVISOR (15 steps, human approval / automation envelope)
      →  BROKER CONNECTOR (MT5 bridge, demo-gated)  →  PORTFOLIO + PERFORMANCE MONITORING
```

---

## Current state: Phases 1–3 complete; Phase 4/5 automation core complete

| Area | Status |
|---|---|
| CodeIgniter 3.1.13 MVC (controllers / models / views / libraries) | **TESTED** |
| **MySQL / MariaDB** persistence — canonical schema + mysqli config (`application/database/schema.mysql.sql`) | **IMPLEMENTED** |
| Market-data abstraction (health checks, retry, timeout, circuit breaker, cache, fallback, provenance) | **TESTED** |
| Binance + Frankfurter/ECB real providers; labeled synthetic demo provider | **TESTED** |
| Multi-agent analysis (technical, market-structure, forex, crypto, sentiment, consensus) | **TESTED** |
| Regime detection + trade setup generator + Risk Engine (independent veto, actual-volume checks) | **TESTED** |
| Strategy framework: 4 built-ins, evidence-gated lifecycle; **live APPROVED gate requires ≥10 paper trades with PF>1** | **TESTED** |
| Backtester: next-bar fills, cost model, pessimistic stop rule, look-ahead guard | **TESTED** |
| Paper Trading Engine: accounts, orders, fills, positions, ticks, strategy deployments | **TESTED** |
| Trade journal + analytics + confidence calibration | **TESTED** |
| **Trade Execution Supervisor — full 15-step pipeline** with durable auditable proposals | **TESTED** |
| **HUMAN_APPROVAL / SEMI_AUTONOMOUS / FULLY_AUTOMATED modes** (automation envelope: notional, daily cap, risk %, approved symbols) | **TESTED** |
| **MT5 connector — full trading surface** (account/quote/candles/positions/orders/history + place/modify/cancel/close) | **TESTED** (simulated bridge; not yet verified against a real MetaTrader terminal) |
| **Python MT5 bridge service** (`python-services/mt5-bridge`, FastAPI + MetaTrader5, demo-only default) | **IMPLEMENTED** (contract unit-tested; requires deployment on a Windows MT5 host) |
| **Portfolio Risk Monitor**: HIGH_EXPOSURE, EXCESSIVE_LEVERAGE, CORRELATED_POSITIONS, MAX_DRAWDOWN_WARNING, DAILY_LOSS_WARNING, BROKER_DISCONNECTED | **TESTED** |
| Kill switch, audit trail, ANALYSIS_ONLY default | **TESTED** |
| **RBAC on the trading API**: trading.view / trading.control / trading.execute (+ CSRF); approval decisions record the deciding operator | **TESTED** |
| **Notifications**: risk alerts, approval requests, execution outcomes, broker disconnects, kill switch — deduped until acknowledged | **TESTED** |
| **Scheduled operations worker** (`php index.php tools cron`): portfolio scan, broker transitions, proposal expiry | **TESTED** |
| **Lottery Intelligence (EuroMillions)**: rule engine, validated idempotent ingestion (verified draws never silently overwritten), frequency/gap/hot-cold/distribution/pair statistics, per-line combination analyzer, 5-mode AI combination generator with lock/exclude + AI decision reports, diversification engine, system builder (C(N,5) combinatorics), user-scoped ticket builder + saved tickets, backtesting (Strategy Lab) with mandatory random baseline + same-period strategy comparison, model versioning, separated performance overview, RBAC (lottery.view/manage), idempotent lottery-cron | **TESTED** (admin controls/UI/security-E2E next; official feeds PLANNED) |
| MT4 / crypto-exchange / stock-broker connectors | **PLANNED** (added one at a time after MT5 is verified) |

**351 automated tests** run through the real CodeIgniter stack
(`php index.php tools tests` on any host; `node run-tests.mjs` in the offline
sandbox — see below), plus 9 contract tests for the Python bridge
(`python-services/mt5-bridge/.venv/bin/python -m pytest test_bridge.py`).

---
---|---|
| CodeIgniter 3.1.13 MVC (controllers / models / views / libraries) | **TESTED** |
| **MySQL / MariaDB** persistence — canonical schema + mysqli config (`application/database/schema.mysql.sql`) | **IMPLEMENTED** |
| Market-data abstraction (health checks, retry, timeout, circuit breaker, cache, fallback, provenance) | **TESTED** |
| Binance + Frankfurter/ECB real providers; labeled synthetic demo provider | **TESTED** |
| Multi-agent analysis (technical, market-structure, forex, crypto, sentiment, consensus) | **TESTED** |
| Regime detection + trade setup generator + Risk Engine (independent veto) | **TESTED** |
| Strategy framework: 4 built-ins, evidence-gated lifecycle through PAPER_TRADING | **TESTED** |
| Backtester: next-bar fills, cost model, pessimistic stop rule, look-ahead guard | **TESTED** |
| **Paper Trading Engine (Phase 3): accounts, orders, fills, positions, ticks, strategy deployments** | **TESTED** |
| Trade journal + analytics + confidence calibration | **TESTED** |
| ANALYSIS_ONLY + PAPER_TRADING modes, kill switch, audit trail | **TESTED** |
| MT5 bridge health + read-only account/quote contracts | **IMPLEMENTED** (Phase 4 foundation) |
| Execution supervisor preflight + persistent HUMAN_APPROVAL review workflow | **IMPLEMENTED** (Phase 5 foundation; never routes orders) |
| Broker order routing and live trading | **PLANNED** (Phase 5) |

**57 automated tests** run through the real CodeIgniter stack
(`php index.php tools tests` on any host; `node run-tests.mjs` in the offline
sandbox — see below).

---

## Production deployment (cPanel — no terminal required)

Requirements: PHP 8.1–8.3 with `mysqli` + `mbstring`, MySQL 5.7+/MariaDB 10.3+,
Apache with `mod_rewrite` and permission for the bundled `.htaccess` rules.

The supported production flow is entirely browser-based:

1. Upload and extract `application-deployment.zip` with **cPanel File Manager**.
2. Create a database/user and grant **ALL PRIVILEGES** in **cPanel → MySQL Databases**.
3. Import `database/production.sql` in **cPanel → phpMyAdmin**.
4. Copy `.env.example` to `.env` and edit `CI_ENV`, `VP_BASE_URL`, the `VP_DB_*`
   values, and preserve the existing `VP_ENCRYPTION_KEY` / `VP_AUTH_SECRET`.
5. Open the domain. No install, seed, migration, Composer, Node, npm, Docker or
   CLI admin-creation command is required.

The complete cPanel guide is [`docs/CPANEL_DEPLOYMENT.md`](docs/CPANEL_DEPLOYMENT.md).
The SQL import contains all application tables, indexes, foreign keys, defaults,
RBAC, language/lottery reference data, built-in strategies and the initial
administrator account. Configuration is read from `.env` by the bundled
`application/config/env.php` loader.

## Offline dev / demo runtime (this repository's live preview)

The development sandbox has **no package mirrors and no MySQL server
egress** — it cannot run native PHP or MariaDB. The demo therefore runs the
**same CodeIgniter application** unmodified inside a WebAssembly PHP runtime
(`php-wasm` 8.2, host filesystem mounted) using CodeIgniter's built-in
`pdo_sqlite` driver with a schema that mirrors the MySQL DDL:

```bash
cd runtime && npm install
AEGIS_ALLOW_SYNTHETIC_PAPER=1 node server.mjs   # CI3 app on :8080
node run-tests.mjs                              # full test suite
```

This is a **dev bridge only** — `runtime/` is not part of the production
stack. Every honesty rule still applies: synthetic market prices are labeled
`SIMULATION` everywhere, and the `allowSyntheticPaperData` switch (which the
demo sets) is a persisted, audited platform-state flag that production leaves
off — with it off, the Risk Engine vetoes any synthetic-data trade.

---

## Repository layout (traditional CI3 MVC)

```text
index.php                       CI3 front controller (+ dev-bridge URI adapter)
system/                         CodeIgniter 3.1.13 core (unmodified)
application/
  config/                       config.php, database.php (mysqli/pdo_sqlite), routes.php
  controllers/                  Welcome (dashboard), Strategy_lab, Paper, Journal,
                                Execution (supervisor console), Brokers (broker center),
                                Risk_center (limits + monitor), Api_system, Api_analysis,
                                Api_marketdata, Api_strategies, Api_paper, Api_journal,
                                Tools (CLI: install/tests)
  models/Aegis_model.php        THE only place SQL lives — repository interfaces
                                implemented over CI3's query builder (mysqli/sqlite)
  libraries/Aegis/              domain layer (no framework dependency):
    Indicators, MathUtils, CandleNormalizer, Timeframes
    ProviderManager + Providers/ (Binance, Frankfurter, Synthetic)
    Agents/ (Technical, MarketStructure, Forex, Crypto, Sentiment, Intelligence)
    Analysis (regime + setup generator), RiskEngine
    Strategies/ (SeriesView w/ look-ahead guard, 4 built-ins, StrategyRegistry)
    Backtest/ (Backtester + Metrics), Journal/Analytics
    Paper/PaperTradingEngine    Phase 3: accounts/orders/fills/ticks/deployments
    Brokers/ (TradingConnector, Mt5BridgeConnector, BrokerDataNormalizer)
    ExecutionSupervisor         Phase 5: 15-step pipeline, proposals, routing
    Portfolio/PortfolioRiskMonitor  continuous portfolio risk alerts
    Platform                    service container wired from the model layer
  views/                        server-rendered dashboard (layout, welcome, strategy,
                                paper, execution, brokers, risk, journal) + SVG chart
  database/                     schema.mysql.sql (canonical) + schema.sqlite.sql (dev)
python-services/mt5-bridge/     Phase 4 bridge: FastAPI + MetaTrader5 service,
                                contract-tested with a simulated terminal
  helpers/aegis_helper.php      view-safe platform-state access
tests/                          framework.php + cases/*.php (63 case files, 351 tests, incl. full UI audit `65-ui-audit.php`)
tools/install.php               schema installer (mysqli or sqlite by driver)
runtime/                        offline WASM-PHP bridge (dev only, not production)
assets/css/aegis.css            dashboard styles (no CDN dependency)
```

## Phase 3 — Paper Trading (how it works)

Every paper order passes the **full governance chain before simulation**:

```text
kill switch → trading mode (PAPER_TRADING required) → duplicate check →
mandatory stop-loss → sizing (risk% × equity ÷ stop distance, notional-capped) →
Risk Engine (exposure, drawdown, daily/weekly loss) → fill
```

- **Market orders** fill instantly at the quoted price (spread + slippage +
  commission per side). **Limit orders** queue until a tick crosses them.
- **Ticks** (`POST /api/accounts/:id/tick`): fill pending limits, evaluate
  SL/TP on the latest candle with the **pessimistic stop-first rule**, and
  run **deployed strategies** on the latest closed bar — each signal is a
  fresh risk-checked paper order.
- **Strategy deployment** to a paper account is the `PAPER_TRADING`
  lifecycle stage (requires `RISK_REVIEWED`; AI-source strategies blocked
  without human sign-off).
- Closed positions land in the **journal** (source=paper) with fees, reason
  and decision confidence — feeding the confidence-calibration analytics.
- All events audited: `ORDER_SUBMITTED`, `ORDER_FILLED`, `POSITION_OPENED`,
  `POSITION_CLOSED`, `STOP_LOSS_TRIGGERED`, `KILL_SWITCH_*`, …
- Paper trading is **simulation**: no order ever leaves the process; broker
  connectors arrive in Phase 4.

### Quick demo flow (also in the Paper Trading console UI)

```bash
curl -X POST :8080/api/trading/mode -d '{"mode":"PAPER_TRADING"}' -H 'Content-Type: application/json'
curl -X POST :8080/api/trading/kill-switch -d '{"active":false}' -H 'Content-Type: application/json'
curl -X POST :8080/api/accounts/create -d '{"name":"Demo","startingBalance":25000}' -H 'Content-Type: application/json'
# -> account id 1
curl -X POST :8080/api/backtesting/run -d '{"strategyId":"trend-following","symbol":"BTCUSDT","marketClass":"crypto","timeframe":"1h","limit":1500}' -H 'Content-Type: application/json'
# lifecycle: BACKTESTED -> VALIDATED -> RISK_REVIEWED (POST /api/strategies/trend-following/status)
curl -X POST :8080/api/accounts/1/order -d '{"symbol":"BTCUSDT","side":"BUY","stopLoss":<2%below>,"reason":"...","confidence":0.72}' -H 'Content-Type: application/json'
curl -X POST :8080/api/accounts/1/deploy -d '{"strategyId":"trend-following","symbol":"ETHUSDT","timeframe":"1h","marketClass":"crypto"}' -H 'Content-Type: application/json'
curl -X POST :8080/api/accounts/1/tick
```

## Phase 4/5 — Execution governance (how it works)

Every broker-bound intent is a **durable, auditable proposal** that runs the
15-step pipeline inside `TradeExecutionSupervisor`:

```text
1 kill switch → 2 trading mode → 3 strategy (APPROVED lifecycle required for
automated intents) → 4 broker connection (bridge-VERIFIED order submission) →
5 market session → 6 data freshness → 7 duplicate orders → 8 symbol
permissions → 9 margin estimate → 10 Risk Engine (actual order volume:
notional / leverage / risk% / RR / exposure / daily+weekly loss / drawdown) →
automation envelope (SEMI/FULLY: max notional, max daily trades, max risk %,
approved symbols) → 11 human approval (HUMAN_APPROVAL mode) → 12 place order
→ 13 confirm execution → 14 audit log → 15 portfolio snapshot
```

- **Routing only happens through a connector whose bridge-verified status
  reports effective order submission** — otherwise the attempt is audited as
  `ROUTING_BLOCKED` and no order exists.
- The MT5 connector refuses orders unless `AEGIS_MT5_TRADING_ENABLED=1` AND
  the deployed bridge reports `tradingEnabled=true` AND the account is
  **demo** (unless `AEGIS_MT5_LIVE_ALLOWED=1`).
- The **Portfolio Risk Monitor** scans every paper account and connector;
  only alert *transitions* are audited (no spam). Correlation warnings use
  static disclosed groups — explicitly labeled heuristic, not statistical.
- Strategy lifecycle now includes the **live-approval gate**: `APPROVED`
  requires the PAPER_TRADING stage plus ≥10 closed paper trades with
  profit factor > 1 and positive expectancy.

### Operator access control, notifications, scheduled operations

- **RBAC** (seeded by the installer, shared matrix in `tools/rbac.php`):
  `trading.view` (read status/proposals/executions), `trading.control` (kill
  switch, mode, risk/automation limits), `trading.execute` (propose/decide/
  route). Mutating trading endpoints require session auth + `X-CSRF-Token`.
  The operator console stays server-rendered; API integrations authenticate
  via `POST /api/auth/login`.
- **Notifications** (`notifications` table + `/api/notifications` + the
  Alerts page): portfolio risk transitions, `TRADE_APPROVAL_REQUESTED`,
  `ORDER_FILLED`, `EXECUTION_FAILED`, `ROUTING_BLOCKED`, `BROKER_DISCONNECTED`
  / `BROKER_CONNECTED`, kill-switch activation, `PROPOSAL_EXPIRED`. Unread
  dedupe: one badge per active issue until acknowledged.
- **Cron worker** — run every minute:
  `* * * * * php /path/index.php tools cron`
  Executes the portfolio risk scan (with broker transition detection), expires
  undecided proposals after `proposalExpiryMinutes` (default 240, spec §5
  invalidation) and audits a `CRON_RUN` summary.

### AI Language Learning (Phase 1 complete)

`/app/languages` (console) · `/api/v1/language-learning` (API)

- **Language registry** — 20 languages (Dutch, Spanish, Italian, French,
  German, English, Portuguese, Arabic, Chinese, Japanese, Korean, Russian,
  Hindi, Turkish, Swahili, Yoruba, Igbo, Hausa, Afrikaans, Zulu) with native
  names, script, LTR/RTL and an honest per-language feature table. Nothing
  hard-codes languages; `LanguageRegistry::register()` extends the catalog.
- **Profiles** — one per (user, language), fully independent progress; strict
  ownership isolation on every endpoint.
- **Adaptive AI level assessment** — staircase difficulty per skill
  (vocabulary / grammar / reading) over real authored item banks; levels are
  computed from actual answers, never random, and can never exceed a
  language's verified bank ceiling (disclosed in the result). Listening,
  speaking and writing are reported as not assessed in this build — never
  faked.
- **Learning paths** — CEFR module chains from the assessed level with real
  checkpoint quizzes (pass ≥ 75% unlocks the next module).
- **Progress** — levels, path completion and study streaks derived only from
  stored activity (assessments, checkpoints, study sessions).

**Phase 2 — AI Teacher (complete)**: lessons (teach → examples from the
verified bank → practice → grade → module completion), structured
conversation drills for every banked language (first-meeting; café where
confidently authored) with all four correction preferences and assisted
advance after two misses, guided writing tasks with real element checks
(original text always stored unchanged next to the feedback), grammar rules
with on-demand simpler explanations, and full lesson history.

**Phase 3 — Vocabulary (complete)**: a 10-word authored bank per language
(word, translation, pronunciation only where confidently romanized, example
sentences only when the sentence genuinely contains the word), a learner word
list, and a real spaced-repetition schedule — remembered walks 1→3→7→14→30→90
days by demonstrated stage, forgotten resets to tomorrow with a lapse
counted. Daily reviews pull the due-today queue; quizzes are deterministic
multiple-choice graded against the same options shown (start and submit build
identically), flashcards are self-assessed and labeled as such, and
vocabulary progress (learned / learning / due / average familiarity /
mastery) is computed only from stored reviews.

**Phase 4 — Listening + Speaking (complete, honest provider boundaries)**:
listening exercises are built from the language's real reading bank — the
browser's speech synthesis speaks the actual sentence (feature-detected; no
voice → an honest notice, never fake audio) with slow/normal speeds, replay
and show/hide transcript; attempts are graded server-side (comprehension
against the bank answer, transcription by diacritic-tolerant word accuracy).
Speaking practice prompts real sentences and captures the transcript through
the browser's SpeechRecognition where available; word accuracy is computed
from the transcript that was actually returned, an empty transcript is
stored unscored, and **pronunciation/fluency scores are never produced** —
they require a pronunciation-assessment provider that is not configured.

**Phase 5 — Adaptive AI learning (complete)**: weakness detection reads only
stored performance — per-skill averages (≥3 attempts), vocabulary words with
repeated SRS lapses, bank items missed ≥2 times, modules failed repeatedly —
and every finding cites its evidence; with insufficient activity the answer
is an explicit "not enough data" instead of invented findings. Daily plans
are built from real state (vocabulary due today, current path module,
measured weak areas) and sized to the profile's daily minutes; block
completion is computed from the same day's actual activity, never assumed.
Recommendations are generated from the same evidence, and item-level mastery
(mastered / learning / weak / unseen) is graded from real attempt outcomes.
All five phases of the language-learning module are now complete.

### Phase 6 intelligence: agent debate + strategy optimizer

- **Multi-agent debate** runs as a deterministic adversarial review in front
  of every consensus: bull/bear advocates state their strongest evidence
  (citing the agent + signal each claim came from), a **skeptic** challenges
  the leading bias (split panel, regime contradiction, stale data, weak
  conviction), and a **risk critic** challenges the concrete setup
  (risk/reward, stop width). Verdicts can only **reduce** a bias — NO_TRADE
  on any sustained critical objection, NEUTRAL on two majors, confidence cuts
  otherwise — never manufacture conviction. The transcript ships with every
  analysis run (`debate` field; dashboard renders it).
- **Strategy optimizer** (`POST /api/strategies/:id/optimize`, Strategy Lab):
  grid search over the strategy's small declared `paramGrid()` on the first
  70% of the series, then **out-of-sample verification** on the last 30%.
  A candidate is recommended only if it survives out-of-sample (PF > 1,
  positive expectancy, ≥ 5 trades) and beats the baseline there; in-sample
  wins alone are never adopted, and degradation is reported as explicit
  overfit warnings. Registering a winner creates a **new version with source
  `ai`** — DRAFT lifecycle, human sign-off required before paper/live, same
  as any AI-generated strategy.

### Lottery Intelligence (native WINDELS module — EuroMillions first)

A provider-neutral lottery intelligence platform inside WINDELS (not a
separate site, not a random number generator). EuroMillions is the first
supported lottery; the `LotteryProvider` + `LotteryRules` contract means
additional lotteries plug in as configuration + a provider, not a rebuild.

**Honesty contract (mandatory):** EuroMillions is a random lottery. Every
statistical output carries the engine's independence disclaimer; hot/cold,
frequency and gaps are labeled **historical observations**, never predictions;
no "win chance" or "due" number exists anywhere in the module.

Implemented and tested in this increment:

- **Rule engine** (`EuroMillionsRules`): 5 mains from 1–50, 2 Lucky Stars from
  1–12, Tue/Fri 21:00 UTC — stored as data (DB-updatable `lottery_rules`
  table), enforced for validation, statistics and (future) generation.
- **Provider abstraction** (`LotteryProvider`): `UnavailableLotteryProvider`
  default (honest `DISABLED_NO_PROVIDER`) + clearly-labeled
  `SandboxLotteryProvider` (env-gated `WINDELS_LOTTERY_SANDBOX=1`,
  deterministic, source `sandbox-simulation`) for pipeline testing. Official
  licensed feeds are PLANNED, added one at a time.
- **Ingestion with validation** (spec §6): every imported draw must pass
  count/range/duplicate/date/source checks or it is marked
  `DATA_VALIDATION_FAILED` and audited — never stored as official. Imports
  are idempotent (unique `lottery_code + external_id`), and a `VERIFIED` draw
  is **never silently overwritten** — conflicts are audited for manual
  correction. Every row carries source, source timestamp and retrieved time.
- **Historical database**: `lotteries`, `lottery_rules`, `lottery_draws`,
  `lottery_draw_numbers`, `lottery_data_sources`, `lottery_provider_health`,
  `lottery_sync_runs` (sqlite + mysql), through the existing `Aegis_model`
  repository pattern.
- **Statistics engine** (pure, tested): per-number and per-star frequency /
  appearance% / last appearance / current gap / avg-min-max gaps / windowed
  recent stats (all-history or last N draws); hot/cold by window (labeled
  non-predictive); distribution (odd/even, low/high, sum min/max/avg/median,
  spread, consecutive runs); pair/triplet/star-pair co-occurrence with gaps.
- **Combination analyzer** (spec §13, `CombinationAnalyzer`): full profile of
  one 5+2 line against stored draws — odd/even, low/high, sum & spread with
  historical min/max/avg/percentile, consecutive patterns, per-number and
  per-star history (appearances, gaps, absence), historical similarity
  (best overlap, shared-3+ draws, same split), pattern characteristics
  (birthday range, sequences, visual patterns) and a labelled
  **STATISTICAL BALANCE SCORE: N/100** with documented component weights —
  explicitly *not* a probability.
- **AI combination generator** (spec §15/§16/§21/§26/§33,
  `CombinationGenerator`): five modes — `RANDOM`, `BALANCED` (historical
  profile targets), `HISTORICAL` (frequency-weighted sampling),
  `DIVERSIFIED` (min-overlap greedy) and `ANTI-POPULAR` (avoids birthday-heavy
  / sequence / visual patterns) — with LOCK/EXCLUDE respected by every mode,
  seeded reproducibility (same seed ⇒ same lines) and a full AI decision
  report recording the *actual* inputs: model (`WINDELS Lottery Model v1.0`),
  seed, rules version, dataset version, locks/excludes, factors and method.
  Every report carries the independence disclaimer and the honesty note that
  no mode changes the mathematical chance of any valid combination.
- **Diversification engine** (spec §22, `DiversificationEngine`): exact
  number/pair/triplet/star overlap for every pair of lines (pair overlap =
  C(|A∩B|, 2)), duplicate detection, distribution similarity and a labelled
  **DIVERSITY SCORE: N/100** — how different the lines are from each other,
  never a likelihood. Scales to 50+ lines.
- **System builder** (spec §18/§19, `SystemBuilder`): a pool of N mains +
  S stars → the full system. Line count is computed as
  `C(N,5) x C(S,2)` — **never hardcoded**; 100% pool coverage (numbers, main
  pairs, star pairs); estimated cost stays `null` with an explicit
  "no cost is fabricated" note while official pricing is unavailable. Lines
  enumerate lazily (constant memory) with paginated windows; systems above
  10,000 lines are queued idempotently (execution key) and built by the
  background `systems` cron job. Built systems persist as `SYSTEM`
  combination rows with model stamping + audit.
- **Ticket builder + saved tickets** (spec §20/§29/§38,
  `lottery_tickets` + `lottery_ticket_lines`): user-scoped named tickets with
  multiple lines — **every line validated before anything is stored**, lines
  normalized, generation method + model version + configuration stamped.
  Check against stored `VERIFIED` draws with per-line main/star matches and
  the official EuroMillions prize tiers (amounts never stored); automatic
  post-draw checking via the idempotent `tickets` cron job; archive/soft
  delete. Users can only access **their own** tickets unless they hold
  `lottery.manage`. Actual ticket outcomes stay separate from backtests and
  demo data (spec §30).
- **Backtesting — Strategy Lab** (spec §23/§24/§25, `LotteryBacktester`):
  four deterministic strategies — `RANDOM_BASELINE` (mandatory, spec §25),
  `BALANCED_PROFILE`, `HISTORICAL_FREQ`, `ANTI_POPULAR` — replayed over
  stored draws **without look-ahead** (test draw i only sees draws 1..i-1).
  Reports: main/star match distributions, official tier counts (amounts
  never stored), best line, per-draw detail — labelled **HISTORICAL
  SIMULATION**, with simulated cost/winnings `null` while official figures
  are unavailable. Strategy comparison runs every strategy on the **same
  period** and never declares one "better" (spec §24/§34). Runs persist in
  `lottery_backtests` (audited `LOTTERY_BACKTEST_RUN`) and the daily
  `backtests` cron job is execution-key idempotent (one run per strategy per
  day).
- **Model versioning** (spec §33, `lottery_model_versions`):
  `WINDELS Lottery Model v1.0` row records the full statistical
  configuration (score weights, generator modes, backtester strategies).
  Versions are **never deleted or replaced** — historical results stay
  connected to the model that generated them.
- **Performance overview** (spec §30, `api/lottery/performance`):
  **ACTUAL TICKET RESULTS**, **HISTORICAL BACKTEST RESULTS** and
  **DEMO/SANDBOX DATA** in three separate sections that are **never
  mixed**; sandbox data is explicitly labeled synthetic.
- **Persistence**: `lottery_combinations` (lines + constraints + model
  version), `lottery_ai_decisions` (full report), `lottery_tickets`,
  `lottery_ticket_lines`, `lottery_backtests`, `lottery_model_versions` —
  every artefact stays connected to the model that produced it (spec §33);
  each generation/backtest is audited with the acting user.
- **API + RBAC + cron**: `api/lottery/*` (status public; reads `lottery.view`;
  `POST generate` / `POST diversity` / `POST system` / `POST backtest` /
  `POST backtest-compare` / ticket mutations `lottery.view` + session CSRF;
  `POST sync` + `POST system-build` `lottery.manage` + CSRF),
  `lottery_admin` / `lottery_viewer` roles seeded by `tools/rbac.php`,
  idempotent `php index.php tools lottery-cron
  [sync|health|statistics|systems|tickets|backtests|cleanup]`
  (execution-key guarded; integrity sweep audits violations without rewriting
  verified data).

Next increments: result-verification pipeline formalization (spec §28/§19),
provider-health + AI-decision-report endpoints/UI, admin controls (spec §39,
every change logged), the WINDELS-styled desktop + mobile lottery console
(spec §35/§36/§37), security testing (spec §31) and the full E2E +
production-readiness review (spec §32/§33).

### Simulated MT5 bridge (offline demo only)

The sandbox has no MetaTrader terminal, and the platform refuses to pretend
otherwise: with no bridge deployed, routing is audited as `ROUTING_BLOCKED`.
To **demo** the full chain, Broker Center has a *Simulated MT5 bridge* toggle:

- The dev runtime runs an in-process mock on `127.0.0.1:8790` that speaks the
  **exact documented bridge contract** (health, quotes, candles, positions,
  pending orders, history, place/modify/cancel/close) with in-memory state.
- It is activated by a marker file (`application/data/mt5-demo.json`) that
  only the dev bridge's front controller honors — production never reads it,
  it never overrides an explicitly configured real bridge, it is locked to
  loopback, and `AEGIS_MT5_LIVE_ALLOWED` stays 0.
- `/health` reports `simulated: true`; the connector surfaces the flag, and
  the Broker/Execution consoles show a **SIMULATION** banner. Every fill is a
  simulation — no real broker, no real order.
- All connector gates still apply (demo account, trading flags), so the demo
  exercises the genuine 15-step pipeline: propose → PENDING_APPROVAL (with
  operator notification) → approve → route → simulated fill → audit +
  post-trade portfolio snapshot. SEMI_AUTONOMOUS still refuses without an
  APPROVED (paper-proven) strategy — by design.

## API surface

`/api/auth/{login,me,logout}` · `/api/notifications[/read-all|/:id/read]`
`/api/system/{status,features}` · `/api/events` · `/api/trading/{kill-switch,mode,synthetic-paper}`
`/api/trading/limits[/update]` · `/api/trading/propose` · `/api/trading/execute` · `/api/trading/:id/{approve,route}`
`/api/execution/{preflight,proposals,executions}` · `/api/portfolio/risk-scan` · `/api/brokers` · `/api/brokers/mt5/{account,quote}`
`/api/market-data/{candles,quote,providers}` · `/api/analysis/{run,history}` · `/api/agents/consensus`
`/api/strategies[/:id[/status]]` · `/api/backtesting/{run,results[/:id]}`
`/api/accounts[/create|/:id|/:id/order|/:id/positions|/:id/positions/:pid/close|/:id/tick|/:id/deploy|/:id/deployments]`
`/api/journal[/manual]` · `/api/analytics/{summary,confidence-calibration}` · `/api/risk/limits[/update]`

## Critical rules enforcement (unchanged from the platform spec)

| Rule | Enforcement |
|---|---|
| Agents never call brokers | Agents see only `AnalysisContext`; every order path (paper AND broker) runs through the Risk Engine + Execution Supervisor; only the supervisor holds a TradingConnector |
| Never silently use fake data | `provenance.synthetic` flows end-to-end; paper fills on synthetic prices require the explicit, audited `allowSyntheticPaperData` dev flag |
| No integration claimed unless tested | `GET /api/system/features` renders the same matrix; unverified integrations are listed as PLANNED (Broker Center) |
| Live trading disabled by default | Boot state: `ANALYSIS_ONLY` + kill switch ACTIVE; broker routing needs an explicitly deployed bridge + `AEGIS_MT5_TRADING_ENABLED=1` + demo account; automated modes need a configured automation envelope |
| Every trade auditable | `audit_logs` table + UI trail; every order/position/journal row is linked |
| Risk Engine veto power | `RiskEngine::evaluate()` sits in every order path |
| Kill switch blocks orders | Checked first in `submitOrder()`, in the supervisor pipeline (step 1) and re-verified at routing time |

## Unfinished-module scaffolds

The previously planned integrations now have provider-neutral, testable code
boundaries, but they remain **PLANNED** until their real external contracts
are verified. Nothing is enabled by default and no missing data is fabricated.

- **Licensed asset market data:** stock, ETF, futures and options adapters in
  `application/libraries/Aegis/Providers/LicensedAssetMarketDataProvider.php`.
  Each requires an explicit enable flag, safe URL, license identifier, token
  where required and a symbol allow-list. It accepts only the documented
  normalized candle/quote contract and reports `NOT_CONFIGURED`/`DOWN` honestly.
- **Official lottery feeds:** `OfficialLotteryProvider` requires explicit
  authorization metadata and HTTPS, normalizes the provider-neutral draw
  contract, and leaves all validation/idempotency/conflict handling to the
  existing lottery engine. The sandbox provider is never treated as official.
- **MT4, crypto and stock-broker connectors:**
  `ConfiguredTradingConnector` supplies the normalized bridge boundary for
  MetaTrader 4, Binance, Bybit, OKX, Coinbase, Kraken, Interactive Brokers,
  Alpaca and OANDA. Each connector is disabled by default; writes require
  separate connector and adapter health gates and demo/live authorization.

The scaffolds are intentionally not marked as working integrations in
`GET /api/system/features` until a real provider is contract-tested.

## Roadmap

- **Phase 4 (verification)** — the MT5 surface and the Python bridge are
  implemented and contract-tested with a simulated terminal. Remaining
  before any real-money consideration: deploy the bridge on a Windows host
  with a **demo** MT5 account, verify the PHP↔bridge path end-to-end, and
  only then review `AEGIS_MT5_LIVE_ALLOWED` (default stays off). Crypto
  exchanges are added **one at a time** after MT5 is verified.
- **Phase 5 (core + hardening done)** — supervisor pipeline, human approval,
  automation modes, kill switch, duplicate protection, broker health
  monitoring, portfolio risk monitoring, RBAC on the trading API,
  notifications and the scheduled-operations worker are implemented and
  tested, and the offline demo can run the full chain through the clearly
  labeled SIMULATED bridge (real routing still requires a deployed bridge).
  Next: verify MT5 against a real demo terminal, then crypto exchanges one at
  a time.
- **Phase 6 (in progress)** — multi-agent debate and the strategy optimizer
  are implemented and tested. The fundamentals agent boundary is implemented
  and explicitly abstains until a licensed, attributable feed is configured.
  The sentiment feed boundary is implemented next: a `SentimentFeed` contract
  with provenance + freshness validation (per-observation source, timestamp,
  license, 1h staleness floor) that votes only on licensed, attributable,
  fresh data and abstains otherwise.
  Next: add on-chain and options providers one at a time with the same
  provenance/freshness contract; portfolio optimization.

## Disclaimer

Analysis + simulation software for research and education. Nothing here is
investment advice. Synthetic demo data is always labeled as simulation.
