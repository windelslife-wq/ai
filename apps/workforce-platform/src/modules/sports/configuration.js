/**
 * Ticket-engine configuration — the rules behind legacy `Aegis\Sports\ConfigurationService`
 * (Phase 17, row 14 slice 3).
 *
 * The configuration is **versioned and append-only**. Every change writes a new row with
 * version `n + 1`, and the row before it is never edited. Predictions and tickets
 * record the version that produced them, so a historical decision can be reconstructed
 * with the configuration that existed at the time, not with whatever is active now.
 *
 * `AUTOMATED_EXECUTION` is refused unless an explicit override is passed. Legacy
 * accepts the override from the request body. The Node route never passes it, so
 * automated execution is refused in every deployment. Node has no external execution
 * connector, so the override has no use, and not having it is safer (DV-14).
 *
 * Pure: validation and planning only. The service persists the planned row and the
 * repository rejects a duplicate version.
 */

import { STAKING_METHODS } from "./stake-sizing.js";

export { STAKING_METHODS };

export const PLATFORM_MODES = Object.freeze(["SANDBOX", "PAPER", "PRODUCTION"]);
export const ENGINE_MODES = Object.freeze([
  "VIEW_ONLY",
  "AI_ANALYSIS",
  "AI_TICKET_GENERATION",
  "USER_APPROVAL_REQUIRED",
  "AUTOMATED_EXECUTION",
]);
export const RISK_LEVELS = Object.freeze(["CONSERVATIVE", "MODERATE", "AGGRESSIVE"]);
export const CORRELATION_LIMITS = Object.freeze(["LOW", "MEDIUM"]);
export const VOID_POLICIES = Object.freeze(["RESTITUTE_ODDS", "ALL_VOID_ONLY"]);

export const BOOLEAN_FIELDS = Object.freeze(["module_enabled", "ticket_engine_enabled", "require_calibration"]);
export const NUMBER_FIELDS = Object.freeze([
  "target_odds_min",
  "target_odds_max",
  "max_selections",
  "min_confidence",
  "min_expected_value",
  "min_data_quality",
  "max_exposure",
  "stake_amount",
]);
export const NULLABLE_NUMBER_FIELDS = Object.freeze(["min_liquidity"]);
export const LIST_FIELDS = Object.freeze(["allowed_markets", "allowed_leagues"]);
export const ENUM_FIELDS = Object.freeze({
  platform_mode: PLATFORM_MODES,
  engine_mode: ENGINE_MODES,
  risk_level: RISK_LEVELS,
  max_correlation: CORRELATION_LIMITS,
  void_policy: VOID_POLICIES,
  // DV-27 (Phase 48): a Node-only extension legacy does not have. Legacy has exactly one
  // behaviour — the configured fixed stake — so its default fills every existing row.
  staking_method: STAKING_METHODS,
});

/** Every field a caller may change. Anything else in a patch is ignored, as legacy does. */
export const CONFIGURATION_FIELDS = Object.freeze([
  "module_enabled",
  "ticket_engine_enabled",
  "platform_mode",
  "engine_mode",
  "target_odds_min",
  "target_odds_max",
  "max_selections",
  "risk_level",
  "min_confidence",
  "min_expected_value",
  "max_correlation",
  "min_data_quality",
  "min_liquidity",
  "allowed_markets",
  "allowed_leagues",
  "max_exposure",
  "stake_amount",
  "staking_method",
  "void_policy",
  "require_calibration",
]);

export const REASON_MAX_LENGTH = 500;

/** The configuration in force before any version has been saved. Legacy `defaults()`. */
export function defaultConfiguration() {
  return {
    version: 0,
    module_enabled: true,
    ticket_engine_enabled: true,
    platform_mode: "SANDBOX",
    engine_mode: "USER_APPROVAL_REQUIRED",
    target_odds_min: 5,
    target_odds_max: 8,
    max_selections: 5,
    risk_level: "CONSERVATIVE",
    min_confidence: 75,
    min_expected_value: 0.02,
    max_correlation: "MEDIUM",
    min_data_quality: 80,
    min_liquidity: null,
    allowed_markets: [],
    allowed_leagues: [],
    max_exposure: 100,
    stake_amount: 10,
    // DV-27: Node's one addition to legacy's field list. `FLAT` is legacy's behaviour
    // unchanged — the fixed `stake_amount` copied onto each ticket — so the defaults are
    // otherwise what PHP asserts, and the parity test pins both facts.
    staking_method: "FLAT",
    void_policy: "RESTITUTE_ODDS",
    require_calibration: true,
    updated_by: "system",
    reason: "built-in defaults",
  };
}

/**
 * Validate a complete configuration. Returns the first error (legacy reports one at a
 * time, and so does this), or null when the configuration is acceptable.
 *
 * Node validates types before the range checks. Legacy casts with `(float)` first, so
 * `"abc"` becomes `0` and fails on a range. Node refuses the type up front, which gives
 * a clearer message (DV-15).
 *
 * @param {Record<string, any>} c
 * @param {{allowAutomatedExecution?: boolean}} [options]
 * @returns {string|null}
 */
