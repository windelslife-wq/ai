/**
 * Regime detection, trade-setup generation and scenario building.
 *
 * Ported from `application/libraries/Aegis/Analysis.php`. The three functions are
 * the bridge between the agents (which describe the market) and the risk engine
 * (which decides whether a proposal may exist at all):
 *
 *  - `detectRegime` classifies the series and always returns its evidence, so a
 *    label is never asserted without the numbers that produced it;
 *  - `generateSetup` returns `null` unless the bias is directional *and* the
 *    consensus confidence clears 0.55 — a proposal is earned, not defaulted to;
 *  - `buildScenarios` states the bullish, bearish and neutral paths with their
 *    triggers and invalidation levels, including when the bias is neutral.
 *
 * Nothing here can place an order. A setup is a proposal that the risk engine may
 * veto, and the debate stage may reduce (see `agents/debate.js`).
 */

import { timeframeMs } from "../market-data/timeframes.js";
import { clamp, numberFormat, roundTo } from "./math.js";
import { adx, atr, bollinger, ema, last } from "./indicators.js";

const MINIMUM_CANDLES_FOR_REGIME = 60;
const MINIMUM_CONFIDENCE_FOR_SETUP = 0.55;
const TARGET_RISK_MULTIPLES = Object.freeze([1.5, 2.5, 3.5]);

/**
 * @param {{candles: Array<object>, symbol: string, marketClass: string, timeframe: string}} series
 * @returns {{regime: string, confidence: number, evidence: string[], volatilityPct: number|null, adx: number|null}}
 */
