/**
 * Paper trading and persisted governance HTTP routes (Phase 7).
 *
 * Paper account rows are owner-scoped at the service/repository boundary, not
 * merely hidden by the route. Read operations require `trading.view`; account
 * mutations require `trading.execute`; global mode, risk, kill-switch and
 * synthetic-data changes require `trading.control`.
 */

import { createAuthenticator, requirePermission } from "../platform/guards.js";
import { createPaperService } from "./service.js";
import {
  ACCOUNT_CREATE_BODY,
  ACCOUNT_PARAMS,
  DEPLOYMENT_BODY,
  DEPLOYMENT_PARAMS,
  DEPLOYMENT_TOGGLE_BODY,
  KILL_SWITCH_BODY,
  ORDER_BODY,
  ORDERS_QUERY,
  PORTFOLIO_QUERY,
  POSITIONS_QUERY,
  RISK_LIMITS_BODY,
  SYNTHETIC_PAPER_BODY,
  TRADING_MODE_BODY,
  POSITION_PARAMS,
} from "./contracts.js";

export function paperRoutes(app, { store, config, service = null, marketData = null, strategies = null, log = app.log }) {
  const paper = service || createPaperService({ store, marketData, strategies, log });
  const authenticate = createAuthenticator({ store, config });
  const actorOf = (request) => request.auth?.user?.id ?? null;
  const guardFor = (permission) => {
    const guard = requirePermission(permission, config);
    guard.permission = permission;
    return [authenticate, guard];
  };
  const view = guardFor("trading.view");
  const execute = guardFor("trading.execute");
  const control = guardFor("trading.control");

  app.get("/paper/accounts", {
    preHandler: view,
  }, async (request) => paper.listAccounts(actorOf(request)));

  app.post("/paper/accounts", {
    preHandler: execute,
    bodySchema: ACCOUNT_CREATE_BODY,
  }, async (request, reply) => reply.code(201).send(await paper.createAccount(
    actorOf(request),
    request.body,
    { actorId: actorOf(request) },
  )));

  app.get("/paper/accounts/:accountId", {
    preHandler: view,
    paramsSchema: ACCOUNT_PARAMS,
  }, async (request) => paper.accountSummary(actorOf(request), request.params.accountId));

  app.get("/paper/accounts/:accountId/orders", {
    preHandler: view,
    paramsSchema: ACCOUNT_PARAMS,
    querySchema: ORDERS_QUERY,
  }, async (request) => paper.listOrders(actorOf(request), request.params.accountId, request.query));

  app.post("/paper/accounts/:accountId/orders", {
    preHandler: execute,
    paramsSchema: ACCOUNT_PARAMS,
    bodySchema: ORDER_BODY,
  }, async (request, reply) => {
    const result = await paper.submitOrder(actorOf(request), request.params.accountId, request.body, { actorId: actorOf(request) });
    const status = result.order?.status === "REJECTED" ? 409 : result.filled ? 201 : 202;
    return reply.code(status).send(result);
  });

  app.get("/paper/accounts/:accountId/positions", {
    preHandler: view,
    paramsSchema: ACCOUNT_PARAMS,
    querySchema: POSITIONS_QUERY,
  }, async (request) => paper.positions(actorOf(request), request.params.accountId, request.query));

  app.post("/paper/accounts/:accountId/positions/:positionId/close", {
    preHandler: execute,
    paramsSchema: POSITION_PARAMS,
  }, async (request) => paper.closePosition(
    actorOf(request),
    request.params.accountId,
    request.params.positionId,
    { actorId: actorOf(request), reason: "MANUAL" },
  ));

  app.post("/paper/accounts/:accountId/tick", {
    preHandler: execute,
    paramsSchema: ACCOUNT_PARAMS,
  }, async (request) => paper.tick(actorOf(request), request.params.accountId, { actorId: actorOf(request) }));

  app.get("/paper/accounts/:accountId/deployments", {
    preHandler: view,
    paramsSchema: ACCOUNT_PARAMS,
  }, async (request) => paper.listDeployments(actorOf(request), request.params.accountId));

  app.post("/paper/accounts/:accountId/deployments", {
    preHandler: execute,
    paramsSchema: ACCOUNT_PARAMS,
    bodySchema: DEPLOYMENT_BODY,
  }, async (request, reply) => reply.code(201).send(await paper.deployStrategy(
    actorOf(request),
    request.params.accountId,
    request.body,
    { actorId: actorOf(request) },
  )));

  app.post("/paper/accounts/:accountId/deployments/:deploymentId/toggle", {
    preHandler: execute,
    paramsSchema: DEPLOYMENT_PARAMS,
    bodySchema: DEPLOYMENT_TOGGLE_BODY,
  }, async (request) => paper.toggleDeployment(
    actorOf(request),
    request.params.accountId,
    request.params.deploymentId,
    request.body.active,
    { actorId: actorOf(request) },
  ));

  // Persisted risk limits. Both the modern PATCH path and the legacy-style update
  // path reach the same validator and audit transaction.
  app.get("/risk/limits", { preHandler: view }, async () => paper.riskLimits());
  app.patch("/risk/limits", {
    preHandler: control,
    bodySchema: RISK_LIMITS_BODY,
  }, async (request) => paper.updateRiskLimits(request.body, { actorId: actorOf(request) }));
  app.post("/risk/limits/update", {
    preHandler: control,
    bodySchema: RISK_LIMITS_BODY,
  }, async (request) => paper.updateRiskLimits(request.body, { actorId: actorOf(request) }));

  app.get("/trading/mode", { preHandler: view }, async () => paper.tradingState());
  app.post("/trading/mode", {
    preHandler: control,
    bodySchema: TRADING_MODE_BODY,
  }, async (request) => paper.setTradingMode(request.body.mode, { actorId: actorOf(request) }));

  app.post("/trading/kill-switch", {
    preHandler: control,
    bodySchema: KILL_SWITCH_BODY,
  }, async (request) => paper.setKillSwitch(request.body.active, request.body.reason, { actorId: actorOf(request) }));

  app.post("/trading/synthetic-paper", {
    preHandler: control,
    bodySchema: SYNTHETIC_PAPER_BODY,
  }, async (request) => paper.setSyntheticPaperData(request.body.allow, { actorId: actorOf(request) }));

  app.get("/portfolio/risk-scan", {
    preHandler: view,
    querySchema: PORTFOLIO_QUERY,
  }, async (request) => paper.portfolioRiskScan(actorOf(request), request.query));

}
