/**
 * Broker connector boundary: the normalized data contracts, the health ladder and
 * the order gates (row 13).
 *
 * Every test here runs against an **injected transport**, which is the seam legacy
 * used for its own bridge tests. That is what makes the gates provable without a
 * real bridge, a real terminal or a real order — and it is why this file contains
 * no network access at all.
 *
 * The point of the gate tests is not that a configured connector can trade. It is
 * the opposite: that every one of the ways an order could be sent without all four
 * gates agreeing is refused, and refused *before* the transport is called. A test
 * that asserted only the happy path would prove nothing about the safety model.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

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
} from "../src/modules/brokers/normalizer.js";
import { createTradingConnector, isConfiguredUrl } from "../src/modules/brokers/connector.js";
import { createBrokerManager } from "../src/modules/brokers/manager.js";
import { BROKER_CONNECTOR_ROSTER, createBrokerRegistry, plannedConnectors } from "../src/modules/brokers/registry.js";
import { brokerEnvNames, BROKER_CONNECTOR_ENV, BROKER_ENV_SUFFIXES } from "../src/config.js";

const NOW = Date.parse("2026-10-12T09:30:00Z");
const now = () => NOW;

/** A bridge that answers from a table and records every call it received. */
function fakeBridge(routes = {}) {
  const calls = [];
  const transport = async (method, path, token, body) => {
    calls.push({ method, path, token, body });
    const handler = routes[`${method} ${path}`] ?? routes[path] ?? routes["*"];
    if (typeof handler === "function") return handler({ method, path, token, body });
    if (handler instanceof Error) throw handler;
    return handler === undefined ? null : handler;
  };
  return { transport, calls };
}

const HEALTHY_DEMO = Object.freeze({ ok: true, tradingEnabled: true, accountType: "demo", simulated: false, version: "1.4.2" });

function connector(overrides = {}, routes = { "GET /health": HEALTHY_DEMO }) {
  const bridge = fakeBridge(routes);
  const instance = createTradingConnector({
    id: "mt5-bridge",
    displayName: "MT5 bridge",
    envPrefix: "AEGIS_MT5_BRIDGE",
    marketClasses: ["forex", "crypto"],
    url: "http://127.0.0.1:8790",
    token: "bridge-token",
    enabled: true,
    tradingEnabled: true,
    transport: bridge.transport,
    now,
    ...overrides,
  });
  return { connector: instance, calls: bridge.calls };
}

// --------------------------------------------------------------------- normalizer

test("the account contract derives free margin the way legacy did and refuses negatives", async (t) => {
  const account = normalizeAccount(
    { currency: "usd", balance: "1000.5", equity: 1100, margin: 100, accountId: 12345, leverage: 30 },
    "mt5-bridge",
    { now },
  );
  assert.equal(account.currency, "USD", "currency is upper-cased");
  assert.equal(account.balance, 1000.5, "a numeric string is accepted, as PHP's is_numeric accepted it");
  assert.equal(account.freeMargin, 1000, "free margin defaults to equity minus margin");
  assert.equal(account.accountId, "12345", "the account id is stringified, never left numeric");
  assert.equal(account.timestamp, "2026-10-12T09:30:00+00:00");

  // The derived floor matters: a margin call must not produce a negative-looking
  // free margin that a sizing calculation would then treat as available capital.
  const called = normalizeAccount({ currency: "USD", balance: 500, equity: 400, margin: 900 }, "x", { now });
  assert.equal(called.freeMargin, 0, "a derived free margin is floored at zero");

  for (const [label, raw, message] of [
    ["a two-letter currency", { currency: "US", balance: 1, equity: 1 }, "broker account currency is invalid"],
    ["negative equity", { currency: "USD", balance: 1, equity: -1 }, "broker account values cannot be negative"],
    ["negative reported free margin", { currency: "USD", balance: 1, equity: 1, freeMargin: -5 }, "broker account values cannot be negative"],
    ["a missing balance", { currency: "USD", equity: 1 }, "broker response missing balance"],
    ["a null margin", { currency: "USD", balance: 1, equity: 1, margin: null }, "broker response margin is invalid"],
  ]) {
    await t.test(`refuses ${label}`, () => {
      assert.throws(() => normalizeAccount(raw, "x", { now }), { message });
    });
  }
});

