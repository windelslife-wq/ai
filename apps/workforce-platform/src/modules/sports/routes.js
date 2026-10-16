/**
 * Sports Intelligence API — slice 1 of row 14: provider status and the honesty matrix.
 *
 * **One route, and it is a read.** Legacy's `Api_sports` exposes twenty-odd
 * endpoints across matches, odds, predictions, tickets, results, models,
 * calibrations, backtests, jobs, configuration and monitoring. Every one of them
 * reads from or writes to the eleven tables this slice does not create, so none of
 * them is ported. Shipping a `GET /api/v1/sports/matches` that answered from a live
 * provider call instead of stored history would return a different thing under the
 * same name — and the name is what an operator and the SPA both rely on.
 *
 * **Authorization is not a divergence here, and that is worth recording.**
 * `Api_sports` is the best-gated controller in the legacy application: every read
 * requires `sports.view`, every write requires `sports.manage`, and approval and
 * settlement have their own `sports.approve` and `sports.settle`. This route
 * requires `sports.view` because legacy did, not because a finding forced it. The
 * contrast with `Api_system` (**F-32**) is the point: the same codebase gated one
 * module's reads correctly and left another's open, so "legacy did it this way" is
 * evidence about a controller, never about the application.
 *
 * Since no domain module has a sports console screen (**F-29**), the list of what is
 * *not* ported travels in the response — the same decision as BC-10 in the broker
 * port. The shell's other consoles cover portfolio optimisation, the lottery and
 * strategies — not sports (**F-29**) — so a module that reported only what it has
 * would still look complete.
 */

import { AppError } from "../../http/errors.js";
import { createAuthenticator, requirePermission } from "../platform/guards.js";
import {
  BOOLEAN_FIELDS,
  CORRELATION_LIMITS,
  ENGINE_MODES,
  LIST_FIELDS,
  NUMBER_FIELDS,
  PLATFORM_MODES,
  RISK_LEVELS,
  VOID_POLICIES,
} from "./configuration.js";

/**
 * The status route's query contract.
 *
 * Declaring it is not optional decoration: `validateRequest` rebuilds
 * `request.query` from the schema, so **an undeclared parameter is dropped rather
 * than passed through**. Without this, `?probe=1` never reached the handler and the
 * route silently always took the cheap reading — a flag that looks settable and is
 * not read, which is the shape F-30 and D-21 both describe.
 *
 * A boolean, matching `PROVIDERS_QUERY.refresh` in the market-data module. The
 * validator's query-string coercion already accepts `1`/`true`/`yes` and
 * `0`/`false`/`no` **case-insensitively** and rejects anything else, so there is no
 * spelling to enumerate here and nothing for the handler to parse.
 *
 * The first version of this schema was a string with a hand-written value list. It
 * worked, and it was wrong: it duplicated a coercion rule the platform already has,
 * and it disagreed with that rule — `?probe=YES` was refused here and accepted by
 * every other boolean query flag on the platform. Two sources of truth for one
 * convention is how a codebase ends up with flags that behave differently depending
 * on which module you are calling.
 */
const STATUS_QUERY = Object.freeze({
  probe: Object.freeze({ type: "boolean", default: false }),
});

/**
 * The stored-read and ingestion contracts (slice 2).
 *
 * Every one is declared rather than read ad hoc, for the reason D-24 made concrete:
 * `validateRequest` rebuilds `request.query` from the schema, so an undeclared
 * parameter is dropped. A filter that is silently ignored returns the whole table and
 * looks like a filter that matched everything.
 *
 * Bounds are declared here AND re-asserted in the repository. The duplication is not
 * accidental: a route is one caller of many, and the repository's own bounds are what
 * keep a scheduled job or a future console from asking for a million rows.
 */

/** `wf_sports_data_sources.provider_code` is VARCHAR(64). */
const PROVIDER_CODE_PARAMS = Object.freeze({
  providerCode: Object.freeze({ type: "string", required: true, minLength: 1, maxLength: 64 }),
});

/** `wf_sports_matches.id` is BIGINT UNSIGNED. */
const MATCH_PARAMS = Object.freeze({
  matchId: Object.freeze({ type: "integer", required: true, min: 1 }),
});

const PROVIDERS_QUERY = Object.freeze({
  // A boolean, not a string enum: the validator already coerces `1`/`true`/`yes` and
  // `0`/`false`/`no` case-insensitively. D-26 is the record of what happens when a
  // module hand-rolls its own spelling of that convention instead.
  enabledOnly: Object.freeze({ type: "boolean", default: false }),
});

const HEALTH_QUERY = Object.freeze({
  limit: Object.freeze({ type: "integer", default: 20, min: 1, max: 200 }),
});

