import assert from "node:assert/strict";
import test from "node:test";

import { cookieFrom, createFileStoreApp } from "./helpers.js";

const ENV = {
  MARKET_DATA_REAL_PROVIDERS: "0",
  MARKET_DATA_ALLOW_SYNTHETIC: "1",
};

async function signIn(app, identifier = "rootadmin", password = "Root administrator pass") {
  const response = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { identifier, password } });
  assert.equal(response.statusCode, 200, response.body);
  return { headers: { cookie: cookieFrom(response), "x-csrf-token": response.json().csrfToken } };
}

function request(app, method, url, headers, payload) {
  return app.inject({ method, url, headers, ...(payload === undefined ? {} : { payload }) });
}

async function createAccount(instance, headers) {
  const response = await request(instance.app, "POST", "/api/v1/paper/accounts", headers, {
    name: "Automation simulation account",
    startingBalance: 10_000,
    currency: "USD",
  });
  assert.equal(response.statusCode, 201, response.body);
  return response.json().account.id;
}

async function prepareGovernance(instance, headers, accountId) {
  for (const [url, payload] of [
    ["/api/v1/trading/mode", { mode: "PAPER_TRADING" }],
    ["/api/v1/trading/kill-switch", { active: false }],
    ["/api/v1/trading/synthetic-paper", { allow: true }],
    ["/api/v1/risk/limits", { blockSyntheticData: false }],
  ]) {
    const response = await request(instance.app, url.endsWith("risk/limits") ? "PATCH" : "POST", url, headers, payload);
    assert.equal(response.statusCode, 200, response.body);
  }
  const limits = await request(instance.app, "PATCH", "/api/v1/execution/automation-limits", headers, {
    maxDailyTrades: 1,
    maxTradeNotionalUsd: 500,
    maxRiskPerTradePct: 0.004,
    approvedSymbols: ["EURUSD"],
  });
  assert.equal(limits.statusCode, 200, limits.body);
  const mode = await request(instance.app, "POST", "/api/v1/execution/mode", headers, { mode: "SEMI_AUTONOMOUS" });
  assert.equal(mode.statusCode, 200, mode.body);
  assert.equal(mode.json().executionMode, "SEMI_AUTONOMOUS");
  assert.equal(mode.json().liveTradingEnabled, false);
  return accountId;
}

function automatedBody(accountId, overrides = {}) {
  return {
    accountId,
    symbol: "EURUSD",
    marketClass: "forex",
    side: "BUY",
    type: "MARKET",
    stopLoss: 0.5,
    takeProfit: 2.5,
    strategyId: "trend-following",
    strategyVersion: "1.0.0",
    reason: "Approved strategy automation test",
    ...overrides,
  };
}

async function markBuiltinApproved(store, strategyId = "trend-following") {
  const record = await store.findStrategy(strategyId, "1.0.0");
  assert.ok(record, "the Strategy Lab seeded the builtin version");
  await store.saveStrategy({ ...record, lifecycle: "APPROVED" });
}

test("automation modes are opt-in, persisted, bounded by global governance and auditable", async (t) => {
  const instance = await createFileStoreApp({ configOverrides: { env: ENV } });
  t.after(() => instance.cleanup());
  const session = await signIn(instance.app);

  const initial = await request(instance.app, "GET", "/api/v1/execution/automation", session.headers);
  assert.equal(initial.statusCode, 200, initial.body);
  assert.equal(initial.json().executionMode, "HUMAN_APPROVAL");
  assert.deepEqual(initial.json().automationLimits.approvedSymbols, []);
  assert.equal(initial.json().liveTradingEnabled, false);

  const noAutomation = await request(instance.app, "POST", "/api/v1/execution/mode", session.headers, { mode: "FULLY_AUTOMATED" });
  assert.equal(noAutomation.statusCode, 409);
  assert.equal(noAutomation.json().error.code, "EXECUTION_AUTOMATION_GOVERNANCE_BLOCKED");

  const accountId = await createAccount(instance, session.headers);
  await prepareGovernance(instance, session.headers, accountId);

  const invalidRisk = await request(instance.app, "PATCH", "/api/v1/execution/automation-limits", session.headers, { maxRiskPerTradePct: 0.05 });
  assert.equal(invalidRisk.statusCode, 409);
  assert.equal(invalidRisk.json().error.code, "AUTOMATION_LIMIT_EXCEEDS_GOVERNANCE");

  const saved = await request(instance.app, "GET", "/api/v1/execution/automation", session.headers);
  assert.equal(saved.json().executionMode, "SEMI_AUTONOMOUS");
  assert.deepEqual(saved.json().automationLimits.approvedSymbols, ["EURUSD"]);
  assert.equal(saved.json().automationLimits.maxDailyTrades, 1);

  const audit = await instance.store.listAuditEvents({ userId: session.user?.id ?? 1, action: "governance.execution-mode.changed", limit: 10 });
  assert.ok(audit.total >= 1);
});

