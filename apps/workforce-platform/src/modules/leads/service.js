/**
 * Lead Discovery service (row 17 — Phase 45).
 *
 * Ports `application/controllers/Api_lead_discovery.php` across both the file
 * adapter and MySQL adapter (`src/db/lead-repository.js`):
 * - Organization-scoped workspace provisioning and membership verification
 * - Pluggable provider registry (`GooglePlacesProvider`, disabled by default when
 *   `GOOGLE_PLACES_API_KEY` is unconfigured; never fabricates business rows)
 * - Conservative secondary duplicate detection (`Deduplicator`)
 * - Collections, pipeline stages, owner assignment, notes, activity trail,
 *   data coverage, search history, and CSV-safe export
 */

import { randomBytes, timingSafeEqual } from "node:crypto";
import { AppError } from "../../http/errors.js";
import {
  COVERAGE_FIELDS,
  CSV_EXPORT_COLUMNS,
  DUPLICATE_ACTIONS,
  LEAD_STATUSES,
  MERGEABLE_LEAD_FIELDS,
  safeCsvValue,
} from "./contracts.js";
import { detectLeadDuplicates } from "./deduplicator.js";
import {
  ProviderException,
  createGooglePlacesProvider,
  createLeadProviderRegistry,
} from "./providers.js";

