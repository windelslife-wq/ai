/**
 * Risk engine — an independent veto authority.
 *
 * Ported from `application/libraries/Aegis/RiskEngine.php`. The legacy platform
 * documents this as Rule 6: nothing may bypass it, and the AI stack never holds a
 * broker handle. `evaluate()` receives a *proposal* plus portfolio state and
 * returns an explicit, auditable decision — it never edits the proposal.
 *
 * The order of `reasons` is part of the contract: the kill switch is checked
 * first, then the two data-honesty vetoes (synthetic, stale), then data quality,
 * then the proposal's own geometry, then the portfolio gates. Callers and tests
 * read `reasons[0]` as "the most important objection".
 *
 * Exposure is capital at risk on a stop-distance basis, not notional — a 50k
 * notional position risking 100 dollars is not the same exposure as one risking
 * 5 000, and the limits are written for the second number.
 *
 * Ported here (rather than left for the later `risk` module) because the analysis
 * engine cannot produce a run without it: every proposal it emits is measured by
 * these gates, including the synthetic-data veto that keeps labelled simulation
 * data from becoming a trade idea. The rest of the risk module — the portfolio
 * monitor, the limits API, the kill-switch control surface — is still unported;
 * `docs/migration/PHASE5_ANALYSIS.md` records that split.
 */

import { numberFormat, roundTo } from "./math.js";

export const DEFAULT_RISK_LIMITS = Object.freeze({
  riskPerTradePct: 0.01,
  maxRiskPerTradePct: 0.02,
  minRiskReward: 1.5,
  requireStopLoss: true,
  maxPositionNotionalUsd: 50_000,
  maxLeverage: 5,
  maxOpenPositions: 10,
  maxDailyLossPct: 0.03,
  maxWeeklyLossPct: 0.06,
  maxDrawdownPct: 0.1,
  // Exposure = CAPITAL AT RISK (stop-distance basis), not notional.
  maxSymbolExposurePct: 0.05,
  maxPortfolioExposurePct: 0.15,
  maxCorrelatedPositions: 3,
  minDataQuality: 0.5,
  blockSyntheticData: true,
  blockStaleData: true,
});

/**
 * Static, disclosed correlation groups ported from `PortfolioRiskMonitor::CORRELATION_GROUPS`
 * (`application/libraries/Aegis/Portfolio/PortfolioRiskMonitor.php`).
 *
 * This is a v1 heuristic over asset classes and currency legs — not a live return-covariance
 * matrix — and is disclosed as such in both the portfolio scan and the Risk Engine veto.
 */
export const CORRELATION_GROUPS = Object.freeze({
  CRYPTO_MAJORS: Object.freeze(["BTCUSDT", "ETHUSDT", "BNBUSDT", "SOLUSDT", "XRPUSDT", "ADAUSDT", "DOGEUSDT"]),
  USD_MAJORS: Object.freeze(["EURUSD", "GBPUSD", "AUDUSD", "NZDUSD"]),
  USD_COUNTER: Object.freeze(["USDJPY", "USDCAD", "USDCHF"]),
  METALS: Object.freeze(["XAUUSD", "XAGUSD", "XAUEUR"]),
  ENERGY: Object.freeze(["USOIL", "UKOIL", "WTIUSD", "NATGAS", "NGUSD"]),
  US_EQUITY_INDEX: Object.freeze(["US30", "US500", "SPX500", "NAS100", "US100"]),
});

export const CORRELATION_MODEL_DESCRIPTION = "static disclosed groups (v1 heuristic, not statistical)";

/**
 * Legacy `PortfolioRiskMonitor::scan()` early-warning ratios (`SJ-8`):
 * - 80% of portfolio exposure (`maxPortfolioExposurePct`) and notional leverage (`maxLeverage`)
 * - 70% of maximum drawdown (`maxDrawdownPct`)
 * - 60% of daily loss (`maxDailyLossPct`)
 */
export const EARLY_WARNING_RATIOS = Object.freeze({
  portfolioExposure: 0.8,
  leverage: 0.8,
  drawdown: 0.7,
  dailyLoss: 0.6,
});

export function correlationGroupsForSymbol(symbol) {
  const normalized = String(symbol ?? "").trim().toUpperCase();
  if (!normalized) return [];
  const groups = [];
  for (const [group, members] of Object.entries(CORRELATION_GROUPS)) {
    if (members.includes(normalized)) groups.push(group);
  }
  return groups;
}

