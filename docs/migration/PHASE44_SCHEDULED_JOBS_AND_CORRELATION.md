# Phase 44 — Early-Warning Risk Tiers, Leverage & Correlated Position Enforcement (Rows 11 & 19)

Phase 44 closes **`F-30`** (`maxCorrelatedPositions` enforcement), **`SJ-8`** (legacy `PortfolioRiskMonitor` 80% / 70% / 60% early-warning tiers), and **`SJ-9`** (`EXCESSIVE_LEVERAGE` and `CORRELATED_POSITIONS` equivalents in the Node portfolio risk scan), advancing **`scheduledJobs` (Row 19) from `partial` to `ported`** (taking `MODULE_STATUS` to **12 `ported` / 3 `partial` / 2 `not-ported`**).

---

## 1. Scope Closed in Phase 44

### 1.1 Static Disclosed Correlation Groups & Order-Time Enforcement (`F-30` — Row 11)
- **`apps/workforce-platform/src/modules/analysis/risk-engine.js`**:
  - Ports `CORRELATION_GROUPS` and `CORRELATION_MODEL_DESCRIPTION` (`"static disclosed groups (v1 heuristic, not statistical)"`) from `application/libraries/Aegis/Portfolio/PortfolioRiskMonitor.php`:
    - `CRYPTO_MAJORS`: `BTCUSDT`, `ETHUSDT`, `BNBUSDT`, `SOLUSDT`, `XRPUSDT`, `ADAUSDT`, `DOGEUSDT`
    - `USD_MAJORS`: `EURUSD`, `GBPUSD`, `AUDUSD`, `NZDUSD`
    - `USD_COUNTER`: `USDJPY`, `USDCAD`, `USDCHF`
    - `METALS`: `XAUUSD`, `XAGUSD`, `XAUEUR`
    - `ENERGY`: `USOIL`, `UKOIL`, `WTIUSD`, `NATGAS`, `NGUSD`
    - `US_EQUITY_INDEX`: `US30`, `US500`, `SPX500`, `NAS100`, `US100`
  - Exports `correlationGroupsForSymbol(symbol)` and `findCorrelatedGroupOverlaps(openSymbols)`.
  - Enforces `limits.maxCorrelatedPositions` inside `RiskEngine.evaluate(setup, context)` whenever `context.openSymbols` (or `context.positions`) is supplied: if opening `setup.symbol` would push any matching group's open position count above `limits.maxCorrelatedPositions`, the proposal is vetoed with:
    `Correlated position count in <GROUP> (<N>) would exceed limit <maxCorrelatedPositions>`.
- **`apps/workforce-platform/src/modules/paper/service.js`**:
  - `evaluatePaperRisk` passes `openSymbols: (summary.positions || []).map((position) => position.symbol)` into `risk.evaluate(setup, context)`, enforcing `maxCorrelatedPositions` on every paper market and limit order submission.

### 1.2 Early-Warning Tiers (`SJ-8`) & Leverage / Correlation Scan Codes (`SJ-9` — Row 19)
- **`apps/workforce-platform/src/modules/paper/service.js` (`portfolioRiskScan`)**:
  - Ports `EARLY_WARNING_RATIOS` (`portfolioExposure: 0.8`, `leverage: 0.8`, `drawdown: 0.7`, `dailyLoss: 0.6`) from `PortfolioRiskMonitor::scan()`:
    - `DAILY_LOSS_APPROACHING` (`warning`): emitted when `-dailyPnl / equity > maxDailyLossPct * 0.6` and `<= maxDailyLossPct`.
    - `DRAWDOWN_APPROACHING` (`warning`): emitted when `(peakEquity - equity) / peakEquity > maxDrawdownPct * 0.7` and `<= maxDrawdownPct`.
    - `PORTFOLIO_EXPOSURE_APPROACHING` (`warning`): emitted when `openRisk / equity > maxPortfolioExposurePct * 0.8` and `<= maxPortfolioExposurePct`.
    - `LEVERAGE_LIMIT` (`critical`) and `LEVERAGE_APPROACHING` (`warning`): computes `grossNotional = sum(units * current_price)` and `rawLeverage = grossNotional / equity`, emitting `LEVERAGE_LIMIT` above `maxLeverage` and `LEVERAGE_APPROACHING` above `maxLeverage * 0.8`.
    - `CORRELATED_POSITION_LIMIT` (`critical`) and `CORRELATED_GROUP_EXPOSURE` (`warning`): evaluates `findCorrelatedGroupOverlaps` across open positions, emitting `CORRELATED_POSITION_LIMIT` when a group's open position count exceeds `maxCorrelatedPositions` and `CORRELATED_GROUP_EXPOSURE` when `2 <= count <= maxCorrelatedPositions`.
  - Attaches `grossNotional` and `leverage` to each scanned account entry and `correlationModel` + `correlationGroups` to the top-level scan report.
- **`apps/workforce-platform/src/jobs/scheduled.js` & `apps/workforce-platform/client/src/risk.js`**:
  - Classifies `LEVERAGE_LIMIT` and `CORRELATED_POSITION_LIMIT` in `CRITICAL_BREACH_CODES` and `DAILY_LOSS_APPROACHING`, `DRAWDOWN_APPROACHING`, `PORTFOLIO_EXPOSURE_APPROACHING`, `LEVERAGE_APPROACHING`, and `CORRELATED_GROUP_EXPOSURE` in `WARNING_BREACH_CODES`.
  - Updates `RISK_SCAN_CODES` and `RISK_OTHER_LIMITS` in `/app/risk` so the Risk Center console renders the 16-code scan vocabulary and documents `maxCorrelatedPositions` as enforced (closing `F-30`).
- **`apps/workforce-platform/src/modules/platform/health.js`**:
  - Advances `scheduledJobs` from `state: "partial"` to `state: "ported"` (`12 ported`, `3 partial`, `2 not-ported`).

---

## 2. Verification

- `apps/workforce-platform/test/paper_service.test.js` — Order-time `maxCorrelatedPositions` veto across `CRYPTO_MAJORS`, uncorrelated symbol pass-through (`EURUSD`), `CORRELATED_GROUP_EXPOSURE`, `PORTFOLIO_EXPOSURE_APPROACHING`, `LEVERAGE_APPROACHING`, and `LEVERAGE_LIMIT`.
- `apps/workforce-platform/test/scheduled_jobs.test.js` — Source parity check against `application/libraries/Aegis/Portfolio/PortfolioRiskMonitor.php` (`CORRELATION_GROUPS` and `0.8 / 0.8 / 0.7 / 0.6` ratios) and `portfolioRiskSweep()` severity sorting across all 16 scan codes.
- `apps/workforce-platform/test/client_risk_console.test.js` & `test/platform_findings.test.js` — Client/cron breach code classification parity and 17-module status ledger assertions.