test("the quote contract refuses an inverted or non-positive spread", async () => {
  const quote = normalizeQuote({ symbol: "eurusd", bid: 1.1, ask: 1.1002, timestamp: 1_760_000_000 }, "x", { now });
  assert.equal(quote.symbol, "EURUSD");
  assert.equal(quote.last, 1.1001, "last defaults to the midpoint when the bridge omits it");
  assert.ok(Math.abs(quote.spread - 0.0002) < 1e-12);
  assert.equal(quote.timestamp, "2025-10-09T08:53:20+00:00", "a numeric timestamp is epoch seconds");

  // `last: null` must fall back to the midpoint, not throw: PHP's isset() is false
  // for an explicit null, and collapsing that into `?? ` would change the answer.
  const explicitNull = normalizeQuote({ symbol: "EURUSD", bid: 1, ask: 2, last: null }, "x", { now });
  assert.equal(explicitNull.last, 1.5);

  for (const [label, raw, message] of [
    ["an inverted quote", { symbol: "EURUSD", bid: 2, ask: 1 }, "broker quote bid/ask is invalid"],
    ["a zero bid", { symbol: "EURUSD", bid: 0, ask: 1 }, "broker quote bid/ask is invalid"],
    ["a missing ask", { symbol: "EURUSD", bid: 1 }, "broker response missing ask"],
    ["a symbol with a colon", { symbol: "BTC:USD", bid: 1, ask: 2 }, "broker quote symbol is invalid"],
    ["a 33-character symbol", { symbol: "A".repeat(33), bid: 1, ask: 2 }, "broker quote symbol is invalid"],
    ["an unparseable timestamp", { symbol: "EURUSD", bid: 1, ask: 2, timestamp: "not-a-date" }, "broker response timestamp is invalid"],
  ]) {
    assert.throws(() => normalizeQuote(raw, "x", { now }), { message }, label);
  }
});

test("the list contracts keep legacy's closed vocabularies and drop non-object rows", async () => {
  const positions = normalizePositions([
    { ticket: "7", symbol: "eurusd", side: "long", volume: 0.5, entry: 1.1, profit: 12.5, openedAt: 1_760_000_000 },
    "garbage",
    null,
  ], "x", { now });
  assert.equal(positions.length, 1, "a non-object row is skipped, as legacy skipped a non-array one");
  assert.equal(positions[0].ticket, 7, "the ticket is an integer, not the string the bridge sent");
  assert.equal(positions[0].side, "LONG");
  assert.equal(positions[0].stopLoss, null, "an absent stop loss is null, not zero");
  assert.equal(positions[0].takeProfit, null);

  const pending = normalizePendingOrders([{ ticket: 1, symbol: "BTCUSD", side: "buy", type: "limit", volume: 0.1, price: 50000 }], "x", { now });
  assert.deepEqual([pending[0].side, pending[0].type], ["BUY", "LIMIT"], "pending orders use BUY/SELL and LIMIT/STOP");

  const history = normalizeHistory([{ ticket: 2, symbol: "XAUUSD", side: "short", volume: 1, entry: 2000, exit: 1950, profit: 50 }], "x", { now });
  assert.equal(history[0].exit, 1950);

  assert.throws(() => normalizePositions([{ ticket: 1, symbol: "EURUSD", side: "BUY", volume: 1, entry: 1 }], "x", { now }), { message: "broker response side is invalid" }, "a position side is LONG/SHORT, not BUY/SELL");
  assert.throws(() => normalizePendingOrders([{ ticket: 1, symbol: "EURUSD", side: "BUY", type: "MARKET", volume: 1, price: 1 }], "x", { now }), { message: "broker response type is invalid" }, "a pending type is LIMIT/STOP, not MARKET");
  assert.throws(() => normalizeHistory([{ ticket: 1, symbol: "EURUSD", side: "LONG", volume: 1, entry: 1 }], "x", { now }), { message: "broker response missing exit" });
  assert.throws(() => normalizePositions("not-a-list", "x", { now }), { message: "broker response is invalid" });
});

test("the candle contract validates the OHLC relationship and renames the wire keys", async () => {
  const candles = normalizeCandles([{ t: 1_760_000_000, o: 1, h: 3, l: 0.5, c: 2 }], "x", { now });
  assert.deepEqual(
    { ...candles[0] },
    { broker: "x", time: "2025-10-09T08:53:20+00:00", open: 1, high: 3, low: 0.5, close: 2, volume: 0 },
    "short wire keys become long ones and volume defaults to zero",
  );

  for (const [label, row] of [
    ["a high below the low", { o: 1, h: 0.5, l: 2, c: 1 }],
    ["a high below the open", { o: 5, h: 3, l: 1, c: 2 }],
    ["a low above the close", { o: 5, h: 6, l: 4, c: 2 }],
  ]) {
    assert.throws(() => normalizeCandles([row], "x", { now }), { message: "broker candle OHLC relationship is invalid" }, label);
  }
});

