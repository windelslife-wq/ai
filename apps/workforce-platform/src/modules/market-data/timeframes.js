/**
 * Timeframe vocabulary and staleness thresholds.
 *
 * Ported from `application/libraries/Aegis/Timeframes.php`. The staleness table
 * is the one that decides `provenance.stale`, so it is data here exactly as it
 * is data there — an analysis layer that guesses a threshold would label fresh
 * data stale or, worse, stale data fresh.
 */

export const TIMEFRAMES = Object.freeze(["1m", "5m", "15m", "1h", "4h", "1d"]);

const MS = Object.freeze({
  "1m": 60_000,
  "5m": 300_000,
  "15m": 900_000,
  "1h": 3_600_000,
  "4h": 14_400_000,
  "1d": 86_400_000,
});

/** Staleness thresholds per timeframe (matches the legacy PHP/TS editions). */
const STALE_MS = Object.freeze({
  "1m": 5 * 60_000,
  "5m": 15 * 60_000,
  "15m": 45 * 60_000,
  "1h": 3 * 3_600_000,
  "4h": 12 * 3_600_000,
  "1d": 4 * 86_400_000,
});

export function isTimeframe(value) {
  return TIMEFRAMES.includes(value);
}

export function timeframeMs(timeframe) {
  return MS[timeframe] ?? 3_600_000;
}

export function staleMs(timeframe) {
  return STALE_MS[timeframe] ?? 3 * 3_600_000;
}

/**
 * Market classes accepted by the API. The legacy controller rejects anything
 * outside this list rather than guessing, and `inferClass` maps an unlabelled
 * symbol to `crypto` when it ends in USDT and `forex` otherwise.
 */
export const MARKET_CLASSES = Object.freeze([
  "forex", "crypto", "stock", "etf", "commodity", "futures", "options", "indices", "bonds",
]);

export function isMarketClass(value) {
  return MARKET_CLASSES.includes(String(value).toLowerCase());
}

export function inferMarketClass(symbol) {
  return String(symbol).toUpperCase().endsWith("USDT") ? "crypto" : "forex";
}
