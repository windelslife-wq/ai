/**
 * Strategy Lab API endpoints.
 *
 * Legacy routes were `api/strategies`, `api/strategies/(:any)`,
 * `api/strategies/(:any)/status`, `api/strategies/(:any)/optimize`,
 * `api/backtesting/run`, `api/backtesting/results` and
 * `api/backtesting/results/(:any)`, all behind the session-only `Api_controller`
 * (none is in its PUBLIC_ACTIONS list) and none permission-gated — any signed-in
 * role could run a backtest or promote a strategy. That is preserved: every route
 * here requires a session and no permission.
 *
 * Two divergences from the legacy route table, both recorded in
 * `docs/migration/PHASE6_STRATEGIES.md`:
 *
 *  - `POST /strategies/:id/status` only. CodeIgniter routes are method-agnostic,
 *    so `ROUTE_MAP.md` §7.4 lists this path as `GET/POST`, but `status()` reads a
 *    JSON body and a GET therefore always produced a 400 ("body must be {to:
 *    stage, reason?, version?}"). There was no GET behaviour to preserve, and the
 *    current lifecycle plus `nextStage` are already on `GET /strategies/:id`, so a
 *    read-only status route would duplicate it.
 *  - `optimize` takes the strategy id from the path only. The legacy accepted it
 *    from the path OR the body (`if ($strategyId !== '') $body['strategyId'] =
 *    $strategyId`), which let two callers disagree about which strategy was
 *    optimized. One source of truth is the path.
 *
 * The journal and its analytics are served from here too, because they are one
 * bounded context: backtests WRITE journal rows and the analytics READ them. That
 * is the "model/decision analytics and calibration" half of row 8 in
 * `docs/migration/UNFINISHED_MODULES.md`, ported from
 * `application/libraries/Aegis/Journal/Analytics.php` and `Api_journal.php`.
 *
 * Static paths are registered before parameterised ones — the router matches in
 * registration order, so `/backtesting/results` must win over
 * `/backtesting/results/:backtestId`.
 *
 * Cost control (risk R-26, applied to this module at birth rather than as a later
 * finding). A backtest fetches up to 5 000 candles and simulates every bar. An
 * optimization is far heavier: it re-runs the backtester once per grid
 * combination and once per walk-forward segment, so a trend-following search is
 * 24 combinations × 2 segments plus the baseline ≈ 50 simulations. The global API
 * limiter bounds *requests*, not *work*, so both POST routes carry their own
 * window limits and both hold a slot in a per-session in-flight cap.
 */

import { AppError } from "../../http/errors.js";
import { createAuthenticator, requireCsrf } from "../platform/guards.js";
import {
  BACKTEST_BODY,
  BACKTEST_PARAMS,
  JOURNAL_QUERY,
  MANUAL_JOURNAL_BODY,
  OPTIMIZE_BODY,
  RESULTS_QUERY,
  SHOW_QUERY,
  STATUS_BODY,
  STRATEGY_PARAMS,
  SUMMARY_QUERY,
  messages,
} from "./contracts.js";
import { createStrategiesService } from "./service.js";

/**
 * Per-session in-flight cap on backtests and optimizations (risk R-26).
 *
 * The window limits answer "how often"; this answers "how many at once". An
 * optimization holds a slot for as long as ~50 simulations, so capping
 * concurrency is what actually bounds the CPU one session can occupy on shared
 * hosting — a window limit alone would permit several of them to overlap.
 *
 * Keyed by **session**, not by address, and prefixed `strategies:` so it shares
 * the app-wide tracker with the analysis module's `analysis:` slots without
 * colliding with them. A shared office NAT must not let one colleague's long
 * optimization starve another's, which is the same reasoning that keeps login
 * lockout keyed per account.
 *
 * `max < 1` (or no tracker) disables the cap, matching the
 * `MAX_REQUESTS_PER_CLIENT` convention: `0` means "off", never "refuse
 * everything".
 *
 * @param {{tracker?: {acquire: Function, release: Function, count?: Function}|null, max?: number, keyOf?: Function}} [options]
 */
