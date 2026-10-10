/**
 * Error mapping shared by every module that consumes market data.
 *
 * Extracted from `market-data/routes.js` when the analysis module needed the same
 * mapping (Phase 5): a provider outage must read identically whether the caller
 * asked for candles or for an analysis run built from candles. Duplicating the
 * logic is how two endpoints drift into reporting the same outage differently.
 *
 * The legacy platform answered a provider failure with `502` and a bare
 * `{error: "…"}`. This platform answers `503` with the standard envelope plus a
 * positive `Retry-After`, because the failure is a dependency outage the caller
 * can retry — recorded as a divergence in `docs/migration/PHASE4_MARKET_DATA.md`.
 */

import { AppError } from "../../http/errors.js";
import { messages } from "./contracts.js";

export const MARKET_DATA_RETRY_AFTER_SECONDS = 30;

/** True when the error came from the provider chain rather than from our code. */
export function isProviderFailure(error) {
  if (error instanceof AppError) return false;
  if (error?.statusCode === 400) return false;
  return Array.isArray(error?.failedProviders) || /synthetic data is refused/i.test(String(error?.message || ""));
}

/**
 * @returns {AppError} 503 with the provider's own reason in `details`, so a typo'd
 *   ticker surfaces as "Invalid symbol." rather than a generic outage.
 */
export function marketDataFailure(error) {
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
        reason: String(error?.message || error).slice(0, 240),
      },
      retryAfter: MARKET_DATA_RETRY_AFTER_SECONDS,
    },
  );
}
