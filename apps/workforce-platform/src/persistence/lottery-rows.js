/**
 * The lottery foundation's shared row shape — validators and column mappers used by
 * BOTH adapters, exactly as `sports-rows.js` does for row 14 (that file's header
 * records why this code is shared rather than duplicated; the generic validators it
 * exports — ids, instants, enums, JSON — are reused here rather than moved, because
 * moving them would churn every sports import for no behavioral change).
 *
 * Rows are snake_case with JSON columns decoded: the shape CodeIgniter's
 * `result_array()` plus `json_decode` produced, and the shape the lottery facade
 * reads fields like `observed_at`, `draw_date` and `execution_key` straight off.
 *
 * Timestamps are canonical UTC (`…Z`) on the way in — divergence **LT-1**, the
 * lottery instance of AV-2/SP-1: the columns hold one fixed shape because
 * `listLotteryDraws` really does issue `draw_date >= ?` as a string comparison,
 * while payloads keep legacy's `gmdate('c')` `+00:00` shape because the pure
 * classes are the PHP differential harness's subject.
 */

import { parseStrictInstant } from "../lib/php-date.js";
import {
  assertEnum,
  assertExecutionKey,
  assertInstant,
  assertProviderCode,
  assertProviderName,
  assertRowId,
  assertSyncRunId,
  assertText,
  encodeJson,
  decodeJson,
  nonNegativeInt,
  optionalInstant,
  optionalRowId,
  toDecimal,
  toInt,
} from "./sports-rows.js";

// The generation modes (legacy `CombinationGenerator::MODES`) plus `SYSTEM`, the
// mode a saved full-system build is stamped with.
const GENERATION_MODES = Object.freeze(["RANDOM", "BALANCED", "HISTORICAL", "DIVERSIFIED", "ANTI-POPULAR"]);

// ── lottery-specific validators ───────────────────────────────────────────────

/** A lottery code: legacy stores `EUROMILLIONS`; uppercase, digits, dashes, underscores. */
export function assertLotteryCode(value) {
  const code = String(value ?? "").trim();
  if (!/^[A-Z0-9_-]{1,32}$/.test(code)) {
    throw new TypeError(`lottery_code must be 1-32 characters of [A-Z0-9_-], received ${JSON.stringify(String(value ?? "").slice(0, 80))}`);
  }
  return code;
}

/** `YYYY-MM-DD`, refused rather than normalized — a draw date is published data. */
export function assertDrawDate(value) {
  const text = String(value ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    throw new TypeError(`draw_date must be YYYY-MM-DD, received ${JSON.stringify(text.slice(0, 40))}`);
  }
  const at = new Date(`${text}T00:00:00Z`);
  if (Number.isNaN(at.getTime()) || at.toISOString().slice(0, 10) !== text) {
    throw new TypeError(`draw_date must be a real calendar day, received ${JSON.stringify(text)}`);
  }
  return text;
}

/**
 * The statuses a stored draw's `verification_status` may hold. Legacy only ever
 * writes `VERIFIED` (a draw that failed validation is never inserted at all), but
 * the column is the module's attestation point — slice 2's ticket checking reads
 * it — so the enum is pinned rather than left implicit.
 */
export const LOTTERY_VERIFICATION_STATUSES = Object.freeze(["VERIFIED", "UNVERIFIED", "DATA_VALIDATION_FAILED"]);

/** Draw-number kinds: mains and (EuroMillions) Lucky Stars. */
export const LOTTERY_NUMBER_KINDS = Object.freeze(["MAIN", "STAR"]);

/** Provider-health statuses, exactly the states `probeProvider` can report. */
export const LOTTERY_HEALTH_STATUSES = Object.freeze(["ONLINE", "DEGRADED", "OFFLINE", "DISABLED", "UNCONFIGURED", "ERROR", "UNKNOWN"]);

// ── the game and its rules ────────────────────────────────────────────────────

export function prepareLotteryGame({ code, name, rulesVersion, now }) {
  return {
    code: assertLotteryCode(code),
    name: assertText(name, 120, "name"),
    enabled: 1,
    rules_version: assertText(rulesVersion, 16, "rules_version"),
    created_at: now,
    updated_at: now,
  };
}

