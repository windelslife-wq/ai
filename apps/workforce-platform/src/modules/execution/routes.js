/**
 * Paper-only Execution Supervisor routes (Phase 8A).
 *
 * Approval is a separate `trading.control` action; paper submission requires
 * `trading.execute` and calls the existing Paper Trading service. No live-order
 * or broker route is registered here.
 */

import { createAuthenticator, requirePermission } from "../platform/guards.js";
import { createExecutionService } from "./service.js";
import { DECISION_BODY, EMPTY_BODY, PROPOSAL_BODY, PROPOSAL_PARAMS, PROPOSALS_QUERY } from "./contracts.js";

export function executionRoutes(app, { store, config, service = null, paper = null, strategies = null, log = app.log }) {
  const execution = service || createExecutionService({ store, paper, strategies, log });
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

  app.get("/execution/status", { preHandler: view }, async () => execution.statusSnapshot());

  app.post("/execution/proposals", {
    preHandler: execute,
    bodySchema: PROPOSAL_BODY,
  }, async (request, reply) => reply.code(201).send(await execution.propose(actorOf(request), request.body)));

  app.get("/execution/proposals", {
    preHandler: view,
    querySchema: PROPOSALS_QUERY,
  }, async (request) => execution.list(actorOf(request), request.query));

  app.get("/execution/proposals/:proposalId", {
    preHandler: view,
    paramsSchema: PROPOSAL_PARAMS,
  }, async (request) => execution.find(actorOf(request), request.params.proposalId));

  app.post("/execution/proposals/:proposalId/decision", {
    preHandler: control,
    paramsSchema: PROPOSAL_PARAMS,
    bodySchema: DECISION_BODY,
  }, async (request) => execution.decide(actorOf(request), request.params.proposalId, request.body));

  app.post("/execution/proposals/:proposalId/paper-submit", {
    preHandler: execute,
    paramsSchema: PROPOSAL_PARAMS,
    bodySchema: EMPTY_BODY,
  }, async (_request, reply) => {
    const proposalId = _request.params.proposalId;
    const ownerUserId = _request.auth?.user?.id ?? null;
    const result = await execution.submitToPaper(ownerUserId, proposalId);
    const status = result.proposal.status === "PAPER_REJECTED" ? 409
      : result.proposal.status === "PAPER_PENDING" ? 202 : 201;
    return reply.code(status).send(result);
  });
}
