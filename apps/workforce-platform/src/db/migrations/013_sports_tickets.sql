-- Sports Intelligence: tickets and the daily ticket run (row 14 of
-- docs/migration/UNFINISHED_MODULES.md, slice 4).
--
-- Three tables, the three that migration 012's header reserved for this slice:
--
--   tickets            -> one row per optimized combination the engine recorded
--   ticket_selections  -> one row per selection on a ticket, linked to its prediction
--   daily_tickets      -> one row per (run date, configuration version): the run's outcome
--
-- Still absent, and owed by slice 5: any settlement or result column, `sports_backtests`,
-- `sports_model_metrics`, and `sports_performance_snapshots`. A ticket here is a record of
-- what was proposed and who decided it. Whether it won is unknown until settlement exists.
--
-- A decision on a ticket is recorded here, and nothing else. There is no execution, paper,
-- order or broker table in this migration, and no column that could reach one. Nothing in
-- this slice can place a bet.
--
-- Referential integrity is by convention, as in migrations 011 and 012: there are no
-- foreign keys. A ticket selection points at a prediction by id, and the repository writes
-- both in one transaction.
--
-- Timestamps are VARCHAR(32) canonical UTC (`...Z`). Money-like and probability values are
-- DECIMAL. JSON is LONGTEXT.

CREATE TABLE IF NOT EXISTS wf_sports_tickets (
  -- Caller-visible id ('tkt_' + 16 hex), generated before the insert, as legacy does.
  id VARCHAR(40) NOT NULL PRIMARY KEY,
  model_version_id BIGINT UNSIGNED NULL,
  configuration_version INT UNSIGNED NOT NULL,
  total_odds DECIMAL(12,4) NOT NULL,
  selection_count INT UNSIGNED NOT NULL,
  -- The product of the selections' calibrated probabilities. Stored at 8 places, as legacy does.
  combined_probability DECIMAL(12,8) NOT NULL,
  -- The minimum selection confidence, NULL when no selection had a measured confidence.
  confidence DECIMAL(8,2) NULL,
  risk VARCHAR(8) NOT NULL,
  correlation VARCHAR(8) NOT NULL,
  data_quality_score INT NOT NULL,
  -- PENDING until a person decides. Never APPROVED by the engine (DV-22).
  status VARCHAR(16) NOT NULL,
  approval_status VARCHAR(32) NOT NULL,
  settlement_status VARCHAR(16) NOT NULL,
  stake DECIMAL(14,2) NULL,
  reason VARCHAR(500) NULL,
  optimization_score DECIMAL(16,6) NOT NULL,
  pool_size INT UNSIGNED NOT NULL,
  decided_by VARCHAR(64) NULL,
  decided_at VARCHAR(32) NULL,
  created_at VARCHAR(32) NOT NULL,
  KEY ix_wf_sports_tickets_approval (approval_status, created_at),
  KEY ix_wf_sports_tickets_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS wf_sports_ticket_selections (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  ticket_id VARCHAR(40) NOT NULL,
  prediction_id VARCHAR(40) NOT NULL,
  match_id BIGINT UNSIGNED NOT NULL,
  market VARCHAR(40) NOT NULL,
  selection VARCHAR(40) NOT NULL,
  odds DECIMAL(10,4) NOT NULL,
  odds_timestamp VARCHAR(32) NULL,
  model_probability DECIMAL(10,6) NULL,
  calibrated_probability DECIMAL(10,6) NULL,
  expected_value DECIMAL(12,6) NOT NULL,
  risk VARCHAR(8) NOT NULL,
  -- NULL until settlement (slice 5) decides the selection.
  result VARCHAR(16) NULL,
  status VARCHAR(16) NOT NULL,
  -- The pairwise reasons that produced the ticket's correlation, as a JSON array.
  correlation_reasons LONGTEXT NOT NULL,
  KEY ix_wf_sports_ticket_selections_ticket (ticket_id),
  KEY ix_wf_sports_ticket_selections_prediction (prediction_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS wf_sports_daily_tickets (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  -- The UTC calendar day the run covers, YYYY-MM-DD.
  run_date VARCHAR(10) NOT NULL,
  configuration_version INT UNSIGNED NOT NULL,
  -- RUNNING while work is in progress, then NO_QUALIFIED_TICKET or
  -- PENDING_USER_APPROVAL. A run that throws is NO_QUALIFIED_TICKET, with the error in the
  -- message (DV-23, as legacy). DUPLICATE_SKIPPED is never stored: a second request
  -- for the same day and version finds this row and reports the skip.
  status VARCHAR(32) NOT NULL,
  ticket_id VARCHAR(40) NULL,
  fixtures_read INT UNSIGNED NOT NULL DEFAULT 0,
  candidates_evaluated INT UNSIGNED NOT NULL DEFAULT 0,
  predictions_recorded INT UNSIGNED NOT NULL DEFAULT 0,
  rejections INT UNSIGNED NOT NULL DEFAULT 0,
  -- Qualified candidates excluded from the ticket pool because they are simulated (DV-20).
  simulated_refused INT UNSIGNED NOT NULL DEFAULT 0,
  rejection_summary LONGTEXT NOT NULL,
  message VARCHAR(500) NOT NULL,
  errors LONGTEXT NOT NULL,
  requested_by VARCHAR(64) NULL,
  created_at VARCHAR(32) NOT NULL,
  updated_at VARCHAR(32) NOT NULL,
  -- One run per day and configuration version. The claim is an insert on this key, and a
  -- second writer that loses it is told the run already exists (legacy's `startJobRun`).
  UNIQUE KEY uq_wf_sports_daily_tickets_run (run_date, configuration_version),
  KEY ix_wf_sports_daily_tickets_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
