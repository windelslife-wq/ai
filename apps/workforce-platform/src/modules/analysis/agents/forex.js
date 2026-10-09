/**
 * Forex Analysis Agent — price-derived work only.
 *
 * Ported from the `ForexAgent` class in
 * `application/libraries/Aegis/Agents/ForexCryptoSentimentAgents.php`.
 *
 * The honesty rule is the reason this agent exists in its current shape: the
 * macro inputs a currency view normally rests on — interest-rate differentials,
 * the economic calendar (CPI/NFP/FOMC), central-bank events — require a macro
 * provider that is not configured, so `macro.available` is `false` with the reason
 * spelled out, and `dataLimitations` lists each missing input separately. What
 * remains is real work: classification, volatility, session, trend alignment and a
 * currency-strength table computed from USD-matrix price momentum, which is
 * labelled `derivedFrom: "price-momentum"` and carries the note that it is *not*
 * news or fundamental data.
 *
 * When the reference series are synthetic, the strength table says so
 * (`synthetic: true`) and the report warns that it is not representative.
 */

import { splitPair } from "../../market-data/providers/frankfurter.js";
import { clamp, numberFormat, roundTo } from "../math.js";
import { atr, ema, last } from "../indicators.js";
import { dataQuality, makeVote, AGENT_WEIGHTS } from "./helper.js";

export const FOREX_AGENT_ID = "forex";

const MAJORS = Object.freeze(["EURUSD", "GBPUSD", "USDJPY", "USDCHF", "USDCAD", "AUDUSD", "NZDUSD"]);
const MINORS = Object.freeze(["EURGBP", "EURJPY", "GBPJPY", "AUDJPY", "EURCHF", "AUDNZD", "EURAUD", "CADJPY", "CHFJPY"]);
const STRENGTH_BARS = 24;
const MINIMUM_BARS_FOR_STRENGTH = 10;

function classify(symbol) {
  if (symbol === "XAUUSD") return "other";
  if (MAJORS.includes(symbol)) return "major";
  if (MINORS.includes(symbol)) return "minor";
  return "exotic";
}

function sessionInfo(nowMs) {
  const hour = new Date(nowMs).getUTCHours();
  let name = "Off-hours";
  if (hour >= 0 && hour < 7) name = "Asia (Tokyo)";
  else if (hour >= 7 && hour < 12) name = "London";
  else if (hour >= 12 && hour < 17) name = "London/New York overlap";
  else if (hour >= 17 && hour < 21) name = "New York";
  const active = name !== "Off-hours";
  return {
    name,
    utcHour: hour,
    active,
    note: active
      ? "Session liquidity is generally available"
      : "Thin liquidity — wider spreads and false moves are more likely",
  };
}

function currencyStrength(context) {
  const contributions = new Map();
  const collect = (symbol, series) => {
    if (!series || !Array.isArray(series.candles) || series.candles.length < MINIMUM_BARS_FOR_STRENGTH) return;
    const window = series.candles.slice(-STRENGTH_BARS);
    const first = window[0].close;
    if (!Number.isFinite(first) || first === 0) return;
    const ret = (window[window.length - 1].close - first) / first;
    const [base, quote] = splitPair(symbol);
    if (!contributions.has(base)) contributions.set(base, []);
    if (!contributions.has(quote)) contributions.set(quote, []);
    contributions.get(base).push(ret);
    contributions.get(quote).push(-ret);
  };

  const references = context.referenceSeries ?? [];
  if (references.length > 0) {
    for (const reference of references) collect(reference.symbol, reference.series);
  } else {
    collect(context.series.symbol, context.series);
  }

  const scores = [...contributions.entries()]
    .map(([currency, returns]) => ({
      currency,
      score: roundTo(returns.reduce((sum, value) => sum + value, 0) / returns.length, 5),
    }))
    .sort((a, b) => b.score - a.score);

  let synthetic = Boolean(context.series?.provenance?.synthetic);
  for (const reference of references) {
    if (reference?.series?.provenance?.synthetic) synthetic = true;
  }

  return {
    derivedFrom: "price-momentum",
    synthetic,
    scores,
    strongest: scores[0]?.currency ?? null,
    weakest: scores.length ? scores[scores.length - 1].currency : null,
    note: "Computed from USD-matrix price momentum only — this is NOT news or fundamental data.",
  };
}

