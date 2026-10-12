-- Lottery measured half (row 15, slice 4).
--
-- Two tables: the backtest report record and the model version it is stamped
-- with (legacy `lottery_backtests` + `lottery_model_versions`, the spec
-- §23/§24/§25/§33 pair).
--
--   model_versions <- (logical) backtests.model_version
--
-- A backtest is a HISTORICAL SIMULATION: a strategy replayed over stored
-- draws WITHOUT look-ahead, persisted as one JSON `report` column with the
-- period and dataset version it covered. Every report is labelled and honest
-- about what it is not: `simulated_cost` and `simulated_winnings` do not exist
-- as columns because no official line pricing or prize amount exists in this
-- environment — the report JSON carries the two null fields and their notes
-- instead, and no column in this schema names money. Tier counts only.
--
-- Model versions are the spec §33 anchor: a row records name, version and the
-- full statistical configuration, is ENSURED once (an existing (model_name,
-- model_version) pair returns the existing row) and is NEVER deleted or
-- replaced — historical results stay connected to the model that produced
-- them. There is deliberately no DELETE in either adapter for this table.
--
-- `period_from`/`period_to` stay DATE, exactly as legacy declares them; the
-- repository reads them back as strings on both adapters (the file adapter
-- stores whatever the service wrote — always legacy's Y-m-d).
--
-- Timestamps are VARCHAR(32) canonical UTC (`...Z`), matching migrations 007
-- through 018 (divergence AV-2 / SP-1 / LT-1).
--
-- Additive only. No foreign keys, for the reason migrations 016–018 record:
-- the file adapter must implement the identical contract, and it has no
-- referential engine. Nothing here can be purchased, priced or settled for
-- money — these are measurement records about strategies and their reports.

CREATE TABLE IF NOT EXISTS wf_lottery_backtests (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  lottery_code VARCHAR(32) NOT NULL,
  strategy VARCHAR(40) NOT NULL,
  model_version VARCHAR(64) NOT NULL,
  lines_per_draw INT NOT NULL DEFAULT 1,
  draws_tested INT NOT NULL DEFAULT 0,
  period_from DATE NULL,
  period_to DATE NULL,
  dataset_version VARCHAR(128) NULL,
  report MEDIUMTEXT NOT NULL,
  created_at VARCHAR(32) NOT NULL,
  KEY idx_lottery_backtests_strategy (strategy, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS wf_lottery_model_versions (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  model_name VARCHAR(64) NOT NULL,
  model_version VARCHAR(16) NOT NULL,
  config MEDIUMTEXT NOT NULL,
  dataset_version VARCHAR(128) NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'ACTIVE',
  created_at VARCHAR(32) NOT NULL,
  UNIQUE KEY uq_lottery_model_versions (model_name, model_version)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
