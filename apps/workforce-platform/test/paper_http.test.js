import assert from "node:assert/strict";
import test from "node:test";
import bcrypt from "bcryptjs";

import { cookieFrom, createFileStoreApp } from "./helpers.js";

const PAPER_ENV = {
  MARKET_DATA_REAL_PROVIDERS: "0",
  MARKET_DATA_ALLOW_SYNTHETIC: "1",
};

async function signIn(app, identifier = "rootadmin", password = "Root administrator pass") {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { identifier, password },
  });
  assert.equal(response.statusCode, 200, response.body);
  const body = response.json();
  const cookie = cookieFrom(response);
  return { cookie, csrfToken: body.csrfToken, headers: { cookie, "x-csrf-token": body.csrfToken } };
}

async function addReadOnlyTradingMember(store) {
  const user = await store.createUser({
    username: "paperreader",
    email: "paperreader@example.test",
    passwordHash: await bcrypt.hash("Paper reader password", 4),
    displayName: "Paper Reader",
  });
  const role = (await store.listRoles()).find((entry) => entry.role_key === "platform_member");
  const permission = (await store.listPermissions()).find((entry) => entry.permission_key === "trading.view");
  await store.grantRolePermission(role.id, permission.id);
  await store.assignRole(user.id, role.id);
  return user;
}

test("paper routes expose owner-scoped simulation with read, execute and control permissions", async (t) => {
  const instance = await createFileStoreApp({ configOverrides: { env: PAPER_ENV } });
  t.after(() => instance.cleanup());

  const inventoryResponse = await instance.app.inject({ method: "GET", url: "/api/v1/system/routes" });
  assert.equal(inventoryResponse.statusCode, 200);
  const inventory = inventoryResponse.json().routes;
  const byRoute = new Map(inventory.map((route) => [`${route.method} ${route.path}`, route]));
  const expected = [
    ["GET", "/api/v1/paper/accounts", "trading.view"],
    ["POST", "/api/v1/paper/accounts", "trading.execute"],
    ["GET", "/api/v1/paper/accounts/:accountId", "trading.view"],
    ["GET", "/api/v1/paper/accounts/:accountId/orders", "trading.view"],
    ["POST", "/api/v1/paper/accounts/:accountId/orders", "trading.execute"],
    ["GET", "/api/v1/paper/accounts/:accountId/positions", "trading.view"],
    ["POST", "/api/v1/paper/accounts/:accountId/positions/:positionId/close", "trading.execute"],
    ["POST", "/api/v1/paper/accounts/:accountId/tick", "trading.execute"],
    ["GET", "/api/v1/paper/accounts/:accountId/deployments", "trading.view"],
    ["POST", "/api/v1/paper/accounts/:accountId/deployments", "trading.execute"],
    ["POST", "/api/v1/paper/accounts/:accountId/deployments/:deploymentId/toggle", "trading.execute"],
    ["GET", "/api/v1/risk/limits", "trading.view"],
    ["PATCH", "/api/v1/risk/limits", "trading.control"],
    ["GET", "/api/v1/trading/mode", "trading.view"],
    ["POST", "/api/v1/trading/mode", "trading.control"],
    ["POST", "/api/v1/trading/kill-switch", "trading.control"],
    ["POST", "/api/v1/trading/synthetic-paper", "trading.control"],
    ["GET", "/api/v1/portfolio/risk-scan", "trading.view"],
  ];
  for (const [method, path, permission] of expected) {
    const route = byRoute.get(`${method} ${path}`);
    assert.ok(route, `${method} ${path} is registered`);
    assert.equal(route.auth, true, `${method} ${path} requires a session`);
    assert.equal(route.permission, permission, `${method} ${path} requires ${permission}`);
  }
  assert.ok(!inventory.some((route) => /\/api\/v1\/(?:live|execution)(?:\/|$)/.test(route.path)), "Node exposes no live-order or execution route");

  const status = await instance.app.inject({ method: "GET", url: "/api/v1/system/status" });
  assert.equal(status.statusCode, 200);
  assert.equal(status.json().trading.simulationOnly, true);
  assert.equal(status.json().trading.paperTradingAvailable, true);
  assert.equal(status.json().trading.liveTradingEnabled, false);
  assert.equal(status.json().modules.find((module) => module.key === "paperTrading").state, "ported");
  assert.equal(status.json().modules.find((module) => module.key === "risk").state, "ported");
});

