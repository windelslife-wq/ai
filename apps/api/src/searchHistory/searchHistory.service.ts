import type { Database } from "../db.js";

/** Read-only discovery ledger service; every result is scoped to one organization. */
export class SearchHistoryService {
  constructor(private readonly db: Database) {}

  async list(organizationId: string, limit = 100) {
    const rows = await this.db.query("SELECT id,query,provider,filters,results_returned,new_leads_created,duplicates_detected,errors,duration_ms,created_at FROM search_history WHERE organization_id=$1 ORDER BY created_at DESC LIMIT $2", [organizationId, Math.min(500, Math.max(1, limit))]);
    return { history: rows.rows.map(row => ({ id: row.id, query: row.query, provider: row.provider, filters: row.filters ?? {}, resultsReturned: Number(row.results_returned), newLeadsCreated: Number(row.new_leads_created), duplicatesDetected: Number(row.duplicates_detected), errors: row.errors ?? null, durationMs: Number(row.duration_ms), createdAt: row.created_at })) };
  }
}
