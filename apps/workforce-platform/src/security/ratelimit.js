/**
 * In-process rate limiting and credential-stuffing lockout (finding F-08).
 *
 * Deliberately bounded: entries are pruned on a schedule and the map has a hard
 * key cap, so a spread of random keys cannot grow memory without limit. Limits
 * are per process; on a multi-worker host they are a floor, not a global ceiling,
 * and that limitation is documented rather than hidden.
 */

export function createRateLimiter({ maxEntries = 20_000, sweepIntervalMs = 30_000, timer = null } = {}) {
  const buckets = new Map();
  let lastSweep = 0;

  function sweep(now) {
    for (const [key, entry] of buckets) {
      if (now >= entry.resetAt) buckets.delete(key);
    }
    lastSweep = now;
  }

  function check(key, { max, windowMs }, now = Date.now()) {
    if (!Number.isFinite(max) || max < 1) throw new TypeError("rate limit max must be a positive integer");
    if (now - lastSweep > sweepIntervalMs) sweep(now);
    let bucket = buckets.get(key);
    if (!bucket || now >= bucket.resetAt) {
      if (buckets.size >= maxEntries) sweep(now);
      // Even after sweeping, a hostile spread can exceed the cap; oldest-entry
      // eviction keeps memory bounded and only weakens limits under load.
      while (buckets.size >= maxEntries) buckets.delete(buckets.keys().next().value);
      bucket = { count: 0, resetAt: now + windowMs };
      buckets.set(key, bucket);
    }
    bucket.count += 1;
    if (bucket.count <= max) return 0;
    return Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
  }

  return {
    check,
    sweep,
    get size() {
      return buckets.size;
    },
    reset() {
      buckets.clear();
    },
  };
}

/**
 * Failed-login lockout with the legacy semantics preserved: five failures lock
 * the key for fifteen minutes (PHP `Auth::login` used a session-scoped counter;
 * the Node port keys it on account identifier AND client address so a shared
 * browser cannot be used to lock an account out).
 */
export function createLoginGuard({ maxFailures = 5, lockMs = 15 * 60_000, windowMs = 15 * 60_000, maxEntries = 20_000 } = {}) {
  const attempts = new Map();

  function prune(now) {
    for (const [key, entry] of attempts) {
      if (entry.lockedUntil > now) continue;
      if (now - entry.firstFailureAt > windowMs) attempts.delete(key);
    }
  }

  function evaluate(keys, now = Date.now()) {
    prune(now);
    let longestWaitMs = 0;
    for (const key of keys) {
      const entry = attempts.get(key);
      if (!entry) continue;
      if (entry.lockedUntil > now) longestWaitMs = Math.max(longestWaitMs, entry.lockedUntil - now);
    }
    return longestWaitMs > 0 ? Math.ceil(longestWaitMs / 1000) : 0;
  }

  function recordFailure(keys, now = Date.now()) {
    prune(now);
    if (attempts.size >= maxEntries) {
      const oldestKey = attempts.keys().next().value;
      attempts.delete(oldestKey);
    }
    for (const key of keys) {
      const entry = attempts.get(key);
      if (!entry || now - entry.firstFailureAt > windowMs) {
        attempts.set(key, { count: 1, firstFailureAt: now, lockedUntil: 0 });
        continue;
      }
      entry.count += 1;
      if (entry.count >= maxFailures) entry.lockedUntil = now + lockMs;
    }
    return evaluate(keys, now);
  }

  function clear(keys) {
    for (const key of keys) attempts.delete(key);
  }

  return {
    evaluate,
    recordFailure,
    clear,
    get size() {
      return attempts.size;
    },
    reset() {
      attempts.clear();
    },
  };
}