const MATCHES_QUERY = Object.freeze({
  status: Object.freeze({ type: "string", values: ["SCHEDULED", "LIVE", "FINISHED", "POSTPONED", "CANCELLED", "SUSPENDED"] }),
  // Instants, validated as text here and parsed strictly by the repository. Declaring
  // them at all is what makes `?from=12345` a 400 rather than an empty window that
  // looks like a working filter — defect D-12, which is exactly that mistake.
  from: Object.freeze({ type: "string", maxLength: 32 }),
  to: Object.freeze({ type: "string", maxLength: 32 }),
  competition: Object.freeze({ type: "string", maxLength: 160 }),
  providerId: Object.freeze({ type: "integer", min: 1 }),
  limit: Object.freeze({ type: "integer", default: 50, min: 1, max: 200 }),
  oddsLimit: Object.freeze({ type: "integer", default: 50, min: 1, max: 500 }),
});

const SYNC_RUNS_QUERY = Object.freeze({
  providerId: Object.freeze({ type: "integer", min: 1 }),
  jobType: Object.freeze({ type: "string", values: ["FIXTURES", "ODDS", "RESULTS"] }),
  status: Object.freeze({ type: "string", values: ["RUNNING", "COMPLETED", "FAILED", "DUPLICATE_SKIPPED"] }),
  limit: Object.freeze({ type: "integer", default: 20, min: 1, max: 200 }),
});

const SYNC_BODY = Object.freeze({
  type: "object",
  required: ["jobType", "providerId", "executionKey"],
  properties: Object.freeze({
    jobType: Object.freeze({ type: "string", required: true, values: ["FIXTURES", "ODDS", "RESULTS"] }),
    // The provider's registered id, not its numeric row id: a caller names the vendor
    // it configured, and the registry row is looked up. Asking for a number here would
    // make the caller depend on an insertion order it cannot see.
    providerId: Object.freeze({ type: "string", required: true, minLength: 1, maxLength: 64 }),
    /**
     * The idempotency key, and the reason this route can be retried.
     *
     * Required from the CALLER rather than generated here, because a key the server
     * invented would be different on every retry and would guarantee nothing. Legacy
     * composes one from the job type and the window; a caller here supplies its own,
     * which keeps the guarantee where the retry decision is made.
     */
    executionKey: Object.freeze({ type: "string", required: true, minLength: 1, maxLength: 128 }),
    fixtureExternalId: Object.freeze({ type: "string", maxLength: 128 }),
    query: Object.freeze({ type: "object" }),
  }),
});

// ── decision-chain schemas (slice 3) ─────────────────────────────────────────

const CALIBRATION_PARAMS = Object.freeze({
  calibrationId: Object.freeze({ type: "integer", required: true, min: 1 }),
});

const PREDICTION_PARAMS = Object.freeze({
  predictionId: Object.freeze({ type: "string", required: true, minLength: 1, maxLength: 40 }),
});

const LIMIT_QUERY = Object.freeze({
  limit: Object.freeze({ type: "integer", default: 50, min: 1, max: 200 }),
});

const WINDOW_QUERY = Object.freeze({
  windowDays: Object.freeze({ type: "integer", default: 90, min: 1, max: 3650 }),
});

// Literal lists, matching `CALIBRATION_STATUSES` and `PREDICTION_DECISIONS` in
// `persistence/sports-rows.js`. The repository checks them again, so a drift would fail
// closed rather than silently match nothing.
const CALIBRATIONS_QUERY = Object.freeze({
  status: Object.freeze({ type: "string", values: ["PENDING", "APPROVED", "REJECTED"] }),
  modelVersionId: Object.freeze({ type: "integer", min: 1 }),
  limit: Object.freeze({ type: "integer", default: 50, min: 1, max: 200 }),
});

// ── ticket schemas (slice 4) ─────────────────────────────────────────────────

const TICKET_APPROVALS = ["PENDING_USER_APPROVAL", "APPROVED_NOT_EXECUTED", "REJECTED"];

const TICKET_PARAMS = Object.freeze({
  ticketId: Object.freeze({ type: "string", required: true, minLength: 1, maxLength: 40 }),
});

const TICKETS_QUERY = Object.freeze({
  approvalStatus: Object.freeze({ type: "string", values: TICKET_APPROVALS }),
  runDate: Object.freeze({ type: "string", maxLength: 10 }),
  limit: Object.freeze({ type: "integer", default: 50, min: 1, max: 200 }),
});

const DAILY_RUNS_QUERY = Object.freeze({
  limit: Object.freeze({ type: "integer", default: 50, min: 1, max: 200 }),
});

const DAILY_RUN_BODY = Object.freeze({
  type: "object",
  properties: Object.freeze({
    // The UTC day to generate for. Omitted means today (UTC), as legacy's `gmdate('Y-m-d')`.
    date: Object.freeze({ type: "string", maxLength: 10 }),
  }),
});

