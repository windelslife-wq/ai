-- WINDELS Sports Intelligence — Phase 3 migrations (MySQL/MariaDB).
-- New tables only; indexes are inline (MySQL lacks CREATE INDEX IF NOT EXISTS).
-- Indexes on pre-existing tables are added by the installer with a
-- duplicate-key guard. Existing sports_* tables are extended via guarded
-- ALTERs in the installer (tools/install.php, Tools::install).

CREATE TABLE IF NOT EXISTS sports_configurations (
  id INT AUTO_INCREMENT PRIMARY KEY,
  version INT NOT NULL UNIQUE,
  module_enabled TINYINT(1) NOT NULL DEFAULT 0,
  ticket_engine_enabled TINYINT(1) NOT NULL DEFAULT 0,
  platform_mode VARCHAR(16) NOT NULL DEFAULT 'SANDBOX',
  engine_mode VARCHAR(32) NOT NULL DEFAULT 'USER_APPROVAL_REQUIRED',
  target_odds_min DECIMAL(10,4) NOT NULL DEFAULT 5.0,
  target_odds_max DECIMAL(10,4) NOT NULL DEFAULT 8.0,
  max_selections INT NOT NULL DEFAULT 5,
  risk_level VARCHAR(16) NOT NULL DEFAULT 'CONSERVATIVE',
  min_confidence DECIMAL(5,2) NOT NULL DEFAULT 75,
  min_expected_value DECIMAL(8,5) NOT NULL DEFAULT 0.02,
  max_correlation VARCHAR(8) NOT NULL DEFAULT 'MEDIUM',
  min_data_quality SMALLINT NOT NULL DEFAULT 80,
  min_liquidity DECIMAL(10,4) NULL,
  allowed_markets TEXT NOT NULL,
  allowed_leagues TEXT NOT NULL,
  max_exposure DECIMAL(12,2) NOT NULL DEFAULT 100,
  stake_amount DECIMAL(12,2) NOT NULL DEFAULT 10,
  void_policy VARCHAR(16) NOT NULL DEFAULT 'RESTITUTE_ODDS',
  require_calibration TINYINT(1) NOT NULL DEFAULT 1,
  updated_by VARCHAR(64) NOT NULL DEFAULT 'system',
  reason VARCHAR(500) NULL,
  created_at DATETIME NOT NULL,
  INDEX idx_sports_config_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS sports_calibrations (
  id INT AUTO_INCREMENT PRIMARY KEY,
  model_version_id INT NOT NULL,
  method VARCHAR(16) NOT NULL DEFAULT 'platt',
  intercept DECIMAL(8,6) NOT NULL,
  slope DECIMAL(8,6) NOT NULL,
  brier DECIMAL(8,6) NULL,
  ece DECIMAL(8,6) NULL,
  samples INT NOT NULL DEFAULT 0,
  bins TEXT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'PENDING',
  created_by VARCHAR(64) NULL,
  approved_by VARCHAR(64) NULL,
  approved_at DATETIME NULL,
  created_at DATETIME NOT NULL,
  INDEX idx_sports_calibrations_model (model_version_id, status, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS sports_job_runs (
  id VARCHAR(40) PRIMARY KEY,
  job_type VARCHAR(48) NOT NULL,
  status VARCHAR(16) NOT NULL,
  started_at DATETIME NOT NULL,
  ended_at DATETIME NULL,
  records_processed INT NOT NULL DEFAULT 0,
  records_created INT NOT NULL DEFAULT 0,
  records_updated INT NOT NULL DEFAULT 0,
  errors TEXT NULL,
  provider VARCHAR(64) NULL,
  execution_key VARCHAR(160) NOT NULL UNIQUE,
  INDEX idx_sports_job_runs_type (job_type, started_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS sports_backtests (
  id VARCHAR(40) PRIMARY KEY,
  created_at DATETIME NOT NULL,
  created_by VARCHAR(64) NULL,
  params TEXT NOT NULL,
  report TEXT NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'COMPLETED',
  INDEX idx_sports_backtests_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS sports_model_metrics (
  id INT AUTO_INCREMENT PRIMARY KEY,
  model_version_id INT NOT NULL,
  window_days INT NOT NULL,
  sample_type VARCHAR(16) NOT NULL DEFAULT 'live',
  predictions INT NOT NULL DEFAULT 0,
  settled INT NOT NULL DEFAULT 0,
  accuracy DECIMAL(8,5) NULL,
  brier DECIMAL(8,5) NULL,
  ece DECIMAL(8,5) NULL,
  win_rate DECIMAL(8,5) NULL,
  roi DECIMAL(8,5) NULL,
  max_drawdown DECIMAL(12,4) NULL,
  computed_at DATETIME NOT NULL,
  INDEX idx_sports_model_metrics (model_version_id, window_days, computed_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS sports_daily_tickets (
  id INT AUTO_INCREMENT PRIMARY KEY,
  date DATE NOT NULL UNIQUE,
  ticket_id VARCHAR(36) NULL,
  status VARCHAR(32) NOT NULL,
  configuration_version INT NULL,
  candidates_evaluated INT NOT NULL DEFAULT 0,
  predictions_recorded INT NOT NULL DEFAULT 0,
  rejections INT NOT NULL DEFAULT 0,
  rejection_summary TEXT NULL,
  message VARCHAR(500) NULL,
  provider VARCHAR(64) NULL,
  run_id VARCHAR(40) NULL,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS sports_performance_snapshots (
  id INT AUTO_INCREMENT PRIMARY KEY,
  as_of DATETIME NOT NULL,
  window VARCHAR(8) NOT NULL,
  payload TEXT NOT NULL,
  UNIQUE KEY uq_sports_perf_snapshot (as_of, window)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
