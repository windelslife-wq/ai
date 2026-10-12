/**
 * Portfolio optimization service: the seam between the HTTP layer and the numeric core.
 *
 * Ports `Aegis\Platform::optimizePortfolio()` (`application/libraries/Aegis/Platform.php:187`)
 * and `portfolioPeriodsPerYear()` (`:296`). The optimizer itself does no I/O; this
 * module owns everything that does:
 *
 *  - fetching each asset's candle series through `marketData.candles`, the same seam
 *    the analysis, Strategy Lab and paper modules use, so the report is built from
 *    the same normalization, cache, circuit breakers and provenance labelling;
 *  - the **synthetic-data gates**, which are the honesty core of this endpoint;
 *  - annualization inference, which is only safe for a single market calendar;
 *  - the audit event, so a run is attributable after the fact;
 *  - the provenance block and the warnings that come from it.
 *
 * **Nothing here can place an order.** The output is weights plus a disclaimer; the
 * legacy controller's own header comment says the same ("No endpoint in this
 * controller routes orders") and that is preserved as a structural fact: this module
 * is not given the execution supervisor, the paper service, or the store's order
 * methods at all. It cannot reach them.
 */

import { AppError } from "../../http/errors.js";
import { marketDataFailure } from "../market-data/errors.js";
import {
  InvalidOptimizationError,
  MAX_ASSETS,
  MIN_ASSETS,
  MIN_RETURN_OBSERVATIONS,
  OptimizationUnavailableError,
  optimizePortfolio,
} from "./optimizer.js";

/** Market classes the legacy facade accepted. Anything else is refused, not defaulted. */
export const PORTFOLIO_MARKET_CLASSES = Object.freeze([
  "forex", "crypto", "commodity", "stock", "etf", "futures", "options", "indices", "bonds",
]);

/** Timeframes a portfolio may be optimized over — the legacy list. */
export const PORTFOLIO_TIMEFRAMES = Object.freeze(["15m", "1h", "4h", "1d"]);

/** Default history depth, and its legacy bounds: 31 minimum (30 returns + 1), 2000 maximum. */
export const DEFAULT_CANDLE_LIMIT = 500;
export const MIN_CANDLE_LIMIT = MIN_RETURN_OBSERVATIONS + 1;
export const MAX_CANDLE_LIMIT = 2000;

/** Bars per day for each timeframe, used only to derive annualization. */
const BARS_PER_DAY = Object.freeze({ "15m": 96, "1h": 24, "4h": 6, "1d": 1 });
/** Approximate regular exchange session length in hours, for intraday equity calendars. */
const EQUITY_SESSION_HOURS = 6.5;
const HOURS_PER_BAR = Object.freeze({ "15m": 0.25, "1h": 1.0, "4h": 4.0 });

/** Legacy audit action, preserved inside `details` so the PHP trail and the Node
 *  trail can be correlated after cutover without inventing a second vocabulary. */
const LEGACY_AUDIT_ACTION = "PORTFOLIO_OPTIMIZATION_RUN";

/** Audit action key, in this platform's dotted vocabulary. */
export const PORTFOLIO_OPTIMIZATION_AUDIT_ACTION = "portfolio.optimization.run";