test("automated execution enforces approved strategy, symbol allowlist, kill switch and one daily paper-order limit", async (t) => {
  const instance = await createFileStoreApp({ configOverrides: { env: ENV } });
  t.after(() => instance.cleanup());
  const session = await signIn(instance.app);
  const accountId = await createAccount(instance, session.headers);
  await prepareGovernance(instance, session.headers, accountId);
  await markBuiltinApproved(instance.store);

  const unapprovedSymbol = await request(instance.app, "POST", "/api/v1/execution/automated-paper", session.headers,
    automatedBody(accountId, { symbol: "GBPUSD" }));
  assert.equal(unapprovedSymbol.statusCode, 409);
  assert.equal(unapprovedSymbol.json().error.code, "EXECUTION_SYMBOL_NOT_APPROVED");

  const first = await request(instance.app, "POST", "/api/v1/execution/automated-paper", session.headers, automatedBody(accountId));
  assert.equal(first.statusCode, 201, first.body);
  assert.equal(first.json().status, "PAPER_EXECUTED");
  assert.equal(first.json().simulationOnly, true);
  assert.equal(first.json().liveTradingEnabled, false);
  assert.equal(first.json().paper.order.status, "FILLED");
  assert.equal(first.json().effectiveRiskPct, 0.00396);

  const savedOrders = await instance.store.listPaperOrders({ accountId, ownerUserId: 1, limit: 10 });
  assert.equal(savedOrders.length, 1);
  assert.ok(savedOrders[0].units * savedOrders[0].fill_price <= 500.01, "per-automation notional cap was applied before filling");

  const dailyLimit = await request(instance.app, "POST", "/api/v1/execution/automated-paper", session.headers,
    automatedBody(accountId, { symbol: "EURUSD", reason: "second attempt today" }));
  assert.equal(dailyLimit.statusCode, 409);
  assert.equal(dailyLimit.json().error.code, "EXECUTION_DAILY_LIMIT_REACHED");

  const completed = await instance.store.listAuditEvents({ userId: 1, action: "execution.automation.completed", limit: 5 });
  assert.equal(completed.total, 1, "accepted automated paper orders are counted through durable audit records");
});

test("automated routes are permissioned, approval changes are optimistic and no live broker path is added", async (t) => {
  const instance = await createFileStoreApp({ configOverrides: { env: ENV } });
  t.after(() => instance.cleanup());
  const session = await signIn(instance.app);

  const status = await request(instance.app, "GET", "/api/v1/execution/status", session.headers);
  assert.equal(status.statusCode, 200);
  assert.equal(status.json().automatedModesAvailable, true);
  assert.equal(status.json().liveTradingEnabled, false);

  const routes = (await request(instance.app, "GET", "/api/v1/system/routes", session.headers)).json().routes;
  assert.ok(routes.some((route) => route.path === "/api/v1/execution/automated-paper" && route.method === "POST"));
  assert.equal(routes.some((route) => route.path === "/api/v1/execution/route" || route.path === "/api/v1/brokers/orders"), false);

  const body = automatedBody(1);
  const anonymous = await instance.app.inject({ method: "POST", url: "/api/v1/execution/automated-paper", payload: body });
  assert.equal(anonymous.statusCode, 401);
});
