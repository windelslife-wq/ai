/**
 * The per-match decision chain — ports of legacy `MatchIntelligenceEngine`,
 * `FeatureEngineeringEngine`, `PredictionEngine`, `ValueEngine`, `ConfidenceEngine`,
 * `RiskEngine` and `PredictionPipeline` (Phase 17, row 14 slice 3).
 *
 *   match + odds → match intelligence → features → prediction → calibration
 *     → value → confidence → risk → gate (do-not-predict)
 *
 * Every stage is pure. Inputs are plain objects, time is passed in as epoch seconds
 * (PHP's `time()`), and nothing reads the database. The service layer is responsible
 * for loading rows, calling `evaluatePrediction`, and persisting the result, so the
 * whole chain can be checked against the PHP oracle without a store.
 *
 * Legacy behaviour that is kept on purpose, because the parity harness depends on it:
 *
 *  - `PredictionPipeline` hard-codes `correlation: LOW` on every candidate. Legacy
 *    constructs `CorrelationEngine` and never calls it; the port does the same and the
 *    field is documented as a placeholder, not a measurement (slice 4 replaces it).
 *  - The gate's `(conf ?? 0) !== null` test is always true, so `LOW_CONFIDENCE` is
 *    appended on the NO_PREDICTION path whenever `min_confidence > 0`. Quirk Q-2.
 *  - `!empty($value['qualified']) === false` is written with a precedence that makes
 *    it mean "qualified is empty". Ported as written, so it reads as `phpEmpty`.
 *
 * Legacy behaviour that is deliberately NOT kept, each recorded as a divergence:
 *
 *  - The calibrated probability is the logistic map of `intercept + slope * raw`
 *    (DV-12, finding F-37). Legacy `PredictionEngine` uses the linear form, which
 *    contradicts the function the calibration was fitted under.
 */

import { phpRound, phpEmpty, phpFloat, phpInt, phpIsNumeric, phpIsset, isPhpArray } from "../../lib/php.js";
import { formatGmdateC } from "../../lib/php-date.js";
import { assessOddsFreshness } from "./quality.js";
import { applyFittedCalibration } from "./calibration.js";

export const FEATURE_VERSION = "sports-features-v1";
export const MODEL_NAME = "WINDELS Sports Baseline";
export const MODEL_VERSION = "1.0.0";
export const CONFIDENCE_CAP = 95;
export const MAX_ODDS_MOVEMENT = 0.5;
export const GATE_PASSED_REASONS = Object.freeze([
  "INTELLIGENCE_READY",
  "PREDICTION_READY",
  "POSITIVE_VALUE",
  "RISK_APPROVED",
  "CONFIDENCE_OK",
  "WITHIN_CONFIGURATION",
]);

const FORM_KEYS = Object.freeze(["homeGoalsPerMatch", "awayGoalsPerMatch", "homeConcededPerMatch", "awayConcededPerMatch"]);

/** PHP `strtoupper()` is ASCII-only; `toUpperCase()` also rewrites non-ASCII letters. */
function asciiUpper(text) {
  return text.replace(/[a-z]+/g, (run) => run.toUpperCase());
}

/**
 * Match intelligence: which inputs are present, whether the odds are usable, and
 * whether the match may proceed at all. Legacy `MatchIntelligenceEngine::analyze`.
 *
 * @param {Record<string, any>} match a stored match row or normalized fixture
 * @param {Record<string, any>|null} latestOdds the latest odds observation, or null
 * @param {Record<string, any>} [verifiedContext] caller-supplied context that overrides
 *   the stored `payload.context`
 * @param {number|null} [now] epoch seconds; defaults to the wall clock
 */
