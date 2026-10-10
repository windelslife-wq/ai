/**
 * Event-driven backtester: next-bar-open fills, a full cost model, pessimistic
 * stop handling, and a hard look-ahead guard.
 *
 * Ported from `application/libraries/Aegis/Backtest/Backtester.php`.
 *
 * The design choices here are the ones that decide whether a backtest is
 * evidence or fiction, so they are stated plainly:
 *
 *  - **Signals fill at the *next* bar's open, never the bar that produced them.**
 *    A signal is computed from a closed bar; acting on that bar's close would be
 *    trading on a price that was already gone. This is why the loop carries a
 *    `pending` order across one iteration instead of filling inline.
 *  - **Costs are applied to every fill.** Half-spread plus slippage move the
 *    fill price away from the trader, and a fee is charged on notional both ways.
 *    A strategy that looks profitable only because costs were omitted is the most
 *    common backtest lie, and it is not available here.
 *  - **When one bar touches both the stop and the target, the stop wins.** The
 *    intrabar path is unknown, so the pessimistic assumption is taken. Oracle
 *    case `06-backtester.php` pins this ("stop fills first").
 *  - **A position can stop out on its entry bar.** The same bar is re-tested
 *    immediately after the fill, so `barsHeld: 0` is a real outcome rather than
 *    something the loop skips.
 *  - **Look-ahead is fatal.** `LookAheadError` is rethrown, not recorded as a
 *    warning, because a biased run must never be persisted as a result. Any
 *    *other* strategy exception is non-fatal: it is recorded in `warnings` and
 *    the bar is treated as HOLD, so one bad bar does not destroy an otherwise
 *    valid run.
 *  - **Equity is marked to market every bar** and the curve is reconciled with
 *    the cost decomposition, which oracle case `06-backtester.php` checks
 *    arithmetically rather than by snapshot.
 *
 * Two deliberate divergences from the legacy, both recorded in the phase doc:
 *
 *  1. **Timestamps are well-formed ISO-8601.** The legacy `iso()` builds
 *     `gmdate('Y-m-d\TH:i:s\Z', …)` — where `\Z` is a *literal* Z in PHP's date
 *     format — and then appends `.mmm` and a second `Z`, producing
 *     `2025-08-12T14:40:00Z.123Z`. That string is an Invalid Date in JavaScript
 *     and does not match this repo's own `assertIsoCutoff` pattern, so it cannot
 *     be sorted or range-filtered as text. This port emits
 *     `2025-08-12T14:40:00.123Z`. No oracle assertion pins the legacy spelling,
 *     which is why the defect survived there.
 *  2. **`created_at` uses the `Z` form, not `gmdate('c')`'s `+00:00` form.** The
 *     two spellings sort differently as text for the same instant, and mixing
 *     them across tables would silently corrupt any cutoff comparison. The `Z`
 *     form is the house convention already used by `wf_analysis_runs`.
 */

import { randomUUID } from "node:crypto";
import { roundTo } from "../analysis/math.js";
import { LookAheadError, SeriesView, precomputeIndicators } from "./series-view.js";
import { computeMetrics } from "./metrics.js";

/**
 * Backtest request defaults.
 *
 * These are also the only keys a caller may override: `resolveBacktestRequest`
 * intersects the input against this object, so an unrecognised key is ignored
 * rather than smuggled into the run. Every value is a cost or risk assumption,
 * which means the defaults are a statement about what a realistic fill looks
 * like — 2bp fee, 1bp spread (charged as half on each side), 2bp slippage.
 */
export const BACKTEST_DEFAULTS = Object.freeze({
  limit: 720,
  initialEquity: 10_000,
  riskPct: 0.01,
  feeBps: 2.0,
  spreadBps: 1.0,
  slippageBps: 2.0,
  allowShorts: false,
  warmupBars: 60,
  maxBarsInTrade: 200,
});

