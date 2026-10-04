import type { Database } from "./db.js";
import type { DiscoveredBusiness } from "./providers/leadDiscoveryProvider.js";

export type PersistedLead = {
  id: string;
  organizationId: string;
  source: string;
  sourceId: string;
  name: string;
  category: string | null;
  address: string | null;
  city: string | null;
  region: string | null;
  country: string | null;
  phone: string | null;
  website: string | null;
  latitude: number | null;
  longitude: number | null;
  status: "new" | "contacted" | "qualified" | "disqualified" | "converted";
  ownerId: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

const jsonObject = (value: unknown): Record<string, unknown> => {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value === "string") {
    try { const parsed: unknown = JSON.parse(value); if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>; } catch { /* malformed metadata is treated as empty at the transport boundary */ }
  }
  return {};
};

export const mapLeadRow = (r: Record<string, unknown>): PersistedLead => ({
  id: String(r.id), organizationId: String(r.organization_id), source: String(r.source), sourceId: String(r.source_id),
  name: String(r.name), category: r.category as string | null, address: r.address as string | null,
  city: r.city as string | null, region: r.region as string | null, country: r.country as string | null,
  phone: r.phone as string | null, website: r.website as string | null,
  latitude: r.latitude == null ? null : Number(r.latitude), longitude: r.longitude == null ? null : Number(r.longitude),
  status: r.status as PersistedLead["status"], ownerId: r.owner_id as string | null,
  metadata: jsonObject(r.metadata), createdAt: new Date(String(r.created_at)).toISOString(), updatedAt: new Date(String(r.updated_at)).toISOString(),
});

export class LeadRepository {
  constructor(private readonly db: Database) {}

  async findById(organizationId: string, leadId: string): Promise<PersistedLead | null> {
    const result = await this.db.query("SELECT * FROM leads WHERE organization_id=$1 AND id=$2", [organizationId, leadId]);
    return result.rows[0] ? mapLeadRow(result.rows[0]) : null;
  }

  async upsertDiscovery(organizationId: string, source: string, business: DiscoveredBusiness): Promise<{ lead: PersistedLead; created: boolean }> {
    const result = await this.db.query(`
      INSERT INTO leads (organization_id,source,source_id,name,category,address,city,region,country,phone,website,latitude,longitude,metadata)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb)
      ON CONFLICT (organization_id,source,source_id) DO UPDATE SET
        name=EXCLUDED.name,
        category=COALESCE(EXCLUDED.category,leads.category),
        address=COALESCE(EXCLUDED.address,leads.address),
        city=COALESCE(EXCLUDED.city,leads.city),
        region=COALESCE(EXCLUDED.region,leads.region),
        country=COALESCE(EXCLUDED.country,leads.country),
        phone=COALESCE(EXCLUDED.phone,leads.phone),
        website=COALESCE(EXCLUDED.website,leads.website),
        latitude=COALESCE(EXCLUDED.latitude,leads.latitude),
        longitude=COALESCE(EXCLUDED.longitude,leads.longitude),
        metadata=leads.metadata || EXCLUDED.metadata,
        updated_at=now()
      RETURNING *, (xmax = 0) AS inserted`, [
      organizationId, source, business.sourceId, business.name, business.category, business.address,
      business.city, business.region, business.country, business.phone, business.website,
      business.latitude, business.longitude, JSON.stringify(business.metadata),
    ]);
    const row = result.rows[0];
    if (!row) throw new Error("lead upsert returned no record");
    return { lead: mapLeadRow(row), created: row.inserted === true || row.inserted === "t" };
  }

  /** Creates review candidates only for secondary signals; source identity remains authoritative. */
  async detectSecondaryDuplicates(lead: PersistedLead): Promise<number> {
    const others = await this.db.query("SELECT id,name,address,phone,website FROM leads WHERE organization_id=$1 AND id<>$2", [lead.organizationId, lead.id]);
    let created = 0;
    const digits = (value: string | null) => value?.replace(/\D/g, "") ?? "";
    const domain = (value: string | null) => { try { return value ? new URL(value.includes("://") ? value : `https://${value}`).hostname.replace(/^www\./, "").toLowerCase() : ""; } catch { return ""; } };
    const compact = (value: string | null) => value?.toLowerCase().replace(/[^a-z0-9]/g, "") ?? "";
    for (const other of others.rows) {
      let rule: "website_domain" | "normalized_phone" | "name_address" | undefined;
      let confidence = 0;
      if (domain(lead.website) && domain(lead.website) === domain(other.website as string | null)) { rule = "website_domain"; confidence = .95; }
      else if (digits(lead.phone).length >= 7 && digits(lead.phone) === digits(other.phone as string | null)) { rule = "normalized_phone"; confidence = .92; }
      else if (compact(lead.name) && compact(lead.address) && `${compact(lead.name)}|${compact(lead.address)}` === `${compact(other.name as string | null)}|${compact(other.address as string | null)}`) { rule = "name_address"; confidence = .84; }
      if (!rule) continue;
      const [a, b] = [lead.id, String(other.id)].sort();
      const result = await this.db.query(`
        INSERT INTO duplicate_candidates (organization_id,lead_a_id,lead_b_id,rule_name,confidence)
        VALUES ($1,$2,$3,$4,$5)
        ON CONFLICT (organization_id,lead_a_id,lead_b_id,rule_name) DO NOTHING
        RETURNING id`, [lead.organizationId, a, b, rule, confidence]);
      created += result.rows.length;
    }
    return created;
  }

  async recordActivity(organizationId: string, actorId: string, leadId: string, type: string, detail: Record<string, unknown> = {}): Promise<void> {
    await this.db.query("INSERT INTO lead_activities (organization_id,lead_id,actor_id,type,detail) VALUES ($1,$2,$3,$4,$5::jsonb)", [organizationId, leadId, actorId, type, JSON.stringify(detail)]);
  }

  async recordSearch(input: { organizationId: string; userId: string; query: string; provider: string; filters: Record<string, unknown>; resultsReturned: number; newLeadsCreated: number; duplicatesDetected: number; errors?: string; durationMs: number }): Promise<void> {
    await this.db.query("INSERT INTO search_history (organization_id,user_id,query,provider,filters,results_returned,new_leads_created,duplicates_detected,errors,duration_ms) VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9::jsonb,$10)", [
      input.organizationId, input.userId, input.query, input.provider, JSON.stringify(input.filters), input.resultsReturned,
      input.newLeadsCreated, input.duplicatesDetected, input.errors ? JSON.stringify({ message: input.errors }) : null, input.durationMs,
    ]);
  }
}
