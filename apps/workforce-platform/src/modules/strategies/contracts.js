/**
 * Request contracts for the Strategy Lab API.
 *
 * The vocabulary mirrors `application/controllers/Api_strategies.php`, and in two
 * places it is deliberately NARROWER than the platform's:
 *
 *  - `timeframe` accepts `15m | 1h | 4h | 1d`, not the six the market-data module
 *    serves. `Api_strategies::run_backtest` rejects anything else with
 *    "invalid timeframe", and a 1-minute backtest would be almost entirely spread
 *    and slippage — the cost model charges every fill, so the shorter the bar the
 *    larger the fraction of gross P&L that is cost.
 *  - `marketClass` accepts `forex | crypto | commodity`, not the nine the
 *    market-data module knows. Same source: the legacy controller's own list.
 *
 * Both are parity, not opinion. A caller asking for `5m` gets a 400 here exactly
 * as it does on the legacy route.
 *
 * ## Where each kind of validation lives
 *
 * These schemas validate SHAPE and VOCABULARY: required fields, types, string
 * lengths, enums, and `additionalProperties: false` so an undeclared key is
 * rejected with UNKNOWN_PROPERTY rather than smuggled into a run.
 *
 * Numeric policy is deliberately left to the engine, because the engine and the
 * legacy disagree with a schema in two ways that matter:
 *
 *  - `limit` is CLAMPED into 60..5000 by `resolveBacktestRequest`, not refused.
 *    A schema bound would turn a clamp into a 400 and change behaviour.
 *  - `initialEquity`, `riskPct`, `feeBps`, `spreadBps`, `slippageBps`,
 *    `warmupBars` and `maxBarsInTrade` are REFUSED with a precise message by
 *    `resolveBacktestRequest` (`riskPct must be in (0, 5%]`). Declaring bounds
 *    here too would answer the same mistake with two different error shapes —
 *    a 422 VALIDATION_FAILED from the router and a 400 from the service —
 *    depending on which check fired first.
 *
 * So: one source of truth per rule. Shape here, numeric safety in the engine.
 */

import {
  BACKTEST_LIMIT_MAX,
  BACKTEST_LIMIT_MIN,
} from "./backtester.js";
import { LIFECYCLE_STAGES } from "./registry.js";
import { GROUP_KEYS } from "./journal-analytics.js";

/** The four timeframes a strategy backtest may use (legacy `run_backtest`). */
export const STRATEGY_TIMEFRAMES = Object.freeze(["15m", "1h", "4h", "1d"]);

/** The three market classes a strategy backtest may use (legacy `run_backtest`). */
export const STRATEGY_MARKET_CLASSES = Object.freeze(["forex", "crypto", "commodity"]);

/**
 * Candle bounds for an optimization run (legacy `Platform::optimizeStrategy`).
 *
 * The floor is 420 rather than the backtester's 120 because the optimizer splits
 * the series 70/30 and refuses to rank a segment under 120 bars: 420 * 0.3 = 126,
 * so 420 is the smallest history that yields two usable segments. The ceiling
 * 2000 bounds one request's work on shared hosting.
 */
export const OPTIMIZE_CANDLE_MIN = 420;
export const OPTIMIZE_CANDLE_MAX = 2_000;
export const OPTIMIZE_CANDLE_DEFAULT = 800;

/** Legacy default symbol for an optimization request that names none. */
export const DEFAULT_OPTIMIZE_SYMBOL = "BTCUSDT";

const IDENTIFIER = /^[A-Za-z0-9_-]{1,64}$/;
const STRATEGY_ID = /^[a-z0-9][a-z0-9_-]{0,59}$/;

/**
 * An empty version means "the latest", and an empty strategyId filter means "no
 * filter" — both are legacy behaviour (`$version ?: ''`, `$strategyId ?: null`),
 * so the optional forms accept the empty string rather than 400-ing on it. A
 * client that builds a query string from an unset variable sends `?version=` and
 * must get the latest version, not a validation error.
 */
const VERSION = /^$|^[A-Za-z0-9._-]{1,20}$/;
const OPTIONAL_STRATEGY_ID = /^$|^[a-z0-9][a-z0-9_-]{0,59}$/;

/**
 * Symbols are upper-cased by the engine, not by the schema.
 *
 * `src/http/validate.js` supports `trim` and `lowercase` and has NO `uppercase`
 * keyword, so declaring one here would be silently ignored — a schema line that
 * reads like a guarantee and is not one. Case folding stays where the legacy does
 * it: `resolveBacktestRequest` upper-cases for a run, and the service upper-cases
 * for an optimization, matching `strtoupper($input['symbol'])` in
 * `Backtester::run` and `Platform::optimizeStrategy`.
 */

