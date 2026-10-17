/**
 * Lead Discovery console logic (row 17 — Phase 45).
 *
 * Plain ESM with no JSX or browser globals so `test/client_leads_console.test.js`
 * can import it directly and verify vocabulary parity against
 * `src/modules/leads/contracts.js` and `application/views/leads/index.php`.
 */

export const LEADS_PERMISSION = "system.authenticated";

export const LEADS_COPY = Object.freeze({
  eyebrow: "Business Lead Discovery",
  heading: "Lead Discovery & Qualification",
  lede: "Discover real public business records, organize collections, review duplicate candidates, and manage your qualification pipeline without synthetic data.",
  noSyntheticRule: "Strict real-data policy: when Google Places is unconfigured or unavailable, searches fail closed with HTTP 503 and never fabricate business leads.",
  searchPlaceholder: "e.g. specialty coffee roasters in Brussels",
  emptyLeads: "No leads saved in this workspace yet. Run a real-provider discovery search when Google Places is configured.",
  emptyCollections: "No collections in this workspace yet.",
  emptyDuplicates: "No open duplicate candidates require review.",
  emptyHistory: "No discovery searches recorded in this workspace yet.",
  emptyNotes: "No notes recorded for this lead yet.",
  emptyActivity: "No activity recorded for this lead yet.",
});

export const LEADS_TABS = Object.freeze([
  Object.freeze({ id: "discovery", label: "Discovery Search" }),
  Object.freeze({ id: "leads", label: "Saved Leads" }),
  Object.freeze({ id: "pipeline", label: "Pipeline Board" }),
  Object.freeze({ id: "collections", label: "Collections" }),
  Object.freeze({ id: "duplicates", label: "Duplicate Review" }),
  Object.freeze({ id: "coverage", label: "Data Coverage" }),
  Object.freeze({ id: "history", label: "Search History" }),
]);

export const LEAD_STATUS_OPTIONS = Object.freeze([
  "new",
  "contacted",
  "qualified",
  "disqualified",
  "converted",
]);

export const DUPLICATE_RESOLUTION_ACTIONS = Object.freeze([
  Object.freeze({ action: "merge", label: "Merge into A" }),
  Object.freeze({ action: "keep_a", label: "Keep A" }),
  Object.freeze({ action: "keep_b", label: "Keep B" }),
  Object.freeze({ action: "ignore", label: "Ignore" }),
]);

export const COVERAGE_FIELD_KEYS = Object.freeze([
  "name",
  "address",
  "category",
  "phone",
  "website",
]);

export const LEADS_READS = Object.freeze([
  Object.freeze({ key: "workspaces", path: "/api/v1/lead-discovery/workspaces", permission: LEADS_PERMISSION }),
  Object.freeze({ key: "providers", path: "/api/v1/lead-discovery/providers", permission: LEADS_PERMISSION }),
  Object.freeze({ key: "leads", path: "/api/v1/lead-discovery/leads", permission: LEADS_PERMISSION }),
  Object.freeze({ key: "collections", path: "/api/v1/lead-discovery/collections", permission: LEADS_PERMISSION }),
  Object.freeze({ key: "duplicates", path: "/api/v1/lead-discovery/duplicates", permission: LEADS_PERMISSION }),
  Object.freeze({ key: "coverage", path: "/api/v1/lead-discovery/coverage", permission: LEADS_PERMISSION }),
  Object.freeze({ key: "history", path: "/api/v1/lead-discovery/history", permission: LEADS_PERMISSION }),
  Object.freeze({ key: "pipeline", path: "/api/v1/lead-discovery/pipeline", permission: LEADS_PERMISSION }),
  Object.freeze({ key: "summary", path: "/api/v1/lead-discovery/summary", permission: LEADS_PERMISSION }),
]);

export function validateLeadSearchQuery(query) {
  const trimmed = String(query ?? "").trim();
  if (trimmed.length < 3 || trimmed.length > 300) {
    return "query must be 3–300 characters";
  }
  return null;
}

export function validateCollectionName(name) {
  const trimmed = String(name ?? "").trim();
  if (!trimmed || trimmed.length > 150) {
    return "name must be 1–150 characters";
  }
  return null;
}

export function validateLeadNoteBody(body) {
  const trimmed = String(body ?? "").trim();
  if (!trimmed || trimmed.length > 4000) {
    return "note must be 1–4000 characters";
  }
  return null;
}

export function formatProviderBadge(provider) {
  const status = String(provider?.status ?? "DISABLED");
  const tone = status === "IMPLEMENTED" ? "badge-green" : status === "PLANNED" ? "badge-amber" : "badge-gray";
  return {
    name: String(provider?.name ?? "google_places"),
    status,
    detail: String(provider?.detail ?? ""),
    tone,
  };
}

export function parseLeadMetadata(lead) {
  if (!lead?.metadata) return {};
  if (typeof lead.metadata === "object") return lead.metadata;
  try {
    return JSON.parse(String(lead.metadata)) || {};
  } catch {
    return {};
  }
}

export function buildExportPreviewSummary(preview) {
  const rows = Array.isArray(preview?.rows) ? preview.rows : [];
  return {
    count: Number(preview?.count ?? rows.length),
    previewCount: rows.length,
    csvSafe: preview?.csvSafe === true,
    rows,
  };
}