const TICKET_DECISION_BODY = Object.freeze({
  type: "object",
  required: ["approve"],
  properties: Object.freeze({
    approve: Object.freeze({ type: "boolean", required: true }),
    reason: Object.freeze({ type: "string", maxLength: 500 }),
  }),
});

const PREDICTIONS_QUERY = Object.freeze({
  matchId: Object.freeze({ type: "integer", min: 1 }),
  modelVersionId: Object.freeze({ type: "integer", min: 1 }),
  decision: Object.freeze({ type: "string", values: ["PREDICTION_READY", "NO_PREDICTION"] }),
  limit: Object.freeze({ type: "integer", default: 50, min: 1, max: 200 }),
});

// ── settlement, results, backtests and monitoring (slice 5) ──────────────────

const BACKTEST_PARAMS = Object.freeze({
  backtestId: Object.freeze({ type: "string", required: true, minLength: 3, maxLength: 40 }),
});

const RESULTS_QUERY = Object.freeze({
  // The kickoff window. Defaults to no bound, which reads every FINISHED fixture —
  // bounded by `limit`, as legacy's `min(500, max(1, $limit))` is.
  from: Object.freeze({ type: "string", maxLength: 32 }),
  to: Object.freeze({ type: "string", maxLength: 32 }),
  competition: Object.freeze({ type: "string", maxLength: 160 }),
  limit: Object.freeze({ type: "integer", default: 200, min: 1, max: 500 }),
});

const PERFORMANCE_QUERY = Object.freeze({
  from: Object.freeze({ type: "string", maxLength: 32 }),
  to: Object.freeze({ type: "string", maxLength: 32 }),
  modelVersionId: Object.freeze({ type: "integer", min: 1 }),
});

const VERIFY_BODY = Object.freeze({
  type: "object",
  required: ["matchId", "providerId"],
  properties: Object.freeze({
    matchId: Object.freeze({ type: "integer", required: true, min: 1 }),
    providerId: Object.freeze({ type: "integer", required: true, min: 1 }),
  }),
});

const SETTLE_BODY = Object.freeze({
  type: "object",
  properties: Object.freeze({
    // Both present → settle that one match from the stored (match, provider) result.
    // Neither → sweep every PENDING leg against its best stored result.
    matchId: Object.freeze({ type: "integer", min: 1 }),
    providerId: Object.freeze({ type: "integer", min: 1 }),
  }),
});

const BACKTEST_RUN_BODY = Object.freeze({
  type: "object",
  required: ["from", "to"],
  properties: Object.freeze({
    from: Object.freeze({ type: "string", required: true, maxLength: 10 }),
    to: Object.freeze({ type: "string", required: true, maxLength: 10 }),
    league: Object.freeze({ type: "string", maxLength: 160 }),
    modelVersionId: Object.freeze({ type: "integer", min: 1 }),
    minConfidence: Object.freeze({ type: "number", min: 0, max: 100 }),
    oddsMin: Object.freeze({ type: "number", min: 0 }),
    oddsMax: Object.freeze({ type: "number", min: 0 }),
    minDataQuality: Object.freeze({ type: "integer", min: 0, max: 100 }),
    stake: Object.freeze({ type: "number", min: 0 }),
  }),
});

const BACKTESTS_QUERY = Object.freeze({
  limit: Object.freeze({ type: "integer", default: 20, min: 1, max: 200 }),
});

const RECOVER_BODY = Object.freeze({
  type: "object",
  required: ["date"],
  properties: Object.freeze({
    // The UTC day whose stuck RUNNING runs are released. A finished run can never
    // match; only a claim that never finished is removed.
    date: Object.freeze({ type: "string", required: true, maxLength: 10 }),
  }),
});

/**
 * The configuration patch. Every editable field is declared, because the validator drops
 * undeclared keys (the body is rebuilt from its schema). Types come from the configuration
 * module's own field lists, so the schema cannot drift from `validateConfiguration`.
 * `reason` is optional HERE on purpose: a missing or blank reason is refused by the
 * service as 422, the same status legacy returns, instead of a generic 400.
 */
const CONFIGURATION_BODY = Object.freeze({
  type: "object",
  properties: Object.freeze({
    reason: Object.freeze({ type: "string", maxLength: 4000 }),
    ...Object.fromEntries(BOOLEAN_FIELDS.map((field) => [field, Object.freeze({ type: "boolean" })])),
    platform_mode: Object.freeze({ type: "string", values: PLATFORM_MODES }),
    engine_mode: Object.freeze({ type: "string", values: ENGINE_MODES }),
    risk_level: Object.freeze({ type: "string", values: RISK_LEVELS }),
    max_correlation: Object.freeze({ type: "string", values: CORRELATION_LIMITS }),
    void_policy: Object.freeze({ type: "string", values: VOID_POLICIES }),
    ...Object.fromEntries(NUMBER_FIELDS.map((field) => [field, Object.freeze({
      type: field === "max_selections" || field === "min_data_quality" ? "integer" : "number",
    })])),
    min_liquidity: Object.freeze({ type: "number", nullable: true }),
    ...Object.fromEntries(LIST_FIELDS.map((field) => [field, Object.freeze({
      type: "array",
      maxItems: 100,
      items: Object.freeze({ type: "string", minLength: 1, maxLength: 64 }),
    })])),
  }),
});

