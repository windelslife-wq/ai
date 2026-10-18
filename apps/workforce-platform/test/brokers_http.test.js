/**
 * Broker Center HTTP surface (row 13).
 *
 * The two things this file exists to prove:
 *
 *  1. **The one route is a read, and it is gated.** Legacy's `Api_system::brokers()`
 *     made no `requirePermission` call, so any signed-in user could read connector
 *     health; `mt5_account()` went further and returned the broker login, currency,
 *     balance and equity to the same audience (**F-32**). Node requires
 *     `trading.view`, and the route inventory is asserted rather than assumed.
 *  2. **A default host reports honestly and does nothing.** Ten connectors, all
 *     `DISABLED`, `routable: false`, no outbound call, and no secret in the body.
 */

import assert from "node:assert/strict";
import bcrypt from "bcryptjs";
import { test } from "node:test";

import { cookieFrom, createFileStoreApp } from "./helpers.js";

const SECRET = "root-session-secret-value-that-is-long-enough";

async function signIn(app, identifier = "rootadmin", password = "Root administrator pass") {
  const response = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { identifier, password } });
  assert.equal(response.statusCode, 200, response.body);
  const body = response.json();
  const cookie = cookieFrom(response);
  return { cookie, headers: { cookie, "x-csrf-token": body.csrfToken } };
}

/** A signed-in operator who does NOT hold `trading.view`. */
async function addViewerWithoutTradingPermission(store) {
  const user = await store.createUser({
    username: "brokerviewer",
    email: "brokerviewer@example.test",
    passwordHash: await bcrypt.hash("Broker viewer phrase", 4),
    displayName: "Broker Viewer",
  });
  const role = (await store.listRoles()).find((entry) => entry.role_key === "platform_member");
  const authenticated = await store.ensurePermission("system.authenticated", "Signed in");
  await store.grantRolePermission(role.id, authenticated.id);
  await store.assignRole(user.id, role.id);
  return user;
}

test("the broker route requires a session and then requires trading.view (F-32)", async (t) => {
  const instance = await createFileStoreApp({});
  t.after(() => instance.cleanup());

  const anonymous = await instance.app.inject({ method: "GET", url: "/api/v1/brokers" });
  assert.equal(anonymous.statusCode, 401, "an anonymous caller gets nothing");

  const viewer = await addViewerWithoutTradingPermission(instance.store);
  const limited = await signIn(instance.app, viewer.username, "Broker viewer phrase");
  for (const url of ["/api/v1/brokers", "/api/v1/brokers/mt5/account", "/api/v1/brokers/mt5/quote?symbol=EURUSD", "/api/v1/brokers/simulation/account", "/api/v1/brokers/simulation/quote?symbol=EURUSD"]) {
    const forbidden = await instance.app.inject({ method: "GET", url, headers: limited.headers });
    assert.equal(forbidden.statusCode, 403, `${url} refuses a signed-in user without trading.view`);
    assert.equal(forbidden.json().error.code, "PERMISSION_DENIED");
  }

  const root = await signIn(instance.app);
  const allowed = await instance.app.inject({ method: "GET", url: "/api/v1/brokers", headers: root.headers });
  assert.equal(allowed.statusCode, 200, allowed.body);
});

test("a default host reports ten disabled connectors, routes nothing, and leaks nothing", async (t) => {
  const instance = await createFileStoreApp({});
  t.after(() => instance.cleanup());
  const { headers } = await signIn(instance.app);

  const response = await instance.app.inject({ method: "GET", url: "/api/v1/brokers", headers });
  assert.equal(response.statusCode, 200);
  const body = response.json();

  assert.deepEqual(Object.keys(body.brokers), [
    "mt5-bridge", "mt4-bridge", "binance", "bybit", "okx", "coinbase", "kraken", "ib", "alpaca", "oanda",
  ], "legacy's ten connectors, in legacy's registration order");
  for (const [id, status] of Object.entries(body.brokers)) {
    assert.equal(status.state, "DISABLED", `${id} is disabled by default`);
    assert.equal(status.configured, false, `${id} has no URL configured`);
    assert.match(status.message, /disabled by default/i, `${id} says how to enable it`);
    assert.match(status.message, /AEGIS_[A-Z0-9_]+_ENABLED=1/, `${id} names the exact variable`);
    assert.equal(status.capabilities.orderSubmission, false);
    assert.equal(status.capabilities.liveTrading, false);
  }

  assert.equal(body.routable, false, "no connector may route, so nothing can be routed");
  assert.match(body.notice, /No real connector is READY with effective order submission/i);
  assert.deepEqual(body.simulation, {
    enabled: false,
    ordersEnabled: false,
    memoryOnly: true,
    accountType: "demo",
    liveTradingEnabled: false,
    state: "DISABLED",
    message: "In-process simulator is disabled by default.",
  });
  assert.equal(body.planned.length, 9, "the nine unverified adapters are named as PLANNED");
  assert.ok(body.planned.every((entry) => entry.status === "PLANNED"));

  // The honesty requirement: a body that carries connector configuration must not
  // carry a credential, a URL or a token fragment.
  const serialized = JSON.stringify(body);
  assert.equal(/token/i.test(serialized) && /"token"\s*:\s*"[^"]+"/.test(serialized), false, "no token value appears");
  assert.equal(serialized.includes("127.0.0.1"), false, "no bridge URL appears");
  assert.equal(serialized.includes("Bearer"), false, "no authorization header appears");
});

