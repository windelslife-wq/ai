# Unfinished module inventory — names only

**Derived:** 2026-10-13, from a read-only scan of the tree (app version
`@windels/workforce-platform@0.23.0`).

**Updated after Phase 28** (the sports and lottery consoles): the last two tracked
items moved — `/app/sports` and `/app/lottery` now exist, removing F-29's sports and
lottery halves. **F-29 itself stays open**: its own text names the market-data,
analysis and Strategy Lab consoles, which still have no screen. See
[`migration/PHASE28_SPORTS_LOTTERY_CONSOLES.md`](migration/PHASE28_SPORTS_LOTTERY_CONSOLES.md);
the Phase 27 record is
[`migration/PHASE27_CONSOLE_SCREENS.md`](migration/PHASE27_CONSOLE_SCREENS.md).

**Sources of truth for this list (nothing here is invented):**

| Source | What it declares |
|---|---|
| `docs/migration/UNFINISHED_MODULES.md` | The 23-row Node.js port backlog |
| `apps/workforce-platform/src/modules/platform/health.js` → `MODULE_STATUS` | The runtime module ledger (what `GET /api/v1/system/status` serves) |
| `apps/workforce-platform/src/modules/sports/service.js` → `SPORTS_NOT_PORTED` | Sports sub-areas still not ported |
| `apps/workforce-platform/src/modules/lottery/service.js` → `LOTTERY_NOT_PORTED` | Lottery sub-areas still not ported |
| `application/controllers/Api_system.php` → `FEATURES` | PHP feature-honesty matrix (`PLANNED` entries) |
| `application/controllers/Brokers.php` | PHP broker-connector matrix (9 `PLANNED` scaffolds) |
| `README.md` → "Unfinished-module scaffolds" / "Roadmap" | PHP-side scaffold list |

---

## 1. Node.js port backlog — the 23 named workstreams

Names exactly as they appear in `docs/migration/UNFINISHED_MODULES.md`.

| # | Module / workstream name | State |
|---:|---|---|
| 1 | Identity, authentication and legacy account import | Partial — importer never run against a real DB |
| 2 | Account management, registration, password reset and admin users | Mostly ported — **password reset not ported** |
| 3 | Shared app shell, dashboards, settings and navigation | Partial — notification inbox, audit browser and portfolio optimizer screens landed (Phase 27); domain dashboards + settings screens still absent |
| 4 | Public website, help/contact and SEO | Ported — **chat widget not ported** |
| 5 | Notifications, audit browser, feature/status reporting and system health | Ported — audit console screen landed (Phase 27); settings screens, delivery channel and retention policy open |
| 6 | Market data and provider health | Ported — no live upstream call, no UI |
| 7 | Analysis engines, specialized agents and consensus/debate | Ported — no PHP↔Node numeric diff (F-26) |
| 8 | Strategy Lab, lifecycle, backtesting and model/decision analytics | Ported — 4 legacy document routes + view absent |
| 9 | Research-only portfolio optimization | Ported — console screen landed (Phase 27); no saved reports, no numeric parity vs PHP |
| 10 | Paper trading and strategy deployments | Ported in code — MySQL repo unexercised |
| 11 | Risk Center and portfolio risk monitor | Ported in code |
| 12 | Execution Supervisor and trading governance | **Partial** |
| 13 | Broker Center and broker connectors | **Partial** |
| 14 | Sports intelligence | **Partial** |
| 15 | Lottery intelligence and Operations console | **Partial** |
| 16 | **Language learning / AI teacher** | **Not ported** |
| 17 | **Lead Discovery: CI3 module + Scout consolidation** | **Not ported** |
| 18 | **Chat, journal, trading tools and remaining platform surfaces** | **Not ported** |
| 19 | Scheduled jobs, CLI and resumable work | **Partial** |
| 20 | Football Predictions app integration | Undecided — isolated app |
| 21 | Python MT5 bridge conversion or explicit exception | Undecided — no Node-compatible adapter |
| 22 | Full legacy data migration and cutover | **Not started** — no importer, no reconciliation |
| 23 | PWA + Capacitor release readiness | Closed in code — **unverified in a real browser / no native build** |

---

## 2. Runtime module ledger — `MODULE_STATUS` (17 modules)

What the platform itself reports. **9 ported / 6 partial / 2 not-ported.**

### 2a. `not-ported` (2)

- **languageLearning** — Language learning and AI teacher
- **leadDiscovery** — Lead discovery

### 2b. `partial` (6)

- **publicSite** — Public site, SEO + PWA shell, contact intake (chat assistant not ported)
- **execution** — Human-reviewed paper proposals, fail-closed governance (no live route, no automated mode)
- **scheduledJobs** — Scheduled operations cron (CLI only, no HTTP route, no early-warning tiers)
- **brokers** — Broker connector boundary, normalized data contracts, demo-only gates (ten adapters, all disabled; no order routing; no adapter verified)
- **sports** — Sports foundation → decision chain → tickets → measured half, **with its console screen**; **stake sizing not ported** (its whole remainder)
- **lottery** — Lottery foundation → combinations → tickets → backtests → cron, **with its console screen**; **nothing left on its not-ported matrix**

### 2c. `ported` (9) — accepted, but each with a stated open gap

