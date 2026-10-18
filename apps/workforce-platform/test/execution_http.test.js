import assert from "node:assert/strict";
import test from "node:test";
import bcrypt from "bcryptjs";

import { cookieFrom, createFileStoreApp } from "./helpers.js";

const EXECUTION_ENV = {
  PUBLIC_BASE_URL: "https://site.example.test",
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
  return { cookie, headers: { cookie, "x-csrf-token": body.csrfToken } };
}

async function addPaperOperator(store) {
  const user = await store.createUser({
    username: "paperoperator",
    email: "paperoperator@example.test",
    passwordHash: await bcrypt.hash("Paper operator phrase", 4),
    displayName: "Paper Operator",
  });
  const role = (await store.listRoles()).find((entry) => entry.role_key === "platform_member");
  const view = await store.ensurePermission("trading.view", "View paper trading");
  const execute = await store.ensurePermission("trading.execute", "Create and submit paper proposals");
  await store.grantRolePermission(role.id, view.id);
  await store.grantRolePermission(role.id, execute.id);
  await store.assignRole(user.id, role.id);
  return user;
}

test("execution exposes human-reviewed Paper/simulator routes and reports real/live routing unavailable", async (t) => {
  const instance = await createFileStoreApp({ configOverrides: { env: EXECUTION_ENV } });
  t.after(() => instance.cleanup());

  const inventoryResponse = await instance.app.inject({ method: "GET", url: "/api/v1/system/routes" });
  assert.equal(inventoryResponse.statusCode, 200);
  const routes = inventoryResponse.json().routes;
  const routeMap = new Map(routes.map((route) => [`${route.method} ${route.path}`, route]));
  for (const [method, path, permission] of [
    ["GET", "/api/v1/execution/status", "trading.view"],
    ["GET", "/api/v1/execution/automation", "trading.view"],
    ["POST", "/api/v1/execution/proposals", "trading.execute"],
    ["GET", "/api/v1/execution/proposals", "trading.view"],
    ["GET", "/api/v1/execution/proposals/:proposalId", "trading.view"],
    ["POST", "/api/v1/execution/proposals/:proposalId/decision", "trading.control"],
    ["POST", "/api/v1/execution/proposals/:proposalId/paper-submit", "trading.execute"],
    ["POST", "/api/v1/execution/proposals/:proposalId/simulator-submit", "trading.execute"],
    ["PATCH", "/api/v1/execution/automation-limits", "trading.control"],
    ["POST", "/api/v1/execution/mode", "trading.control"],
    ["POST", "/api/v1/execution/automated-paper", "trading.execute"],
  ]) {
    const route = routeMap.get(`${method} ${path}`);
    assert.ok(route, `${method} ${path} is registered`);
    assert.equal(route.auth, true);
    assert.equal(route.permission, permission);
  }
  assert.equal(routeMap.has("POST /api/v1/execution"), false, "there is no generic supervisor or broker route");
  assert.equal(routes.some((route) => /\/api\/v1\/(?:live|broker)(?:\/|$)/.test(route.path)), false);

  const status = await instance.app.inject({ method: "GET", url: "/api/v1/execution/status", headers: (await signIn(instance.app)).headers });
  assert.equal(status.statusCode, 200, status.body);
  assert.equal(status.json().simulationOnly, true);
  assert.equal(status.json().approvalRequired, true);
  assert.equal(status.json().liveTradingEnabled, false);
  assert.equal(status.json().brokerConnectorAvailable, false, "real broker connector is not routable");
  assert.equal(status.json().simulatedBrokerAvailable, false, "simulator is opt-in");
  assert.equal(status.json().simulatedOrderRoutingEnabled, false);
  assert.equal(status.json().automatedModesAvailable, true, "automated modes are explicit request-based Paper Trading only");
  assert.match(status.json().automationScope, /request-based Paper Trading only/);
  assert.match(status.json().simulatorSubmissionScope, /process-local simulated MT5 bridge/);

  const overall = await instance.app.inject({ method: "GET", url: "/api/v1/system/status" });
  assert.equal(overall.json().modules.find((module) => module.key === "execution").state, "partial");
  assert.equal(overall.json().trading.paperProposalWorkflowAvailable, true);
  assert.equal(overall.json().trading.liveTradingEnabled, false);
});