test("the optional simulator is explicit, read-only over HTTP, and never makes real routing available", async (t) => {
  const instance = await createFileStoreApp({
    configOverrides: {
      env: {
        WF_SIMULATED_BROKER_ENABLED: "1",
        WF_SIMULATED_BROKER_ORDERS_ENABLED: "1",
        WF_SIMULATED_BROKER_INITIAL_BALANCE: "25000",
      },
    },
  });
  t.after(() => instance.cleanup());
  const { headers } = await signIn(instance.app);

  const center = await instance.app.inject({ method: "GET", url: "/api/v1/brokers", headers });
  assert.equal(center.statusCode, 200, center.body);
  assert.equal(center.json().routable, false, "the simulated connector never counts as real broker routing");
  assert.equal(center.json().simulation.enabled, true);
  assert.equal(center.json().simulation.ordersEnabled, true);
  assert.equal(center.json().simulation.memoryOnly, true);
  assert.equal(center.json().simulation.liveTradingEnabled, false);

  const account = await instance.app.inject({ method: "GET", url: "/api/v1/brokers/simulation/account", headers });
  assert.equal(account.statusCode, 200, account.body);
  assert.equal(account.json().account.balance, 25_000);
  assert.equal(account.json().account.accountId, "SIM-0001");
  assert.equal(account.json().simulationOnly, true);
  assert.equal(account.json().memoryOnly, true);

  const quote = await instance.app.inject({ method: "GET", url: "/api/v1/brokers/simulation/quote?symbol=EURUSD", headers });
  assert.equal(quote.statusCode, 200, quote.body);
  assert.equal(quote.json().quote.symbol, "EURUSD");
  assert.equal(quote.json().simulationOnly, true);
  assert.equal(quote.json().memoryOnly, true);

  const missingSymbol = await instance.app.inject({ method: "GET", url: "/api/v1/brokers/simulation/quote", headers });
  assert.equal(missingSymbol.statusCode, 400);
  assert.equal(missingSymbol.json().error.code, "INVALID_REQUEST");

  const realAccount = await instance.app.inject({ method: "GET", url: "/api/v1/brokers/mt5/account", headers });
  assert.equal(realAccount.statusCode, 503, "an enabled simulator is never a substitute for a configured MT5 bridge");
  assert.equal(realAccount.json().error.code, "BROKER_NOT_CONFIGURED");
});

test("Broker Center has no direct write/toggle route; the only simulator write is proposal-gated in Execution", async (t) => {
  const instance = await createFileStoreApp({});
  t.after(() => instance.cleanup());
  const { headers } = await signIn(instance.app);

  const inventory = (await instance.app.inject({ method: "GET", url: "/api/v1/system/routes", headers })).json().routes;
  const brokerRoutes = inventory.filter((route) => route.path.includes("/brokers"));
  assert.deepEqual(
    brokerRoutes.map((route) => `${route.method} ${route.path}`),
    [
      "GET /api/v1/brokers",
      "GET /api/v1/brokers/mt5/account",
      "GET /api/v1/brokers/mt5/quote",
      "GET /api/v1/brokers/simulation/account",
      "GET /api/v1/brokers/simulation/quote",
    ],
    "the Broker Center exposes only authenticated status/account/quote reads",
  );

  // Legacy's console had `Brokers::sim_toggle()`, which wrote a marker file its dev
  // front controller turned into environment variables. There is no equivalent here,
  // so there must be no route that claims to switch a bridge on.
  for (const path of ["/api/v1/brokers/simulate", "/api/v1/brokers/sim-toggle", "/api/v1/brokers/enable"]) {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const response = await instance.app.inject({ method, url: path, headers, payload: { enable: "1" } });
      assert.equal(response.statusCode, 404, `${method} ${path} does not exist`);
    }
  }

  const writeRoutes = inventory.filter((route) => route.path.includes("/brokers") && route.method !== "GET");
  assert.deepEqual(writeRoutes, [], "Broker Center exposes no direct broker order or toggle write");
  const simulatorSubmit = inventory.find((route) => route.path === "/api/v1/execution/proposals/:proposalId/simulator-submit");
  assert.ok(simulatorSubmit, "simulator orders are submitted only from an owner-scoped proposal");
  assert.equal(simulatorSubmit.method, "POST");
  assert.equal(simulatorSubmit.permission, "trading.execute");
  assert.equal(simulatorSubmit.auth, true);
  assert.equal(inventory.some((route) => route.path === "/api/v1/execution/route" || route.path === "/api/v1/brokers/orders"), false,
    "there is no generic real-broker order route");
});

