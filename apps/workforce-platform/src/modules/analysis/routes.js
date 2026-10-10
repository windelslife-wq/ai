/**
 * Analysis API endpoints.
 *
 * Legacy routes were `api/analysis/run`, `api/analysis/history`,
 * `api/analysis/(:any)`, `api/agents` and `api/agents/consensus`, all behind the
 * session-only `Api_controller` (none of them is in its PUBLIC_ACTIONS list) and
 * none of them permission-gated — any signed-in role could run an analysis. That
 * is preserved: every route here requires a session and no permission.
 *
 * The two agent routes moved under `/analysis/` so the whole module lives behind
 * one prefix (`/api/v1/analysis/agents`, `/api/v1/analysis/consensus`); the legacy
 * paths sat at the API root next to unrelated endpoints. Recorded as a divergence
 * in `docs/migration/PHASE5_ANALYSIS.md`, along with the redirect-free decision:
 * nothing consumes those paths yet, so no alias is added to imply otherwise.
 *
 * Static paths are registered before `/analysis/:runId` — the router matches in
 * registration order, so a literal `agents` segment must win over a parameter.
 *
 * Cost control (risk R-26). This is the most expensive authenticated surface on
 * the platform: one run fetches up to eight upstream series — a forex or commodity
 * run also pulls seven reference legs — and one consensus scan is up to ten runs,
 * so a ten-symbol scan can fan out into roughly eighty provider calls. The global
 * API limiter bounds *requests*, not *work*, so the two POST routes carry their own
 * window limits, and both hold a slot in a per-session in-flight cap. See
 * `createAnalysisRunGate` and `config.rateLimit.analysis*`.
 */

import { AppError } from "../../http/errors.js";
import { marketDataFailure } from "../market-data/errors.js";
import { createAuthenticator, requireCsrf } from "../platform/guards.js";
import { CONSENSUS_BODY, HISTORY_QUERY, RUN_BODY, RUN_PARAMS, messages } from "./contracts.js";
import { createAnalysisService } from "./service.js";

/**
 * Per-session in-flight cap on analysis runs (risk R-26).
 *
 * The window limits answer "how often"; this answers "how many at once". A scan of
 * ten symbols holds one slot for as long as ten runs would, so capping concurrency
 * is what actually bounds the upstream fan-out a single session can hold open.
 *
 * Keyed by **session**, not by address: the platform-wide ceiling in `app.js`
 * (`MAX_REQUESTS_PER_CLIENT`) is per address, and a shared office NAT must not let
 * one colleague's long scan starve another's — the same reasoning that keeps login
 * lockout keyed per account. Unauthenticated requests never reach this gate (both
 * POST routes run `authenticate` first), but the address fallback keeps the key
 * total if that ever changes.
 *
 * `max < 1` (or no tracker) disables the cap, matching the `MAX_REQUESTS_PER_CLIENT`
 * convention: `0` means "off", never "refuse everything".
 *
 * @param {{tracker?: {acquire: Function, release: Function, count?: Function}|null, max?: number, keyOf?: Function}} [options]
 */
export function createAnalysisRunGate({ tracker = null, max = 0, keyOf = defaultGateKey } = {}) {
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
     * @throws {AppError} 429 `TOO_MANY_CONCURRENT_ANALYSES` when the session already
     *   holds `max` runs. Distinct from `RATE_LIMITED` on purpose: the remedy is
     *   "wait for the run you already started", not "slow down your request rate".
     */
    acquire(request) {
      if (disabled) return null;
      const key = keyOf(request);
      if (!tracker.acquire(key, max)) {
        throw new AppError(429, "TOO_MANY_CONCURRENT_ANALYSES",
          `At most ${max} analysis ${max === 1 ? "run" : "runs"} may be in flight per session — wait for the current one to finish`,
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
  return actorId !== null ? `analysis:session:${actorId}` : `analysis:client:${request?.clientAddress ?? "unknown"}`;
}

export function analysisRoutes(app, { store, config, service = null, marketData = null, concurrency = null }) {
  const analysis = service || createAnalysisService({ store, marketData, log: app.log });
  const authenticate = createAuthenticator({ store, config });
  // This is the first ported module with an authenticated *unsafe* method, so it is
  // the first to need the CSRF guard explicitly: a cookie session without a
  // matching `x-csrf-token` is refused with 403 before the handler runs. Bearer
  // callers are exempt (the guard checks `request.auth.via`), exactly as in the
  // identity module.
  const csrf = requireCsrf(config);
  const actorOf = (request) => request.auth?.user?.id ?? null;
  const gate = createAnalysisRunGate({
    tracker: concurrency,
    max: config?.rateLimit?.analysisMaxConcurrentRuns ?? 0,
  });

  /**
   * A full analysis run: candles → agents → consensus → regime → scenarios →
   * setup → risk engine → debate. Expensive by nature — up to eight provider calls
   * for a forex symbol — so it carries its own window limit (charged per address,
   * before validation, exactly like the login routes) and holds a per-session
   * concurrency slot for as long as it runs.
   *
   * The release sits in `finally`: a run that throws (provider 503, risk veto,
   * store unavailable) must give its slot back, or a client that hit one error
   * would be locked out of the endpoint until the process restarted.
   */
  app.post("/analysis/run", {
    preHandler: [authenticate, csrf],
    bodySchema: RUN_BODY,
    config: { rateLimit: { max: config.rateLimit.analysisRun.max, windowMs: config.rateLimit.analysisRun.windowMs } },
  }, async (request) => {
    const slot = gate.acquire(request);
    try {
      return await analysis.run(request.body, { actorId: actorOf(request) });
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw marketDataFailure(error);
    } finally {
      gate.release(slot);
    }
  });

  app.get("/analysis/history", {
    preHandler: [authenticate],
    querySchema: HISTORY_QUERY,
  }, async (request) => analysis.history(request.query));

  app.get("/analysis/agents", {
    preHandler: [authenticate],
  }, async () => analysis.agents());

  // A scan is up to ten runs, so it gets the tighter window and holds one
  // concurrency slot for its whole duration rather than ten.
  app.post("/analysis/consensus", {
    preHandler: [authenticate, csrf],
    bodySchema: CONSENSUS_BODY,
    config: { rateLimit: { max: config.rateLimit.analysisConsensus.max, windowMs: config.rateLimit.analysisConsensus.windowMs } },
  }, async (request) => {
    const slot = gate.acquire(request);
    try {
      return await analysis.consensus(request.body, { actorId: actorOf(request) });
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw marketDataFailure(error);
    } finally {
      gate.release(slot);
    }
  });

  app.get("/analysis/:runId", {
    preHandler: [authenticate],
    paramsSchema: RUN_PARAMS,
  }, async (request) => {
    const run = await analysis.find(request.params.runId);
    if (!run) throw AppError.notFound(messages.RUN_NOT_FOUND, { code: "ANALYSIS_RUN_NOT_FOUND" });
    return run;
  });
}
