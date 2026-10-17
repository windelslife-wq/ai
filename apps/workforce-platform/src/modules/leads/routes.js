/**
 * Lead Discovery HTTP routes (row 17 — Phase 45).
 *
 * Mirrors all 22 routes in `application/config/routes.php` (lines 298–319) plus
 * `GET /api/v1/lead-discovery/status`:
 * - Every route requires `system.authenticated` (`requirePermission("system.authenticated")`)
 * - Active organization is resolved from `X-Lead-Organization` verified against
 *   `wf_lead_organization_members` for `request.auth.user.id`
 */

import { createAuthenticator, requirePermission } from "../platform/guards.js";
import {
  COLLECTION_LEAD_PARAMS,
  COVERAGE_QUERY,
  ID_PARAMS,
  LEAD_PERMISSION,
  LEADS_QUERY,
} from "./contracts.js";
import { createLeadDiscoveryService } from "./service.js";

function requestedOrgOf(request) {
  const raw = request.headers?.["x-lead-organization"];
  if (Array.isArray(raw)) return String(raw[0] ?? "").trim();
  return String(raw ?? "").trim();
}

export function leadDiscoveryRoutes(app, { store, config, service = null }) {
  const leads = service || createLeadDiscoveryService({ config, store });
  const authenticate = createAuthenticator({ store, config });
  const guard = requirePermission(LEAD_PERMISSION, config);
  guard.permission = LEAD_PERMISSION;
  const authGuard = [authenticate, guard];

  app.get("/lead-discovery/status", {
    preHandler: authGuard,
  }, async () => leads.statusSnapshot());

  app.get("/lead-discovery/workspaces", {
    preHandler: authGuard,
  }, async (request) => leads.workspaces(request.auth.user, requestedOrgOf(request)));

  app.get("/lead-discovery/providers", {
    preHandler: authGuard,
  }, async (request) => leads.providers(request.auth.user, requestedOrgOf(request)));

  app.post("/lead-discovery/search", {
    preHandler: authGuard,
  }, async (request) => leads.search(request.auth.user, request.body || {}, requestedOrgOf(request)));

  app.get("/lead-discovery/leads", {
    preHandler: authGuard,
    querySchema: LEADS_QUERY,
  }, async (request) => leads.listLeads(request.auth.user, request.query || {}, requestedOrgOf(request)));

  app.get("/lead-discovery/leads/:id", {
    preHandler: authGuard,
    paramsSchema: ID_PARAMS,
  }, async (request) => leads.getLead(request.auth.user, request.params.id, requestedOrgOf(request)));

  app.get("/lead-discovery/collections", {
    preHandler: authGuard,
  }, async (request) => leads.listCollections(request.auth.user, requestedOrgOf(request)));

  app.post("/lead-discovery/collections", {
    preHandler: authGuard,
  }, async (request, reply) => reply.code(201).send(
    await leads.createCollection(request.auth.user, request.body || {}, requestedOrgOf(request)),
  ));

  app.patch("/lead-discovery/collections/:id", {
    preHandler: authGuard,
    paramsSchema: ID_PARAMS,
  }, async (request) => leads.updateCollection(request.auth.user, request.params.id, request.body || {}, requestedOrgOf(request)));

  app.delete("/lead-discovery/collections/:id", {
    preHandler: authGuard,
    paramsSchema: ID_PARAMS,
  }, async (request) => leads.deleteCollection(request.auth.user, request.params.id, requestedOrgOf(request)));

  app.get("/lead-discovery/collections/:id/leads", {
    preHandler: authGuard,
    paramsSchema: ID_PARAMS,
  }, async (request) => leads.listCollectionLeads(request.auth.user, request.params.id, requestedOrgOf(request)));

  app.post("/lead-discovery/collections/:id/leads", {
    preHandler: authGuard,
    paramsSchema: ID_PARAMS,
  }, async (request) => leads.mutateCollectionLeads(
    request.auth.user,
    request.params.id,
    { body: request.body || {}, remove: false },
    requestedOrgOf(request),
  ));

  app.delete("/lead-discovery/collections/:id/leads", {
    preHandler: authGuard,
    paramsSchema: ID_PARAMS,
  }, async (request) => leads.mutateCollectionLeads(
    request.auth.user,
    request.params.id,
    { body: request.body || {}, remove: true },
    requestedOrgOf(request),
  ));

  app.delete("/lead-discovery/collections/:id/leads/:leadId", {
    preHandler: authGuard,
    paramsSchema: COLLECTION_LEAD_PARAMS,
  }, async (request) => leads.mutateCollectionLeads(
    request.auth.user,
    request.params.id,
    { leadId: request.params.leadId, body: request.body || {}, remove: true },
    requestedOrgOf(request),
  ));

  app.patch("/lead-discovery/leads/:id/status", {
    preHandler: authGuard,
    paramsSchema: ID_PARAMS,
  }, async (request) => leads.updateLeadStatus(request.auth.user, request.params.id, request.body || {}, requestedOrgOf(request)));

  app.patch("/lead-discovery/leads/:id/owner", {
    preHandler: authGuard,
    paramsSchema: ID_PARAMS,
  }, async (request) => leads.updateLeadOwner(request.auth.user, request.params.id, request.body || {}, requestedOrgOf(request)));

  app.get("/lead-discovery/leads/:id/notes", {
    preHandler: authGuard,
    paramsSchema: ID_PARAMS,
  }, async (request) => leads.listNotes(request.auth.user, request.params.id, requestedOrgOf(request)));

  app.post("/lead-discovery/leads/:id/notes", {
    preHandler: authGuard,
    paramsSchema: ID_PARAMS,
  }, async (request, reply) => reply.code(201).send(
    await leads.addNote(request.auth.user, request.params.id, request.body || {}, requestedOrgOf(request)),
  ));

  app.get("/lead-discovery/leads/:id/activity", {
    preHandler: authGuard,
    paramsSchema: ID_PARAMS,
  }, async (request) => leads.listActivity(request.auth.user, request.params.id, requestedOrgOf(request)));

  app.get("/lead-discovery/duplicates", {
    preHandler: authGuard,
  }, async (request) => leads.listDuplicates(request.auth.user, requestedOrgOf(request)));

  app.post("/lead-discovery/duplicates/resolve", {
    preHandler: authGuard,
  }, async (request) => leads.resolveDuplicate(request.auth.user, request.body || {}, requestedOrgOf(request)));

  app.get("/lead-discovery/coverage", {
    preHandler: authGuard,
    querySchema: COVERAGE_QUERY,
  }, async (request) => leads.coverage(request.auth.user, request.query || {}, requestedOrgOf(request)));

  app.get("/lead-discovery/history", {
    preHandler: authGuard,
  }, async (request) => leads.history(request.auth.user, requestedOrgOf(request)));

  app.get("/lead-discovery/summary", {
    preHandler: authGuard,
  }, async (request) => leads.summary(request.auth.user, requestedOrgOf(request)));

  app.get("/lead-discovery/pipeline", {
    preHandler: authGuard,
  }, async (request) => leads.pipeline(request.auth.user, requestedOrgOf(request)));

  app.post("/lead-discovery/export", {
    preHandler: authGuard,
  }, async (request, reply) => {
    const result = await leads.exportLeads(request.auth.user, request.body || {}, { mode: "json" }, requestedOrgOf(request));
    if (result.isCsv) {
      reply.header("content-type", "text/csv; charset=utf-8");
      reply.header("content-disposition", 'attachment; filename="leads.csv"');
      return reply.end(result.csv);
    }
    return result;
  });

  app.post("/lead-discovery/export/preview", {
    preHandler: authGuard,
  }, async (request) => leads.exportLeads(request.auth.user, request.body || {}, { mode: "preview" }, requestedOrgOf(request)));

  app.post("/lead-discovery/export/csv", {
    preHandler: authGuard,
  }, async (request, reply) => {
    const result = await leads.exportLeads(request.auth.user, request.body || {}, { mode: "csv" }, requestedOrgOf(request));
    reply.header("content-type", "text/csv; charset=utf-8");
    reply.header("content-disposition", 'attachment; filename="leads.csv"');
    return reply.end(result.csv);
  });
}