test("the public status surface reports broker readiness without probing anything", async (t) => {
  const instance = await createFileStoreApp({});
  t.after(() => instance.cleanup());

  // Unauthenticated on purpose: this is the surface an anonymous caller can read,
  // and the invariant is that reading it cannot make the server reach an outbound
  // host or do measurable work (BC-11).
  const status = await instance.app.inject({ method: "GET", url: "/api/v1/system/status" });
  assert.equal(status.statusCode, 200);
  const body = status.json();

  assert.equal(body.trading.liveTradingEnabled, false);
  assert.equal(body.trading.brokerConnectorAvailable, false);
  assert.equal(body.trading.brokerConnectorsConfigured, 0, "nothing is configured on a default host");
  assert.match(body.trading.reason, /process-local MT5-shaped simulator may submit only an approved proposal after all fifteen checks/i);
  assert.match(body.trading.reason, /real adapters remain unverified and live trading is disabled/i);
  assert.equal(body.trading.simulatedBrokerAvailable, false);
  assert.equal(body.trading.simulatedOrderRoutingEnabled, false);
  assert.match(body.trading.reason, /GET \/api\/v1\/brokers/, "the reason points at the surface that does probe");

  const features = await instance.app.inject({ method: "GET", url: "/api/v1/system/features" });
  assert.equal(features.json().features.brokers, "partial");

  const executionStatus = await instance.app.inject({
    method: "GET",
    url: "/api/v1/execution/status",
    headers: (await signIn(instance.app)).headers,
  });
  const execution = executionStatus.json();
  assert.equal(execution.brokerConnectorAvailable, false);
  assert.equal(execution.brokerConnectorsConfigured, 0);
  assert.equal(execution.liveTradingEnabled, false);
  assert.equal(execution.automatedModesAvailable, true, "the automated modes are available only through governed Paper Trading");
  assert.deepEqual(execution.availableModes, ["HUMAN_APPROVAL", "SEMI_AUTONOMOUS", "FULLY_AUTOMATED"]);
  assert.match(execution.automationScope, /Paper Trading only/);
});

test("a configured bridge that cannot be reached reports DOWN and still routes nothing", async (t) => {
  // Port 9 (discard) on loopback: nothing listens, so the real transport fails
  // immediately. This is the case that matters most for honesty — a host that set
  // every variable correctly but has no bridge must be told DOWN, not READY.
  const instance = await createFileStoreApp({
    configOverrides: {
      env: {
        AEGIS_MT5_BRIDGE_URL: "http://127.0.0.1:9",
        AEGIS_MT5_BRIDGE_TOKEN: "a-bridge-token-that-is-long-enough",
        AEGIS_MT5_BRIDGE_ENABLED: "1",
        AEGIS_MT5_TRADING_ENABLED: "1",
        BROKER_REQUEST_TIMEOUT_MS: "1500",
      },
    },
  });
  t.after(() => instance.cleanup());
  const { headers } = await signIn(instance.app);

  const body = (await instance.app.inject({ method: "GET", url: "/api/v1/brokers", headers })).json();
  assert.equal(body.brokers["mt5-bridge"].state, "DOWN", "an unreachable bridge is DOWN");
  assert.match(body.brokers["mt5-bridge"].message, /health check failed/i);
  assert.equal(body.brokers["mt5-bridge"].configured, true, "the URL is valid, so it is configured");
  assert.equal(body.brokers["mt5-bridge"].capabilities.orderSubmission, true, "the local *intent* flag is on");
  assert.equal(body.routable, false, "intent is not permission: nothing may route");
  assert.equal(body.brokers["mt4-bridge"].state, "DISABLED", "the other nine are unaffected");

  const status = (await instance.app.inject({ method: "GET", url: "/api/v1/system/status" })).json();
  assert.equal(status.trading.brokerConnectorsConfigured, 1, "the public surface counts configuration without probing");
  assert.equal(status.trading.brokerConnectorAvailable, false);

  // The credentials that made this connector configurable must not be echoed back.
  const serialized = JSON.stringify(body);
  assert.equal(serialized.includes("a-bridge-token-that-is-long-enough"), false, "the token never appears");
  assert.equal(serialized.includes("127.0.0.1:9"), false, "the bridge URL never appears");
});