export function detectRegime(series) {
  const candles = series.candles ?? [];
  const closes = candles.map((candle) => candle.close);

  if (candles.length < MINIMUM_CANDLES_FOR_REGIME) {
    return {
      regime: "UNKNOWN",
      confidence: 0.2,
      evidence: [`insufficient candles (<${MINIMUM_CANDLES_FOR_REGIME}) for regime classification`],
      volatilityPct: null,
      adx: null,
    };
  }

  const evidence = [];
  const adxResult = adx(candles, 14);
  const adx14 = last(adxResult.adx);
  const plusDi = last(adxResult.plusDi);
  const minusDi = last(adxResult.minusDi);
  const atr14 = last(atr(candles, 14));
  const price = closes[closes.length - 1];
  const atrPct = atr14 !== null ? (atr14 / price) * 100 : null;

  // Volatility percentile against the series' own history: the same ATR% means
  // different things in a quiet pair and a volatile one, so the comparison is
  // always self-referential.
  const atrHistory = [];
  for (let i = MINIMUM_CANDLES_FOR_REGIME; i < candles.length; i += 1) {
    const prefixAtr = atr(candles.slice(0, i + 1), 14);
    const value = prefixAtr[prefixAtr.length - 1];
    if (value !== null && Number.isFinite(value)) atrHistory.push((value / closes[i]) * 100);
  }
  let volatilityPercentile = null;
  if (atrPct !== null && atrHistory.length > 20) {
    const below = atrHistory.filter((value) => value <= atrPct).length;
    volatilityPercentile = below / atrHistory.length;
  }

  const ema20 = last(ema(closes, 20));
  const ema50 = last(ema(closes, 50));
  const bands = bollinger(closes, 20, 2);
  const upperBand = last(bands.upper);
  const lowerBand = last(bands.lower);
  const midBand = last(bands.mid);
  const bandwidthPct = upperBand !== null && lowerBand !== null && midBand
    ? ((upperBand - lowerBand) / midBand) * 100
    : null;

  // Breakout test: beyond the 48-bar range that excludes the last two bars, with
  // volume expansion. Excluding the last bars keeps the current candle from
  // defining the range it is supposedly breaking.
  let lookback = candles.slice(Math.max(0, candles.length - 50), candles.length - 2);
  if (lookback.length < 40) lookback = candles.slice(0, Math.max(1, candles.length - 2));
  const rangeHigh = Math.max(...lookback.map((candle) => candle.high));
  const rangeLow = Math.min(...lookback.map((candle) => candle.low));
  const volumeAverage = lookback.reduce((sum, candle) => sum + candle.volume, 0) / Math.max(1, lookback.length);
  const lastCandle = candles[candles.length - 1];
  const volumeExpansion = volumeAverage > 0 ? lastCandle.volume / volumeAverage : null;
  const isBreakUp = price > rangeHigh && (volumeExpansion === null || volumeExpansion > 1.2);
  const isBreakDown = price < rangeLow && (volumeExpansion === null || volumeExpansion > 1.2);

  // DI-separation guard: a degenerate series (+DI ≈ -DI ≈ 0) saturates DX and
  // would otherwise fake a trend.
  const diSeparation = plusDi !== null && minusDi !== null ? Math.abs(plusDi - minusDi) : null;
  const trendUp = adx14 !== null && adx14 >= 25 && ema20 !== null && ema50 !== null && ema20 > ema50
    && diSeparation !== null && diSeparation >= 3 && plusDi > minusDi;
  const trendDown = adx14 !== null && adx14 >= 25 && ema20 !== null && ema50 !== null && ema20 < ema50
    && diSeparation !== null && diSeparation >= 3 && minusDi > plusDi;

  let regime = "UNKNOWN";
  let confidence = 0.4;

  if (isBreakUp || isBreakDown) {
    regime = "BREAKOUT";
    confidence = 0.7;
    evidence.push(`close beyond ${isBreakUp ? "48-bar high" : "48-bar low"} (${numberFormat(isBreakUp ? rangeHigh : rangeLow, 5)})`);
    if (volumeExpansion !== null) evidence.push(`volume ${numberFormat(volumeExpansion, 1)}x average on the break`);
  } else if (trendUp || trendDown) {
    regime = trendUp ? "TRENDING_UP" : "TRENDING_DOWN";
    confidence = Math.min(0.9, 0.5 + adx14 / 100);
    evidence.push(`ADX ${numberFormat(adx14, 1)} with ${trendUp ? "+DI above -DI and EMA20 > EMA50" : "-DI above +DI and EMA20 < EMA50"}`);
    if (volatilityPercentile !== null && volatilityPercentile >= 0.85) {
      evidence.push(`note: ATR% is elevated (${Math.round(volatilityPercentile * 100)}th percentile) despite the trend`);
    }
  } else if (volatilityPercentile !== null && volatilityPercentile >= 0.9) {
    regime = "HIGH_VOLATILITY";
    confidence = 0.6;
    evidence.push(`ATR% at the ${Math.round(volatilityPercentile * 100)}th percentile of its own history with no directional trend`);
  } else if (volatilityPercentile !== null && volatilityPercentile <= 0.1) {
    regime = "LOW_VOLATILITY";
    confidence = 0.55;
    evidence.push(`ATR% at the ${Math.round(volatilityPercentile * 100)}th percentile of its own history`);
  }

  if (regime === "UNKNOWN" && adx14 !== null && adx14 < 20) {
    regime = "RANGING";
    confidence = 0.5;
    evidence.push(`ADX ${numberFormat(adx14, 1)} below 20 — no directional trend`);
    if (bandwidthPct !== null) evidence.push(`Bollinger bandwidth ${numberFormat(bandwidthPct, 2)}%`);
  }
  if (regime === "UNKNOWN") {
    evidence.push("mixed evidence — trend, volatility and breakout tests disagree");
  }

  return {
    regime,
    confidence: roundTo(confidence, 2),
    evidence,
    volatilityPct: atrPct !== null ? roundTo(atrPct, 3) : null,
    adx: adx14 !== null ? roundTo(adx14, 1) : null,
  };
}