export function findCorrelatedGroupOverlaps(openSymbols) {
  const open = Array.isArray(openSymbols)
    ? openSymbols.map((symbol) => String(symbol ?? "").trim().toUpperCase()).filter(Boolean)
    : [];
  const overlaps = [];
  for (const [group, members] of Object.entries(CORRELATION_GROUPS)) {
    const memberSet = new Set(members);
    const overlap = open.filter((symbol) => memberSet.has(symbol));
    if (overlap.length > 0) {
      overlaps.push({ group, symbols: overlap, count: overlap.length });
    }
  }
  return overlaps;
}

function finiteNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : NaN;
}

export function createRiskEngine(limits = {}) {
  let current = { ...DEFAULT_RISK_LIMITS, ...limits };

  function getLimits() {
    return { ...current };
  }

  function updateLimits(patch) {
    current = { ...current, ...patch };
    // A configured risk can never exceed the hard cap, whatever was supplied.
    current.riskPerTradePct = Math.min(current.riskPerTradePct, current.maxRiskPerTradePct);
    return getLimits();
  }

  /**
   * @param {object} setup proposal with `entry.reference`, `stopLoss`, `riskReward`, `symbol`
   * @param {object} context kill switch, data honesty flags, equity and open exposure
   * @returns {{approved: boolean, checkedAt: string, reasons: string[], warnings: string[], sizing: object|null}}
   */
  function evaluate(setup, context) {
    const reasons = [];
    const warnings = [];
    const limits = current;
    const equity = finiteNumber(context.equity);

    if (context.killSwitchActive) {
      reasons.push("Kill switch is ACTIVE — all trade proposals are vetoed");
    }
    if (context.syntheticData && limits.blockSyntheticData) {
      reasons.push("Setup is built on SYNTHETIC data — live risk decisions require real market data");
    }
    if (context.staleData && limits.blockStaleData) {
      reasons.push("Market data is stale beyond the freshness threshold");
    }
    const dataQuality = context.dataQuality ?? 1;
    if (dataQuality < limits.minDataQuality) {
      reasons.push(`Data quality ${numberFormat(dataQuality, 2)} below minimum ${limits.minDataQuality}`);
    }

    /**
     * Divergence DV-10 — the one place this port deliberately refuses to reproduce
     * the legacy engine (finding F-27).
     *
     * Every portfolio gate below is guarded by `equity > 0`, and sizing derives
     * risk from equity, so with zero equity the legacy engine skipped the
     * drawdown, daily/weekly-loss and exposure gates *and* cleared the notional
     * and leverage caps trivially (0 <= cap) — then returned `approved: true` for
     * a proposal with no capital behind it. A negative or non-finite equity did
     * the same.
     *
     * Without positive equity there is no basis for sizing, exposure or drawdown,
     * so the honest answer is a veto that names the reason rather than an
     * approval that measures nothing. The legacy PHP is left untouched until
     * cutover; the divergence is recorded in `PHASE5_ANALYSIS.md` §5 as DV-10 and
     * the reason string is asserted by test so it cannot be dropped silently.
     *
     * No legacy case is affected: `tests/cases/04-risk-engine.php` uses equity 100
     * and 10 000, so all eight ported cases still pass unchanged.
     */
    if (!Number.isFinite(equity) || equity <= 0) {
      reasons.push(Number.isFinite(equity)
        ? `Equity ${numberFormat(equity, 2)} is not positive — portfolio risk cannot be measured`
        : "Equity is not a finite number — portfolio risk cannot be measured");
    }

    const stopLoss = finiteNumber(setup.stopLoss);
    if (limits.requireStopLoss && !Number.isFinite(stopLoss)) reasons.push("Stop loss is required");
    if (limits.riskPerTradePct > limits.maxRiskPerTradePct) {
      reasons.push(`Configured risk per trade ${limits.riskPerTradePct * 100}% exceeds hard cap ${limits.maxRiskPerTradePct * 100}%`);
    }
    const riskReward = finiteNumber(setup.riskReward) || 0;
    if (riskReward < limits.minRiskReward) {
      reasons.push(`Risk/reward ${numberFormat(riskReward, 2)} below minimum ${limits.minRiskReward}`);
    }

    let sizing = null;
    if (Number.isFinite(stopLoss)) {
      const entry = finiteNumber(setup.entry?.reference);
      const stopDistance = Math.abs(entry - stopLoss);
      if (stopDistance > 0 && Number.isFinite(entry)) {
        // Broker execution passes the ACTUAL order volume (givenUnits), so the
        // sizing/notional/leverage checks apply to the real order instead of a
        // derived position. Analysis proposals never carry it.
        const givenUnits = context.givenUnits ?? null;
        let units;
        let riskAmount;
        let riskPct;
        if (givenUnits !== null && Number.isFinite(Number(givenUnits)) && Number(givenUnits) > 0) {
          units = Number(givenUnits);
          riskAmount = units * stopDistance;
          riskPct = equity > 0 ? riskAmount / equity : 1;
        } else {
          riskPct = Math.min(limits.riskPerTradePct, limits.maxRiskPerTradePct);
          riskAmount = equity * riskPct;
          units = riskAmount / stopDistance;
        }
        const notional = units * entry;
        const leverage = equity > 0 ? notional / equity : null;
        if (notional > limits.maxPositionNotionalUsd) {
          reasons.push(`Position notional $${numberFormat(notional, 0)} exceeds limit $${numberFormat(limits.maxPositionNotionalUsd, 0)}`);
        }
        if (leverage !== null && leverage > limits.maxLeverage) {
          reasons.push(`Implied leverage ${numberFormat(leverage, 1)}x exceeds limit ${limits.maxLeverage}x`);
        }
        if (givenUnits !== null && Number.isFinite(Number(givenUnits)) && riskPct > limits.maxRiskPerTradePct) {
          reasons.push(`Order risk ${numberFormat(riskPct * 100, 2)}% of equity exceeds hard cap ${limits.maxRiskPerTradePct * 100}%`);
        }
        sizing = {
          equity: roundTo(equity, 2),
          riskAmount: roundTo(riskAmount, 2),
          riskPct: roundTo(riskPct, 4),
          entryReference: entry,
          stopDistance,
          units: roundTo(units, 2),
          notionalUsd: roundTo(notional, 2),
          impliedLeverage: leverage !== null ? roundTo(leverage, 2) : null,
        };
      }
    }

    // Portfolio gates, on the capital-at-risk basis.
    const openRiskBySymbol = context.openRiskBySymbol ?? {};
    const openRisk = Object.values(openRiskBySymbol)
      .reduce((sum, value) => sum + (Number.isFinite(Number(value)) ? Number(value) : 0), 0);
    const thisTradeRisk = sizing !== null ? sizing.riskAmount : 0;
    if (equity > 0 && (openRisk + thisTradeRisk) / equity > limits.maxPortfolioExposurePct) {
      reasons.push(`Total open risk ${numberFormat(((openRisk + thisTradeRisk) / equity) * 100, 1)}% would exceed limit ${numberFormat(limits.maxPortfolioExposurePct * 100)}%`);
    }
    const symbolRisk = finiteNumber(openRiskBySymbol[setup.symbol] ?? 0) + thisTradeRisk;
    if (equity > 0 && symbolRisk / equity > limits.maxSymbolExposurePct) {
      reasons.push(`Risk concentration in ${setup.symbol} would exceed ${numberFormat(limits.maxSymbolExposurePct * 100)}% of equity`);
    }
    if ((context.openPositions ?? 0) + 1 > limits.maxOpenPositions) {
      reasons.push(`Open position count would exceed limit ${limits.maxOpenPositions}`);
    }
    const openSymbols = Array.isArray(context.openSymbols)
      ? context.openSymbols.map((symbol) => String(symbol ?? "").trim().toUpperCase()).filter(Boolean)
      : Array.isArray(context.positions)
        ? context.positions.map((position) => String(position?.symbol ?? "").trim().toUpperCase()).filter(Boolean)
        : null;
    if (openSymbols && setup.symbol) {
      for (const group of correlationGroupsForSymbol(setup.symbol)) {
        const memberSet = new Set(CORRELATION_GROUPS[group] || []);
        const openInGroup = openSymbols.filter((symbol) => memberSet.has(symbol)).length;
        if (openInGroup + 1 > limits.maxCorrelatedPositions) {
          reasons.push(`Correlated position count in ${group} (${openInGroup + 1}) would exceed limit ${limits.maxCorrelatedPositions}`);
        }
      }
    }
    if (equity > 0) {
      if (-(finiteNumber(context.dailyPnl) || 0) / equity > limits.maxDailyLossPct) reasons.push("Daily loss limit exceeded");
      if (-(finiteNumber(context.weeklyPnl) || 0) / equity > limits.maxWeeklyLossPct) reasons.push("Weekly loss limit exceeded");
      const peak = finiteNumber(context.peakEquity) || equity;
      const drawdown = peak > 0 ? (peak - equity) / peak : 0;
      if (drawdown > limits.maxDrawdownPct) {
        reasons.push(`Maximum drawdown ${numberFormat(drawdown * 100, 1)}% exceeds limit ${numberFormat(limits.maxDrawdownPct * 100)}%`);
      }
    }
    if ((setup.entry?.min ?? 0) >= (setup.entry?.max ?? 1)) warnings.push("Entry zone is degenerate");

    return {
      approved: reasons.length === 0,
      checkedAt: new Date().toISOString(),
      reasons,
      warnings,
      sizing,
    };
  }

  return { getLimits, updateLimits, evaluate };
}
