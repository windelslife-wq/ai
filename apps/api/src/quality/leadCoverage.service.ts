import type { Database } from "../db.js";
import { mapLeadRow } from "../leadRepository.js";

const columns = "id, organization_id, source, source_id, name, category, address, city, region, country, phone, website, latitude, longitude, status, owner_id, metadata, created_at, updated_at";
const fields = ["name", "address", "category", "phone", "website"] as const;
const labels: Record<(typeof fields)[number], string> = { name: "Business Name", address: "Address", category: "Category", phone: "Phone", website: "Website" };

/** Computes field coverage from PostgreSQL rows; no percentage is hard-coded. */
export class LeadCoverageService {
  constructor(private readonly db: Database) {}

  async summarize(organizationId: string, missing?: (typeof fields)[number]) {
    const aggregate = await this.db.query(`SELECT COUNT(*)::int AS total, ${fields.map(field => `COUNT(NULLIF(${field}, ''))::int AS ${field}_filled`).join(", ")} FROM leads WHERE organization_id=$1`, [organizationId]);
    const total = Number(aggregate.rows[0]?.total ?? 0);
    const response = {
      leadCount: total,
      fields: fields.map(key => { const filled = Number(aggregate.rows[0]?.[`${key}_filled`] ?? 0); return { key, field: labels[key], coverage: total ? Math.round((filled / total) * 1000) / 10 : 0, missing: total - filled }; }),
      missingField: missing ?? null,
      missingLeads: [] as ReturnType<typeof mapLeadRow>[],
    };
    if (missing) {
      const result = await this.db.query(`SELECT ${columns} FROM leads WHERE organization_id=$1 AND NULLIF(${missing}, '') IS NULL ORDER BY updated_at DESC LIMIT 250`, [organizationId]);
      response.missingLeads = result.rows.map(mapLeadRow);
    }
    return response;
  }
}
