/**
 * Cryptocurrency Intelligence Agent.
 *
 * Ported from the `CryptoAgent` class in
 * `application/libraries/Aegis/Agents/ForexCryptoSentimentAgents.php`.
 *
 * Everything this agent reports is derived from the candles it was given: 24h and
 * 7d moves, volume against its own 30-bar average, ATR-based volatility and EMA
 * alignment. The three inputs a crypto view usually leans on — on-chain activity,
 * derivatives (funding rates and open interest) and market dominance — have no
 * provider, so each is reported as an explicit `dataAvailable: false` with the
 * reason, rather than being omitted or approximated from price.
 *
 * When the candles are synthetic the report says so in `warnings`, and the series'
 * own `dataQuality` penalty (see `agents/helper.js`) is what actually keeps the
 * result out of a trade proposal.
 */

import { clamp, numberFormat, roundTo } from "../math.js";
import { atr, ema, last, sma } from "../indicators.js";
import { dataQuality, makeVote, AGENT_WEIGHTS } from "./helper.js";

export const CRYPTO_AGENT_ID = "crypto";

const BARS_24H = 24;
const BARS_7D = 168;

export function createCryptoAgent() {
  function applicable(context) {
    return context.series?.marketClass === "crypto";
  }

  function analyze(context) {
    const candles = context.series?.candles ?? [];
    if (!Array.isArray(candles) || candles.length === 0) {
      throw new Error("insufficient candles for crypto analysis");
    }

    const closes = candles.map((candle) => candle.close);
    const n = closes.length;
    const price = closes[n - 1];

    const bars24 = Math.min(BARS_24H, n - 1);
    const bars7d = Math.min(BARS_7D, n - 1);
    const change24h = bars24 > 0 ? ((price - closes[n - 1 - bars24]) / closes[n - 1 - bars24]) * 100 : null;
    const change7d = bars7d > 0 ? ((price - closes[n - 1 - bars7d]) / closes[n - 1 - bars7d]) * 100 : null;

    const volumes = candles.map((candle) => candle.volume);
    const volumeAverage = last(sma(volumes, 30));
    const hasVolume = volumes.some((volume) => volume > 0);
    const latestVsAverage = hasVolume && volumeAverage !== null && volumeAverage > 0
      ? volumes[volumes.length - 1] / volumeAverage
      : null;

    const atr14 = last(atr(candles, 14));
    const atrPct = atr14 !== null ? (atr14 / price) * 100 : null;
    const volatilityLabel = atrPct === null ? "normal" : (atrPct > 3.5 ? "high" : (atrPct < 0.8 ? "low" : "normal"));

    const ema20 = last(ema(closes, 20));
    const ema50 = last(ema(closes, 50));
    const trendLabel = ema20 !== null && ema50 !== null
      ? (ema20 > ema50 ? "short-term uptrend" : "short-term downtrend")
      : "undetermined";

    let score = 0;
    const reasons = [];
    if (change24h !== null) {
      score += clamp(change24h / 6, -0.35, 0.35);
      reasons.push(`24h move ${numberFormat(change24h, 2)}%`);
    }
    if (change7d !== null) {
      score += clamp(change7d / 15, -0.25, 0.25);
      reasons.push(`7d move ${numberFormat(change7d, 2)}%`);
    }
    if (ema20 !== null && ema50 !== null) {
      score += ema20 > ema50 ? 0.25 : -0.25;
      reasons.push(trendLabel);
    }
    if (latestVsAverage !== null && latestVsAverage > 1.5) {
      if (change24h !== null && change24h > 0) {
        score += 0.15;
        reasons.push("volume expansion confirms buying");
      }
      if (change24h !== null && change24h < 0) {
        score -= 0.15;
        reasons.push("volume expansion confirms selling");
      }
    }

    return {
      agent: CRYPTO_AGENT_ID,
      title: "Cryptocurrency Intelligence Agent",
      generatedAt: context.now,
      dataQuality: dataQuality(context.series),
      dataLimitations: [
        "On-chain data: no provider configured",
        "Funding rates & open interest: no derivatives provider configured",
        "Market dominance: no aggregator configured",
        "Exchange flows / whale activity: no provider configured",
        ...(hasVolume ? [] : ["Provider supplies no volume data — volume analysis unavailable"]),
      ],
      warnings: context.series?.provenance?.synthetic
        ? ["Candles are SYNTHETIC — analysis is a simulation, not market reality"]
        : [],
      vote: makeVote(score, AGENT_WEIGHTS[CRYPTO_AGENT_ID], reasons.join("; ") || "no decisive crypto edge"),
      priceAction: {
        changePct24h: change24h !== null ? roundTo(change24h, 2) : null,
        changePct7d: change7d !== null ? roundTo(change7d, 2) : null,
        trendLabel,
      },
      volume: {
        latestVsAverage: latestVsAverage !== null ? roundTo(latestVsAverage, 2) : null,
        trendLabel: !hasVolume
          ? "unavailable (no volume data)"
          : (latestVsAverage === null
            ? "undetermined"
            : (latestVsAverage > 1.5 ? "expansion" : (latestVsAverage < 0.6 ? "contraction" : "average"))),
      },
      volatility: { atrPct: atrPct !== null ? roundTo(atrPct, 2) : null, label: volatilityLabel },
      onChain: { dataAvailable: false, warning: "On-chain provider not configured" },
      derivatives: {
        dataAvailable: false,
        warning: "Derivatives provider not configured — funding rates and open interest analysis disabled",
      },
      marketDominance: {
        dataAvailable: false,
        warning: "Market-cap aggregator not configured — dominance analysis disabled",
      },
    };
  }

  return { id: CRYPTO_AGENT_ID, applicable, analyze };
}