- **identity** — Identity, sessions, RBAC, account management
- **audit** — Security audit trail + read-only browser API **and its workspace screen** (no retention policy)
- **notifications** — Operator notifications, unread-deduped inbox **with its workspace screen** (**no outbound delivery channel**)
- **marketData** — Market data providers and health
- **analysis** — Analysis engines, agents, consensus (proposals only)
- **portfolioOptimizer** — Research-only mean-variance optimization **with its workspace screen** (weights only; no saved reports)
- **strategies** — Strategy lab, lifecycle, backtesting, durable AI review
- **paperTrading** — Owner-scoped simulation accounts, orders, fills, deployments
- **risk** — Risk engine, persisted limits, kill switch, paper-portfolio monitor

---

## 3. Named sub-areas explicitly declared "not ported"

### `SPORTS_NOT_PORTED` (1)

1. **Stake sizing** — no stake is sized from bankroll or edge; the configured fixed `stake_amount` is recorded, as legacy does. This is the matrix's whole remainder since Phase 28.

### `LOTTERY_NOT_PORTED` (0)

Empty — asserted empty by `test/lottery_http.test.js`: every area the matrix named has been ported.

### Finding F-29 — narrowed twice, still open (Phases 27 and 28)

**F-29 removed five items; it is not closed.** Each of these now has a workspace screen:

- ~~Notification inbox (`GET /api/v1/notifications`)~~ → `/app/notifications`
- ~~Audit browser (`GET /api/v1/admin/audit`)~~ → `/app/admin/audit`
- ~~Portfolio optimizer (`views/portfolio/optimizer.php`)~~ → `/app/portfolio/optimizer`
- ~~Sports consoles (`Sports::index`, `Sports::tickets`)~~ → `/app/sports`
- ~~Lottery console (`Lottery::index`)~~ → `/app/lottery`

**What F-29 still names:** the market-data (Phase 4), analysis (Phase 5) and Strategy
Lab (Phase 6) consoles — all three APIs are ported and none has a screen — plus,
from the same class of gap, the unported legacy consoles `brokers/index.php`,
`execution/index.php`, `journal/index.php`, `paper/index.php` + `account.php` and
`risk/index.php`. Settings screens and the per-domain dashboards are row 3's
remainder; the three consoles above are F-29's.

---

## 4. PHP-side unfinished work — `PLANNED` scaffolds (not live integrations)

### 4a. Feature-matrix `PLANNED` entries (`Api_system.php::FEATURES`)

- **Stock/ETF/futures/options data providers** — licensed-feed adapters scaffolded, no licensed source verified
- **Lottery data providers (official feeds)** — authorized-feed adapter scaffolded, no authorized source verified
- **MT4 / crypto exchange / stock broker connectors** — nine adapters scaffolded, none verified

### 4b. The nine `PLANNED` broker connector scaffolds (`Brokers.php`)

1. MetaTrader 4 (`mt4-bridge`)
2. Binance
3. Bybit
4. OKX
5. Coinbase
6. Kraken
7. InteractiveBrokers
8. Alpaca
9. OANDA

### 4c. README "Unfinished-module scaffolds"

- **Licensed asset market data** — `Aegis/Providers/LicensedAssetMarketDataProvider.php`
- **Official lottery feeds** — `Aegis/Lottery/OfficialLotteryProvider.php`
- **MT4, crypto and stock-broker connectors** — `Aegis/Brokers/ConfiguredTradingConnectors.php`

### 4d. Honest-abstention boundaries (code exists; no real feed configured anywhere)

- **Fundamentals** — `Aegis/Providers/FundamentalsFeed.php`
- **Sentiment (news/social)** — `Aegis/Providers/SentimentFeed.php`
- **Sports live data provider** — `Aegis/Sports/Providers/HttpSportsProvider.php`
- **On-chain and options providers** — not started (Phase 6 "next")

---

## 5. Written but unverified — remaining build/readiness gaps

These are code-complete but not yet proven, so they are not "done":

- **MT5 real-terminal validation** — Django-free Python bridge passes fake-terminal contract tests; no Windows MT5 host + demo account test (Phase 4).
- **Real MySQL/MariaDB validation** — Node migrations 001–019 and repository transactions never run against a real server (F-15).
- **PHP↔Node numeric parity diff** — F-26, still outstanding for market data, analysis and strategy numerics.
- **cPanel / Passenger host acceptance** — no deployment, cron line not installed, no backup/restore rollback rehearsal.
- **PWA / Capacitor** — no Lighthouse run, no install/update cycle observed, native sign-in deliberately disabled.
- **SMTP delivery** — mail path exists; no production transport verified, so no email-backed flow is claimed (`emailDeliveryAvailable: false`).
- **Scheduled live-provider probe (F-25)** and **multi-process health store (F-24)**.
- **Retention policy** — undecided and shared across audit, notifications, `wf_analysis_runs` (R-27), `wf_backtests` (R-28).
- **Settings screens + permissions** — the last of row 5, alongside the module cards' former audience.
- ~~Sports and lottery console screens~~ — ported in Phase 28; F-29 loses its sports and lottery halves and now names the market-data, analysis and Strategy Lab consoles.
- **Executable top-level artefacts:** bundled `application-deployment.zip` has drifted from the tree and must not be deployed until rebuilt (release action).

---

## 6. Summary counts

| Bucket | Count |
|---|---:|
| Node port backlog rows named | 23 |
| Node modules `not-ported` | 2 |
| Node modules `partial` (five of them now carry their console screen) | 6 |
| Node modules `ported` (with a stated open gap) | 9 |
| Sports sub-areas not ported | 1 (stake sizing) |
| Lottery sub-areas not ported | 0 (empty matrix) |
| PHP `PLANNED` feature-matrix entries | 3 |
| PHP `PLANNED` broker connector scaffolds | 9 |
| PHP provider/sentiment/fundamentals abstention boundaries | 4 |
