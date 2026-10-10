/**
 * Configured boundary for licensed stock, ETF, futures and options data.
 * Ported from `application/libraries/Aegis/Providers/LicensedAssetMarketDataProvider.php`.
 *
 * This adapter is **inert until a licensed feed is supplied**: it needs a URL, an
 * explicit ENABLED flag, license metadata and a symbol allow-list. Until then it
 * reports `DISABLED` or `NOT_CONFIGURED` and refuses every data call. It performs
 * no symbol discovery and never synthesises a value — a missing integration must
 * be visible as a missing integration (master plan rule 4, and the reason the
 * status surface lists `marketData` capabilities per provider rather than in
 * aggregate).
 *
 * The wire contract is provider-neutral so a vendor integration can sit behind it
 * without leaking its payload shape into the platform:
 *   GET {url}/candles?symbol&marketClass&timeframe&limit → {"data":{"candles":[{timestamp,open,high,low,close,volume}]}}
 *   GET {url}/quote?symbol&marketClass                   → {"data":{"symbol","last","bid","ask","timestamp"}}
 *   GET {healthUrl}                                      → {"ok":true,"version":"…"}
 */

import { TIMEFRAMES } from "../timeframes.js";

const SYMBOL_PATTERN = /^[A-Z0-9._:-]{1,64}$/;
const USER_AGENT = "WINDELS-Licensed-Market-Data/1.0";

function isList(value) {
  return Array.isArray(value);
}

function normalizeSymbols(symbols) {
  const out = new Set();
  for (const entry of symbols || []) {
    const symbol = String(entry).trim().toUpperCase();
    if (symbol && SYMBOL_PATTERN.test(symbol)) out.add(symbol);
  }
  return [...out];
}

