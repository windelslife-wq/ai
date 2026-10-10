/**
 * Provider chain: priority order, capability filtering, circuit-breaker gating,
 * bounded caching, explicit fallback tracking and provenance stamping.
 *
 * Ported from `application/libraries/Aegis/ProviderManager.php`. The invariant
 * that matters: when the synthetic provider ends up serving, `provenance.synthetic`
 * is `true` and flows to every consumer, so no layer can present simulated data
 * as market data. Two deliberate hardenings over the legacy version are marked
 * inline — a bounded cache (the legacy arrays grew without limit in a long-lived
 * process) and a request deadline (a host with no outbound access must fail fast
 * and honestly instead of stacking provider timeouts).
 */

import { normalizeCandles } from "./normalize.js";
import { staleMs, timeframeMs } from "./timeframes.js";

const MAX_CACHE_ENTRIES = 500;

function createTtlCache() {
  const entries = new Map();
  return {
    get(key, now) {
      const entry = entries.get(key);
      if (!entry) return null;
      if (entry.expires <= now) {
        entries.delete(key);
        return null;
      }
      return entry.value;
    },
    set(key, value, expires, now) {
      if (entries.size >= MAX_CACHE_ENTRIES) {
        // Evict expired entries first, then the oldest insertion (Map preserves
        // insertion order), so a burst of symbols cannot grow the heap forever.
        for (const [existingKey, existing] of entries) {
          if (existing.expires <= now) entries.delete(existingKey);
        }
        while (entries.size >= MAX_CACHE_ENTRIES) {
          const oldest = entries.keys().next();
          if (oldest.done) break;
          entries.delete(oldest.value);
        }
      }
      entries.set(key, { value, expires });
    },
    size: () => entries.size,
    clear: () => entries.clear(),
  };
}

