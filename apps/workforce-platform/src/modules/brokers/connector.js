/**
 * The safety-gated trading connector boundary — a port of
 * `application/libraries/Aegis/Brokers/ConfiguredTradingConnectors.php` and
 * `Mt5BridgeConnector.php` (row 13).
 *
 * Legacy has two classes that enforce the same gates: a generic
 * `ConfiguredTradingConnector` (the base for the MT4, crypto-exchange and
 * stock-broker adapters) and a hand-written `Mt5BridgeConnector`. This file is
 * one factory covering both, because the *gate set* is identical and only the
 * error wording differed. Divergences BC-3 and BC-4 record the two places where
 * Node deliberately follows the MT5 class rather than the generic one.
 *
 * THE SAFETY MODEL, unchanged from legacy:
 *
 *   - Nothing is enabled by default. A connector needs `_ENABLED`, a valid URL
 *     and a token even to be *read*.
 *   - Order submission needs the local `_TRADING_ENABLED` flag **and** a bridge
 *     that reports `tradingEnabled: true`. Flipping our env var is not enough if
 *     the bridge itself refuses to trade.
 *   - Non-demo accounts are refused unless `_LIVE_ALLOWED=1` is *also* set. Demo
 *     is the safe default and no provider is ever silently live. The adapter
 *     never guesses whether an account is safe to trade.
 *   - Every write re-runs the whole gate set against a **force-refreshed** health
 *     probe. A cached "READY" from four seconds ago is not a reason to place an
 *     order now.
 *
 * Transport is injectable — `transport(method, path, token, body)` — which is the
 * seam legacy used for its own tests and the reason these gates can be proven
 * here without a real bridge, a real terminal or a real order.
 */

import {
  normalizeAccount,
  normalizeCandles,
  normalizeCloseResult,
  normalizeHistory,
  normalizeOrderResult,
  normalizePendingOrders,
  normalizePositions,
  normalizeQuote,
  normalizeTicketResult,
} from "./normalizer.js";

/** Legacy `HEALTH_TTL_SECONDS = 5` — long enough to keep probes cheap, short
 *  enough that a bridge going down is noticed within one sweep. */
export const HEALTH_TTL_MS = 5_000;

/** Legacy's generic connector used an 8 s request timeout; the MT5 bridge used 5 s. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 8_000;

const TIMEFRAMES = Object.freeze(["1m", "5m", "15m", "1h", "4h", "1d"]);

/**
 * Legacy's generic connector accepted `/^[A-Z0-9._:-]{1,64}$/` while the MT5
 * connector and `BrokerDataNormalizer` both accept `/^[A-Z0-9._-]{1,32}$/`.
 *
 * That mismatch is a latent defect in legacy, not a feature: a symbol containing
 * `:` (or longer than 32 characters) passes the generic connector's own gate and
 * is then **refused by the normalizer** applied to the response, so the request
 * fails after it has already been sent to the bridge. Node uses the narrower
 * pattern everywhere — divergence BC-5, recorded because it is a tightening that
 * changes which inputs are refused and when.
 */
const SYMBOL = /^[A-Z0-9._-]{1,32}$/;

function requireSymbol(value, label = "symbol") {
  const symbol = String(value ?? "").trim().toUpperCase();
  if (!SYMBOL.test(symbol)) throw new Error(`invalid broker ${label}`);
  return symbol;
}

/**
 * Legacy `validUrl()`: absolute http(s), a non-empty host, and **no embedded
 * credentials**. Configuration already enforces https in production and strips
 * the path via `httpsBaseUrl`, but the connector re-checks because `configured`
 * is reported to callers and must not claim a URL is usable when it is not.
 */
export function isConfiguredUrl(url) {
  const raw = String(url ?? "").trim();
  if (!raw) return false;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  if (!parsed.hostname) return false;
  return !parsed.username && !parsed.password;
}

