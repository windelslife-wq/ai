/**
 * Lead Discovery module contracts and constants (row 17 — Phase 45).
 *
 * Mirrors `application/controllers/Api_lead_discovery.php` and `application/views/leads/index.php`.
 */

export const LEAD_PERMISSION = "system.authenticated";

export const LEAD_STATUSES = Object.freeze([
  "new",
  "contacted",
  "qualified",
  "disqualified",
  "converted",
]);

export const DUPLICATE_ACTIONS = Object.freeze([
  "keep_a",
  "keep_b",
  "merge",
  "ignore",
]);

export const COVERAGE_FIELDS = Object.freeze([
  Object.freeze({ key: "name", label: "Business Name" }),
  Object.freeze({ key: "address", label: "Address" }),
  Object.freeze({ key: "category", label: "Category" }),
  Object.freeze({ key: "phone", label: "Phone" }),
  Object.freeze({ key: "website", label: "Website" }),
]);

export const CSV_EXPORT_COLUMNS = Object.freeze([
  "name",
  "category",
  "address",
  "city",
  "country",
  "phone",
  "website",
  "status",
]);

export const MERGEABLE_LEAD_FIELDS = Object.freeze([
  "category",
  "address",
  "city",
  "region",
  "country",
  "phone",
  "website",
  "latitude",
  "longitude",
]);

/**
 * CSV formula-injection guard (`Api_lead_discovery::safeCsv()`).
 * Any string beginning with `=`, `+`, `-`, or `@` is prefixed with a single quote `'`.
 */
export function safeCsvValue(value) {
  const str = String(value ?? "");
  return /^[=+\-@]/.test(str) ? `'${str}` : str;
}

export const ID_PARAMS = {
  id: { type: "string", minLength: 1, maxLength: 80 },
};

export const COLLECTION_LEAD_PARAMS = {
  id: { type: "string", minLength: 1, maxLength: 80 },
  leadId: { type: "string", minLength: 1, maxLength: 80 },
};

export const LEADS_QUERY = {
  status: { type: "string", minLength: 1, maxLength: 40 },
};

export const COVERAGE_QUERY = {
  missing: { type: "string", maxLength: 40 },
};

export const EMPTY_BODY = {
  type: "object",
  additionalProperties: true,
};
