import type { FastifyInstance, FastifyRequest } from "fastify";
import { AddCollectionLeadsSchema, AddLeadNoteSchema, ChangeLeadOwnerSchema, ChangeLeadStatusSchema, CreateCollectionSchema } from "../../../../packages/shared/src/leadDiscovery.js";
import { requireLeadAccess, type LeadPrincipal } from "../auth.js";
import { mapLeadRow } from "../leadRepository.js";

const id = (request: FastifyRequest, key: string) => {
  const value = (request.params as Record<string, string>)[key];
  if (!/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(value ?? "")) throw Object.assign(new Error(`invalid ${key}`), { statusCode: 400 });
  return value!;
};
const writable = async (request: FastifyRequest): Promise<LeadPrincipal> => {
  const user = await requireLeadAccess(request);
  if (!user.permissions.includes("lead.write")) throw Object.assign(new Error("forbidden"), { statusCode: 403 });
  return user;
};
const leadColumns = "l.id, l.organization_id, l.source, l.source_id, l.name, l.category, l.address, l.city, l.region, l.country, l.phone, l.website, l.latitude, l.longitude, l.status, l.owner_id, l.metadata, l.created_at, l.updated_at";

export async function pipelineRoutes(app: FastifyInstance): Promise<void> {
  app.get("/summary", async request => { const user = await requireLeadAccess(request); return app.leadPipeline.summary(user.organizationId); });
  app.get("/pipeline", async request => { const user = await requireLeadAccess(request); return app.leadPipeline.pipeline(user.organizationId); });

  app.patch("/leads/:id/status", async request => {
    const user = await writable(request); const leadId = id(request, "id");
    const body = ChangeLeadStatusSchema.parse(request.body);
    return app.leadPipeline.updateStatus(user, leadId, body.status);
  });

  app.patch("/leads/:id/owner", async request => {
    const user = await writable(request); const leadId = id(request, "id");
    const body = ChangeLeadOwnerSchema.parse(request.body);
    return app.leadPipeline.updateOwner(user, leadId, body.ownerId);
  });

  app.get("/leads/:id/notes", async request => { const user = await requireLeadAccess(request); return app.leadPipeline.notes(user.organizationId, id(request, "id")); });
  app.post("/leads/:id/notes", async request => { const user = await writable(request); const body = AddLeadNoteSchema.parse(request.body); return app.leadPipeline.addNote(user, id(request, "id"), body.body); });
  app.get("/leads/:id/activity", async request => { const user = await requireLeadAccess(request); const leadId = id(request, "id"); const result = await app.db.query("SELECT id,lead_id,actor_id,type,detail,created_at FROM lead_activities WHERE organization_id=$1 AND lead_id=$2 ORDER BY created_at DESC LIMIT 250", [user.organizationId, leadId]); return { activity: result.rows.map(item => ({ id: item.id, leadId: item.lead_id, actorId: item.actor_id, type: item.type, detail: item.detail, createdAt: item.created_at })) }; });

  app.get("/collections", async request => {
    const user = await requireLeadAccess(request);
    const result = await app.db.query("SELECT c.id,c.organization_id,c.name,c.created_at,c.updated_at,COUNT(cl.lead_id)::int AS lead_count FROM collections c LEFT JOIN collection_leads cl ON cl.collection_id=c.id WHERE c.organization_id=$1 GROUP BY c.id ORDER BY c.name", [user.organizationId]);
    return { collections: result.rows.map(x => ({ id: x.id, organizationId: x.organization_id, name: x.name, leadCount: Number(x.lead_count), createdAt: x.created_at, updatedAt: x.updated_at })) };
  });

  app.post("/collections", async request => {
    const user = await writable(request); const body = CreateCollectionSchema.parse(request.body);
    try {
      const result = await app.db.query("INSERT INTO collections (organization_id,name) VALUES ($1,$2) RETURNING id,organization_id,name,created_at,updated_at", [user.organizationId, body.name]);
      const x = result.rows[0]!; return { id: x.id, organizationId: x.organization_id, name: x.name, leadCount: 0, createdAt: x.created_at, updatedAt: x.updated_at };
    } catch (error) { if ((error as { code?: string }).code === "23505") throw Object.assign(new Error("a collection with this name already exists"), { statusCode: 409 }); throw error; }
  });

  app.patch("/collections/:id", async request => {
    const user = await writable(request); const collectionId = id(request, "id"); const body = CreateCollectionSchema.parse(request.body);
    try {
      const result = await app.db.query("UPDATE collections SET name=$1,updated_at=now() WHERE id=$2 AND organization_id=$3 RETURNING id", [body.name, collectionId, user.organizationId]);
      if (!result.rows[0]) throw Object.assign(new Error("collection not found"), { statusCode: 404 }); return { ok: true };
    } catch (error) { if ((error as { code?: string }).code === "23505") throw Object.assign(new Error("a collection with this name already exists"), { statusCode: 409 }); throw error; }
  });

  app.delete("/collections/:id", async request => { const user = await writable(request); const collectionId = id(request, "id"); const result = await app.db.query("DELETE FROM collections WHERE id=$1 AND organization_id=$2 RETURNING id", [collectionId, user.organizationId]); if (!result.rows[0]) throw Object.assign(new Error("collection not found"), { statusCode: 404 }); return { ok: true }; });

  app.get("/collections/:id/leads", async request => { const user = await requireLeadAccess(request); const collectionId = id(request, "id"); const result = await app.db.query(`SELECT ${leadColumns} FROM leads l JOIN collection_leads cl ON cl.lead_id=l.id JOIN collections c ON c.id=cl.collection_id WHERE c.id=$1 AND c.organization_id=$2 AND l.organization_id=$2 ORDER BY l.updated_at DESC`, [collectionId, user.organizationId]); return { leads: result.rows.map(mapLeadRow) }; });

  app.post("/collections/:id/leads", async request => {
    const user = await writable(request); const collectionId = id(request, "id"); const body = AddCollectionLeadsSchema.parse(request.body);
    const collection = await app.db.query("SELECT id FROM collections WHERE id=$1 AND organization_id=$2", [collectionId, user.organizationId]);
    if (!collection.rows[0]) throw Object.assign(new Error("collection not found"), { statusCode: 404 });
    let added = 0;
    for (const leadId of body.leadIds) {
      const result = await app.db.query("INSERT INTO collection_leads (collection_id,lead_id) SELECT $1,$2 WHERE EXISTS (SELECT 1 FROM leads WHERE id=$2 AND organization_id=$3) ON CONFLICT DO NOTHING RETURNING lead_id", [collectionId, leadId, user.organizationId]);
      if (result.rows[0]) { added += 1; await app.leadPipeline.activity(user, leadId, "LEAD_ADDED_TO_COLLECTION", { collectionId }); }
    }
    return { ok: true, added };
  });

  app.delete("/collections/:id/leads/:leadId", async request => {
    const user = await writable(request); const collectionId = id(request, "id"); const leadId = id(request, "leadId");
    const deleted = await app.db.query("DELETE FROM collection_leads cl USING collections c, leads l WHERE cl.collection_id=c.id AND cl.lead_id=l.id AND c.id=$1 AND c.organization_id=$2 AND l.id=$3 AND l.organization_id=$2 RETURNING cl.lead_id", [collectionId, user.organizationId, leadId]);
    if (deleted.rows[0]) await app.leadPipeline.activity(user, leadId, "LEAD_REMOVED_FROM_COLLECTION", { collectionId });
    return { ok: true, removed: deleted.rows.length };
  });
}

declare module "fastify" { interface FastifyInstance { db: import("../db.js").Database } }