/**
 * A backtest below this many candles is refused rather than reported.
 *
 * With a 60-bar indicator warmup, fewer than 120 bars leaves almost nothing to
 * trade on, and the resulting metrics would look like a measurement of the
 * strategy while actually being a measurement of the sample.
 */
export const MIN_BACKTEST_CANDLES = 120;

/** Hard bounds on how much history one run may request. */
export const BACKTEST_LIMIT_MIN = 60;
export const BACKTEST_LIMIT_MAX = 5000;

/** Per-trade risk ceiling. Above this a single loss can end the account. */
export const MAX_RISK_PCT = 0.05;

/**
 * Format a millisecond epoch as well-formed ISO-8601 in UTC.
 *
 * @param {number} ms
 * @returns {string} e.g. `2025-08-12T14:40:00.123Z`
 */
export function isoUtc(ms) {
  return new Date(Number(ms)).toISOString();
}

/**
 * Thrown for a malformed backtest request.
 *
 * Carries `statusCode: 400` so the HTTP layer can map it directly, matching how
 * the legacy controller turns `InvalidArgumentException` into a 400.
 */
export class BacktestRequestError extends Error {
  constructor(message, code = "BACKTEST_REQUEST_INVALID") {
    super(message);
    this.name = "BacktestRequestError";
    this.code = code;
    this.statusCode = 400;
  }
}

/**
 * Thrown when the requested range holds too few candles to be meaningful.
 *
 * Separated from `BacktestRequestError` because the request was well-formed —
 * the *data* was insufficient. The legacy controller maps this class of failure
 * to 400 as well, and the HTTP layer keeps that.
 */
export class InsufficientHistoryError extends Error {
  constructor(message) {
    super(message);
    this.name = "InsufficientHistoryError";
    this.code = "INSUFFICIENT_HISTORY";
    this.statusCode = 400;
  }
}

/**
 * Merge caller overrides onto the defaults, then clamp and validate.
 *
 * Only keys present in `BACKTEST_DEFAULTS` are honoured, plus the four identity
 * fields. Validation refuses out-of-range risk assumptions instead of clamping
 * them: silently clamping a requested `riskPct` of 0.5 down to 0.05 would report
 * results the caller did not ask for, which is worse than an error.
 *
 * @param {Record<string, unknown>} input
 * @returns {Record<string, unknown>} the resolved request
 * @throws {BacktestRequestError}
 */
export function resolveBacktestRequest(input) {
  const source = input ?? {};
  const request = { ...BACKTEST_DEFAULTS };

  for (const key of Object.keys(BACKTEST_DEFAULTS)) {
    if (source[key] !== undefined && source[key] !== null) request[key] = source[key];
  }

  request.strategyId = String(source.strategyId ?? "");
  request.strategyVersion = String(source.strategyVersion ?? "");
  request.symbol = String(source.symbol ?? "").trim().toUpperCase();
  request.marketClass = String(source.marketClass ?? "");
  request.timeframe = String(source.timeframe ?? "");

  const limit = Number(request.limit);
  if (!Number.isFinite(limit)) throw new BacktestRequestError("limit must be a number");
  request.limit = Math.min(Math.max(BACKTEST_LIMIT_MIN, Math.trunc(limit)), BACKTEST_LIMIT_MAX);

  const initialEquity = Number(request.initialEquity);
  if (!Number.isFinite(initialEquity) || initialEquity <= 0) {
    throw new BacktestRequestError("initialEquity must be positive");
  }
  request.initialEquity = initialEquity;

  const riskPct = Number(request.riskPct);
  if (!Number.isFinite(riskPct) || riskPct <= 0 || riskPct > MAX_RISK_PCT) {
    throw new BacktestRequestError("riskPct must be in (0, 5%]");
  }
  request.riskPct = riskPct;

  for (const key of ["feeBps", "spreadBps", "slippageBps"]) {
    const value = Number(request[key]);
    if (!Number.isFinite(value) || value < 0) {
      throw new BacktestRequestError(`${key} must be a non-negative number`);
    }
    request[key] = value;
  }

  const warmupBars = Number(request.warmupBars);
  if (!Number.isFinite(warmupBars) || warmupBars < 0) {
    throw new BacktestRequestError("warmupBars must be a non-negative number");
  }
  request.warmupBars = Math.trunc(warmupBars);

  const maxBarsInTrade = Number(request.maxBarsInTrade);
  if (!Number.isFinite(maxBarsInTrade) || maxBarsInTrade < 0) {
    throw new BacktestRequestError("maxBarsInTrade must be a non-negative number");
  }
  request.maxBarsInTrade = Math.trunc(maxBarsInTrade);

  request.allowShorts = Boolean(request.allowShorts);
  return request;
}