test("the environment gate refuses an unsafe bridge URL and accepts a loopback one", async (t) => {
  const { loadConfig } = await import("../src/config.js");
  const base = { SESSION_SECRET: SECRET, NODE_ENV: "production", PUBLIC_BASE_URL: "https://workforce.example" };

  // A local bridge on http:// is legitimate in production: the MT5 bridge is a
  // service on the same host, and demanding TLS there pushes operators toward
  // self-signed certificates, which is a worse outcome than the plain socket.
  const loopback = loadConfig({ ...base, AEGIS_MT5_BRIDGE_URL: "http://127.0.0.1:8790" });
  assert.equal(loopback.brokers.connectors["mt5-bridge"].url, "http://127.0.0.1:8790");

  const ipv6 = loadConfig({ ...base, AEGIS_MT5_BRIDGE_URL: "http://[::1]:8790" });
  assert.equal(ipv6.brokers.connectors["mt5-bridge"].url, "http://[::1]:8790");

  // A *remote* bridge on plain http is refused in production.
  assert.throws(
    () => loadConfig({ ...base, AEGIS_MT5_BRIDGE_URL: "http://bridge.example.com" }),
    { message: /must use https:\/\/ in production/ },
  );
  // Credentials in the URL are refused in every mode, and only the origin is kept,
  // so a path or query string can never be carried into a request or a log.
  assert.throws(
    () => loadConfig({ ...base, AEGIS_ALPACA_CONNECTOR_URL: "https://user:pass@alpaca.example" }),
    { message: /must not contain credentials/ },
  );
  const withPath = loadConfig({ ...base, AEGIS_IB_CONNECTOR_URL: "https://ib.example/gateway?token=abc" });
  assert.equal(withPath.brokers.connectors.ib.url, "https://ib.example", "only the origin survives");

  // Every flag defaults to off, and a non-boolean value is refused rather than
  // being coerced into something an operator did not write.
  const defaults = loadConfig({ SESSION_SECRET: SECRET, NODE_ENV: "test" });
  for (const id of Object.keys(defaults.brokers.connectors)) {
    assert.deepEqual(
      { ...defaults.brokers.connectors[id] },
      { url: null, token: "", enabled: false, tradingEnabled: false, liveAllowed: false },
      `${id} is entirely off by default`,
    );
  }
  assert.throws(
    () => loadConfig({ SESSION_SECRET: SECRET, NODE_ENV: "test", AEGIS_MT5_BRIDGE_ENABLED: "maybe" }),
    { message: /AEGIS_MT5_BRIDGE_ENABLED must be true or false/ },
  );
  assert.deepEqual(defaults.brokers.simulation, { enabled: false, ordersEnabled: false, initialBalance: 10_000 });
  assert.throws(
    () => loadConfig({ SESSION_SECRET: SECRET, NODE_ENV: "test", WF_SIMULATED_BROKER_ORDERS_ENABLED: "1" }),
    { message: /WF_SIMULATED_BROKER_ORDERS_ENABLED requires WF_SIMULATED_BROKER_ENABLED=1/ },
  );
  const simulationOn = loadConfig({
    SESSION_SECRET: SECRET,
    NODE_ENV: "test",
    WF_SIMULATED_BROKER_ENABLED: "1",
    WF_SIMULATED_BROKER_ORDERS_ENABLED: "1",
    WF_SIMULATED_BROKER_INITIAL_BALANCE: "25000",
  });
  assert.deepEqual(simulationOn.brokers.simulation, { enabled: true, ordersEnabled: true, initialBalance: 25_000 });
  assert.throws(
    () => loadConfig({ SESSION_SECRET: SECRET, NODE_ENV: "test", BROKER_REQUEST_TIMEOUT_MS: "10" }),
    { message: /BROKER_REQUEST_TIMEOUT_MS must be an integer between 1000 and 60000/ },
  );
  assert.equal(loadConfig({ SESSION_SECRET: SECRET, NODE_ENV: "test", AEGIS_OKX_CONNECTOR_LIVE_ALLOWED: "1" }).brokers.connectors.okx.liveAllowed, true);
});