/**
 * The backtester's own tunables, as optional body properties.
 *
 * Every one of them is typed but NOT bounded here — see the header. They are
 * shared by the run and optimize bodies because legacy passes
 * `array_intersect_key($input, Backtester::DEFAULTS)` from the optimize request
 * straight into the backtester, so the two accept the same knobs.
 */
const BACKTEST_TUNABLES = Object.freeze({
  limit: Object.freeze({ type: "integer", nullable: true }),
  initialEquity: Object.freeze({ type: "number", nullable: true }),
  riskPct: Object.freeze({ type: "number", nullable: true }),
  feeBps: Object.freeze({ type: "number", nullable: true }),
  spreadBps: Object.freeze({ type: "number", nullable: true }),
  slippageBps: Object.freeze({ type: "number", nullable: true }),
  allowShorts: Object.freeze({ type: "boolean", nullable: true }),
  warmupBars: Object.freeze({ type: "integer", nullable: true }),
  maxBarsInTrade: Object.freeze({ type: "integer", nullable: true }),
});

/** Optional date-range filter, applied after the candles are fetched. */
const RANGE_FIELDS = Object.freeze({
  from: Object.freeze({ type: "string", nullable: true, maxLength: 32 }),
  to: Object.freeze({ type: "string", nullable: true, maxLength: 32 }),
});

export const BACKTEST_BODY = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["strategyId", "symbol", "marketClass", "timeframe"],
  properties: Object.freeze({
    strategyId: Object.freeze({ type: "string", minLength: 1, maxLength: 60, pattern: STRATEGY_ID }),
    strategyVersion: Object.freeze({ type: "string", nullable: true, maxLength: 20, pattern: VERSION }),
    symbol: Object.freeze({ type: "string", minLength: 2, maxLength: 24 }),
    marketClass: Object.freeze({ type: "string", values: [...STRATEGY_MARKET_CLASSES] }),
    timeframe: Object.freeze({ type: "string", values: [...STRATEGY_TIMEFRAMES] }),
    ...BACKTEST_TUNABLES,
    ...RANGE_FIELDS,
  }),
});

export const OPTIMIZE_BODY = Object.freeze({
  type: "object",
  additionalProperties: false,
  properties: Object.freeze({
    strategyVersion: Object.freeze({ type: "string", nullable: true, maxLength: 20, pattern: VERSION }),
    symbol: Object.freeze({ type: "string", nullable: true, minLength: 2, maxLength: 24 }),
    marketClass: Object.freeze({ type: "string", nullable: true, values: [...STRATEGY_MARKET_CLASSES] }),
    timeframe: Object.freeze({ type: "string", nullable: true, values: [...STRATEGY_TIMEFRAMES] }),
    /**
     * Register the winning parameters as a NEW version with source `ai`.
     *
     * Default false, and the note returned with a registered variant says why:
     * an `ai`-sourced strategy is refused the paper and live stages until a human
     * signs off, so adopting a result is the start of a lifecycle, not the end of
     * one.
     */
    register: Object.freeze({ type: "boolean", nullable: true, default: false }),
    ...BACKTEST_TUNABLES,
  }),
});

export const STATUS_BODY = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["to"],
  properties: Object.freeze({
    to: Object.freeze({ type: "string", values: [...LIFECYCLE_STAGES] }),
    reason: Object.freeze({ type: "string", nullable: true, maxLength: 500 }),
    version: Object.freeze({ type: "string", nullable: true, maxLength: 20, pattern: VERSION }),
  }),
});

export const STRATEGY_PARAMS = Object.freeze({
  strategyId: Object.freeze({ type: "string", required: true, minLength: 1, maxLength: 60, pattern: STRATEGY_ID }),
});

export const BACKTEST_PARAMS = Object.freeze({
  backtestId: Object.freeze({ type: "string", required: true, minLength: 1, maxLength: 64, pattern: IDENTIFIER }),
});

export const SHOW_QUERY = Object.freeze({
  version: { type: "string", maxLength: 20, pattern: VERSION },
});

export const RESULTS_QUERY = Object.freeze({
  strategyId: { type: "string", maxLength: 60, pattern: OPTIONAL_STRATEGY_ID },
  // The legacy route was hard-coded to 30 rows with no way to ask for more. A
  // bounded limit is additive; the default preserves the legacy response.
  limit: { type: "integer", min: 1, max: 100, default: 30 },
});

// ---- journal and model/decision analytics ---------------------------------
//
// Legacy `Api_journal`: `api/journal`, `api/journal/manual`,
// `api/analytics/summary`, `api/analytics/confidence-calibration`. The journal is
// part of this module rather than a separate one because it is one bounded
// context: backtests WRITE journal rows and analytics READ them, and both already
// live in this module's repository.

