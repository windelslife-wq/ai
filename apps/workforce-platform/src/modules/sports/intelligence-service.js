/**
 * The Sports Intelligence decision service (row 14, slices 3 and 5).
 *
 * This is the orchestration layer over the pure ports in this directory. It loads the
 * inputs a decision needs, runs the chain, stores the result, and audits it. It never
 * computes a probability, a value or a gate itself: those live in `intelligence.js`,
 * `calibration.js` and `configuration.js`, and the parity test holds them to legacy's
 * output value for value.
 *
 * Slice 5 completes the measured half: `fitCalibration` fits on the platform's own
 * settled outcomes and stores the result as PENDING, and `modelPerformance` measures
 * accuracy, Brier, ECE and the ticket aggregates from the same outcomes. What this
 * service still does NOT do:
 *
 *  - **It cannot size a stake.** The configured fixed stake is recorded on each
 *    ticket; sizing from bankroll or edge has no ported implementation.
 *  - **It cannot place a bet or execute anything.** A decision, a settlement and a
 *    fit are records. Nothing here reaches a paper, execution or broker path.
 *
 * Predictions are immutable: this service inserts them and reads them, and there is no
 * method to change one.
 */
import { randomBytes } from "node:crypto";

import { AppError } from "../../http/errors.js";
import { phpEmpty } from "../../lib/php.js";
import { FEATURE_VERSION, MODEL_NAME, MODEL_VERSION, evaluatePrediction } from "./intelligence.js";
import { assessProviderHealth } from "./health-monitor.js";
import { assessQuality } from "./quality.js";
import { calibrationVersion, fitCalibration as fitFromOutcomes } from "./calibration.js";
import { metricsFromOutcomes } from "./model-performance.js";
import {
  CONFIGURATION_FIELDS,
  changedConfigurationFields,
  defaultConfiguration,
  planConfigurationUpdate,
} from "./configuration.js";
import {
  DEFAULT_WINDOW_DAYS,
  MAX_WINDOW_DAYS,
  inWindow,
  windowStartSeconds,
} from "./model-performance.js";

/** The market and selection the chain predicts. Fixed: legacy's pipeline is one market. */
export const MARKET = "TOTAL_GOALS";
export const SELECTION = "OVER_1_5";

/** Correlation is not computed until slice 4. `UNKNOWN` is stored, never a placeholder class. */
export const CORRELATION_PENDING = "UNKNOWN";

/** Reads are bounded: a single response never grows with the number of decisions. */
const LIST_LIMIT = 500;

/**
 * The most settled outcomes one measurement read may load. Legacy's
 * `predictionOutcomes()` has no bound; this one does, and reports when it bites, so a
 * fit on a very large history knows its sample was cut rather than complete.
 */
const OUTCOME_LIMIT = 5000;

/** A new prediction id, `prd_` + 24 lower-case hex, as legacy's `bin2hex(random_bytes(12))`. */
export function newPredictionId() {
  return `prd_${randomBytes(12).toString("hex")}`;
}

/** The gate verdict a stored decision implies. Legacy's `QUALIFIED`/`REJECTED`, derived, not stored. */
export function gateOf(rejectionReasons) {
  const reasons = Array.isArray(rejectionReasons) ? rejectionReasons : [];
  return { decision: reasons.length === 0 ? "QUALIFIED" : "REJECTED", rejectionReasons: reasons };
}

/**
 * Map a stored quality row to the shape the chain reads. The chain was written against
 * `assessQuality`'s result, so the storage names are translated here, in one place.
 */

/**
 * Seconds since an instant, or `null` when there is no instant. An instant that does not
 * parse is `Number.MAX_SAFE_INTEGER`: it was never observed, which is how legacy reads a
 * failed `DateTimeImmutable`.
 */
function ageSecondsOf(instant, nowSec) {
  if (typeof instant !== "string" || instant === "") return null;
  const at = Date.parse(instant);
  if (!Number.isFinite(at)) return Number.MAX_SAFE_INTEGER;
  return Math.max(0, nowSec - Math.floor(at / 1000));
}

/** A stored calibration as the chain reads it: approved only, with the camelCase version it logs. */
function calibrationFromRow(row) {
  if (!row) return null;
  return {
    method: row.method,
    intercept: Number(row.intercept),
    slope: Number(row.slope),
    ece: Number(row.ece),
    samples: Number(row.samples),
    approved_at: row.approved_at,
    calibrationVersion: row.calibration_version,
  };
}