/** How much a regime label is allowed to contribute to consensus clarity. */
export function regimeDirectionality(regime) {
  switch (regime) {
    case "TRENDING_UP":
    case "TRENDING_DOWN":
      return 1.0;
    case "BREAKOUT":
      return 0.8;
    case "LOW_VOLATILITY":
      return 0.5;
    case "RANGING":
      return 0.4;
    case "HIGH_VOLATILITY":
      return 0.3;
    default:
      return 0.2;
  }
}

/**
 * Builds a concrete proposal (entry zone, stop, three targets, R:R) or `null`.
 *
 * The stop is structural — below support for a long, above resistance for a
 * short — padded by 0.4 ATR and capped at 2 ATR from the entry reference, so a
 * wide stop cannot be used to inflate the position size the risk engine derives
 * from it. Targets ladder at 1.5R/2.5R/3.5R and snap to the opposing structural
 * levels when one is within 0.35 of the stop distance, then are forced apart by
 * at least half the stop distance so the ladder cannot collapse onto one level.
 */
export function generateSetup(series, technical, structure, bias, confidence) {
  if (!["BULLISH", "BEARISH"].includes(bias) || confidence < MINIMUM_CONFIDENCE_FOR_SETUP) return null;

  const candles = series.candles;
  const price = candles[candles.length - 1].close;
  const atr14 = last(atr(candles, 14)) ?? price * 0.005;
  const action = bias === "BULLISH" ? "BUY" : "SELL";
  const supports = technical.structure.support;
  const resistances = technical.structure.resistance;

  let entryMin;
  let entryMax;
  if (action === "BUY") {
    const nearestSupport = supports.length ? supports[supports.length - 1] : price - 0.5 * atr14;
    entryMax = price + 0.1 * atr14;
    entryMin = Math.max(nearestSupport, price - 0.75 * atr14);
    if (entryMax - entryMin < 0.2 * atr14) entryMin = entryMax - 0.3 * atr14;
  } else {
    const nearestResistance = resistances.length ? resistances[0] : price + 0.5 * atr14;
    entryMin = price - 0.1 * atr14;
    entryMax = Math.min(nearestResistance, price + 0.75 * atr14);
    if (entryMax - entryMin < 0.2 * atr14) entryMax = entryMin + 0.3 * atr14;
  }
  const entryReference = (entryMin + entryMax) / 2;

  const invalidation = [];
  let stop;
  const changeOfCharacter = structure?.events?.changeOfCharacter;
  if (action === "BUY") {
    const below = supports.length ? Math.min(...supports) : entryMin - atr14;
    stop = Math.min(entryMin - 0.4 * atr14, below - 0.2 * atr14);
    if (entryReference - stop > 2 * atr14) stop = entryReference - 2 * atr14;
    invalidation.push("close below the structural support invalidates the long thesis");
    if (changeOfCharacter?.detected && changeOfCharacter.direction === "SELL") {
      invalidation.push("bearish change of character would flip the structure");
    }
  } else {
    const above = resistances.length ? Math.max(...resistances) : entryMax + atr14;
    stop = Math.max(entryMax + 0.4 * atr14, above + 0.2 * atr14);
    if (stop - entryReference > 2 * atr14) stop = entryReference + 2 * atr14;
    invalidation.push("close above the structural resistance invalidates the short thesis");
    if (changeOfCharacter?.detected && changeOfCharacter.direction === "BUY") {
      invalidation.push("bullish change of character would flip the structure");
    }
  }

  const stopDistance = Math.abs(entryReference - stop);
  if (stopDistance <= 0) return null;

  const targets = TARGET_RISK_MULTIPLES.map((multiple) => (action === "BUY"
    ? entryReference + multiple * stopDistance
    : entryReference - multiple * stopDistance));
  const levels = action === "BUY" ? resistances : [...supports].reverse();
  const snapped = targets.map((target) => {
    const near = levels.find((level) => Math.abs(level - target) < 0.35 * stopDistance);
    return near === undefined ? target : near;
  });
  for (let i = 1; i < 3; i += 1) {
    const gap = 0.5 * stopDistance;
    if (action === "BUY" && snapped[i] <= snapped[i - 1] + gap) snapped[i] = snapped[i - 1] + gap;
    if (action === "SELL" && snapped[i] >= snapped[i - 1] - gap) snapped[i] = snapped[i - 1] - gap;
  }
  const riskReward = Math.abs(snapped[0] - entryReference) / stopDistance;

  // Rounding follows the instrument's own price scale: 5 digits for a forex pair,
  // 2 for an index or a large-cap price.
  const digits = price >= 100 ? 2 : (price >= 10 ? 3 : (price >= 1 ? 5 : 6));
  const round = (value) => roundTo(value, digits + 1);

  return {
    action,
    symbol: series.symbol,
    marketClass: series.marketClass,
    timeframe: series.timeframe,
    entry: {
      type: "ZONE",
      min: round(Math.min(entryMin, entryMax)),
      max: round(Math.max(entryMin, entryMax)),
      reference: round(entryReference),
    },
    stopLoss: round(stop),
    takeProfit: snapped.map(round),
    riskReward: roundTo(riskReward, 2),
    confidence: roundTo(confidence, 2),
    expiration: new Date(Date.now() + 24 * timeframeMs(series.timeframe)).toISOString(),
    invalidationReasons: invalidation,
    rationale: [
      `${action} aligned with ${bias.toLowerCase()} confluence at ${numberFormat(confidence, 2)} confidence`,
      `entry zone anchored to ${action === "BUY" ? "support" : "resistance"} structure, stop padded by 0.4 ATR`,
      `targets ladder at 1.5R/2.5R/3.5R snapped to ${action === "BUY" ? "resistance" : "support"} levels`,
      `setup expires after 24 bars (${series.timeframe})`,
    ],
  };
}

