/**
 * Client-side mirror of the server contracts the screens depend on.
 *
 * Every list here is a copy of a list the server already declares, and the copy
 * exists for one reason: an operator must be able to pick from the real
 * vocabulary (a notification `type`, an audit `sort`) instead of typing it and
 * being refused. The copy is not trusted, though — `test/console_screens.test.js`
 * imports both sides and fails if a single entry drifts apart, and the server
 * re-validates every value anyway, so a drifted copy produces a 400, never a
 * silently different query.
 *
 * Nothing here is a bound the client should enforce by itself: the inputs use
 * these values to *guide*, and the API remains the authority for all of them.
 */

/** `src/modules/notifications/contracts.js` — the legacy notification vocabulary. */
export const NOTIFICATION_TYPES = Object.freeze([
  "KILL_SWITCH",
  "TRADING_MODE_CHANGED",
  "TRADE_APPROVAL_REQUESTED",
  "PROPOSAL_EXPIRED",
  "ORDER_FILLED",
  "EXECUTION_FAILED",
  "ROUTING_BLOCKED",
  "PORTFOLIO_RISK",
  "BROKER_CONNECTED",
  "BROKER_DISCONNECTED",
  "SPORTS_MODEL_DRIFT",
]);

export const NOTIFICATION_SEVERITIES = Object.freeze(["info", "warning", "critical"]);

/** `INBOX_QUERY.limit` — server maximum for one inbox page. */
export const INBOX_LIMIT_MAX = 200;

/** `src/modules/identity/contracts.js` → `AUDIT_QUERY`. */
export const AUDIT_SORTS = Object.freeze(["createdAt", "action", "id"]);
export const AUDIT_DIRECTIONS = Object.freeze(["asc", "desc"]);
export const AUDIT_LIMIT_MAX = 200;

/** `src/modules/portfolio/service.js` and `optimizer.js`. */
export const PORTFOLIO_MARKET_CLASSES = Object.freeze([
  "forex", "crypto", "commodity", "stock", "etf", "futures", "options", "indices", "bonds",
]);
export const PORTFOLIO_TIMEFRAMES = Object.freeze(["15m", "1h", "4h", "1d"]);
export const PORTFOLIO_OBJECTIVES = Object.freeze(["max_sharpe", "min_variance"]);
export const MIN_ASSETS = 2;
export const MAX_ASSETS = 12;
export const MIN_CANDLE_LIMIT = 31;
export const MAX_CANDLE_LIMIT = 2000;

/** `src/modules/sports/routes.js` → `MATCHES_QUERY`, `TICKETS_QUERY`, `SYNC_RUNS_QUERY`, `CALIBRATIONS_QUERY`. */
export const SPORTS_MATCH_STATUSES = Object.freeze(["SCHEDULED", "LIVE", "FINISHED", "POSTPONED", "CANCELLED", "SUSPENDED"]);
export const SPORTS_TICKET_APPROVALS = Object.freeze(["PENDING_USER_APPROVAL", "APPROVED_NOT_EXECUTED", "REJECTED"]);
export const SPORTS_JOB_TYPES = Object.freeze(["FIXTURES", "ODDS", "RESULTS"]);
export const SPORTS_CALIBRATION_STATUSES = Object.freeze(["PENDING", "APPROVED", "REJECTED"]);

/** `src/modules/lottery/routes.js` → `STATISTICS_PARAMS`. */
export const LOTTERY_STATISTICS_KINDS = Object.freeze([
  "numbers", "stars", "hot-cold", "distribution", "pairs", "triplets", "star-pairs",
]);

/**
 * The permission each workspace screen is gated on, and the elevated permissions
 * the sports and lottery consoles use for their own controls. The console test
 * asserts each of these is the permission the matching endpoint enforces, and
 * that the screen references it before rendering the control.
 */
export const SCREEN_PERMISSIONS = Object.freeze({
  audit: "identity.users.view",
  portfolioOptimizer: "trading.view",
  notifications: "system.authenticated",
  sports: "sports.view",
  lottery: "lottery.view",
  sportsApprove: "sports.approve",
  sportsSettle: "sports.settle",
  lotteryManage: "lottery.manage",
});