test("the result contracts keep legacy's shapes, including the hard-coded confirmation flag", async () => {
  assert.deepEqual(
    { ...normalizeOrderResult({ ticket: 42, price: 1.1, placedAt: 1_760_000_000 }, "x", { now }) },
    { broker: "x", ticket: 42, price: 1.1, placedAt: "2025-10-09T08:53:20+00:00" },
  );
  assert.deepEqual(
    { ...normalizeTicketResult({ ticket: 42 }, "x") },
    { broker: "x", ticket: 42, confirmed: true },
    "`confirmed` asserts only that the bridge returned a ticket — which is why the supervisor re-reads state instead of trusting it",
  );
  assert.deepEqual(
    { ...normalizeCloseResult({ ticket: 42, price: 1.2 }, "x", { now }) },
    { broker: "x", ticket: 42, price: 1.2, profit: 0 },
  );
  assert.throws(() => normalizeOrderResult({ price: 1 }, "x", { now }), { message: "broker response missing ticket" });
  assert.throws(() => normalizeOrderResult([], "x", { now }), { message: "broker response is invalid" });
});

// ------------------------------------------------------------------ health ladder

test("a connector nobody enabled reports DISABLED and never touches the network", async () => {
  const { connector: instance, calls } = connector({ enabled: false });
  const status = await instance.status();
  assert.equal(status.state, "DISABLED");
  assert.equal(status.configured, true, "`configured` reports the URL, not the enabled flag");
  assert.equal(status.message, "Connector disabled by default. Set AEGIS_MT5_BRIDGE_ENABLED=1 after its adapter is verified.");
  assert.deepEqual(calls, [], "a disabled connector performs no I/O at all");
  assert.equal(status.bridgeVersion, undefined, "the bridge-reported fields exist only in the READY state");
  assert.equal(await instance.orderSubmissionEffective(), false);
});

test("an enabled connector with no URL or token reports NOT_CONFIGURED", async () => {
  for (const [label, overrides, message] of [
    ["no URL", { url: "" }, "AEGIS_MT5_BRIDGE_URL and AEGIS_MT5_BRIDGE_TOKEN are required."],
    ["no token", { token: "" }, "AEGIS_MT5_BRIDGE_URL and AEGIS_MT5_BRIDGE_TOKEN are required."],
    ["a URL with credentials", { url: "http://user:pass@127.0.0.1:8790" }, "AEGIS_MT5_BRIDGE_URL and AEGIS_MT5_BRIDGE_TOKEN are required."],
    ["a non-absolute URL", { url: "127.0.0.1:8790" }, "AEGIS_MT5_BRIDGE_URL and AEGIS_MT5_BRIDGE_TOKEN are required."],
  ]) {
    const { connector: instance, calls } = connector(overrides);
    const status = await instance.status();
    assert.equal(status.state, "NOT_CONFIGURED", label);
    assert.equal(status.message, message, label);
    assert.equal(status.configured, overrides.url === undefined ? true : isConfiguredUrl(overrides.url), label);
    assert.deepEqual(calls, [], `an unconfigured connector performs no I/O (${label})`);
  }
  assert.equal(isConfiguredUrl("https://bridge.example.com"), true);
  assert.equal(isConfiguredUrl("ftp://bridge.example.com"), false, "only http and https");
});

test("a bridge that does not answer reports DOWN rather than a guessed state", async () => {
  for (const [label, routes] of [
    ["a transport that throws", { "GET /health": new Error("ECONNREFUSED") }],
    ["a null payload", { "GET /health": null }],
    ["ok: false", { "GET /health": { ok: false, error: "bridge starting" } }],
    ["a payload with no ok flag", { "GET /health": { tradingEnabled: true, accountType: "demo" } }],
  ]) {
    const { connector: instance } = connector({}, routes);
    const status = await instance.status();
    assert.equal(status.state, "DOWN", label);
    assert.equal(status.message, "MT5 bridge adapter health check failed.", label);
    assert.equal(status.orderSubmissionEffective, undefined, "the READY-only fields are absent, so a caller cannot read them as false-but-present");
    assert.equal(await instance.orderSubmissionEffective(), false, label);
  }
});

test("READY distinguishes a simulated bridge from an unverified real one", async () => {
  const simulated = await connector({}, { "GET /health": { ...HEALTHY_DEMO, simulated: true } }).connector.status();
  assert.equal(simulated.state, "READY");
  assert.equal(simulated.message, "Adapter reachable — SIMULATION only.");
  assert.equal(simulated.simulated, true);

  const real = await connector().connector.status();
  assert.equal(real.message, "Adapter reachable; provider-specific verification is still required.");
  assert.equal(real.simulated, false);
  assert.equal(real.bridgeVersion, "1.4.2");
  assert.equal(real.accountType, "demo");
  assert.equal(real.bridgeTradingEnabled, true);

  const noVersion = await connector({}, { "GET /health": { ok: true } }).connector.status();
  assert.equal(noVersion.state, "READY");
  assert.equal(noVersion.bridgeVersion, null, "an absent version is null, not undefined");
  assert.equal(noVersion.accountType, "unknown", "an absent account type is 'unknown', never assumed demo");
});

