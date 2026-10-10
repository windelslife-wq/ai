/**
 * REAL crypto market data from Binance public REST (no key required for market
 * data). Ported from `application/libraries/Aegis/Providers/BinanceProvider.php`.
 *
 * Honesty rules carried over verbatim:
 *  - only the 12 listed symbols are supported; an unlisted symbol is refused
 *    rather than approximated;
 *  - a `{code,msg}` error envelope is a failure, never a candle row;
 *  - a quote with a zero or inverted bid/ask is a failure;
 *  - when the host cannot reach any Binance endpoint the provider reports DOWN
 *    and the manager falls back — it never silently serves synthetic data as if
 *    it were live, because `provenance.synthetic` says which happened;
 *  - only market-data endpoints are used. No trading endpoint is called here or
 *    anywhere else in this platform.
 */

import { createCircuitBreaker } from "../circuit-breaker.js";
import { TIMEFRAMES } from "../timeframes.js";

export const BINANCE_SYMBOLS = Object.freeze([
  "BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT", "ADAUSDT",
  "DOGEUSDT", "AVAXUSDT", "LINKUSDT", "DOTUSDT", "MATICUSDT", "LTCUSDT",
]);

const FALLBACK_HOSTS = Object.freeze(["https://data-api.binance.vision", "https://api1.binance.com"]);

function toNumber(value) {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function createBinanceProvider({
  baseUrl = "https://api.binance.com",
  http,
  retries = 1,
  now = () => Date.now(),
  breaker = createCircuitBreaker("binance", { now }),
} = {}) {
  const name = "binance";
  const hosts = [...new Set([String(baseUrl).replace(/\/$/, ""), ...FALLBACK_HOSTS])];

  async function fetchJson(path, options = {}) {
    if (!breaker.canCall()) throw new Error("binance circuit breaker OPEN");
    let lastError = "binance request failed";
    for (const host of hosts) {
      try {
        const json = await http.getJson(`${host}${path}`, { retries, signal: options.signal });
        if (!json || typeof json !== "object") throw new Error("binance returned a non-object payload");
        breaker.recordSuccess();
        return json;
      } catch (error) {
        lastError = error?.message || String(error);
      }
    }
    breaker.recordFailure();
    throw new Error(lastError);
  }

  function normalizeKlines(raw) {
    if (!Array.isArray(raw)) {
      const message = typeof raw?.msg === "string" ? raw.msg : "unexpected klines payload";
      throw new Error(`binance klines failed: ${message}`);
    }
    const out = [];
    for (const row of raw) {
      if (!Array.isArray(row) || row.length < 6) throw new Error("binance klines row is invalid");
      const [timestamp, open, high, low, close, volume] = row.slice(0, 6).map(toNumber);
      if ([timestamp, open, high, low, close, volume].some((value) => value === null)) {
        throw new Error("binance klines row is invalid");
      }
      out.push({ timestamp: Math.trunc(timestamp), open, high, low, close, volume });
    }
    if (out.length === 0) throw new Error("binance returned no klines");
    return out;
  }

  return {
    name: () => name,
    synthetic: () => false,
    priority: () => 10,
    supportsSymbol: (symbol) => BINANCE_SYMBOLS.includes(String(symbol).toUpperCase()),
    supportsTimeframe: (_symbol, timeframe) => TIMEFRAMES.includes(timeframe),
    supportsMarketClass: (marketClass) => String(marketClass).toLowerCase() === "crypto",
    hosts: () => [...hosts],
    circuitState: () => breaker.currentState(),

    async getCandles(request) {
      const symbol = String(request.symbol).toUpperCase();
      if (!BINANCE_SYMBOLS.includes(symbol)) throw new Error(`Binance provider does not list ${symbol}`);
      const limit = Math.min(1000, Math.max(1, Number(request.limit) || 0));
      const query = `symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(request.timeframe)}&limit=${limit}`;
      return normalizeKlines(await fetchJson(`/api/v3/klines?${query}`, request));
    },

    async getQuote(symbol, options = {}) {
      const upper = String(symbol).toUpperCase();
      if (!BINANCE_SYMBOLS.includes(upper)) throw new Error(`Binance provider does not list ${upper}`);
      const ticker = await fetchJson(`/api/v3/ticker/bookTicker?symbol=${encodeURIComponent(upper)}`, options);
      const bid = toNumber(ticker?.bidPrice);
      const ask = toNumber(ticker?.askPrice);
      if (bid === null || ask === null) throw new Error(`binance ticker failed: ${String(ticker?.msg ?? "missing bid/ask")}`);
      if (bid <= 0 || ask <= 0 || ask < bid) throw new Error("binance ticker returned invalid prices");
      return { symbol: upper, bid, ask, last: (bid + ask) / 2, timestamp: now() };
    },

    async healthCheck(options = {}) {
      const started = now();
      try {
        await fetchJson("/api/v3/ping", options);
        return {
          name,
          status: "UP",
          synthetic: false,
          latencyMs: now() - started,
          checkedAt: Math.floor(now() / 1000),
          circuitState: breaker.currentState(),
          detail: "Public market-data REST API (no key required)",
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
        marketClasses: ["crypto"],
        timeframes: [...TIMEFRAMES],
        delayed: false,
        notes: "Real spot crypto klines/quotes via public REST. Trading endpoints NOT used.",
      };
    },
  };
}