export function analyzeMatchIntelligence(match, latestOdds, verifiedContext = {}, now = null) {
  const clock = now ?? Math.floor(Date.now() / 1000);
  const source = isPhpArray(match) ? match : {};
  const payload = isPhpArray(source.payload) ? source.payload : {};
  const storedContext = isPhpArray(payload.context) ? payload.context : {};
  const context = { ...storedContext, ...(isPhpArray(verifiedContext) ? verifiedContext : {}) };

  const odds = assessOddsFreshness(latestOdds, phpInt(context.maxOddsAgeSeconds ?? 900), clock);
  const fields = {
    recentForm: context.recentForm ?? null,
    injuries: context.injuries ?? null,
    lineups: context.lineups ?? null,
    historical: context.historical ?? null,
    marketLiquidity: context.marketLiquidity ?? null,
    restDays: context.restDays ?? null,
  };
  const unavailableInputs = Object.keys(fields).filter((key) => fields[key] === null);
  const status = asciiUpper(String(source.status ?? "UNKNOWN"));

  const rejections = [];
  if (!["SCHEDULED", "LIVE"].includes(status)) rejections.push("MATCH_STATUS_INVALID");
  if (latestOdds === null || latestOdds === undefined) rejections.push("ODDS_UNAVAILABLE");
  else if (!odds.available) rejections.push("ODDS_UNAVAILABLE");
  else if (!odds.fresh) rejections.push(odds.reason ?? "STALE_ODDS");
  if (phpEmpty(fields.recentForm)) rejections.push("INSUFFICIENT_DATA");
  if (fields.marketLiquidity !== null && phpFloat(fields.marketLiquidity) < 1) rejections.push("INSUFFICIENT_LIQUIDITY");

  return {
    match: {
      id: source.id ?? null,
      homeTeam: source.home_team ?? source.homeTeam ?? null,
      awayTeam: source.away_team ?? source.awayTeam ?? null,
      competition: source.competition ?? null,
      kickoff: source.kickoff_at ?? source.kickoff ?? null,
      status,
      simulated: !phpEmpty(payload.simulated),
    },
    odds: latestOdds ?? null,
    oddsFreshness: odds,
    inputs: fields,
    unavailableInputs,
    rejectionReasons: [...new Set(rejections)],
    decision: rejections.length > 0 ? "NO_QUALIFIED_TICKET" : "INTELLIGENCE_READY",
    generatedAt: formatGmdateC(new Date(clock * 1000)),
  };
}

/**
 * Versioned features. Built only from explicitly numeric recent-form inputs; a missing
 * or non-numeric value is `INSUFFICIENT_DATA`, never a default. Legacy
 * `FeatureEngineeringEngine::build`.
 *
 * @param {Record<string, any>} intelligence an `analyzeMatchIntelligence` result
 */
export function buildFeatures(intelligence) {
  const insufficient = { ok: false, reason: "INSUFFICIENT_DATA", version: FEATURE_VERSION, features: {} };
  if ((intelligence?.decision ?? "") !== "INTELLIGENCE_READY") return insufficient;

  const form = intelligence.inputs?.recentForm ?? null;
  for (const key of FORM_KEYS) {
    if (!isPhpArray(form) || !phpIsset(form[key]) || !phpIsNumeric(form[key])) return insufficient;
  }

  const features = {
    expectedGoalsProxy: phpRound(
      (phpFloat(form.homeGoalsPerMatch) + phpFloat(form.awayGoalsPerMatch)
        + phpFloat(form.homeConcededPerMatch) + phpFloat(form.awayConcededPerMatch)) / 2,
      4,
    ),
    homeAttack: phpFloat(form.homeGoalsPerMatch),
    awayAttack: phpFloat(form.awayGoalsPerMatch),
    homeDefenseConceded: phpFloat(form.homeConcededPerMatch),
    awayDefenseConceded: phpFloat(form.awayConcededPerMatch),
  };
  return {
    ok: true,
    version: FEATURE_VERSION,
    features,
    inputSources: { recentForm: form.source ?? null },
  };
}

