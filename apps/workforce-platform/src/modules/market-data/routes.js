/**
 * Market-data API endpoints.
 *
 * Legacy routes were `api/market-data/{candles,quote,providers}` behind the
 * session-only `Api_controller` (they are not in its PUBLIC_ACTIONS list), so all
 * three require an authenticated session here too — and no permission, because
 * market data is readable by every signed-in role in the legacy platform.
 *
 * Response shape follows the legacy payload (`symbol`, `marketClass`, `timeframe`,
 * `candles`, `provenance`, `validation`) with additive fields only. Errors use the
 * platform envelope: a provider failure is a dependency outage → 503 + Retry-After
 * (legacy answered 502 with a bare `{error}`; recorded as a divergence).
 */

import { AppError } from "../../http/errors.js";
import { createAuthenticator } from "../platform/guards.js";
import { CANDLE_QUERY, PROVIDERS_QUERY, QUOTE_QUERY, messages } from "./contracts.js";
import { createMarketDataService } from "./service.js";

const RETRY_AFTER_SECONDS = 30;

function providerFailure(error) {
  const failed = Array.isArray(error?.failedProviders) ? error.failedProviders : [];
  const syntheticRefused = /synthetic data is refused/i.test(String(error?.message || ""));
  return new AppError(
    503,
    syntheticRefused ? "SYNTHETIC_DATA_DISABLED" : "MARKET_DATA_UNAVAILABLE",
    syntheticRefused ? messages.SYNTHETIC_REFUSED : messages.PROVIDER_UNAVAILABLE,
    {
      details: {
        failedProviders: failed,
        syntheticAllowed: !syntheticRefused,
        // The provider's own words are the useful part of this failure: "Invalid
        // symbol." beats a generic outage message when a caller typo'd a ticker.
        reason: String(error?.message || error).slice(0, 240),
      },
      retryAfter: RETRY_AFTER_SECONDS,
    },
  );
}

export function marketDataRoutes(app, { store, config, service = null }) {
  const marketData = service || createMarketDataService({ config, store, log: app.log });
  const authenticate = createAuthenticator({ store, config });

  app.get("/market-data/candles", {
    preHandler: [authenticate],
    querySchema: CANDLE_QUERY,
  }, async (request) => {
    try {
      return await marketData.candles(request.query);
    } catch (error) {
      if (error instanceof AppError) throw error;
      if (error?.statusCode === 400) throw AppError.badRequest(String(error.message));
      throw providerFailure(error);
    }
  });

  app.get("/market-data/quote", {
    preHandler: [authenticate],
    querySchema: QUOTE_QUERY,
  }, async (request) => {
    try {
      return await marketData.quote(request.query);
    } catch (error) {
      if (error instanceof AppError) throw error;
      if (error?.statusCode === 400) throw AppError.badRequest(String(error.message));
      throw providerFailure(error);
    }
  });

  app.get("/market-data/providers", {
    preHandler: [authenticate],
    querySchema: PROVIDERS_QUERY,
  }, async (request) => marketData.providers(request.query.refresh !== false));
}