/**
 * Restrict a series to an inclusive `from` / `to` date range.
 *
 * `to` is extended by one day so that a caller asking for "up to 2026-01-31"
 * gets that whole day, matching the legacy `+86400000`. Both bounds are optional.
 *
 * @param {Array<{timestamp:number}>} candles
 * @param {{from?: string|null, to?: string|null}} range
 * @returns {Array<{timestamp:number}>}
 */
export function filterCandlesByRange(candles, range = {}) {
  let out = candles;
  if (range.from) {
    const fromMs = Date.parse(range.from);
    if (Number.isFinite(fromMs)) out = out.filter((candle) => candle.timestamp >= fromMs);
  }
  if (range.to) {
    const toMs = Date.parse(range.to) + 86_400_000;
    if (Number.isFinite(toMs)) out = out.filter((candle) => candle.timestamp < toMs);
  }
  return out;
}

/**
 * Run one strategy over one candle series.
 *
 * Pure: no I/O, no clock, no randomness. Given the same inputs it produces
 * byte-identical output, which is what makes the optimizer's determinism claim
 * testable and what makes a stored backtest reproducible.
 *
 * @param {import("./builtin.js").TradingStrategy} strategy
 * @param {Array<object>} candles normalised OHLCV bars ascending by time
 * @param {Record<string, unknown>} req a resolved request (`resolveBacktestRequest`)
 * @param {{symbol?:string,timeframe?:string,marketClass?:string}} meta
 * @returns {{trades:Array, equityCurve:Array, barsInMarket:number, warnings:string[], ignoredSignals:number}}
 * @throws {LookAheadError} if the strategy reads a future bar
 */