function noPrediction(reason, featureSet) {
  return {
    decision: "NO_PREDICTION",
    reason,
    modelName: MODEL_NAME,
    modelVersion: MODEL_VERSION,
    featureVersion: featureSet?.version ?? FEATURE_VERSION,
  };
}

/**
 * The Over 1.5 baseline. Never predicts without an approved calibration.
 *
 * `calibration` is the calibration input object the pipeline builds, or null. The
 * calibrated probability uses `applyFittedCalibration`: the logistic map, or the raw
 * probability for an identity calibration (F-37, DV-12).
 *
 * @param {Record<string, any>} featureSet a `buildFeatures` result
 * @param {Record<string, any>|null} calibration
 */
export function predictOver15(featureSet, calibration) {
  if (phpEmpty(featureSet?.ok)) return noPrediction(featureSet?.reason ?? "INSUFFICIENT_DATA", featureSet);
  if (phpEmpty(calibration?.approved) || !phpIsset(calibration?.intercept) || !phpIsset(calibration?.slope)) {
    return noPrediction("MODEL_NOT_CALIBRATED", featureSet);
  }

  const expectedGoals = featureSet.features.expectedGoalsProxy;
  // Logistic baseline from a verified feature; model details and version are stored with the output.
  const raw = 1 / (1 + Math.exp(-(expectedGoals - 1.5)));
  const calibrated = applyFittedCalibration(
    { method: calibration.method, intercept: phpFloat(calibration.intercept), slope: phpFloat(calibration.slope) },
    raw,
  );

  return {
    decision: "PREDICTION_READY",
    market: "TOTAL_GOALS",
    selection: "OVER_1_5",
    rawModelProbability: phpRound(raw, 6),
    calibratedProbability: phpRound(calibrated, 6),
    modelName: MODEL_NAME,
    modelVersion: MODEL_VERSION,
    featureVersion: featureSet.version,
    calibrationVersion: String(calibration.version ?? "unspecified"),
    inputSources: featureSet.inputSources,
  };
}

/**
 * Expected value of a prediction against a decimal price. Legacy `ValueEngine::assess`.
 *
 * @param {Record<string, any>} prediction
 * @param {{decimalOdds?: number}} odds
 */
export function assessValue(prediction, odds) {
  if ((prediction?.decision ?? "") !== "PREDICTION_READY") {
    return { qualified: false, reason: prediction?.reason ?? "NO_PREDICTION" };
  }
  const decimal = phpFloat(odds?.decimalOdds ?? 0);
  if (decimal <= 1) return { qualified: false, reason: "ODDS_UNAVAILABLE" };

  const implied = 1 / decimal;
  const calibrated = phpFloat(prediction.calibratedProbability);
  const expectedValue = calibrated * decimal - 1;
  return {
    qualified: expectedValue > 0,
    reason: expectedValue > 0 ? null : "LOW_MODEL_EDGE",
    odds: decimal,
    impliedProbability: phpRound(implied, 6),
    calibratedProbability: calibrated,
    expectedValue: phpRound(expectedValue, 6),
  };
}

/**
 * Confidence from data quality, calibration quality and probability separation.
 * Legacy `ConfidenceEngine::assess`. Capped at 95.
 *
 * @param {Record<string, any>} prediction
 * @param {Record<string, any>} quality
 * @param {Record<string, any>|null} calibration the calibration input, or null
 */
export function assessConfidence(prediction, quality, calibration) {
  if ((prediction?.decision ?? "") !== "PREDICTION_READY") {
    return { confidence: null, breakdown: null, reason: "NO_PREDICTION" };
  }

  const dataQuality = phpFloat(quality?.score ?? 0);
  let calibrationQuality = 0;
  if (calibration !== null && calibration !== undefined && phpIsset(calibration.ece)
    && phpIsNumeric(calibration.ece) && phpFloat(calibration.samples) >= 20) {
    calibrationQuality = 100 * Math.max(0, Math.min(1, 1 - phpFloat(calibration.ece)));
  }

  const probability = phpFloat(prediction.calibratedProbability ?? 0.5);
  const separation = Math.min(100, 400 * Math.abs(probability - 0.5));
  const confidence = Math.min(CONFIDENCE_CAP, 0.5 * dataQuality + 0.3 * calibrationQuality + 0.2 * separation);

  return {
    confidence: phpRound(confidence, 2),
    breakdown: {
      dataQuality: phpRound(dataQuality, 2),
      calibrationQuality: phpRound(calibrationQuality, 2),
      probabilitySeparation: phpRound(separation, 2),
    },
  };
}