/**
 * Turn a storage-layer refusal into a 400.
 *
 * The repository's validators throw `TypeError` — the right thing for a programming
 * error, and the wrong thing to surface as a 500 when the cause is a malformed filter
 * a caller supplied. Without this, `?from=12345` would report an internal error and
 * invite a retry of a request that can never succeed.
 */
async function guarded(promise) {
  try {
    return await promise;
  } catch (error) {
    if (error instanceof TypeError) {
      throw AppError.badRequest(error.message, { code: "INVALID_SPORTS_QUERY" });
    }
    throw error;
  }
}

/**
 * @param {import("fastify").FastifyInstance} app
 * @param {object} options
 * @param {object} options.config
 * @param {object} options.store
 * @param {object|null} [options.sports] the sports service
 */
export function sportsRoutes(app, { config, store, sports = null }) {
  const authenticate = createAuthenticator({ store, config });
  const actorOf = (request) => request.auth?.user?.id ?? null;
  const guardFor = (permission) => {
    const guard = requirePermission(permission, config);
    // Set so `/api/v1/system/routes` reports which permission each route needs. A
    // route whose guard cannot name its permission looks ungated in the inventory,
    // which is how F-02's count went stale in the first place.
    guard.permission = permission;
    return [authenticate, guard];
  };
  const canViewSports = requirePermission("sports.view", config);
  canViewSports.permission = "sports.view";
  const view = guardFor("sports.view");
  /**
   * Ingestion is a WRITE, and legacy gates every `Api_sports` write behind
   * `sports.manage` while reads need only `sports.view`. Both permissions already
   * existed in `src/db/platform-baseline.js` before this slice used either, so this is
   * not a new grant — it is the first caller of one that was declared in anticipation.
   */
  const manage = guardFor("sports.manage");

  /**
   * Provider configuration, derived health, and the list of sports capabilities
   * that are not ported.
   *
   * **Probe-free unless `probe=1` is passed** (divergence SP-10). Legacy's
   * `status()` called every provider's `health()` on every request, which for the
   * HTTP provider is an outbound call to a third-party vendor from a dashboard
   * load. The default here derives status from stored observations instead; since
   * this slice stores none, that derivation is `UNKNOWN` — the monitor's defined
   * answer when it has witnessed nothing, not a placeholder.
   *
   * A probed response is stamped `persisted`, which is true only on a host whose
   * sports repository is wired: a probe is a reading taken now, and it becomes a
   * history only where there is somewhere to put it.
   *
   * **Since slice 2 the derived status is measured, not assumed.** Phase 15 hard-coded
   * two empty arrays into the monitor because there was nowhere to read from, so every
   * provider reported `UNKNOWN`. `describeProviders()` now reads the health rows a sync
   * persists and the sync runs it opens — which is what closes finding F-35, legacy
   * having never called its own monitor at all.
   *
   * No secret can appear in this response: providers are described by id and kind,
   * the base URL is reported as a boolean rather than as a value, and the token is
   * never read outside the `Authorization` header.
   */
  app.get("/sports/status", {
    preHandler: [authenticate, canViewSports],
    querySchema: STATUS_QUERY,
  }, async (request) => {
    if (!sports) {
      throw new AppError(503, "SPORTS_SERVICE_UNAVAILABLE", "The sports service is not configured on this host");
    }
    // Already coerced and already defaulted by `STATUS_QUERY`, so this is a strict
    // comparison and not a parse. A probe is outbound I/O, which is why the default
    // is `false`: the cheap reading has to be the one a caller gets by accident.
    const probe = request?.query?.probe === true;
    const report = await sports.status({ probe });
    return {
      ...report,
      // Stated rather than left to inference, because `providersConfigured: false`
      // and `derivedStatus: "UNKNOWN"` are the *expected* answers on a default host
      // and neither is a fault.
      notice: report.providersConfigured
        ? (report.persistence
          ? "Providers are configured from the environment and ingestion is persisted. The decision chain, tickets, settlement, verification, calibration fitting, backtesting, drift monitoring and measured performance are runnable on request; nothing is executed, and no provider has been verified against a real vendor."
          : "Providers are configured from the environment, but this host has no sports repository: nothing is persisted and no decision, ticket or measurement can be produced.")
        : "No sports provider is configured, so no fixture, odds, prediction or ticket can be produced. Nothing is fabricated to fill the gap.",
    };
  });

  // ── stored reads ──────────────────────────────────────────────────────────────
  //
  // Legacy's `Api_sports` exposes twenty-odd endpoints over eighteen tables. These five
  // read the seven that exist here, and no others: a `GET /sports/predictions` that
  // answered from thin air would be the fabrication the platform's rules forbid, and one
  // that answered from a live provider call would return a different thing under a name
  // an operator already trusts.

  /**
   * The stored provider registry — which vendors have been seen, and whether each is
   * enabled.
   *
   * Distinct from `/sports/status`, which lists the providers THIS PROCESS registered
   * from the environment. The two disagreeing is information: a stored row with no
   * registered provider is a vendor a previous configuration used, and its history is
   * still attached to it.
   *
   * `enabled` is false for a row a sync created, because a row appearing is not an
   * operator approving a vendor. There is no route here that sets it: enabling a
   * provider changes what every future sync consults, and that is a configuration
   * decision belonging to a later slice with the configuration service, not a side
   * effect of an ingestion endpoint.
   */
  app.get("/sports/providers", {
    preHandler: view,
    querySchema: PROVIDERS_QUERY,
  }, async (request) => {
    const providers = await guarded(sports.listProviders(request.query.enabledOnly === true));
    return { providers, count: providers.length };
  });

  /**
   * One provider's stored health observations, newest first.
   *
   * The series, not the current value — because an outage is visible as a gap in a
   * series and invisible in an overwritten row. Bounded to 200, the same window the
   * monitor derives from, so what an operator reads here is what the derivation saw.
   */
  app.get("/sports/providers/:providerCode/health", {
    preHandler: view,
    paramsSchema: PROVIDER_CODE_PARAMS,
    querySchema: HEALTH_QUERY,
  }, async (request) => guarded(sports.providerHealthHistory(request.params.providerCode, request.query.limit)));

  /**
   * Stored fixtures, oldest kickoff first.
   *
   * **Stored history, not a live provider call.** That distinction is the whole reason
   * this route did not exist in slice 1: `readFixtures()` can fetch fixtures from a
   * provider, and serving those under this name would have made "the fixtures" mean
   * something different depending on whether anything had been ingested. A caller that
   * wants a live read has `/sports/status?probe=1` and the fallback chain, and this
   * route answers only from what is stored.
   */
  app.get("/sports/matches", {
    preHandler: view,
    querySchema: MATCHES_QUERY,
  }, async (request) => {
    const { limit, oddsLimit: _oddsLimit, ...filter } = request.query;
    const matches = await guarded(sports.listMatches(filter, limit));
    return { matches, count: matches.length };
  });

  /**
   * One fixture with everything stored about it: odds series, latest quality
   * assessment, and its result.
   *
   * Assembled in one response rather than four, because the four rows are only
   * meaningful together — an assessment says whether a fixture was eligible, the odds
   * say what was on offer, the result says how it ended, and read separately they can
   * be combined into a picture that never existed.
   *
   * `verified` is reported explicitly and is false for every row this slice can
   * produce: ingestion reports a result, it does not attest to one, and settlement
   * (slice 5) is the only thing that will.
   */
  app.get("/sports/matches/:matchId", {
    preHandler: view,
    paramsSchema: MATCH_PARAMS,
    querySchema: MATCHES_QUERY,
  }, async (request) => guarded(sports.matchDetail(request.params.matchId, { oddsLimit: request.query.oddsLimit })));

  /**
   * Sync-run evidence, newest first.
   *
   * **The read legacy never had.** `sports_sync_runs` was written by `startSync` and
   * `finishSync` and selected from nowhere in `application/` — so a run's counters and
   * its per-record refusal messages were recorded into a table no operator could query,
   * and a row left in `RUNNING` (the evidence of a worker that died mid-sync) was
   * invisible. Finding F-35; divergence SP-15.
   *
   * `errors` is returned whole rather than as a count, because "40 processed, 2
   * refused" without the two messages is a number to shrug at and the messages are the
   * thing that tells an operator whether the provider changed shape or the clock
   * drifted.
   */
  app.get("/sports/sync-runs", {
    preHandler: view,
    querySchema: SYNC_RUNS_QUERY,
  }, async (request) => {
    const { limit, ...filter } = request.query;
    const runs = await guarded(sports.listSyncRuns(filter, limit));
    return {
      runs,
      count: runs.length,
      // Called out rather than left to be counted: a run still in RUNNING is not
      // in-flight, it is unfinished, and on a single-process cPanel host it will not
      // resume itself.
      unfinished: runs.filter((run) => run.status === "RUNNING").length,
    };
  });

  // ── ingestion ─────────────────────────────────────────────────────────────────

  /**
   * Run one ingestion job: fixtures for a window, or odds/results for one fixture.
   *
   * Gated `sports.manage`, matching legacy's write gate. Idempotent by the caller's
   * `executionKey`: a retry after a timeout, or a schedule that fires twice for one
   * window, returns `DUPLICATE_SKIPPED` instead of storing the same records again.
   *
   * The response distinguishes three outcomes that must not be collapsed:
   *
   *  - `COMPLETED` — the run finished. It may still carry `errors`, because one
   *    malformed record out of forty does not fail a run; it is counted and named.
   *  - `FAILED` — a provider-level refusal (not `ONLINE`, or a fixture that was never
   *    synchronized). The counters say how far it got, so a run that stored four
   *    fixtures before the provider dropped does not report zero work.
   *  - `DUPLICATE_SKIPPED` — this `executionKey` has been used. No `runId` is returned,
   *    because no run was opened, and no audit event is emitted, because the original
   *    run already has one.
   *
   * **This route stores data and nothing else.** It cannot verify a result, generate a
   * prediction, size a stake or build a ticket — none of those tables exists, and no
   * code path here reaches one.
   */
  app.post("/sports/sync", {
    preHandler: manage,
    bodySchema: SYNC_BODY,
  }, async (request) => guarded(sports.sync({
    jobType: request.body.jobType,
    providerId: request.body.providerId,
    executionKey: request.body.executionKey,
    fixtureExternalId: request.body.fixtureExternalId ?? null,
    query: request.body.query ?? {},
    actorId: actorOf(request),
  })));

  // ── decision chain (slice 3) ──────────────────────────────────────────────
  // Every read and write goes through the intelligence service, which owns the inputs,
  // the audit trail and the refusals. These handlers add no logic of their own.
  // Configuration is read and changed under `sports.manage`: it sets the engine mode and
  // its limits, which is an administrator's concern. Everything else is `sports.view`.
  const intel = sports.intelligence;

  app.get("/sports/configuration", { preHandler: manage }, async () => guarded(intel.configuration()));

  app.get("/sports/configuration/versions", {
    preHandler: manage,
    querySchema: LIMIT_QUERY,
  }, async (request) => {
    const versions = await guarded(intel.configurationVersions(request.query.limit));
    return { versions, count: versions.length };
  });

  /**
   * Publish the next configuration version. Append-only. `AUTOMATED_EXECUTION` is refused
   * whatever the body says (DV-14), because the allow-flag is not a request field.
   */
  app.patch("/sports/configuration", {
    preHandler: manage,
    bodySchema: CONFIGURATION_BODY,
  }, async (request) => {
    const { reason, ...patch } = request.body;
    return guarded(intel.updateConfiguration({ patch, reason: reason ?? "", actorId: actorOf(request) }));
  });

  app.get("/sports/models", { preHandler: view }, async () => {
    const models = await guarded(intel.listModels());
    // The measured snapshots, newest first (legacy's `models()` lists them alongside
    // the registry): each `live` metrics read and each drift warning writes one row,
    // so this list is the evidence trail of what was measured, when.
    const metrics = await guarded(store.listSportsModelMetrics({}, 100));
    return { models, metrics, count: models.length };
  });

  /**
   * Model performance over a window — measured from stored settled outcomes and
   * settled tickets (slice 5). `samples: 0` with null metrics is an empty history,
   * not an unimplemented measurement; `comparison` is every model version side by
   * side, measured in the same window.
   */
  app.get("/sports/models/performance", {
    preHandler: view,
    querySchema: WINDOW_QUERY,
  }, async (request) => guarded(intel.modelPerformance({ windowDays: request.query.windowDays })));

  app.get("/sports/calibrations", {
    preHandler: view,
    querySchema: CALIBRATIONS_QUERY,
  }, async (request) => {
    const { limit, ...filter } = request.query;
    const calibrations = await guarded(intel.listCalibrations(filter, limit));
    return { calibrations, count: calibrations.length };
  });

  /**
   * Fit a calibration from the platform's own settled outcomes (slice 5). A fit needs
   * at least 20 settled predictions with both classes represented; anything less is a
   * 422 with the fit's own reason and nothing is stored. A successful fit is stored
   * PENDING — it is not usable until an administrator approves it below.
   */
  app.post("/sports/calibrations/fit", { preHandler: manage }, async (request) => guarded(intel.fitCalibration({ actorId: actorOf(request) })));

  app.post("/sports/calibrations/:calibrationId/approve", {
    preHandler: manage,
    paramsSchema: CALIBRATION_PARAMS,
  }, async (request) => guarded(intel.decideCalibration({
    id: request.params.calibrationId,
    decision: "APPROVED",
    actorId: actorOf(request),
  })));

  app.post("/sports/calibrations/:calibrationId/reject", {
    preHandler: manage,
    paramsSchema: CALIBRATION_PARAMS,
  }, async (request) => guarded(intel.decideCalibration({
    id: request.params.calibrationId,
    decision: "REJECTED",
    actorId: actorOf(request),
  })));

  /**
   * Record a decision for a fixture. Gated `sports.manage`: it writes evidence, and an
   * operator asked for it. Quality is re-assessed from the current price (F-38), so no
   * stored assessment is needed; a fixture that does not exist is a 404.
   */
  app.post("/sports/matches/:matchId/evaluate", {
    preHandler: manage,
    paramsSchema: MATCH_PARAMS,
  }, async (request) => guarded(intel.evaluateMatch({
    matchId: request.params.matchId,
    actorId: actorOf(request),
  })));

  /** What the chain would conclude now, with nothing stored. */
  app.get("/sports/matches/:matchId/intelligence", {
    preHandler: view,
    paramsSchema: MATCH_PARAMS,
  }, async (request) => guarded(intel.matchIntelligence(request.params.matchId)));

  app.get("/sports/predictions", {
    preHandler: view,
    querySchema: PREDICTIONS_QUERY,
  }, async (request) => {
    const { limit, ...filter } = request.query;
    const predictions = await guarded(intel.listPredictions(filter, limit));
    return { predictions, count: predictions.length };
  });

  app.get("/sports/predictions/:predictionId/decision", {
    preHandler: view,
    paramsSchema: PREDICTION_PARAMS,
  }, async (request) => guarded(intel.predictionDecision(request.params.predictionId)));

  // ── tickets (slice 4) ─────────────────────────────────────────────────────
  // Generating a run is an operator's action (`sports.manage`). Reading is `sports.view`.
  // Deciding a ticket is `sports.approve`, the permission legacy's `Api_sports` checks, and
  // it records a decision only: nothing is executed.

  /**
   * Run the daily ticket generation for one UTC day over the fixtures already stored. A
   * second run for the same day and configuration version is DUPLICATE_SKIPPED.
   */
  app.post("/sports/daily-tickets/run", {
    preHandler: manage,
    bodySchema: DAILY_RUN_BODY,
  }, async (request) => guarded(sports.tickets.runDaily({
    date: request.body?.date ?? null,
    actorId: actorOf(request),
  })));

  app.get("/sports/daily-tickets", {
    preHandler: view,
    querySchema: DAILY_RUNS_QUERY,
  }, async (request) => {
    const runs = await guarded(sports.tickets.listDailyRuns(request.query.limit));
    return { runs, count: runs.length };
  });

  app.get("/sports/tickets", {
    preHandler: view,
    querySchema: TICKETS_QUERY,
  }, async (request) => {
    const { limit, ...filter } = request.query;
    const tickets = await guarded(sports.tickets.listTickets(filter, limit));
    return { tickets, count: tickets.length };
  });

  app.get("/sports/tickets/:ticketId", {
    preHandler: view,
    paramsSchema: TICKET_PARAMS,
  }, async (request) => guarded(sports.tickets.getTicket(request.params.ticketId)));

  app.post("/sports/tickets/:ticketId/decision", {
    preHandler: guardFor("sports.approve"),
    paramsSchema: TICKET_PARAMS,
    bodySchema: TICKET_DECISION_BODY,
  }, async (request) => guarded(sports.tickets.decideTicket({
    id: request.params.ticketId,
    approve: request.body.approve,
    reason: request.body.reason ?? "",
    actorId: actorOf(request),
  })));

  // ── settlement, verification, backtests and monitoring (slice 5) ───────────
  // Verification and settlement are `sports.settle`, the separate permission legacy
  // gates them with — attesting to a result is a different act from reading one, and
  // a different act from approving a ticket. Approval under a kill switch is blocked
  // (the decision route's own gate); settlement deliberately is not, because settling
  // existing records is how the book is closed while new approvals wait.

  /**
   * Stored results: every FINISHED fixture in the window with its best stored result
   * row and that row's attestation state. This is what an operator verifies from —
   * `verified: false` here is a result waiting for a person, not a refusal.
   */
  app.get("/sports/results", {
    preHandler: view,
    querySchema: RESULTS_QUERY,
  }, async (request) => {
    const { limit, ...filter } = request.query;
    const results = await guarded(sports.listResults(filter, limit));
    return {
      results,
      count: results.length,
      unverified: results.filter((row) => !row.verified).length,
    };
  });

  /**
   * Attest to one stored provider result. The scores do not move; only the
   * attestation does, and the audit event names the person who made it. A result that
   * is not a well-formed final score (not FINISHED, missing or negative scores) is
   * refused with 409 and nothing is attested.
   */
  app.post("/sports/results/verify", {
    preHandler: guardFor("sports.settle"),
    bodySchema: VERIFY_BODY,
  }, async (request) => guarded(sports.settlement.verifyStoredResult({
    matchId: request.body.matchId,
    providerId: request.body.providerId,
    actorId: actorOf(request),
  })));

  /**
   * Settle a ticket: either one match from a stored (match, provider) result, or a
   * sweep of every PENDING leg against its best stored result. Idempotent by
   * construction — the ticket's status is recomputed from its legs every time — and
   * safe to run repeatedly, which is what a future settlement sweep will do.
   */
  app.post("/sports/tickets/:ticketId/settle", {
    preHandler: guardFor("sports.settle"),
    paramsSchema: TICKET_PARAMS,
    bodySchema: SETTLE_BODY,
  }, async (request) => {
    const hasMatchProvider = request.body?.matchId !== undefined && request.body?.providerId !== undefined;
    const settlement = hasMatchProvider
      ? await guarded(sports.settlement.applyStoredResult(request.params.ticketId, request.body.matchId, request.body.providerId))
      : await guarded(sports.settlement.settlePending(request.params.ticketId));
    const ticket = await guarded(sports.tickets.getTicket(request.params.ticketId));
    return { settlement, ticket };
  });

  /**
   * The performance report over stored settled data. Every number derives from stored
   * records; an empty history reports `dataAvailable: false` with null metrics, and a
   * SANDBOX-mode host's report says `DEMO / SANDBOX DATA` in so many words.
   */
  app.get("/sports/performance", {
    preHandler: view,
    querySchema: PERFORMANCE_QUERY,
  }, async (request) => {
    const { modelVersionId, ...filter } = request.query;
    return guarded(sports.performanceReport({ ...filter, modelVersionId: modelVersionId ?? null }));
  });

  /**
   * Run one point-in-time backtest over stored history. Gated `sports.manage`, as
   * legacy's `run_backtest` is. The report is stored whole with `simulation: true`
   * inside it, and every derived number says it is a replay.
   */
  app.post("/sports/backtests/run", {
    preHandler: manage,
    bodySchema: BACKTEST_RUN_BODY,
  }, async (request) => {
    const stored = await guarded(sports.backtester.run(request.body, { actorId: actorOf(request) }));
    return { backtest: stored };
  });

  app.get("/sports/backtests", {
    preHandler: view,
    querySchema: BACKTESTS_QUERY,
  }, async (request) => {
    const backtests = await guarded(store.listSportsBacktests(request.query.limit));
    // The report bodies stay out of the list: they can be large, and the read exists
    // so an operator can find a run, not re-read every run.
    return {
      backtests: backtests.map((backtest) => ({
        id: backtest.id,
        createdAt: backtest.created_at,
        createdBy: backtest.created_by,
        status: backtest.status,
        params: backtest.params,
      })),
      count: backtests.length,
    };
  });

  app.get("/sports/backtests/:backtestId", {
    preHandler: view,
    paramsSchema: BACKTEST_PARAMS,
  }, async (request) => {
    const backtest = await guarded(store.findSportsBacktest(request.params.backtestId)).catch(() => null);
    if (!backtest) throw AppError.notFound("No stored backtest with that id");
    return { backtest };
  });

  /**
   * Run the model drift monitor now (slice 5). Legacy runs it only from the
   * `monitoring` cron job, which is not ported (row 19); this route is the on-request
   * surface the alerting needs until a scheduler exists. A warning publishes
   * `SPORTS_MODEL_DRIFT` — the last declared notification type to gain a publisher
   * (NV-6) — deduped once per model per UTC day, and writes a `drift` snapshot row.
   */
  app.post("/sports/models/drift/run", {
    preHandler: manage,
  }, async () => guarded(sports.drift.monitor()));

  /**
   * Recover a stuck daily-ticket run (R-29). A run that crashed mid-way stays RUNNING
   * and blocks its (day, configuration version) forever, because the claim is the
   * row. Recovery deletes the RUNNING claims for one day — a finished run can never
   * match — reports the counters it died with, and audits each release, so the day
   * can be re-run and the crash is still on the record.
   */
  app.post("/sports/daily-tickets/recover", {
    preHandler: manage,
    bodySchema: RECOVER_BODY,
  }, async (request) => {
    if (!store) {
      throw new AppError(503, "SPORTS_PERSISTENCE_UNAVAILABLE",
        "This host has no sports repository, so there is no run to recover");
    }
    const storeRepository = store;
    const removed = await guarded(storeRepository.recoverSportsDailyTicketRuns(request.body.date));
    for (const run of removed) {
      await storeRepository.recordAudit({
        actorId: actorOf(request),
        action: "sports.daily_ticket.recovered",
        entityType: "sports_daily_ticket",
        entityId: String(run.id),
        details: {
          runDate: run.run_date,
          configurationVersion: run.configuration_version,
          recoveredAt: new Date().toISOString(),
          counters: {
            fixturesRead: run.fixtures_read,
            candidatesEvaluated: run.candidates_evaluated,
            predictionsRecorded: run.predictions_recorded,
          },
          message: `A RUNNING run for ${run.run_date} (configuration ${run.configuration_version}) never finished and was released; the day can be re-run`,
        },
      });
    }
    return { recovered: removed, count: removed.length };
  });
}