export function simulate(strategy, candles, req, meta = {}) {
  const warnings = [];
  const trades = [];
  const equityCurve = [];
  const indicators = precomputeIndicators(candles);
  const n = candles.length;
  const warmup = Math.min(req.warmupBars, Math.max(0, n - 10));

  let equity = req.initialEquity;
  let peak = equity;
  let position = null;
  let pending = null;
  let barsInMarket = 0;
  let ignoredSignals = 0;

  // Half-spread and slippage both push the fill away from the mid; the fee is
  // charged on the filled notional.
  const h = req.spreadBps / 2 / 10_000;
  const s = req.slippageBps / 10_000;
  const feeRate = req.feeBps / 10_000;

  /**
   * Close the open position at a raw price, applying exit costs.
   *
   * Mutates `equity`, appends to `trades` and clears `position`. The gross/net
   * split is kept in the trade record so the cost decomposition can be
   * reconciled against the equity curve.
   */
  function closePosition(pos, rawExit, exitTime, exitReason, exitBar) {
    const exitPrice = pos.direction === "LONG" ? rawExit * (1 - h - s) : rawExit * (1 + h + s);
    const grossPnl =
      pos.direction === "LONG"
        ? (exitPrice - pos.entryPrice) * pos.units
        : (pos.entryPrice - exitPrice) * pos.units;
    const exitFee = exitPrice * pos.units * feeRate;
    const exitSpread = rawExit * h * pos.units;
    const exitSlip = rawExit * s * pos.units;

    equity += grossPnl - exitFee;
    const netPnl = grossPnl - pos.entryFee - exitFee;

    trades.push({
      direction: pos.direction,
      entryTime: pos.entryTime,
      exitTime,
      entryPrice: pos.entryPrice,
      exitPrice,
      units: pos.units,
      notional: pos.entryPrice * pos.units,
      riskAmount: pos.riskAmount,
      stopLoss: pos.stopLoss,
      takeProfit: pos.takeProfit,
      fees: {
        entryFee: roundTo(pos.entryFee, 6),
        exitFee: roundTo(exitFee, 6),
        spreadCost: roundTo(pos.entrySpread + exitSpread, 6),
        slippageCost: roundTo(pos.entrySlip + exitSlip, 6),
        totalCost: roundTo(
          pos.entryFee + exitFee + pos.entrySpread + exitSpread + pos.entrySlip + exitSlip,
          6,
        ),
      },
      grossPnl: roundTo(grossPnl, 6),
      netPnl: roundTo(netPnl, 6),
      // R multiple is the honest per-trade measure: profit relative to what was
      // risked, not relative to notional. Zero when nothing was risked.
      rMultiple: pos.riskAmount > 0 ? roundTo(netPnl / pos.riskAmount, 4) : 0,
      exitReason,
      barsHeld: exitBar - pos.entryBar,
      signalReason: pos.signalReason,
      confidence: pos.confidence,
    });
    position = null;
  }

  for (let i = warmup; i < n; i += 1) {
    const bar = candles[i];

    // 1) Intrabar stop/target on an existing position. Stop first: pessimistic.
    if (position !== null) {
      barsInMarket += 1;
      const stopHit =
        position.direction === "LONG"
          ? bar.low <= position.stopLoss
          : bar.high >= position.stopLoss;
      const targetHit =
        position.direction === "LONG"
          ? bar.high >= position.takeProfit
          : bar.low <= position.takeProfit;
      if (stopHit) {
        closePosition(position, position.stopLoss, isoUtc(bar.timestamp), "STOP_LOSS", i);
        pending = null;
      } else if (targetHit) {
        closePosition(position, position.takeProfit, isoUtc(bar.timestamp), "TAKE_PROFIT", i);
        pending = null;
      } else if (req.maxBarsInTrade > 0 && i - position.entryBar >= req.maxBarsInTrade) {
        // Time stop is queued, not executed here: it still fills at the next
        // open, because the decision to exit is made on a closed bar.
        pending = {
          kind: "EXIT",
          signal: { action: "CLOSE", reason: "time stop", confidence: 0 },
          exitReason: "TIME_STOP",
        };
      }
    }

    // 2) Fill whatever was pending at THIS bar's open.
    if (pending !== null) {
      if (pending.kind === "EXIT") {
        if (position !== null) {
          closePosition(position, bar.open, isoUtc(bar.timestamp), pending.exitReason ?? "SIGNAL", i);
        }
        pending = null;
      } else if (position === null) {
        const sig = pending.signal;
        pending = null;
        const wantsShort = sig.action === "SELL";
        const stop = sig.stopLoss ?? null;
        if (
          (sig.action === "BUY" || sig.action === "SELL") &&
          stop !== null &&
          Number.isFinite(stop)
        ) {
          const direction = wantsShort ? "SHORT" : "LONG";
          // A stop on the wrong side of the fill would be triggered instantly and
          // is a strategy bug, not a trade. Refuse it loudly.
          const stopOk = direction === "LONG" ? stop < bar.open : stop > bar.open;
          if (wantsShort && !req.allowShorts) {
            ignoredSignals += 1;
          } else if (!stopOk) {
            warnings.push(
              `Skipped ${sig.action} at ${isoUtc(bar.timestamp)}: stop must sit beyond the entry fill on the correct side`,
            );
          } else {
            const raw = bar.open;
            const fill = wantsShort ? raw * (1 - h - s) : raw * (1 + h + s);
            const stopDistance = Math.abs(fill - stop);
            const riskAmount = equity * req.riskPct;
            const units = riskAmount / stopDistance;
            const entryFee = units * fill * feeRate;
            equity -= entryFee;
            position = {
              direction,
              entryBar: i,
              entryTime: isoUtc(bar.timestamp),
              entryPrice: fill,
              stopLoss: stop,
              takeProfit:
                sig.takeProfit !== undefined &&
                sig.takeProfit !== null &&
                Number.isFinite(sig.takeProfit)
                  ? sig.takeProfit
                  : direction === "LONG"
                    ? fill + 3 * stopDistance
                    : fill - 3 * stopDistance,
              units,
              riskAmount,
              entryFee,
              entrySpread: raw * h * units,
              entrySlip: raw * s * units,
              signalReason: sig.reason,
              confidence: sig.confidence,
            };
            // The entry bar can still stop out immediately: re-test this bar.
            const stopHitNow =
              direction === "LONG" ? bar.low <= stop : bar.high >= stop;
            const tp = position.takeProfit;
            const targetHitNow = direction === "LONG" ? bar.high >= tp : bar.low <= tp;
            if (stopHitNow) {
              closePosition(position, stop, isoUtc(bar.timestamp), "STOP_LOSS", i);
            } else if (targetHitNow) {
              closePosition(position, tp, isoUtc(bar.timestamp), "TAKE_PROFIT", i);
            }
          }
        }
      } else {
        pending = null;
      }
    }

    // 3) Evaluate the strategy on the closed bar.
    const view = new SeriesView(candles, indicators, i, meta);
    const unrealized =
      position !== null
        ? position.direction === "LONG"
          ? (bar.close - position.entryPrice) * position.units
          : (position.entryPrice - bar.close) * position.units
        : 0;
    const ctx = {
      view,
      position:
        position !== null
          ? {
              direction: position.direction,
              entryPrice: position.entryPrice,
              entryBar: position.entryBar,
              stopLoss: position.stopLoss,
              takeProfit: position.takeProfit,
              unrealizedPnl: unrealized,
            }
          : null,
      equity: equity + unrealized,
    };

    let signal;
    try {
      signal = strategy.evaluate(ctx);
    } catch (error) {
      if (error instanceof LookAheadError) throw error;
      warnings.push(`Strategy threw at bar ${isoUtc(bar.timestamp)}: ${error.message}`);
      signal = { action: "HOLD", reason: "strategy error", confidence: 0 };
    }

    if (signal.action === "CLOSE" && position !== null) {
      pending = { kind: "EXIT", signal, exitReason: "SIGNAL" };
    } else if (
      (signal.action === "BUY" || signal.action === "SELL") &&
      position === null &&
      pending === null
    ) {
      if (signal.action === "SELL" && !req.allowShorts) ignoredSignals += 1;
      else pending = { kind: "ENTRY", signal };
    }

    // 4) Mark to market.
    const marked = equity + unrealized;
    peak = Math.max(peak, marked);
    equityCurve.push({
      time: isoUtc(bar.timestamp),
      equity: roundTo(marked, 2),
      drawdownPct: peak > 0 ? roundTo(((peak - marked) / peak) * 100, 4) : 0,
    });
  }

  // An open position at the end of the data is closed at the last close and
  // labelled, never left dangling: an unreported open trade would make the run's
  // return figure meaningless.
  if (position !== null) {
    const lastBar = candles[n - 1];
    const pos = position;
    closePosition(pos, lastBar.close, isoUtc(lastBar.timestamp), "END_OF_DATA", n - 1);
    if (equityCurve.length) {
      const last = equityCurve[equityCurve.length - 1];
      last.equity = roundTo(equity, 2);
      last.drawdownPct = peak > 0 ? roundTo(((peak - equity) / peak) * 100, 4) : 0;
    }
  }
  if (ignoredSignals > 0) {
    warnings.push(`${ignoredSignals} short signals ignored (allowShorts=false)`);
  }

  return { trades, equityCurve, barsInMarket, warnings, ignoredSignals };
}

