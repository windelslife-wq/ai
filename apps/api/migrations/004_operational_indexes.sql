-- Operational indexes for organization-scoped lookups and race-safe duplicate review.
CREATE UNIQUE INDEX IF NOT EXISTS duplicate_candidates_identity_idx
  ON duplicate_candidates (organization_id, lead_a_id, lead_b_id, rule_name);
CREATE INDEX IF NOT EXISTS duplicate_candidates_org_status_idx
  ON duplicate_candidates (organization_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS search_history_org_created_idx
  ON search_history (organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS lead_activities_org_lead_created_idx
  ON lead_activities (organization_id, lead_id, created_at DESC);
CREATE INDEX IF NOT EXISTS lead_notes_org_lead_created_idx
  ON lead_notes (organization_id, lead_id, created_at DESC);
CREATE INDEX IF NOT EXISTS collection_leads_lead_idx
  ON collection_leads (lead_id);
