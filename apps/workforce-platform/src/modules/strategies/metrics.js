/**
 * Performance metrics over a trade list and an equity curve.
 *
 * Ported from `application/libraries/Aegis/Backtest/Metrics.php`.
 *
 * These are pure functions: they read a completed run and describe it. Nothing
 * here can influence a trade, which is what makes them safe to expose verbatim
 * in the API — a client cannot ask for metrics that flatter the result.
 *
 * Four conventions are load-bearing and are pinned by `test/strategies.test.js`
 * against the same hand-computed fixtures as oracle case `06-backtester.php`:
 *
 * 1. **A break-even trade counts as a loss.** `netPnl <= 0` is the loss
 *    predicate in both the win/loss split and the streaks. A trade that exactly
 *    covers its costs did not make money, and counting it as a win would inflate
 *    the win rate on any strategy that scalps to zero.
 * 2. **Profit factor is `null`, not `Infinity`, when there are no losses.** A
 *    run with three winners and no losers has no measured downside, so reporting
 *    a number would assert more than the sample supports. `null` propagates into
 *    the validation gate, which refuses to advance a strategy it cannot measure.
 * 3. **Sharpe uses population variance** (divide by `n`), and **Sortino divides
 *    the downside sum by the total count**, not by the number of negative bars.
 *    Both are the legacy definitions; they are not the textbook sample-variance
 *    forms, and "fixing" them would silently break parity with every stored
 *    backtest.
 * 4. **Sharpe is `null` when the standard deviation is zero.** A perfectly flat
 *    return series has no volatility to scale by; returning `Infinity` or `0`
 *    would both be claims about risk that the data does not support.
 */

import { timeframeMs } from "../market-data/timeframes.js";
import { roundTo } from "../analysis/math.js";

/** Milliseconds in a year, for annualising per-bar statistics. */
const MS_PER_YEAR = 365 * 24 * 3600 * 1000;

/**
 * Bars per year for a timeframe.
 *
 * This is a calendar-year count, not a trading-session count: the platform runs
 * crypto and forex series that trade continuously, so a session calendar would
 * be wrong for most symbols. Annualised figures are therefore comparable across
 * timeframes but should not be read as "per trading year".
 *
 * @param {string} timeframe
 * @returns {number}
 */
export function barsPerYear(timeframe) {
  return MS_PER_YEAR / timeframeMs(timeframe);
}

/**
 * Sharpe ratio from per-bar returns.
 *
 * The risk-free rate is treated as zero, which is the legacy convention and is
 * stated here rather than buried: every Sharpe figure this platform reports is a
 * raw return-to-volatility ratio.
 *
 * @param {number[]} returns per-bar simple returns
 * @param {number} barsPerYearValue annualisation factor
 * @returns {number|null} `null` when the sample is too small or has no variance
 */
export function sharpe(returns, barsPerYearValue) {
  if (returns.length < 2) return null;
  const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
  const variance =
    returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / returns.length;
  const sd = Math.sqrt(variance);
  if (sd === 0 || !Number.isFinite(sd)) return null;
  return roundTo((mean / sd) * Math.sqrt(barsPerYearValue), 4);
}

/**
 * Sortino ratio from per-bar returns.
 *
 * Penalises only downside deviation. When there is no downside at all the result
 * is `null` for a profitable series (no penalty to divide by) and `0` for a
 * non-positive one — the legacy asymmetry, preserved because collapsing the two
 * cases would make a flat-but-losing run look identical to an unmeasurably good
 * one.
 *
 * @param {number[]} returns
 * @param {number} barsPerYearValue
 * @returns {number|null}
 */
export function sortino(returns, barsPerYearValue) {
  if (returns.length < 2) return null;
  const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
  const downside = returns.filter((value) => value < 0);
  if (downside.length === 0) return mean > 0 ? null : 0;
  const downsideDeviation = Math.sqrt(
    downside.reduce((sum, value) => sum + value * value, 0) / returns.length,
  );
  if (downsideDeviation === 0) return null;
  return roundTo((mean / downsideDeviation) * Math.sqrt(barsPerYearValue), 4);
}

/**
 * Longest run of consecutive trades satisfying `predicate`.
 *
 * @param {Array<object>} trades
 * @param {(trade: object) => boolean} predicate
 * @returns {number}
 */
export function streak(trades, predicate) {
  let best = 0;
  let current = 0;
  for (const trade of trades) {
    if (predicate(trade)) {
      current += 1;
      best = Math.max(best, current);
    } else {
      current = 0;
    }
  }
  return best;
}

/**
 * Largest peak-to-trough decline in absolute currency.
 *
 * @param {Array<{equity: number}>} curve
 * @returns {number}
 */
