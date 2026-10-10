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
import { CANDLE_QUERY, PROVIDERS_QUERY, QUOTE_QUERY } from "./contracts.js";
import { marketDataFailure } from "./errors.js";
import { createMarketDataService } from "./service.js";

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
      throw marketDataFailure(error);
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
      throw marketDataFailure(error);
    }
  });

  app.get("/market-data/providers", {
    preHandler: [authenticate],
    querySchema: PROVIDERS_QUERY,
  }, async (request) => marketData.providers(request.query.refresh !== false));
}
