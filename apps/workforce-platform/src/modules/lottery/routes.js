/**
 * Lottery Intelligence API — slice 1 of row 15: the foundation surface.
 *
 * Legacy's `Api_lottery` exposes thirty-odd endpoints over thirteen tables, and its
 * header comment states the authorization matrix this slice reproduces exactly:
 *
 *   - status                authenticated (no secrets or PII in the response);
 *   - reads                 `lottery.view` (draws, statistics, providers, jobs);
 *   - provider probe / sync POST + `lottery.manage` + session CSRF.
 *
 * What is here reads and writes the seven tables migration 016 creates. Every other
 * legacy endpoint — combinations, AI decisions, generation, systems, tickets,
 * backtests, models, performance — reads tables this slice does not create, so none
 * of them is ported, and the status route says so (`notPorted`) rather than leaving
 * the module looking complete (BC-10). A `GET /lottery/generate` that answered from
 * thin air would be the fabrication the platform's rules forbid.
 *
 * Every statistics response is a historical observation carrying the engine's
 * DISCLAIMER; no endpoint claims knowledge of future draws (legacy spec §41).
 */

import { AppError } from "../../http/errors.js";
import { SYNC_LINE_LIMIT } from "./system.js";
import { createAuthenticator, requirePermission } from "../platform/guards.js";
import { userHasPermission } from "../identity/service.js";

const DRAW_PARAMS = Object.freeze({
  drawId: Object.freeze({ type: "integer", required: true, min: 1 }),
});

const DRAWS_QUERY = Object.freeze({
  limit: Object.freeze({ type: "integer", min: 1, max: 100_000 }),
  from: Object.freeze({ type: "string", maxLength: 10 }),
  to: Object.freeze({ type: "string", maxLength: 10 }),
});

const STATISTICS_KINDS = Object.freeze(["numbers", "stars", "hot-cold", "distribution", "pairs", "triplets", "star-pairs"]);

const STATISTICS_PARAMS = Object.freeze({
  kind: Object.freeze({ type: "string", required: true, values: STATISTICS_KINDS }),
});

const STATISTICS_QUERY = Object.freeze({
  window: Object.freeze({ type: "integer", min: 0, max: 10_000 }),
});

const JOBS_QUERY = Object.freeze({
  jobType: Object.freeze({ type: "string", maxLength: 40 }),
  limit: Object.freeze({ type: "integer", min: 1, max: 500 }),
});

const SYNC_BODY = Object.freeze({
  type: "object",
  properties: Object.freeze({
    limit: Object.freeze({ type: "integer", min: 1, max: 1000 }),
  }),
});

const EMPTY_BODY = Object.freeze({ type: "object" });

// ── slice 2 schemas ───────────────────────────────────────────────────────────

const ANALYZE_QUERY = Object.freeze({
  mains: Object.freeze({ type: "string", maxLength: 400 }),
  stars: Object.freeze({ type: "string", maxLength: 100 }),
});

const COMBINATIONS_QUERY = Object.freeze({
  limit: Object.freeze({ type: "integer", min: 0, max: 10_000 }),
  offset: Object.freeze({ type: "integer", min: 0, max: 1_000_000 }),
});

const DECISIONS_QUERY = Object.freeze({
  // Legacy: numeric scalars clamp to 1..200; anything else falls back to 50 —
  // the numeric test happens in the handler so "?limit=abc" is 50, not a 400.
  limit: Object.freeze({ type: "string", maxLength: 16 }),
  combinationId: Object.freeze({ type: "string", maxLength: 16 }),
});

const DECISION_PARAMS = Object.freeze({
  decisionId: Object.freeze({ type: "integer", required: true, min: 1 }),
});

const COMBINATION_PARAMS = Object.freeze({
  combinationId: Object.freeze({ type: "integer", required: true, min: 1 }),
});

const GENERATE_BODY = Object.freeze({
  type: "object",
  properties: Object.freeze({
    mode: Object.freeze({ type: "string", maxLength: 32 }),
    count: Object.freeze({ type: "integer", min: 1, max: 1000 }),
    seed: Object.freeze({ type: "integer", nullable: true, min: -2_147_483_648, max: 2_147_483_647 }),
    // Both are PASSTHROUGHS, not keyed objects: legacy hands `$body['locks']` to the
    // generator unchanged (`is_array` and nothing more), and the generator's
    // `normalizeField` is the only validator, throwing legacy's exact messages that
    // `guarded` translates to a 400. An `{type: "object"}` node with no declared
    // properties keeps only declared keys, so `{mains: [7, 21]}` was being reduced to
    // `{}` — the route accepted a lock and silently generated without it.
    locks: Object.freeze({ type: "object", additionalProperties: true }),
    excludes: Object.freeze({ type: "object", additionalProperties: true }),
    contextLines: Object.freeze({ type: "array" }),
  }),
});

