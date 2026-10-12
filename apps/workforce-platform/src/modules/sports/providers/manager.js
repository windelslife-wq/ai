/**
 * Provider registry with a graceful fallback chain — the port of
 * `Aegis\Sports\Providers\SportsProviderManager`.
 *
 * Legacy's contract, quoted because it states the safety property this class
 * exists to hold: *"`withFallback()` runs an operation against the first provider
 * that is ONLINE and succeeds; failures are classified (ProviderException status),
 * reported through the health observer, and the next provider is tried. If no
 * provider can serve the request the caller receives a structured failure — the
 * pipeline then degrades safely (no fabricated data, no forced tickets)."*
 *
 * **"No fabricated data, no forced tickets" is the load-bearing phrase.** A
 * fallback chain that returned an empty list on total failure would be
 * indistinguishable from a day with no fixtures, and a downstream ticket engine
 * would then have to guess which it was looking at. Returning
 * `{ok: false, failures}` keeps the two apart, and every provider that was tried
 * is named with the reason it could not serve.
 *
 * **SP-4 — every method that consults a provider is `async`.** Legacy's manager
 * is synchronous because PHP's `file_get_contents` blocks the request. Node's
 * HTTP provider does non-blocking I/O, so `health()`, `withFallback()` and the
 * provider calls themselves all return promises. The shapes are unchanged; the
 * call sites must await. This is the same divergence as BC-8 in the broker port.
 */

import { PROVIDER_STATUS, ProviderError } from "../provider-error.js";

/**
 * @typedef {object} SportsDataProvider
 * @property {() => string} id
 * @property {() => Promise<Record<string, unknown>>} health
 * @property {(query: Record<string, unknown>) => Promise<Array<Record<string, unknown>>>} fixtures
 * @property {(fixtureExternalId: string) => Promise<Array<Record<string, unknown>>>} odds
 * @property {(fixtureExternalId: string) => Promise<Array<Record<string, unknown>>>} results
 */

/**
 * The operations `withFallback` accepts. Used as the label on every health
 * observation, so a stored health row can say which call produced it.
 */
export const PROVIDER_OPERATIONS = Object.freeze(["fixtures", "odds", "results"]);

/**
 * Create a provider manager.
 *
 * @param {object} [options]
 * @param {SportsDataProvider[]} [options.providers] registered in this order; the
 *   order **is** the fallback preference, so the cheapest or most trusted provider
 *   goes first
 * @returns {Readonly<Record<string, unknown>>}
 */
