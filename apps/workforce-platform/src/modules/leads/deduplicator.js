/**
 * Conservative secondary duplicate detector for Lead Discovery (row 17).
 *
 * Ported 1:1 from `application/libraries/LeadDiscovery/Deduplicator.php`.
 * Creates `open` review candidates ordered lexicographically (`lead_a_id < lead_b_id`)
 * and never auto-merges leads.
 */

import { randomBytes } from "node:crypto";

export function normalizeWebsiteDomain(url) {
  if (!url) return null;
  const raw = String(url).trim();
  if (!raw) return null;
  try {
    const parsed = new URL(raw.includes("://") ? raw : `https://${raw}`);
    if (!parsed.hostname) return null;
    return parsed.hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

export function normalizePhoneDigits(phone) {
  if (!phone) return null;
  const digits = String(phone).replace(/\D+/g, "");
  return digits || null;
}

export function normalizeIdentityText(value) {
  return String(value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/**
 * Compare two lead records and return `[ruleName, confidence]`.
 *
 * Rules and confidences match `Deduplicator::match()` in PHP:
 * - `website_domain` -> `0.95`
 * - `normalized_phone` (7+ digits) -> `0.92`
 * - `name_address` -> `0.84`
 */
export function matchDuplicateLead(a, b) {
  const domainA = normalizeWebsiteDomain(a?.website ?? null);
  const domainB = normalizeWebsiteDomain(b?.website ?? null);
  if (domainA && domainA === domainB) return ["website_domain", 0.95];

  const phoneA = normalizePhoneDigits(a?.phone ?? null);
  const phoneB = normalizePhoneDigits(b?.phone ?? null);
  if (phoneA && phoneA.length >= 7 && phoneA === phoneB) return ["normalized_phone", 0.92];

  const identityA = `${normalizeIdentityText(a?.name ?? "")}|${normalizeIdentityText(a?.address ?? "")}`;
  const identityB = `${normalizeIdentityText(b?.name ?? "")}|${normalizeIdentityText(b?.address ?? "")}`;
  if (identityA !== "|" && identityA === identityB) return ["name_address", 0.84];

  return [null, 0.0];
}

export async function detectLeadDuplicates(store, lead, organizationId, { nowIso = () => new Date().toISOString(), newId = () => randomBytes(16).toString("hex") } = {}) {
  const rows = await store.listLeads(organizationId, { limit: 10_000 });
  let created = 0;
  for (const other of rows) {
    if (String(other.id) === String(lead.id)) continue;
    const [rule, confidence] = matchDuplicateLead(lead, other);
    if (!rule) continue;
    const a = String(lead.id).localeCompare(String(other.id)) < 0 ? String(lead.id) : String(other.id);
    const b = a === String(lead.id) ? String(other.id) : String(lead.id);
    const saved = await store.saveLeadDuplicateCandidate({
      id: newId(),
      organization_id: String(organizationId),
      lead_a_id: a,
      lead_b_id: b,
      rule_name: rule,
      confidence,
      status: "open",
      created_at: nowIso(),
    });
    if (saved.created) created += 1;
  }
  return created;
}