export function lotteryGameRow(row) {
  if (!row) return null;
  return {
    id: row.id === null || row.id === undefined ? null : Number(row.id),
    code: String(row.code),
    name: String(row.name),
    enabled: Number(row.enabled),
    rules_version: String(row.rules_version),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

/**
 * One stored rules version. `schedule` stays the stored JSON **text** on both
 * adapters — legacy's `EuroMillionsRules::fromArray` is the only decoder, and the
 * rules layer owns that step.
 */
export function prepareLotteryRules({ lotteryCode, version, mainCount, mainMin, mainMax, starCount, starMin, starMax, schedule, active = 1, createdAt }) {
  return {
    lottery_code: assertLotteryCode(lotteryCode),
    version: assertText(version, 16, "version"),
    main_count: nonNegativeInt(mainCount, "main_count"),
    main_min: nonNegativeInt(mainMin, "main_min"),
    main_max: nonNegativeInt(mainMax, "main_max"),
    star_count: nonNegativeInt(starCount, "star_count"),
    star_min: nonNegativeInt(starMin, "star_min"),
    star_max: nonNegativeInt(starMax, "star_max"),
    schedule: assertText(schedule, 65535, "schedule"),
    active: active ? 1 : 0,
    created_at: createdAt,
  };
}

export function lotteryRulesRow(row) {
  if (!row) return null;
  return {
    id: row.id === null || row.id === undefined ? null : Number(row.id),
    lottery_code: String(row.lottery_code),
    version: String(row.version),
    main_count: Number(row.main_count),
    main_min: Number(row.main_min),
    main_max: Number(row.main_max),
    star_count: Number(row.star_count),
    star_min: Number(row.star_min),
    star_max: Number(row.star_max),
    schedule: String(row.schedule),
    active: Number(row.active),
    created_at: String(row.created_at),
  };
}

// ── providers and their health ────────────────────────────────────────────────

export function prepareLotteryProvider({ code, name, now }) {
  return {
    provider_code: assertProviderCode(code),
    display_name: assertProviderName(name),
    enabled: 0,
    synthetic: String(code).includes("sandbox") ? 1 : 0,
    created_at: now,
    updated_at: now,
  };
}

export function lotteryProviderRow(row) {
  if (!row) return null;
  return {
    id: row.id === null || row.id === undefined ? null : Number(row.id),
    provider_code: String(row.provider_code),
    display_name: String(row.display_name),
    enabled: Number(row.enabled),
    synthetic: Number(row.synthetic),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

/** One append-only provider-health observation (the lottery `lottery_provider_health`). */
export function prepareLotteryHealth({ providerId, health, observedAt }) {
  const h = health && typeof health === "object" ? health : {};
  return {
    provider_id: assertRowId(providerId, "provider_id"),
    status: assertEnum(h.status, LOTTERY_HEALTH_STATUSES, "health status"),
    response_ms: h.responseMs === null || h.responseMs === undefined ? null : toInt(h.responseMs),
    records_received: nonNegativeInt(h.recordsReceived ?? 0, "records_received"),
    invalid_records: nonNegativeInt(h.invalidRecords ?? 0, "invalid_records"),
    error_rate: h.errorRate === null || h.errorRate === undefined ? null : toDecimal(h.errorRate),
    last_success_at: optionalInstant(h.lastSuccessAt, "last_success_at"),
    last_failure_at: optionalInstant(h.lastFailureAt, "last_failure_at"),
    last_draw_retrieved: h.lastDrawRetrieved === null || h.lastDrawRetrieved === undefined ? null : assertDrawDate(h.lastDrawRetrieved),
    data_freshness_seconds: h.dataFreshnessSeconds === null || h.dataFreshnessSeconds === undefined ? null : toInt(h.dataFreshnessSeconds),
    synthetic: h.synthetic ? 1 : 0,
    observed_at: observedAt,
  };
}

export function lotteryHealthRow(row) {
  if (!row) return null;
  return {
    id: row.id === null || row.id === undefined ? null : Number(row.id),
    provider_id: Number(row.provider_id),
    status: String(row.status),
    response_ms: row.response_ms === null || row.response_ms === undefined ? null : Number(row.response_ms),
    records_received: Number(row.records_received),
    invalid_records: Number(row.invalid_records),
    error_rate: row.error_rate === null || row.error_rate === undefined ? null : Number(row.error_rate),
    last_success_at: row.last_success_at === null || row.last_success_at === undefined ? null : String(row.last_success_at),
    last_failure_at: row.last_failure_at === null || row.last_failure_at === undefined ? null : String(row.last_failure_at),
    last_draw_retrieved: row.last_draw_retrieved === null || row.last_draw_retrieved === undefined ? null : String(row.last_draw_retrieved),
    data_freshness_seconds: row.data_freshness_seconds === null || row.data_freshness_seconds === undefined ? null : Number(row.data_freshness_seconds),
    synthetic: Number(row.synthetic),
    observed_at: String(row.observed_at),
  };
}

// ── draws ─────────────────────────────────────────────────────────────────────

/**
 * One published draw result. `payload` carries the numbers and provenance as the
 * validator saw them; `verification_status` is the module's attestation, and an
 * import that cannot attest never reaches this table.
 */
export function prepareLotteryDraw({ lotteryCode, providerId, externalId, drawDate, jackpot, rollover, source, sourceTimestamp, retrievedAt, verificationStatus, payload, now }) {
  return {
    lottery_code: assertLotteryCode(lotteryCode),
    provider_id: optionalRowId(providerId, "provider_id"),
    external_id: assertText(externalId, 64, "external_id"),
    draw_date: assertDrawDate(drawDate),
    jackpot: jackpot === null || jackpot === undefined || jackpot === "" ? null : assertText(String(jackpot), 32, "jackpot"),
    rollover: rollover ? 1 : 0,
    source: assertText(source, 120, "source"),
    source_timestamp: assertText(sourceTimestamp, 40, "source_timestamp"),
    retrieved_at: retrievedAt,
    verification_status: assertEnum(verificationStatus, LOTTERY_VERIFICATION_STATUSES, "verification_status"),
    payload: encodeJson(payload ?? {}),
    created_at: now,
    updated_at: now,
  };
}

export function lotteryDrawRow(row) {
  if (!row) return null;
  return {
    id: row.id === null || row.id === undefined ? null : Number(row.id),
    lottery_code: String(row.lottery_code),
    provider_id: row.provider_id === null || row.provider_id === undefined ? null : Number(row.provider_id),
    external_id: String(row.external_id),
    draw_date: String(row.draw_date),
    jackpot: row.jackpot === null || row.jackpot === undefined ? null : String(row.jackpot),
    rollover: Number(row.rollover),
    source: String(row.source),
    source_timestamp: String(row.source_timestamp),
    retrieved_at: String(row.retrieved_at),
    verification_status: String(row.verification_status),
    payload: decodeJson(row.payload, {}),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

export function lotteryDrawNumberRow(row) {
  if (!row) return null;
  return {
    id: row.id === null || row.id === undefined ? null : Number(row.id),
    draw_id: Number(row.draw_id),
    kind: String(row.kind),
    position: Number(row.position),
    number: Number(row.number),
  };
}

// ── sync runs ─────────────────────────────────────────────────────────────────

export function prepareLotterySyncRun({ id, providerId, jobType, payload, executionKey, startedAt }) {
  return {
    id: assertSyncRunId(id),
    provider_id: optionalRowId(providerId, "provider_id"),
    job_type: assertText(jobType, 40, "job_type"),
    status: "RUNNING",
    started_at: startedAt,
    ended_at: null,
    records_processed: 0,
    records_created: 0,
    records_updated: 0,
    errors: null,
    payload: payload === null || payload === undefined ? null : encodeJson(payload),
    execution_key: assertExecutionKey(executionKey),
  };
}

export function lotterySyncRunRow(row) {
  if (!row) return null;
  return {
    id: String(row.id),
    provider_id: row.provider_id === null || row.provider_id === undefined ? null : Number(row.provider_id),
    job_type: String(row.job_type),
    status: String(row.status),
    started_at: String(row.started_at),
    ended_at: row.ended_at === null || row.ended_at === undefined ? null : String(row.ended_at),
    records_processed: Number(row.records_processed),
    records_created: Number(row.records_created),
    records_updated: Number(row.records_updated),
    errors: decodeJson(row.errors, []),
    payload: decodeJson(row.payload, null),
    execution_key: String(row.execution_key),
  };
}

// ── combinations (slice 2) ────────────────────────────────────────────────────

/**
 * A generated-combination row: the lines, their constraints and the score
 * summary travel as JSON, decoded on read (legacy `findCombination`).
 * `mode` is the generation mode (`RANDOM`…`ANTI-POPULAR`) or `SYSTEM`;
 * `created_by` is the acting user id or null when the actor was the system.
 */
export function prepareLotteryCombination({ lotteryCode, mode, modelVersion, seed, lineCount, lines, constraints, scoreSummary, createdBy, createdAt }) {
  return {
    lottery_code: assertLotteryCode(lotteryCode),
    mode: assertEnum(mode, [...GENERATION_MODES, "SYSTEM"], "mode"),
    model_version: assertText(modelVersion, 64, "model_version"),
    seed: seed === null || seed === undefined ? null : assertText(String(seed), 32, "seed"),
    line_count: nonNegativeInt(lineCount, "line_count"),
    lines: encodeJson(lines),
    constraints: encodeJson(constraints),
    score_summary: encodeJson(scoreSummary),
    created_by: optionalRowId(createdBy, "created_by"),
    created_at: assertInstant(createdAt, "created_at"),
  };
}

export function lotteryCombinationRow(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    lottery_code: String(row.lottery_code),
    mode: String(row.mode),
    model_version: String(row.model_version),
    seed: row.seed === null || row.seed === undefined ? null : String(row.seed),
    line_count: Number(row.line_count),
    lines: decodeJson(row.lines, []),
    constraints: decodeJson(row.constraints, {}),
    score_summary: decodeJson(row.score_summary, {}),
    created_by: row.created_by === null || row.created_by === undefined ? null : Number(row.created_by),
    created_at: String(row.created_at),
  };
}

// ── AI decisions (slice 2) ────────────────────────────────────────────────────

/**
 * The persisted decision report: the FULL generation report as JSON, tied to
 * its combination row and model version (spec §26/§33 — the inputs are the
 * recorded truth, never invented after the fact).
 */
export function prepareLotteryAiDecision({ lotteryCode, combinationId, modelVersion, mode, decision, createdAt }) {
  return {
    lottery_code: assertLotteryCode(lotteryCode),
    combination_id: optionalRowId(combinationId, "combination_id"),
    model_version: assertText(modelVersion, 64, "model_version"),
    mode: mode === null || mode === undefined ? null : assertEnum(mode, [...GENERATION_MODES, "SYSTEM"], "mode"),
    decision: encodeJson(decision),
    created_at: assertInstant(createdAt, "created_at"),
  };
}

export function lotteryAiDecisionRow(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    lottery_code: String(row.lottery_code),
    combination_id: row.combination_id === null || row.combination_id === undefined ? null : Number(row.combination_id),
    model_version: String(row.model_version),
    mode: row.mode === null || row.mode === undefined ? null : String(row.mode),
    decision: decodeJson(row.decision, {}),
    created_at: String(row.created_at),
  };
}

// ── tickets (slice 3) ─────────────────────────────────────────────────────────

const TICKET_STATUSES = Object.freeze(["OPEN", "CHECKED", "ARCHIVED"]);
export const LOTTERY_TICKET_METHODS = Object.freeze(["MANUAL", "RANDOM", "BALANCED", "HISTORICAL", "DIVERSIFIED", "ANTI-POPULAR"]);

/**
 * A ticket record: a named, user-scoped set of number lines. `draw_date` is
 * nullable (the caller may target "the latest draw"); `result` is null until a
 * check fills it, and holds the per-line outcome JSON — tier LABELS only, never
 * an amount. `configuration` is the caller's own JSON, decoded on read.
 */
export function prepareLotteryTicket({ userId, lotteryCode, name, drawDate, generationMethod, modelVersion, configuration, status, result, createdAt, updatedAt }) {
  return {
    user_id: assertRowId(userId, "user_id"),
    lottery_code: assertLotteryCode(lotteryCode),
    name: assertText(name, 120, "name"),
    draw_date: drawDate === null || drawDate === undefined ? null : assertDrawDate(drawDate),
    generation_method: assertEnum(generationMethod, LOTTERY_TICKET_METHODS, "generation_method"),
    model_version: assertText(modelVersion, 64, "model_version"),
    configuration: encodeJson(configuration),
    status: assertEnum(status, TICKET_STATUSES, "status"),
    result: result === null || result === undefined ? null : encodeJson(result),
    created_at: assertInstant(createdAt, "created_at"),
    updated_at: assertInstant(updatedAt, "updated_at"),
  };
}

export function lotteryTicketRow(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    user_id: Number(row.user_id),
    lottery_code: String(row.lottery_code),
    name: String(row.name),
    draw_date: row.draw_date === null || row.draw_date === undefined || row.draw_date === "" ? null : String(row.draw_date),
    generation_method: String(row.generation_method),
    model_version: String(row.model_version),
    configuration: decodeJson(row.configuration, {}),
    status: String(row.status),
    result: row.result === null || row.result === undefined || row.result === "" ? null : decodeJson(row.result, null),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

/** One ticket line: its position is its order AS GIVEN at save time. */
export function prepareLotteryTicketLine({ ticketId, position, mains, stars, createdAt }) {
  return {
    ticket_id: assertRowId(ticketId, "ticket_id"),
    position: nonNegativeInt(position, "position"),
    mains: encodeJson(mains),
    stars: encodeJson(stars),
    created_at: assertInstant(createdAt, "created_at"),
  };
}

export function lotteryTicketLineRow(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    ticket_id: Number(row.ticket_id),
    position: Number(row.position),
    mains: decodeJson(row.mains, []),
    stars: decodeJson(row.stars, []),
    created_at: String(row.created_at),
  };
}

// ── slice 4 (migration 019): backtest reports + model versions ────────────────

/** Legacy's DATE column for a backtest period bound: `YYYY-MM-DD`, real calendar day, refused rather than normalized. */
function assertPeriodDate(value, label) {
  const text = String(value ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    throw new TypeError(`${label} must be YYYY-MM-DD, received ${JSON.stringify(text.slice(0, 40))}`);
  }
  const at = new Date(`${text}T00:00:00Z`);
  if (Number.isNaN(at.getTime()) || at.toISOString().slice(0, 10) !== text) {
    throw new TypeError(`${label} must be a real calendar day, received ${JSON.stringify(text)}`);
  }
  return text;
}

/**
 * A HISTORICAL SIMULATION report row: one strategy (or the COMPARISON stamp)
 * replayed over stored draws without look-ahead. `report` is the full report
 * JSON, decoded on read; `period_from`/`period_to` are legacy's DATE columns,
 * read back as strings (or null). No column names money — the report's cost
 * and winnings fields are nulls with their notes, inside the JSON.
 */
export function prepareLotteryBacktest({ lotteryCode, strategy, modelVersion, linesPerDraw, drawsTested, periodFrom, periodTo, datasetVersion, report, createdAt }) {
  return {
    lottery_code: assertLotteryCode(lotteryCode),
    strategy: assertText(strategy, 40, "strategy"),
    model_version: assertText(modelVersion, 64, "model_version"),
    lines_per_draw: nonNegativeInt(linesPerDraw, "lines_per_draw"),
    draws_tested: nonNegativeInt(drawsTested, "draws_tested"),
    period_from: periodFrom === null || periodFrom === undefined || periodFrom === "" ? null : assertPeriodDate(periodFrom, "period_from"),
    period_to: periodTo === null || periodTo === undefined || periodTo === "" ? null : assertPeriodDate(periodTo, "period_to"),
    dataset_version: datasetVersion === null || datasetVersion === undefined ? null : assertText(datasetVersion, 128, "dataset_version"),
    report: encodeJson(report),
    created_at: assertInstant(createdAt, "created_at"),
  };
}

export function lotteryBacktestRow(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    lottery_code: String(row.lottery_code),
    strategy: String(row.strategy),
    model_version: String(row.model_version),
    lines_per_draw: Number(row.lines_per_draw),
    draws_tested: Number(row.draws_tested),
    period_from: row.period_from === null || row.period_from === undefined || row.period_from === "" ? null : String(row.period_from),
    period_to: row.period_to === null || row.period_to === undefined || row.period_to === "" ? null : String(row.period_to),
    dataset_version: row.dataset_version === null || row.dataset_version === undefined ? null : String(row.dataset_version),
    report: decodeJson(row.report, null),
    created_at: String(row.created_at),
  };
}

/**
 * A model version (spec §33): ensured once, never deleted or replaced —
 * historical results stay connected to the model that produced them. `config`
 * is the full statistical configuration as JSON, decoded on read.
 */
export function prepareLotteryModelVersion({ modelName, modelVersion, config, datasetVersion, status, createdAt }) {
  return {
    model_name: assertText(modelName, 64, "model_name"),
    model_version: assertText(modelVersion, 16, "model_version"),
    config: encodeJson(config),
    dataset_version: datasetVersion === null || datasetVersion === undefined ? null : assertText(datasetVersion, 128, "dataset_version"),
    status: assertText(status, 16, "status"),
    created_at: assertInstant(createdAt, "created_at"),
  };
}

export function lotteryModelVersionRow(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    model_name: String(row.model_name),
    model_version: String(row.model_version),
    config: decodeJson(row.config, null),
    dataset_version: row.dataset_version === null || row.dataset_version === undefined ? null : String(row.dataset_version),
    status: String(row.status),
    created_at: String(row.created_at),
  };
}
