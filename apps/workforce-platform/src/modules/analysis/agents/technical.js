/**
 * Technical Analysis Agent — pure quant.
 *
 * Ported from `application/libraries/Aegis/Agents/TechnicalAgent.php`. It computes
 * the indicator suite, emits one row per indicator with the signal that row
 * implies, and aggregates them into a single weighted vote in [-1, 1].
 *
 * The signal thresholds are the legacy ones and are deliberately blunt (RSI above
 * 60 is "BUY", above 70 additionally warns "overbought"): this agent describes
 * momentum, it does not decide anything. Deciding belongs to the consensus, the
 * debate and the risk engine.
 *
 * It throws when handed fewer than 20 candles rather than returning a thin report:
 * an indicator panel computed on 12 bars is not a weaker opinion, it is noise with
 * a confident shape.
 */

import { clamp, numberFormat, roundTo, fixedFormat } from "../math.js";
import {
  adx, atr, bollinger, ema, last, macd, pivotPoints, regressionSlopePct, rsi, sma,
  stochastic, supportResistance, volumeProfile, vwap,
} from "../indicators.js";
import { dataQuality, makeVote } from "./helper.js";

const MINIMUM_CANDLES = 20;

/** Legacy per-indicator weights in the aggregate vote. */
const SIGNAL_WEIGHTS = Object.freeze({
  "EMA20 vs EMA50": 1.2,
  "Price vs SMA50": 1.0,
  "Trend slope (50-bar regression)": 1.0,
  "RSI(14)": 0.8,
  "MACD(12,26,9) histogram": 1.0,
  "Stochastic(14,3)": 0.6,
  "Bollinger position": 0.4,
  VWAP: 0.6,
  "ADX(14) / DI": 0.8,
});

const DEFAULT_SIGNAL_WEIGHT = 0.5;

export const TECHNICAL_AGENT_ID = "technical";

