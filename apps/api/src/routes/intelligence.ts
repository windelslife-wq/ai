import type { FastifyInstance, FastifyRequest } from "fastify";
import { ExportRequestSchema, ResolveDuplicateSchema } from "../../../../packages/shared/src/leadDiscovery.js";
import { requireLeadAccess, type LeadPrincipal } from "../auth.js";
import { mapLeadRow } from "../leadRepository.js";

const leadColumns = "l.id, l.organization_id, l.source, l.source_id, l.name, l.category, l.address, l.city, l.region, l.country, l.phone, l.website, l.latitude, l.longitude, l.status, l.owner_id, l.metadata, l.created_at, l.updated_at";
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
const audit = (app: FastifyInstance, user: LeadPrincipal, leadId: string | null, type: string, detail: Record<string, unknown>) => app.db.query("INSERT INTO lead_activities (organization_id,lead_id,actor_id,type,detail) VALUES ($1,$2,$3,$4,$5::jsonb)", [user.organizationId, leadId, user.sub, type, JSON.stringify(detail)]);
const csvCell = (value: unknown): string => {
  const text = String(value ?? "");
  const safe = /^[=+\-@]/.test(text) ? `'${text}` : text;
  return `"${safe.replaceAll('"', '""')}"`;
};
const csvSafeValue = (value: unknown): unknown => typeof value === "string" && /^[=+\-@]/.test(value) ? `'${value}` : value;

