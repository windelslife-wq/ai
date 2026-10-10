# Phase 7 — Paper Trading, Governance and Portfolio Risk (2026-10-11)

Rows 10 and 11 of [`UNFINISHED_MODULES.md`](UNFINISHED_MODULES.md). The Node
implementation is simulation-only. This phase does **not** add a broker, an
execution supervisor, or a live-order route.

## 1. Implemented surface

| Area | Node implementation | Scope |
|---|---|---|
| Paper ledger arithmetic | `apps/workforce-platform/src/modules/paper/engine.js` | Risk sizing, spread/slippage/fees, fills, mandatory stop and 3R default target, limit touch, pessimistic stop-first exits, settlement and valuation |
| Paper service | `src/modules/paper/service.js` | Owner-scoped accounts, order submission, limit/stop/target ticks, manual close, journal/audit writes, strategy deployments, governance and portfolio scans |
| HTTP routes | `src/modules/paper/routes.js` | Account/order/position/tick/deployment endpoints and persisted risk/mode/kill-switch/synthetic-data controls |
| MySQL/MariaDB repository | `src/db/paper-repository.js` | Bound SQL, owner-qualified lookups/listings, decimal conversion, transaction-scoped repository methods |
| Development persistence | `src/persistence/file-store.js` | Serialized WAL batch for paper mutations; single-process only, not production multi-worker storage |
| Schema | `src/db/migrations/007_paper_trading.sql` | Governance row, owner-scoped paper accounts, orders, positions, trade legs, deployments, and synthetic provenance |
| Strategy approval | `src/modules/strategies/registry.js` | Synthetic paper journal rows are excluded from live-approval evidence; AI source is not rewritten by human review |

The migration also persists a one-time, attributed `human_signoff` record for an
AI strategy after `VALIDATED`. The sign-off route requires `trading.control`,
records an audit event, cannot overwrite an earlier sign-off, and does not move
the strategy lifecycle or change `source: "ai"`.

## 2. HTTP and authorization

All routes below are under `/api/v1` and require an authenticated session. Cookie
mutations also require the platform CSRF token.

| Methods and paths | Permission | Behaviour |
|---|---|---|
| `GET/POST /paper/accounts` | `trading.view` / `trading.execute` | List only the caller's accounts; create an account owned by the caller |
| `GET /paper/accounts/:accountId` | `trading.view` | Owner-only summary and valuation |
| `GET/POST /paper/accounts/:accountId/orders` | `trading.view` / `trading.execute` | List and submit simulated market/limit orders |
| `GET /paper/accounts/:accountId/positions` | `trading.view` | Owner-only open and closed positions |
| `POST /paper/accounts/:accountId/positions/:positionId/close` | `trading.execute` | Owner-only manual close |
| `POST /paper/accounts/:accountId/tick` | `trading.execute` | Process limit fills, protective exits and active strategy deployments |
| `GET/POST /paper/accounts/:accountId/deployments` | `trading.view` / `trading.execute` | List and deploy eligible, executable strategy versions |
| `POST /paper/accounts/:accountId/deployments/:deploymentId/toggle` | `trading.execute` | Pause or resume an owned deployment |
| `GET /risk/limits`, `GET /trading/mode` | `trading.view` | Read persisted global governance |
| `PATCH /risk/limits`, `POST /trading/mode`, `/trading/kill-switch`, `/trading/synthetic-paper` | `trading.control` | Validated, audited governance changes |
| `GET /portfolio/risk-scan` | `trading.view` | Scan only accounts owned by the authenticated user |

The service checks account ownership before provider or strategy work and repeats
the check under the mutation transaction. Account IDs supplied in a URL are
identifiers, **not authorization**. A guessed foreign account returns the same
not-found boundary for account details and its child resources.

## 3. Safety and provenance invariants

- **Fail-safe boot:** mode is `ANALYSIS_ONLY`, the kill switch is active, and
  synthetic paper data is disallowed. Missing state and invalid individual
  governance fields normalize to conservative defaults; corrupt serialized JSON
  fails closed rather than being silently replaced. Releasing controls requires
  `trading.control`.