/** Ceiling for a journal listing, matching the legacy calibration query. */
export const JOURNAL_LIMIT_MAX = 2_000;

/** Legacy `Api_journal::index` read a fixed 200 rows. */
export const JOURNAL_LIMIT_DEFAULT = 200;

/**
 * A manually recorded trade.
 *
 * Three deliberate divergences from the legacy handler, each recorded in
 * `docs/migration/PHASE6_STRATEGIES.md`:
 *
 *  - `reasonForTrade` over 500 characters is REJECTED rather than silently
 *    truncated. Legacy applied `mb_substr(..., 0, 500)`, which loses the end of
 *    someone's rationale without telling them — and the rationale is the field a
 *    reviewer reads to judge whether the trade had a thesis.
 *  - `aiConfidence` is bounded to 0..1. Legacy accepted any number, but the
 *    calibration buckets span [0, 1.0001), so a confidence of 5 would be written
 *    and then silently excluded from every bucket — the calibration report would
 *    quietly omit trades it was supposed to measure.
 *  - `entryTime` and `exitTime` are validated as parseable instants, and
 *    `exitTime` may not precede `entryTime`. Legacy checked both too, but after
 *    the `empty()` scan, so the order of the two 400s could differ; here the shape
 *    checks come first, consistently.
 */
export const MANUAL_JOURNAL_BODY = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["symbol", "direction", "entryTime", "entryPrice", "positionSize", "reasonForTrade"],
  properties: Object.freeze({
    symbol: Object.freeze({ type: "string", minLength: 2, maxLength: 24 }),
    direction: Object.freeze({ type: "string", values: ["LONG", "SHORT"] }),
    market: Object.freeze({ type: "string", nullable: true, maxLength: 12 }),
    strategy: Object.freeze({ type: "string", nullable: true, maxLength: 60, pattern: OPTIONAL_STRATEGY_ID }),
    strategyVersion: Object.freeze({ type: "string", nullable: true, maxLength: 20, pattern: VERSION }),
    entryTime: Object.freeze({ type: "string", minLength: 1, maxLength: 40 }),
    exitTime: Object.freeze({ type: "string", nullable: true, maxLength: 40 }),
    entryPrice: Object.freeze({ type: "number" }),
    exitPrice: Object.freeze({ type: "number", nullable: true }),
    positionSize: Object.freeze({ type: "number" }),
    stopLoss: Object.freeze({ type: "number", nullable: true }),
    takeProfit: Object.freeze({ type: "number", nullable: true }),
    fees: Object.freeze({ type: "number", nullable: true }),
    slippage: Object.freeze({ type: "number", nullable: true }),
    reasonForTrade: Object.freeze({ type: "string", minLength: 1, maxLength: 500 }),
    aiConfidence: Object.freeze({ type: "number", nullable: true, min: 0, max: 1 }),
    confidenceSource: Object.freeze({ type: "string", nullable: true, maxLength: 16 }),
    agentConsensus: Object.freeze({ type: "string", nullable: true, maxLength: 120 }),
    riskScore: Object.freeze({ type: "number", nullable: true }),
  }),
});

export const JOURNAL_QUERY = Object.freeze({
  source: { type: "string", maxLength: 10, pattern: /^$|^(backtest|manual|paper|live)$/ },
  strategy: { type: "string", maxLength: 60, pattern: OPTIONAL_STRATEGY_ID },
  symbol: { type: "string", maxLength: 24 },
  limit: { type: "integer", min: 1, max: JOURNAL_LIMIT_MAX, default: JOURNAL_LIMIT_DEFAULT },
});

export const SUMMARY_QUERY = Object.freeze({
  groupBy: { type: "string", values: [...GROUP_KEYS], default: "strategy" },
});

export const messages = Object.freeze({
  STRATEGY_NOT_FOUND: (id) => `Strategy ${id} was not found on this platform.`,
  BACKTEST_NOT_FOUND: "That backtest result does not exist on this platform.",
  TRANSITION_REJECTED: "That lifecycle transition was rejected.",
  OPTIMIZE_BUILTIN_ONLY:
    "optimization requires a builtin strategy (trend-following, mean-reversion, breakout, momentum)",
  STORE_UNAVAILABLE:
    "The Strategy Lab requires a persistence adapter, and none is configured on this host",
  MARKET_DATA_UNAVAILABLE:
    "Backtesting requires the market-data service, and it is not configured on this host",
  INVALID_ENTRY_TIME: "invalid entryTime (ISO 8601 expected)",
  EXIT_BEFORE_ENTRY: "exitTime cannot precede entryTime",
  NON_POSITIVE_PRICE_OR_SIZE: "prices and size must be positive",
});

export { BACKTEST_LIMIT_MIN, BACKTEST_LIMIT_MAX, LIFECYCLE_STAGES, GROUP_KEYS };