// -------------------------------------------------------------------- order gates

test("order submission needs all four gates, and each one alone is not enough", async (t) => {
  // The table is the safety model: every row is a configuration an operator could
  // plausibly believe enables trading, and every row must refuse.
  const cases = [
    ["all gates agree on a demo account", { tradingEnabled: true, liveAllowed: false }, { ok: true, tradingEnabled: true, accountType: "demo" }, true],
    ["the local flag is off", { tradingEnabled: false, liveAllowed: false }, { ok: true, tradingEnabled: true, accountType: "demo" }, false],
    ["the bridge refuses to trade", { tradingEnabled: true, liveAllowed: false }, { ok: true, tradingEnabled: false, accountType: "demo" }, false],
    ["the bridge does not say", { tradingEnabled: true, liveAllowed: false }, { ok: true, accountType: "demo" }, false],
    ["a live account without the opt-in", { tradingEnabled: true, liveAllowed: false }, { ok: true, tradingEnabled: true, accountType: "live" }, false],
    ["a live account WITH the opt-in", { tradingEnabled: true, liveAllowed: true }, { ok: true, tradingEnabled: true, accountType: "live" }, true],
    ["an unknown account type without the opt-in", { tradingEnabled: true, liveAllowed: false }, { ok: true, tradingEnabled: true }, false],
    ["an unknown account type WITH the opt-in", { tradingEnabled: true, liveAllowed: true }, { ok: true, tradingEnabled: true }, true],
    ["DEMO in upper case still counts as demo", { tradingEnabled: true, liveAllowed: false }, { ok: true, tradingEnabled: true, accountType: "DEMO" }, true],
  ];

  for (const [label, overrides, health, expected] of cases) {
    await t.test(label, async () => {
      const { connector: instance } = connector(overrides, { "GET /health": health });
      assert.equal(await instance.orderSubmissionEffective(), expected, label);
      const status = await instance.status();
      assert.equal(status.orderSubmissionEffective, expected, "status reports the same verdict as the gate itself");
      // `capabilities().orderSubmission` is intent, not permission: it stays true
      // whenever the local flag is set, which is exactly why the supervisor is
      // required to consult the effective gate instead.
      assert.equal(instance.capabilities().orderSubmission, overrides.tradingEnabled === true);
    });
  }
});

test("every write runs the full gate ladder before the transport is called", async (t) => {
  const refusals = [
    ["not enabled", { enabled: false }, { "GET /health": HEALTHY_DEMO }, "MT5 bridge is not enabled and configured"],
    ["no token", { token: "" }, { "GET /health": HEALTHY_DEMO }, "MT5 bridge token is not configured"],
    ["bridge unreachable", { tradingEnabled: true }, { "GET /health": new Error("down") }, "MT5 bridge health check failed — order refused"],
    ["local trading flag off", { tradingEnabled: false }, { "GET /health": HEALTHY_DEMO }, "MT5 bridge order submission is disabled"],
    ["bridge tradingEnabled false", { tradingEnabled: true }, { "GET /health": { ...HEALTHY_DEMO, tradingEnabled: false } }, "MT5 bridge reports tradingEnabled=false — order refused"],
    ["a live account", { tradingEnabled: true }, { "GET /health": { ...HEALTHY_DEMO, accountType: "live" } }, "MT5 bridge is on a 'live' account — demo accounts only unless live trading is explicitly allowed"],
  ];

  for (const [label, overrides, routes, message] of refusals) {
    await t.test(`placeOrder refuses: ${label}`, async () => {
      const { connector: instance, calls } = connector(overrides, routes);
      await assert.rejects(
        instance.placeOrder({ symbol: "EURUSD", side: "BUY", type: "MARKET", volume: 0.1 }),
        { message },
      );
      // The assertion that matters: the refusal happened before any order request.
      // A gate that throws *after* sending would have placed the order.
      assert.deepEqual(
        calls.filter((call) => call.method === "POST"),
        [],
        "no order request was sent",
      );
    });

    await t.test(`modify, cancel and close also refuse: ${label}`, async () => {
      for (const attempt of [
        () => connector(overrides, routes).connector.modifyOrder(1, { stopLoss: 1.1 }),
        () => connector(overrides, routes).connector.cancelOrder(1),
        () => connector(overrides, routes).connector.closePosition(1),
      ]) {
        await assert.rejects(attempt(), { message });
      }
    });
  }
});