/**
 * Assemble the persisted backtest record from a completed simulation.
 *
 * The record is what the API returns, what the store holds, and what the
 * lifecycle gates read back — so its shape is a schema, not an internal detail.
 * `dataProvenance` is carried at the top level on purpose: a result whose data
 * was synthetic must say so in the same object as the metrics, never only in a
 * warning string that a consumer might drop.
 *
 * @param {object} params
 * @param {Record<string, unknown>} params.req resolved request
 * @param {{trades:Array,equityCurve:Array,barsInMarket:number,warnings:string[]}} params.result
 * @param {{source:string,synthetic:boolean}} params.provenance
 * @param {Array<object>} params.candles the candles actually simulated (post-filter)
 * @param {{createdAt?:string,id?:string}} [params.stamp] injectable for tests
 * @returns {Record<string, unknown>}
 */
export function buildBacktestRecord({ req, result, provenance, candles, stamp = {} }) {
  const metrics = computeMetrics(
    result.trades,
    result.equityCurve,
    req.initialEquity,
    req.timeframe,
    result.barsInMarket,
  );
  const synthetic = Boolean(provenance?.synthetic);
  return {
    id: stamp.id ?? randomUUID(),
    created_at: stamp.createdAt ?? isoUtc(Date.now()),
    request: {
      strategyId: req.strategyId,
      strategyVersion: req.strategyVersion,
      symbol: req.symbol,
      marketClass: req.marketClass,
      timeframe: req.timeframe,
      from: req.from ?? null,
      to: req.to ?? null,
      initialEquity: req.initialEquity,
      riskPct: req.riskPct,
      feeBps: req.feeBps,
      spreadBps: req.spreadBps,
      slippageBps: req.slippageBps,
      allowShorts: req.allowShorts,
    },
    dataProvenance: {
      source: String(provenance?.source ?? "unknown"),
      synthetic,
      candles: candles.length,
      from: candles.length ? isoUtc(candles[0].timestamp) : "",
      to: candles.length ? isoUtc(candles[candles.length - 1].timestamp) : "",
    },
    metrics,
    equityCurve: result.equityCurve,
    trades: result.trades,
    warnings: synthetic
      ? [
          ...result.warnings,
          "Candles are SYNTHETIC — results are a simulation of the strategy logic, not market performance",
        ]
      : [...result.warnings],
  };
}