export function maxDrawdownAbs(curve) {
  let peak = -Infinity;
  let drawdown = 0;
  for (const point of curve) {
    peak = Math.max(peak, point.equity);
    drawdown = Math.max(drawdown, peak - point.equity);
  }
  return drawdown;
}

/**
 * Largest peak-to-trough decline as a percentage of the peak at the time.
 *
 * Points before any positive peak are skipped rather than dividing by zero or a
 * negative number, which would produce a meaningless (and possibly negative)
 * drawdown.
 *
 * @param {Array<{equity: number}>} curve
 * @returns {number}
 */
export function maxDrawdownPct(curve) {
  let peak = -Infinity;
  let drawdown = 0;
  for (const point of curve) {
    peak = Math.max(peak, point.equity);
    if (peak > 0) {
      drawdown = Math.max(drawdown, ((peak - point.equity) / peak) * 100);
    }
  }
  return drawdown;
}

/**
 * Per-bar simple returns derived from an equity curve.
 *
 * A non-positive previous equity yields `0` rather than a division by zero; this
 * only arises if an account was wiped out mid-run, in which case every later bar
 * is flat anyway.
 *
 * @param {Array<{equity: number}>} curve
 * @returns {number[]}
 */
export function perBarReturns(curve) {
  const returns = [];
  for (let i = 1; i < curve.length; i += 1) {
    const previous = curve[i - 1].equity;
    returns.push(previous > 0 ? curve[i].equity / previous - 1 : 0);
  }
  return returns;
}

/**
 * The full metric set for one backtest.
 *
 * Every key here is part of the stored payload and the API response, so adding
 * or renaming one is a schema change: historical runs would no longer decode
 * into the same shape. The validation gate (`registry.js`) reads `trades`,
 * `profitFactor`, `maxDrawdownPct`, `expectancyPnl` and `sharpe` from this
 * object, so those five in particular carry behavioural weight beyond display.
 *
 * @param {Array<object>} trades closed trades from the backtester
 * @param {Array<{time:string,equity:number,drawdownPct:number}>} equityCurve
 * @param {number} initialEquity
 * @param {string} timeframe used only to annualise Sharpe/Sortino
 * @param {number} barsInMarket bars spent holding a position
 * @returns {Record<string, number|null>}
 */
export function computeMetrics(trades, equityCurve, initialEquity, timeframe, barsInMarket) {
  const wins = trades.filter((trade) => trade.netPnl > 0);
  const losses = trades.filter((trade) => trade.netPnl <= 0);
  const grossWin = wins.reduce((sum, trade) => sum + trade.netPnl, 0);
  const grossLoss = Math.abs(losses.reduce((sum, trade) => sum + trade.netPnl, 0));
  const finalEquity = equityCurve.length ? equityCurve[equityCurve.length - 1].equity : initialEquity;
  const n = trades.length;
  const returns = equityCurve.length > 1 ? perBarReturns(equityCurve) : [];
  const annualisation = barsPerYear(timeframe);

  return {
    totalReturnPct: roundTo(((finalEquity - initialEquity) / initialEquity) * 100, 4),
    finalEquity: roundTo(finalEquity, 2),
    trades: n,
    winRate: n ? roundTo(wins.length / n, 4) : null,
    lossRate: n ? roundTo(losses.length / n, 4) : null,
    profitFactor: n === 0 || grossLoss === 0 ? null : roundTo(grossWin / grossLoss, 4),
    expectancyR: n
      ? roundTo(trades.reduce((sum, trade) => sum + trade.rMultiple, 0) / n, 4)
      : null,
    expectancyPnl: n ? roundTo((grossWin - grossLoss) / n, 2) : null,
    avgWin: wins.length ? roundTo(grossWin / wins.length, 2) : null,
    avgLoss: losses.length ? roundTo(-grossLoss / losses.length, 2) : null,
    avgTrade: n ? roundTo((grossWin - grossLoss) / n, 2) : null,
    sharpe: sharpe(returns, annualisation),
    sortino: sortino(returns, annualisation),
    maxDrawdownPct: roundTo(maxDrawdownPct(equityCurve), 4),
    maxDrawdownAbs: roundTo(maxDrawdownAbs(equityCurve), 2),
    longestWinStreak: streak(trades, (trade) => trade.netPnl > 0),
    longestLossStreak: streak(trades, (trade) => trade.netPnl <= 0),
    exposurePct:
      equityCurve.length > 1
        ? roundTo((barsInMarket / (equityCurve.length - 1)) * 100, 2)
        : 0,
    totalFees: roundTo(
      trades.reduce((sum, trade) => sum + trade.fees.totalCost, 0),
      2,
    ),
    totalSlippage: roundTo(
      trades.reduce((sum, trade) => sum + trade.fees.slippageCost, 0),
      2,
    ),
  };
}
