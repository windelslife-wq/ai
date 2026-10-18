import assert from "node:assert/strict";
import test from "node:test";

import { cookieFrom, createFileStoreApp } from "./helpers.js";

const ENV = {
  MARKET_DATA_REAL_PROVIDERS: "0",
  MARKET_DATA_ALLOW_SYNTHETIC: "1",
  WF_SIMULATED_BROKER_ENABLED: "1",
  WF_SIMULATED_BROKER_ORDERS_ENABLED: "1",
  WF_SIMULATED_BROKER_INITIAL_BALANCE: "10000",
};

async function signIn(app) {
  const response = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: {
    identifier: "rootadmin",
    password: "Root administrator pass",
  } });
  assert.equal(response.statusCode, 200, response.body);
  return { headers: { cookie: cookieFrom(response), "x-csrf-token": response.json().csrfToken } };
}

async function call(app, method, url, headers, payload) {
  return app.inject({ method, url, headers, ...(payload === undefined ? {} : { payload }) });
}

async function approveProposal(app, headers, accountId, marketClass = "crypto") {
  const proposal = await call(app, "POST", "/api/v1/execution/proposals", headers, {
    accountId,
    symbol: "BTCUSDT",
    marketClass,
    side: "BUY",
    type: "MARKET",
    stopLoss: 60_000,
    takeProfit: 80_000,
    reason: "Manual approval before simulator route",
  });
  assert.equal(proposal.statusCode, 201, proposal.body);
  const decision = await call(app, "POST", `/api/v1/execution/proposals/${proposal.json().id}/decision`, headers, {
    approve: true,
    reason: "Reviewed and approved for a simulator-only order",
  });
  assert.equal(decision.statusCode, 200, decision.body);
  assert.equal(decision.json().proposal.status, "APPROVED");
  return proposal.json();
}

