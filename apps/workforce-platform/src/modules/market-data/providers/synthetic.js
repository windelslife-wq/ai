/**
 * SYNTHETIC DEMO PROVIDER — deterministic, reproducible, clearly labelled.
 *
 * Ported from `application/libraries/Aegis/Providers/SyntheticProvider.php`,
 * including the `aegis:<symbol>:<timeframe>` seed string, the phase-based
 * drift/volatility schedule and the 6-decimal rounding, so a given symbol and
 * timeframe produce the same series this platform has always produced.
 *
 * It is registered **last** and only serves when every real provider has failed.
 * Every candle it returns is flagged `synthetic: true`, and the manager stamps
 * `provenance.synthetic` so downstream layers must label it: simulated data is
 * never presented as market data (master plan rule 4).
 */

import { gaussian, hashString, seededRandom } from "../normalize.js";
import { TIMEFRAMES, timeframeMs } from "../timeframes.js";

export const BASE_PRICES = Object.freeze({
  EURUSD: 1.085, GBPUSD: 1.27, USDJPY: 151.5, AUDUSD: 0.66,
  USDCAD: 1.36, USDCHF: 0.895, NZDUSD: 0.61, XAUUSD: 2320,
  BTCUSDT: 64000, ETHUSDT: 3300, SOLUSDT: 148, BNBUSDT: 590, XRPUSDT: 0.62,
});

/** Half-away-from-zero rounding to 6 decimals, matching PHP `round($v, 6)`. */
function round6(value) {
  const scaled = value * 1e6;
  const rounded = scaled < 0 ? -Math.round(-scaled) : Math.round(scaled);
  return rounded / 1e6;
}

/**
 * @param {string} symbol
 * @param {string} timeframe
 * @param {number} limit
 * @param {number} [now] epoch ms; injectable so a series is reproducible
 * @returns {Array<{timestamp:number,open:number,high:number,low:number,close:number,volume:number}>}
 */
export function generateSyntheticCandles(symbol, timeframe, limit, now = Date.now()) {
  const random = seededRandom(hashString(`aegis:${symbol}:${timeframe}`));
  const interval = timeframeMs(timeframe);
  const lastOpen = Math.floor(now / interval) * interval - interval;

  const upper = String(symbol).toUpperCase();
  let price = BASE_PRICES[upper] ?? 10 + (hashString(upper) % 5000) / 10;
  const isFxLike = !upper.includes("BTC") && !upper.includes("ETH") && !upper.includes("SOL");
  const volatilityScale = isFxLike || upper.startsWith("XAU") ? 0.0012 : 0.004;

  const candles = [];
  for (let index = 0; index < limit; index += 1) {
    const timestamp = lastOpen - (limit - 1 - index) * interval;
    const phase = Math.floor(index / 40) % 4;
    let drift = 0;
    let volatility = volatilityScale;
    if (phase === 0) drift = 0.0018;
    else if (phase === 1) { drift = 0; volatility = volatilityScale * 0.7; }
    else if (phase === 2) { drift = -0.0015; volatility = volatilityScale * 1.4; }
    else { drift = 0.0004; volatility = volatilityScale * 1.1; }

    const returns = drift + gaussian(random) * volatility;
    const open = price;
    const close = open * (1 + returns);
    const wick = Math.abs(gaussian(random)) * volatility * open * 0.8;
    const high = Math.max(open, close) + wick * random();
    const low = Math.min(open, close) - wick * random();
    const baseVolume = upper.startsWith("BTC") || upper.startsWith("ETH") ? 800 : 1_000_000;
    const volume = Math.round(baseVolume * (0.5 + random() * 1.5) * (1 + Math.abs(returns) * 40));

    candles.push({
      timestamp,
      open: round6(open),
      high: round6(high),
      low: round6(low),
      close: round6(close),
      volume: Math.max(1, volume),
    });
    price = close;
  }
  return candles;
}

export function createSyntheticProvider({ now = () => Date.now() } = {}) {
  return {
    name: () => "synthetic-demo",
    synthetic: () => true,
    priority: () => 999,
    supportsSymbol: () => true,
    supportsTimeframe: () => true,
    supportsMarketClass: () => true,

    getCandles(request) {
      return generateSyntheticCandles(
        String(request.symbol).toUpperCase(),
        request.timeframe,
        request.limit,
        now(),
      );
    },

    getQuote(symbol) {
      const candles = generateSyntheticCandles(String(symbol).toUpperCase(), "1m", 2, now());
      const last = candles[candles.length - 1];
      const spread = last.close * 0.0002;
      return {
        symbol: String(symbol).toUpperCase(),
        bid: round6(last.close - spread / 2),
        ask: round6(last.close + spread / 2),
        last: last.close,
        timestamp: last.timestamp,
      };
    },

    healthCheck() {
      return {
        name: "synthetic-demo",
        status: "UP",
        synthetic: true,
        latencyMs: 0,
        checkedAt: Math.floor(now() / 1000),
        detail: "Deterministic synthetic generator (SIMULATION ONLY — not market data)",
        circuitState: "CLOSED",
      };
    },

    capabilities() {
      return {
        marketClasses: ["forex", "crypto", "stock", "etf", "commodity", "futures", "indices", "bonds"],
        timeframes: [...TIMEFRAMES],
        delayed: false,
        notes: "SYNTHETIC DATA — deterministic simulation for offline development/testing.",
      };
    },
  };
}
