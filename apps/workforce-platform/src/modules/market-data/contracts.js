/**
 * Request contracts and messages for the market-data API.
 *
 * The vocabulary mirrors the legacy controller
 * (`application/controllers/Api_marketdata.php`): symbol, timeframe, marketClass
 * and limit are validated the same way, with the same bounds, so the same client
 * queries keep working after cutover. Error strings are the platform's own — the
 * legacy controller echoed raw provider exception text, while the Node platform
 * normalises to an error code with details; that divergence is recorded in
 * `docs/migration/PHASE4_MARKET_DATA.md`.
 *
 * Schemas use the platform's flat field dialect (see `src/http/validate.js`),
 * which rejects any query parameter not declared here.
 */

import { MARKET_CLASSES, TIMEFRAMES, inferMarketClass } from "./timeframes.js";

export { MARKET_CLASSES, TIMEFRAMES, inferMarketClass };

/** Legacy bounds: timeframe ∈ 1m,5m,15m,1h,4h,1d; limit clamped 30–5000. */
export const CANDLE_QUERY = Object.freeze({
  symbol: { type: "string", required: true, minLength: 2, maxLength: 24 },
  timeframe: { type: "string", required: true, values: [...TIMEFRAMES] },
  marketClass: { type: "string", nullable: true, values: [...MARKET_CLASSES] },
  limit: { type: "integer", min: 30, max: 5_000, default: 200 },
});

export const QUOTE_QUERY = Object.freeze({
  symbol: { type: "string", required: true, minLength: 2, maxLength: 24 },
});

export const PROVIDERS_QUERY = Object.freeze({
  refresh: { type: "boolean", default: true },
});

export const messages = Object.freeze({
  SYMBOL_REQUIRED: "A symbol of at least 2 characters is required.",
  PROVIDER_UNAVAILABLE: "No market-data provider could serve this request.",
  SYNTHETIC_REFUSED: "No real provider could serve this request and synthetic data is disabled on this host.",
});