test("approved proposals run the complete 15-step supervisor path only through the in-process broker simulator", async (t) => {
  const instance = await createFileStoreApp({ configOverrides: { env: ENV } });
  t.after(() => instance.cleanup());
  const { headers } = await signIn(instance.app);

  const account = await call(instance.app, "POST", "/api/v1/paper/accounts", headers, {
    name: "Simulated broker approval account",
    startingBalance: 10_000,
    currency: "USD",
  });
  assert.equal(account.statusCode, 201, account.body);
  const accountId = account.json().account.id;

  for (const [url, payload, method] of [
    ["/api/v1/trading/mode", { mode: "PAPER_TRADING" }, "POST"],
    ["/api/v1/trading/kill-switch", { active: false }, "POST"],
    ["/api/v1/trading/synthetic-paper", { allow: true }, "POST"],
    ["/api/v1/risk/limits", { blockSyntheticData: false }, "PATCH"],
  ]) {
    const response = await call(instance.app, method, url, headers, payload);
    assert.equal(response.statusCode, 200, response.body);
  }

  const proposal = await approveProposal(instance.app, headers, accountId);
  assert.equal((await call(instance.app, "GET", `/api/v1/execution/proposals/${proposal.id}`, headers)).json().proposal.checks.length, 3);

  const submitted = await call(instance.app, "POST", `/api/v1/execution/proposals/${proposal.id}/simulator-submit`, headers, {});
  assert.equal(submitted.statusCode, 201, submitted.body);
  const body = submitted.json();
  assert.equal(body.proposal.status, "SIMULATOR_EXECUTED");
  assert.equal(body.proposal.paperOrderId, null, "this is not a Paper Trading order");
  assert.equal(body.execution.broker, "simulated-mt5");
  assert.equal(body.execution.confirmed, true);
  assert.equal(body.execution.simulationOnly, true);
  assert.equal(body.execution.liveTradingEnabled, false);
  assert.deepEqual(body.execution.checks.map((check) => check.step), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
  assert.ok(body.execution.checks.every((check) => check.ok));
  assert.equal(body.execution.riskDecision.approved, true);
  assert.equal(body.execution.portfolioAfter.accountId, "SIM-0001");
  assert.equal(body.execution.portfolioAfter.openPositions, 1);

  const brokerRead = await call(instance.app, "GET", "/api/v1/brokers/simulation/account", headers);
  assert.equal(brokerRead.statusCode, 200, brokerRead.body);
  assert.equal(brokerRead.json().account.accountId, "SIM-0001");
  assert.equal(brokerRead.json().simulationOnly, true);
  assert.equal((await instance.store.listPaperOrders({ accountId, ownerUserId: 1, limit: 10 })).length, 0,
    "the broker simulation path does not also place a Paper Trading order");

  const center = (await call(instance.app, "GET", "/api/v1/brokers", headers)).json();
  assert.equal(center.routable, false, "the in-process simulator never makes real connectors routable");
  assert.equal(center.simulation.ordersEnabled, true);

  const duplicateSubmit = await call(instance.app, "POST", `/api/v1/execution/proposals/${proposal.id}/simulator-submit`, headers, {});
  assert.equal(duplicateSubmit.statusCode, 409);
  assert.equal(duplicateSubmit.json().error.code, "SIMULATOR_SUBMISSION_NOT_APPROVED");
});

test("simulator routing refuses disabled order configuration before any order is created", async (t) => {
  const instance = await createFileStoreApp({ configOverrides: { env: { ...ENV, WF_SIMULATED_BROKER_ORDERS_ENABLED: "0" } } });
  t.after(() => instance.cleanup());
  const { headers } = await signIn(instance.app);
  const account = await call(instance.app, "POST", "/api/v1/paper/accounts", headers, { name: "Safe defaults", startingBalance: 10_000, currency: "USD" });
  const accountId = account.json().account.id;

  for (const [url, payload] of [
    ["/api/v1/trading/mode", { mode: "PAPER_TRADING" }],
    ["/api/v1/trading/kill-switch", { active: false }],
  ]) assert.equal((await call(instance.app, "POST", url, headers, payload)).statusCode, 200);

  const proposal = await approveProposal(instance.app, headers, accountId);
  const refused = await call(instance.app, "POST", `/api/v1/execution/proposals/${proposal.id}/simulator-submit`, headers, {});
  assert.equal(refused.statusCode, 409);
  assert.equal(refused.json().error.code, "SIMULATOR_ORDERING_DISABLED");
  assert.equal((await instance.store.listPaperOrders({ accountId, ownerUserId: 1, limit: 10 })).length, 0);
});

test("simulator risk and market-session gates fail closed before order placement", async (t) => {
  const instance = await createFileStoreApp({ configOverrides: { env: ENV } });
  t.after(() => instance.cleanup());
  const { headers } = await signIn(instance.app);
  const account = await call(instance.app, "POST", "/api/v1/paper/accounts", headers, { name: "Simulator gates", startingBalance: 10_000, currency: "USD" });
  const accountId = account.json().account.id;
  for (const [url, payload] of [
    ["/api/v1/trading/mode", { mode: "PAPER_TRADING" }],
    ["/api/v1/trading/kill-switch", { active: false }],
  ]) assert.equal((await call(instance.app, "POST", url, headers, payload)).statusCode, 200);

  const syntheticProposal = await approveProposal(instance.app, headers, accountId);
  const syntheticRefusal = await call(instance.app, "POST", `/api/v1/execution/proposals/${syntheticProposal.id}/simulator-submit`, headers, {});
  assert.equal(syntheticRefusal.statusCode, 409);
  assert.equal(syntheticRefusal.json().error.code, "SIMULATOR_RISK_REJECTED",
    "synthetic quotes need explicit account permission and blockSyntheticData=false");

  const closedMarketProposal = await approveProposal(instance.app, headers, accountId, "stock");
  const marketRefusal = await call(instance.app, "POST", `/api/v1/execution/proposals/${closedMarketProposal.id}/simulator-submit`, headers, {});
  assert.equal(marketRefusal.statusCode, 409);
  assert.equal(marketRefusal.json().error.code, "SIMULATOR_MARKET_CLOSED");
  assert.equal((await instance.store.listPaperOrders({ accountId, ownerUserId: 1, limit: 10 })).length, 0);
  const accountState = await call(instance.app, "GET", "/api/v1/brokers/simulation/account", headers);
  assert.equal(accountState.json().account.margin, 0, "failed risk/session checks did not create a simulator position");
});
