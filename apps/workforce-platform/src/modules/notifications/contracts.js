/**
 * Strict contracts for the operator notification surface.
 *
 * The vocabulary below is copied from the legacy application, not invented: every
 * `type` is one the PHP platform actually publishes through
 * `Aegis\Notifications\Notifier::notify()` (see the ten call sites under
 * `application/libraries/Aegis/`), and every `severity` is one the legacy
 * repository accepted before coercing anything else to `info`.
 */

const NOTIFICATION_ID = /^[1-9][0-9]{0,15}$/;

/** The ten legacy notification types. A new module adds its type here explicitly. */
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

/** Legacy `severity` column domain (`Aegis_model.php` coerced anything else to `info`). */
export const NOTIFICATION_SEVERITIES = Object.freeze(["info", "warning", "critical"]);

export const NOTIFICATION_PARAMS = Object.freeze({
  notificationId: Object.freeze({ type: "string", required: true, minLength: 1, maxLength: 16, pattern: NOTIFICATION_ID }),
});

export const INBOX_QUERY = Object.freeze({
  // Legacy accepted only `?unread=1`; the shared validator's query coercion also
  // answers `true`/`yes`. Everything else is false, as it was.
  unread: Object.freeze({ type: "boolean", default: false }),
  limit: Object.freeze({ type: "integer", min: 1, max: 200, default: 50 }),
  severity: Object.freeze({ type: "string", values: NOTIFICATION_SEVERITIES }),
  type: Object.freeze({ type: "string", values: NOTIFICATION_TYPES }),
});

export const EMPTY_BODY = Object.freeze({ type: "object", additionalProperties: false, properties: Object.freeze({}) });
