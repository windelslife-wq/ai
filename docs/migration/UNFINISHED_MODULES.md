# Unfinished modules and migration work

**Updated:** 2026-10-05 · **Scope:** the full Node.js/cPanel replacement requested by the user.

## How to read this list

“Unfinished” means **not yet implemented and parity-accepted in the Node.js modular-monolith target**. Several items below already exist and pass tests in the PHP application; they are still unfinished as Node ports. This list does not imply that tested PHP features should be rebuilt or that scaffolded integrations are live.

## Node.js module backlog

| # | Module / workstream | Current situation | Still required for Node acceptance |
|---:|---|---|---|
| 1 | **Identity, authentication and legacy account import** | Node has initial session/RBAC routes and a dry-run-first identity importer. No source data has been imported; no real MySQL run. | Real-DB import rehearsal, role/permission parity, profile-file plan, session re-login plan, account-isolation and auth parity tests, then approval to import. |
| 2 | **Account management, registration, password reset and admin users** | PHP has tested account management. Node has no registration/reset/admin-management UI or complete account workflows. | Port the existing behavior, mail/reset security, rate limits, CSRF, audit, and account ownership tests. |
| 3 | **Shared app shell, dashboards, settings and navigation** | PHP server-rendered UI exists; Node root is only a status response. | Build the target UI and responsive authenticated workspace after the cPanel frontend strategy is decided. |
| 4 | **Public website, help/contact and SEO** | PHP site and SEO routes exist. | Port public pages, contact handling, robots/sitemap and metadata; preserve safe caching and avoid exposing authenticated pages. |
| 5 | **Notifications, audit browser, feature/status reporting and system health** | PHP implementations are tested; Node foundation currently has operational health endpoints and authentication audit events only. | Port notification workflows, audit views, feature honesty matrix, settings, and security-event retention. |
| 6 | **Market data and provider health** | PHP provider chain and Binance/Frankfurter adapters are tested with deterministic fixtures; Node implementation absent. | Port normalization, provenance, retries, circuit breakers, freshness, cache/fallback and provider-health behavior; add real MySQL/provider contract tests. |
| 7 | **Analysis engines, specialized agents and consensus/debate** | Implemented/tested in PHP; absent from Node. | Port indicators, candle/timeframe handling, regime/setup logic, agents, abstention rules, consensus, debate and analysis history with parity tests. |
| 8 | **Strategy Lab, lifecycle, backtesting and model/decision analytics** | PHP strategy registry, optimizer, backtester, journal and calibration are tested; Node port absent. | Port versioning/lifecycle gates, next-bar execution, costs, look-ahead protection, out-of-sample evaluation, journal, metrics and calibration. |
| 9 | **Research-only portfolio optimization** | The PHP version is implemented and tested in this branch; it never routes orders. | Port its input/provenance contracts, covariance/shrinkage calculations, constraints, synthetic-data gates and warnings to Node; verify identical fixtures. |
| 10 | **Paper trading and strategy deployments** | PHP engine and governance chain are tested; Node port absent. | Port accounts, orders, fills, positions, ticks, deployments, journals and all safety gates. |
| 11 | **Risk Center and portfolio risk monitor** | PHP Risk Engine and portfolio monitor are tested; Node port absent. | Port veto rules, sizing/exposure limits, drawdown/loss checks, correlation warnings and notification/audit behavior. |
| 12 | **Execution Supervisor and trading governance** | PHP has the tested ordered 15-step supervisor, kill switch, approvals, expiry and automation envelope; Node port absent. | Port every step in order, require negative bypass tests, preserve default `ANALYSIS_ONLY`/kill-switch state, and prove no agent can route orders. |
| 13 | **Broker Center and broker connectors** | PHP connector contract and MT5 path are tested against a simulated/fake bridge only; most other adapters are disabled scaffolds. | Port the Node-facing connector boundary and health/demo gates; verify MT5 against a real demo terminal before any real-routing claim. |
| 14 | **Sports intelligence** | PHP pipeline, ticket governance, settlement, backtests, calibration, monitoring and UI are tested; Node port absent. | Port service/API/UI/data mappings and parity tests. A live provider is not currently configured. |
| 15 | **Lottery intelligence and Operations console** | EuroMillions rules, statistics, generator, tickets, backtests and the new operations console are implemented/tested in PHP; Node port absent. | Port the complete data/domain/API/UI surface, user scoping, RBAC/CSRF, report history and safe provider controls. |
| 16 | **Language learning / AI teacher** | PHP learning paths, lessons, vocabulary/SRS, adaptive plans and honest browser listening/speaking boundaries are tested; Node port absent. | Port learner data and strict profile ownership, assessments, lessons, conversation/writing/grammar, SRS, adaptive recommendations and unsupported-feature honesty. |
| 17 | **Lead Discovery: CI3 module + Scout consolidation** | PHP MySQL and Scout PostgreSQL/Redis implementations coexist with overlapping APIs; Scout API/web use TypeScript. | Decide canonical identity/IDs and persistence semantics, migrate Scout to supported MySQL/MariaDB for cPanel where required, convert runtime code to JavaScript, consolidate without dropping organization isolation, and port UI/API parity. |
| 18 | **Chat, journal, trading tools and remaining platform surfaces** | PHP surfaces are implemented to varying tested levels; Node equivalents absent. | Inventory every remaining controller/route/view/table and migrate each explicitly; do not infer that listed modules cover every convention route. |
| 19 | **Scheduled jobs, CLI and resumable work** | PHP cron jobs are idempotent; the Node foundation has no business cron jobs. | Build short-lived Node CLI entry points, DB-backed locks, bounded batches/checkpoints, retry behavior and cPanel cron schedules. No persistent shell worker. |
| 20 | **Football Predictions app integration** | It is already an independent JavaScript/Express/MySQL app with 29 tests and cPanel notes. | Decide whether it stays an isolated app or is consolidated; verify first-run MySQL, live provider and cPanel staging. Do not break its isolation/safety contract. |
| 21 | **Python MT5 bridge conversion or explicit exception** | FastAPI/Python bridge is contract-tested against a fake terminal and requires a Windows MT5 host. | Design/test a safe Node-compatible adapter or retain the Python bridge as a documented, bounded exception. A real demo terminal check is still outstanding; do not claim full-JavaScript completion meanwhile. |
| 22 | **Full legacy data migration and cutover** | Identity importer code is present but unexecuted; no business-data importer, checksum reconciliation, delta plan or restore rehearsal exists. | Map every legacy table, build resumable verified imports, rehearse backups/restore, prove rollback, stage cPanel deployment and obtain explicit cutover approval. |