/**
 * Create the intelligence service.
 *
 * @param {object} options
 * @param {object|null} options.store the repository (the store adapter)
 * @param {() => number} [options.now] epoch milliseconds
 */
export function createSportsIntelligenceService({ store = null, now = () => Date.now() } = {}) {
  const requireStore = () => {
    if (!store) {
      throw new AppError(503, "SPORTS_PERSISTENCE_UNAVAILABLE",
        "This host has no sports repository, so decisions cannot be read or recorded");
    }
    return store;
  };
  const nowIso = () => new Date(now()).toISOString();
  const nowSeconds = () => Math.floor(now() / 1000);

  /**
   * The provider's reliability now, as legacy's `provider->health()['reliability']` gives
   * it: derived from the stored health observations and sync runs by the same monitor the
   * status route uses. A provider that is not in the registry is 0, as legacy's `?? 0` gives.
   */
  async function providerReliability(providerId) {
    const repository = requireStore();
    const providers = await repository.listSportsProviders();
    const provider = providers.find((candidate) => Number(candidate.id) === Number(providerId)) ?? null;
    if (provider === null) return 0;
    const healthRows = await repository.listSportsHealth(Number(provider.id), 20);
    const runRows = await repository.listSportsSyncRuns({ providerId: Number(provider.id) }, 20);
    const derived = assessProviderHealth(provider, healthRows, runRows, nowSeconds());
    const reliability = Number(derived.reliability);
    return Number.isFinite(reliability) ? reliability : 0;
  }

  /**
   * Re-assess data quality now, as legacy's `DailyTicketService::qualityContext` does before
   * it evaluates: the odds in use, the age of those odds (or of the fixture when there are
   * none), the provider's current reliability, and recent form. An age that cannot be read
   * is "never observed", as legacy's `PHP_INT_MAX` is.
   *
   * The stored assessment is not read and no row is written. The sync stays the only writer
   * of quality rows, and the decision records the assessment it actually used.
   */
  async function currentQuality(match, odds) {
    const fixture = match.payload && typeof match.payload === "object" ? match.payload : {};
    const nowSec = nowSeconds();
    const reliability = await providerReliability(match.provider_id);
    let age = ageSecondsOf(odds?.observed_at, nowSec);
    if (age === null) age = ageSecondsOf(match.source_timestamp, nowSec);
    return assessQuality(fixture, {
      oddsAvailable: odds !== null,
      // Legacy reads `$match['context']['recentForm']`; the normalized fixture keeps it there.
      recentFormAvailable: !phpEmpty(fixture.context?.recentForm),
      providerReliability: reliability,
      dataAgeSeconds: age ?? Number.MAX_SAFE_INTEGER,
      maxAgeSeconds: 3600,
    });
  }

  /**
   * Load everything a decision reads, in one place, so a read and a write cannot disagree
   * about the inputs. The odds are the latest stored observation, the quality is re-assessed
   * from them now (F-38), the newest approved calibration is used, and the configuration in
   * force applies.
   */
  async function loadInputs(matchId) {
    const repository = requireStore();
    const id = Number(matchId);
    if (!Number.isInteger(id) || id < 1) {
      throw new AppError(400, "INVALID_MATCH_ID", "A match id must be a positive integer");
    }
    const match = await repository.findSportsMatchById(id);
    if (!match) throw AppError.notFound(`No stored fixture with id ${id}`);
    const [odds, calibrations, configuration] = await Promise.all([
      repository.latestSportsOdds(id, MARKET, SELECTION),
      repository.listSportsCalibrations({ status: "APPROVED" }, 1),
      repository.activeSportsConfiguration(),
    ]);
    const calibrationRow = calibrations[0] ?? null;
    const oddsRow = odds ?? null;
    return {
      matchId: id,
      match,
      odds: oddsRow,
      quality: await currentQuality(match, oddsRow),
      calibrationRow,
      calibration: calibrationFromRow(calibrationRow),
      config: configuration ?? defaultConfiguration(),
    };
  }

  /** Run the pure chain over loaded inputs. Persists nothing. */
  function runChain(inputs) {
    return evaluatePrediction({
      match: inputs.match,
      odds: inputs.odds,
      quality: inputs.quality ?? undefined,
      calibration: inputs.calibration,
      config: inputs.config,
      now: nowSeconds(),
    });
  }

  /**
   * The read-only preview: what the chain would conclude right now, with nothing stored.
   * Quality is re-assessed on every call, so `qualityAssessed` is true for any stored
   * fixture. It stays in the response so its shape does not change. Recording one is
   * the same computation, stored (below).
   */
  async function matchIntelligence(matchId) {
    const inputs = await loadInputs(matchId);
    const result = runChain(inputs);
    return Object.freeze({
      matchId: inputs.matchId,
      persisted: false,
      qualityAssessed: inputs.quality !== null,
      calibrated: inputs.calibration !== null,
      evaluation: summarize(result),
    });
  }

  function summarize(result) {
    return {
      decision: result.prediction?.decision ?? "NO_PREDICTION",
      gate: gateOf(result.rejectionReasons),
      prediction: result.prediction ?? null,
      value: result.value ?? null,
      confidence: result.confidence ?? null,
      risk: result.risk ?? null,
      factors: result.factors ?? {},
    };
  }

  /**
   * Record a decision for one fixture, from the quality re-assessed now (F-38). A fixture
   * that is not in the store is a 404, from `loadInputs`. There is no refusal for a missing
   * stored assessment, because none is read.
   */
  /**
   * Store one decision: the model version it was made under, then the immutable prediction,
   * then (when `audit` is true) an audit event. `evaluateMatch` audits each decision. The
   * daily ticket run persists many decisions and audits the run once, so it passes
   * `audit: false`. Both paths therefore write the same row shape.
   */
  async function persistDecision(inputs, result, { actorId = null, audit = true } = {}) {
    const repository = requireStore();
    const model = await repository.ensureSportsModelVersion({
      modelName: MODEL_NAME,
      modelVersion: MODEL_VERSION,
      featureVersion: FEATURE_VERSION,
      // Empty when no calibration is approved: the column is NOT NULL and '' names "uncalibrated".
      calibrationVersion: inputs.calibrationRow?.calibration_version ?? "",
      createdAt: nowIso(),
    });

    const prediction = await repository.saveSportsPrediction({
      id: newPredictionId(),
      matchId: inputs.matchId,
      modelVersionId: model.id,
      market: result.market ?? MARKET,
      selection: result.selection ?? SELECTION,
      rawProbability: result.prediction?.rawModelProbability ?? null,
      calibratedProbability: result.prediction?.calibratedProbability ?? null,
      impliedProbability: result.value?.impliedProbability ?? null,
      expectedValue: result.value?.expectedValue ?? null,
      confidence: result.confidence?.confidence ?? null,
      risk: result.risk?.classification ?? "REJECTED",
      correlation: CORRELATION_PENDING,
      dataQualityScore: inputs.quality.score,
      decision: result.prediction?.decision ?? "NO_PREDICTION",
      // The gate's full list, not only its first reason, so the decision can be re-read later.
      rejectionReasons: result.rejectionReasons ?? [],
      factors: result.factors ?? {},
      inputVersion: FEATURE_VERSION,
      odds: result.odds ?? null,
      oddsTimestamp: result.oddsTimestamp ?? null,
      createdAt: nowIso(),
    });

    if (audit) {
      await repository.recordAudit({
        actorId,
        action: "sports.decision.recorded",
        entityType: "sports_prediction",
        entityId: prediction.id,
        details: {
          matchId: inputs.matchId,
          modelVersionId: model.id,
          decision: prediction.decision,
          gate: gateOf(prediction.rejection_reasons).decision,
          rejectionReasons: prediction.rejection_reasons,
        },
      });
    }
    return Object.freeze({ prediction, modelVersionId: model.id });
  }

  /**
   * Record a decision for one fixture, from the quality re-assessed now (F-38). A fixture
   * that is not in the store is a 404, from `loadInputs`. There is no refusal for a missing
   * stored assessment, because none is read.
   */
  async function evaluateMatch({ matchId, actorId = null }) {
    const inputs = await loadInputs(matchId);
    const result = runChain(inputs);
    const { prediction } = await persistDecision(inputs, result, { actorId });
    return Object.freeze({
      persisted: true,
      prediction,
      gate: gateOf(prediction.rejection_reasons),
    });
  }

  async function listPredictions(filter = {}, limit = 50) {
    const rows = await requireStore().listSportsPredictions(filter, limit);
    return rows.map((row) => ({ ...row, gate: gateOf(row.rejection_reasons).decision }));
  }

  /** One stored decision, with its gate verdict and the factors that produced it. */
  async function predictionDecision(predictionId) {
    const row = await requireStore().findSportsPrediction(predictionId);
    if (!row) throw AppError.notFound("No stored prediction with that id");
    return Object.freeze({ prediction: row, gate: gateOf(row.rejection_reasons) });
  }

  /** The configuration in force. `source` says whether it was stored or is the built-in default. */
  async function configuration() {
    const row = await requireStore().activeSportsConfiguration();
    return Object.freeze({
      configuration: row ?? defaultConfiguration(),
      source: row ? "stored" : "default",
    });
  }

  async function configurationVersions(limit = 50) {
    return requireStore().listSportsConfigurations(limit);
  }

  /**
   * Publish the next configuration version. Append-only: a version is never edited, and
   * the audit record names exactly the fields that changed.
   *
   * `reason` is required (legacy's `ConfigurationService::update` refuses without one),
   * and `AUTOMATED_EXECUTION` is refused in every case: this deployment has no automated
   * execution, and the allow-flag is not something a request can set (DV-14).
   */
  async function updateConfiguration({ patch = {}, reason = "", actorId = null }) {
    const repository = requireStore();
    const trimmed = String(reason ?? "").trim();
    if (trimmed === "") {
      throw new AppError(422, "CONFIGURATION_REASON_REQUIRED", "A configuration change must say why it was made");
    }
    const base = (await repository.activeSportsConfiguration()) ?? defaultConfiguration();
    const planned = planConfigurationUpdate(base, patch ?? {}, {
      actor: actorId ?? "system",
      reason: trimmed,
      allowAutomatedExecution: false,
      createdAt: nowIso(),
    });
    if (!planned.ok) {
      throw new AppError(422, "SPORTS_CONFIGURATION_INVALID", planned.reason);
    }
    const saved = await repository.saveSportsConfiguration(planned.row);
    if (saved === null) {
      throw new AppError(409, "SPORTS_CONFIGURATION_CONFLICT",
        "Another change was saved first. Read the configuration again and retry");
    }
    await repository.recordAudit({
      actorId,
      action: "sports.configuration.updated",
      entityType: "sports_configuration",
      entityId: String(saved.version),
      details: {
        version: saved.version,
        previousVersion: base.version,
        changed: changedConfigurationFields(base, planned.next),
        reason: trimmed,
      },
    });
    return Object.freeze({ configuration: saved, changed: changedConfigurationFields(base, planned.next) });
  }

  async function listModels() {
    return requireStore().listSportsModelVersions();
  }

  /**
   * Model performance over a window — measured, as of slice 5.
   *
   * Every metric below is computed from stored settled outcomes and settled tickets.
   * `samples: 0` with null metrics is still the honest shape when nothing has settled
   * yet — but it is now a measurement of an empty history, not a statement that
   * measurement is impossible. `outcomesAvailable` says which of the two a reader is
   * looking at, and `comparison` is legacy's per-model side-by-side
   * (`ModelPerformanceService::compare`), each model's metrics measured in the same
   * window. Ticket metrics are measured per model in `comparison`; the top-level
   * `tickets` block is the same measurement across every model.
   */
  async function modelPerformance({ windowDays = DEFAULT_WINDOW_DAYS } = {}) {
    const repository = requireStore();
    const days = Math.min(MAX_WINDOW_DAYS, Math.max(1, Math.trunc(Number(windowDays) || DEFAULT_WINDOW_DAYS)));
    const since = windowStartSeconds(nowSeconds(), days);
    const sinceIso = new Date(since * 1000).toISOString();
    const recent = (await repository.listSportsPredictions({}, LIST_LIMIT))
      .filter((row) => inWindow(row.created_at, since));
    const outcomes = (await repository.listSportsPredictionOutcomes(null, OUTCOME_LIMIT))
      .filter((row) => inWindow(row.created_at, since));
    const windowSelections = await repository.listSportsSettledSelections({ from: sinceIso }, OUTCOME_LIMIT);
    const settledSelections = windowSelections.filter((row) => row._settled === 1);
    return Object.freeze({
      window: { days, since: new Date(since * 1000).toISOString() },
      predictions: recent.length,
      readyPredictions: recent.filter((row) => row.decision === "PREDICTION_READY").length,
      // `truncated` is stated, not hidden: the count is exact only below the read bound.
      truncated: recent.length >= LIST_LIMIT || outcomes.length >= OUTCOME_LIMIT,
      outcomesAvailable: true,
      samples: outcomes.length,
      metrics: metricsFromOutcomes(outcomes),
      tickets: ticketsFromSelections(settledSelections, windowSelections),
      // Legacy's `compare($window)`: every model version side by side, measured.
      // Each entry also snapshots one `live` metrics row, as legacy's metricsFor does.
      comparison: await modelComparison(days),
    });
  }

  /** All model versions with measured metrics for one window (legacy's `compare`). */
  async function modelComparison(windowDays) {
    const repository = requireStore();
    const models = await repository.listSportsModelVersions();
    const sinceIso = new Date(windowStartSeconds(nowSeconds(), windowDays) * 1000).toISOString();
    const out = [];
    for (const model of models) {
      const outcomes = (await repository.listSportsPredictionOutcomes(model.id, OUTCOME_LIMIT))
        .filter((row) => inWindow(row.created_at, windowStartSeconds(nowSeconds(), windowDays)));
      const windowSelections = await repository.listSportsSettledSelections({
        from: sinceIso,
        modelVersionId: model.id,
      }, OUTCOME_LIMIT);
      out.push({
        id: Number(model.id),
        modelName: model.model_name,
        modelVersion: model.model_version,
        featureVersion: model.feature_version,
        calibrationVersion: model.calibration_version ?? null,
        status: model.status,
        createdAt: model.created_at,
        metrics: {
          ...metricsFromOutcomes(outcomes),
          ...ticketsFromSelections(windowSelections.filter((row) => row._settled === 1), windowSelections),
        },
      });
    }
    return out;
  }

  /**
   * The ticket-level metrics for a set of settled selections, with legacy's allocation:
   * one ticket's stake and P/L are shared equally across ALL its legs — settled or not —
   * which is the denominator legacy divides by. `allSelections` (the window's legs,
   * settled or not) supplies that count; when it is omitted the settled rows stand in
   * for it. An empty history measures nothing: every metric stays null.
   */
  function ticketsFromSelections(settledSelections, allSelections = null) {
    const settledTickets = new Set(settledSelections.map((s) => String(s.ticket_id)));
    const metrics = {
      status: "MEASURED",
      settledTickets: settledTickets.size,
      winRate: null,
      roi: null,
      maxDrawdown: null,
      byMarket: {},
      byLeague: {},
    };
    if (settledSelections.length === 0) return metrics;
    const legCounts = new Map();
    for (const s of allSelections ?? settledSelections) {
      const ticketId = String(s.ticket_id);
      legCounts.set(ticketId, (legCounts.get(ticketId) ?? 0) + 1);
    }
    let stakeSum = 0;
    let pnlSum = 0;
    let hasStake = false;
    let cum = 0;
    let peak = 0;
    let maxDd = 0;
    const byMarket = new Map();
    const byLeague = new Map();
    for (const s of settledSelections) {
      const n = Math.max(1, legCounts.get(String(s.ticket_id)) ?? 1);
      const stake = s.ticket_stake !== null && s.ticket_stake !== undefined ? Number(s.ticket_stake) / n : null;
      const pnl = s.ticket_pnl !== null && s.ticket_pnl !== undefined ? Number(s.ticket_pnl) : null;
      if (pnl !== null && stake !== null) {
        const pnlSel = pnl / n;
        hasStake = true;
        pnlSum += pnlSel;
        stakeSum += stake;
        cum += pnlSel;
        peak = Math.max(peak, cum);
        maxDd = Math.max(maxDd, peak - cum);
      }
      for (const [group, label] of [["byMarket", s.market ?? "UNKNOWN"], ["byLeague", s.competition ?? "UNKNOWN"]]) {
        const bucket = group === "byMarket" ? byMarket : byLeague;
        if (!bucket.has(label)) bucket.set(label, { n: 0, won: 0 });
        const entry = bucket.get(label);
        entry.n += 1;
        if (String(s.status) === "WON") entry.won += 1;
      }
    }
    const toOut = (bucket) => Object.fromEntries(
      [...bucket.entries()].map(([label, b]) => [label, { ...b, winRate: Math.round((b.won / b.n) * 10 ** 4) / 10 ** 4 }]),
    );
    const decisive = settledSelections.filter((s) => s.status === "WON" || s.status === "LOST").length;
    const won = settledSelections.filter((s) => s.status === "WON").length;
    metrics.winRate = decisive ? Math.round((won / decisive) * 10 ** 5) / 10 ** 5 : null;
    metrics.roi = (hasStake && stakeSum > 0) ? Math.round((pnlSum / stakeSum) * 10 ** 5) / 10 ** 5 : null;
    metrics.maxDrawdown = hasStake ? Math.round(maxDd * 10 ** 4) / 10 ** 4 : null;
    metrics.byMarket = toOut(byMarket);
    metrics.byLeague = toOut(byLeague);
    return metrics;
  }

  async function listCalibrations(filter = {}, limit = 50) {
    return requireStore().listSportsCalibrations(filter, limit);
  }

  /**
   * Fit a calibration from stored settled outcomes.
   *
   * Slice 5 makes this real. The outcomes are the platform's own — predictions joined
   * to VERIFIED finished results, which is why no fit was possible before settlement.
   * The pure fit (parity-tested since slice 3) runs on them; a refusal from the fit
   * (not enough samples, or no class coverage) is a 422 with the fit's own reason and
   * nothing is stored. A fit that succeeds is stored as PENDING: it is not usable until
   * an administrator approves it, which is the gate the whole design rests on.
   */
  async function fitCalibration({ actorId = null } = {}) {
    const repository = requireStore();
    const outcomes = await repository.listSportsPredictionOutcomes(null, OUTCOME_LIMIT);
    const fit = fitFromOutcomes(outcomes);
    if (!fit.ok) {
      throw new AppError(422, "CALIBRATION_CANNOT_BE_FITTED",
        `calibration cannot be fitted: ${fit.reason} (samples: ${fit.samples ?? 0})`);
    }
    const model = await repository.ensureSportsModelVersion({
      modelName: MODEL_NAME,
      modelVersion: MODEL_VERSION,
      featureVersion: FEATURE_VERSION,
      createdAt: nowIso(),
    });
    const saved = await repository.saveSportsCalibration({
      fit: {
        ...fit.fit,
        ece: fit.metrics.ece,
        brier: fit.metrics.brier,
        identityBrier: fit.metrics.identityBrier,
        bins: fit.bins,
      },
      modelVersionId: model.id,
      calibrationVersion: calibrationVersion(fit.fit),
      createdBy: actorId ?? "system",
      createdAt: nowIso(),
    });
    await repository.recordAudit({
      actorId,
      action: "sports.calibration.fitted",
      entityType: "sports_calibration",
      entityId: String(saved.id),
      details: {
        calibrationId: saved.id,
        samples: fit.fit.samples,
        ece: fit.metrics.ece,
        brier: fit.metrics.brier,
        identityBrier: fit.metrics.identityBrier,
        message: "New calibration version fitted (pending approval)",
      },
    });
    return Object.freeze({ calibration: saved });
  }

  /**
   * Approve or reject a PENDING calibration. The decision is compare-and-set in the
   * repository, so two administrators racing on one row cannot both succeed.
   */
  async function decideCalibration({ id, decision, actorId = null }) {
    const repository = requireStore();
    const current = await repository.findSportsCalibration(id);
    if (!current) throw AppError.notFound("No calibration with that id");
    if (current.status !== "PENDING") {
      throw new AppError(409, "CALIBRATION_NOT_PENDING", `This calibration is already ${current.status}`);
    }
    const decided = await repository.decideSportsCalibration(id, decision, actorId, nowIso());
    if (decided === null) {
      throw new AppError(409, "CALIBRATION_NOT_PENDING", "This calibration was decided by another request");
    }
    await repository.recordAudit({
      actorId,
      action: decision === "APPROVED" ? "sports.calibration.approved" : "sports.calibration.rejected",
      entityType: "sports_calibration",
      entityId: String(decided.id),
      details: { calibrationVersion: decided.calibration_version, modelVersionId: decided.model_version_id },
    });
    return Object.freeze({ calibration: decided });
  }

  return Object.freeze({
    matchIntelligence,
    evaluateMatch,
    // Exposed for the daily ticket run (slice 4), which must read and persist the same way a
    // single evaluation does. It must not reimplement either step.
    loadInputs,
    runChain,
    persistDecision,
    listPredictions,
    predictionDecision,
    configuration,
    configurationVersions,
    updateConfiguration,
    listModels,
    modelPerformance,
    listCalibrations,
    fitCalibration,
    decideCalibration,
    /** The configurable fields, exported so the route schema cannot drift from them. */
    configurationFields: CONFIGURATION_FIELDS,
    market: MARKET,
    selection: SELECTION,
  });
}