const DIVERSITY_BODY = Object.freeze({
  type: "object",
  properties: Object.freeze({
    lines: Object.freeze({ type: "array" }),
  }),
});

const SYSTEM_BODY = Object.freeze({
  type: "object",
  properties: Object.freeze({
    mains: Object.freeze({ type: "array" }),
    stars: Object.freeze({ type: "array" }),
    page: Object.freeze({ type: "integer", min: 0, max: 1_000_000 }),
    limit: Object.freeze({ type: "integer", min: 1, max: 500 }),
  }),
});

const SYSTEM_BUILD_BODY = Object.freeze({
  type: "object",
  properties: Object.freeze({
    mains: Object.freeze({ type: "array" }),
    stars: Object.freeze({ type: "array" }),
  }),
});

const TICKETS_QUERY = Object.freeze({
  limit: Object.freeze({ type: "integer", min: 1, max: 500 }),
});

const TICKET_PARAMS = Object.freeze({
  ticketId: Object.freeze({ type: "integer", required: true, min: 1 }),
});

// ── slice 4 schemas ───────────────────────────────────────────────────────────

const BACKTEST_BODY = Object.freeze({
  type: "object",
  properties: Object.freeze({
    // Legacy's controller casts with (string)($body['strategy'] ?? 'RANDOM_BASELINE')
    // and the ENGINE refuses an unknown name — the schema stays permissive.
    strategy: Object.freeze({ type: "string", maxLength: 40 }),
    lines: Object.freeze({ type: "integer", nullable: true, min: 0, max: 1_000_000 }),
    window: Object.freeze({ type: "integer", nullable: true, min: 0, max: 1_000_000 }),
  }),
});

const BACKTEST_COMPARE_BODY = Object.freeze({
  type: "object",
  properties: Object.freeze({
    strategies: Object.freeze({ type: "array" }),
    lines: Object.freeze({ type: "integer", nullable: true, min: 0, max: 1_000_000 }),
    window: Object.freeze({ type: "integer", nullable: true, min: 0, max: 1_000_000 }),
  }),
});

const BACKTESTS_QUERY = Object.freeze({
  limit: Object.freeze({ type: "integer", min: 1, max: 500 }),
});

const BACKTEST_PARAMS = Object.freeze({
  backtestId: Object.freeze({ type: "integer", required: true, min: 1 }),
});

const TICKET_BODY = Object.freeze({
  type: "object",
  properties: Object.freeze({
    name: Object.freeze({ type: "string", maxLength: 200 }),
    lines: Object.freeze({ type: "array" }),
    generationMethod: Object.freeze({ type: "string", maxLength: 32 }),
    drawDate: Object.freeze({ type: "string", maxLength: 10, nullable: true }),
    modelVersion: Object.freeze({ type: "string", maxLength: 64, nullable: true }),
    // Free-form caller JSON, stored verbatim (legacy's json_decode'd column) —
    // the validator's declared passthrough keeps its keys intact.
    configuration: Object.freeze({ type: "object", additionalProperties: true }),
  }),
});

/**
 * Turn an engine refusal (legacy `InvalidArgumentException`) into a 400. The
 * analyzer, generator, diversification engine and system builder throw
 * `TypeError` with legacy's exact message; a storage-layer refusal uses the
 * same translation the sports routes justify at length on `guarded` there.
 */
async function guarded(promise) {
  try {
    return await promise;
  } catch (error) {
    if (error instanceof TypeError) {
      throw AppError.badRequest(error.message, { code: "LOTTERY_INVALID_ARGUMENT" });
    }
    throw error;
  }
}

/**
 * @param {import("http").Server} app
 * @param {object} options
 * @param {object} options.config
 * @param {object} options.store
 * @param {object|null} [options.lottery] the lottery service
 */