/**
 * Flatten a backtest's trades into journal entries.
 *
 * The journal is the single place where trades from every source (backtest,
 * paper, live, manual) are comparable, so a backtest that is not journaled
 * cannot later be distinguished from one that never ran. Entries are stamped
 * `source: "backtest"`, which is also what keeps them out of the paper-trading
 * evidence the live-approval gate counts.
 *
 * @param {Record<string, unknown>} record a built backtest record
 * @param {Record<string, unknown>} req the resolved request
 * @param {{id?: () => string}} [ids] injectable id source for tests
 * @returns {Array<Record<string, unknown>>}
 */
export function journalEntriesFromBacktest(record, req, ids = {}) {
  const nextId = ids.id ?? (() => randomUUID());
  return record.trades.map((trade) => {
    const notional = trade.units * trade.entryPrice;
    return {
      id: nextId(),
      source: "backtest",
      symbol: req.symbol,
      market: req.marketClass,
      strategy: req.strategyId,
      strategy_version: req.strategyVersion,
      direction: trade.direction,
      entry_time: trade.entryTime,
      entry_price: trade.entryPrice,
      exit_time: trade.exitTime,
      exit_price: trade.exitPrice,
      position_size: trade.units,
      stop_loss: trade.stopLoss,
      take_profit: trade.takeProfit,
      fees: trade.fees.totalCost,
      slippage: trade.fees.slippageCost,
      pnl: trade.netPnl,
      pnl_pct: notional > 0 ? (trade.netPnl / notional) * 100 : null,
      r_multiple: trade.rMultiple,
      reason: trade.signalReason,
      ai_confidence: trade.confidence,
      confidence_source: "strategy",
      agent_consensus: null,
      risk_score: req.riskPct,
      execution_time: trade.entryTime,
      backtest_id: record.id,
    };
  });
}
