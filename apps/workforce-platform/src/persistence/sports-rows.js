/**
 * The sports foundation's shared row shape — validators and column mappers used by
 * BOTH adapters.
 *
 * This file exists for one reason: `src/db/sports-repository.js` (MySQL) and the
 * sports section of `src/persistence/file-store.js` (file adapter) must describe the
 * same world, and the only way to guarantee that is for them to share the code that
 * defines it. A validator duplicated into two adapters drifts the first time one of
 * them is edited, and the drift is invisible until a host changes adapter — which is
 * exactly when it is most expensive to discover. `src/persistence/contract.js` does
 * the same job for method *names*; this does it for row *shapes*.
 *
 * Rows are snake_case with JSON columns decoded, which is the shape CodeIgniter's
 * `result_array()` plus `json_decode` produced. That is not an accident of porting:
 * Phase 15's `assessProviderHealth` reads `observed_at`, `started_at` and `status`
 * straight off these rows, and it is byte-compared against PHP by the differential
 * harness. Re-casing them here would break a class that has already been proven equal
 * to its original.
 *
 * Timestamps are canonical UTC (`…Z`) on the way in. See divergence SP-1 in
 * `docs/migration/PHASE16_SPORTS_PERSISTENCE.md`: the normalized payloads keep
 * legacy's `gmdate('c')` `+00:00` shape because they are the harness's subject, but
 * the columns hold one shape, because `listSportsMatches` really does issue
 * `kickoff_at >= ?` as a string comparison.
 */

import { parseStrictInstant } from "../lib/php-date.js";

// ── validators ────────────────────────────────────────────────────────────────
// Each one names the column it guards, because a refusal that reaches an operator
// through a sync run's `errors` array has to say which field was wrong.

export function assertProviderCode(value) {
  const code = String(value ?? "").trim();
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(code)) {
    throw new TypeError(`provider_code must be 1-64 characters of [A-Za-z0-9._-], received ${JSON.stringify(String(value ?? "").slice(0, 80))}`);
  }
  return code;
}

export function assertProviderName(value) {
  const name = String(value ?? "").trim();
  if (name.length === 0 || name.length > 120) {
    throw new TypeError(`display_name must be 1-120 characters, received ${name.length}`);
  }
  return name;
}

/** A positive integer id, for columns typed `INT UNSIGNED` / `BIGINT UNSIGNED`. */
export function assertRowId(value, label) {
  const id = Number(value);
  if (!Number.isInteger(id) || id < 1) {
    throw new TypeError(`${label} must be a positive integer, received ${JSON.stringify(value)}`);
  }
  return id;
}

/** A nullable positive integer id (`provider_id` is nullable on a sync run). */
export function optionalRowId(value, label) {
  if (value === null || value === undefined || value === "") return null;
  return assertRowId(value, label);
}

/**
 * A canonical UTC instant for a NOT NULL timestamp column.
 *
 * Strict on purpose. `kickoff_at`, `observed_at`, `assessed_at` and `started_at` are
 * the columns every ordering, windowing and staleness decision in this module is
 * made against; storing a guessed instant would make a downstream comparison wrong
 * in a way no reader of the row could detect.
 */
export function assertInstant(value, label) {
  const parsed = parseStrictInstant(value);
  if (!parsed) {
    throw new TypeError(`${label} must be an ISO-8601 calendar instant, received ${JSON.stringify(String(value ?? "").slice(0, 80))}`);
  }
  // Always `toISOString()`, milliseconds included, and never the shorter whole-second
  // spelling. These columns are compared as TEXT — `listSportsMatches` issues
  // `kickoff_at >= ?`, retention issues `observed_at < ?`, and every `ORDER BY … DESC`
  // in this module is a string sort. Text ordering is chronological only while every
  // value has the same width: `"…T12:34:56.789Z"` sorts BEFORE `"…T12:34:56Z"`
  // because `.` (0x2E) is less than `Z` (0x5A), even though it is 789 ms LATER. A
  // conditional trim therefore misorders two rows in the same second, and it does so
  // silently — the rows still look like valid timestamps to anyone reading them.
  // `assertIsoCutoff` in `contract.js` warns about exactly this hazard for
  // `wf_analysis_runs.completed_at`. Divergence SP-19.
  return parsed.toISOString();
}

/** A canonical UTC instant for a nullable timestamp column. */
export function optionalInstant(value, label) {
  if (value === null || value === undefined || value === "") return null;
  return assertInstant(value, label);
}

export const MATCH_STATUSES = Object.freeze(["SCHEDULED", "LIVE", "FINISHED", "POSTPONED", "CANCELLED", "SUSPENDED"]);
export const RESULT_STATUSES = Object.freeze(["FINISHED", "VOID", "CANCELLED", "POSTPONED", "SUSPENDED"]);
export const HEALTH_STATUSES = Object.freeze(["ONLINE", "DEGRADED", "OFFLINE", "RATE_LIMITED", "AUTHENTICATION_ERROR", "DATA_ERROR", "UNKNOWN"]);
export const SYNC_JOB_TYPES = Object.freeze(["FIXTURES", "ODDS", "RESULTS"]);
export const SYNC_STATUSES = Object.freeze(["RUNNING", "COMPLETED", "FAILED", "DUPLICATE_SKIPPED"]);