/**
 * The three paths forward, always including the neutral one. A scenario states
 * its triggers and its own invalidation, so "the market went the other way" is a
 * defined outcome rather than a surprise.
 */
export function buildScenarios(series, technical, bias, price) {
  const support = technical.structure.support;
  const resistance = technical.structure.resistance;
  const nearestResistance = resistance.length ? resistance[0] : price * 1.01;
  const nearestSupport = support.length ? support[support.length - 1] : price * 0.99;
  const format = (value) => numberFormat(value, 5);

  const bullishTargets = resistance.slice(0, 3);
  const bearishTargets = [...support.slice(0, 3)].reverse();

  return {
    bullish: {
      summary: "Bulls take control — break and hold above nearby resistance",
      triggers: [`close above ${format(nearestResistance)}`, "MACD histogram expanding positive"],
      targets: bullishTargets.length ? bullishTargets : [price * 1.02],
      invalidation: `close below ${format(nearestSupport)}`,
      probabilityHint: bias === "BULLISH" ? "primary" : "alternate",
    },
    bearish: {
      summary: "Bears press the break — lose support and extend lower",
      triggers: [`close below ${format(nearestSupport)}`, "MACD histogram expanding negative"],
      targets: bearishTargets.length ? bearishTargets : [price * 0.98],
      invalidation: `close above ${format(nearestResistance)}`,
      probabilityHint: bias === "BEARISH" ? "primary" : "alternate",
    },
    neutral: {
      summary: "Rotation continues between support and resistance",
      triggers: ["volume contraction inside the range", "no confirmed break of structure"],
      targets: [nearestResistance, nearestSupport],
      invalidation: `decisive close beyond ${format(nearestSupport)} or ${format(nearestResistance)}`,
      probabilityHint: bias === "NEUTRAL" || bias === "NO_TRADE" ? "base" : "alternate",
    },
  };
}

/** Placeholder used when the technical agent could not produce a report. */
export function insufficientDataScenarios() {
  const empty = (hint) => ({ summary: "insufficient data", triggers: [], targets: [], invalidation: "", probabilityHint: hint });
  return { bullish: empty("alternate"), bearish: empty("alternate"), neutral: empty("base") };
}

export { clamp };