export function createLicensedAssetProvider({
  assetClass,
  providerId,
  displayName,
  envPrefix,
  baseUrl = null,
  healthUrl = null,
  token = "",
  license = "",
  enabled = false,
  delayed = true,
  priority = 30,
  symbols = [],
  request = null,
  now = () => Date.now(),
}) {
  const klass = String(assetClass).toLowerCase().trim();
  if (!["stock", "etf", "futures", "options"].includes(klass)) {
    throw new Error(`unsupported licensed asset class: ${assetClass}`);
  }
  const id = String(providerId).trim();
  const allowedSymbols = normalizeSymbols(symbols);

  function validUrl() {
    if (!baseUrl) return false;
    try {
      const parsed = new URL(baseUrl);
      return ["https:", "http:"].includes(parsed.protocol) && Boolean(parsed.hostname) && !parsed.username && !parsed.password;
    } catch {
      return false;
    }
  }

  function configured() {
    return Boolean(enabled) && validUrl() && String(license).trim() !== "" && allowedSymbols.length > 0;
  }

  function assertConfigured() {
    if (!configured()) {
      throw new Error(`${id} is not configured: enable it only after URL, license metadata and symbols are supplied`);
    }
  }

  function endpoint(path, query = {}) {
    const url = `${String(baseUrl).replace(/\/$/, "")}/${String(path).replace(/^\//, "")}`;
    const entries = Object.entries(query);
    return entries.length === 0 ? url : `${url}?${new URLSearchParams(entries.map(([key, value]) => [key, String(value)])).toString()}`;
  }

  async function defaultRequest(url, authToken, options = {}) {
    try {
      const headers = { accept: "application/json", "user-agent": USER_AGENT };
      if (authToken) headers.authorization = `Bearer ${authToken}`;
      const response = await fetch(url, { headers, signal: options.signal, redirect: "follow" });
      const text = await response.text();
      const decoded = JSON.parse(text);
      return decoded && typeof decoded === "object" ? decoded : null;
    } catch {
      return null;
    }
  }

  const call = request || defaultRequest;

  function fail(message) {
    throw new Error(`${id} ${message}`);
  }

  function number(row, key, required) {
    if (!(key in row)) {
      if (!required) return 0;
      fail(`response is missing ${key}`);
    }
    const value = typeof row[key] === "number" ? row[key] : Number(row[key]);
    if (!Number.isFinite(value)) fail(`response ${key} is invalid`);
    return value;
  }

  function numberAny(row, keys, fallback = null) {
    for (const key of keys) if (key in row) return number(row, key, false);
    if (fallback !== null) return fallback;
    fail(`response is missing ${keys[0]}`);
    return 0;
  }

  function timestampOf(value) {
    if (typeof value === "number" || (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value)))) {
      const asInt = Math.trunc(Number(value));
      return asInt > 100_000_000_000 ? asInt : asInt * 1000;
    }
    if (typeof value === "string" && value.trim() !== "") {
      const parsed = Date.parse(value);
      if (Number.isFinite(parsed)) return parsed;
    }
    fail("response timestamp is invalid");
    return 0;
  }

  function rows(payload, key) {
    if (!payload || typeof payload !== "object") fail("returned an invalid JSON object");
    let list = payload[key] ?? payload?.data?.[key];
    if (!isList(list)) list = payload?.data ?? payload;
    if (!isList(list)) fail(`response has no ${key} list`);
    return list.filter((entry) => entry && typeof entry === "object");
  }

  function object(payload, key) {
    if (!payload || typeof payload !== "object") fail(`returned an invalid ${key} object`);
    const row = payload[key] ?? payload?.data?.[key] ?? payload?.data ?? payload;
    if (!row || typeof row !== "object" || isList(row)) fail(`response has no ${key} object`);
    return row;
  }

  function normalizeCandle(row) {
    const candle = {
      timestamp: timestampOf(row.timestamp ?? row.time ?? row.t ?? null),
      open: numberAny(row, ["open", "o"]),
      high: numberAny(row, ["high", "h"]),
      low: numberAny(row, ["low", "l"]),
      close: numberAny(row, ["close", "c"]),
      volume: numberAny(row, ["volume", "v"], 0),
    };
    if (candle.open <= 0 || candle.high <= 0 || candle.low <= 0 || candle.close <= 0
      || candle.high < Math.max(candle.open, candle.close)
      || candle.low > Math.min(candle.open, candle.close)
      || candle.volume < 0) {
      fail("returned invalid OHLCV data");
    }
    return candle;
  }

  return {
    name: () => id,
    synthetic: () => false,
    priority: () => priority,
    marketClass: () => klass,
    displayName: () => displayName,
    envPrefix: () => envPrefix,
    configured,
    supportsMarketClass: (marketClass) => String(marketClass).toLowerCase() === klass,
    supportsSymbol(symbol) {
      return configured() && allowedSymbols.includes(String(symbol).trim().toUpperCase());
    },
    supportsTimeframe(symbol, timeframe) {
      return this.supportsSymbol(symbol) && TIMEFRAMES.includes(timeframe);
    },

    async getCandles(request) {
      assertConfigured();
      const symbol = String(request.symbol ?? "").trim().toUpperCase();
      const timeframe = String(request.timeframe ?? "");
      const limit = Math.max(1, Math.min(5000, Number(request.limit) || 200));
      if (!allowedSymbols.includes(symbol)) fail(`does not allow ${symbol}`);
      if (!TIMEFRAMES.includes(timeframe)) fail(`does not support timeframe ${timeframe}`);

      const payload = await call(endpoint("/candles", {
        symbol, marketClass: klass, timeframe, limit,
      }), token || null, request);
      const list = rows(payload, "candles");
      if (list.length === 0) fail("returned no candles");
      return list.map(normalizeCandle);
    },

    async getQuote(symbol, options = {}) {
      assertConfigured();
      const upper = String(symbol).trim().toUpperCase();
      if (!allowedSymbols.includes(upper)) fail(`does not allow ${upper}`);
      const payload = await call(endpoint("/quote", { symbol: upper, marketClass: klass }), token || null, options);
      const row = object(payload, "quote");
      const quote = { symbol: upper, last: number(row, "last", true), timestamp: timestampOf(row.timestamp ?? null) };
      for (const field of ["bid", "ask"]) {
        if (field in row && row[field] !== null) quote[field] = number(row, field, false);
      }
      if ("bid" in quote && "ask" in quote && (quote.bid <= 0 || quote.ask <= 0 || quote.ask < quote.bid)) {
        fail("returned an invalid bid/ask quote");
      }
      return quote;
    },

    async healthCheck(options = {}) {
      const base = { name: id, synthetic: false, checkedAt: Math.floor(now() / 1000), marketClass: klass };
      if (!enabled) {
        return { ...base, status: "DISABLED", detail: `Set ${envPrefix}_ENABLED=1 after the licensed feed is approved.` };
      }
      if (!validUrl() || String(license).trim() === "" || allowedSymbols.length === 0) {
        return { ...base, status: "NOT_CONFIGURED", detail: "Requires a safe HTTPS URL, license metadata, and an explicit symbol allow-list." };
      }
      const started = now();
      try {
        const health = await call(healthUrl || endpoint("/health"), token || null, options);
        if (!health || typeof health !== "object" || health.ok === false) throw new Error("health endpoint reported failure");
        const out = {
          ...base,
          status: "UP",
          latencyMs: now() - started,
          detail: `${displayName} reachable; licensed source metadata is configured.`,
          licenseConfigured: true,
          delayed,
        };
        if (health.version !== undefined && health.version !== null && typeof health.version !== "object") {
          out.providerVersion = String(health.version);
        }
        return out;
      } catch (error) {
        return {
          ...base,
          status: "DOWN",
          latencyMs: now() - started,
          lastError: String(error?.message || error).slice(0, 240),
          detail: "Licensed feed is configured but unreachable; synthetic fallback remains explicit.",
        };
      }
    },

    capabilities() {
      return {
        marketClasses: [klass],
        timeframes: [...TIMEFRAMES],
        delayed,
        notes: `${displayName} adapter. Upstream license and schema must be verified before production use; no provider is claimed by this scaffold.`,
        configuredSymbols: allowedSymbols.length,
        licenseConfigured: String(license).trim() !== "",
      };
    },
  };
}
