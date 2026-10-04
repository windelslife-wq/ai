import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { LeadStatusSchema, LeadStatuses } from "../../../../packages/shared/src/leadDiscovery.js";
import { requireLeadAccess } from "../auth.js";
import { LeadRepository, mapLeadRow } from "../leadRepository.js";

const LeadListQuery = z.object({
  status: LeadStatusSchema.optional(),
  q: z.string().trim().max(200).optional(),
  country: z.string().trim().max(120).optional(),
  category: z.string().trim().max(255).optional(),
  ownerId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(250).default(100),
});
const CoverageQuery = z.object({ missing: z.enum(["name", "address", "category", "phone", "website"]).optional() });
const columns = "id, organization_id, source, source_id, name, category, address, city, region, country, phone, website, latitude, longitude, status, owner_id, metadata, created_at, updated_at";
const id = (request: FastifyRequest): string => {
  const value = (request.params as Record<string, string | undefined>).id;
  if (!value || !/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(value)) throw Object.assign(new Error("invalid lead id"), { statusCode: 400 });
  return value;
};

export async function leadRoutes(app: FastifyInstance): Promise<void> {
  app.get("/leads", async request => {
    const principal = await requireLeadAccess(request);
    const query = LeadListQuery.parse(request.query);
    const where = ["organization_id = $1"];
    const values: unknown[] = [principal.organizationId];
    const add = (clause: string, value: unknown) => { values.push(value); where.push(clause.replace("?", `$${values.length}`)); };
    if (query.status) add("status = ?", query.status);
    if (query.q) add("(name ILIKE ? OR address ILIKE ? OR category ILIKE ?)", `%${query.q}%`);
    // q has three placeholders and must be appended explicitly.
    if (query.q) {
      const qValue = values[values.length - 1];
      values.push(qValue, qValue);
      where[where.length - 1] = `(name ILIKE $${values.length - 2} OR address ILIKE $${values.length - 1} OR category ILIKE $${values.length})`;
    }
    if (query.country) add("country = ?", query.country);
    if (query.category) add("category ILIKE ?", `%${query.category}%`);
    if (query.ownerId) add("owner_id = ?", query.ownerId);
    values.push(query.limit);
    const result = await app.db.query(`SELECT ${columns} FROM leads WHERE ${where.join(" AND ")} ORDER BY updated_at DESC LIMIT $${values.length}`, values);
    return { leads: result.rows.map(mapLeadRow), count: result.rows.length };
  });

  app.get("/leads/:id", async request => {
    const principal = await requireLeadAccess(request);
    const leadId = id(request);
    const repository = new LeadRepository(app.db);
    const record = await repository.findById(principal.organizationId, leadId);
    if (!record) throw Object.assign(new Error("lead not found"), { statusCode: 404 });
    const [notes, activities] = await Promise.all([
      app.db.query("SELECT id,lead_id,author_id,body,created_at FROM lead_notes WHERE organization_id=$1 AND lead_id=$2 ORDER BY created_at DESC", [principal.organizationId, leadId]),
      app.db.query("SELECT id,lead_id,actor_id,type,detail,created_at FROM lead_activities WHERE organization_id=$1 AND lead_id=$2 ORDER BY created_at DESC LIMIT 250", [principal.organizationId, leadId]),
    ]);
    return {
      lead: record,
      notes: notes.rows.map(note => ({ id: note.id, leadId: note.lead_id, authorId: note.author_id, body: note.body, createdAt: note.created_at })),
      activity: activities.rows.map(item => ({ id: item.id, leadId: item.lead_id, actorId: item.actor_id, type: item.type, detail: item.detail, createdAt: item.created_at })),
    };
  });

  app.get("/coverage", async request => {
    const principal = await requireLeadAccess(request);
    const query = CoverageQuery.parse(request.query);
    return app.leadCoverage.summarize(principal.organizationId, query.missing);
  });
}

declare module "fastify" { interface FastifyInstance { db: import("../db.js").Database } }
