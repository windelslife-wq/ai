-- Sports Intelligence: settlement, verification, backtests and model metrics
-- (row 14 of docs/migration/UNFINISHED_MODULES.md, slice 5).
--
-- Two tables, the two that migrations 011-013 reserved for this slice. They carry the
-- WRITES of settlement and measurement; every column settlement needs on the existing
-- tables already exists (wf_sports_results.verified/verified_at since migration 011;
-- wf_sports_tickets.settlement_status/pnl and wf_sports_ticket_selections.result/status
-- since migration 013).
--
--   backtests     -> one row per point-in-time replay the backtester stored
--   model_metrics -> one row per measured window: model performance snapshots and the
--                    drift monitor's warning snapshots
--
-- Deliberately absent: `sports_performance_snapshots`. Legacy's performance snapshot
-- table has exactly one writer, the `performance` cron job in `SportsCronService`, and
-- the sports cron is not ported (it stays in row 19 with the other scheduled jobs).
-- A table whose only writer is an unported job is dead schema; it arrives with the cron,
-- if the cron arrives.
--
-- Nothing here reaches a paper, execution, order or broker table. Settlement settles a
-- RECORD: the P/L it stores is evidence about the model, computed on stored tickets
-- with the configured fixed stake. No stake is sized, no bet is placed, nothing is
-- executed.
--
-- Referential integrity is by convention, as in migrations 011-013: there are no
-- foreign keys. A backtest row is self-contained JSON; a metrics row points at a model
-- version by id and is append-only.
--
-- Timestamps are VARCHAR(32) canonical UTC (`...Z`). Rates and metrics are DECIMAL.
-- JSON is LONGTEXT.

CREATE TABLE IF NOT EXISTS wf_sports_backtests (
  -- Caller-visible id ('bt_' + 16 hex), generated before the insert, as ticket ids are.
  id VARCHAR(40) NOT NULL PRIMARY KEY,
  created_at VARCHAR(32) NOT NULL,
  created_by VARCHAR(64) NULL,
  -- The run's parameters and its full report, each one JSON document. The report is
  -- stored whole and flagged simulation=true inside, so a report read back years later
  -- still says it is a replay and not live performance.
  params LONGTEXT NOT NULL,
  report LONGTEXT NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'COMPLETED',
  KEY ix_wf_sports_backtests_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS wf_sports_model_metrics (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  model_version_id BIGINT UNSIGNED NOT NULL,
  window_days INT UNSIGNED NOT NULL,
  -- 'live' for the model-performance snapshot, 'drift' for the drift monitor's
  -- warning snapshot — the two values legacy writes.
  sample_type VARCHAR(16) NOT NULL DEFAULT 'live',
  predictions INT UNSIGNED NOT NULL DEFAULT 0,
  settled INT UNSIGNED NOT NULL DEFAULT 0,
  accuracy DECIMAL(8,5) NULL,
  brier DECIMAL(8,5) NULL,
  ece DECIMAL(8,5) NULL,
  win_rate DECIMAL(8,5) NULL,
  roi DECIMAL(8,5) NULL,
  max_drawdown DECIMAL(12,4) NULL,
  computed_at VARCHAR(32) NOT NULL,
  KEY ix_wf_sports_model_metrics (model_version_id, window_days, computed_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