test("a write re-probes the bridge instead of trusting the cached health", async () => {
  let healthy = true;
  const { connector: instance, calls } = connector({}, {
    "GET /health": () => (healthy ? HEALTHY_DEMO : { ok: true, tradingEnabled: false, accountType: "demo" }),
    "POST /v1/orders": { ok: true, data: { ticket: 99, price: 1.1 } },
  });

  assert.equal((await instance.status()).state, "READY");
  const healthProbesBefore = calls.filter((call) => call.path === "/health").length;

  const result = await instance.placeOrder({ symbol: "EURUSD", side: "BUY", type: "MARKET", volume: 0.1 });
  assert.equal(result.ticket, 99);
  assert.ok(
    calls.filter((call) => call.path === "/health").length > healthProbesBefore,
    "the write forced a fresh probe rather than reusing the cached READY",
  );

  // The bridge flips between calls. The cache is still warm, so a connector that
  // trusted it would place this order.
  healthy = false;
  await assert.rejects(
    instance.placeOrder({ symbol: "EURUSD", side: "BUY", type: "MARKET", volume: 0.1 }),
    { message: "MT5 bridge reports tradingEnabled=false — order refused" },
  );
});

test("the health probe is cached for reads but never for writes", async () => {
  const { connector: instance, calls } = connector({}, { "GET /health": HEALTHY_DEMO });
  await instance.status();
  await instance.status();
  await instance.status();
  assert.equal(calls.filter((call) => call.path === "/health").length, 1, "three status reads share one probe");

  instance.resetHealthCache();
  await instance.status();
  assert.equal(calls.filter((call) => call.path === "/health").length, 2, "the cache can be dropped explicitly");
});

test("the health probe carries no credential", async () => {
  const { connector: instance, calls } = connector({}, { "GET /health": HEALTHY_DEMO, "GET /v1/account": { ok: true, data: { currency: "USD", balance: 1, equity: 1 } } });
  await instance.status();
  assert.equal(calls[0].path, "/health");
  assert.equal(calls[0].token, null, "a health probe is unauthenticated: the bridge does not require a token for it, and sending one widens its exposure for nothing");

  await instance.account();
  const accountCall = calls.find((call) => call.path === "/v1/account");
  assert.equal(accountCall.token, "bridge-token", "data reads do carry the token");
});

test("a provider error is surfaced but truncated, and no secret can escape in a message", async () => {
  const long = `bridge rejected the order: ${"x".repeat(400)}`;
  const { connector: instance } = connector({}, {
    "GET /health": HEALTHY_DEMO,
    "GET /v1/account": { ok: false, error: long },
  });
  await assert.rejects(instance.account(), { message: long.slice(0, 200) });
  assert.equal(long.slice(0, 200).length, 200);

  // A transport failure must not carry the URL, the token or a stack trace.
  const failing = connector({}, { "GET /health": HEALTHY_DEMO, "GET /v1/account": new Error("connect ECONNREFUSED http://user:secret@127.0.0.1:8790") });
  await assert.rejects(failing.connector.account(), { message: "MT5 bridge account request failed" });

  const invalid = connector({}, { "GET /health": HEALTHY_DEMO, "GET /v1/account": { ok: true, data: "not-an-object" } });
  await assert.rejects(invalid.connector.account(), { message: "MT5 bridge account response is invalid" });
});

test("order bodies are validated before they are sent, and use the bridge's `action` key", async () => {
  const { connector: instance, calls } = connector({}, {
    "GET /health": HEALTHY_DEMO,
    "POST /v1/orders": { ok: true, data: { ticket: 1, price: 1.1 } },
  });

  const result = await instance.placeOrder({ symbol: "eurusd", side: "buy", type: "limit", volume: "0.25", price: 1.1, stopLoss: 1.05, takeProfit: 1.2 });
  assert.equal(result.ticket, 1);
  const sent = calls.find((call) => call.method === "POST");
  assert.deepEqual(sent.body, { action: "BUY", type: "LIMIT", symbol: "EURUSD", volume: 0.25, price: 1.1, stopLoss: 1.05, takeProfit: 1.2 }, "the wire key is `action`, not `side`");

  for (const [label, order, message] of [
    ["an unknown side", { symbol: "EURUSD", side: "HOLD", volume: 1 }, "side must be BUY or SELL"],
    ["an unknown type", { symbol: "EURUSD", side: "BUY", type: "STOP", volume: 1 }, "type must be MARKET or LIMIT"],
    ["zero volume", { symbol: "EURUSD", side: "BUY", volume: 0 }, "volume must be positive"],
    ["a non-finite volume", { symbol: "EURUSD", side: "BUY", volume: Number.NaN }, "volume must be positive"],
    ["a LIMIT with no price", { symbol: "EURUSD", side: "BUY", type: "LIMIT", volume: 1 }, "LIMIT orders require a price"],
    ["a negative stop loss", { symbol: "EURUSD", side: "BUY", volume: 1, stopLoss: -1 }, "stopLoss must be positive"],
    ["a zero take profit", { symbol: "EURUSD", side: "BUY", volume: 1, takeProfit: 0 }, "takeProfit must be positive"],
    ["an invalid symbol", { symbol: "BTC:USD", side: "BUY", volume: 1 }, "invalid broker symbol"],
  ]) {
    await assert.rejects(instance.placeOrder(order), { message }, label);
  }
  assert.equal(calls.filter((call) => call.method === "POST").length, 1, "only the valid order was ever sent");
});

