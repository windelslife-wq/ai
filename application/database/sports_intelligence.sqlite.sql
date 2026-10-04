-- WINDELS Sports Intelligence — Phase 3 migrations (SQLite mirror).
-- New tables only; existing sports_* tables are extended via guarded ALTERs
-- in the installer (tools/install.php, Tools::install).

-- Versioned, append-only ticket-engine configuration. The latest row is the
-- active configuration; every change inserts a new version and an audit event
-- carrying the original and new values plus the acting administrator and reason.
CREATE TABLE IF NOT EXISTS sports_configurations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  version INTEGER NOT NULL UNIQUE,
  module_enabled INTEGER NOT NULL DEFAULT 0,
  ticket_engine_enabled INTEGER NOT NULL DEFAULT 0,
  platform_mode TEXT NOT NULL DEFAULT 'SANDBOX',
  engine_mode TEXT NOT NULL DEFAULT 'USER_APPROVAL_REQUIRED',
  target_odds_min REAL NOT NULL DEFAULT 5.0,
  target_odds_max REAL NOT NULL DEFAULT 8.0,
  max_selections INTEGER NOT NULL DEFAULT 5,
  risk_level TEXT NOT NULL DEFAULT 'CONSERVATIVE',
  min_confidence REAL NOT NULL DEFAULT 75,
  min_expected_value REAL NOT NULL DEFAULT 0.02,
  max_correlation TEXT NOT NULL DEFAULT 'MEDIUM',
  min_data_quality INTEGER NOT NULL DEFAULT 80,
  min_liquidity REAL,
  allowed_markets TEXT NOT NULL DEFAULT '[]',
  allowed_leagues TEXT NOT NULL DEFAULT '[]',
  max_exposure REAL NOT NULL DEFAULT 100,
  stake_amount REAL NOT NULL DEFAULT 10,
  void_policy TEXT NOT NULL DEFAULT 'RESTITUTE_ODDS',
  require_calibration INTEGER NOT NULL DEFAULT 1,
  updated_by TEXT NOT NULL DEFAULT 'system',
  reason TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sports_config_created ON sports_configurations(created_at);

-- Probability calibration versions fitted on stored settled predictions.
-- A model may only be used for ticket-grade decisions through an APPROVED
-- calibration; the raw model probability is never presented as calibrated.
CREATE TABLE IF NOT EXISTS sports_calibrations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  model_version_id INTEGER NOT NULL,
  method TEXT NOT NULL DEFAULT 'platt',
  intercept REAL NOT NULL,
  slope REAL NOT NULL,
  brier REAL,
  ece REAL,
  samples INTEGER NOT NULL DEFAULT 0,
  bins TEXT,
  status TEXT NOT NULL DEFAULT 'PENDING',
  created_by TEXT,
  approved_by TEXT,
  approved_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sports_calibrations_model ON sports_calibrations(model_version_id, status, created_at);

-- Idempotent non-sync scheduled job runs (spec §31). Sync jobs use sports_sync_runs.
CREATE TABLE IF NOT EXISTS sports_job_runs (
  id TEXT PRIMARY KEY,
  job_type TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  records_processed INTEGER NOT NULL DEFAULT 0,
  records_created INTEGER NOT NULL DEFAULT 0,
  records_updated INTEGER NOT NULL DEFAULT 0,
  errors TEXT,
  provider TEXT,
  execution_key TEXT NOT NULL UNIQUE
);
CREATE INDEX IF NOT EXISTS idx_sports_job_runs_type ON sports_job_runs(job_type, started_at);

-- Historical backtest runs. Reports are clearly marked as simulation and are
-- never merged into live performance statistics.
CREATE TABLE IF NOT EXISTS sports_backtests (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  created_by TEXT,
  params TEXT NOT NULL,
  report TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'COMPLETED'
);
CREATE INDEX IF NOT EXISTS idx_sports_backtests_created ON sports_backtests(created_at);

-- Periodic model performance snapshots (drift monitoring, comparison).
CREATE TABLE IF NOT EXISTS sports_model_metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  model_version_id INTEGER NOT NULL,
  window_days INTEGER NOT NULL,
  sample_type TEXT NOT NULL DEFAULT 'live',
  predictions INTEGER NOT NULL DEFAULT 0,
  settled INTEGER NOT NULL DEFAULT 0,
  accuracy REAL,
  brier REAL,
  ece REAL,
  win_rate REAL,
  roi REAL,
  max_drawdown REAL,
  computed_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sports_model_metrics ON sports_model_metrics(model_version_id, window_days, computed_at);

-- One row per UTC date for the daily ticket engine. NO_QUALIFIED_TICKET is a
-- stored, expected outcome — the engine never forces a ticket to exist.
CREATE TABLE IF NOT EXISTS sports_daily_tickets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL UNIQUE,
  ticket_id TEXT,
  status TEXT NOT NULL,
  configuration_version INTEGER,
  candidates_evaluated INTEGER NOT NULL DEFAULT 0,
  predictions_recorded INTEGER NOT NULL DEFAULT 0,
  rejections INTEGER NOT NULL DEFAULT 0,
  rejection_summary TEXT,
  message TEXT,
  provider TEXT,
  run_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Periodic performance snapshots so dashboards never fabricate history.
CREATE TABLE IF NOT EXISTS sports_performance_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  as_of TEXT NOT NULL,
  window TEXT NOT NULL,
  payload TEXT NOT NULL,
  UNIQUE(as_of, window)
);

-- Additional spec-required indexes on existing tables.
CREATE INDEX IF NOT EXISTS idx_sports_odds_provider ON sports_odds(provider_id, observed_at);
CREATE INDEX IF NOT EXISTS idx_sports_matches_provider_kickoff ON sports_matches(provider_id, kickoff_at);
CREATE INDEX IF NOT EXISTS idx_sports_predictions_market ON sports_predictions(market, created_at);
CREATE INDEX IF NOT EXISTS idx_sports_selections_market ON sports_ticket_selections(market, selection);
CREATE INDEX IF NOT EXISTS idx_sports_selections_match ON sports_ticket_selections(match_id);
CREATE INDEX IF NOT EXISTS idx_sports_predictions_created ON sports_predictions(created_at);