export function createTechnicalAgent() {
  function applicable() {
    return true;
  }

  function analyze(context) {
    const candles = context.series?.candles ?? [];
    if (!Array.isArray(candles) || candles.length < MINIMUM_CANDLES) {
      throw new Error("insufficient candles for technical analysis");
    }

    const closes = candles.map((candle) => candle.close);
    const n = candles.length;
    const price = candles[n - 1].close;

    const sma20 = last(sma(closes, 20));
    const sma50 = last(sma(closes, 50));
    const sma200 = last(sma(closes, 200));
    const ema20 = last(ema(closes, 20));
    const ema50 = last(ema(closes, 50));
    const rsi14 = last(rsi(closes, 14));
    const macdResult = macd(closes);
    const macdLast = last(macdResult.macd);
    const macdSignal = last(macdResult.signal);
    const macdHistogram = last(macdResult.histogram);
    const bands = bollinger(closes, 20, 2);
    const bandUpper = last(bands.upper);
    const bandMid = last(bands.mid);
    const bandLower = last(bands.lower);
    const atr14 = last(atr(candles, 14));
    const atrPct = atr14 !== null ? (atr14 / price) * 100 : null;
    const adxResult = adx(candles, 14);
    const adx14 = last(adxResult.adx);
    const plusDi = last(adxResult.plusDi);
    const minusDi = last(adxResult.minusDi);
    const vwapLast = last(vwap(candles));
    const stochasticResult = stochastic(candles, 14, 3);
    const stochasticK = last(stochasticResult.k);
    const stochasticD = last(stochasticResult.d);
    const slopePct = regressionSlopePct(closes, 50);
    const levels = supportResistance(candles, atr14, price);
    const pivots = pivotPoints(candles[n - 2] ?? null);
    const profile = volumeProfile(candles, 24);

    const signals = [];
    const push = (name, value, signal, detail) => signals.push({ name, value, signal, detail });
    // `number_format($v, 5, '.', '')` in the legacy code: five decimals and *no*
    // thousands separator, because these strings sit inside a price comparison.
    const f5 = (value) => fixedFormat(value, 5);

    if (ema20 !== null && ema50 !== null) {
      push("EMA20 vs EMA50", null, ema20 > ema50 ? "BUY" : "SELL",
        `EMA20 ${f5(ema20)} ${ema20 > ema50 ? ">" : "<"} EMA50 ${f5(ema50)}`);
    }
    if (sma50 !== null) {
      push("Price vs SMA50", null, price > sma50 ? "BUY" : "SELL", `close ${f5(price)} vs SMA50 ${f5(sma50)}`);
    }
    if (slopePct !== null) {
      push("Trend slope (50-bar regression)", roundTo(slopePct, 4),
        slopePct > 0.01 ? "BUY" : (slopePct < -0.01 ? "SELL" : "NEUTRAL"),
        `${numberFormat(slopePct, 3)}%/bar`);
    }
    if (rsi14 !== null) {
      push("RSI(14)", roundTo(rsi14, 2), rsi14 > 60 ? "BUY" : (rsi14 < 40 ? "SELL" : "NEUTRAL"),
        rsi14 > 70 ? "overbought — treat longs with caution" : (rsi14 < 30 ? "oversold — treat shorts with caution" : "mid-range"));
    }
    if (macdHistogram !== null && macdLast !== null && macdSignal !== null) {
      push("MACD(12,26,9) histogram", roundTo(macdHistogram, 8), macdHistogram > 0 ? "BUY" : "SELL",
        `macd ${f5(macdLast)} vs signal ${f5(macdSignal)}`);
    }
    if (stochasticK !== null && stochasticD !== null) {
      const signal = stochasticK > 80
        ? (stochasticK < stochasticD ? "SELL" : "NEUTRAL")
        : (stochasticK < 20
          ? (stochasticK > stochasticD ? "BUY" : "NEUTRAL")
          : (stochasticK > stochasticD ? "BUY" : "SELL"));
      push("Stochastic(14,3)", roundTo(stochasticK, 1), signal,
        `%K ${numberFormat(stochasticK, 1)} / %D ${numberFormat(stochasticD, 1)}`);
    }
    if (bandUpper !== null && bandLower !== null && bandMid !== null) {
      const width = bandUpper - bandLower;
      const position = width > 0 ? (price - bandLower) / width : 0.5;
      push("Bollinger position", roundTo(position, 3),
        position > 0.95 ? "SELL" : (position < 0.05 ? "BUY" : "NEUTRAL"),
        `price at ${Math.round(position * 100)}% of band`);
    }
    if (vwapLast !== null) {
      push("VWAP", roundTo(vwapLast, 6), price > vwapLast ? "BUY" : "SELL",
        `close ${f5(price)} vs VWAP ${f5(vwapLast)}`);
    }
    if (adx14 !== null && plusDi !== null && minusDi !== null) {
      const trending = adx14 >= 25;
      push("ADX(14) / DI", roundTo(adx14, 2), !trending ? "NEUTRAL" : (plusDi > minusDi ? "BUY" : "SELL"),
        `ADX ${numberFormat(adx14, 1)} (${trending ? "trending" : "weak trend"}), +DI ${numberFormat(plusDi, 1)} / -DI ${numberFormat(minusDi, 1)}`);
    }

    let accumulator = 0;
    let weightSum = 0;
    for (const signal of signals) {
      const weight = SIGNAL_WEIGHTS[signal.name] ?? DEFAULT_SIGNAL_WEIGHT;
      accumulator += (signal.signal === "BUY" ? 1 : (signal.signal === "SELL" ? -1 : 0)) * weight;
      weightSum += weight;
    }
    const aggregate = weightSum === 0 ? 0 : accumulator / weightSum;

    const trendStrength = adx14 !== null ? clamp(adx14 / 50, 0, 1) : 0.3;
    const trend = ema20 !== null && ema50 !== null && trendStrength > 0.4
      ? (ema20 > ema50 ? "up" : "down")
      : "sideways";

    const buys = signals.filter((signal) => signal.signal === "BUY").length;
    const sells = signals.filter((signal) => signal.signal === "SELL").length;

    return {
      agent: TECHNICAL_AGENT_ID,
      title: "Technical Analysis Agent",
      generatedAt: context.now,
      dataQuality: dataQuality(context.series),
      dataLimitations: n < 200 ? ["Fewer than 200 candles — SMA200 not available"] : [],
      warnings: rsi14 !== null && (rsi14 > 70 || rsi14 < 30)
        ? [`RSI ${numberFormat(rsi14, 1)} is ${rsi14 > 70 ? "overbought" : "oversold"} — counter-trend entries penalized`]
        : [],
      vote: makeVote(aggregate, 1.0, `${buys} bullish / ${sells} bearish of ${signals.length} indicators`),
      indicators: {
        sma20,
        sma50,
        sma200,
        ema20,
        ema50,
        rsi14: rsi14 !== null ? roundTo(rsi14, 2) : null,
        macd: { macd: macdLast, signal: macdSignal, histogram: macdHistogram },
        macdBias: macdHistogram !== null ? (macdHistogram > 0 ? "BUY" : "SELL") : "NEUTRAL",
        bollinger: {
          upper: bandUpper,
          mid: bandMid,
          lower: bandLower,
          bandwidthPct: bandUpper !== null && bandLower !== null && bandMid
            ? roundTo(((bandUpper - bandLower) / bandMid) * 100, 3)
            : null,
        },
        atr14,
        atrPct: atrPct !== null ? roundTo(atrPct, 3) : null,
        adx14: {
          adx: adx14 !== null ? roundTo(adx14, 2) : null,
          plusDi: plusDi !== null ? roundTo(plusDi, 2) : null,
          minusDi: minusDi !== null ? roundTo(minusDi, 2) : null,
        },
        vwap: vwapLast,
        stochastic: {
          k: stochasticK !== null ? roundTo(stochasticK, 1) : null,
          d: stochasticD !== null ? roundTo(stochasticD, 1) : null,
        },
      },
      structure: {
        trend,
        trendStrength: roundTo(trendStrength, 3),
        momentum: macdHistogram !== null ? (macdHistogram > 0 ? "BUY" : "SELL") : "NEUTRAL",
        support: levels.support.map((value) => roundTo(value, 6)),
        resistance: levels.resistance.map((value) => roundTo(value, 6)),
        pivots,
        volumeProfile: profile,
      },
      signals,
      aggregateScore: roundTo(aggregate, 4),
    };
  }

  return { id: TECHNICAL_AGENT_ID, applicable, analyze };
}