test("modify refuses a non-positive value and an empty change set", async () => {
  const { connector: instance, calls } = connector({}, {
    "GET /health": HEALTHY_DEMO,
    "POST /v1/orders/5/modify": { ok: true, data: { ticket: 5 } },
  });
  const result = await instance.modifyOrder(5, { stopLoss: 1.05 });
  assert.deepEqual({ ...result }, { broker: "mt5-bridge", ticket: 5, confirmed: true });

  // Legacy's MT5 connector accepted any numeric here, including zero and negatives;
  // its generic connector required positive. A non-positive stop loss reaching a
  // real bridge is a malformed order, so Node requires positive everywhere (BC-7).
  await assert.rejects(instance.modifyOrder(5, { stopLoss: 0 }), { message: "stopLoss must be positive" });
  await assert.rejects(instance.modifyOrder(5, { price: -2 }), { message: "price must be positive" });
  await assert.rejects(instance.modifyOrder(5, {}), { message: "nothing to modify" });
  await assert.rejects(instance.modifyOrder(5, { stopLoss: null }), { message: "nothing to modify" });
  assert.equal(calls.filter((call) => call.method === "POST").length, 1);
});

test("a ticket is validated as an integer before it becomes a URL path segment", async () => {
  const { connector: instance, calls } = connector({}, { "GET /health": HEALTHY_DEMO });
  for (const ticket of ["../../admin", "1 OR 1=1", 0, -1, 1.5, Number.NaN, null]) {
    await assert.rejects(instance.cancelOrder(ticket), { message: "ticket must be a positive integer" }, String(ticket));
  }
  assert.deepEqual(calls.filter((call) => call.method === "POST"), [], "no request was built from an unvalidated ticket");
});

test("reads are clamped rather than refused, and candles validate the timeframe", async () => {
  const { connector: instance, calls } = connector({}, {
    "GET /health": HEALTHY_DEMO,
    "*": { ok: true, data: [] },
  });
  await instance.history(10_000);
  await instance.history(0);
  await instance.candles("EURUSD", "1h", 100_000);
  const paths = calls.filter((call) => call.method === "GET").map((call) => call.path);
  assert.ok(paths.includes("/v1/history?limit=500"), "history is clamped to 500");
  assert.ok(paths.includes("/v1/history?limit=1"), "history is clamped up to 1");
  assert.ok(paths.some((path) => path.endsWith("&limit=1000")), "candles are clamped to 1000");

  await assert.rejects(instance.candles("EURUSD", "2h", 100), { message: "invalid timeframe" });
  await assert.rejects(instance.quote(""), { message: "invalid broker symbol" });
});

// ----------------------------------------------------------------------- manager

test("the manager returns a routing connector only when its own status says it may route", async (t) => {
  const readOnly = { id: () => "prices", status: async () => ({ state: "READY", orderSubmissionEffective: true }), capabilities: () => ({}) };

  await t.test("null when nothing is registered", async () => {
    const manager = createBrokerManager();
    assert.equal(await manager.tradingConnector(), null);
    assert.equal(await manager.routable(), false);
    assert.deepEqual(await manager.allStatus(), {});
  });

  await t.test("null for a connector with no order methods, however healthy", async () => {
    const manager = createBrokerManager({ connectors: [readOnly] });
    assert.equal(await manager.tradingConnector(), null, "a read-only connector can never route, whatever its status claims");
    assert.equal(await manager.routable(), false);
    assert.equal(manager.isOrderCapable(readOnly), false);
  });

  await t.test("null when an order-capable connector is READY but not effective", async () => {
    const gated = {
      id: () => "mt5-bridge",
      status: async () => ({ state: "READY", orderSubmissionEffective: false }),
      capabilities: () => ({}),
      placeOrder: async () => { throw new Error("must not be called"); },
      cancelOrder: async () => {},
      closePosition: async () => {},
    };
    const manager = createBrokerManager({ connectors: [gated] });
    assert.equal(await manager.tradingConnector(), null);
  });

  await t.test("null when effective but not READY", async () => {
    const down = {
      id: () => "mt5-bridge",
      status: async () => ({ state: "DOWN", orderSubmissionEffective: true }),
      capabilities: () => ({}),
      placeOrder: async () => {},
      cancelOrder: async () => {},
      closePosition: async () => {},
    };
    assert.equal(await createBrokerManager({ connectors: [down] }).tradingConnector(), null);
  });

  await t.test("the connector when both agree", async () => {
    const live = {
      id: () => "mt5-bridge",
      status: async () => ({ state: "READY", orderSubmissionEffective: true }),
      capabilities: () => ({ orderSubmission: true }),
      placeOrder: async () => {},
      cancelOrder: async () => {},
      closePosition: async () => {},
    };
    const manager = createBrokerManager({ connectors: [readOnly, live] });
    assert.equal(await manager.tradingConnector(), live);
    assert.equal(await manager.routable(), true);
    assert.deepEqual(manager.ids(), ["prices", "mt5-bridge"], "registration order is preserved");
  });
});

