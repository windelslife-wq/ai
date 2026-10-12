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