export function createForexAgent() {
  function applicable(context) {
    return ["forex", "commodity"].includes(context.series?.marketClass);
  }

  function analyze(context) {
    const symbol = String(context.series.symbol).toUpperCase();
    const candles = context.series.candles;
    const closes = candles.map((candle) => candle.close);
    const price = closes[closes.length - 1];
    const [base, quote] = splitPair(symbol);

    const atr14 = last(atr(candles, 14));
    const atrPct = atr14 !== null ? (atr14 / price) * 100 : null;
    const ema20 = last(ema(closes, 20));
    const ema50 = last(ema(closes, 50));
    const aligned = ema20 !== null && ema50 !== null ? ema20 > ema50 : null;
    const volatilityLabel = atrPct === null ? "normal" : (atrPct > 1.2 ? "high" : (atrPct < 0.25 ? "low" : "normal"));
    const session = sessionInfo(context.now);
    const strength = currencyStrength(context);

    let score = 0;
    const reasons = [];
    if (aligned !== null) {
      score += aligned ? 0.4 : -0.4;
      reasons.push(`EMA20 ${aligned ? "above" : "below"} EMA50`);
    }
    if (strength.strongest === base) {
      score += 0.25;
      reasons.push(`${base} is the strongest leg of the USD matrix`);
    }
    if (strength.strongest === quote) {
      score -= 0.25;
      reasons.push(`${quote} is the strongest leg of the USD matrix`);
    }
    if (strength.weakest === base) {
      score -= 0.2;
      reasons.push(`${base} is the weakest leg of the USD matrix`);
    }
    if (strength.weakest === quote) {
      score += 0.2;
      reasons.push(`${quote} is the weakest leg of the USD matrix`);
    }
    let baseScore = 0;
    let quoteScore = 0;
    for (const entry of strength.scores) {
      if (entry.currency === base) baseScore = entry.score;
      if (entry.currency === quote) quoteScore = entry.score;
    }
    score += clamp((baseScore - quoteScore) * 0.5, -0.2, 0.2);

    return {
      agent: FOREX_AGENT_ID,
      title: "Forex Analysis Agent",
      generatedAt: context.now,
      dataQuality: dataQuality(context.series),
      dataLimitations: [
        "Interest-rate differentials: no macro provider configured",
        "Economic calendar (CPI/NFP/FOMC): no macro provider configured",
        "Central-bank events: no macro provider configured",
      ],
      warnings: strength.synthetic
        ? ["Currency strength computed from SYNTHETIC candles — not representative of real markets"]
        : [],
      vote: makeVote(score, AGENT_WEIGHTS[FOREX_AGENT_ID], reasons.join("; ") || "no decisive forex edge"),
      pair: { symbol, base, quote, classification: classify(symbol) },
      volatility: { atrPct: atrPct !== null ? roundTo(atrPct, 3) : null, label: volatilityLabel },
      trendAlignment: {
        emaFastAboveSlow: aligned,
        detail: ema20 !== null && ema50 !== null
          ? `EMA20 ${numberFormat(ema20, 5)} vs EMA50 ${numberFormat(ema50, 5)}`
          : "insufficient data",
      },
      session,
      macro: {
        available: false,
        reason: "No economic-calendar / macro provider configured. Rate differentials, CPI, NFP and FOMC analysis remain disabled until one is added.",
      },
      currencyStrength: strength,
    };
  }

  return { id: FOREX_AGENT_ID, applicable, analyze };
}