export function assertEnum(value, allowed, label) {
  const text = String(value ?? "").trim().toUpperCase();
  if (!allowed.includes(text)) {
    throw new TypeError(`${label} must be one of ${allowed.join(", ")}, received ${JSON.stringify(String(value ?? "").slice(0, 40))}`);
  }
  return text;
}

/** A bounded free-text column. Truncation would silently corrupt provenance, so refuse. */
export function assertText(value, max, label) {
  const text = String(value ?? "");
  if (text.length > max) {
    throw new TypeError(`${label} must be at most ${max} characters, received ${text.length}`);
  }
  return text;
}

/**
 * `wf_sports_sync_runs.id` is a caller-supplied VARCHAR(36).
 *
 * It has to exist before the work starts so a crash mid-sync still leaves evidence
 * of the attempt, which is why it is not an auto-increment. Refusing anything that
 * is not UUID-shaped keeps the column meaningful: a sync run id that collides with
 * another run's would silently overwrite its evidence.
 */
export function assertSyncRunId(value) {
  const id = String(value ?? "").trim();
  if (!/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(id)) {
    throw new TypeError(`a sync run id must be a UUID, received ${JSON.stringify(id.slice(0, 80))}`);
  }
  return id;
}

/** `wf_sports_sync_runs.execution_key` is VARCHAR(128) and UNIQUE. */
export function assertExecutionKey(value) {
  const key = String(value ?? "").trim();
  if (key.length === 0 || key.length > 128) {
    throw new TypeError(`execution_key must be 1-128 characters, received ${key.length}`);
  }
  return key;
}

export function encodeJson(value) {
  return JSON.stringify(value ?? null);
}

export function decodeJson(text, fallback) {
  if (text === null || text === undefined || text === "") return fallback;
  try {
    const parsed = JSON.parse(String(text));
    return parsed === null || parsed === undefined ? fallback : parsed;
  } catch {
    return fallback;
  }
}