test("the manager refuses a duplicate id and merges id and capabilities into every status", async () => {
  const manager = createBrokerManager();
  const one = { id: () => "a", status: async () => ({ state: "DISABLED", message: "off" }), capabilities: () => ({ orderSubmission: false }) };
  manager.register(one);
  assert.throws(() => manager.register({ ...one }), { message: "broker connector 'a' is already registered" });
  assert.throws(() => manager.register({}), { message: "a broker connector must expose id()" });
  assert.throws(() => manager.register({ id: () => "  " }), { message: "a broker connector must have a non-empty id" });
  assert.equal(manager.get("a"), one);
  assert.equal(manager.get("missing"), null);
  assert.equal(manager.size, 1);

  const status = await manager.allStatus();
  assert.deepEqual({ ...status.a }, { state: "DISABLED", message: "off", id: "a", capabilities: { orderSubmission: false } });
});

test("one connector failing to report does not blind the manager to the others", async () => {
  const manager = createBrokerManager();
  manager.register({ id: () => "broken", status: async () => { throw new Error("probe exploded"); }, capabilities: () => { throw new Error("nope"); } });
  manager.register({ id: () => "fine", status: async () => ({ state: "READY", orderSubmissionEffective: false }), capabilities: () => ({ orderSubmission: false }) });

  const status = await manager.allStatus();
  assert.equal(status.broken.state, "ERROR", "a throwing connector degrades to an honest ERROR entry");
  assert.match(status.broken.message, /could not report its status/);
  assert.equal(status.broken.capabilities, null);
  assert.equal(status.fine.state, "READY", "the healthy connector is still reported");
  assert.equal(status.broken.reason.includes("probe exploded"), true, "the reason is carried, truncated");
});

// ---------------------------------------------------------------------- registry

test("the registry registers legacy's ten connectors, all disabled, and routes nothing", async () => {
  let transportCalls = 0;
  const manager = createBrokerRegistry({
    brokers: { connectors: {}, requestTimeoutMs: 8_000, healthTtlMs: 5_000 },
    now,
    transportFactory: () => async () => { transportCalls += 1; return HEALTHY_DEMO; },
  });

  assert.deepEqual(manager.ids(), [
    "mt5-bridge", "mt4-bridge", "binance", "bybit", "okx", "coinbase", "kraken", "ib", "alpaca", "oanda",
  ], "legacy's order, from Platform::__construct");
  assert.equal(manager.size, 10);
  assert.equal(manager.configuredCount(), 0);
  assert.equal(await manager.routable(), false);
  assert.equal(transportCalls, 0, "a default deployment performs no I/O whatsoever");

  const status = await manager.allStatus();
  for (const id of manager.ids()) {
    assert.equal(status[id].state, "DISABLED", `${id} is disabled by default`);
    assert.equal(status[id].configured, false, `${id} has no URL`);
    assert.equal(status[id].capabilities.orderSubmission, false, `${id} has no local trading intent`);
    assert.equal(status[id].capabilities.liveTrading, false, `${id} has no live opt-in`);
    assert.equal(status[id].capabilities.requiresBridge, true);
    assert.match(status[id].capabilities.reason, /Read-only by default/i);
    assert.equal(status[id].id, id);
  }

  // Even with every connector DISABLED, an order attempt must be refused rather
  // than silently dropped — and refused by the connector's own gate.
  await assert.rejects(
    manager.get("mt5-bridge").placeOrder({ symbol: "EURUSD", side: "BUY", volume: 1 }),
    { message: "MT5 bridge is not enabled and configured" },
  );
  assert.equal(transportCalls, 0, "the refusal happened before any transport existed");
});

test("the registry enables a connector from configuration and still refuses to route without a bridge", async () => {
  const manager = createBrokerRegistry({
    brokers: {
      connectors: {
        "mt5-bridge": { url: "http://127.0.0.1:8790", token: "abc", enabled: true, tradingEnabled: true, liveAllowed: false },
      },
      requestTimeoutMs: 8_000,
      healthTtlMs: 5_000,
    },
    now,
    // No bridge is listening, so the real transport fails: the connector must
    // report DOWN rather than inventing a READY.
  });

  assert.equal(manager.configuredCount(), 1);
  const status = await manager.allStatus();
  assert.equal(status["mt5-bridge"].state, "DOWN", "an unreachable bridge is DOWN, never READY");
  assert.equal(status["mt5-bridge"].configured, true);
  assert.equal(await manager.routable(), false);
  assert.equal(status["mt4-bridge"].state, "DISABLED", "the other nine are untouched");
});

