/**
 * MySQL repository for the Lead Discovery module (row 17 — migration 020).
 *
 * Every query is organization-scoped (`organization_id = ?`), matching
 * `application/controllers/Api_lead_discovery.php` and `application/database/schema.mysql.sql`.
 */

function toJsonString(value, fallback = "{}") {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return fallback;
  return JSON.stringify(value);
}

export function normalizeLeadRow(row) {
  if (!row) return null;
  return {
    id: String(row.id),
    organization_id: String(row.organization_id),
    source: String(row.source),
    source_id: String(row.source_id),
    name: String(row.name),
    category: row.category ?? null,
    address: row.address ?? null,
    city: row.city ?? null,
    region: row.region ?? null,
    country: row.country ?? null,
    phone: row.phone ?? null,
    website: row.website ?? null,
    latitude: row.latitude === null || row.latitude === undefined ? null : Number(row.latitude),
    longitude: row.longitude === null || row.longitude === undefined ? null : Number(row.longitude),
    status: String(row.status || "new"),
    owner_id: row.owner_id === null || row.owner_id === undefined ? null : Number(row.owner_id),
    metadata: toJsonString(row.metadata, "{}"),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

export function normalizeLeadNoteRow(row) {
  if (!row) return null;
  return {
    id: String(row.id),
    lead_id: String(row.lead_id),
    organization_id: String(row.organization_id),
    author_id: Number(row.author_id),
    body: String(row.body),
    created_at: String(row.created_at),
  };
}

export function normalizeLeadActivityRow(row) {
  if (!row) return null;
  return {
    id: String(row.id),
    lead_id: row.lead_id === null || row.lead_id === undefined ? null : String(row.lead_id),
    organization_id: String(row.organization_id),
    actor_id: row.actor_id === null || row.actor_id === undefined ? null : Number(row.actor_id),
    type: String(row.type),
    detail: toJsonString(row.detail, "{}"),
    created_at: String(row.created_at),
  };
}

export function normalizeLeadCollectionRow(row) {
  if (!row) return null;
  return {
    id: String(row.id),
    organization_id: String(row.organization_id),
    name: String(row.name),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
    leadCount: Number(row.leadCount ?? row.lead_count ?? 0),
  };
}

export function normalizeLeadDuplicateCandidateRow(row) {
  if (!row) return null;
  return {
    id: String(row.id),
    organization_id: String(row.organization_id),
    lead_a_id: String(row.lead_a_id),
    lead_b_id: String(row.lead_b_id),
    rule_name: String(row.rule_name),
    confidence: Number(row.confidence),
    status: String(row.status || "open"),
    created_at: String(row.created_at),
    ...(row.leadAName !== undefined ? { leadAName: String(row.leadAName) } : {}),
    ...(row.leadBName !== undefined ? { leadBName: String(row.leadBName) } : {}),
  };
}

export function normalizeLeadSearchHistoryRow(row) {
  if (!row) return null;
  return {
    id: String(row.id),
    organization_id: String(row.organization_id),
    user_id: Number(row.user_id),
    query: String(row.query),
    provider: String(row.provider),
    filters: toJsonString(row.filters, "{}"),
    results_returned: Number(row.results_returned ?? 0),
    new_leads_created: Number(row.new_leads_created ?? 0),
    duplicates_detected: Number(row.duplicates_detected ?? 0),
    errors: row.errors === null || row.errors === undefined ? null : String(row.errors),
    duration_ms: Number(row.duration_ms ?? 0),
    created_at: String(row.created_at),
  };
}

export function normalizeLeadExportHistoryRow(row) {
  if (!row) return null;
  return {
    id: String(row.id),
    organization_id: String(row.organization_id),
    user_id: Number(row.user_id),
    format: String(row.format),
    filters: toJsonString(row.filters, "{}"),
    lead_count: Number(row.lead_count ?? 0),
    created_at: String(row.created_at),
  };
}

export function createLeadRepository(pool) {
  return {
    async listLeadWorkspaces(userId) {
      const [rows] = await pool.execute(
        `SELECT o.id, o.name, m.role, m.created_at
           FROM wf_lead_organizations o
           JOIN wf_lead_organization_members m ON m.organization_id = o.id
          WHERE m.user_id = ?
          ORDER BY m.created_at ASC, o.id ASC`,
        [Number(userId)],
      );
      return rows.map((row) => ({
        id: String(row.id),
        name: String(row.name),
        role: String(row.role),
        created_at: String(row.created_at),
      }));
    },

    async ensureLeadWorkspace({ userId, email = null, organizationId = null, name = null, role = "owner", nowIso }) {
      const uid = Number(userId);
      const orgId = String(organizationId || `org-${uid}`);
      const orgName = String(name || `${email || "My"} workspace`);
      const at = String(nowIso);
      await pool.execute(
        `INSERT INTO wf_lead_organizations (id, name, created_at)
         VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE name = VALUES(name)`,
        [orgId, orgName, at],
      );
      await pool.execute(
        `INSERT INTO wf_lead_organization_members (organization_id, user_id, role, created_at)
         VALUES (?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE role = VALUES(role)`,
        [orgId, uid, String(role || "owner"), at],
      );
      return { id: orgId, name: orgName, role: String(role || "owner"), created_at: at };
    },

    async listLeads(organizationId, { status = null, limit = 250 } = {}) {
      const bounded = Math.min(Math.max(Number(limit) || 250, 1), 10_000);
      const values = [String(organizationId)];
      let where = "WHERE organization_id = ?";
      if (status) {
        where += " AND status = ?";
        values.push(String(status));
      }
      const [rows] = await pool.query(
        `SELECT * FROM wf_leads ${where} ORDER BY updated_at DESC, id ASC LIMIT ${bounded}`,
        values,
      );
      return rows.map(normalizeLeadRow);
    },

    async findLeadById(organizationId, leadId) {
      const [rows] = await pool.execute(
        `SELECT * FROM wf_leads WHERE id = ? AND organization_id = ? LIMIT 1`,
        [String(leadId), String(organizationId)],
      );
      return normalizeLeadRow(rows[0] || null);
    },

    async findLeadBySource(organizationId, source, sourceId) {
      const [rows] = await pool.execute(
        `SELECT * FROM wf_leads WHERE organization_id = ? AND source = ? AND source_id = ? LIMIT 1`,
        [String(organizationId), String(source), String(sourceId)],
      );
      return normalizeLeadRow(rows[0] || null);
    },

    async saveLead(lead) {
      const row = normalizeLeadRow(lead);
      await pool.execute(
        `INSERT INTO wf_leads
          (id, organization_id, source, source_id, name, category, address, city, region, country,
           phone, website, latitude, longitude, status, owner_id, metadata, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           name = VALUES(name),
           category = VALUES(category),
           address = VALUES(address),
           city = VALUES(city),
           region = VALUES(region),
           country = VALUES(country),
           phone = VALUES(phone),
           website = VALUES(website),
           latitude = VALUES(latitude),
           longitude = VALUES(longitude),
           status = VALUES(status),
           owner_id = VALUES(owner_id),
           metadata = VALUES(metadata),
           updated_at = VALUES(updated_at)`,
        [
          row.id,
          row.organization_id,
          row.source,
          row.source_id,
          row.name,
          row.category,
          row.address,
          row.city,
          row.region,
          row.country,
          row.phone,
          row.website,
          row.latitude,
          row.longitude,
          row.status,
          row.owner_id,
          row.metadata,
          row.created_at,
          row.updated_at,
        ],
      );
      return row;
    },

    async listLeadNotes(organizationId, leadId) {
      const [rows] = await pool.execute(
        `SELECT * FROM wf_lead_notes WHERE organization_id = ? AND lead_id = ? ORDER BY created_at DESC, id ASC`,
        [String(organizationId), String(leadId)],
      );
      return rows.map(normalizeLeadNoteRow);
    },

    async createLeadNote(note) {
      const row = normalizeLeadNoteRow(note);
      await pool.execute(
        `INSERT INTO wf_lead_notes (id, lead_id, organization_id, author_id, body, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [row.id, row.lead_id, row.organization_id, row.author_id, row.body, row.created_at],
      );
      return row;
    },

    async listLeadActivities(organizationId, leadId) {
      const [rows] = await pool.execute(
        `SELECT * FROM wf_lead_activities WHERE organization_id = ? AND lead_id = ? ORDER BY created_at DESC, id ASC`,
        [String(organizationId), String(leadId)],
      );
      return rows.map(normalizeLeadActivityRow);
    },

    async recordLeadActivity(activity) {
      const row = normalizeLeadActivityRow(activity);
      await pool.execute(
        `INSERT INTO wf_lead_activities (id, lead_id, organization_id, actor_id, type, detail, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [row.id, row.lead_id, row.organization_id, row.actor_id, row.type, row.detail, row.created_at],
      );
      return row;
    },

    async listLeadCollections(organizationId) {
      const [rows] = await pool.execute(
        `SELECT c.*, COUNT(cl.lead_id) AS leadCount
           FROM wf_lead_collections c
           LEFT JOIN wf_lead_collection_leads cl ON cl.collection_id = c.id
          WHERE c.organization_id = ?
          GROUP BY c.id
          ORDER BY c.name ASC, c.id ASC`,
        [String(organizationId)],
      );
      return rows.map(normalizeLeadCollectionRow);
    },

    async findLeadCollection(organizationId, collectionId) {
      const [rows] = await pool.execute(
        `SELECT c.*, COUNT(cl.lead_id) AS leadCount
           FROM wf_lead_collections c
           LEFT JOIN wf_lead_collection_leads cl ON cl.collection_id = c.id
          WHERE c.id = ? AND c.organization_id = ?
          GROUP BY c.id
          LIMIT 1`,
        [String(collectionId), String(organizationId)],
      );
      return normalizeLeadCollectionRow(rows[0] || null);
    },

    async saveLeadCollection(collection) {
      const row = {
        id: String(collection.id),
        organization_id: String(collection.organization_id),
        name: String(collection.name),
        created_at: String(collection.created_at),
        updated_at: String(collection.updated_at),
      };
      await pool.execute(
        `INSERT INTO wf_lead_collections (id, organization_id, name, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE name = VALUES(name), updated_at = VALUES(updated_at)`,
        [row.id, row.organization_id, row.name, row.created_at, row.updated_at],
      );
      return row;
    },

    async deleteLeadCollection(organizationId, collectionId) {
      await pool.execute(`DELETE FROM wf_lead_collection_leads WHERE collection_id = ?`, [String(collectionId)]);
      const [result] = await pool.execute(
        `DELETE FROM wf_lead_collections WHERE id = ? AND organization_id = ?`,
        [String(collectionId), String(organizationId)],
      );
      return Number(result?.affectedRows ?? 0) > 0;
    },

    async listCollectionLeads(organizationId, collectionId) {
      const [rows] = await pool.execute(
        `SELECT l.*
           FROM wf_leads l
           JOIN wf_lead_collection_leads cl ON cl.lead_id = l.id
          WHERE cl.collection_id = ? AND l.organization_id = ?
          ORDER BY l.updated_at DESC, l.id ASC`,
        [String(collectionId), String(organizationId)],
      );
      return rows.map(normalizeLeadRow);
    },

    async setCollectionLeadMembership({ collectionId, leadId, member }) {
      const cid = String(collectionId);
      const lid = String(leadId);
      if (member) {
        const [existing] = await pool.execute(
          `SELECT 1 FROM wf_lead_collection_leads WHERE collection_id = ? AND lead_id = ? LIMIT 1`,
          [cid, lid],
        );
        if (existing.length > 0) return { changed: false };
        await pool.execute(
          `INSERT INTO wf_lead_collection_leads (collection_id, lead_id) VALUES (?, ?)`,
          [cid, lid],
        );
        return { changed: true };
      }
      const [result] = await pool.execute(
        `DELETE FROM wf_lead_collection_leads WHERE collection_id = ? AND lead_id = ?`,
        [cid, lid],
      );
      return { changed: Number(result?.affectedRows ?? 0) > 0 };
    },

    async listLeadDuplicateCandidates(organizationId, { status = "open" } = {}) {
      const [rows] = await pool.execute(
        `SELECT d.*, a.name AS leadAName, b.name AS leadBName
           FROM wf_lead_duplicate_candidates d
           JOIN wf_leads a ON a.id = d.lead_a_id AND a.organization_id = d.organization_id
           JOIN wf_leads b ON b.id = d.lead_b_id AND b.organization_id = d.organization_id
          WHERE d.organization_id = ? AND d.status = ?
          ORDER BY d.created_at DESC, d.id ASC`,
        [String(organizationId), String(status)],
      );
      return rows.map(normalizeLeadDuplicateCandidateRow);
    },

    async saveLeadDuplicateCandidate(candidate) {
      const row = normalizeLeadDuplicateCandidateRow(candidate);
      const [existing] = await pool.execute(
        `SELECT * FROM wf_lead_duplicate_candidates
          WHERE organization_id = ? AND lead_a_id = ? AND lead_b_id = ? AND rule_name = ? AND status = 'open'
          LIMIT 1`,
        [row.organization_id, row.lead_a_id, row.lead_b_id, row.rule_name],
      );
      if (existing.length > 0) {
        return { created: false, candidate: normalizeLeadDuplicateCandidateRow(existing[0]) };
      }
      await pool.execute(
        `INSERT INTO wf_lead_duplicate_candidates
          (id, organization_id, lead_a_id, lead_b_id, rule_name, confidence, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [row.id, row.organization_id, row.lead_a_id, row.lead_b_id, row.rule_name, row.confidence, row.status, row.created_at],
      );
      return { created: true, candidate: row };
    },

    async resolveLeadDuplicateCandidate({ organizationId, candidateId, resolution }) {
      const [result] = await pool.execute(
        `UPDATE wf_lead_duplicate_candidates SET status = 'resolved' WHERE id = ? AND organization_id = ?`,
        [String(candidateId), String(organizationId)],
      );
      await pool.execute(
        `INSERT INTO wf_lead_duplicate_resolutions (id, candidate_id, organization_id, resolver_id, action, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          String(resolution.id),
          String(candidateId),
          String(organizationId),
          Number(resolution.resolver_id),
          String(resolution.action),
          String(resolution.created_at),
        ],
      );
      return Number(result?.affectedRows ?? 0) > 0;
    },

    async recordLeadSearchHistory(entry) {
      const row = normalizeLeadSearchHistoryRow(entry);
      await pool.execute(
        `INSERT INTO wf_lead_search_history
          (id, organization_id, user_id, query, provider, filters, results_returned,
           new_leads_created, duplicates_detected, errors, duration_ms, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          row.id,
          row.organization_id,
          row.user_id,
          row.query,
          row.provider,
          row.filters,
          row.results_returned,
          row.new_leads_created,
          row.duplicates_detected,
          row.errors,
          row.duration_ms,
          row.created_at,
        ],
      );
      return row;
    },

    async listLeadSearchHistory(organizationId, limit = 100) {
      const bounded = Math.min(Math.max(Number(limit) || 100, 1), 250);
      const [rows] = await pool.query(
        `SELECT * FROM wf_lead_search_history WHERE organization_id = ? ORDER BY created_at DESC, id ASC LIMIT ${bounded}`,
        [String(organizationId)],
      );
      return rows.map(normalizeLeadSearchHistoryRow);
    },

    async recordLeadExportHistory(entry) {
      const row = normalizeLeadExportHistoryRow(entry);
      await pool.execute(
        `INSERT INTO wf_lead_export_history
          (id, organization_id, user_id, format, filters, lead_count, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [row.id, row.organization_id, row.user_id, row.format, row.filters, row.lead_count, row.created_at],
      );
      return row;
    },
  };
}
