/**
 * Portfolio optimization endpoint.
 *
 * Legacy route was `POST /api/portfolio/optimize`
 * (`application/config/routes.php` → `Api_portfolio::optimize`), behind the
 * session-only `Api_controller` and gated on `trading.view`. Both are preserved:
 * a session is required, and so is `trading.view` — which every member role
 * already holds (`MEMBER_PERMISSIONS`), so this is a "signed-in operator" gate
 * rather than an administrative one, exactly as in the legacy app.
 *
 * Divergence **PO-5**: the path moves to `/api/v1/portfolio/optimize` with the rest
 * of the versioned API rather than staying at the unversioned root. No alias is
 * added, because nothing consumes the legacy path yet and an alias would imply
 * otherwise.
 *
 * The response envelope keeps the legacy shape — `{ optimization: {...report} }` —
 * so a client written against the PHP endpoint reads the same key.
 *
 * Cost control (risk R-26). This is the widest single-request fan-out on the
 * platform: up to twelve sequential provider calls, then two iterative solves. It
 * therefore carries its own window limit *and* holds a per-session in-flight slot
 * for its whole duration, on the same reasoning as the analysis and Strategy Lab
 * routes. See `config.rateLimit.portfolioOptimize` and
 * `config.rateLimit.portfolioMaxConcurrentRuns`.
 */

import { AppError } from "../../http/errors.js";
import { marketDataFailure } from "../market-data/errors.js";
import { createAuthenticator, requireCsrf, requirePermission } from "../platform/guards.js";
import { OPTIMIZE_BODY, messages } from "./contracts.js";
import { InvalidOptimizationError, OptimizationUnavailableError } from "./optimizer.js";
import { createPortfolioService } from "./service.js";

/**
 * Per-session in-flight cap on optimization runs (risk R-26).
 *
 * Structurally the same gate the analysis and Strategy Lab routes use, with its own
 * key prefix so a session's analysis slot and its portfolio slot are counted
 * separately — they bound different work and one should not starve the other.
 *
 * Keyed by **session**, not by address: the platform-wide ceiling is per address,
 * and a shared office NAT must not let one colleague's long optimization starve
 * another's.
 *
 * `max < 1` (or no tracker) disables the cap, matching the `MAX_REQUESTS_PER_CLIENT`
 * convention: `0` means "off", never "refuse everything".
 *
 * @param {{tracker?: {acquire: Function, release: Function, count?: Function}|null, max?: number, keyOf?: Function}} [options]
 */
export function createPortfolioRunGate({ tracker = null, max = 0, keyOf = defaultGateKey } = {}) {
  const disabled = !tracker || !Number.isFinite(max) || max < 1;

  return {
    get disabled() {
      return disabled;
    },
    keyOf,
    /**
     * Take a slot. Returns the key that MUST be passed to `release`, or `null` when
     * the cap is disabled (so `release(null)` is a no-op and callers can use a
     * single `try/finally` unconditionally).
     *
     * @throws {AppError} 429 `TOO_MANY_CONCURRENT_OPTIMIZATIONS` when the session
     *   already holds `max` runs. Distinct from `RATE_LIMITED` on purpose: the
     *   remedy is "wait for the run you already started", not "slow down".
     */
    acquire(request) {
      if (disabled) return null;
      const key = keyOf(request);
      if (!tracker.acquire(key, max)) {
        throw new AppError(429, "TOO_MANY_CONCURRENT_OPTIMIZATIONS",
          `At most ${max} portfolio ${max === 1 ? "optimization" : "optimizations"} may be in flight per session — wait for the current one to finish`,
          { retryAfter: 1 });
      }
      return key;
    },
    /** Release a slot. Always safe to call in `finally`, including with `null`. */
    release(key) {
      if (!disabled && key !== null && key !== undefined) tracker.release(key);
    },
    inFlight(request) {
      return disabled || typeof tracker.count !== "function" ? 0 : tracker.count(keyOf(request));
    },
  };
}

function defaultGateKey(request) {
  const actorId = request?.auth?.user?.id ?? null;
  return actorId !== null ? `portfolio:session:${actorId}` : `portfolio:client:${request?.clientAddress ?? "unknown"}`;
}

export function portfolioRoutes(app, { store, config, service = null, marketData = null, concurrency = null }) {
  const portfolio = service || createPortfolioService({ store, marketData, log: app.log });
  const authenticate = createAuthenticator({ store, config });
  // This is an authenticated *unsafe* method, so the CSRF guard applies: a cookie
  // session without a matching `x-csrf-token` is refused with 403 before the handler
  // runs. Bearer callers are exempt, exactly as in the identity and analysis modules.
  const csrf = requireCsrf(config);
  const canViewTrading = requirePermission("trading.view", config);
  canViewTrading.permission = "trading.view";
  const actorOf = (request) => request.auth?.user?.id ?? null;
  const gate = createPortfolioRunGate({
    tracker: concurrency,
    max: config?.rateLimit?.portfolioMaxConcurrentRuns ?? 0,
  });

  /**
   * Run a research-only optimization over a 2–12 asset universe.
   *
   * Error mapping follows the legacy controller's three catches, with one deliberate
   * refinement (**PO-2**): legacy answered 400 for *every* `\InvalidArgumentException`,
   * including the ones raised from inside the estimator when a price series produced
   * a non-finite return. Those are data conditions, not request-shape conditions —
   * the caller cannot fix them by editing the body — so they are a distinct error
   * type here and answer 422, the status the legacy controller already used for its
   * `\RuntimeException` branch (mixed synthetic/live data, all-synthetic without
   * opt-in, provider failure).
   *
   * The slot release sits in `finally`: a run that throws (provider 503, refused
   * synthetic mix, store unavailable) must give its slot back, or a client that hit
   * one error would be locked out of the endpoint until the process restarted.
   */
  app.post("/portfolio/optimize", {
    preHandler: [authenticate, csrf, canViewTrading],
    bodySchema: OPTIMIZE_BODY,
    config: {
      rateLimit: {
        max: config.rateLimit.portfolioOptimize.max,
        windowMs: config.rateLimit.portfolioOptimize.windowMs,
      },
    },
  }, async (request) => {
    const slot = gate.acquire(request);
    try {
      const report = await portfolio.optimize(request.body, {
        actorId: actorOf(request),
        signal: request.signal ?? null,
      });
      return { optimization: report, notice: messages.RESEARCH_ONLY };
    } catch (error) {
      if (error instanceof AppError) throw error;
      if (error instanceof InvalidOptimizationError) {
        throw AppError.badRequest(error.message, { code: "INVALID_PORTFOLIO_REQUEST" });
      }
      if (error instanceof OptimizationUnavailableError) {
        throw new AppError(422, "PORTFOLIO_OPTIMIZATION_UNAVAILABLE", error.message);
      }
      throw marketDataFailure(error);
    } finally {
      gate.release(slot);
    }
  });
}