export function createPortfolioService({
  store = null,
  marketData = null,
  log = null,
  now = () => Date.now(),
} = {}) {
  /**
   * @param {object} body already schema-validated: `{assets, timeframe?, limit?, objective?, maxWeight?, riskFreeRate?, shrinkage?, periodsPerYear?, allowSyntheticData?}`
   * @param {{actorId?: number|null, signal?: AbortSignal}} [options]
   * @returns {Promise<object>} the research report
   */
  async function optimize(body, { actorId = null, signal = null } = {}) {
    if (!marketData || typeof marketData.candles !== "function") {
      // A missing provider chain is a host configuration problem, not a bad request.
      // Answering 422 with invented prices would be the fabrication the plan forbids.
      throw AppError.unavailable(
        "Portfolio optimization requires the market-data provider chain, and none is configured on this host",
        { code: "PORTFOLIO_DATA_UNAVAILABLE", retryAfter: 30 },
      );
    }

    const assetsInput = Array.isArray(body.assets) ? body.assets : [];
    if (assetsInput.length < MIN_ASSETS || assetsInput.length > MAX_ASSETS) {
      throw new InvalidOptimizationError(
        `assets must contain ${MIN_ASSETS}–${MAX_ASSETS} {symbol, marketClass} entries`,
      );
    }

    const timeframe = String(body.timeframe ?? "1d").trim().toLowerCase();
    if (!PORTFOLIO_TIMEFRAMES.includes(timeframe)) {
      throw new InvalidOptimizationError("timeframe must be one of 15m, 1h, 4h or 1d");
    }

    const limit = Number.isInteger(body.limit) ? body.limit : DEFAULT_CANDLE_LIMIT;
    if (limit < MIN_CANDLE_LIMIT || limit > MAX_CANDLE_LIMIT) {
      throw new InvalidOptimizationError(`limit must be an integer between ${MIN_CANDLE_LIMIT} and ${MAX_CANDLE_LIMIT}`);
    }

    // Validated as a strict boolean by the schema; re-checked here because this
    // function is also called directly from tests and from any future CLI.
    const allowSynthetic = body.allowSyntheticData === true;

    const { assets, syntheticCount, classList } = await loadAssets(assetsInput, timeframe, limit, signal);

    // --- The synthetic-data gates -------------------------------------------------
    // A **mix** is refused outright rather than resolved in favour of whichever side
    // has more rows: comparing a real series against a generated one produces a
    // covariance that describes neither, and no label on the output could make that
    // number meaningful. All-synthetic is allowed only on an explicit opt-in, and
    // then only with a warning that starts with the word SIMULATION.
    if (syntheticCount > 0 && syntheticCount < assets.length) {
      throw new OptimizationUnavailableError("mixed synthetic and live data is not allowed in one portfolio optimization");
    }
    if (syntheticCount === assets.length && !allowSynthetic) {
      throw new OptimizationUnavailableError(
        "all available history is synthetic; retry with allowSyntheticData=true for a clearly labeled simulation",
      );
    }

    const periodsPerYear = body.periodsPerYear ?? portfolioPeriodsPerYear(timeframe, classList);

    const report = optimizePortfolio(assets, {
      objective: body.objective,
      maxWeight: body.maxWeight,
      riskFreeRate: body.riskFreeRate,
      shrinkage: body.shrinkage,
      periodsPerYear,
      timeframe,
    });

    report.request = {
      assets: assets.map((asset) => ({ symbol: asset.symbol, marketClass: asset.marketClass })),
      timeframe,
      limit,
      allowSyntheticData: allowSynthetic,
    };

    // Provenance is reported per asset and never summarized away: a reader must be
    // able to see that BTCUSDT came from a synthetic generator while EURUSD did not.
    report.dataProvenance = assets.map((asset) => ({
      symbol: asset.symbol,
      source: asset.provenance?.source ?? "unknown",
      synthetic: Boolean(asset.provenance?.synthetic),
      stale: Boolean(asset.provenance?.stale),
      fetchedAt: asset.provenance?.fetchedAt ?? null,
      dataTimestamp: asset.provenance?.dataTimestamp ?? null,
      validation: asset.provenance?.validation ?? {},
    }));

    for (const provenance of report.dataProvenance) {
      if (provenance.stale) {
        report.warnings.push(`${provenance.symbol} latest candle is marked stale by its market-data provider.`);
      }
      const gapCount = Number(provenance.validation?.gapCount ?? 0);
      if (gapCount > 0) {
        report.warnings.push(`${provenance.symbol} history contains ${Math.trunc(gapCount)} timeframe gap(s).`);
      }
    }
    if (syntheticCount > 0) {
      report.warnings.push(
        "SIMULATION: every input series is synthetic; weights and statistics do not represent real market behavior.",
      );
    }
    report.warnings = [...new Set(report.warnings)];

    await emitAudit(report, { assets, timeframe, syntheticCount, actorId });
    return report;
  }

  /**
   * Fetch and validate every asset's history.
   *
   * Sequential rather than parallel on purpose: one optimization can demand twelve
   * series, and firing twelve concurrent provider calls from one request is exactly
   * the fan-out risk R-26 exists to bound. The per-session concurrency cap on the
   * route bounds how many *optimizations* run at once; this bounds the calls within
   * one. A failure on any asset fails the whole request — a partial universe would
   * silently optimize a different portfolio than the one asked for.
   */
  async function loadAssets(assetsInput, timeframe, limit, signal) {
    const assets = [];
    const seen = new Set();
    let syntheticCount = 0;

    for (const rawAsset of assetsInput) {
      if (rawAsset === null || typeof rawAsset !== "object" || Array.isArray(rawAsset)) {
        throw new InvalidOptimizationError("each asset must be an object");
      }
      const symbol = String(rawAsset.symbol ?? "").trim().toUpperCase();
      const marketClass = String(rawAsset.marketClass ?? "").trim().toLowerCase();
      if (symbol === "" || !/^[A-Z0-9._:-]{1,64}$/.test(symbol)) {
        throw new InvalidOptimizationError("each asset needs a valid symbol");
      }
      // The facade checks the class *before* fetching, so an unsupported class costs
      // no provider call and cannot be discovered halfway through a twelve-asset run.
      if (!PORTFOLIO_MARKET_CLASSES.includes(marketClass)) {
        throw new InvalidOptimizationError(`invalid marketClass for ${symbol}`);
      }
      if (seen.has(symbol)) throw new InvalidOptimizationError(`duplicate asset symbol: ${symbol}`);
      seen.add(symbol);

      let series;
      try {
        // `marketData.candles` is the house seam every other module uses (analysis,
        // Strategy Lab, paper). It delegates to `manager.getCandleSeries` and returns
        // the same `{candles, provenance, validation}` shape, but it also applies the
        // symbol floor and the market-class inference, so this module cannot drift
        // into calling the manager directly and missing a rule the others get.
        series = await marketData.candles({ symbol, marketClass, timeframe, limit }, { signal });
      } catch (error) {
        // A provider failure is not a bad request. `marketDataFailure` is the shared
        // mapping every market-data consumer uses, so a portfolio run reports an
        // outage with the same 503, code and `Retry-After` as a candle request —
        // and it already carries the chain's own reason in `details.reason`, which
        // names the symbol. Duplicating that taxonomy here is how two endpoints
        // drift into describing the same outage differently.
        if (error instanceof AppError) throw error;
        throw marketDataFailure(error);
      }

      const synthetic = Boolean(series?.provenance?.synthetic);
      if (synthetic) syntheticCount += 1;
      assets.push({
        symbol,
        marketClass,
        candles: series.candles,
        // `validation` travels inside provenance so the report can warn about gaps
        // without the optimizer needing to know the field exists.
        provenance: { ...(series.provenance ?? {}), validation: series.validation ?? {} },
      });
    }

    const classList = [...new Set(assets.map((asset) => asset.marketClass))];
    return { assets, syntheticCount, classList };
  }

  /**
   * Conventional annualization factor for a timeframe and market calendar.
   *
   * Only inferred for a **single** market class. Crypto trades every day, forex
   * roughly 252, listed equities 252 with a 6.5-hour session — and a universe
   * mixing them has no one answer, so the caller must supply `periodsPerYear`
   * explicitly rather than be handed a number that is wrong for every asset in it.
   * Refusing is the honest outcome; averaging the calendars would not be.
   *
   * @throws {InvalidOptimizationError} when the universe spans more than one class
   *   and no explicit `periodsPerYear` was given
   */
  function portfolioPeriodsPerYear(timeframe, marketClasses) {
    if (marketClasses.length !== 1) {
      throw new InvalidOptimizationError(
        "periodsPerYear is required when optimizing across different market classes/calendars",
      );
    }
    const marketClass = marketClasses[0];
    const barsPerDay = BARS_PER_DAY[timeframe];
    if (!Number.isInteger(barsPerDay)) {
      throw new InvalidOptimizationError("timeframe must be one of 15m, 1h, 4h or 1d");
    }
    if (marketClass === "crypto") return 365 * barsPerDay;
    if (marketClass === "forex") return 252 * barsPerDay;
    if (timeframe === "1d") return 252;
    const hoursPerBar = HOURS_PER_BAR[timeframe];
    return Math.max(1, Math.round((252 * EQUITY_SESSION_HOURS) / hoursPerBar));
  }

  /**
   * Record the run.
   *
   * Failure to persist is **logged, not thrown**: the optimization is already
   * computed and correct, and refusing to return a valid research report because
   * the audit write failed would make the endpoint less useful without making
   * anything safer. This is the same trade the notification publishers make.
   *
   * The event records the objective, the universe, whether the inputs were
   * synthetic and the selected weights — enough to answer "what was this person
   * shown" without storing the whole report.
   */
  async function emitAudit(report, { assets, timeframe, syntheticCount, actorId }) {
    if (!store) return;
    const symbols = assets.map((asset) => asset.symbol);
    try {
      await store.recordAudit({
        actorId: actorId ?? null,
        action: PORTFOLIO_OPTIMIZATION_AUDIT_ACTION,
        entityType: "portfolio",
        entityId: null,
        details: {
          // The legacy `emit()` took a human-readable summary and there is no
          // summary column, so it travels in `details` where it stays searchable —
          // the same accommodation the strategy registry makes.
          legacyAction: LEGACY_AUDIT_ACTION,
          summary: `Portfolio optimization (${report.objective}, ${assets.length} assets, ${report.window.returnObservations} aligned returns)`,
          objective: report.objective,
          assets: symbols,
          assetCount: assets.length,
          timeframe,
          synthetic: syntheticCount > 0,
          returnObservations: report.window.returnObservations,
          selectedWeights: report.allocations.selected.weights,
        },
      });
    } catch (error) {
      if (log) log.warn({ err: error }, "portfolio optimization audit event could not be recorded");
    }
  }

  return {
    optimize,
    portfolioPeriodsPerYear,
    /** Exposed for tests and for any future CLI: the numeric core, un-wrapped. */
    optimizePortfolio,
    now,
  };
}