/**
 * Risk classification and rejection. Legacy `RiskEngine::assess`.
 *
 * @param {Record<string, any>} value an `assessValue` result
 * @param {Record<string, any>} quality
 * @param {Record<string, any>} [config] the active configuration (snake_case or camelCase)
 * @param {Record<string, any>} [context] market context
 */
export function assessRisk(value, quality, config = {}, context = {}) {
  const cfg = isPhpArray(config) ? config : {};
  const ctx = isPhpArray(context) ? context : {};
  const minQuality = phpInt(cfg.min_data_quality ?? cfg.minDataQuality ?? 75);
  const minEv = phpFloat(cfg.min_expected_value ?? cfg.minExpectedValue ?? 0.02);
  const minConfidence = cfg.min_confidence ?? cfg.minConfidence ?? null;
  const minLiquidity = cfg.min_liquidity ?? cfg.minLiquidity ?? null;

  const reasons = [];
  if (!phpEmpty(ctx.marketSuspended)) reasons.push("MARKET_SUSPENDED");
  if (phpEmpty(value?.qualified)) reasons.push(value?.reason ?? "NO_PREDICTION");
  if (phpFloat(quality?.score ?? 0) < minQuality) reasons.push("LOW_DATA_QUALITY");
  if (phpEmpty(quality?.eligibleForTicket)) reasons.push("STALE_OR_INCOMPLETE_DATA");
  if (phpFloat(value?.expectedValue ?? -1) < minEv) reasons.push("LOW_MODEL_EDGE");
  if (minConfidence !== null && phpIsset(ctx.confidence) && phpIsNumeric(ctx.confidence)
    && phpFloat(ctx.confidence) < phpFloat(minConfidence)) reasons.push("LOW_CONFIDENCE");
  if (minLiquidity !== null && phpIsset(ctx.liquidity) && phpIsNumeric(ctx.liquidity)
    && phpFloat(ctx.liquidity) < phpFloat(minLiquidity)) reasons.push("INSUFFICIENT_LIQUIDITY");

  if (reasons.length > 0) {
    return { classification: "REJECTED", approved: false, reasons: [...new Set(reasons)] };
  }

  const score = phpFloat(quality?.score ?? 0);
  let risk;
  if (score >= 90 && phpFloat(value?.expectedValue ?? 0) >= 0.08) risk = "LOW";
  else if (score >= 80) risk = "MEDIUM";
  else risk = "HIGH";

  // Volatile market movement upgrades MEDIUM to HIGH and never downgrades.
  if (phpIsset(ctx.oddsMovement) && phpIsNumeric(ctx.oddsMovement)
    && Math.abs(phpFloat(ctx.oddsMovement)) > MAX_ODDS_MOVEMENT) {
    if (risk !== "HIGH") risk = "HIGH";
    reasons.push("ODDS_VOLATILE");
  }
  return { classification: risk, approved: risk !== "HIGH", reasons: [...new Set(reasons)] };
}

function oddsMovement(odds) {
  if (odds === null || odds === undefined) return null;
  const payload = isPhpArray(odds.payload) ? odds.payload : {};
  const opening = payload.openingDecimalOdds ?? odds.openingDecimalOdds ?? null;
  const current = phpFloat(odds.decimalOdds ?? odds.decimal_odds ?? 0);
  if (!phpIsNumeric(opening) || phpFloat(opening) <= 0) return null;
  return current - phpFloat(opening);
}

