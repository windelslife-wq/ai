/**
 * Per-provider circuit breaker: CLOSED → OPEN after `threshold` failures inside
 * `windowMs`, OPEN → HALF_OPEN once `cooldownMs` has elapsed, HALF_OPEN → OPEN
 * on the very next failure (a probe is not a second chance), any success →
 * CLOSED with the failure window cleared.
 *
 * Ported from `application/libraries/Aegis/CircuitBreaker.php` with the same
 * defaults (5 failures / 60 s window / 30 s cooldown). The clock is injectable
 * so the state machine is testable without sleeping: the legacy test had to
 * `usleep(30000)` to observe HALF_OPEN, and a suite that sleeps is a suite
 * nobody runs twice.
 */

export const CLOSED = "CLOSED";
export const OPEN = "OPEN";
export const HALF_OPEN = "HALF_OPEN";

export function createCircuitBreaker(name, {
  threshold = 5,
  windowMs = 60_000,
  cooldownMs = 30_000,
  now = () => Date.now(),
} = {}) {
  let failures = [];
  let state = CLOSED;
  let openedAt = 0;

  function currentState() {
    if (state === OPEN && now() - openedAt >= cooldownMs) state = HALF_OPEN;
    return state;
  }

  return {
    name,
    threshold,
    windowMs,
    cooldownMs,
    currentState,
    canCall() {
      const current = currentState();
      return current === CLOSED || current === HALF_OPEN;
    },
    recordSuccess() {
      failures = [];
      state = CLOSED;
    },
    recordFailure() {
      const at = now();
      failures = [...failures, at].filter((timestamp) => at - timestamp <= windowMs);
      if (state === HALF_OPEN || failures.length >= threshold) {
        state = OPEN;
        openedAt = at;
      }
    },
    /** Test/diagnostic hook: the failures currently inside the window. */
    recentFailures() {
      return failures.length;
    },
  };
}