export function createSportsProviderManager({ providers = [] } = {}) {
  /** @type {Map<string, SportsDataProvider>} */
  const registry = new Map();
  /** @type {string[]} registration order, kept separately so it survives re-registration */
  const order = [];
  /** @type {null | ((event: Record<string, unknown>) => void | Promise<void>)} */
  let observer = null;

  for (const provider of providers) register(provider);

  /**
   * Register a provider. Re-registering the same id **replaces** it in place and
   * keeps its original position in the fallback order, so a caller can swap an
   * implementation without silently changing which provider is preferred.
   *
   * @param {SportsDataProvider} provider
   */
  function register(provider) {
    if (!provider || typeof provider.id !== "function") {
      throw new TypeError("a sports provider must expose id(), health(), fixtures(), odds() and results()");
    }
    const id = String(provider.id());
    if (!registry.has(id)) order.push(id);
    registry.set(id, provider);
  }

  /**
   * Observe every provider outcome, for the health monitor.
   *
   * The observer is called for successes, for classified failures **and** for
   * providers skipped because they were not ONLINE — the third case matters most,
   * because a provider that is silently never consulted would otherwise look
   * healthy forever. An observer that throws is swallowed: legacy's comment is
   * *"health observation must never break sync"*, and a monitoring defect must not
   * be able to turn a working ingest into a failed one.
   *
   * @param {(event: {providerId: string, operation: string, error: ProviderError|null,
   *   payload: Record<string, unknown>}) => void|Promise<void>} fn
   */
  function setHealthObserver(fn) {
    observer = typeof fn === "function" ? fn : null;
  }

  async function notify(provider, operation, error, payload) {
    if (observer === null) return;
    try {
      await observer({ providerId: String(provider.id()), operation, error, payload });
    } catch {
      // Deliberately empty: see the docblock above.
    }
  }

  /** @param {string} id @returns {SportsDataProvider|null} */
  function provider(id) {
    return registry.get(id) ?? null;
  }

  /** Every provider, in registration order. */
  function all() {
    return order.map((id) => registry.get(id)).filter((entry) => entry !== undefined);
  }

  /**
   * Each provider's own self-reported health, keyed by id.
   *
   * This calls every provider's `health()` — which for the HTTP provider is a real
   * outbound request. Callers that only want to know what has been *observed*
   * should read the stored health history and let `ProviderHealthMonitor` derive a
   * status, which is what the status route does; this method is for a deliberate
   * live probe.
   *
   * A provider whose `health()` throws degrades to a `DATA_ERROR` entry rather
   * than failing the whole map, so one broken vendor cannot hide the other nine.
   *
   * @returns {Promise<Record<string, Record<string, unknown>>>}
   */
  async function health() {
    const out = {};
    for (const id of order) {
      const entry = registry.get(id);
      if (!entry) continue;
      try {
        out[id] = { id, ...(await entry.health()) };
      } catch (error) {
        out[id] = {
          id,
          status: error instanceof ProviderError ? error.status : PROVIDER_STATUS.DATA_ERROR,
          detail: error instanceof Error ? error.message : String(error),
        };
      }
    }
    return out;
  }

  /** Whether any provider is registered at all. Registering is not enabling. */
  function configured() {
    return registry.size > 0;
  }

  /**
   * Run `fn(provider)` against the first provider that is ONLINE and succeeds.
   *
   * @param {string} operation one of `PROVIDER_OPERATIONS`, recorded on every observation
   * @param {(provider: SportsDataProvider) => Promise<Array<Record<string, unknown>>>|Array<Record<string, unknown>>} fn
   * @param {string|null} [preferredId] tried first when it is registered, without
   *   removing it from its normal position for later attempts
   * @returns {Promise<{ok: true, provider: string, result: Array<Record<string, unknown>>,
   *   failures: Record<string, string>} | {ok: false, failures: Record<string, string>}>}
   */
  async function withFallback(operation, fn, preferredId = null) {
    /** @type {Record<string, string>} */
    const failures = {};
    const ids = [...order];
    if (preferredId !== null && ids.includes(preferredId)) {
      ids.splice(ids.indexOf(preferredId), 1);
      ids.unshift(preferredId);
    }

    for (const id of ids) {
      const entry = registry.get(id);
      if (!entry) continue;
      let reported;
      try {
        // Health is consulted per attempt, not once for the whole chain: a
        // provider that failed the previous call may have recovered, and one that
        // succeeded may have just been rate-limited.
        reported = await entry.health();
      } catch (error) {
        const classified =
          error instanceof ProviderError
            ? error
            : new ProviderError(error instanceof Error ? error.message : String(error), PROVIDER_STATUS.DATA_ERROR, error);
        failures[id] = `${classified.status}: ${classified.message}`;
        await notify(entry, operation, classified, {});
        continue;
      }

      const status = typeof reported?.status === "string" ? reported.status : PROVIDER_STATUS.OFFLINE;
      if (status !== PROVIDER_STATUS.ONLINE) {
        const detail = typeof reported?.detail === "string" ? reported.detail : "";
        failures[id] = `provider status ${status}${detail}`;
        await notify(entry, operation, null, { skipped: status });
        continue;
      }

      try {
        const result = await fn(entry);
        await notify(entry, operation, null, { ok: true });
        return { ok: true, provider: id, result, failures };
      } catch (error) {
        const classified =
          error instanceof ProviderError
            ? error
            : new ProviderError(error instanceof Error ? error.message : String(error), PROVIDER_STATUS.DATA_ERROR, error);
        failures[id] = `${classified.status}: ${classified.message}`;
        await notify(entry, operation, classified, {});
      }
    }

    // A structured failure, never an empty success — see the module docblock.
    return { ok: false, failures };
  }

  return Object.freeze({
    register,
    setHealthObserver,
    provider,
    all,
    health,
    configured,
    withFallback,
  });
}