function positiveNumber(value, label) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${label} must be positive`);
  return parsed;
}

/**
 * @param {object} options
 * @param {string} options.id connector id, e.g. `mt5-bridge`
 * @param {string} options.displayName used verbatim in every refusal message
 * @param {string[]} [options.marketClasses] lowercased, de-duplicated
 * @param {string} [options.url]
 * @param {string} [options.token]
 * @param {boolean} [options.enabled]
 * @param {boolean} [options.tradingEnabled] local *intent* to submit orders
 * @param {boolean} [options.liveAllowed] explicit opt-in for non-demo accounts
 * @param {(method: string, path: string, token: string|null, body: object|null) => (object|null|Promise<object|null>)} [options.transport]
 * @param {() => number} [options.now]
 * @param {number} [options.healthTtlMs]
 * @param {number} [options.requestTimeoutMs]
 */
export function createTradingConnector(options = {}) {
  const id = String(options.id ?? "").trim();
  if (!id) throw new Error("a broker connector requires an id");
  const displayName = String(options.displayName ?? id).trim() || id;
  const marketClasses = Object.freeze(
    [...new Set((options.marketClasses ?? []).map((entry) => String(entry).toLowerCase()))],
  );
  const url = String(options.url ?? "").trim();
  const token = String(options.token ?? "").trim();
  const enabled = options.enabled === true;
  const tradingEnabled = options.tradingEnabled === true;
  const liveAllowed = options.liveAllowed === true;
  const now = options.now ?? (() => Date.now());
  const healthTtlMs = Number.isFinite(options.healthTtlMs) ? options.healthTtlMs : HEALTH_TTL_MS;
  const requestTimeoutMs = Number.isFinite(options.requestTimeoutMs)
    ? options.requestTimeoutMs
    : DEFAULT_REQUEST_TIMEOUT_MS;
  const transport = options.transport ?? null;

  /** `null` until the first probe; `{checkedAt, payload}` afterwards. */
  let healthCache = null;

  function configured() {
    return isConfiguredUrl(url);
  }

  /**
   * Legacy `health()`. A probe that throws is cached as `null` — not retried
   * immediately — so a down bridge cannot be hammered once per status call.
   * Writes pass `force: true` to bypass the cache entirely.
   *
   * The probe is sent **without** the token (BC-4, following the MT5 connector):
   * `/health` does not require it, and sending a bearer credential to an endpoint
   * that does not check it widens that credential's exposure for no benefit.
   */
  async function health({ force = false } = {}) {
    const at = now();
    if (!force && healthCache !== null && at - healthCache.checkedAt < healthTtlMs) {
      return healthCache.payload;
    }
    let payload = null;
    try {
      payload = await callTransport("GET", "/health", null, null);
    } catch {
      payload = null;
    }
    healthCache = { checkedAt: at, payload: isPlainObject(payload) ? payload : null };
    return healthCache.payload;
  }

  /**
   * The effective, bridge-verified order capability — **the only one the
   * supervisor trusts**. `capabilities().orderSubmission` is local intent; this
   * is whether an order may actually be sent right now.
   */
  async function orderSubmissionEffective(probe = undefined) {
    const payload = probe !== undefined
      ? probe
      : (enabled && configured() && token !== "" ? await health() : null);
    if (!isPlainObject(payload) || payload.ok !== true) return false;
    if (!tradingEnabled || payload.tradingEnabled !== true) return false;
    const accountType = String(payload.accountType ?? "unknown").toLowerCase();
    // Demo is the safe default. A non-demo account needs a separate, explicit,
    // connector-specific opt-in; no provider is silently live.
    return accountType === "demo" || liveAllowed;
  }

  function capabilities() {
    return Object.freeze({
      accountRead: true,
      marketData: true,
      tradingRead: true,
      // Intent only. The effective gate is `orderSubmissionEffective`, verified
      // against the bridge on every order call.
      orderSubmission: tradingEnabled,
      liveTrading: liveAllowed,
      marketClasses,
      requiresBridge: true,
      reason: tradingEnabled
        ? "Write intent is enabled; the adapter health response and account safety gate must also pass."
        : "Read-only by default. Set the connector TRADING_ENABLED flag only after the provider adapter is verified.",
    });
  }

  /**
   * The four-state ladder legacy reports: `DISABLED` → `NOT_CONFIGURED` → `DOWN`
   * → `READY`. Only `READY` carries the bridge-reported fields, so a caller
   * cannot mistake a configured-but-unreachable adapter for a working one.
   *
   * Never returns the URL, a query string or any secret (BC-6).
   */
  async function status() {
    const base = { state: "DISABLED", message: "", configured: configured(), connector: id };
    if (!enabled) {
      return Object.freeze({
        ...base,
        message: `Connector disabled by default. Set ${envHint()}_ENABLED=1 after its adapter is verified.`,
      });
    }
    if (!configured() || token === "") {
      return Object.freeze({
        ...base,
        state: "NOT_CONFIGURED",
        message: `${envHint()}_URL and ${envHint()}_TOKEN are required.`,
      });
    }
    const payload = await health();
    if (!isPlainObject(payload) || payload.ok !== true) {
      return Object.freeze({
        ...base,
        state: "DOWN",
        message: `${displayName} adapter health check failed.`,
      });
    }
    const simulated = payload.simulated === true;
    return Object.freeze({
      ...base,
      state: "READY",
      message: simulated
        ? "Adapter reachable — SIMULATION only."
        : "Adapter reachable; provider-specific verification is still required.",
      bridgeVersion: payload.version === undefined || payload.version === null ? null : String(payload.version),
      bridgeTradingEnabled: payload.tradingEnabled === true,
      accountType: payload.accountType === undefined || payload.accountType === null ? "unknown" : String(payload.accountType),
      simulated,
      orderSubmissionEffective: await orderSubmissionEffective(payload),
    });
  }

  /**
   * Legacy `assertTradingAllowed()`, with the MT5 connector's granular messages
   * (BC-3). Six distinct refusals rather than three, because "safety gates
   * failed — order refused" leaves an operator with nothing to act on while
   * "bridge reports tradingEnabled=false" names the fix.
   *
   * The health probe is **forced**, so a write never relies on a cached READY.
   */
  async function assertTradingAllowed() {
    if (!enabled || !configured()) throw new Error(`${displayName} is not enabled and configured`);
    if (token === "") throw new Error(`${displayName} token is not configured`);
    const payload = await health({ force: true });
    if (!isPlainObject(payload) || payload.ok !== true) {
      throw new Error(`${displayName} health check failed — order refused`);
    }
    if (!tradingEnabled) throw new Error(`${displayName} order submission is disabled`);
    if (payload.tradingEnabled !== true) {
      throw new Error(`${displayName} reports tradingEnabled=false — order refused`);
    }
    const accountType = String(payload.accountType ?? "unknown");
    if (!liveAllowed && accountType.toLowerCase() !== "demo") {
      throw new Error(`${displayName} is on a '${accountType}' account — demo accounts only unless live trading is explicitly allowed`);
    }
  }

  /**
   * Legacy `read()`: the bridge envelope is `{ok, data, error}`. Any transport
   * failure becomes a generic message, so a URL, a token or a provider stack
   * trace can never reach a caller through an error string. A provider-supplied
   * `error` is passed through but truncated to 200 characters, exactly as legacy
   * did.
   */
  async function read(method, path, kind, body = null) {
    if (!enabled || !configured()) throw new Error(`${displayName} is not enabled and configured`);
    if (token === "") throw new Error(`${displayName} token is not configured`);
    let payload;
    try {
      payload = await callTransport(method, path, token, body);
    } catch {
      throw new Error(`${displayName} ${kind} request failed`);
    }
    if (!isPlainObject(payload) || payload.ok === false) {
      const message = isPlainObject(payload) && typeof payload.error === "string"
        ? payload.error.slice(0, 200)
        : `${displayName} ${kind} request failed`;
      throw new Error(message);
    }
    // Legacy checked `is_array($data)`, which in PHP is true for a list *and* a
    // map. That matters: the list endpoints (`/v1/positions`, `/v1/orders`,
    // `/v1/history`, `/v1/candles`) return a JSON array as `data`, so refusing
    // arrays here would reject every successful list read. The per-contract shape
    // is enforced by the normalizer, which requires an array for lists and an
    // object for single records.
    if (!Array.isArray(payload.data) && !isPlainObject(payload.data)) {
      throw new Error(`${displayName} ${kind} response is invalid`);
    }
    return payload.data;
  }

  async function callTransport(method, path, authToken, body) {
    if (typeof transport !== "function") {
      throw new Error(`${displayName} has no transport configured`);
    }
    return transport(method, path, authToken, body, { timeoutMs: requestTimeoutMs });
  }

  function envHint() {
    return String(options.envPrefix ?? id.toUpperCase().replaceAll("-", "_"));
  }

  const clock = { now };

  return Object.freeze({
    id: () => id,
    displayName: () => displayName,
    /**
     * Probe-free: does this connector have everything it needs to be *asked*?
     * Distinct from `status()`, which reaches the network. The public status
     * surface uses this so an unauthenticated caller cannot trigger a probe (BC-11).
     */
    isConfigured: () => enabled && configured() && token !== "",
    capabilities,
    status,
    orderSubmissionEffective,
    /** Test seam: forget the cached probe so the next read re-checks the bridge. */
    resetHealthCache() {
      healthCache = null;
    },

    async account() {
      return normalizeAccount(await read("GET", "/v1/account", "account"), id, clock);
    },
    async quote(symbol) {
      return normalizeQuote(
        await read("GET", `/v1/quotes/${encodeURIComponent(requireSymbol(symbol))}`, "quote"),
        id,
        clock,
      );
    },
    async candles(symbol, timeframe = "1h", limit = 500) {
      const normalizedSymbol = requireSymbol(symbol);
      const tf = String(timeframe ?? "");
      if (!TIMEFRAMES.includes(tf)) throw new Error("invalid timeframe");
      // Legacy clamped rather than refused an out-of-range limit: a caller asking
      // for 100k candles gets 1000, not an error.
      const bounded = Math.max(10, Math.min(1000, Math.trunc(Number(limit) || 0)));
      return normalizeCandles(
        await read("GET", `/v1/candles/${encodeURIComponent(normalizedSymbol)}?tf=${encodeURIComponent(tf)}&limit=${bounded}`, "candles"),
        id,
        clock,
      );
    },
    async positions() {
      return normalizePositions(await read("GET", "/v1/positions", "positions"), id, clock);
    },
    async pendingOrders() {
      return normalizePendingOrders(await read("GET", "/v1/orders", "pending orders"), id, clock);
    },
    async history(limit = 100) {
      const bounded = Math.max(1, Math.min(500, Math.trunc(Number(limit) || 0)));
      return normalizeHistory(await read("GET", `/v1/history?limit=${bounded}`, "history"), id, clock);
    },

    /**
     * Place an order. Every gate runs first; the request body uses legacy's
     * `action` key (not `side`) because that is the documented bridge contract.
     */
    async placeOrder(order = {}) {
      await assertTradingAllowed();
      const symbol = requireSymbol(order.symbol);
      const side = String(order.side ?? "").toUpperCase();
      const type = String(order.type ?? "MARKET").toUpperCase();
      if (!["BUY", "SELL"].includes(side)) throw new Error("side must be BUY or SELL");
      if (!["MARKET", "LIMIT"].includes(type)) throw new Error("type must be MARKET or LIMIT");
      const volume = Number(order.volume ?? 0);
      if (!Number.isFinite(volume) || volume <= 0) throw new Error("volume must be positive");
      const body = { action: side, type, symbol, volume };
      for (const field of ["price", "stopLoss", "takeProfit"]) {
        if (order[field] === undefined || order[field] === null) continue;
        body[field] = positiveNumber(order[field], field);
      }
      if (type === "LIMIT" && body.price === undefined) throw new Error("LIMIT orders require a price");
      return normalizeOrderResult(await read("POST", "/v1/orders", "order placement", body), id, clock);
    },

    async modifyOrder(ticket, changes = {}) {
      await assertTradingAllowed();
      const body = {};
      for (const field of ["stopLoss", "takeProfit", "price"]) {
        if (changes[field] === undefined || changes[field] === null) continue;
        // Legacy's MT5 connector accepted *any* numeric here, including zero and
        // negatives, while its generic connector required a positive value. A
        // non-positive stop loss sent to a real bridge is a malformed order, so
        // Node requires positive on every connector — divergence BC-7, and the
        // one place this port is deliberately stricter than the MT5 class.
        body[field] = positiveNumber(changes[field], field);
      }
      if (Object.keys(body).length === 0) throw new Error("nothing to modify");
      return normalizeTicketResult(
        await read("POST", `/v1/orders/${encodeTicket(ticket)}/modify`, "order modify", body),
        id,
      );
    },

    async cancelOrder(ticket) {
      await assertTradingAllowed();
      return normalizeTicketResult(
        await read("POST", `/v1/orders/${encodeTicket(ticket)}/cancel`, "order cancel"),
        id,
      );
    },

    async closePosition(ticket) {
      await assertTradingAllowed();
      return normalizeCloseResult(
        await read("POST", `/v1/positions/${encodeTicket(ticket)}/close`, "position close"),
        id,
        clock,
      );
    },
  });
}

/**
 * Tickets go into a URL path, so they are validated as integers rather than
 * interpolated. Legacy typed them `int` in the signature; Node has no such
 * coercion at a JSON boundary and must refuse a string that would otherwise
 * become a path segment.
 */
function encodeTicket(ticket) {
  const parsed = Number(ticket);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error("ticket must be a positive integer");
  return String(parsed);
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