export function toInt(value, fallback = null) {
  if (value === null || value === undefined || value === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
}

/** DECIMAL columns come back from the driver as strings. */
export function toDecimal(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

// ── row mappers ───────────────────────────────────────────────────────────────

export function providerRow(row) {
  if (!row) return null;
  return {
    id: toInt(row.id),
    provider_code: String(row.provider_code),
    display_name: String(row.display_name),
    enabled: toInt(row.enabled, 0) === 1,
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

export function healthRow(row) {
  if (!row) return null;
  return {
    id: toInt(row.id),
    provider_id: toInt(row.provider_id),
    status: String(row.status),
    response_ms: toInt(row.response_ms),
    error_rate: toDecimal(row.error_rate),
    rate_limit_remaining: toInt(row.rate_limit_remaining),
    last_success_at: row.last_success_at === null || row.last_success_at === undefined ? null : String(row.last_success_at),
    last_failure_at: row.last_failure_at === null || row.last_failure_at === undefined ? null : String(row.last_failure_at),
    last_fixture_sync_at: row.last_fixture_sync_at === null || row.last_fixture_sync_at === undefined ? null : String(row.last_fixture_sync_at),
    last_odds_sync_at: row.last_odds_sync_at === null || row.last_odds_sync_at === undefined ? null : String(row.last_odds_sync_at),
    last_result_sync_at: row.last_result_sync_at === null || row.last_result_sync_at === undefined ? null : String(row.last_result_sync_at),
    data_freshness_seconds: toInt(row.data_freshness_seconds),
    records_received: toInt(row.records_received, 0),
    invalid_records: toInt(row.invalid_records, 0),
    // Legacy decoded with a `'[]'` fallback only on `latestSportsHealth` and not on
    // `listSportsHealth`, so a row read through the list path kept its raw JSON string and
    // the monitor's callers had two different shapes for one column. Both paths
    // decode here (divergence SP-17) — the monitor reads `missing_fields` as an
    // array, and a shape that depends on which method fetched the row is a trap.
    missing_fields: decodeJson(row.missing_fields, []),
    observed_at: String(row.observed_at),
  };
}

export function matchRow(row) {
  if (!row) return null;
  return {
    id: toInt(row.id),
    provider_id: toInt(row.provider_id),
    external_id: String(row.external_id),
    sport: String(row.sport),
    competition: String(row.competition),
    home_team: String(row.home_team),
    away_team: String(row.away_team),
    kickoff_at: String(row.kickoff_at),
    status: String(row.status),
    source_timestamp: String(row.source_timestamp),
    payload: decodeJson(row.payload, null),
    created_at: row.created_at === null || row.created_at === undefined ? null : String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

export function oddsRow(row) {
  if (!row) return null;
  return {
    id: toInt(row.id),
    match_id: toInt(row.match_id),
    provider_id: toInt(row.provider_id),
    market: String(row.market),
    selection: String(row.selection),
    decimal_odds: toDecimal(row.decimal_odds),
    observed_at: String(row.observed_at),
    payload: decodeJson(row.payload, null),
  };
}

export function resultRow(row) {
  if (!row) return null;
  return {
    id: toInt(row.id),
    match_id: toInt(row.match_id),
    provider_id: toInt(row.provider_id),
    home_score: toInt(row.home_score),
    away_score: toInt(row.away_score),
    status: String(row.status),
    verified: toInt(row.verified, 0) === 1,
    source_timestamp: String(row.source_timestamp),
    verified_at: row.verified_at === null || row.verified_at === undefined ? null : String(row.verified_at),
    payload: decodeJson(row.payload, null),
  };
}

export function qualityRow(row) {
  if (!row) return null;
  return {
    id: toInt(row.id),
    match_id: toInt(row.match_id),
    score: toInt(row.score, 0),
    band: String(row.band),
    freshness_score: toInt(row.freshness_score, 0),
    provider_reliability_score: toInt(row.provider_reliability_score, 0),
    eligible_prediction: toInt(row.eligible_prediction, 0) === 1,
    eligible_ticket: toInt(row.eligible_ticket, 0) === 1,
    missing_fields: decodeJson(row.missing_fields, []),
    checks_payload: decodeJson(row.checks_payload, null),
    assessed_at: String(row.assessed_at),
  };
}

export function syncRunRow(row) {
  if (!row) return null;
  return {
    id: String(row.id),
    provider_id: toInt(row.provider_id),
    job_type: String(row.job_type),
    status: String(row.status),
    started_at: String(row.started_at),
    ended_at: row.ended_at === null || row.ended_at === undefined ? null : String(row.ended_at),
    records_processed: toInt(row.records_processed, 0),
    records_created: toInt(row.records_created, 0),
    records_updated: toInt(row.records_updated, 0),
    errors: decodeJson(row.errors, []),
    execution_key: String(row.execution_key),
  };
}


// ── Slice 3 (migration 012): decisions, model registry, configuration, calibration ──
//
// Shared by both adapters for the same reason as everything above: the MySQL and file
// stores must refuse the same inputs and return the same shapes. The `prepare*` functions
// validate and build the storage row; the `*Row` readers turn a stored row into the shape
// the API returns. Storage holds booleans as 0/1 and lists as JSON text, as migration 012
// declares; the readers turn them back.

export const CALIBRATION_STATUSES = Object.freeze(["PENDING", "APPROVED", "REJECTED"]);
export const PREDICTION_DECISIONS = Object.freeze(["PREDICTION_READY", "NO_PREDICTION"]);

/** `prd_` followed by 24 lower-case hex digits, as legacy's `bin2hex(random_bytes(12))` produces. */
export function assertPredictionId(value) {
  const id = String(value ?? "").trim();
  if (!/^prd_[0-9a-f]{24}$/.test(id)) {
    throw new TypeError(`a prediction id must be prd_ followed by 24 hex digits, received ${JSON.stringify(id.slice(0, 40))}`);
  }
  return id;
}

/** A probability-like column: finite, or null when the decision did not produce one. */
function optionalNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new TypeError(`expected a finite number, received ${JSON.stringify(String(value).slice(0, 40))}`);
  return parsed;
}

/**
 * The model-version row for one (name, version, feature set, calibration) identity.
 * `calibration_version` is stored as '' when absent, so the UNIQUE key holds.
 */
export function prepareModelVersion(input, createdAt) {
  return {
    model_name: assertText(input.modelName, 80, "model_name"),
    model_version: assertText(input.modelVersion, 32, "model_version"),
    feature_version: assertText(input.featureVersion, 40, "feature_version"),
    calibration_version: assertText(input.calibrationVersion ?? "", 120, "calibration_version"),
    status: "ACTIVE",
    created_at: createdAt,
  };
}

export function modelVersionRow(row) {
  if (!row) return null;
  return {
    id: toInt(row.id),
    model_name: String(row.model_name),
    model_version: String(row.model_version),
    feature_version: String(row.feature_version),
    calibration_version: row.calibration_version === "" || row.calibration_version === null || row.calibration_version === undefined
      ? null
      : String(row.calibration_version),
    status: String(row.status),
    created_at: String(row.created_at),
  };
}

/**
 * One immutable decision. Every field the chain produced is stored, so the decision can
 * be reconstructed later: the odds at decision time with its timestamp, the feature and
 * calibration versions, both probabilities, confidence, value, risk, and the gate's
 * full list of reasons.
 */
export function preparePrediction(input, { id, createdAt }) {
  return {
    id: assertPredictionId(id),
    match_id: assertRowId(input.matchId, "match_id"),
    model_version_id: assertRowId(input.modelVersionId, "model_version_id"),
    market: assertText(input.market ?? "UNSPECIFIED", 40, "market"),
    selection: assertText(input.selection ?? "UNSPECIFIED", 40, "selection"),
    raw_probability: optionalNumber(input.rawProbability),
    calibrated_probability: optionalNumber(input.calibratedProbability),
    implied_probability: optionalNumber(input.impliedProbability),
    expected_value: optionalNumber(input.expectedValue),
    confidence: optionalNumber(input.confidence),
    risk: assertEnum(input.risk ?? "REJECTED", ["LOW", "MEDIUM", "HIGH", "REJECTED"], "risk"),
    correlation: assertText(input.correlation ?? "UNKNOWN", 16, "correlation"),
    data_quality_score: toInt(input.dataQualityScore, 0),
    decision: assertEnum(input.decision, PREDICTION_DECISIONS, "decision"),
    rejection_reasons: encodeJson(Array.isArray(input.rejectionReasons) ? input.rejectionReasons : []),
    factors: encodeJson(input.factors ?? {}),
    input_version: assertText(input.inputVersion ?? "unknown", 40, "input_version"),
    odds: optionalNumber(input.odds),
    odds_timestamp: optionalInstant(input.oddsTimestamp, "odds_timestamp"),
    created_at: createdAt,
  };
}

export function predictionRow(row) {
  if (!row) return null;
  return {
    id: String(row.id),
    match_id: toInt(row.match_id),
    model_version_id: toInt(row.model_version_id),
    market: String(row.market),
    selection: String(row.selection),
    raw_probability: toDecimal(row.raw_probability),
    calibrated_probability: toDecimal(row.calibrated_probability),
    implied_probability: toDecimal(row.implied_probability),
    expected_value: toDecimal(row.expected_value),
    confidence: toDecimal(row.confidence),
    risk: String(row.risk),
    correlation: String(row.correlation),
    data_quality_score: toInt(row.data_quality_score, 0),
    decision: String(row.decision),
    rejection_reasons: decodeJson(row.rejection_reasons, []),
    factors: decodeJson(row.factors, {}),
    input_version: String(row.input_version),
    odds: toDecimal(row.odds),
    odds_timestamp: row.odds_timestamp === null || row.odds_timestamp === undefined ? null : String(row.odds_timestamp),
    created_at: String(row.created_at),
  };
}

const CONFIGURATION_BOOLEANS = Object.freeze(["module_enabled", "ticket_engine_enabled", "require_calibration"]);
const CONFIGURATION_LISTS = Object.freeze(["allowed_markets", "allowed_leagues"]);

/**
 * The storage row for one configuration version. Booleans become 0/1 and lists become
 * JSON text; the configuration module has already validated every value.
 */
export function prepareConfiguration(row) {
  const out = {
    version: assertRowId(row.version, "version"),
    platform_mode: assertText(row.platform_mode, 16, "platform_mode"),
    engine_mode: assertText(row.engine_mode, 32, "engine_mode"),
    target_odds_min: Number(row.target_odds_min),
    target_odds_max: Number(row.target_odds_max),
    max_selections: toInt(row.max_selections, 0),
    risk_level: assertText(row.risk_level, 16, "risk_level"),
    min_confidence: Number(row.min_confidence),
    min_expected_value: Number(row.min_expected_value),
    max_correlation: assertText(row.max_correlation, 8, "max_correlation"),
    min_data_quality: toInt(row.min_data_quality, 0),
    min_liquidity: row.min_liquidity === null || row.min_liquidity === undefined ? null : Number(row.min_liquidity),
    max_exposure: Number(row.max_exposure),
    stake_amount: Number(row.stake_amount),
    void_policy: assertText(row.void_policy, 24, "void_policy"),
    updated_by: assertText(row.updated_by, 64, "updated_by"),
    reason: assertText(row.reason, 500, "reason"),
    created_at: assertInstant(row.created_at, "created_at"),
  };
  for (const field of CONFIGURATION_BOOLEANS) out[field] = row[field] ? 1 : 0;
  for (const field of CONFIGURATION_LISTS) out[field] = encodeJson(Array.isArray(row[field]) ? row[field] : []);
  return out;
}

export function configurationRow(row) {
  if (!row) return null;
  const out = {
    id: toInt(row.id),
    version: toInt(row.version, 0),
    platform_mode: String(row.platform_mode),
    engine_mode: String(row.engine_mode),
    target_odds_min: toDecimal(row.target_odds_min),
    target_odds_max: toDecimal(row.target_odds_max),
    max_selections: toInt(row.max_selections, 0),
    risk_level: String(row.risk_level),
    min_confidence: toDecimal(row.min_confidence),
    min_expected_value: toDecimal(row.min_expected_value),
    max_correlation: String(row.max_correlation),
    min_data_quality: toInt(row.min_data_quality, 0),
    min_liquidity: toDecimal(row.min_liquidity),
    max_exposure: toDecimal(row.max_exposure),
    stake_amount: toDecimal(row.stake_amount),
    void_policy: String(row.void_policy),
    updated_by: String(row.updated_by),
    reason: String(row.reason),
    created_at: String(row.created_at),
  };
  for (const field of CONFIGURATION_BOOLEANS) out[field] = toInt(row[field], 0) === 1;
  for (const field of CONFIGURATION_LISTS) out[field] = decodeJson(row[field], []);
  return out;
}

/** The storage row for a fitted calibration, PENDING until an administrator decides. */
export function prepareCalibration(fit, { modelVersionId, calibrationVersion, createdBy, createdAt }) {
  return {
    model_version_id: assertRowId(modelVersionId, "model_version_id"),
    method: assertText(fit.method, 16, "method"),
    intercept: Number(fit.intercept),
    slope: Number(fit.slope),
    samples: toInt(fit.samples, 0),
    positives: toInt(fit.positives, 0),
    ece: Number(fit.ece),
    brier: Number(fit.brier),
    identity_brier: Number(fit.identityBrier),
    bins: encodeJson(Array.isArray(fit.bins) ? fit.bins : []),
    calibration_version: assertText(calibrationVersion, 120, "calibration_version"),
    status: "PENDING",
    created_by: assertText(createdBy, 64, "created_by"),
    created_at: createdAt,
    approved_by: null,
    approved_at: null,
  };
}

export function calibrationRow(row) {
  if (!row) return null;
  return {
    id: toInt(row.id),
    model_version_id: toInt(row.model_version_id),
    method: String(row.method),
    intercept: toDecimal(row.intercept),
    slope: toDecimal(row.slope),
    samples: toInt(row.samples, 0),
    positives: toInt(row.positives, 0),
    ece: toDecimal(row.ece),
    brier: toDecimal(row.brier),
    identity_brier: toDecimal(row.identity_brier),
    bins: decodeJson(row.bins, []),
    calibration_version: String(row.calibration_version),
    status: String(row.status),
    created_by: String(row.created_by),
    created_at: String(row.created_at),
    approved_by: row.approved_by === null || row.approved_by === undefined ? null : String(row.approved_by),
    approved_at: row.approved_at === null || row.approved_at === undefined ? null : String(row.approved_at),
  };
}

// ── row 14, slice 4: tickets and the daily run (migration 013) ───────────────────────

export const TICKET_STATUSES = Object.freeze(["PENDING", "APPROVED", "CANCELLED"]);
export const TICKET_APPROVALS = Object.freeze(["PENDING_USER_APPROVAL", "APPROVED_NOT_EXECUTED", "REJECTED"]);
export const TICKET_RISK_LEVELS = Object.freeze(["LOW", "MEDIUM", "HIGH"]);
export const DAILY_RUN_STATUSES = Object.freeze(["RUNNING", "NO_QUALIFIED_TICKET", "PENDING_USER_APPROVAL"]);

/** A ticket id is `tkt_` and sixteen lowercase hex characters, as legacy generates. */
export function assertTicketId(value) {
  const id = String(value ?? "");
  if (!/^tkt_[0-9a-f]{16}$/.test(id)) {
    throw new TypeError(`ticket id must be 'tkt_' and 16 hex characters, received ${JSON.stringify(id.slice(0, 40))}`);
  }
  return id;
}

/** A UTC calendar day, `YYYY-MM-DD`, that exists (2026-02-30 is refused, not normalized). */
export function assertRunDate(value) {
  const text = String(value ?? "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    throw new TypeError(`run date must be YYYY-MM-DD, received ${JSON.stringify(text.slice(0, 20))}`);
  }
  const parsed = new Date(`${text}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== text) {
    throw new TypeError(`run date ${text} is not a calendar day`);
  }
  return text;
}

function nonNegativeInt(value, label) {
  const parsed = toInt(value, 0);
  if (parsed < 0) throw new TypeError(`${label} must not be negative, received ${parsed}`);
  return parsed;
}

/**
 * The storage rows for one ticket and its selections, from `buildTicket` (governance).
 * Validation happens here so that both adapters refuse the same inputs.
 */
export function prepareTicket(built) {
  const t = built.ticket;
  const ticket = {
    id: assertTicketId(t.id),
    model_version_id: optionalRowId(t.modelVersionId, "model_version_id"),
    configuration_version: nonNegativeInt(t.configurationVersion, "configuration_version"),
    total_odds: optionalNumber(t.totalOdds),
    selection_count: nonNegativeInt(t.selectionCount, "selection_count"),
    combined_probability: optionalNumber(t.combinedProbability),
    confidence: optionalNumber(t.confidence),
    risk: assertEnum(t.risk, TICKET_RISK_LEVELS, "risk"),
    correlation: assertEnum(t.correlation, TICKET_RISK_LEVELS, "correlation"),
    data_quality_score: toInt(t.dataQualityScore, 0),
    status: assertEnum(t.status, TICKET_STATUSES, "status"),
    approval_status: assertEnum(t.approvalStatus, TICKET_APPROVALS, "approval_status"),
    settlement_status: assertText(t.settlementStatus ?? "PENDING", 16, "settlement_status"),
    stake: optionalNumber(t.stake),
    reason: t.reason === null || t.reason === undefined ? null : assertText(t.reason, 500, "reason"),
    optimization_score: optionalNumber(t.optimizationScore),
    pool_size: nonNegativeInt(t.poolSize, "pool_size"),
    decided_by: null,
    decided_at: null,
    created_at: assertInstant(t.createdAt, "created_at"),
  };
  const selections = built.selections.map((s) => ({
    ticket_id: ticket.id,
    prediction_id: assertText(s.predictionId ?? "unlinked", 40, "prediction_id"),
    match_id: assertRowId(s.matchId, "match_id"),
    market: assertText(s.market ?? "UNSPECIFIED", 40, "market"),
    selection: assertText(s.selection ?? "UNSPECIFIED", 40, "selection"),
    odds: optionalNumber(s.odds),
    odds_timestamp: optionalInstant(s.oddsTimestamp, "odds_timestamp"),
    model_probability: optionalNumber(s.modelProbability),
    calibrated_probability: optionalNumber(s.calibratedProbability),
    expected_value: optionalNumber(s.expectedValue),
    risk: assertEnum(s.risk, TICKET_RISK_LEVELS, "risk"),
    result: null,
    status: assertEnum(s.status ?? "PENDING", ["PENDING"], "selection status"),
    correlation_reasons: encodeJson(Array.isArray(s.correlationReasons) ? s.correlationReasons : []),
  }));
  return { ticket, selections };
}

export function ticketRow(row) {
  if (!row) return null;
  return {
    id: String(row.id),
    model_version_id: toInt(row.model_version_id),
    configuration_version: toInt(row.configuration_version, 0),
    total_odds: toDecimal(row.total_odds),
    selection_count: toInt(row.selection_count, 0),
    combined_probability: toDecimal(row.combined_probability),
    confidence: toDecimal(row.confidence),
    risk: String(row.risk),
    correlation: String(row.correlation),
    data_quality_score: toInt(row.data_quality_score, 0),
    status: String(row.status),
    approval_status: String(row.approval_status),
    settlement_status: String(row.settlement_status),
    stake: toDecimal(row.stake),
    reason: row.reason === null || row.reason === undefined ? null : String(row.reason),
    optimization_score: toDecimal(row.optimization_score),
    pool_size: toInt(row.pool_size, 0),
    decided_by: row.decided_by === null || row.decided_by === undefined ? null : String(row.decided_by),
    decided_at: row.decided_at === null || row.decided_at === undefined ? null : String(row.decided_at),
    created_at: String(row.created_at),
  };
}

export function ticketSelectionRow(row) {
  if (!row) return null;
  return {
    id: toInt(row.id),
    ticket_id: String(row.ticket_id),
    prediction_id: String(row.prediction_id),
    match_id: toInt(row.match_id),
    market: String(row.market),
    selection: String(row.selection),
    odds: toDecimal(row.odds),
    odds_timestamp: row.odds_timestamp === null || row.odds_timestamp === undefined ? null : String(row.odds_timestamp),
    model_probability: toDecimal(row.model_probability),
    calibrated_probability: toDecimal(row.calibrated_probability),
    expected_value: toDecimal(row.expected_value),
    risk: String(row.risk),
    result: row.result === null || row.result === undefined ? null : String(row.result),
    status: String(row.status),
    correlation_reasons: decodeJson(row.correlation_reasons, []),
  };
}

/** The claim row: written first, before any work, so a second request for the day finds it. */
export function prepareDailyRunClaim({ runDate, configurationVersion, requestedBy = null, createdAt }) {
  return {
    run_date: assertRunDate(runDate),
    configuration_version: nonNegativeInt(configurationVersion, "configuration_version"),
    status: "RUNNING",
    ticket_id: null,
    fixtures_read: 0,
    candidates_evaluated: 0,
    predictions_recorded: 0,
    rejections: 0,
    simulated_refused: 0,
    rejection_summary: encodeJson({}),
    message: "",
    errors: encodeJson([]),
    requested_by: requestedBy === null || requestedBy === undefined ? null : assertText(requestedBy, 64, "requested_by"),
    created_at: assertInstant(createdAt, "created_at"),
    updated_at: assertInstant(createdAt, "updated_at"),
  };
}

/** The outcome patch written when a claimed run finishes. */
export function prepareDailyRunFinish(outcome, updatedAt) {
  return {
    status: assertEnum(outcome.status, DAILY_RUN_STATUSES, "daily run status"),
    ticket_id: outcome.ticketId === null || outcome.ticketId === undefined ? null : assertTicketId(outcome.ticketId),
    fixtures_read: nonNegativeInt(outcome.fixturesRead, "fixtures_read"),
    candidates_evaluated: nonNegativeInt(outcome.candidatesEvaluated, "candidates_evaluated"),
    predictions_recorded: nonNegativeInt(outcome.predictionsRecorded, "predictions_recorded"),
    rejections: nonNegativeInt(outcome.rejections, "rejections"),
    simulated_refused: nonNegativeInt(outcome.simulatedRefused, "simulated_refused"),
    rejection_summary: encodeJson(outcome.rejectionSummary ?? {}),
    message: assertText(String(outcome.message ?? "").slice(0, 500), 500, "message"),
    errors: encodeJson(Array.isArray(outcome.errors) ? outcome.errors.map((e) => String(e).slice(0, 500)) : []),
    updated_at: assertInstant(updatedAt, "updated_at"),
  };
}

export function dailyRunRow(row) {
  if (!row) return null;
  return {
    id: toInt(row.id),
    run_date: String(row.run_date),
    configuration_version: toInt(row.configuration_version, 0),
    status: String(row.status),
    ticket_id: row.ticket_id === null || row.ticket_id === undefined ? null : String(row.ticket_id),
    fixtures_read: toInt(row.fixtures_read, 0),
    candidates_evaluated: toInt(row.candidates_evaluated, 0),
    predictions_recorded: toInt(row.predictions_recorded, 0),
    rejections: toInt(row.rejections, 0),
    simulated_refused: toInt(row.simulated_refused, 0),
    rejection_summary: decodeJson(row.rejection_summary, {}),
    message: String(row.message ?? ""),
    errors: decodeJson(row.errors, []),
    requested_by: row.requested_by === null || row.requested_by === undefined ? null : String(row.requested_by),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

// ── row 14, slice 5: settlement, verification, backtests and model metrics (migration 014) ──

/**
 * The settlement statuses a TICKET and a SELECTION can carry.
 *
 * Legacy's `finalizeTicket` writes `settlement_status` and mirrors it into `status`,
 * and legacy's `status` column already holds `PENDING`/`APPROVED`/`CANCELLED` from the
 * decision path (slice 4), so a settled ticket's `status` legitimately holds `WON`,
 * `LOST`, `VOID` or `CANCELLED` too. The migration's VARCHAR accepts that; the two
 * lists here are the write-side vocabulary, split so a reader can tell the decision
 * states from the settlement states.
 */
export const TICKET_SETTLEMENT_STATUSES = Object.freeze(["PENDING", "WON", "LOST", "VOID", "CANCELLED"]);
/** The union `updateSportsTicket` may write into the mirrored `status` column. */
export const TICKET_LIFECYCLE_STATUSES = Object.freeze([...TICKET_STATUSES, "WON", "LOST", "VOID"]);
/** What `settleSelection` may write onto one leg. A leg is never APPROVED. */
export const SELECTION_SETTLEMENT_STATUSES = Object.freeze(["PENDING", "WON", "LOST", "VOID", "CANCELLED"]);

/** The void-handling policies, from the configuration (`void_policy`). */
export const VOID_POLICY_DEFAULT = "RESTITUTE_ODDS";

/**
 * The settlement patch for one ticket: what `finalizeTicket` writes, and nothing else.
 *
 * Legacy's `updateTicket($id, $patch)` takes an arbitrary associative array. This port
 * takes four named fields instead, because settlement is the one writer of this table
 * outside the decision path, and an arbitrary patch would let a future caller silently
 * overwrite `approval_status` — the column a person's decision owns.
 */
export function prepareTicketSettlement({ settlementStatus, status, totalOdds = null, reason = null }) {
  return {
    settlement_status: assertEnum(settlementStatus, TICKET_SETTLEMENT_STATUSES, "settlement_status"),
    status: assertEnum(status, TICKET_LIFECYCLE_STATUSES, "status"),
    // Round(…, 6) as legacy rounds it; NULL keeps the ticket's stored odds (a PENDING ticket).
    total_odds: totalOdds === null || totalOdds === undefined ? null : Number(Number(totalOdds).toFixed(6)),
    reason: reason === null || reason === undefined ? null : assertText(String(reason).slice(0, 500), 500, "reason"),
  };
}

/** The settlement patch for one selection leg: its status and the same value in `result`. */
export function prepareSelectionSettlement({ status }) {
  const settled = assertEnum(status, SELECTION_SETTLEMENT_STATUSES, "selection status");
  return { status: settled, result: settled };
}

/**
 * One stored backtest. `id` is `bt_` + 16 lower-case hex, generated by the caller before
 * the insert, exactly as the ticket ids are. `params` and `report` are JSON text.
 */
export function prepareBacktest({ id, createdAt, createdBy = null, params, report, status = "COMPLETED" }) {
  const backtestId = String(id ?? "");
  if (!/^bt_[0-9a-f]{16}$/.test(backtestId)) {
    throw new TypeError(`backtest id must be 'bt_' and 16 hex characters, received ${JSON.stringify(backtestId.slice(0, 40))}`);
  }
  return {
    id: backtestId,
    created_at: assertInstant(createdAt, "created_at"),
    created_by: createdBy === null || createdBy === undefined ? null : assertText(String(createdBy).slice(0, 64), 64, "created_by"),
    params: encodeJson(params ?? {}),
    report: encodeJson(report ?? {}),
    status: assertText(String(status).slice(0, 16), 16, "status"),
  };
}

/** Read one backtest row. `params` and `report` come back decoded, as legacy's do. */
export function backtestRow(row) {
  if (!row) return null;
  return {
    id: String(row.id),
    created_at: String(row.created_at),
    created_by: row.created_by === null || row.created_by === undefined ? null : String(row.created_by),
    params: decodeJson(row.params, {}),
    report: decodeJson(row.report, {}),
    status: String(row.status),
  };
}

/**
 * One performance snapshot (`wf_sports_performance_snapshots`), legacy's shape one for
 * one: identified by (as_of hour, window), the payload the whole report as JSON.
 *
 * `asOf` is truncated to the hour here, so a cron that runs twice within the hour
 * writes the same identity and the upsert replaces — the guarantee legacy's
 * `uq_sports_perf_snapshot (as_of, window)` makes. `window` is legacy's own spelling:
 * '7', '30', '90' or 'ALL'.
 */
export const SNAPSHOT_WINDOWS = Object.freeze(["7", "30", "90", "ALL"]);

/** `YYYY-MM-DDTHH:00:00.000Z` — the hour containing `instant`, in UTC. */
export function hourFloorIso(instant) {
  const at = instant instanceof Date ? instant.getTime() : Date.parse(String(instant));
  if (Number.isNaN(at)) throw new TypeError(`as_of must be an ISO-8601 instant, received ${JSON.stringify(String(instant).slice(0, 40))}`);
  return new Date(Math.floor(at / 3_600_000) * 3_600_000).toISOString();
}

export function preparePerformanceSnapshot({ asOf, window, payload }) {
  const w = String(window ?? "").trim();
  if (!SNAPSHOT_WINDOWS.includes(w)) {
    throw new TypeError(`snapshot window must be one of ${SNAPSHOT_WINDOWS.join(", ")}, received ${JSON.stringify(w.slice(0, 8))}`);
  }
  return {
    as_of: hourFloorIso(asOf ?? new Date()),
    window: w,
    payload: encodeJson(payload ?? {}),
  };
}

/** Read one snapshot row. `payload` comes back decoded, as legacy's does. */
export function performanceSnapshotRow(row) {
  if (!row) return null;
  return {
    id: row.id === null || row.id === undefined ? null : Number(row.id),
    as_of: String(row.as_of),
    window: String(row.window),
    payload: decodeJson(row.payload, {}),
  };
}

/**
 * One measured model-metrics snapshot (`wf_sports_model_metrics`).
 *
 * `sampleType` is `live` for `ModelPerformanceService::metricsFor` and `drift` for the
 * drift monitor's warning snapshot — the same two values legacy writes.
 */
export const MODEL_METRICS_SAMPLE_TYPES = Object.freeze(["live", "drift"]);

export function prepareModelMetrics(input) {
  const m = input && typeof input === "object" ? input : {};
  return {
    model_version_id: assertRowId(m.modelVersionId, "model_version_id"),
    window_days: nonNegativeInt(m.windowDays, "window_days"),
    sample_type: assertEnum(m.sampleType ?? "live", MODEL_METRICS_SAMPLE_TYPES, "sample_type"),
    predictions: nonNegativeInt(m.predictions ?? 0, "predictions"),
    settled: nonNegativeInt(m.settled ?? 0, "settled"),
    accuracy: optionalNumber(m.accuracy),
    brier: optionalNumber(m.brier),
    ece: optionalNumber(m.ece),
    win_rate: optionalNumber(m.winRate),
    roi: optionalNumber(m.roi),
    max_drawdown: optionalNumber(m.maxDrawdown),
    computed_at: assertInstant(m.computedAt, "computed_at"),
  };
}

export function modelMetricsRow(row) {
  if (!row) return null;
  return {
    id: toInt(row.id),
    model_version_id: toInt(row.model_version_id),
    window_days: toInt(row.window_days, 0),
    sample_type: String(row.sample_type),
    predictions: toInt(row.predictions, 0),
    settled: toInt(row.settled, 0),
    accuracy: toDecimal(row.accuracy),
    brier: toDecimal(row.brier),
    ece: toDecimal(row.ece),
    win_rate: toDecimal(row.win_rate),
    roi: toDecimal(row.roi),
    max_drawdown: toDecimal(row.max_drawdown),
    computed_at: String(row.computed_at),
  };
}

/**
 * One prediction joined to its match and its VERIFIED finished result, with the binary
 * outcome for the market it predicted.
 *
 * Only `TOTAL_GOALS` `OVER_1_5` / `UNDER_1_5` rows produce an outcome; any other market
 * is excluded rather than guessed (legacy's `predictionOutcomes` does exactly this).
 * The rows keep the snake_case names the metric code reads: `raw_probability`,
 * `calibrated_probability`, `outcome`, `created_at`.
 */
export function predictionOutcomeRow(row) {
  const homeScore = toInt(row.home_score);
  const awayScore = toInt(row.away_score);
  if (homeScore === null || awayScore === null) return null;
  const market = String(row.market ?? "");
  const selection = String(row.selection ?? "");
  const total = homeScore + awayScore;
  let outcome = null;
  if (market === "TOTAL_GOALS" && selection === "OVER_1_5") outcome = total > 1 ? 1 : 0;
  else if (market === "TOTAL_GOALS" && selection === "UNDER_1_5") outcome = total <= 1 ? 1 : 0;
  // Unknown markets are excluded, never guessed.
  if (outcome === null) return null;
  return {
    ...predictionRow(row),
    league: row.league === null || row.league === undefined ? null : String(row.league),
    home_score: homeScore,
    away_score: awayScore,
    outcome,
  };
}

/**
 * One ticket selection joined to its ticket, match and model version — the row shape
 * `settledSelections` returns and the ticket metrics read.
 *
 * `_settled` is legacy's flag: 1 when the leg's status is terminal, 0 otherwise. The
 * ticket's `pnl` is carried as `ticket_pnl` — legacy reads it with a `findTicket` call
 * per selection; the join supplies the same column without the N+1 reads.
 */
export function settledSelectionRow(row) {
  const status = String(row.status ?? "");
  const settled = ["WON", "LOST", "VOID", "CANCELLED"].includes(status) ? 1 : 0;
  return {
    ...ticketSelectionRow(row),
    ticket_odds: toDecimal(row.ticket_odds),
    ticket_status: row.ticket_status === null || row.ticket_status === undefined ? null : String(row.ticket_status),
    ticket_stake: toDecimal(row.ticket_stake),
    ticket_pnl: toDecimal(row.ticket_pnl),
    competition: row.competition === null || row.competition === undefined ? null : String(row.competition),
    kickoff_at: row.kickoff_at === null || row.kickoff_at === undefined ? null : String(row.kickoff_at),
    model_name: row.model_name === null || row.model_name === undefined ? null : String(row.model_name),
    model_version: row.model_version === null || row.model_version === undefined ? null : String(row.model_version),
    _settled: settled,
  };
}