export function lotteryRoutes(app, { config, store, lottery = null }) {
  const authenticate = createAuthenticator({ store, config });
  const actorOf = (request) => request.auth?.user?.id ?? null;
  const guardFor = (permission) => {
    const guard = requirePermission(permission, config);
    // Set so `/api/v1/system/routes` reports which permission each route needs — the
    // F-02 rule: a route whose guard cannot name its permission looks ungated.
    guard.permission = permission;
    return [authenticate, guard];
  };
  const view = guardFor("lottery.view");
  const manage = guardFor("lottery.manage");
  const authenticated = guardFor("system.authenticated");

  const service = () => {
    if (!lottery) {
      throw new AppError(503, "LOTTERY_SERVICE_UNAVAILABLE", "The lottery service is not configured on this host");
    }
    return lottery;
  };

  /**
   * The module status — the one route legacy left at plain `authenticated`, because
   * it carries no secrets or PII: the active rules, the engine state, the provider's
   * self-reported health and the disclaimer. The `notPorted` matrix travels here so
   * the module's honest boundary is visible from the outside.
   */
  app.get("/lottery/status", { preHandler: authenticated }, async () => service().status());

  // ── reads (lottery.view) ─────────────────────────────────────────────────────

  app.get("/lottery/lotteries", { preHandler: view }, async () => {
    const report = await service().status();
    return { lotteries: report.lotteries };
  });

  app.get("/lottery/rules", { preHandler: view }, async () => {
    const report = await service().status();
    return { rules: report.rules };
  });

  app.get("/lottery/draws", { preHandler: view, querySchema: DRAWS_QUERY }, async (request) => {
    const q = request.query ?? {};
    return { draws: await service().listDraws(q.limit ?? 50, q.from ?? null, q.to ?? null) };
  });

  app.get("/lottery/draws/:drawId", { preHandler: view, paramsSchema: DRAW_PARAMS }, async (request) => {
    const draw = await service().drawDetail(request.params.drawId);
    if (!draw) throw new AppError(404, "LOTTERY_DRAW_NOT_FOUND", "draw not found");
    return { draw };
  });

  /**
   * Statistical intelligence (spec §8–§14) — historical observations carrying the
   * engine DISCLAIMER, never forecasts. An unknown kind is a 400 that names the
   * kinds that exist, exactly as legacy's 400 did.
   */
  app.get("/lottery/statistics/:kind", { preHandler: view, paramsSchema: STATISTICS_PARAMS, querySchema: STATISTICS_QUERY }, async (request) => {
    const { kind } = request.params;
    const window = request.query?.window ?? 0;
    try {
      return { kind, window, data: await service().statistics(kind, window) };
    } catch (error) {
      if (error instanceof RangeError) throw new AppError(400, "LOTTERY_STATISTICS_KIND_UNKNOWN", error.message);
      throw error;
    }
  });

  /**
   * The stored provider registry — which sources have been seen, and whether each
   * is enabled. Read straight from the repository: a registry read must not be able
   * to trigger the facade's lazy-ensure write (LT-4), and this endpoint is a read.
   */
  app.get("/lottery/providers", { preHandler: view }, async () => service().registry());

  /** Provider health (spec §32): live status + persisted checks/sync history, no probe. */
  app.get("/lottery/health", { preHandler: view }, async () => service().providerHealth());

  /** Recent sync runs, newest first — the ingestion evidence the jobs route summarizes. */
  app.get("/lottery/jobs", { preHandler: view, querySchema: JOBS_QUERY }, async (request) => {
    const q = request.query ?? {};
    return { jobs: await store.listLotteryJobRuns(q.jobType ?? null, q.limit ?? 50) };
  });

  // ── combination intelligence (slice 2, lottery.view) ─────────────────────────

  /** Full statistical profile of one line (spec §13) — a historical observation only. */
  app.get("/lottery/analyze", { preHandler: view, querySchema: ANALYZE_QUERY }, async (request) => {
    const q = request.query ?? {};
    const toInts = (raw) => String(raw ?? "").split(",").filter((piece) => piece !== "").map((piece) => Number.parseInt(piece, 10));
    return guarded(service().analyzeLine(toInts(q.mains), toInts(q.stars)));
  });

  /** Persisted generations (spec §14/§16/§33), newest first. */
  app.get("/lottery/combinations", { preHandler: view, querySchema: COMBINATIONS_QUERY }, async (request) => {
    const q = request.query ?? {};
    // Legacy: `(int)($g['limit'] ?: 50)` — an explicit 0 IS the default here.
    return { combinations: await service().listCombinations(q.limit ?? 50, q.offset ?? 0) };
  });

  app.get("/lottery/combinations/:combinationId", { preHandler: view, paramsSchema: COMBINATION_PARAMS }, async (request) => {
    const row = await service().combinationDetail(request.params.combinationId);
    if (!row) throw new AppError(404, "LOTTERY_COMBINATION_NOT_FOUND", "combination not found");
    return { combination: row };
  });

  /** Persisted AI decision reports — the recorded inputs (spec §26/§33). */
  app.get("/lottery/ai-decisions", { preHandler: view, querySchema: DECISIONS_QUERY }, async (request) => {
    const q = request.query ?? {};
    const rawLimit = q.limit ?? 50;
    // Legacy: numeric scalar -> clamp 1..200; anything else -> 50 (NOT a 400).
    const limit = typeof rawLimit === "string" && rawLimit.trim() !== "" && Number.isFinite(Number(rawLimit))
      ? Math.min(200, Math.max(1, Math.trunc(Number(rawLimit))))
      : typeof rawLimit === "number"
        ? Math.min(200, Math.max(1, Math.trunc(rawLimit)))
        : 50;
    let combinationId = null;
    const rawCombination = q.combinationId;
    if (rawCombination !== undefined && rawCombination !== "") {
      if (typeof rawCombination !== "string" && typeof rawCombination !== "number") {
        throw new AppError(400, "LOTTERY_INVALID_ARGUMENT", "combinationId must be a positive integer");
      }
      const parsed = Number(rawCombination);
      if (!Number.isInteger(parsed) || parsed < 1) {
        throw new AppError(400, "LOTTERY_INVALID_ARGUMENT", "combinationId must be a positive integer");
      }
      combinationId = parsed;
    }
    return guarded({ decisions: await service().listDecisions(combinationId, limit), limit, combinationId });
  });

  app.get("/lottery/ai-decisions/:decisionId", { preHandler: view, paramsSchema: DECISION_PARAMS }, async (request) => {
    const row = await service().decisionDetail(request.params.decisionId);
    if (!row) throw new AppError(404, "LOTTERY_DECISION_NOT_FOUND", "AI decision report not found");
    return { decision: row };
  });

  // ── combination writes: POST + CSRF. generate/diversity/system sit behind
  // `lottery.view` exactly as legacy's requirePostPermission('lottery.view')
  // does — they create ANALYSIS RECORDS, not managed ingestion; only the
  // background system build needs `lottery.manage` (it writes job-run rows).

  /** Generate + persist one report: combination row + decision row + audit (spec §14–§17). */
  app.post("/lottery/generate", { preHandler: view, bodySchema: GENERATE_BODY }, async (request) => {
    const body = request.body ?? {};
    return guarded((async () => {
      const report = await service().generate({
        mode: String(body.mode ?? "RANDOM"),
        count: body.count ?? 1,
        seed: body.seed === undefined || body.seed === null ? null : Number(body.seed),
        locks: body.locks && typeof body.locks === "object" ? body.locks : {},
        excludes: body.excludes && typeof body.excludes === "object" ? body.excludes : {},
        contextLines: Array.isArray(body.contextLines) ? body.contextLines : [],
      });
      const saved = await service().saveGeneration(report, String(actorOf(request) ?? "system"));
      return { ...report, saved };
    })());
  });

  /** Diversification score for a posted set of lines (spec §22). Nothing is stored. */
  app.post("/lottery/diversity", { preHandler: view, bodySchema: DIVERSITY_BODY }, async (request) => {
    const body = request.body ?? {};
    return guarded(service().diversity(Array.isArray(body.lines) ? body.lines : []));
  });

  /**
   * The system plan + one paginated window of lines (spec §18/§19). A system
   * above the synchronous limit is a 409 that names the limit and points at
   * the background build, exactly as legacy's controller did.
   */
  app.post("/lottery/system", { preHandler: view, bodySchema: SYSTEM_BODY }, async (request) => {
    const body = request.body ?? {};
    return guarded((async () => {
      const lotteryService = service();
      const plan = await lotteryService.systemPlan(
        Array.isArray(body.mains) ? body.mains : [],
        Array.isArray(body.stars) ? body.stars : [],
      );
      if (plan.requiresBackground) {
        throw new AppError(
          409,
          "LOTTERY_SYSTEM_TOO_LARGE",
          `system has ${plan.totalLines} lines — above the synchronous limit (${SYNC_LINE_LIMIT}); use POST api/lottery/system-build for a background build`,
        );
      }
      const page = Math.max(0, body.page ?? 0);
      const limit = Math.min(500, Math.max(1, body.limit ?? 50));
      const window = await lotteryService.systemPage(plan.mainPool, plan.starPool, page * limit, limit);
      return { plan, page, limit, lines: window };
    })());
  });

  /**
   * The background system build (spec §18): idempotent per pool (execution
   * key). Small systems build inline; large ones queue for the lottery cron —
   * which is slice 3, and the response note says so.
   */
  app.post("/lottery/system-build", { preHandler: manage, bodySchema: SYSTEM_BUILD_BODY }, async (request) => {
    const body = request.body ?? {};
    return guarded(service().buildSystem(
      { mains: Array.isArray(body.mains) ? body.mains : [], stars: Array.isArray(body.stars) ? body.stars : [] },
      String(actorOf(request) ?? "system"),
    ));
  });

  // ── saved tickets (slice 3, lottery.view — records, never purchases) ─────────

  /** The caller's own tickets, newest first (spec §38 — never other users'). */
  app.get("/lottery/tickets", { preHandler: view, querySchema: TICKETS_QUERY }, async (request) => {
    return { tickets: await service().listMyTickets(actorOf(request), request.query?.limit ?? 50) };
  });

  /**
   * Create the caller's own ticket. Every line is validated before anything is
   * stored — one bad line rejects the whole ticket (legacy's contract).
   */
  app.post("/lottery/tickets", { preHandler: view, bodySchema: TICKET_BODY }, async (request) => {
    const body = request.body ?? {};
    // Legacy's controller envelope: the stored row AND its lines, separately.
    const ticket = await guarded(service().createTicket(
      actorOf(request),
      String(body.name ?? ""),
      Array.isArray(body.lines) ? body.lines : [],
      String(body.generationMethod ?? "MANUAL"),
      body.drawDate ?? null,
      body.modelVersion ?? null,
      body.configuration && typeof body.configuration === "object" ? body.configuration : {},
    ));
    return { ticket, lines: ticket.lines };
  });

  /** Ticket detail — own tickets, or an administrator with lottery.manage sees any. */
  app.get("/lottery/tickets/:ticketId", { preHandler: view, paramsSchema: TICKET_PARAMS }, async (request) => {
    const isAdmin = userHasPermission(request.auth?.permissions ?? [], "lottery.manage");
    const ticket = await service().ticketDetail(request.params.ticketId, isAdmin ? null : actorOf(request));
    if (!ticket) throw new AppError(404, "LOTTERY_TICKET_NOT_FOUND", "ticket not found");
    return { ticket };
  });

  /**
   * Compare the ticket against the stored VERIFIED draw (spec §29). A ticket is
   * checkable only by its owner; a draw that has not landed yet is legacy's 409.
   */
  app.post("/lottery/tickets/:ticketId/check", { preHandler: view, bodySchema: EMPTY_BODY, paramsSchema: TICKET_PARAMS }, async (request) => {
    const result = await service().checkTicket(request.params.ticketId, actorOf(request), actorOf(request));
    if (result === null) throw new AppError(404, "LOTTERY_TICKET_NOT_FOUND", "ticket not found");
    if ((result.status ?? "") === "NO_DRAW") {
      throw new AppError(409, "LOTTERY_NO_DRAW_TO_CHECK", "no stored draw to compare yet (sync the provider first)");
    }
    return result;
  });

  /** Archive (soft delete) the caller's own ticket. */
  app.post("/lottery/tickets/:ticketId/delete", { preHandler: view, bodySchema: EMPTY_BODY, paramsSchema: TICKET_PARAMS }, async (request) => {
    const archived = await service().archiveTicket(request.params.ticketId, actorOf(request), actorOf(request));
    if (!archived) throw new AppError(404, "LOTTERY_TICKET_NOT_FOUND", "ticket not found");
    return { archived: request.params.ticketId };
  });

  // ── the measured half (slice 4, lottery.view) ────────────────────────────────
  // Backtests are analysis reads that persist a report row — legacy keeps the
  // whole surface behind lottery.view (like generate/diversity/system, these
  // POSTs are records and analysis, not managed ingestion).

  /**
   * spec §23: HISTORICAL SIMULATION — one strategy replayed over the stored
   * draws without look-ahead. Persisted, audited, model-version stamped.
   */
  app.post("/lottery/backtest", { preHandler: view, bodySchema: BACKTEST_BODY }, async (request) => {
    const body = request.body ?? {};
    return guarded(service().backtest(
      String(body.strategy ?? "RANDOM_BASELINE"),
      // Legacy's `(int)($body['lines'] ?: 1)` — 0/null/missing all become 1.
      body.lines ? Math.trunc(Number(body.lines)) : 1,
      body.window ? Math.trunc(Number(body.window)) : 0,
    ));
  });

  /**
   * spec §24: strategy comparison on the SAME period; the random baseline is
   * mandatory (spec §25) and no strategy is declared "better" (spec §34).
   */
  app.post("/lottery/backtest-compare", { preHandler: view, bodySchema: BACKTEST_COMPARE_BODY }, async (request) => {
    const body = request.body ?? {};
    return guarded(service().backtestCompare(
      Array.isArray(body.strategies) ? body.strategies.map((s) => String(s)) : [],
      // Legacy's `(int)($body['lines'] ?: 1)` — 0/null/missing all become 1.
      body.lines ? Math.trunc(Number(body.lines)) : 1,
      body.window ? Math.trunc(Number(body.window)) : 0,
    ));
  });

  /** Persisted backtests, newest first. GET ?limit=50 */
  app.get("/lottery/backtests", { preHandler: view, querySchema: BACKTESTS_QUERY }, async (request) => {
    return { backtests: await service().listBacktests(request.query?.limit ?? 50) };
  });

  /** One persisted backtest, report decoded. */
  app.get("/lottery/backtests/:backtestId", { preHandler: view, paramsSchema: BACKTEST_PARAMS }, async (request) => {
    const row = await service().backtestDetail(request.params.backtestId);
    if (!row) throw new AppError(404, "LOTTERY_BACKTEST_NOT_FOUND", "backtest not found");
    return { backtest: row };
  });

  /** Model versions (spec §33) — ensured once, never deleted or replaced. */
  app.get("/lottery/models", { preHandler: view }, async () => {
    return { models: await service().modelVersions() };
  });

  /** Performance overview (spec §30) — three separate sections, never mixed. */
  app.get("/lottery/performance", { preHandler: view }, async () => {
    return service().performance();
  });

  // ── writes (lottery.manage + POST + CSRF) ────────────────────────────────────

  /**
   * One explicit, audited live-provider health probe. A probe is outbound I/O, so
   * it is a POST behind `lottery.manage` — never a side effect of a dashboard load
   * (the SP-10 rule legacy's own `probeProvider` already respected: the probe is
   * explicit there too).
   */
  app.post("/lottery/providers/check", { preHandler: manage, bodySchema: EMPTY_BODY }, async (request) => {
    try {
      return await service().probeProvider(actorOf(request));
    } catch (error) {
      // The probe failed to PERSIST. The failure itself is audited, as legacy
      // audited it; the caller gets a 502 and the audit log has the details.
      await store.recordAudit({
        actorId: actorOf(request) ?? null,
        action: "lottery.provider.health.probe.failed",
        entityType: "lottery_data_source",
        entityId: null,
        details: { message: "Lottery provider health probe could not be persisted", errorType: error?.constructor?.name ?? "Error" },
      }).catch(() => {});
      throw new AppError(502, "LOTTERY_PROBE_NOT_PERSISTED", "provider health check could not be saved; inspect the audit log");
    }
  });

  /**
   * Run one provider sync now: fetch → validate → store (idempotent) → health.
   * Audited as an administrator action (`lottery.admin.sync`), because a person
   * asked for it — the cron's syncs, when slice 3 lands, audit their own.
   */
  app.post("/lottery/sync", { preHandler: manage, bodySchema: SYNC_BODY }, async (request) => {
    const limit = Math.min(1000, Math.max(1, request.body?.limit ?? 100));
    try {
      const result = await service().sync(limit);
      await store.recordAudit({
        actorId: actorOf(request) ?? null,
        action: "lottery.admin.sync",
        entityType: "lottery_sync_run",
        entityId: null,
        details: {
          message: `Lottery provider sync requested: ${String(result.status ?? "UNKNOWN")}`,
          provider: String(result.provider ?? ""),
          limit,
          status: String(result.status ?? "UNKNOWN"),
          imported: result.imported ?? 0,
          failed: result.failed ?? 0,
          unchanged: result.unchanged ?? 0,
          conflicts: result.conflicts ?? 0,
        },
      });
      return { result };
    } catch (error) {
      await store.recordAudit({
        actorId: actorOf(request) ?? null,
        action: "lottery.admin.sync.failed",
        entityType: "lottery_sync_run",
        entityId: null,
        details: { message: "Lottery provider sync failed", errorType: error?.constructor?.name ?? "Error" },
      }).catch(() => {});
      throw new AppError(502, "LOTTERY_SYNC_FAILED", "lottery provider sync failed; inspect provider health and audit log");
    }
  });
}