test("HTTP proposals are owner-scoped, require a permissioned human decision and submit only through paper checks", async (t) => {
  const instance = await createFileStoreApp({ configOverrides: { env: EXECUTION_ENV } });
  t.after(() => instance.cleanup());
  const root = await signIn(instance.app);
  const operator = await addPaperOperator(instance.store);
  const operatorSession = await signIn(instance.app, operator.username, "Paper operator phrase");

  const createdAccount = await instance.app.inject({
    method: "POST",
    url: "/api/v1/paper/accounts",
    headers: root.headers,
    payload: { name: "Execution integration paper account", startingBalance: 10_000, currency: "USD" },
  });
  assert.equal(createdAccount.statusCode, 201, createdAccount.body);
  const accountId = createdAccount.json().account.id;

  for (const [url, payload] of [
    ["/api/v1/trading/mode", { mode: "PAPER_TRADING" }],
    ["/api/v1/trading/synthetic-paper", { allow: true }],
    ["/api/v1/trading/kill-switch", { active: false }],
  ]) {
    const response = await instance.app.inject({ method: "POST", url, headers: root.headers, payload });
    assert.equal(response.statusCode, 200, response.body);
  }

  const input = {
    accountId,
    symbol: "eurusd",
    marketClass: "FOREX",
    side: "buy",
    type: "market",
    stopLoss: 0.5,
    takeProfit: 2.5,
    reason: "HTTP paper proposal fixture",
  };
  const foreignCreate = await instance.app.inject({
    method: "POST",
    url: "/api/v1/execution/proposals",
    headers: operatorSession.headers,
    payload: input,
  });
  assert.equal(foreignCreate.statusCode, 404, foreignCreate.body);
  assert.equal(foreignCreate.json().error.code, "PAPER_ACCOUNT_NOT_FOUND");

  const created = await instance.app.inject({
    method: "POST",
    url: "/api/v1/execution/proposals",
    headers: root.headers,
    payload: input,
  });
  assert.equal(created.statusCode, 201, created.body);
  const proposal = created.json();
  assert.equal(proposal.status, "PENDING_APPROVAL");
  assert.equal(proposal.intent.symbol, "EURUSD");
  assert.equal(proposal.intent.side, "BUY");
  assert.equal(proposal.liveTradingEnabled, false);

  const hidden = await instance.app.inject({
    method: "GET",
    url: `/api/v1/execution/proposals/${proposal.id}`,
    headers: operatorSession.headers,
  });
  assert.equal(hidden.statusCode, 404, "proposal detail checks both owner and paper-account ownership");
  const list = await instance.app.inject({ method: "GET", url: "/api/v1/execution/proposals", headers: operatorSession.headers });
  assert.equal(list.statusCode, 200);
  assert.deepEqual(list.json().proposals, []);

  const pendingSubmit = await instance.app.inject({
    method: "POST",
    url: `/api/v1/execution/proposals/${proposal.id}/paper-submit`,
    headers: root.headers,
    payload: {},
  });
  assert.equal(pendingSubmit.statusCode, 409);
  assert.equal(pendingSubmit.json().error.code, "PAPER_SUBMISSION_NOT_APPROVED");

  const permissionDenied = await instance.app.inject({
    method: "POST",
    url: `/api/v1/execution/proposals/${proposal.id}/decision`,
    headers: operatorSession.headers,
    payload: { approve: true, reason: "A human operator reviewed this" },
  });
  assert.equal(permissionDenied.statusCode, 403, permissionDenied.body);
  assert.equal(permissionDenied.json().error.code, "PERMISSION_DENIED");

  const csrfDenied = await instance.app.inject({
    method: "POST",
    url: `/api/v1/execution/proposals/${proposal.id}/decision`,
    headers: { cookie: root.cookie },
    payload: { approve: true, reason: "A human operator reviewed this" },
  });
  assert.equal(csrfDenied.statusCode, 403);
  assert.equal(csrfDenied.json().error.code, "CSRF_INVALID");

  const approved = await instance.app.inject({
    method: "POST",
    url: `/api/v1/execution/proposals/${proposal.id}/decision`,
    headers: root.headers,
    payload: { approve: true, reason: "I reviewed the risk and explicitly approve paper simulation" },
  });
  assert.equal(approved.statusCode, 200, approved.body);
  assert.equal(approved.json().proposal.status, "APPROVED");

  const paperSubmit = await instance.app.inject({
    method: "POST",
    url: `/api/v1/execution/proposals/${proposal.id}/paper-submit`,
    headers: root.headers,
    payload: {},
  });
  assert.ok([201, 202].includes(paperSubmit.statusCode), paperSubmit.body);
  assert.equal(paperSubmit.json().proposal.status, "PAPER_EXECUTED");
  assert.equal(paperSubmit.json().paper.filled, true);
  assert.equal(paperSubmit.json().paper.order.status, "FILLED");
  assert.equal(paperSubmit.json().paper.order.synthetic, true, "paper data provenance remains synthetic through the proposal result");
  assert.equal(paperSubmit.json().paper.simulationOnly, true);
  assert.equal(paperSubmit.json().paper.liveTradingEnabled, false);

  const closed = await instance.app.inject({
    method: "POST",
    url: `/api/v1/paper/accounts/${accountId}/positions/${paperSubmit.json().paper.position.id}/close`,
    headers: root.headers,
  });
  assert.equal(closed.statusCode, 200, closed.body);
  assert.equal(closed.json().position.synthetic, true);
  const syntheticJournal = await instance.store.listJournalEntries({ source: "paper" });
  assert.equal(syntheticJournal.length, 1);
  assert.equal(syntheticJournal[0].synthetic, true, "closing a synthetic paper position cannot launder it into non-synthetic evidence");

  const audits = (await instance.store.snapshot()).audit.filter((entry) => entry.entity_id === proposal.id);
  // The second entry is the 409 asserted above, when `paper-submit` was called before
  // any decision. Legacy audited every routing refusal through `routingBlocked()`; a
  // bare 409 left no trace that an operator had tried to submit an undecided proposal,
  // which is exactly the sort of attempt a governance review asks about.
  assert.deepEqual(audits.map((entry) => entry.action_key), [
    "execution.proposal.created",
    "execution.paper-submission.blocked",
    "execution.proposal.approved",
    "execution.paper-submission.started",
    "execution.paper-submission.completed",
  ]);

  const blocked = audits.find((entry) => entry.action_key === "execution.paper-submission.blocked");
  assert.equal(blocked.detail_json.code, "PAPER_SUBMISSION_NOT_APPROVED");
  assert.equal(blocked.detail_json.orderCreated, false);
  // `ROUTING_BLOCKED` means the platform cannot route. Broadcasting it because a caller
  // submitted an undecided proposal would say the platform is down when it is not.
  const inbox = await instance.store.listNotifications(Number(root.userId ?? 1), { limit: 100 });
  assert.ok(inbox.length > 0, `the inbox must be readable for this assertion to mean anything, got ${JSON.stringify(inbox.length)}`);
  assert.equal(inbox.filter((row) => row.type === "ROUTING_BLOCKED").length, 0);
});
