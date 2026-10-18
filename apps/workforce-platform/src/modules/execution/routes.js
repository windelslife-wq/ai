/**
 * Execution Supervisor routes. Broker-independent proposal submission remains
 * simulation-only through Paper Trading. Governed automated modes are also
 * confined to the same Paper Trading service; no endpoint routes live money.
 */

import { createAuthenticator, requirePermission } from "../platform/guards.js";
import { createExecutionService } from "./service.js";
import {
  AUTOMATION_LIMITS_BODY,
  DECISION_BODY,
  EMPTY_BODY,
  EXECUTION_MODE_BODY,
  PROPOSAL_BODY,
  PROPOSAL_PARAMS,
  PROPOSALS_QUERY,
} from "./contracts.js";

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
  app.get("/execution/automation", { preHandler: view }, async (request) => execution.automationConfig(actorOf(request)));

  app.patch("/execution/automation-limits", {
    preHandler: control,
    bodySchema: AUTOMATION_LIMITS_BODY,
  }, async (request) => execution.updateAutomationLimits(actorOf(request), request.body));

  app.post("/execution/mode", {
    preHandler: control,
    bodySchema: EXECUTION_MODE_BODY,
  }, async (request) => execution.setExecutionMode(actorOf(request), request.body.mode));

  app.post("/execution/automated-paper", {
    preHandler: execute,
    bodySchema: PROPOSAL_BODY,
  }, async (request, reply) => {
    const result = await execution.executeAutomated(actorOf(request), request.body);
    const status = result.status === "REJECTED" ? 409 : result.status === "PAPER_PENDING" ? 202 : 201;
    return reply.code(status).send(result);
  });

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
  }, async (request, reply) => {
    const result = await execution.submitToPaper(request.auth?.user?.id ?? null, request.params.proposalId);
    const status = result.proposal.status === "PAPER_REJECTED" ? 409
      : result.proposal.status === "PAPER_PENDING" ? 202 : 201;
    return reply.code(status).send(result);
  });

  app.post("/execution/proposals/:proposalId/simulator-submit", {
    preHandler: execute,
    paramsSchema: PROPOSAL_PARAMS,
    bodySchema: EMPTY_BODY,
  }, async (request, reply) => {
    const result = await execution.submitToSimulator(request.auth?.user?.id ?? null, request.params.proposalId);
    const status = result.proposal.status === "SIMULATOR_PENDING" ? 202 : 201;
    return reply.code(status).send(result);
  });
}
