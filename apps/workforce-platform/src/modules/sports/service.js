/**
 * The Sports Intelligence service — the port of the provider-facing half of
 * `Aegis\Sports\SportsIntelligence`.
 *
 * Legacy's class is the module facade: it owns the provider registry, the health
 * observer, the repository, the configuration service and the dashboard
 * aggregation. **This port owns the provider registry and nothing else**, because
 * row 14 is being landed in slices and this is slice 1: the normalized contracts,
 * the provider boundary and the parity evidence. There is no repository here, so
 * there is no prediction, no ticket, no settlement and no dashboard — and the status this service
 * returns says so explicitly rather than returning empty arrays that look like
 * "no fixtures today".
 *
 * What is here is the part every later slice depends on and the part that can be
 * proven correct now:
 *
 *  - the provider registry, built from environment configuration only;
 *  - the double-gated sandbox provider, whose output is deterministic and labelled;
 *  - the generic HTTP provider, classified and never verified against a real vendor;
 *  - the fallback chain, which returns a structured failure rather than an empty success;
 *  - the health monitor, which derives a status from observations and **invents none**.
 *
 * **SP-10 — `status()` does not probe.** Legacy's did: its `status()` returned
 * `liveHealth`, which called every provider's `health()` and therefore made an
 * outbound request per provider on every dashboard load. Here the default is
 * probe-free and the derived status comes from stored observations — of which there
 * are none yet, so it is `UNKNOWN`, which is the honest answer and exactly what the
 * monitor returns when it has nothing to go on. A live probe is available behind
 * `probe: true` and its result is stamped `persisted: false` so it cannot be
 * mistaken for history. This is BC-11's reasoning applied to a module whose
 * providers are third-party vendors rather than local bridges.
 */

import { PROVIDER_STATUS } from "./provider-error.js";
import { assessProviderHealth } from "./health-monitor.js";
import { createSportsProviderManager } from "./providers/manager.js";
import { AppError } from "../../http/errors.js";
import { createSportsSyncService } from "./sync.js";
import { createSandboxSportsProvider, SANDBOX_PROVIDER_ID } from "./providers/sandbox.js";
import { createHttpSportsProvider } from "./providers/http.js";

/**
 * The slices of row 14 this port does not yet contain, in legacy's own terms.
 *
 * Nine entries, down from the ten Phase 15 shipped: fixture, odds and result ingestion
 * has been REMOVED rather than re-labelled, because a matrix whose name is "not ported"
 * must not contain an entry that says otherwise. What ingestion now does is stated
 * positively in `status().persistence` and `status().message`, where a reader looking
 * for capability will find it; a slice that graduates out of this list is the list
 * working.
 *
 * Surfaced by `status()` for the same reason the broker route surfaces its
 * `PLANNED` matrix (divergence BC-10): no ported module has a console screen
 * (**F-29**), so a distinction that legacy showed an operator in a view has to
 * travel in the API response or it is lost. "Working" and "scaffolded, not yet
 * ported" must not look the same from the outside.
 */
