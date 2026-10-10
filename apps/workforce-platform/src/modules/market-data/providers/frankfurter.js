/**
 * REAL forex reference rates from Frankfurter (ECB data, public, no key).
 * Ported from `application/libraries/Aegis/Providers/FrankfurterProvider.php`.
 *
 * The honest capability statement is the point of this provider: the ECB
 * publishes **daily** reference rates only, so it serves exactly the `1d`
 * timeframe and *refuses* intraday requests instead of interpolating them, and
 * reference rates carry no volume, so `volume` is `0.0` rather than an invented
 * figure. Metals (XAUUSD) are not covered.
 */

import { createCircuitBreaker } from "../circuit-breaker.js";

export const ECB_CURRENCIES = Object.freeze([
  "AUD", "BGN", "BRL", "CAD", "CHF", "CNY", "CZK", "DKK", "EUR", "GBP", "HKD", "HUF",
  "IDR", "ILS", "INR", "ISK", "JPY", "KRW", "MXN", "MYR", "NOK", "NZD", "PHP", "PLN",
  "RON", "SEK", "SGD", "THB", "TRY", "USD", "ZAR",
]);

const DAY_MS = 86_400_000;

export function splitPair(symbol) {
  const upper = String(symbol).toUpperCase();
  return [upper.slice(0, 3), upper.slice(3, 6)];
}

function utcDate(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

function utcMidnightMs(date) {
  const parsed = Date.parse(`${date}T00:00:00Z`);
  return Number.isFinite(parsed) ? parsed : null;
}

export function createFrankfurterProvider({
  baseUrl = "https://api.frankfurter.dev",
  http,
  retries = 2,
  now = () => Date.now(),
  breaker = createCircuitBreaker("frankfurter", { now }),
} = {}) {
  const name = "frankfurter-ecb";
  const base = String(baseUrl).replace(/\/$/, "");

  async function guarded(fn) {
    if (!breaker.canCall()) throw new Error("frankfurter circuit breaker OPEN");
    try {
      const result = await fn();
      breaker.recordSuccess();
      return result;
    } catch (error) {
      breaker.recordFailure();
      throw error;
    }
  }

  function supportsSymbol(symbol) {
    const [quoteBase, quoteQuote] = splitPair(symbol);
    return ECB_CURRENCIES.includes(quoteBase)
      && ECB_CURRENCIES.includes(quoteQuote)
      && quoteBase !== quoteQuote;
  }

  return {
    name: () => name,
    synthetic: () => false,
    priority: () => 20,
    supportsSymbol,
    supportsTimeframe: (_symbol, timeframe) => timeframe === "1d",
    supportsMarketClass: (marketClass) => String(marketClass).toLowerCase() === "forex",
    circuitState: () => breaker.currentState(),

    async getCandles(request) {
      if (request.timeframe !== "1d") throw new Error("frankfurter-ecb serves daily (1d) data only");
      if (!supportsSymbol(request.symbol)) throw new Error(`frankfurter-ecb does not cover ${request.symbol}`);
      const [pairBase, pairQuote] = splitPair(request.symbol);
      const limit = Math.max(1, Number(request.limit) || 0);
      const days = Math.ceil(limit * 1.5) + 10;
      const start = utcDate(now() - days * DAY_MS);
      const url = `${base}/v1/${start}..?base=${encodeURIComponent(pairBase)}&symbols=${encodeURIComponent(pairQuote)}`;
      const data = await guarded(() => http.getJson(url, { retries, signal: request.signal }));

      const rows = data?.rates;
      if (!rows || typeof rows !== "object" || Array.isArray(rows) || Object.keys(rows).length === 0) {
        throw new Error("frankfurter-ecb returned no series");
      }

      const candles = [];
      let previous = null;
      for (const date of Object.keys(rows).sort()) {
        const entry = rows[date];
        const rate = typeof entry === "object" && entry !== null ? entry[pairQuote] : entry;
        const value = typeof rate === "number" ? rate : Number(rate);
        if (!Number.isFinite(value)) continue;
        const timestamp = utcMidnightMs(date);
        if (timestamp === null) continue;
        const open = previous ?? value;
        candles.push({
          timestamp,
          open,
          high: Math.max(open, value),
          low: Math.min(open, value),
          close: value,
          // Reference rates carry no volume — honest zero, never an estimate.
          volume: 0,
        });
        previous = value;
      }
      if (candles.length === 0) throw new Error("frankfurter-ecb returned no series");
      return candles.slice(-limit);
    },

    async getQuote(symbol, options = {}) {
      if (!supportsSymbol(symbol)) throw new Error(`frankfurter-ecb does not cover ${symbol}`);
      const [pairBase, pairQuote] = splitPair(symbol);
      const url = `${base}/v1/latest?base=${encodeURIComponent(pairBase)}&symbols=${encodeURIComponent(pairQuote)}`;
      const data = await guarded(() => http.getJson(url, { retries: 1, signal: options.signal }));
      const rate = Number(data?.rates?.[pairQuote]);
      if (!Number.isFinite(rate)) throw new Error("frankfurter-ecb returned no rate");
      const date = typeof data?.date === "string" ? data.date : utcDate(now());
      // ECB reference rates are fixed around 16:00 CET; the legacy port stamps
      // the rate at 16:00 UTC of the publication date.
      const published = Date.parse(`${date}T16:00:00Z`);
      return {
        symbol: String(symbol).toUpperCase(),
        last: rate,
        timestamp: Number.isFinite(published) ? published : now(),
      };
    },

    async healthCheck(options = {}) {
      const started = now();
      try {
        await guarded(() => http.getJson(`${base}/v1/latest?base=EUR&symbols=USD`, { retries: 1, signal: options?.signal }));
        return {
          name,
          status: "UP",
          synthetic: false,
          latencyMs: now() - started,
          checkedAt: Math.floor(now() / 1000),
          circuitState: breaker.currentState(),
          detail: "ECB daily reference rates via Frankfurter (daily timeframe only, no volume)",
        };
      } catch (error) {
        return {
          name,
          status: "DOWN",
          synthetic: false,
          latencyMs: now() - started,
          checkedAt: Math.floor(now() / 1000),
          lastError: String(error?.message || error).slice(0, 240),
          circuitState: breaker.currentState(),
          detail: "Unreachable from this host — manager falls back and flags synthetic use.",
        };
      }
    },

    capabilities() {
      return {
        marketClasses: ["forex"],
        timeframes: ["1d"],
        delayed: true,
        notes: "Real ECB daily FX reference rates. Intraday forex and metals are NOT available from this source.",
      };
    },
  };
}
