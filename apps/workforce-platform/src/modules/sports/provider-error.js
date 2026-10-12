/**
 * Typed provider failure — the port of
 * `Aegis\Sports\Providers\ProviderException`.
 *
 * Legacy's own summary: *"Carries the classified status so the manager and health
 * monitor never have to guess what went wrong."* That is the whole reason this
 * exists as a distinct error type rather than a plain `Error`: the fallback chain
 * decides whether to try the next provider, and the health monitor decides what
 * status to derive, and **neither may infer either from a message string**.
 *
 * The classification also separates two things that look identical from the
 * outside and are not: `RATE_LIMITED` and `AUTHENTICATION_ERROR` are terminal for
 * this attempt but differ in what an operator should do about them (wait, versus
 * rotate a credential), and neither is retryable by simply falling through to
 * another provider that has no such credential.
 */

/**
 * The provider's own health vocabulary. `UNKNOWN` is not in this list because a
 * provider never reports it — only `ProviderHealthMonitor` derives it, when there
 * are no observations at all, and inventing one is exactly what it refuses to do.
 */
export const PROVIDER_STATUSES = Object.freeze([
  "ONLINE",
  "DEGRADED",
  "OFFLINE",
  "RATE_LIMITED",
  "AUTHENTICATION_ERROR",
  "DATA_ERROR",
]);

/** Every status that counts as a failure when scanning health history. */
export const FAILURE_STATUSES = Object.freeze([
  "OFFLINE",
  "DATA_ERROR",
  "RATE_LIMITED",
  "AUTHENTICATION_ERROR",
  "DEGRADED",
]);

/** Statuses whose most recent report wins outright, because fallback cannot fix them. */
export const TERMINAL_STATUSES = Object.freeze(["AUTHENTICATION_ERROR", "RATE_LIMITED"]);

export const PROVIDER_STATUS = Object.freeze({
  ONLINE: "ONLINE",
  DEGRADED: "DEGRADED",
  OFFLINE: "OFFLINE",
  RATE_LIMITED: "RATE_LIMITED",
  AUTHENTICATION_ERROR: "AUTHENTICATION_ERROR",
  DATA_ERROR: "DATA_ERROR",
  UNKNOWN: "UNKNOWN",
});

/**
 * A provider failure that knows what kind of failure it is.
 *
 * @extends {Error}
 */
export class ProviderError extends Error {
  /** @param {string} message @param {string} status one of `PROVIDER_STATUSES` @param {unknown} [cause] */
  constructor(message, status = PROVIDER_STATUS.DATA_ERROR, cause) {
    super(message);
    this.name = "ProviderError";
    this.status = PROVIDER_STATUSES.includes(status) ? status : PROVIDER_STATUS.DATA_ERROR;
    if (cause !== undefined) this.cause = cause;
  }
}
