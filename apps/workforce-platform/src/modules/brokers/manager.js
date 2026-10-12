/**
 * The connector registry — a port of `BrokerManager` in
 * `application/libraries/Aegis/Brokers/BrokerConnector.php` (row 13).
 *
 * The manager is the only thing the rest of the platform is allowed to touch.
 * Legacy's rule is preserved exactly: connectors "never receive strategy/agent
 * objects", and the execution supervisor never receives a connector directly —
 * it asks the manager for one that may route, and gets `null` when none may.
 *
 * `tradingConnector()` is the whole safety argument in four lines. It requires
 * BOTH that a connector is order-capable AND that its own freshly-reported
 * status says `READY` with `orderSubmissionEffective === true`. A connector that
 * merely has a `placeOrder` method is not enough; a connector whose local
 * `_TRADING_ENABLED` flag is set is not enough; the bridge has to agree, and the
 * account has to be a demo one unless live trading was separately and explicitly
 * allowed. When no connector satisfies that, this returns `null` and routing
 * stays disabled — which is the state this platform is in until a real adapter is
 * deployed and verified.
 */

/**
 * @param {object} [options]
 * @param {Array<object>} [options.connectors] connectors to register at construction
 */
export function createBrokerManager(options = {}) {
  /** @type {Map<string, object>} insertion-ordered, as legacy's PHP array was */
  const connectors = new Map();

  function register(connector) {
    if (!connector || typeof connector.id !== "function") {
      throw new Error("a broker connector must expose id()");
    }
    const id = connector.id();
    if (typeof id !== "string" || id.trim() === "") {
      throw new Error("a broker connector must have a non-empty id");
    }
    // Re-registering an id would silently replace a connector whose gates were
    // already evaluated. Legacy's array assignment had the same hazard; refusing
    // it here means a duplicate registration is a bug that surfaces immediately.
    if (connectors.has(id)) throw new Error(`broker connector '${id}' is already registered`);
    connectors.set(id, connector);
  }

  for (const connector of options.connectors ?? []) register(connector);

  /**
   * Structural equivalent of legacy's `$connector instanceof TradingConnector`.
   * Node has no interfaces, so an order-capable connector is one that exposes the
   * order methods. A read-only connector never does, and can never be returned by
   * `tradingConnector()` no matter what its status reports.
   */
  function isOrderCapable(connector) {
    return typeof connector?.placeOrder === "function"
      && typeof connector?.cancelOrder === "function"
      && typeof connector?.closePosition === "function";
  }

  function get(id) {
    return connectors.get(String(id)) ?? null;
  }

  function ids() {
    return [...connectors.keys()];
  }

  /**
   * Legacy `allStatus()`, merged with `id` and `capabilities` per connector.
   *
   * **Async, where legacy was synchronous** (divergence BC-8): `status()` performs
   * a health probe, and on this platform that is non-blocking I/O rather than a
   * blocking `file_get_contents`. Callers must await it. The shape is unchanged.
   *
   * One connector failing to report must not erase the others, so a throwing
   * `status()` degrades to an honest `ERROR` entry instead of rejecting the whole
   * map — the sweep that reads this runs unattended and a single dead adapter
   * should not blind it to the rest.
   */
  async function allStatus() {
    const out = {};
    for (const [id, connector] of connectors) {
      let status;
      try {
        status = await connector.status();
      } catch (error) {
        status = {
          state: "ERROR",
          message: `${id} could not report its status`,
          configured: false,
          connector: id,
          reason: String(error?.message || error).slice(0, 240),
        };
      }
      let capabilities = null;
      try {
        capabilities = connector.capabilities();
      } catch {
        capabilities = null;
      }
      out[id] = Object.freeze({ ...status, id, capabilities });
    }
    return out;
  }

  /**
   * The first connector that may actually route an order, or `null`.
   *
   * `status()` is called here rather than `orderSubmissionEffective()` alone,
   * because legacy required `state === 'READY'` too — and that ordering matters:
   * `READY` is only reachable when the adapter is enabled, configured and healthy,
   * so this cannot return a connector that would then fail its own first gate.
   */
  async function tradingConnector() {
    for (const connector of connectors.values()) {
      if (!isOrderCapable(connector)) continue;
      const status = await connector.status();
      if (status?.state === "READY" && status?.orderSubmissionEffective === true) return connector;
    }
    return null;
  }

  /**
   * The single boolean the status surface and the execution supervisor need:
   * is there any connector through which an order could be routed right now?
   */
  async function routable() {
    return (await tradingConnector()) !== null;
  }

  /**
   * How many connectors are enabled with a URL and a token — **without probing
   * any of them**. Safe to call from an unauthenticated surface, which `status()`
   * and `routable()` are not (BC-11).
   */
  function configuredCount() {
    let total = 0;
    for (const connector of connectors.values()) {
      try {
        if (typeof connector.isConfigured === "function" ? connector.isConfigured() : false) total += 1;
      } catch {
        // A connector that cannot answer is not configured.
      }
    }
    return total;
  }

  return Object.freeze({
    register,
    get,
    ids,
    configuredCount,
    allStatus,
    tradingConnector,
    routable,
    isOrderCapable,
    get size() {
      return connectors.size;
    },
  });
}
