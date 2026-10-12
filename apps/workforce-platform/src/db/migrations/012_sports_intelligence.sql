-- Sports Intelligence: the decision chain's storage (row 14 of docs/migration/UNFINISHED_MODULES.md, slice 3).
--
-- Four tables, the four that migration 011's header reserved for this slice:
--
--   model_versions  -> one row per (model, feature set, calibration) that produced a decision
--   predictions     -> one immutable row per evaluated candidate, qualified or rejected
--   configurations  -> append-only ticket-engine configuration, one row per version
--   calibrations    -> fitted Platt calibrations, PENDING until an administrator decides
--
-- Deliberately still absent, and owed by slices 4 and 5: `sports_tickets`,
-- `sports_ticket_selections`, `sports_daily_tickets`, `sports_backtests`,
-- `sports_model_metrics`, `sports_performance_snapshots`, `sports_job_runs`, and any
-- settlement or outcome column. A prediction here records a decision. It does not
-- record whether that decision was right, because nothing in this slice can know.
--
-- Immutability is enforced by the repository, not by the schema: there is no update
-- method for `predictions`, and the file adapter has no mutation path either. A
-- prediction is evidence of what was decided and with which inputs, and six months
-- later it must still say so.
--
-- Timestamps are VARCHAR(32) canonical UTC (`...Z`), as in migrations 007–011.
-- Money-like and probability values are DECIMAL; JSON is LONGTEXT, as in 011.

CREATE TABLE IF NOT EXISTS wf_sports_model_versions (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  model_name VARCHAR(80) NOT NULL,
  model_version VARCHAR(32) NOT NULL,
  feature_version VARCHAR(40) NOT NULL,
  -- '' rather than NULL: a UNIQUE key treats NULLs as distinct, so an absent calibration
  -- would let the same model version be registered twice. The mapper turns '' back into null.
  calibration_version VARCHAR(120) NOT NULL DEFAULT '',
  status VARCHAR(16) NOT NULL DEFAULT 'ACTIVE',
  created_at VARCHAR(32) NOT NULL,
  UNIQUE KEY uq_wf_sports_model_versions_identity (model_name, model_version, feature_version, calibration_version)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS wf_sports_predictions (
  -- Caller-visible id ('prd_' + 24 hex), generated before the insert, as legacy does.
  id VARCHAR(40) NOT NULL PRIMARY KEY,
  match_id BIGINT UNSIGNED NOT NULL,
  model_version_id BIGINT UNSIGNED NOT NULL,
  market VARCHAR(40) NOT NULL,
  selection VARCHAR(40) NOT NULL,
  raw_probability DECIMAL(9,6) NULL,
  calibrated_probability DECIMAL(9,6) NULL,
  implied_probability DECIMAL(9,6) NULL,
  expected_value DECIMAL(9,6) NULL,
  confidence DECIMAL(6,2) NULL,
  risk VARCHAR(16) NOT NULL,
  -- 'UNKNOWN' until a correlation engine runs (slice 4). Never a placeholder class.
  correlation VARCHAR(16) NOT NULL DEFAULT 'UNKNOWN',
  data_quality_score INT NOT NULL DEFAULT 0,
  decision VARCHAR(24) NOT NULL,
  rejection_reasons LONGTEXT NOT NULL,
  factors LONGTEXT NOT NULL,
  input_version VARCHAR(40) NOT NULL,
  odds DECIMAL(12,6) NULL,
  odds_timestamp VARCHAR(32) NULL,
  created_at VARCHAR(32) NOT NULL,
  KEY ix_wf_sports_predictions_match (match_id, created_at),
  KEY ix_wf_sports_predictions_model (model_version_id, created_at),
  KEY ix_wf_sports_predictions_decision (decision, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS wf_sports_configurations (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  -- Monotonic and unique. A second row with the same version is a concurrent writer
  -- that lost the race, and the repository reports it as null (mapped to 409).
  version INT UNSIGNED NOT NULL,
  module_enabled TINYINT(1) NOT NULL,
  ticket_engine_enabled TINYINT(1) NOT NULL,
  platform_mode VARCHAR(16) NOT NULL,
  engine_mode VARCHAR(32) NOT NULL,
  target_odds_min DECIMAL(8,3) NOT NULL,
  target_odds_max DECIMAL(8,3) NOT NULL,
  max_selections INT NOT NULL,
  risk_level VARCHAR(16) NOT NULL,
  min_confidence DECIMAL(6,2) NOT NULL,
  min_expected_value DECIMAL(9,6) NOT NULL,
  max_correlation VARCHAR(8) NOT NULL,
  min_data_quality INT NOT NULL,
  min_liquidity DECIMAL(14,2) NULL,
  allowed_markets LONGTEXT NOT NULL,
  allowed_leagues LONGTEXT NOT NULL,
  max_exposure DECIMAL(14,2) NOT NULL,
  stake_amount DECIMAL(14,2) NOT NULL,
  void_policy VARCHAR(24) NOT NULL,
  require_calibration TINYINT(1) NOT NULL,
  updated_by VARCHAR(64) NOT NULL,
  reason VARCHAR(500) NOT NULL,
  created_at VARCHAR(32) NOT NULL,
  UNIQUE KEY uq_wf_sports_configurations_version (version)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS wf_sports_calibrations (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  model_version_id BIGINT UNSIGNED NOT NULL,
  method VARCHAR(16) NOT NULL,
  intercept DECIMAL(12,6) NOT NULL,
  slope DECIMAL(12,6) NOT NULL,
  samples INT UNSIGNED NOT NULL,
  positives INT UNSIGNED NOT NULL,
  ece DECIMAL(9,6) NOT NULL,
  brier DECIMAL(9,6) NOT NULL,
  identity_brier DECIMAL(9,6) NOT NULL,
  bins LONGTEXT NOT NULL,
  calibration_version VARCHAR(120) NOT NULL,
  status VARCHAR(16) NOT NULL,
  created_by VARCHAR(64) NOT NULL,
  created_at VARCHAR(32) NOT NULL,
  -- Legacy stamps approved_by/approved_at on REJECTED too (SP-27). Preserved, and
  -- documented in PHASE17, because a rejection still records who decided and when.
  approved_by VARCHAR(64) NULL,
  approved_at VARCHAR(32) NULL,
  KEY ix_wf_sports_calibrations_status (status, model_version_id),
  KEY ix_wf_sports_calibrations_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