## Outstanding PHP-side provider / readiness gaps

These are not invitations to fabricate an adapter or mark a scaffold live. They require authorized contracts, credentials, a test host or other external evidence:

- **Licensed stock, ETF, futures and options market data:** provider boundary exists; no verified licensed source is configured.
- **Fundamentals, on-chain and options sentiment sources:** current boundaries abstain honestly; a real attributable feed is not configured.
- **Sports live data provider:** existing pipeline has no configured live provider.
- **Official lottery feed:** provider boundary exists; authorized source contract/credentials and real feed validation are still required.
- **MT4 and crypto/stock brokers:** MetaTrader 4, Binance, Bybit, OKX, Coinbase, Kraken, Interactive Brokers, Alpaca and OANDA are not verified live integrations; current adapters remain gated scaffolds.
- **MT5 real-terminal validation:** fake-terminal contracts pass, but Windows host + demo-account end-to-end validation remains.
- **Lottery result-verification workflow, broader configuration-change governance, security/E2E and production-readiness review:** called out as follow-up in the current PHP README; the underlying tested engine/console is not itself an official live feed.
- **SMTP delivery and real external provider calls:** code/configuration or contract behavior exists, but production host/network credentials are unverified.

## cPanel / deployment gates

- Confirm the actual host's Node 22+ Application Manager/Passenger, proxy behavior, quotas, cron limits, MySQL/MariaDB features, outbound access and PHP+Node coexistence.
- Run the Node migrations and repository tests against a real MySQL/MariaDB service; current Node database tests use fake pools.
- Produce and test a clean production package, environment/secret setup, backup/restore, health checks, logs, uploads and rollback on the target host.
- Keep the PHP system live until module parity, data verification, rollback rehearsal, stability window and explicit human approval are complete.

## Recommended implementation order

Follow `docs/migration/NODEJS_CPANEL_MIGRATION_MASTER_PLAN.md`: finish identity/shared-platform acceptance; migrate market data and analysis; strategies/backtesting; paper trading/risk; execution/brokers; Lottery; language learning; Lead Discovery/Scout; then remaining surfaces and separate apps. Accept one module at a time. Do not enable live trading or unsupported providers while building the ports.
