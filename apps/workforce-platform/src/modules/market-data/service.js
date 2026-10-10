/**
 * Market-data service: builds the provider chain from configuration and exposes
 * candles, quotes and provider health to the API layer.
 *
 * Ported from the registration block in `application/libraries/Aegis/Platform.php`
 * (lines 50–84), including the ordering (Binance 10 → Frankfurter 20 → licensed
 * assets 30–33 → synthetic 999) and the `PROVIDER_FALLBACK` audit event.
 *
 * Registration is configuration-driven and honest:
 *  - `MARKET_DATA_REAL_PROVIDERS=0` skips the real providers (offline development);
 *  - the four licensed adapters are always registered but stay inert until their
 *    URL, license metadata and symbol allow-list are supplied, and they report
 *    `DISABLED`/`NOT_CONFIGURED` rather than pretending to be live;
 *  - `MARKET_DATA_ALLOW_SYNTHETIC=0` refuses the synthetic provider entirely, so a
 *    host that must never serve invented candles returns an error instead.
 */

import { createHttpClient } from "./http.js";
import { createProviderManager } from "./manager.js";
import { createBinanceProvider } from "./providers/binance.js";
import { createFrankfurterProvider } from "./providers/frankfurter.js";
import { createLicensedAssetProvider } from "./providers/licensed-asset.js";
import { createSyntheticProvider } from "./providers/synthetic.js";
import { inferMarketClass } from "./timeframes.js";

/** Legacy action name preserved in the audit payload for cutover traceability. */
const LEGACY_FALLBACK_ACTION = "PROVIDER_FALLBACK";

export function createMarketDataService({
  config,
  store = null,
  log = null,
  now = () => Date.now(),
  http = null,
  settleMs = 50,
} = {}) {
  const settings = config.marketData;
  if (!settings) throw new Error("market data configuration is missing");

  const httpClient = http || createHttpClient({
    timeoutMs: settings.timeoutMs,
    retries: settings.retries,
  });

  const manager = createProviderManager({
    now,
    settleMs,
    deadlineMs: settings.deadlineMs,
    healthDeadlineMs: settings.healthTimeoutMs,
    allowSynthetic: settings.allowSynthetic,
    onFallback: async (event) => {
      const message = `\`${event.symbol}\`: providers [${event.failed.join(", ")}] failed — falling back to ${event.used}`;
      if (!store) return;
      try {
        await store.recordAudit({
          actorId: null,
          action: "marketData.provider.fallback",
          entityType: "market_data",
          entityId: event.symbol,
          details: {
            legacyAction: LEGACY_FALLBACK_ACTION,
            message,
            symbol: event.symbol,
            marketClass: event.marketClass,
            timeframe: event.timeframe,
            failed: event.failed,
            used: event.used,
            synthetic: event.synthetic,
          },
        });
      } catch (error) {
        // Audit failure must never turn a served candle series into a 500.
        if (log) log.warn({ err: error }, "market-data fallback audit failed");
      }
    },
  });

  if (settings.realProviders) {
    manager.register(createBinanceProvider({ baseUrl: settings.binanceBaseUrl, http: httpClient, retries: 1, now }));
    manager.register(createFrankfurterProvider({ baseUrl: settings.frankfurterBaseUrl, http: httpClient, retries: 2, now }));
    for (const licensed of settings.licensed) {
      manager.register(createLicensedAssetProvider({
        assetClass: licensed.assetClass,
        providerId: `licensed-${licensed.assetClass}`,
        displayName: licensed.displayName,
        envPrefix: licensed.envPrefix,
        baseUrl: licensed.baseUrl,
        healthUrl: licensed.healthUrl,
        token: licensed.token,
        license: licensed.license,
        enabled: licensed.enabled,
        delayed: licensed.delayed,
        priority: licensed.priority,
        symbols: licensed.symbols,
        now,
      }));
    }
  }

  // Synthetic is always registered last: it is the fallback of last resort and its
  // output is always labelled synthetic in the response provenance.
  if (settings.allowSynthetic) {
    manager.register(createSyntheticProvider({ now }));
  }

  async function candles({ symbol, timeframe, marketClass = null, limit = 200 }, options = {}) {
    const upper = String(symbol).trim().toUpperCase();
    if (upper.length < 2) throw Object.assign(new Error("symbol too short"), { statusCode: 400, code: "VALIDATION_FAILED" });
    const resolvedClass = marketClass || inferMarketClass(upper);
    const series = await manager.getCandleSeries(upper, resolvedClass, timeframe, limit, options);
    return series;
  }

  async function quote({ symbol }, options = {}) {
    const upper = String(symbol).trim().toUpperCase();
    if (upper.length < 2) throw Object.assign(new Error("symbol too short"), { statusCode: 400, code: "VALIDATION_FAILED" });
    return manager.getQuote(upper, options);
  }

  /** Registry description: what is installed, in what order, and what it claims. */
  function registry() {
    return manager.listProviders().map((provider) => {
      const capabilities = provider.capabilities();
      return {
        name: provider.name(),
        synthetic: provider.synthetic(),
        priority: provider.priority(),
        capabilities,
      };
    });
  }

  async function providers(refresh = true, options = {}) {
    return {
      providers: await manager.getAllHealth(refresh, options),
      registry: registry(),
      policy: {
        realProviders: settings.realProviders,
        syntheticAllowed: settings.allowSynthetic,
        syntheticIsNeverMarketData: true,
      },
    };
  }

  /**
   * Cheap health snapshot for the public status surface. It never probes an
   * external host: an unauthenticated endpoint must not become a way to make this
   * server fan out to third parties. Probing happens on the authenticated
   * `/api/v1/market-data/providers` route.
   */
  async function statusSnapshot() {
    const health = await manager.getAllHealth(false, { probe: false });
    return {
      providers: health.map((entry) => ({ name: entry.name, status: entry.status, synthetic: Boolean(entry.synthetic) })),
      registry: registry().map((entry) => ({
        name: entry.name,
        synthetic: entry.synthetic,
        priority: entry.priority,
        marketClasses: entry.capabilities.marketClasses,
        timeframes: entry.capabilities.timeframes,
        delayed: entry.capabilities.delayed,
      })),
      policy: {
        realProviders: settings.realProviders,
        syntheticAllowed: settings.allowSynthetic,
      },
    };
  }

  return { candles, quote, providers, registry, statusSnapshot, manager };
}