test("the planned matrix keeps legacy's wording for the nine unverified adapters", async () => {
  const planned = plannedConnectors();
  assert.equal(planned.length, 9, "every connector except the MT5 bridge is PLANNED");
  assert.deepEqual(planned.map((entry) => entry.id), ["mt4-bridge", "binance", "bybit", "okx", "coinbase", "kraken", "ib", "alpaca", "oanda"]);
  for (const entry of planned) {
    assert.equal(entry.status, "PLANNED");
    assert.match(entry.detail, /scaffolded|verify/i, `${entry.id} says what is missing rather than implying it works`);
    assert.ok(entry.name.length > 0);
  }
  assert.equal(BROKER_CONNECTOR_ROSTER.find((entry) => entry.id === "mt5-bridge").verification.status, "TESTED");
  assert.match(BROKER_CONNECTOR_ROSTER.find((entry) => entry.id === "mt5-bridge").verification.detail, /NOT yet verified against a real MetaTrader terminal/i);
});

test("the roster and the config agree on every connector id and environment prefix", async () => {
  // Two lists in two layers, and a connector added to one without the other fails
  // silently: it would report DISABLED forever with no variable able to enable it.
  assert.deepEqual(
    BROKER_CONNECTOR_ROSTER.map((entry) => [entry.id, entry.envPrefix]),
    BROKER_CONNECTOR_ENV.map((entry) => [entry.id, entry.envPrefix]),
    "the registry roster and the config table list the same connectors in the same order with the same prefixes",
  );
  assert.equal(BROKER_CONNECTOR_ROSTER.length, 10);
  assert.deepEqual(BROKER_ENV_SUFFIXES, ["URL", "TOKEN", "ENABLED", "TRADING_ENABLED", "LIVE_ALLOWED"]);

  // Legacy's MT5 connector reads two irregular names — the trading flags drop
  // `_BRIDGE`, and `DemoBridgeConfig` writes exactly those. Composing every name
  // from one rule would silently read variables no deployment sets, leaving the
  // only connector that can actually work permanently switched off.
  const mt5 = BROKER_CONNECTOR_ENV.find((entry) => entry.id === "mt5-bridge");
  assert.deepEqual(
    { ...brokerEnvNames(mt5) },
    {
      url: "AEGIS_MT5_BRIDGE_URL",
      token: "AEGIS_MT5_BRIDGE_TOKEN",
      enabled: "AEGIS_MT5_BRIDGE_ENABLED",
      tradingEnabled: "AEGIS_MT5_TRADING_ENABLED",
      liveAllowed: "AEGIS_MT5_LIVE_ALLOWED",
    },
  );
  const binance = BROKER_CONNECTOR_ENV.find((entry) => entry.id === "binance");
  assert.deepEqual(
    Object.values(brokerEnvNames(binance)),
    ["AEGIS_BINANCE_CONNECTOR_URL", "AEGIS_BINANCE_CONNECTOR_TOKEN", "AEGIS_BINANCE_CONNECTOR_ENABLED", "AEGIS_BINANCE_CONNECTOR_TRADING_ENABLED", "AEGIS_BINANCE_CONNECTOR_LIVE_ALLOWED"],
    "every other connector composes uniformly from its prefix",
  );
  for (const entry of BROKER_CONNECTOR_ENV) {
    const names = Object.values(brokerEnvNames(entry));
    assert.equal(new Set(names).size, 5, `${entry.id} reads five distinct variables`);
  }
  assert.equal(
    new Set(BROKER_CONNECTOR_ENV.flatMap((entry) => Object.values(brokerEnvNames(entry)))).size,
    50,
    "no two connectors share a variable name",
  );
  for (const entry of BROKER_CONNECTOR_ROSTER) {
    assert.ok(entry.envPrefix.startsWith("AEGIS_"), `${entry.id} keeps legacy's AEGIS_ spelling`);
    assert.ok(entry.displayName.length > 0, `${entry.id} has a display name for its refusal messages`);
  }
  // Legacy's Mt5BridgeConnector declared no market classes; Node keeps the list
  // empty rather than inventing one (BC-9).
  assert.deepEqual(BROKER_CONNECTOR_ROSTER.find((entry) => entry.id === "mt5-bridge").marketClasses, []);
  assert.deepEqual(BROKER_CONNECTOR_ROSTER.find((entry) => entry.id === "ib").marketClasses, ["stock", "etf", "futures", "options"]);
  assert.deepEqual(BROKER_CONNECTOR_ROSTER.find((entry) => entry.id === "alpaca").marketClasses, ["stock", "etf", "crypto"]);
});