export async function intelligenceRoutes(app: FastifyInstance): Promise<void> {
  app.get("/history", async request => { const user = await requireLeadAccess(request); return app.searchHistory.list(user.organizationId); });

  app.get("/duplicates", async request => {
    const user = await requireLeadAccess(request);
    const rows = await app.db.query("SELECT d.*,a.name AS lead_a_name,b.name AS lead_b_name FROM duplicate_candidates d JOIN leads a ON a.id=d.lead_a_id JOIN leads b ON b.id=d.lead_b_id WHERE d.organization_id=$1 AND d.status='open' ORDER BY d.created_at DESC LIMIT 250", [user.organizationId]);
    return { duplicates: rows.rows.map(row => ({ id: row.id, leadAId: row.lead_a_id, leadBId: row.lead_b_id, leadAName: row.lead_a_name, leadBName: row.lead_b_name, ruleName: row.rule_name, confidence: Number(row.confidence), status: row.status, createdAt: row.created_at })) };
  });

  app.post("/duplicates/resolve", async request => {
    const user = await writable(request); const body = ResolveDuplicateSchema.parse(request.body);
    const candidateResult = await app.db.query("SELECT * FROM duplicate_candidates WHERE id=$1 AND organization_id=$2 AND status='open'", [body.candidateId, user.organizationId]);
    const candidate = candidateResult.rows[0];
    if (!candidate) throw Object.assign(new Error("duplicate candidate not found"), { statusCode: 404 });
    const a = String(candidate.lead_a_id); const b = String(candidate.lead_b_id);
    if (body.action === "merge") {
      // Keep A as the canonical record, fill only missing fields, preserve
      // source identity, and retain B as a disqualified audit trail.
      await app.db.query("UPDATE leads a SET category=COALESCE(a.category,b.category),address=COALESCE(a.address,b.address),city=COALESCE(a.city,b.city),region=COALESCE(a.region,b.region),country=COALESCE(a.country,b.country),phone=COALESCE(a.phone,b.phone),website=COALESCE(a.website,b.website),latitude=COALESCE(a.latitude,b.latitude),longitude=COALESCE(a.longitude,b.longitude),metadata=a.metadata || b.metadata,updated_at=now() FROM leads b WHERE a.id=$1 AND b.id=$2 AND a.organization_id=$3 AND b.organization_id=$3", [a, b, user.organizationId]);
      await app.db.query("INSERT INTO collection_leads (collection_id,lead_id) SELECT collection_id,$1 FROM collection_leads WHERE lead_id=$2 ON CONFLICT DO NOTHING", [a, b]);
      await app.db.query("UPDATE leads SET status='disqualified',metadata=metadata || jsonb_build_object('duplicateResolution',jsonb_build_object('keptLeadId',$1,'reason','merged')),updated_at=now() WHERE id=$2 AND organization_id=$3", [a, b, user.organizationId]);
      await audit(app, user, a, "DUPLICATE_RESOLVED", { candidateId: body.candidateId, action: "merge", mergedLeadId: b });
    } else if (body.action === "keep_a" || body.action === "keep_b") {
      const keep = body.action === "keep_a" ? a : b; const discard = body.action === "keep_a" ? b : a;
      await app.db.query("UPDATE leads SET status='disqualified',metadata=metadata || jsonb_build_object('duplicateResolution',jsonb_build_object('keptLeadId',$1,'reason','discarded')),updated_at=now() WHERE id=$2 AND organization_id=$3", [keep, discard, user.organizationId]);
      await audit(app, user, keep, "DUPLICATE_RESOLVED", { candidateId: body.candidateId, action: body.action, discardedLeadId: discard });
    } else {
      await audit(app, user, a, "DUPLICATE_RESOLVED", { candidateId: body.candidateId, action: "ignore" });
    }
    await app.db.query("UPDATE duplicate_candidates SET status='resolved' WHERE id=$1 AND organization_id=$2", [body.candidateId, user.organizationId]);
    await app.db.query("INSERT INTO duplicate_resolutions (candidate_id,organization_id,resolver_id,action) VALUES ($1,$2,$3,$4)", [body.candidateId, user.organizationId, user.sub, body.action]);
    return { ok: true, action: body.action };
  });

  const exportLeads = async (user: LeadPrincipal, raw: unknown) => {
    const filters = ExportRequestSchema.parse(raw ?? {});
    const where = ["l.organization_id=$1"]; const values: unknown[] = [user.organizationId];
    const add = (clause: string, value: unknown) => { values.push(value); where.push(clause.replace("?", `$${values.length}`)); };
    if (filters.status) add("l.status=?", filters.status);
    if (filters.ownerId) add("l.owner_id=?", filters.ownerId);
    if (filters.country) add("l.country=?", filters.country);
    if (filters.category) add("l.category ILIKE=?", `%${filters.category}%`);
    if (filters.from) add("l.created_at>=?", filters.from);
    if (filters.to) add("l.created_at<=?", filters.to);
    let join = "";
    if (filters.collectionId) { values.push(filters.collectionId); join = ` JOIN collection_leads cl ON cl.lead_id=l.id AND cl.collection_id=$${values.length}`; }
    const rows = await app.db.query(`SELECT ${leadColumns} FROM leads l ${join} WHERE ${where.join(" AND ")} ORDER BY l.created_at DESC`, values);
    return { filters, leads: rows.rows.map(mapLeadRow) };
  };

  app.post("/export/preview", async request => {
    const user = await requireLeadAccess(request); const result = await exportLeads(user, request.body);
    return { rows: result.leads.slice(0, 25).map(lead => Object.fromEntries(Object.entries(lead).map(([key, value]) => [key, csvSafeValue(value)]))), count: result.leads.length, csvSafe: true };
  });

  app.post("/export", async request => {
    const user = await writable(request); const result = await exportLeads(user, request.body);
    await app.db.query("INSERT INTO export_history (organization_id,user_id,format,filters,lead_count) VALUES ($1,$2,'json',$3::jsonb,$4)", [user.organizationId, user.sub, JSON.stringify(result.filters), result.leads.length]);
    await Promise.all(result.leads.map(lead => audit(app, user, lead.id, "LEAD_EXPORTED", { format: "json" })));
    return { leads: result.leads, count: result.leads.length, format: "json" };
  });

  app.post("/export/csv", async (request, reply) => {
    const user = await writable(request); const result = await exportLeads(user, request.body);
    const keys = ["name", "category", "address", "city", "region", "country", "phone", "website", "status"] as const;
    const body = [keys.join(","), ...result.leads.map(lead => keys.map(key => csvCell(lead[key])).join(","))].join("\r\n");
    await app.db.query("INSERT INTO export_history (organization_id,user_id,format,filters,lead_count) VALUES ($1,$2,'csv',$3::jsonb,$4)", [user.organizationId, user.sub, JSON.stringify(result.filters), result.leads.length]);
    await Promise.all(result.leads.map(lead => audit(app, user, lead.id, "LEAD_EXPORTED", { format: "csv" })));
    return reply.header("content-type", "text/csv; charset=utf-8").header("content-disposition", "attachment; filename=leads.csv").send(body);
  });
}

declare module "fastify" { interface FastifyInstance { db: import("../db.js").Database } }