function constantTimeEquals(a, b) {
  const left = Buffer.from(String(a ?? ""), "utf8");
  const right = Buffer.from(String(b ?? ""), "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function createLeadDiscoveryService({
  config = {},
  store = null,
  transport = null,
  now = () => Date.now(),
} = {}) {
  const settings = config?.leads ?? {};
  const googleProvider = createGooglePlacesProvider({
    apiKey: settings.googlePlacesApiKey ?? "",
    timeoutSeconds: settings.googlePlacesTimeoutSeconds ?? 12,
    transport,
  });
  const registry = createLeadProviderRegistry([googleProvider]);

  function requireStore() {
    if (!store) {
      throw AppError.unavailable("Lead discovery persistence is not available on this host", {
        code: "LEADS_PERSISTENCE_UNAVAILABLE",
      });
    }
    return store;
  }

  function nowIso() {
    return new Date(now()).toISOString();
  }

  function newId() {
    return randomBytes(16).toString("hex");
  }

  /**
   * Resolve the active organization workspace solely from the authenticated
   * user's memberships (`Api_lead_discovery::guard()`).
   * First authenticated use auto-provisions `org-<userId>` as `owner`.
   */
  async function resolveWorkspace(user, requestedOrgId = "") {
    const repository = requireStore();
    const userId = Number(user?.id);
    if (!Number.isInteger(userId) || userId <= 0) {
      throw AppError.unauthorized("Authentication required");
    }
    let memberships = await repository.listLeadWorkspaces(userId);
    if (!memberships.length) {
      const created = await repository.ensureLeadWorkspace({
        userId,
        email: user?.email ?? "My",
        organizationId: `org-${userId}`,
        role: "owner",
        nowIso: nowIso(),
      });
      memberships = [created];
    }
    const requested = String(requestedOrgId ?? "").trim();
    const chosen = requested || String(memberships[0].id);
    const matched = memberships.find((m) => constantTimeEquals(m.id, chosen));
    if (!matched) {
      throw AppError.forbidden("forbidden organization workspace");
    }
    return { organizationId: String(matched.id), workspaces: memberships };
  }

  async function recordActivity(organizationId, actorId, leadId, type, detail = {}) {
    return requireStore().recordLeadActivity({
      id: newId(),
      lead_id: leadId,
      organization_id: organizationId,
      actor_id: actorId,
      type,
      detail: JSON.stringify(detail ?? {}),
      created_at: nowIso(),
    });
  }

  async function workspaces(user, requestedOrgId = "") {
    const { organizationId, workspaces: rows } = await resolveWorkspace(user, requestedOrgId);
    return {
      workspaces: rows.map((row) => ({ id: row.id, name: row.name, role: row.role })),
      activeOrganizationId: organizationId,
    };
  }

  async function providers(user, requestedOrgId = "") {
    await resolveWorkspace(user, requestedOrgId);
    return { providers: registry.health() };
  }

  async function search(user, body = {}, requestedOrgId = "") {
    const { organizationId } = await resolveWorkspace(user, requestedOrgId);
    const repository = requireStore();
    const query = String(body?.query ?? "").trim();
    if (query.length < 3 || query.length > 300) {
      throw AppError.badRequest("query must be 3–300 characters");
    }
    const started = now();
    const providerName = String(body?.provider ?? "google_places");
    const limit = body?.limit ?? 20;
    let errorMessage = null;
    let raw = [];
    let providerStatus = "DISABLED";
    try {
      const provider = registry.get(providerName);
      providerStatus = provider.healthCheck().status;
      raw = await provider.searchBusinesses({ query, limit });
    } catch (error) {
      if (error instanceof ProviderException) {
        errorMessage = error.message;
        providerStatus = error.httpStatus === 422 ? "PLANNED" : "DISABLED";
      } else {
        errorMessage = String(error?.message || "Lead search failed");
        providerStatus = "DISABLED";
      }
    }

    let newCount = 0;
    let dupes = 0;
    let candidateCount = 0;
    const results = [];
    for (const p of raw) {
      const sid = String(p.sourceId);
      const existing = await repository.findLeadBySource(organizationId, providerName, sid);
      const at = nowIso();
      let record = {
        id: existing ? String(existing.id) : newId(),
        organization_id: organizationId,
        source: providerName,
        source_id: sid,
        name: p.name,
        category: p.category ?? null,
        address: p.address ?? null,
        city: existing?.city ?? null,
        region: existing?.region ?? null,
        country: existing?.country ?? null,
        phone: p.phone ?? null,
        website: p.website ?? null,
        latitude: p.latitude ?? null,
        longitude: p.longitude ?? null,
        status: existing ? String(existing.status) : "new",
        owner_id: existing ? existing.owner_id ?? null : null,
        metadata: JSON.stringify(p.metadata ?? {}),
        created_at: existing ? String(existing.created_at) : at,
        updated_at: at,
      };
      record = await repository.saveLead(record);
      if (existing) {
        dupes += 1;
        await recordActivity(organizationId, Number(user.id), record.id, "DUPLICATE_DETECTED", {
          rule: "provider_source_id",
        });
      } else {
        newCount += 1;
        await recordActivity(organizationId, Number(user.id), record.id, "LEAD_DISCOVERED", {
          query,
          provider: providerName,
        });
      }
      candidateCount += await detectLeadDuplicates(repository, record, organizationId, {
        nowIso,
        newId,
      });
      results.push(record);
    }

    await repository.recordLeadSearchHistory({
      id: newId(),
      organization_id: organizationId,
      user_id: Number(user.id),
      query,
      provider: providerName,
      filters: JSON.stringify({ limit }),
      results_returned: raw.length,
      new_leads_created: newCount,
      duplicates_detected: dupes + candidateCount,
      errors: errorMessage,
      duration_ms: Math.max(0, Math.trunc(now() - started)),
      created_at: nowIso(),
    });

    if (errorMessage) {
      throw AppError.unavailable(errorMessage, {
        code: "LEAD_PROVIDER_UNAVAILABLE",
        details: { providerStatus },
      });
    }

    return {
      provider: providerName,
      providerStatus,
      results,
      newLeadsCreated: newCount,
      duplicatesDetected: dupes + candidateCount,
      duplicateCandidatesCreated: candidateCount,
    };
  }

  async function listLeads(user, { status = null } = {}, requestedOrgId = "") {
    const { organizationId } = await resolveWorkspace(user, requestedOrgId);
    const leads = await requireStore().listLeads(organizationId, {
      status: status ? String(status) : null,
      limit: 250,
    });
    return { leads };
  }

  async function getLead(user, id, requestedOrgId = "") {
    const { organizationId } = await resolveWorkspace(user, requestedOrgId);
    const lead = await requireStore().findLeadById(organizationId, String(id));
    if (!lead) throw AppError.notFound("lead not found");
    return lead;
  }

  async function listCollections(user, requestedOrgId = "") {
    const { organizationId } = await resolveWorkspace(user, requestedOrgId);
    const collections = await requireStore().listLeadCollections(organizationId);
    return { collections };
  }

  async function createCollection(user, body = {}, requestedOrgId = "") {
    const { organizationId } = await resolveWorkspace(user, requestedOrgId);
    const name = String(body?.name ?? "").trim();
    if (!name || name.length > 150) {
      throw AppError.badRequest("name must be 1–150 characters");
    }
    const at = nowIso();
    const record = await requireStore().saveLeadCollection({
      id: newId(),
      organization_id: organizationId,
      name,
      created_at: at,
      updated_at: at,
    });
    return record;
  }

  async function updateCollection(user, id, body = {}, requestedOrgId = "") {
    const { organizationId } = await resolveWorkspace(user, requestedOrgId);
    const name = String(body?.name ?? "").trim();
    if (!name || name.length > 150) {
      throw AppError.badRequest("name must be 1–150 characters");
    }
    const existing = await requireStore().findLeadCollection(organizationId, String(id));
    if (existing) {
      await requireStore().saveLeadCollection({
        ...existing,
        name,
        updated_at: nowIso(),
      });
    }
    return { ok: true };
  }

  async function deleteCollection(user, id, requestedOrgId = "") {
    const { organizationId } = await resolveWorkspace(user, requestedOrgId);
    await requireStore().deleteLeadCollection(organizationId, String(id));
    return { ok: true };
  }

  async function listCollectionLeads(user, collectionId, requestedOrgId = "") {
    const { organizationId } = await resolveWorkspace(user, requestedOrgId);
    const repository = requireStore();
    const collection = await repository.findLeadCollection(organizationId, String(collectionId));
    if (!collection) throw AppError.notFound("collection not found");
    const leads = await repository.listCollectionLeads(organizationId, String(collectionId));
    return { leads };
  }

  async function mutateCollectionLeads(user, collectionId, { leadId = null, body = {}, remove = false } = {}, requestedOrgId = "") {
    const { organizationId } = await resolveWorkspace(user, requestedOrgId);
    const repository = requireStore();
    const collection = await repository.findLeadCollection(organizationId, String(collectionId));
    if (!collection) throw AppError.notFound("collection not found");
    const ids = leadId ? [leadId] : body?.leadIds;
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > 200) {
      throw AppError.badRequest("leadIds must contain 1–200 leads");
    }
    let added = 0;
    let removed = 0;
    const uniqueIds = [...new Set(ids.map((item) => String(item)))];
    for (const lid of uniqueIds) {
      const lead = await repository.findLeadById(organizationId, lid);
      if (!lead) {
        throw AppError.notFound("lead not found", { details: { leadId: lid } });
      }
      if (remove) {
        const res = await repository.setCollectionLeadMembership({
          collectionId: String(collectionId),
          leadId: lid,
          member: false,
        });
        if (res.changed) removed += 1;
        await recordActivity(organizationId, Number(user.id), lid, "LEAD_REMOVED_FROM_COLLECTION", {
          collectionId: String(collectionId),
        });
      } else {
        const res = await repository.setCollectionLeadMembership({
          collectionId: String(collectionId),
          leadId: lid,
          member: true,
        });
        if (res.changed) {
          added += 1;
          await recordActivity(organizationId, Number(user.id), lid, "LEAD_ADDED_TO_COLLECTION", {
            collectionId: String(collectionId),
          });
        }
      }
    }
    return { ok: true, added, removed };
  }

  async function updateLeadStatus(user, id, body = {}, requestedOrgId = "") {
    const { organizationId } = await resolveWorkspace(user, requestedOrgId);
    const repository = requireStore();
    const lead = await repository.findLeadById(organizationId, String(id));
    if (!lead) throw AppError.notFound("lead not found");
    const status = String(body?.status ?? "");
    if (!LEAD_STATUSES.includes(status)) {
      throw AppError.badRequest("invalid status");
    }
    await repository.saveLead({
      ...lead,
      status,
      updated_at: nowIso(),
    });
    await recordActivity(organizationId, Number(user.id), String(id), "STATUS_CHANGED", {
      from: lead.status,
      to: status,
    });
    return { ok: true };
  }

  async function updateLeadOwner(user, id, body = {}, requestedOrgId = "") {
    const { organizationId } = await resolveWorkspace(user, requestedOrgId);
    const repository = requireStore();
    const lead = await repository.findLeadById(organizationId, String(id));
    if (!lead) throw AppError.notFound("lead not found");
    const rawOwner = body?.ownerId === undefined ? null : body.ownerId;
    if (rawOwner !== null && !/^\d+$/.test(String(rawOwner))) {
      throw AppError.badRequest("ownerId must be an integer or null");
    }
    const ownerId = rawOwner === null ? null : Number(rawOwner);
    await repository.saveLead({
      ...lead,
      owner_id: ownerId,
      updated_at: nowIso(),
    });
    await recordActivity(
      organizationId,
      Number(user.id),
      String(id),
      ownerId === null ? "OWNER_REMOVED" : "OWNER_ASSIGNED",
      { ownerId },
    );
    return { ok: true };
  }

  async function listNotes(user, id, requestedOrgId = "") {
    const { organizationId } = await resolveWorkspace(user, requestedOrgId);
    const repository = requireStore();
    const lead = await repository.findLeadById(organizationId, String(id));
    if (!lead) throw AppError.notFound("lead not found");
    const notes = await repository.listLeadNotes(organizationId, String(id));
    return { notes };
  }

  async function addNote(user, id, body = {}, requestedOrgId = "") {
    const { organizationId } = await resolveWorkspace(user, requestedOrgId);
    const repository = requireStore();
    const lead = await repository.findLeadById(organizationId, String(id));
    if (!lead) throw AppError.notFound("lead not found");
    const text = String(body?.body ?? "").trim();
    if (!text || text.length > 4000) {
      throw AppError.badRequest("note must be 1–4000 characters");
    }
    const note = await repository.createLeadNote({
      id: newId(),
      lead_id: String(id),
      organization_id: organizationId,
      author_id: Number(user.id),
      body: text,
      created_at: nowIso(),
    });
    await recordActivity(organizationId, Number(user.id), String(id), "NOTE_ADDED", {});
    return note;
  }

  async function listActivity(user, id, requestedOrgId = "") {
    const { organizationId } = await resolveWorkspace(user, requestedOrgId);
    const repository = requireStore();
    const lead = await repository.findLeadById(organizationId, String(id));
    if (!lead) throw AppError.notFound("lead not found");
    const activity = await repository.listLeadActivities(organizationId, String(id));
    return { activity };
  }

  async function listDuplicates(user, requestedOrgId = "") {
    const { organizationId } = await resolveWorkspace(user, requestedOrgId);
    const duplicates = await requireStore().listLeadDuplicateCandidates(organizationId, {
      status: "open",
    });
    return { duplicates };
  }

  async function archiveDuplicate(organizationId, actorId, lead, keptId, reason) {
    const repository = requireStore();
    let metadata = {};
    try {
      metadata = JSON.parse(lead.metadata || "{}") || {};
    } catch {
      metadata = {};
    }
    const at = nowIso();
    metadata.duplicateResolution = { keptLeadId: keptId, reason, at };
    await repository.saveLead({
      ...lead,
      status: "disqualified",
      metadata: JSON.stringify(metadata),
      updated_at: at,
    });
    await recordActivity(organizationId, actorId, lead.id, "DUPLICATE_RESOLVED", {
      keptLeadId: keptId,
      action: reason,
    });
  }

  async function resolveDuplicate(user, body = {}, requestedOrgId = "") {
    const { organizationId } = await resolveWorkspace(user, requestedOrgId);
    const repository = requireStore();
    const candidateId = String(body?.candidateId ?? "");
    const action = String(body?.action ?? "");
    if (!DUPLICATE_ACTIONS.includes(action)) {
      throw AppError.badRequest("invalid duplicate resolution");
    }
    const candidates = await repository.listLeadDuplicateCandidates(organizationId, {
      status: "open",
    });
    const candidate = candidates.find((row) => String(row.id) === candidateId);
    if (!candidate) {
      throw AppError.notFound("duplicate candidate not found");
    }
    const a = await repository.findLeadById(organizationId, candidate.lead_a_id);
    const bLead = await repository.findLeadById(organizationId, candidate.lead_b_id);
    if (!a || !bLead) {
      throw AppError.conflict("candidate leads no longer exist");
    }
    const actorId = Number(user.id);
    if (action === "merge") {
      const canonical = { ...a };
      const duplicate = bLead;
      for (const field of MERGEABLE_LEAD_FIELDS) {
        if ((canonical[field] === null || canonical[field] === "" || canonical[field] === undefined) && duplicate[field]) {
          canonical[field] = duplicate[field];
        }
      }
      canonical.updated_at = nowIso();
      await repository.saveLead(canonical);
      await archiveDuplicate(organizationId, actorId, duplicate, canonical.id, "merged");
      await recordActivity(organizationId, actorId, canonical.id, "DUPLICATE_RESOLVED", {
        candidateId,
        action: "merge",
        mergedLeadId: duplicate.id,
      });
    } else if (action === "keep_a" || action === "keep_b") {
      const keep = action === "keep_a" ? a : bLead;
      const discard = action === "keep_a" ? bLead : a;
      await archiveDuplicate(organizationId, actorId, discard, keep.id, "discarded");
      await recordActivity(organizationId, actorId, keep.id, "DUPLICATE_RESOLVED", {
        candidateId,
        action,
        discardedLeadId: discard.id,
      });
    } else {
      await recordActivity(organizationId, actorId, a.id, "DUPLICATE_RESOLVED", {
        candidateId,
        action: "ignore",
      });
    }
    await repository.resolveLeadDuplicateCandidate({
      organizationId,
      candidateId,
      resolution: {
        id: newId(),
        resolver_id: actorId,
        action,
        created_at: nowIso(),
      },
    });
    return { ok: true };
  }

  async function coverage(user, { missing = "" } = {}, requestedOrgId = "") {
    const { organizationId } = await resolveWorkspace(user, requestedOrgId);
    const missingKey = String(missing ?? "").trim();
    if (missingKey !== "" && !COVERAGE_FIELDS.some((item) => item.key === missingKey)) {
      throw AppError.badRequest("invalid missing field");
    }
    const all = await requireStore().listLeads(organizationId, { limit: 10_000 });
    const n = all.length;
    const fields = COVERAGE_FIELDS.map(({ key, label }) => {
      const filled = all.filter((lead) => Boolean(lead[key])).length;
      return {
        key,
        field: label,
        coverage: n ? Math.round(((100 * filled) / n) * 10) / 10 : 0,
        missing: n - filled,
      };
    });
    const missingLeads = missingKey === "" ? [] : all.filter((lead) => !lead[missingKey]);
    return {
      leadCount: n,
      fields,
      missingField: missingKey || null,
      missingLeads,
    };
  }

  async function history(user, requestedOrgId = "") {
    const { organizationId } = await resolveWorkspace(user, requestedOrgId);
    const rows = await requireStore().listLeadSearchHistory(organizationId, 100);
    return { history: rows };
  }

  async function summary(user, requestedOrgId = "") {
    const { organizationId } = await resolveWorkspace(user, requestedOrgId);
    const all = await requireStore().listLeads(organizationId, { limit: 10_000 });
    const counts = new Map();
    for (const lead of all) {
      counts.set(lead.status, (counts.get(lead.status) || 0) + 1);
    }
    return {
      pipeline: [...counts.entries()].map(([status, total]) => ({ status, total })),
    };
  }

  async function pipeline(user, requestedOrgId = "") {
    const { organizationId } = await resolveWorkspace(user, requestedOrgId);
    const all = await requireStore().listLeads(organizationId, { limit: 10_000 });
    const columns = Object.fromEntries(LEAD_STATUSES.map((s) => [s, []]));
    for (const lead of all) {
      if (columns[lead.status]) columns[lead.status].push(lead);
    }
    return { statuses: [...LEAD_STATUSES], columns };
  }

  async function exportLeads(user, body = {}, { mode = "json" } = {}, requestedOrgId = "") {
    const { organizationId } = await resolveWorkspace(user, requestedOrgId);
    const repository = requireStore();
    let leads = body?.collectionId
      ? await repository.listCollectionLeads(organizationId, String(body.collectionId))
      : await repository.listLeads(organizationId, { limit: 10_000 });

    for (const field of ["status", "owner_id", "country", "category"]) {
      if (body?.[field] !== undefined && body?.[field] !== "") {
        leads = leads.filter((lead) => String(lead[field] ?? "") === String(body[field]));
      }
    }
    if (body?.from) {
      leads = leads.filter((lead) => String(lead.created_at) >= String(body.from));
    }
    if (body?.to) {
      leads = leads.filter((lead) => String(lead.created_at) <= String(body.to));
    }

    if (mode === "preview") {
      const rows = leads.slice(0, 25).map((lead) => {
        const copy = { ...lead };
        for (const [k, v] of Object.entries(copy)) {
          if (typeof v === "string") copy[k] = safeCsvValue(v);
        }
        return copy;
      });
      return { rows, count: leads.length, csvSafe: true };
    }

    const format = mode === "csv" ? "csv" : String(body?.format ?? "json");
    await repository.recordLeadExportHistory({
      id: newId(),
      organization_id: organizationId,
      user_id: Number(user.id),
      format,
      filters: JSON.stringify(body ?? {}),
      lead_count: leads.length,
      created_at: nowIso(),
    });
    for (const lead of leads) {
      await recordActivity(organizationId, Number(user.id), lead.id, "LEAD_EXPORTED", { format });
    }
    if (format === "csv") {
      const lines = [CSV_EXPORT_COLUMNS.join(",")];
      for (const lead of leads) {
        const cells = CSV_EXPORT_COLUMNS.map((key) => {
          const safe = safeCsvValue(String(lead[key] ?? ""));
          return `"${safe.replaceAll('"', '""')}"`;
        });
        lines.push(cells.join(","));
      }
      return {
        isCsv: true,
        csv: lines.join("\r\n"),
        count: leads.length,
      };
    }
    return { leads, count: leads.length };
  }

  function statusSnapshot() {
    const providerHealth = registry.health();
    return {
      enabled: true,
      organizationScoped: true,
      syntheticLeadsAllowed: false,
      providers: providerHealth,
      googlePlacesConfigured: providerHealth.some((p) => p.name === "google_places" && p.status === "IMPLEMENTED"),
    };
  }

  return Object.freeze({
    workspaces,
    providers,
    search,
    listLeads,
    getLead,
    listCollections,
    createCollection,
    updateCollection,
    deleteCollection,
    listCollectionLeads,
    mutateCollectionLeads,
    updateLeadStatus,
    updateLeadOwner,
    listNotes,
    addNote,
    listActivity,
    listDuplicates,
    resolveDuplicate,
    coverage,
    history,
    summary,
    pipeline,
    exportLeads,
    statusSnapshot,
  });
}
