-- Lead Discovery module (row 17 — Phase 45).
--
-- Ports the eleven organization-scoped tables from `application/database/schema.mysql.sql`
-- (`lead_organizations`, `lead_organization_members`, `leads`, `lead_notes`,
-- `lead_activities`, `collections`, `collection_leads`, `search_history`,
-- `duplicate_candidates`, `duplicate_resolutions`, `export_history`) under the
-- `wf_` prefix.
--
-- Organization isolation is enforced on every table (`organization_id`), and
-- provider source identity (`organization_id`, `source`, `source_id`) is unique
-- per organization so the same business in two tenants never collides while
-- re-searching in the same tenant refreshes the existing lead row.
--
-- Additive only. No foreign keys, so the file adapter and MySQL adapter share the
-- identical repository contract.

CREATE TABLE IF NOT EXISTS wf_lead_organizations (
  id VARCHAR(80) PRIMARY KEY,
  name VARCHAR(160) NOT NULL,
  created_at VARCHAR(32) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS wf_lead_organization_members (
  organization_id VARCHAR(80) NOT NULL,
  user_id BIGINT UNSIGNED NOT NULL,
  role VARCHAR(20) NOT NULL DEFAULT 'member',
  created_at VARCHAR(32) NOT NULL,
  PRIMARY KEY (organization_id, user_id),
  KEY idx_wf_lead_org_members_user (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS wf_leads (
  id VARCHAR(36) PRIMARY KEY,
  organization_id VARCHAR(80) NOT NULL,
  source VARCHAR(40) NOT NULL,
  source_id VARCHAR(255) NOT NULL,
  name VARCHAR(255) NOT NULL,
  category VARCHAR(255) NULL,
  address TEXT NULL,
  city VARCHAR(120) NULL,
  region VARCHAR(120) NULL,
  country VARCHAR(120) NULL,
  phone VARCHAR(80) NULL,
  website TEXT NULL,
  latitude DECIMAL(10,7) NULL,
  longitude DECIMAL(10,7) NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'new',
  owner_id BIGINT UNSIGNED NULL,
  metadata LONGTEXT NOT NULL,
  created_at VARCHAR(32) NOT NULL,
  updated_at VARCHAR(32) NOT NULL,
  UNIQUE KEY uq_wf_lead_source (organization_id, source, source_id),
  KEY idx_wf_leads_org_status (organization_id, status),
  KEY idx_wf_leads_owner (organization_id, owner_id),
  KEY idx_wf_leads_created (organization_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS wf_lead_notes (
  id VARCHAR(36) PRIMARY KEY,
  lead_id VARCHAR(36) NOT NULL,
  organization_id VARCHAR(80) NOT NULL,
  author_id BIGINT UNSIGNED NOT NULL,
  body TEXT NOT NULL,
  created_at VARCHAR(32) NOT NULL,
  KEY idx_wf_lead_notes_lead (organization_id, lead_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS wf_lead_activities (
  id VARCHAR(36) PRIMARY KEY,
  lead_id VARCHAR(36) NULL,
  organization_id VARCHAR(80) NOT NULL,
  actor_id BIGINT UNSIGNED NULL,
  type VARCHAR(50) NOT NULL,
  detail LONGTEXT NOT NULL,
  created_at VARCHAR(32) NOT NULL,
  KEY idx_wf_lead_activity_lead (organization_id, lead_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS wf_lead_collections (
  id VARCHAR(36) PRIMARY KEY,
  organization_id VARCHAR(80) NOT NULL,
  name VARCHAR(150) NOT NULL,
  created_at VARCHAR(32) NOT NULL,
  updated_at VARCHAR(32) NOT NULL,
  UNIQUE KEY uq_wf_lead_collection (organization_id, name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS wf_lead_collection_leads (
  collection_id VARCHAR(36) NOT NULL,
  lead_id VARCHAR(36) NOT NULL,
  PRIMARY KEY (collection_id, lead_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS wf_lead_search_history (
  id VARCHAR(36) PRIMARY KEY,
  organization_id VARCHAR(80) NOT NULL,
  user_id BIGINT UNSIGNED NOT NULL,
  query TEXT NOT NULL,
  provider VARCHAR(40) NOT NULL,
  filters LONGTEXT NOT NULL,
  results_returned INT NOT NULL,
  new_leads_created INT NOT NULL,
  duplicates_detected INT NOT NULL,
  errors TEXT NULL,
  duration_ms INT NOT NULL,
  created_at VARCHAR(32) NOT NULL,
  KEY idx_wf_lead_history_org (organization_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS wf_lead_duplicate_candidates (
  id VARCHAR(36) PRIMARY KEY,
  organization_id VARCHAR(80) NOT NULL,
  lead_a_id VARCHAR(36) NOT NULL,
  lead_b_id VARCHAR(36) NOT NULL,
  rule_name VARCHAR(80) NOT NULL,
  confidence DECIMAL(4,3) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'open',
  created_at VARCHAR(32) NOT NULL,
  KEY idx_wf_lead_dup_org_status (organization_id, status, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS wf_lead_duplicate_resolutions (
  id VARCHAR(36) PRIMARY KEY,
  candidate_id VARCHAR(36) NOT NULL,
  organization_id VARCHAR(80) NOT NULL,
  resolver_id BIGINT UNSIGNED NOT NULL,
  action VARCHAR(30) NOT NULL,
  created_at VARCHAR(32) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS wf_lead_export_history (
  id VARCHAR(36) PRIMARY KEY,
  organization_id VARCHAR(80) NOT NULL,
  user_id BIGINT UNSIGNED NOT NULL,
  format VARCHAR(10) NOT NULL,
  filters LONGTEXT NOT NULL,
  lead_count INT NOT NULL,
  created_at VARCHAR(32) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
