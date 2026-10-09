-- Public-site contact intake (Phase 3).
--
-- The legacy application stored a contact submission only as an audit entry
-- (`Site::contact_submit` emits CONTACT_INQUIRY). That is enough to prove a message
-- arrived and not enough to work a queue: no read/unread state, no assignee, no
-- indexing by date. This table is the working copy; the audit entry is still written
-- alongside it, so the trail keeps its actor-attributed record.
--
-- Additive only: nothing here alters an existing table.
CREATE TABLE IF NOT EXISTS wf_contact_inquiries (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  reference CHAR(26) NOT NULL,
  name VARCHAR(120) NOT NULL,
  email VARCHAR(190) NOT NULL,
  message VARCHAR(2000) NOT NULL,
  -- HMAC-SHA256 of the client address, keyed with SESSION_SECRET. A raw IP next to
  -- a name and an email address is more personal data than abuse review needs.
  client_fingerprint CHAR(64) NOT NULL,
  user_agent VARCHAR(254) NULL,
  request_id CHAR(36) NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'new',
  handled_by BIGINT UNSIGNED NULL,
  handled_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL,
  UNIQUE KEY uq_wf_contact_inquiries_reference (reference),
  KEY ix_wf_contact_inquiries_created (created_at),
  KEY ix_wf_contact_inquiries_status (status, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