- **Simulation only:** paper orders use only the market-data quote/candle
  interfaces. There is no broker dependency or Node live-order endpoint. Health
  status says paper is available, simulation-only, and live trading disabled.
- **Risk veto:** every fill is checked against the Node risk engine, including
  the actual order units, mandatory stop, risk/reward, exposure, drawdown, loss,
  notional/leverage, stale-data and synthetic-data gates. DV-10 remains intact:
  the Node risk engine vetoes non-positive or non-finite equity rather than
  approving an unmeasurable portfolio.
- **Synthetic provenance:** quote/candle provenance is copied to orders,
  positions, both trade legs and the journal. The global synthetic-paper switch
  is explicit and defaults off; relaxing the generic analysis `blockSyntheticData`
  limit cannot bypass this paper-specific gate. Synthetic journal trades do not
  count toward the strategy `APPROVED` evidence threshold.
- **Audit and journal:** accepted/rejected orders, fills, closes, governance
  changes, deployment actions and ticks carry actor attribution in audit rows.
  Closed paper positions append a `source: "paper"` journal row.
- **No duplicate net exposure per symbol:** the account transaction serializes
  competing order/tick updates, locks the MySQL account/governance rows, and
  enforces one open position or pending order per symbol. Stop-loss wins when a
  candle touches both stop and target.
- **Strategy governance:** deployment requires an executable version at
  `RISK_REVIEWED` or later. AI variants keep their `ai` source and require the
  separate persisted reviewer sign-off; a paper deployment does not authorize
  live execution.

## 4. Verification performed

The Phase 7 suite exercises the pure ledger fixtures, the service on a real
file-store WAL, HTTP authentication/CSRF/RBAC and owner isolation, SQL statement
and bind behavior through a recording fake pool, transaction commit/rollback
wiring, and static parsing/checks of migration 007. Final verification for this
revision: `npm test` reports **472/472 passing** across the workforce-platform
suite; `npm run verify:install` reports **29/29 checks passing**, including syntax
checks for 98 source files, Node 22.22.3, seven required migrations and 64
documented environment variables. The install check skipped the generated client
bundle because it is absent in this checkout. These are **local automated tests**;
they are not a PHP-versus-Node numeric diff or proof of production readiness.

The most relevant tests are:

- `test/paper.test.js` — pure arithmetic and protective-level fixtures.
- `test/paper_service.test.js` — persistence/restart, owner checks, governance,
  synthetic/stale vetoes, orders/fills/closes, ticks, deployments and scans.
- `test/paper_http.test.js` — permission inventory, CSRF, owner isolation and an
  HTTP paper round trip.
- `test/paper_store.test.js` — SQL owner predicates, bound writes and transaction
  wrapper behaviour against a recording fake connection.
- `test/migrator.test.js` — ordered migration file and SQL-splitter assertions.

The exact full-suite result is recorded in the handoff/test output for this
revision. A test passing against a fake pool is deliberately not described as a
real MySQL test.

## 5. Not verified / still open

1. **No real MySQL/MariaDB execution.** Migration 007 and the MySQL repository
   have not been run against a server in this environment. The SQL-focused tests
   record text and bound values only.
2. **No cPanel/Passenger rehearsal.** Host quotas, MySQL/MariaDB version, proxy,
   cron and deployment/rollback behaviour remain unvalidated. The file adapter
   does not claim cross-process safety and is not suitable for a multi-worker
   production deployment.
3. **No legacy parity sign-off.** The tests establish local Node behavior and
   preserve named safety rules; they do not establish complete endpoint or
   numerical parity with PHP. No full PHP↔Node fixture diff was run for this
   phase.
4. **No live market feed or broker.** Automated paper tests use deterministic
   fixtures or explicitly labelled synthetic data. No live upstream data was
   fetched, and live order routing remains unavailable by design.
5. **No paper-trading console or scheduler.** The API tick is callable, but no
   cron/worker is configured to invoke it. The legacy document UI remains a
   separate porting task.

Do not cut over the PHP application or enable live trading on the basis of this
phase alone. Keep the legacy service in place until the MySQL/cPanel rehearsal,
data/rollback checks, remaining module work and explicit human cutover approval
are complete.