export function createStrategyRunGate({ tracker = null, max = 0, keyOf = defaultGateKey } = {}) {
  const disabled = !tracker || !Number.isFinite(max) || max < 1;

  return {
    get disabled() {
      return disabled;
    },
    keyOf,
    /**
     * Take a slot. Returns the key that MUST be passed to `release`, or `null`
     * when the cap is disabled (so `release(null)` is a no-op and callers can use
     * a single `try/finally` unconditionally).
     *
     * @throws {AppError} 429 `TOO_MANY_CONCURRENT_STRATEGY_RUNS` when the session
     *   already holds `max` runs. Distinct from `RATE_LIMITED` on purpose: the
     *   remedy is "wait for the run you already started", not "slow down".
     */
    acquire(request) {
      if (disabled) return null;
      const key = keyOf(request);
      if (!tracker.acquire(key, max)) {
        throw new AppError(429, "TOO_MANY_CONCURRENT_STRATEGY_RUNS",
          `At most ${max} strategy ${max === 1 ? "job" : "jobs"} may be in flight per session — wait for the current one to finish`,
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
  return actorId !== null
    ? `strategies:session:${actorId}`
    : `strategies:client:${request?.clientAddress ?? "unknown"}`;
}

export function strategyRoutes(app, { store, config, service = null, marketData = null, concurrency = null }) {
  const strategies = service || createStrategiesService({ store, marketData, log: app.log });
  const authenticate = createAuthenticator({ store, config });
  // Every mutating route is cookie-reachable, so each carries the CSRF guard: a
  // session cookie without a matching `x-csrf-token` is refused with 403 before
  // the handler runs. Bearer callers are exempt (the guard checks
  // `request.auth.via`), exactly as in the identity and analysis modules.
  const csrf = requireCsrf(config);
  const actorOf = (request) => request.auth?.user?.id ?? null;
  const gate = createStrategyRunGate({
    tracker: concurrency,
    max: config?.rateLimit?.strategyMaxConcurrentRuns ?? 0,
  });

  /**
   * Map an engine failure onto HTTP, or let the router answer 500.
   *
   * `toHttpError` returns `null` for a fault that is ours rather than the
   * caller's or a provider's; rethrowing the ORIGINAL error in that case keeps the
   * stack the router logs, which is the only thing an operator has to go on.
   */
  function rethrow(error) {
    throw strategies.toHttpError(error) ?? error;
  }

  app.get("/strategies", {
    preHandler: [authenticate],
  }, async () => strategies.list());

  app.get("/strategies/:strategyId", {
    preHandler: [authenticate],
    paramsSchema: STRATEGY_PARAMS,
    querySchema: SHOW_QUERY,
  }, async (request) => {
    const strategy = await strategies.show(request.params.strategyId, request.query.version ?? "");
    if (!strategy) {
      throw AppError.notFound(messages.STRATEGY_NOT_FOUND(request.params.strategyId), { code: "STRATEGY_NOT_FOUND" });
    }
    return strategy;
  });

  /**
   * Advance or retire a strategy through its evidence-gated lifecycle.
   *
   * A refusal is a 409 carrying `reasons` and `warnings` in `details`, matching
   * the legacy response body: the request was understood and the current state
   * forbids it, which is a conflict rather than a validation error. Cheap enough
   * (one read, one write, one audit row) that the global limiter covers it.
   */
  app.post("/strategies/:strategyId/status", {
    preHandler: [authenticate, csrf],
    paramsSchema: STRATEGY_PARAMS,
    bodySchema: STATUS_BODY,
  }, async (request) =>
    strategies.transition(request.params.strategyId, request.body, { actorId: actorOf(request) }));

  /**
   * Walk-forward parameter search. The heaviest route on the platform: up to ~50
   * backtests per call, so it gets the tighter window limit and holds a
   * concurrency slot for its whole duration.
   */
  app.post("/strategies/:strategyId/optimize", {
    preHandler: [authenticate, csrf],
    paramsSchema: STRATEGY_PARAMS,
    bodySchema: OPTIMIZE_BODY,
    config: {
      rateLimit: {
        max: config.rateLimit.strategyOptimize.max,
        windowMs: config.rateLimit.strategyOptimize.windowMs,
      },
    },
  }, async (request) => {
    const slot = gate.acquire(request);
    try {
      return await strategies.optimizeStrategy(
        { ...request.body, strategyId: request.params.strategyId },
        { actorId: actorOf(request) },
      );
    } catch (error) {
      rethrow(error);
    } finally {
      gate.release(slot);
    }
  });

  /**
   * Run a backtest and persist it as lifecycle evidence.
   *
   * The release sits in `finally`: a run that throws (provider 503, too few
   * candles, a strategy bug that trips the look-ahead guard) must give its slot
   * back, or a client that hit one error would be locked out of the endpoint
   * until the process restarted.
   */
  app.post("/backtesting/run", {
    preHandler: [authenticate, csrf],
    bodySchema: BACKTEST_BODY,
    config: {
      rateLimit: {
        max: config.rateLimit.strategyBacktest.max,
        windowMs: config.rateLimit.strategyBacktest.windowMs,
      },
    },
  }, async (request) => {
    const slot = gate.acquire(request);
    try {
      return await strategies.runBacktest(request.body, { actorId: actorOf(request) });
    } catch (error) {
      rethrow(error);
    } finally {
      gate.release(slot);
    }
  });

  app.get("/backtesting/results", {
    preHandler: [authenticate],
    querySchema: RESULTS_QUERY,
  }, async (request) => strategies.results(request.query));

  app.get("/backtesting/results/:backtestId", {
    preHandler: [authenticate],
    paramsSchema: BACKTEST_PARAMS,
  }, async (request) => {
    const record = await strategies.result(request.params.backtestId);
    if (!record) throw AppError.notFound(messages.BACKTEST_NOT_FOUND, { code: "BACKTEST_NOT_FOUND" });
    return record;
  });

  // ---- journal and model/decision analytics -------------------------------
  //
  // Legacy served these at `api/journal`, `api/journal/manual`,
  // `api/analytics/summary` and `api/analytics/confidence-calibration`. The two
  // analytics paths are grouped under `/journal/` here, for two reasons. The
  // practical one: `api/v1/analytics/*` would sit two letters away from Phase 5's
  // `api/v1/analysis/*`, and an operator reaching for the wrong one is a real
  // hazard rather than a theoretical one. The structural one: these endpoints read
  // the journal, which is this module's table, so the module lives behind one
  // prefix — the same call the analysis module made when it moved `api/agents`
  // under `/analysis/`. No alias is added, because nothing consumes these paths
  // yet and an alias would imply a compatibility promise nobody asked for.
  // Recorded as a divergence in docs/migration/PHASE6_STRATEGIES.md.
  //
  // None of these carries its own window limit: they are a bounded read plus an
  // O(n) in-memory grouping over at most 2 000 rows, which is nothing beside one
  // backtest, so the global API limiter is the right bound and a second one would
  // only be noise.

  app.get("/journal", {
    preHandler: [authenticate],
    querySchema: JOURNAL_QUERY,
  }, async (request) => strategies.journal(request.query));

  /**
   * Record a trade by hand. 201, as the legacy handler answered, because it
   * creates a row and returns it.
   */
  app.post("/journal/manual", {
    preHandler: [authenticate, csrf],
    bodySchema: MANUAL_JOURNAL_BODY,
  }, async (request, reply) =>
    reply.code(201).send(await strategies.recordManualEntry(request.body, { actorId: actorOf(request) })));

  app.get("/journal/analytics/summary", {
    preHandler: [authenticate],
    querySchema: SUMMARY_QUERY,
  }, async (request) => strategies.summary(request.query));

  app.get("/journal/analytics/calibration", {
    preHandler: [authenticate],
  }, async () => strategies.confidenceCalibration());
}
