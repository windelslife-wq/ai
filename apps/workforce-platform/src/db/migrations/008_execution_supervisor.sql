-- Paper-only Execution Supervisor proposal workflow (Phase 8A).
--
-- This schema deliberately stores no broker id, broker ticket or live execution
-- record. An approved proposal can be submitted only through the existing
-- owner-scoped Paper Trading service. No live-order endpoint is introduced.

CREATE TABLE IF NOT EXISTS wf_execution_proposals (
  proposal_id CHAR(36) NOT NULL PRIMARY KEY,
  owner_user_id BIGINT UNSIGNED NOT NULL,
  account_id BIGINT UNSIGNED NOT NULL,
  status VARCHAR(24) NOT NULL,
  intent_json LONGTEXT NOT NULL,
  checks_json LONGTEXT NOT NULL,
  result_json LONGTEXT NULL,
  decision_by_user_id BIGINT UNSIGNED NULL,
  decision_reason VARCHAR(1000) NULL,
  decided_at VARCHAR(32) NULL,
  paper_order_id BIGINT UNSIGNED NULL,
  created_at VARCHAR(32) NOT NULL,
  updated_at VARCHAR(32) NOT NULL,
  KEY ix_wf_execution_proposals_owner_status (owner_user_id, status, created_at),
  KEY ix_wf_execution_proposals_account (account_id, status, created_at),
  KEY ix_wf_execution_proposals_paper_order (paper_order_id),
  CONSTRAINT fk_wf_execution_proposals_owner
    FOREIGN KEY (owner_user_id) REFERENCES wf_users(id)
    ON DELETE RESTRICT,
  CONSTRAINT fk_wf_execution_proposals_account
    FOREIGN KEY (account_id) REFERENCES wf_paper_accounts(id)
    ON DELETE RESTRICT,
  CONSTRAINT fk_wf_execution_proposals_decider
    FOREIGN KEY (decision_by_user_id) REFERENCES wf_users(id)
    ON DELETE SET NULL,
  CONSTRAINT fk_wf_execution_proposals_paper_order
    FOREIGN KEY (paper_order_id) REFERENCES wf_paper_orders(id)
    ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