export const SPORTS_NOT_PORTED = Object.freeze([
  Object.freeze({ area: "predictions", legacy: "PredictionPipeline, PredictionEngine, FeatureEngineeringEngine, MatchIntelligenceEngine", state: "not ported", detail: "No prediction can be produced. Its inputs — calibrated probabilities and verified results — do not exist in this port yet." }),
  Object.freeze({ area: "value and staking", legacy: "ValueEngine, RiskEngine, CorrelationEngine, ConfidenceEngine", state: "not ported", detail: "No edge, stake or correlation check exists. Nothing in this module can size a wager." }),
  Object.freeze({ area: "ticket governance and optimization", legacy: "TicketGovernance, TicketOptimizer, DailyTicketService", state: "not ported", detail: "No ticket can be generated, and `sports_tickets` has no Node counterpart." }),
  Object.freeze({ area: "settlement and result verification", legacy: "TicketSettlementService, ResultVerificationEngine, PersistedResultVerifier", state: "not ported", detail: "No result can be verified or settled. `wf_sports_results.verified` exists and ingestion deliberately leaves it false — and re-ingesting a result CLEARS it (divergence SP-14), because a changed scoreline invalidates an attestation made about the old one. `verifySportsResult` is not in the contract." }),
  Object.freeze({ area: "calibration", legacy: "CalibrationEngine", state: "not ported", detail: "No calibration can be fitted or approved, and no raw probability can be mapped to a calibrated one." }),
  Object.freeze({ area: "backtesting", legacy: "SportsBacktester", state: "not ported", detail: "Point-in-time backtesting is now UNBLOCKED but not written: migration 011 stores odds as one row per observation, and `findSportsOddsBefore(match, instant)` answers \"what did we know then\". No backtest is run and `wf_sports_backtests` does not exist." }),
  Object.freeze({ area: "model monitoring", legacy: "ModelPerformanceService, ModelDriftMonitor", state: "not ported", detail: "`SPORTS_MODEL_DRIFT` therefore remains the last notification type with no publisher (NV-6)." }),
  Object.freeze({ area: "configuration service", legacy: "ConfigurationService", state: "not ported", detail: "Engine mode and its limits live in `sports_configurations`, which does not exist here; the mode reported by this service comes from the environment only." }),
  Object.freeze({ area: "performance analytics and dashboards", legacy: "PerformanceAnalytics, Sports::index, Sports::tickets", state: "not ported", detail: "Both aggregate stored tickets and selections. No console screen exists in any ported module (F-29)." }),
]);

/**
 * Create the sports service.
 *
 * @param {object} options
 * @param {{sports: Record<string, unknown>}} options.config
 * @param {() => number} [options.now] epoch milliseconds
 * @param {(url: string, init: Record<string, unknown>) => Promise<{status: number, body: string}>} [options.transport]
 *   injected into the HTTP provider; the default uses `fetch`
 * @returns {Readonly<Record<string, unknown>>}
 */