function decimalOf(odds) {
  return phpFloat(odds.decimalOdds ?? odds.decimal_odds ?? 0);
}

function observedAtOf(odds) {
  return odds.observedAt ?? odds.observed_at ?? null;
}

function finalize(candidate, factors, value, conf, risk, prediction, decision, rejectionReasons, predictionDecision) {
  return {
    ...candidate,
    value: value ?? { qualified: false, reason: rejectionReasons[0] ?? "NO_PREDICTION" },
    confidence: conf ?? { confidence: null, breakdown: null },
    risk: risk ?? { classification: "REJECTED", approved: false, reasons: rejectionReasons },
    prediction: prediction ?? {
      decision: predictionDecision,
      reason: rejectionReasons[0] ?? "NO_PREDICTION",
      modelName: MODEL_NAME,
      modelVersion: MODEL_VERSION,
      featureVersion: factors.featureVersion ?? FEATURE_VERSION,
    },
    decision,
    rejectionReasons: [...new Set(rejectionReasons)],
    factors,
  };
}

/**
 * The whole chain for one match, returning the candidate with every stage's inputs
 * recorded in `factors`, so that a decision can be reconstructed later.
 *
 * A rejected candidate keeps its explicit reasons. The chain never forces a prediction.
 * Legacy `PredictionPipeline::evaluate`.
 *
 * @param {object} args
 * @param {Record<string, any>} args.match
 * @param {Record<string, any>|null} args.odds the latest odds observation, or null
 * @param {Record<string, any>} args.quality an `assessQuality` result
 * @param {Record<string, any>|null} args.calibration an approved calibration row, or null
 * @param {Record<string, any>} [args.config] the active configuration
 * @param {number|null} [args.now] epoch seconds
 */