export function createProviderManager({
  now = () => Date.now(),
  settleMs = 50,
  deadlineMs = 15_000,
  healthDeadlineMs = 5_000,
  allowSynthetic = true,
  sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }),
  onFallback = null,
} = {}) {
  let providers = [];
  const candleCache = createTtlCache();
  const quoteCache = createTtlCache();
  const healthCache = createTtlCache();
  const failureLog = new Map();
  let fallbackHandler = onFallback;

  function register(provider) {
    providers = [...providers, provider].sort((a, b) => a.priority() - b.priority());
  }

  function setFallbackHandler(handler) {
    fallbackHandler = handler;
  }

  function listProviders() {
    return [...providers];
  }

  /** Providers that could serve this symbol/class, timeframe-capable first. */
  function candidatesFor(symbol, timeframe, marketClass = null) {
    const candidates = providers.filter((provider) => {
      if (!allowSynthetic && provider.synthetic()) return false;
      if (!provider.supportsSymbol(symbol)) return false;
      if (marketClass !== null && marketClass !== undefined) {
        if (typeof provider.supportsMarketClass === "function") {
          if (!provider.supportsMarketClass(marketClass)) return false;
        } else {
          const classes = provider.capabilities()?.marketClasses || [];
          if (Array.isArray(classes) && classes.length > 0
            && !classes.some((entry) => String(entry).toLowerCase() === String(marketClass).toLowerCase())) return false;
        }
      }
      return true;
    });
    return candidates.sort((a, b) => {
      const ta = a.supportsTimeframe(symbol, timeframe) ? 1 : 0;
      const tb = b.supportsTimeframe(symbol, timeframe) ? 1 : 0;
      return tb - ta || a.priority() - b.priority();
    });
  }

  function requestSignal(callerSignal, limitMs = deadlineMs) {
    const signals = [AbortSignal.timeout(limitMs)];
    if (callerSignal) signals.push(callerSignal);
    return AbortSignal.any(signals);
  }

  async function fetchCandles(symbol, marketClass, timeframe, limit, signal) {
    const key = `c:${String(marketClass).toLowerCase()}:${String(symbol).toUpperCase()}:${timeframe}:${limit}`;
    const cached = candleCache.get(key, now());
    if (cached) return { candles: cached.candles, provider: cached.provider, failed: [], fromCache: true };

    const failed = [];
    for (const provider of candidatesFor(symbol, timeframe, marketClass)) {
      try {
        const candles = await provider.getCandles({ symbol, timeframe, limit, signal });
        if (!Array.isArray(candles) || candles.length === 0) throw new Error("empty candle response");
        // Reject a provider whose rows do not survive normalization: serving 4
        // "candles" of zeros is how the legacy platform once produced a silently
        // empty analysis dashboard.
        const preview = normalizeCandles(candles, timeframe);
        if (preview.candles.length < 30) {
          throw new Error(`${provider.name()} returned too few valid candles (${preview.candles.length})`);
        }
        const ttl = Math.max(15, timeframeMs(timeframe) * 0.25);
        candleCache.set(key, { candles, provider }, now() + ttl, now());
        if (failed.length > 0 && fallbackHandler) {
          await fallbackHandler({ symbol, marketClass, timeframe, failed, used: provider.name(), synthetic: provider.synthetic() });
        }
        return { candles, provider, failed, fromCache: false };
      } catch (error) {
        failureLog.set(provider.name(), String(error?.message || error));
        failed.push(provider.name());
        if (settleMs > 0) await sleep(settleMs);
      }
    }

    const reason = allowSynthetic
      ? `No provider could serve candles for ${symbol} ${timeframe}. Failed: ${failed.join(", ") || "none"}`
      : `No provider could serve candles for ${symbol} ${timeframe} and synthetic data is refused on this host (MARKET_DATA_ALLOW_SYNTHETIC=0). Failed: ${failed.join(", ") || "none"}`;
    const error = new Error(reason);
    error.failedProviders = failed;
    throw error;
  }

  async function getCandleSeries(symbol, marketClass, timeframe, limit, options = {}) {
    const fetchedAt = now();
    const signal = requestSignal(options.signal);
    const { candles: raw, provider, failed, fromCache } = await fetchCandles(symbol, marketClass, timeframe, limit, signal);
    const { candles, validation } = normalizeCandles(raw, timeframe);

    const dataTimestamp = candles.length ? candles[candles.length - 1].timestamp : 0;
    const threshold = staleMs(timeframe);
    const dataAgeMs = Math.max(0, fetchedAt - dataTimestamp);

    return {
      symbol: String(symbol).toUpperCase(),
      marketClass,
      timeframe,
      candles,
      provenance: {
        source: provider.name(),
        synthetic: provider.synthetic(),
        live: !provider.synthetic(),
        delayed: Boolean(provider.capabilities()?.delayed),
        fetchedAt,
        dataTimestamp,
        dataAgeMs,
        stale: dataTimestamp === 0 || dataAgeMs > threshold,
        staleThresholdMs: threshold,
        fallbackChain: failed,
        fromCache,
      },
      validation,
    };
  }

  async function getQuote(symbol, options = {}) {
    const upper = String(symbol).toUpperCase();
    const key = `q:${upper}`;
    const cached = quoteCache.get(key, now());
    if (cached) return { ...cached, fromCache: true };

    const signal = requestSignal(options.signal);
    const candidates = providers
      .filter((provider) => (allowSynthetic || !provider.synthetic()) && provider.supportsSymbol(upper))
      .sort((a, b) => a.priority() - b.priority());

    const failed = [];
    for (const provider of candidates) {
      try {
        const quote = await provider.getQuote(upper, { signal });
        const payload = {
          quote,
          source: provider.name(),
          synthetic: provider.synthetic(),
          live: !provider.synthetic(),
          fallbackChain: failed,
          fetchedAt: now(),
        };
        quoteCache.set(key, payload, now() + 15_000, now());
        if (failed.length > 0 && fallbackHandler) {
          await fallbackHandler({ symbol: upper, marketClass: null, timeframe: null, failed, used: provider.name(), synthetic: provider.synthetic() });
        }
        return payload;
      } catch (error) {
        failureLog.set(provider.name(), String(error?.message || error));
        failed.push(provider.name());
        if (settleMs > 0) await sleep(settleMs);
      }
    }

    const error = new Error(`No provider could serve a quote for ${upper}${allowSynthetic ? "" : " (synthetic data is refused on this host)"}. Failed: ${failed.join(", ") || "none"}`);
    error.failedProviders = failed;
    throw error;
  }

  /**
   * Health for every registered provider. A provider that answered UP but has a
   * recorded failure in this process is reported DEGRADED, exactly as the legacy
   * manager does: "it works now" and "it has been failing" are both true and both
   * worth showing.
   */
  async function getAllHealth(force = false, options = {}) {
    // Health probes get a shorter budget than data requests: a slow provider must
    // not be able to hold the health surface open for the full deadline.
    const signal = requestSignal(options.signal, Math.min(deadlineMs, healthDeadlineMs));
    const out = [];
    for (const provider of providers) {
      const key = `h:${provider.name()}`;
      if (!force) {
        const cached = healthCache.get(key, now());
        if (cached) {
          out.push(cached);
          continue;
        }
      }
      // `probe: false` never touches the network: the public status surface uses
      // it so an unauthenticated caller cannot make this server fan out to third
      // parties. Unprobed providers report UNKNOWN, which is the truthful answer.
      if (options.probe === false) {
        out.push({
          name: provider.name(),
          status: "UNKNOWN",
          synthetic: provider.synthetic(),
          checkedAt: null,
          detail: "Not probed. Request GET /api/v1/market-data/providers (authenticated) to refresh provider health.",
        });
        continue;
      }
      let health;
      try {
        health = await provider.healthCheck({ signal });
      } catch (error) {
        health = {
          name: provider.name(),
          status: "DOWN",
          synthetic: provider.synthetic(),
          checkedAt: Math.floor(now() / 1000),
          lastError: String(error?.message || error).slice(0, 240),
        };
      }
      if (failureLog.get(provider.name()) && health.status === "UP") {
        health = { ...health, status: "DEGRADED" };
      }
      healthCache.set(key, health, now() + 10_000, now());
      out.push(health);
    }
    return out;
  }

  return {
    register,
    setFallbackHandler,
    listProviders,
    candidatesFor,
    getCandleSeries,
    getQuote,
    getAllHealth,
    /** Diagnostics: the last error recorded per provider in this process. */
    failureLog: () => Object.fromEntries(failureLog),
    caches: () => ({ candles: candleCache.size(), quotes: quoteCache.size(), health: healthCache.size() }),
    clearCaches() {
      candleCache.clear();
      quoteCache.clear();
      healthCache.clear();
      failureLog.clear();
    },
  };
}