export function validateConfiguration(c, { allowAutomatedExecution = false } = {}) {
  // Enumerations first, in legacy's order, because the first failure is what a caller sees.
  if (!PLATFORM_MODES.includes(c.platform_mode)) return `platform_mode must be one of ${PLATFORM_MODES.join(", ")}`;
  if (!ENGINE_MODES.includes(c.engine_mode)) return `engine_mode must be one of ${ENGINE_MODES.join(", ")}`;
  if (c.engine_mode === "AUTOMATED_EXECUTION" && !allowAutomatedExecution) {
    return "AUTOMATED_EXECUTION requires explicit authorization (allowAutomatedExecution) and remains disabled in this deployment";
  }
  if (!RISK_LEVELS.includes(c.risk_level)) return `risk_level must be one of ${RISK_LEVELS.join(", ")}`;
  if (!CORRELATION_LIMITS.includes(c.max_correlation)) return "max_correlation must be LOW or MEDIUM";
  if (!VOID_POLICIES.includes(c.void_policy)) return `void_policy must be one of ${VOID_POLICIES.join(", ")}`;
  // DV-27's field, validated with legacy's own style: one enumeration, one sentence.
  // An ABSENT key is not an error: every read path (the DDL default, `prepareConfiguration`,
  // `configurationRow`, `defaultConfiguration`) supplies FLAT, so a caller handing the
  // validator a row shaped before migration 022 still means FLAT. A PRESENT key must be
  // valid. This is also what keeps the PHP-parity golden cases — which carry only the
  // keys legacy validates — meaningful on both sides.
  if (c.staking_method !== undefined && c.staking_method !== null && !STAKING_METHODS.includes(c.staking_method)) {
    return `staking_method must be one of ${STAKING_METHODS.join(", ")}`;
  }

  for (const field of [...NUMBER_FIELDS]) {
    if (typeof c[field] !== "number" || !Number.isFinite(c[field])) return `${field} must be a finite number`;
  }
  for (const field of BOOLEAN_FIELDS) {
    if (typeof c[field] !== "boolean") return `${field} must be a boolean`;
  }
  if (c.min_liquidity !== null && (typeof c.min_liquidity !== "number" || !Number.isFinite(c.min_liquidity))) {
    return "min_liquidity must be a finite number or null";
  }

  if (c.target_odds_min <= 1.0 || c.target_odds_max <= c.target_odds_min) {
    return "target odds range must satisfy 1.0 < min <= max";
  }
  if (c.max_selections < 1 || c.max_selections > 12) return "max_selections must be within [1, 12]";
  if (c.min_confidence < 50 || c.min_confidence > 100) return "min_confidence must be within [50, 100]";
  if (c.min_expected_value < 0) return "min_expected_value must be >= 0";
  if (c.min_data_quality < 60 || c.min_data_quality > 100) return "min_data_quality must be within [60, 100]";
  if (c.max_exposure <= 0) return "max_exposure must be > 0";
  if (c.stake_amount <= 0) return "stake_amount must be > 0";
  if (c.stake_amount > c.max_exposure) return "stake_amount cannot exceed max_exposure";
  if (c.min_liquidity !== null && c.min_liquidity < 0) return "min_liquidity must be >= 0";

  for (const field of LIST_FIELDS) {
    const list = c[field];
    if (!Array.isArray(list)) return `${field} must be an array`;
    for (const item of list) {
      if (typeof item !== "string" || item.trim() === "") return `${field} entries must be non-empty strings`;
    }
  }
  return null;
}

/**
 * Plan the next configuration version from a patch.
 *
 * Returns the row to persist, or the validation error. Nothing is written here.
 *
 * @param {Record<string, any>} base the configuration currently in force
 * @param {Record<string, any>} patch only `CONFIGURATION_FIELDS` are read
 * @param {object} options
 * @param {string} options.actor the acting administrator's id
 * @param {string} [options.reason]
 * @param {boolean} [options.allowAutomatedExecution=false]
 * @param {string} options.createdAt canonical timestamp for the new row
 * @returns {{ok: true, row: Record<string, any>, next: Record<string, any>} | {ok: false, reason: string}}
 */
export function planConfigurationUpdate(base, patch, { actor, reason = "", allowAutomatedExecution = false, createdAt }) {
  const next = { ...base };
  for (const field of CONFIGURATION_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(patch, field)) next[field] = patch[field];
  }

  const error = validateConfiguration(next, { allowAutomatedExecution });
  if (error !== null) return { ok: false, reason: error };

  const row = { version: Number(base.version) + 1 };
  for (const field of CONFIGURATION_FIELDS) row[field] = next[field];
  row.allowed_markets = [...next.allowed_markets];
  row.allowed_leagues = [...next.allowed_leagues];
  row.updated_by = actor;
  row.reason = Array.from(String(reason)).slice(0, REASON_MAX_LENGTH).join("");
  row.created_at = createdAt;
  return { ok: true, row, next };
}

/**
 * The fields whose values differ between two configurations, for the audit trail.
 *
 * @returns {string[]}
 */
export function changedConfigurationFields(previous, next) {
  return CONFIGURATION_FIELDS.filter((field) => JSON.stringify(previous[field] ?? null) !== JSON.stringify(next[field] ?? null));
}