export function evaluatePrediction({ match, odds = null, quality, calibration = null, config = {}, now = null }) {
  const cfg = isPhpArray(config) ? config : {};
  const intel = analyzeMatchIntelligence(match, odds, {}, now);
  const oddsPresent = odds !== null && odds !== undefined;

  const factors = {
    drivers: {},
    odds: oddsPresent
      ? { decimal: decimalOf(odds), observedAt: observedAtOf(odds), ageSeconds: intel.oddsFreshness.ageSeconds ?? null }
      : null,
    calibration: null,
    quality: { score: quality?.score ?? 0, band: quality?.band ?? "UNKNOWN", missing: quality?.missing ?? [] },
    inputsUnavailable: intel.unavailableInputs ?? [],
    simulated: !phpEmpty(intel.match.simulated),
    gate: { passed: [], failed: [] },
  };

  const candidate = {
    matchId: match?.id ?? null,
    match: intel.match,
    market: "TOTAL_GOALS",
    selection: "OVER_1_5",
    odds: oddsPresent ? decimalOf(odds) : null,
    oddsTimestamp: oddsPresent ? observedAtOf(odds) : null,
    intelligence: intel,
    quality,
  };

  if ((intel.decision ?? "") !== "INTELLIGENCE_READY") {
    return finalize(candidate, factors, null, null, null, null, "REJECTED", intel.rejectionReasons ?? ["INSUFFICIENT_DATA"], "NO_PREDICTION");
  }

  const features = buildFeatures(intel);
  if (!phpEmpty(features.features)) factors.drivers = features.features;
  factors.featureVersion = features.version ?? null;

  const calibrationInput = calibration !== null && calibration !== undefined
    ? {
      approved: true,
      // The calibration's own method travels with it (slice 5): a stored identity
      // calibration measures on the raw probability (DV-19), everything else on the
      // logistic map (DV-12). Inputs without a method keep the logistic map, exactly
      // as every pre-slice-5 caller did.
      method: calibration.method ?? null,
      intercept: phpFloat(calibration.intercept),
      slope: phpFloat(calibration.slope),
      version: calibration.calibrationVersion ?? calibration.version ?? null,
      ece: calibration.ece ?? null,
      samples: calibration.samples ?? 0,
      approvedAt: calibration.approved_at ?? null,
    }
    : null;
  if (calibrationInput !== null) {
    factors.calibration = {
      version: calibrationInput.version,
      intercept: calibrationInput.intercept,
      slope: calibrationInput.slope,
      ece: calibrationInput.ece,
      samples: calibrationInput.samples,
      approvedAt: calibrationInput.approvedAt,
    };
  }

  const prediction = predictOver15(features, calibrationInput ?? []);
  if (!phpEmpty(prediction.market)) {
    candidate.market = prediction.market;
    candidate.selection = prediction.selection;
  }

  const value = assessValue(prediction, oddsPresent ? { decimalOdds: decimalOf(odds) } : { decimalOdds: 0 });
  const conf = assessConfidence(prediction, quality, calibrationInput);
  factors.confidence = conf.breakdown ?? null;

  const riskContext = {
    confidence: conf.confidence,
    liquidity: intel.inputs.marketLiquidity ?? null,
    marketSuspended: (oddsPresent && !phpEmpty(odds.suspended)) || (match?.status ?? "") === "SUSPENDED",
    oddsMovement: oddsMovement(odds ?? null),
  };
  const risk = assessRisk(value, quality, cfg, riskContext);

  Object.assign(candidate, {
    features,
    prediction,
    value,
    confidence: conf,
    risk,
    // Placeholder: legacy constructs CorrelationEngine and never calls it. Slice 4 replaces this.
    correlation: { classification: "LOW", reasons: [] },
  });

  const failed = [];
  if ((prediction.decision ?? "") !== "PREDICTION_READY") failed.push(prediction.reason ?? "NO_PREDICTION");
  if (!phpEmpty(cfg.require_calibration ?? 1) && calibrationInput === null) failed.push("MODEL_NOT_CALIBRATED");
  if (risk.classification === "REJECTED") failed.push(...(risk.reasons ?? ["HIGH_RISK"]));
  else if (risk.classification === "HIGH") failed.push("HIGH_RISK");
  // Ported as written: `!empty($q) === false` is "qualified is empty" (see module docblock).
  if (!phpEmpty(value.reason) && (prediction.decision ?? "") === "PREDICTION_READY" && phpEmpty(value.qualified)) {
    failed.push(value.reason);
  }
  // Quirk Q-2: `?? 0` never yields null, so this is always true, and LOW_CONFIDENCE
  // is appended on the NO_PREDICTION path whenever min_confidence > 0.
  if ((conf.confidence ?? 0) !== null && phpFloat(conf.confidence) < phpFloat(cfg.min_confidence ?? 0)) {
    failed.push("LOW_CONFIDENCE");
  }
  const allowedMarkets = cfg.allowed_markets ?? [];
  if (Array.isArray(allowedMarkets) && allowedMarkets.length > 0 && !allowedMarkets.includes(candidate.market)) {
    failed.push("OUTSIDE_CONFIGURATION");
  }
  const allowedLeagues = cfg.allowed_leagues ?? [];
  if (Array.isArray(allowedLeagues) && allowedLeagues.length > 0
    && !allowedLeagues.includes(candidate.match.competition ?? null)) {
    failed.push("OUTSIDE_CONFIGURATION");
  }

  const uniqueFailed = [...new Set(failed)];
  factors.gate.failed = uniqueFailed;
  factors.gate.passed = uniqueFailed.length > 0 ? [] : [...GATE_PASSED_REASONS];

  return finalize(
    candidate,
    factors,
    value,
    conf,
    risk,
    prediction,
    uniqueFailed.length > 0 ? "REJECTED" : "QUALIFIED",
    uniqueFailed,
    uniqueFailed.length > 0 ? "NO_PREDICTION" : "PREDICTION_READY",
  );
}