export function createSportsService({ config, store = null, now = () => Date.now(), transport } = {}) {
  const settings = config?.sports ?? {};
  const http = settings.http ?? {};

  /**
   * Legacy's `registerProviders()`: **providers are registered from environment
   * configuration only — no secrets in code.**
   *
   * The sandbox is registered only when the mode is `SANDBOX` *and* the explicit
   * opt-in is set; the HTTP provider only when a valid base URL is configured. A
   * default installation therefore registers nothing at all, and
   * `providersConfigured` is false.
   */
  const manager = createSportsProviderManager();

  /** @type {Array<{id: string, kind: string, simulated: boolean}>} */
  const declared = [];

  if (settings.mode === "SANDBOX" && settings.sandboxEnabled === true) {
    manager.register(createSandboxSportsProvider({ mode: settings.mode, sandboxEnabled: true, now }));
    declared.push({ id: SANDBOX_PROVIDER_ID, kind: "sandbox", simulated: true });
  }
  if (typeof http.baseUrl === "string" && http.baseUrl !== "") {
    manager.register(
      createHttpSportsProvider({
        id: http.id,
        baseUrl: http.baseUrl,
        token: http.token,
        timeoutSeconds: http.timeoutSeconds,
        transport,
        now,
      }),
    );
    // A real vendor is not "simulated", but it is also not *verified*: no adapter
    // in this repository has ever spoken to its provider, and claiming otherwise
    // would be the exact fabrication the platform's rules forbid.
    declared.push({ id: String(http.id), kind: "http", simulated: false });
  }

  /**
   * Describe each registered provider **without contacting it**.
   *
   * The derived status is computed from stored observations. This slice stores
   * none, so every provider derives to `UNKNOWN` — which is not a placeholder or a
   * default: it is the monitor's defined answer when it has witnessed nothing, and
   * it is the reason `ProviderHealthMonitor` exists as a separate class from a
   * provider's own `health()`.
   */
  /**
   * Describe each registered provider, deriving its status from STORED observations.
   *
   * This is the method Phase 15 shipped with two empty arrays hard-coded into it,
   * because there was nowhere to read from: every provider derived to `UNKNOWN` and
   * the docblock said so. Slice 2 gives it real inputs — the health rows a sync
   * persists and the sync runs it opens — which is what makes `assessProviderHealth`
   * reachable at all.
   *
   * **Finding F-35.** Legacy never reached this code. `ProviderHealthMonitor::assess()`
   * has no caller anywhere in `application/`, and its third parameter is documented as
   * *"newest-first `sports_sync_runs` rows for this provider"* while
   * `Aegis\Persistence\SportsRepository` declares no method that can read that table —
   * only `startSync` and `finishSync`. Legacy wrote sync evidence into a table it had
   * no way to query, and built a monitor whose derived status it never computed.
   * `listSportsSyncRuns` (divergence SP-15) is the method that closes the gap; porting
   * the class would not have.
   *
   * Reads only. A status call never creates a provider row — that is why this looks
   * the id up in `listSportsProviders()` instead of calling `ensureSportsProvider()`,
   * which would make an unauthenticated-adjacent read write to the registry.
   */
  async function describeProviders() {
    const stored = store ? await store.listSportsProviders() : [];
    const derivedRows = [];
    for (const entry of declared) {
      const row = stored.find((candidate) => candidate.provider_code === entry.id) ?? null;
      let healthRows = [];
      let runRows = [];
      if (row) {
        // Bounded windows, not whole tables: the monitor's rules are all about
        // recency, so the newest 20 observations and the newest 20 runs are the input
        // it was written against.
        healthRows = await store.listSportsHealth(Number(row.id), 20);
        runRows = await store.listSportsSyncRuns({ providerId: Number(row.id) }, 20);
      }
      const derived = assessProviderHealth(row ?? { provider_code: entry.id }, healthRows, runRows, Math.floor(now() / 1000));
      derivedRows.push(Object.freeze({
        id: entry.id,
        kind: entry.kind,
        // Every record the sandbox emits carries `simulated: true`; this flag says
        // the provider itself is a simulation, before any record exists.
        simulated: entry.simulated,
        verifiedAgainstProvider: false,
        derivedStatus: derived.status,
        reliability: derived.reliability,
        detail: derived.detail,
        // Whether a provider row exists yet. A registered provider with no row has
        // never been synced, which is a different fact from one whose observations
        // have all aged out — and `UNKNOWN` alone does not distinguish them.
        registered: row !== null,
        enabled: row ? row.enabled === true : false,
        observations: healthRows.length,
        syncRuns: runRows.length,
      }));
    }
    return derivedRows;
  }

  /**
   * The module status. Probe-free by default — see SP-10 in the module docblock.
   *
   * @param {{probe?: boolean}} [options] `probe: true` performs one live
   *   `health()` per registered provider. The result is stamped `persisted: false`
   *   even on a host with a repository, because a probe writes nothing: only
   *   ingestion appends health observations. See the comment at the flag.
   */
  async function status({ probe = false } = {}) {
    const configured = manager.configured();
    const report = {
      module: "WINDELS Sports Intelligence",
      enabled: settings.enabled === true,
      mode: settings.mode ?? "SANDBOX",
      // Legacy's flag, kept because it is the one an operator reads first: in
      // SANDBOX mode every record this module could produce is labelled simulation.
      isDemoData: (settings.mode ?? "SANDBOX") === "SANDBOX",
      providersConfigured: configured,
      providers: await describeProviders(),
      // Whether THIS HOST has a sports repository (migration 011 wired). A statement
      // about capability, and not to be confused with `persisted` below, which is about
      // one reading: a host can have `persistence: true` and still return
      // `persisted: false` for a probe, because probes are never written.
      persistence: store !== null,
      notPorted: SPORTS_NOT_PORTED,
      // Legacy's ticket-engine field reported the active configuration's engine
      // mode, or `DISABLED_NO_PROVIDER`. The configuration service is not ported,
      // so the honest value is that there is no engine at all — not that it is
      // disabled, which would imply one exists and was switched off.
      ticketEngine: "NOT_PORTED",
      message: configured
        ? (store
          ? "Sports data providers are configured and ingestion is persisted: fixtures, odds observations, results, quality assessments, provider health and sync runs are stored. Derived provider health is computed from those rows. No prediction, ticket, settlement, calibration or backtest can be produced, and no stored result is verified."
          : "Sports data providers are configured but this host has no sports repository, so nothing is persisted: fixture, odds and result ingestion has nowhere to put its rows, and no prediction, ticket, settlement, calibration or backtest can be produced.")
        : "No sports provider is configured. No fixtures, odds, predictions, or tickets are fabricated.",
    };

    if (probe !== true) return Object.freeze({ ...report, liveHealth: null, probed: false });

    const liveHealth = await manager.health();
    return Object.freeze({
      ...report,
      probed: true,
      liveHealth,
      // SP-10, unchanged by slice 2 and deliberately so: **a probe is never
      // persisted, even on a host that has a repository.**
      //
      // Making this conditional on `store` was the first thing slice 2 tried, and it
      // was wrong — it reported `persisted: true` for a reading that had been written
      // nowhere, which is a false claim about provenance on the exact field whose only
      // job is to make that claim. Health rows are written by INGESTION
      // (`syncSports*` → `saveSportsHealth`), because an observation belongs to the
      // work that obtained it and carries that run's counters with it. A status probe
      // writes nothing, so `persisted` is false however the host is configured.
      //
      // Not writing on a probe is also what keeps a dashboard load from mutating the
      // history `assessProviderHealth` derives from: a page refreshed twenty times
      // would otherwise append twenty observations, and the monitor's error-rate and
      // staleness rules would be measuring refreshes rather than the provider.
      persisted: false,
    });
  }

  /**
   * Read fixtures through the fallback chain.
   *
   * Exposed because it is the one operation this slice can genuinely perform end to
   * end with the sandbox provider: no I/O, deterministic output, every record
   * labelled. **The rows are returned, not stored** — there is no repository — so a
   * caller must not treat this as a query over history.
   *
   * @param {Record<string, unknown>} query `{from, to}`
   * @param {string|null} [preferredProviderId]
   */
  async function readFixtures(query = {}, preferredProviderId = null) {
    const outcome = await manager.withFallback("fixtures", (provider) => provider.fixtures(query), preferredProviderId);
    return outcome;
  }

  /** @param {string} fixtureExternalId @param {string|null} [preferredProviderId] */
  async function readOdds(fixtureExternalId, preferredProviderId = null) {
    return manager.withFallback("odds", (provider) => provider.odds(fixtureExternalId), preferredProviderId);
  }

  /** @param {string} fixtureExternalId @param {string|null} [preferredProviderId] */
  async function readResults(fixtureExternalId, preferredProviderId = null) {
    return manager.withFallback("results", (provider) => provider.results(fixtureExternalId), preferredProviderId);
  }

  /**
   * A **synchronous, probe-free** description of this module for the unauthenticated
   * `/system/status` surface — the same contract `analysis.statusSnapshot()` and
   * `notifications.statusSnapshot()` honour.
   *
   * It reports configuration, never observations: no provider is contacted, no
   * health is derived, and nothing is read from storage. An anonymous caller must
   * not be able to make this server reach a third-party vendor, which is the
   * invariant BC-11 established for the broker connectors and SP-10 restates here
   * for feeds that are not even on the same host.
   */
  function statusSnapshot() {
    const configured = manager.configured();
    return Object.freeze({
      enabled: settings.enabled === true,
      mode: settings.mode ?? "SANDBOX",
      isDemoData: (settings.mode ?? "SANDBOX") === "SANDBOX",
      providersConfigured: configured,
      providerIds: Object.freeze(declared.map((entry) => entry.id)),
      simulatedProviders: declared.filter((entry) => entry.simulated).length,
      // Stated as a fact rather than implied by empty arrays. Still read from
      // configuration alone: this method must stay synchronous and I/O-free, so it
      // reports whether a repository EXISTS, never what it contains.
      persistence: store !== null,
      notPortedAreas: SPORTS_NOT_PORTED.length,
      ticketEngine: "NOT_PORTED",
      reason: configured
        ? (store
          ? "Providers are configured from the environment and ingestion is persisted. No prediction, ticket, settlement, calibration or backtest can be produced, and no stored result is verified. This snapshot reports configuration only: derived health is computed from stored observations and is available on the authenticated GET /api/v1/sports/status, never here, because this surface is unauthenticated and must not trigger a read of provider history or an outbound call."
          : "Providers are configured from the environment but this host has no sports repository, so no fixture, odds or result is persisted, and no prediction, ticket, settlement, calibration or backtest can be produced. The authenticated GET /api/v1/sports/status reports the same and can probe on request.")
        : "No sports provider is configured, so no fixture, odds, prediction or ticket can be produced and nothing is fabricated to fill the gap.",
    });
  }

  // ── stored reads (slice 2) ───────────────────────────────────────────────────
  //
  // Everything below reads the seven `wf_sports_*` tables and nothing else. Each
  // method refuses loudly when the host has no sports repository, because a read that
  // silently returned an empty list would be indistinguishable from a database with no
  // rows in it — and "this host is not configured for that" is a different fact from
  // "nothing has been ingested yet".

  function requireStore() {
    if (!store) {
      throw new AppError(
        503,
        "SPORTS_PERSISTENCE_UNAVAILABLE",
        "This host has no sports repository, so stored sports data cannot be read. Ingestion needs the tables migration 011 creates.",
      );
    }
    return store;
  }

  /**
   * The stored provider registry.
   *
   * Deliberately distinct from `status().providers`, which lists the providers this
   * process has REGISTERED from the environment. The two can disagree, and the
   * disagreement is information: a row here with no registered provider is a vendor a
   * previous configuration used, whose history is still attached to it; a registered
   * provider with no row has never been synced.
   */
  async function listProviders(enabledOnly = false) {
    return requireStore().listSportsProviders(enabledOnly);
  }

  /** Stored fixtures, oldest kickoff first. Accepts the filter `listSportsMatches` does. */
  async function listMatches(filter = {}, limit = 50) {
    return requireStore().listSportsMatches(filter, limit);
  }

  /**
   * One fixture with everything stored about it.
   *
   * Assembled here rather than by a caller making four requests, because the four rows
   * are only meaningful together: a fixture's quality assessment says whether it was
   * eligible, its odds say what was on offer, and its result says how it ended. Read
   * separately they can be assembled into a picture that never existed — an assessment
   * from one sync next to odds from another.
   *
   * Odds are returned newest-first and NOT reduced to a latest-per-market map, because
   * "the price" of a selection is a series and picking one silently discards the
   * history the series exists to keep.
   */
  async function matchDetail(matchId, { oddsLimit = 50 } = {}) {
    const repository = requireStore();
    const id = Number(matchId);
    if (!Number.isInteger(id) || id < 1) {
      throw new AppError(400, "INVALID_MATCH_ID", "A match id must be a positive integer");
    }
    const match = await repository.findSportsMatchById(id);
    if (!match) throw AppError.notFound(`No stored fixture with id ${id}`);
    const [odds, quality, result] = await Promise.all([
      repository.listSportsOdds(id, oddsLimit),
      repository.latestSportsQuality(id),
      // A fixture may have results from more than one provider; each is its own row,
      // and `verified` is per row.
      repository.findSportsResult(id, Number(match.provider_id)).catch(() => null),
    ]);
    return Object.freeze({
      match,
      odds,
      quality,
      result,
      // Stated rather than inferred from `result === null`: no stored result means the
      // fixture has not finished or has not been synced, and neither is a refusal.
      verified: result ? result.verified === true : false,
    });
  }

  /**
   * Sync-run evidence, newest first.
   *
   * This is the read legacy never had (**F-35**): `sports_sync_runs` was written by
   * `startSync`/`finishSync` and selected from nowhere in `application/`, so a run's
   * counters and its refusal messages were recorded into a table no operator could
   * query. A `RUNNING` row that never closed — the evidence of a worker that died
   * mid-sync — was therefore invisible.
   */
  async function listSyncRuns(filter = {}, limit = 20) {
    return requireStore().listSportsSyncRuns(filter, limit);
  }

  /** One provider's stored health observations, newest first. */
  async function providerHealthHistory(providerCode, limit = 20) {
    const repository = requireStore();
    const providers = await repository.listSportsProviders();
    const row = providers.find((candidate) => candidate.provider_code === String(providerCode));
    if (!row) throw AppError.notFound(`No stored provider with code ${String(providerCode).slice(0, 64)}`);
    return Object.freeze({ provider: row, observations: await repository.listSportsHealth(Number(row.id), limit) });
  }

  // ── ingestion (slice 2) ──────────────────────────────────────────────────────

  /**
   * Resolve a registered provider by id, refusing one that is not registered.
   *
   * The refusal matters: a sync names a provider, and a name that is not registered
   * would otherwise reach `ensureSportsProvider` and create a registry row for a
   * vendor this host cannot talk to — a provider that can only ever fail.
   */
  function resolveProvider(providerId) {
    const configured = manager.configured();
    if (!configured) {
      throw new AppError(
        409,
        "SPORTS_NO_PROVIDER",
        "No sports provider is registered on this host. Providers come from WINDELS_SPORTS_* environment configuration only; nothing is fabricated to fill the gap.",
      );
    }
    const provider = manager.provider(String(providerId));
    if (!provider) {
      throw new AppError(
        404,
        "SPORTS_PROVIDER_UNKNOWN",
        `No sports provider is registered with id ${String(providerId).slice(0, 64)}`,
      );
    }
    return provider;
  }

  /**
   * Run one ingestion job.
   *
   * `actorId` is passed per call rather than bound to the service, because the same
   * service instance serves both an operator's request and a scheduled run — and a
   * cron sync must be attributed to the system actor, never to whichever operator
   * happened to configure the host. `null` is what Phase 10's audit attribution reads
   * as `kind: "system"`.
   */
  async function sync({ jobType, providerId, executionKey, query = {}, fixtureExternalId = null, actorId = null }) {
    requireStore();
    const provider = resolveProvider(providerId);
    const syncService = createSportsSyncService({ store, actorId, now });
    if (jobType === "FIXTURES") return syncService.syncFixtures(provider, query, executionKey);
    if (jobType === "ODDS" || jobType === "RESULTS") {
      if (typeof fixtureExternalId !== "string" || fixtureExternalId.trim() === "") {
        throw new AppError(400, "INVALID_FIXTURE", "An odds or results sync needs the fixture's external id");
      }
      return jobType === "ODDS"
        ? syncService.syncOdds(provider, fixtureExternalId, executionKey)
        : syncService.syncResults(provider, fixtureExternalId, executionKey);
    }
    throw new AppError(400, "INVALID_JOB_TYPE", `jobType must be one of FIXTURES, ODDS, RESULTS, received ${String(jobType).slice(0, 40)}`);
  }

  return Object.freeze({
    status,
    statusSnapshot,
    readFixtures,
    readOdds,
    readResults,
    // Stored reads (migration 011). Each refuses with 503 when this host has no sports
    // repository, rather than returning an empty list that would look like an empty
    // database.
    listProviders,
    listMatches,
    matchDetail,
    listSyncRuns,
    providerHealthHistory,
    // Ingestion. Gated `sports.manage` at the route, matching legacy's `Api_sports`,
    // and idempotent by `executionKey` underneath.
    sync,
    resolveProvider,
    /** The registry itself, for callers that need the fallback chain directly. */
    providers: manager,
    /** `PROVIDER_STATUS`, re-exported so a route does not import two modules. */
    statuses: PROVIDER_STATUS,
  });
}
