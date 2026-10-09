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
 */

import { AppError } from "../../http/errors.js";
import { marketDataFailure } from "../market-data/errors.js";
import { createAuthenticator, requireCsrf } from "../platform/guards.js";
import { CONSENSUS_BODY, HISTORY_QUERY, RUN_BODY, RUN_PARAMS, messages } from "./contracts.js";
import { createAnalysisService } from "./service.js";

export function analysisRoutes(app, { store, config, service = null, marketData = null }) {
  const analysis = service || createAnalysisService({ store, marketData, log: app.log });
  const authenticate = createAuthenticator({ store, config });
  // This is the first ported module with an authenticated *unsafe* method, so it is
  // the first to need the CSRF guard explicitly: a cookie session without a
  // matching `x-csrf-token` is refused with 403 before the handler runs. Bearer
  // callers are exempt (the guard checks `request.auth.via`), exactly as in the
  // identity module.
  const csrf = requireCsrf(config);
  const actorOf = (request) => request.auth?.user?.id ?? null;

  /**
   * A full analysis run: candles → agents → consensus → regime → scenarios →
   * setup → risk engine → debate. Expensive by nature (up to eight provider calls
   * for a forex symbol, bounded by the market-data TTL caches) and covered by the
   * global API rate limit.
   */
  app.post("/analysis/run", {
    preHandler: [authenticate, csrf],
    bodySchema: RUN_BODY,
  }, async (request) => {
    try {
      return await analysis.run(request.body, { actorId: actorOf(request) });
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw marketDataFailure(error);
    }
  });

  app.get("/analysis/history", {
    preHandler: [authenticate],
    querySchema: HISTORY_QUERY,
  }, async (request) => analysis.history(request.query));

  app.get("/analysis/agents", {
    preHandler: [authenticate],
  }, async () => analysis.agents());

  app.post("/analysis/consensus", {
    preHandler: [authenticate, csrf],
    bodySchema: CONSENSUS_BODY,
  }, async (request) => {
    try {
      return await analysis.consensus(request.body, { actorId: actorOf(request) });
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw marketDataFailure(error);
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
