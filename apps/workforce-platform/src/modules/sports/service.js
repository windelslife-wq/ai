/**
 * The Sports Intelligence service — the port of the provider-facing half of
 * `Aegis\Sports\SportsIntelligence`.
 *
 * Legacy's class is the module facade: it owns the provider registry, the health
 * observer, the repository, the configuration service and the dashboard
 * aggregation. **This port owns the provider registry and nothing else**, because
 * row 14 is being landed in slices and this is slice 1: the normalized contracts,
 * the provider boundary and the parity evidence. There is no repository here, so
 * there is no sync, no persistence and no dashboard — and the status this service
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
import { createSandboxSportsProvider, SANDBOX_PROVIDER_ID } from "./providers/sandbox.js";
import { createHttpSportsProvider } from "./providers/http.js";

/**
 * The slices of row 14 this port does not yet contain, in legacy's own terms.
 *
 * Surfaced by `status()` for the same reason the broker route surfaces its
 * `PLANNED` matrix (divergence BC-10): no ported module has a console screen
 * (**F-29**), so a distinction that legacy showed an operator in a view has to
 * travel in the API response or it is lost. "Working" and "scaffolded, not yet
 * ported" must not look the same from the outside.
 */
export const SPORTS_NOT_PORTED = Object.freeze([
  Object.freeze({ area: "fixture, odds and result ingestion", legacy: "SportsSyncService", state: "ported, not persisted", detail: "The service and its idempotency key are ported; the seven tables it writes (migration 011) are not, so a sync has nowhere to put its rows." }),
  Object.freeze({ area: "predictions", legacy: "PredictionPipeline, PredictionEngine, FeatureEngineeringEngine, MatchIntelligenceEngine", state: "not ported", detail: "No prediction can be produced. Its inputs — calibrated probabilities and verified results — do not exist in this port yet." }),
  Object.freeze({ area: "value and staking", legacy: "ValueEngine, RiskEngine, CorrelationEngine, ConfidenceEngine", state: "not ported", detail: "No edge, stake or correlation check exists. Nothing in this module can size a wager." }),
  Object.freeze({ area: "ticket governance and optimization", legacy: "TicketGovernance, TicketOptimizer, DailyTicketService", state: "not ported", detail: "No ticket can be generated, and `sports_tickets` has no Node counterpart." }),
  Object.freeze({ area: "settlement and result verification", legacy: "TicketSettlementService, ResultVerificationEngine, PersistedResultVerifier", state: "not ported", detail: "No result can be verified or settled. The `verified` flag the schema reserves has no writer." }),
  Object.freeze({ area: "calibration", legacy: "CalibrationEngine", state: "not ported", detail: "No calibration can be fitted or approved, and no raw probability can be mapped to a calibrated one." }),
  Object.freeze({ area: "backtesting", legacy: "SportsBacktester", state: "not ported", detail: "Point-in-time backtesting needs stored odds history, which needs the tables." }),
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
export function createSportsService({ config, now = () => Date.now(), transport } = {}) {
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
  function describeProviders() {
    return declared.map((entry) => {
      const derived = assessProviderHealth({ provider_code: entry.id }, [], []);
      return Object.freeze({
        id: entry.id,
        kind: entry.kind,
        // Every record the sandbox emits carries `simulated: true`; this flag says
        // the provider itself is a simulation, before any record exists.
        simulated: entry.simulated,
        verifiedAgainstProvider: false,
        derivedStatus: derived.status,
        reliability: derived.reliability,
        detail: derived.detail,
      });
    });
  }

  /**
   * The module status. Probe-free by default — see SP-10 in the module docblock.
   *
   * @param {{probe?: boolean}} [options] `probe: true` performs one live
   *   `health()` per registered provider. The result is stamped `persisted: false`
   *   because this slice has nowhere to store it, so it is a reading and not a
   *   history.
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
      providers: describeProviders(),
      notPorted: SPORTS_NOT_PORTED,
      // Legacy's ticket-engine field reported the active configuration's engine
      // mode, or `DISABLED_NO_PROVIDER`. The configuration service is not ported,
      // so the honest value is that there is no engine at all — not that it is
      // disabled, which would imply one exists and was switched off.
      ticketEngine: "NOT_PORTED",
      message: configured
        ? "Sports data providers are configured. Nothing is persisted yet: fixture, odds and result ingestion needs the tables this slice does not create, and no prediction, ticket, settlement, calibration or backtest can be produced."
        : "No sports provider is configured. No fixtures, odds, predictions, or tickets are fabricated.",
    };

    if (probe !== true) return Object.freeze({ ...report, liveHealth: null, probed: false });

    const liveHealth = await manager.health();
    return Object.freeze({
      ...report,
      probed: true,
      liveHealth,
      // Stamped so a reading taken now cannot be mistaken for an observation with
      // a history behind it.
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
      // Stated as a fact about this slice rather than implied by empty arrays: there
      // is no repository, so nothing this module reads can be stored.
      persistence: false,
      notPortedAreas: SPORTS_NOT_PORTED.length,
      ticketEngine: "NOT_PORTED",
      reason: configured
        ? "Providers are configured from the environment. No fixture, odds or result is persisted in this slice, and no prediction, ticket, settlement, calibration or backtest can be produced. Derived health is UNKNOWN because no observation is stored; the authenticated GET /api/v1/sports/status reports the same and can probe on request."
        : "No sports provider is configured, so no fixture, odds, prediction or ticket can be produced and nothing is fabricated to fill the gap.",
    });
  }

  return Object.freeze({
    status,
    statusSnapshot,
    readFixtures,
    readOdds,
    readResults,
    /** The registry itself, for callers that need the fallback chain directly. */
    providers: manager,
    /** `PROVIDER_STATUS`, re-exported so a route does not import two modules. */
    statuses: PROVIDER_STATUS,
  });
}