test("HTTP paper account, order and close flows require permissions, CSRF and owner identity", async (t) => {
  const instance = await createFileStoreApp({ configOverrides: { env: PAPER_ENV } });
  t.after(() => instance.cleanup());
  const member = await addReadOnlyTradingMember(instance.store);
  const rootSession = await signIn(instance.app);
  const memberSession = await signIn(instance.app, member.username, "Paper reader password");

  const csrfMissing = await instance.app.inject({
    method: "POST",
    url: "/api/v1/trading/mode",
    headers: { cookie: rootSession.cookie },
    payload: { mode: "PAPER_TRADING" },
  });
  assert.equal(csrfMissing.statusCode, 403);
  assert.equal(csrfMissing.json().error.code, "CSRF_INVALID");

  const createDenied = await instance.app.inject({
    method: "POST",
    url: "/api/v1/paper/accounts",
    headers: memberSession.headers,
    payload: { name: "Not allowed", startingBalance: 1_000 },
  });
  assert.equal(createDenied.statusCode, 403);
  assert.equal(createDenied.json().error.code, "PERMISSION_DENIED");

  const created = await instance.app.inject({
    method: "POST",
    url: "/api/v1/paper/accounts",
    headers: rootSession.headers,
    payload: { name: "Private simulated account", startingBalance: 10_000, currency: "USD" },
  });
  assert.equal(created.statusCode, 201, created.body);
  const accountId = created.json().account.id;

  const memberList = await instance.app.inject({ method: "GET", url: "/api/v1/paper/accounts", headers: memberSession.headers });
  assert.equal(memberList.statusCode, 200);
  assert.deepEqual(memberList.json().accounts, [], "another owner's account is never listed");
  const memberDetail = await instance.app.inject({
    method: "GET",
    url: `/api/v1/paper/accounts/${accountId}`,
    headers: memberSession.headers,
  });
  assert.equal(memberDetail.statusCode, 404);
  assert.equal(memberDetail.json().error.code, "PAPER_ACCOUNT_NOT_FOUND");
  const memberOrders = await instance.app.inject({
    method: "GET",
    url: `/api/v1/paper/accounts/${accountId}/orders`,
    headers: memberSession.headers,
  });
  assert.equal(memberOrders.statusCode, 404, "orders are owner-scoped even when the caller has trading.view");

  const readOnlyControl = await instance.app.inject({
    method: "POST",
    url: "/api/v1/trading/mode",
    headers: memberSession.headers,
    payload: { mode: "PAPER_TRADING" },
  });
  assert.equal(readOnlyControl.statusCode, 403);
  assert.equal(readOnlyControl.json().error.code, "PERMISSION_DENIED");

  const mode = await instance.app.inject({
    method: "POST",
    url: "/api/v1/trading/mode",
    headers: rootSession.headers,
    payload: { mode: "PAPER_TRADING" },
  });
  assert.equal(mode.statusCode, 200, mode.body);
  const synthetic = await instance.app.inject({
    method: "POST",
    url: "/api/v1/trading/synthetic-paper",
    headers: rootSession.headers,
    payload: { allow: true },
  });
  assert.equal(synthetic.statusCode, 200, synthetic.body);
  const released = await instance.app.inject({
    method: "POST",
    url: "/api/v1/trading/kill-switch",
    headers: rootSession.headers,
    payload: { active: false },
  });
  assert.equal(released.statusCode, 200, released.body);

  const filled = await instance.app.inject({
    method: "POST",
    url: `/api/v1/paper/accounts/${accountId}/orders`,
    headers: rootSession.headers,
    payload: {
      symbol: "EURUSD",
      marketClass: "forex",
      side: "BUY",
      type: "MARKET",
      stopLoss: 0.5,
      takeProfit: 2.5,
      reason: "HTTP simulation fixture",
    },
  });
  assert.equal(filled.statusCode, 201, filled.body);
  assert.equal(filled.json().filled, true);
  assert.equal(filled.json().order.status, "FILLED");
  assert.equal(filled.json().order.synthetic, true, "the response carries synthetic-data provenance");

  const positions = await instance.app.inject({
    method: "GET",
    url: `/api/v1/paper/accounts/${accountId}/positions`,
    headers: rootSession.headers,
  });
  assert.equal(positions.statusCode, 200, positions.body);
  assert.equal(positions.json().positions.length, 1);
  const positionId = positions.json().positions[0].id;

  const closed = await instance.app.inject({
    method: "POST",
    url: `/api/v1/paper/accounts/${accountId}/positions/${positionId}/close`,
    headers: rootSession.headers,
  });
  assert.equal(closed.statusCode, 200, closed.body);
  assert.equal(closed.json().position.status, "CLOSED");
  assert.equal(closed.json().position.synthetic, true);

  const journal = await instance.store.listJournalEntries({ source: "paper" });
  assert.equal(journal.length, 1);
  assert.equal(journal[0].synthetic, true, "a synthetic close cannot become live-approval evidence");
  const finalStatus = await instance.app.inject({ method: "GET", url: "/api/v1/trading/mode", headers: rootSession.headers });
  assert.equal(finalStatus.statusCode, 200);
  assert.equal(finalStatus.json().simulationOnly, true);
  assert.equal(finalStatus.json().liveTradingEnabled, false);
});
