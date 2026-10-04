import type { LeadStatus } from "../../../../packages/shared/src/leadDiscovery.js";
import type { LeadPrincipal } from "../auth.js";
import type { Database } from "../db.js";
import { mapLeadRow } from "../leadRepository.js";

const columns = "l.id, l.organization_id, l.source, l.source_id, l.name, l.category, l.address, l.city, l.region, l.country, l.phone, l.website, l.latitude, l.longitude, l.status, l.owner_id, l.metadata, l.created_at, l.updated_at";

/** Domain service for organization-scoped statuses, ownership, notes and activity. */
export class LeadPipelineService {
  constructor(private readonly db: Database) {}

  async summary(organizationId: string) {
    const result = await this.db.query("SELECT status, COUNT(*)::int AS total FROM leads WHERE organization_id=$1 GROUP BY status", [organizationId]);
    const counts = new Map(result.rows.map(row => [String(row.status), Number(row.total)]));
    return { pipeline: (["new", "contacted", "qualified", "disqualified", "converted"] as const).map(status => ({ status, total: counts.get(status) ?? 0 })) };
  }

  async pipeline(organizationId: string) {
    const statuses = ["new", "contacted", "qualified", "disqualified", "converted"] as const;
    const columnsByStatus = Object.fromEntries(statuses.map(status => [status, [] as ReturnType<typeof mapLeadRow>[]]));
    const result = await this.db.query(`SELECT ${columns} FROM leads l WHERE l.organization_id=$1 ORDER BY l.updated_at DESC`, [organizationId]);
    for (const row of result.rows) columnsByStatus[row.status as keyof typeof columnsByStatus]?.push(mapLeadRow(row));
    return { statuses, columns: columnsByStatus };
  }

  async updateStatus(principal: LeadPrincipal, leadId: string, status: LeadStatus) {
    const result = await this.db.query("UPDATE leads SET status=$1,updated_at=now() WHERE id=$2 AND organization_id=$3 RETURNING status", [status, leadId, principal.organizationId]);
    if (!result.rows[0]) throw Object.assign(new Error("lead not found"), { statusCode: 404 });
    await this.activity(principal, leadId, "STATUS_CHANGED", { to: status });
    return { ok: true as const, status };
  }

  async updateOwner(principal: LeadPrincipal, leadId: string, ownerId: string | null) {
    if (ownerId) {
      const member = await this.db.query("SELECT 1 FROM organization_members WHERE organization_id=$1 AND user_id=$2", [principal.organizationId, ownerId]);
      if (!member.rows[0]) throw Object.assign(new Error("owner must belong to this organization"), { statusCode: 400 });
    }
    const result = await this.db.query("UPDATE leads SET owner_id=$1,updated_at=now() WHERE id=$2 AND organization_id=$3 RETURNING id", [ownerId, leadId, principal.organizationId]);
    if (!result.rows[0]) throw Object.assign(new Error("lead not found"), { statusCode: 404 });
    await this.activity(principal, leadId, ownerId ? "OWNER_ASSIGNED" : "OWNER_REMOVED", { ownerId });
    return { ok: true as const, ownerId };
  }

  async notes(organizationId: string, leadId: string) {
    const result = await this.db.query("SELECT id,lead_id,author_id,body,created_at FROM lead_notes WHERE organization_id=$1 AND lead_id=$2 ORDER BY created_at DESC", [organizationId, leadId]);
    return { notes: result.rows.map(note => ({ id: String(note.id), leadId: String(note.lead_id), authorId: String(note.author_id), body: String(note.body), createdAt: String(note.created_at) })) };
  }

  async addNote(principal: LeadPrincipal, leadId: string, body: string) {
    const result = await this.db.query("INSERT INTO lead_notes (organization_id,lead_id,author_id,body) SELECT $1,$2,$3,$4 WHERE EXISTS (SELECT 1 FROM leads WHERE id=$2 AND organization_id=$1) RETURNING id,lead_id,author_id,body,created_at", [principal.organizationId, leadId, principal.sub, body]);
    if (!result.rows[0]) throw Object.assign(new Error("lead not found"), { statusCode: 404 });
    await this.activity(principal, leadId, "NOTE_ADDED");
    const note = result.rows[0];
    return { id: String(note.id), leadId: String(note.lead_id), authorId: String(note.author_id), body: String(note.body), createdAt: String(note.created_at) };
  }

  async activity(organizationIdOrPrincipal: string | LeadPrincipal, leadId: string | null, type: string, detail: Record<string, unknown> = {}) {
    const organizationId = typeof organizationIdOrPrincipal === "string" ? organizationIdOrPrincipal : organizationIdOrPrincipal.organizationId;
    const actorId = typeof organizationIdOrPrincipal === "string" ? null : organizationIdOrPrincipal.sub;
    return this.db.query("INSERT INTO lead_activities (organization_id,lead_id,actor_id,type,detail) VALUES ($1,$2,$3,$4,$5::jsonb)", [organizationId, leadId, actorId, type, JSON.stringify(detail)]);
  }
}
