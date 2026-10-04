-- AEGIS Portable cPanel production database.
-- Import this single file into a new MySQL/MariaDB database through phpMyAdmin.
-- This file contains the complete production schema, indexes, foreign keys,
-- lookup data, default settings, RBAC and a documented initial administrator.
-- No installer, migration, seed, Composer, Node, npm, Docker or CLI command is required.
SET NAMES utf8mb4;
SET SQL_MODE='STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION';
SET FOREIGN_KEY_CHECKS=0;

-- =====================================================================
-- application/database/schema.mysql.sql (canonical production schema)
-- =====================================================================
-- AEGIS — canonical MySQL / MariaDB schema (Phase 3 scope)
-- Notes: JSON documents are stored as LONGTEXT for MySQL 5.7 / MariaDB 10.x
-- portability; monetary values use DECIMAL(18,8) to cover crypto units.

CREATE TABLE IF NOT EXISTS platform_state (
  k  VARCHAR(32) NOT NULL PRIMARY KEY,
  v  LONGTEXT NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS strategies (
  strategy_id   VARCHAR(60)  NOT NULL,
  version       VARCHAR(20)  NOT NULL,
  name          VARCHAR(120) NOT NULL,
  description   TEXT         NOT NULL,
  market_classes LONGTEXT    NOT NULL,
  timeframes    LONGTEXT     NOT NULL,
  params        LONGTEXT     NOT NULL,
  source        VARCHAR(10)  NOT NULL DEFAULT 'builtin',
  lifecycle     VARCHAR(20)  NOT NULL DEFAULT 'DRAFT',
  created_at    VARCHAR(32)  NOT NULL,
  updated_at    VARCHAR(32)  NOT NULL,
  lifecycle_history LONGTEXT NOT NULL,
  PRIMARY KEY (strategy_id, version)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS backtests (
  id               VARCHAR(36) NOT NULL PRIMARY KEY,
  created_at       VARCHAR(32) NOT NULL,
  strategy_id      VARCHAR(60) NOT NULL,
  strategy_version VARCHAR(20) NOT NULL,
  symbol           VARCHAR(20) NOT NULL,
  timeframe        VARCHAR(5)  NOT NULL,
  synthetic        TINYINT(1)  NOT NULL DEFAULT 0,
  payload          LONGTEXT    NOT NULL,
  INDEX idx_backtests_strategy (strategy_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS analysis_runs (
  id            VARCHAR(36) NOT NULL PRIMARY KEY,
  symbol        VARCHAR(20) NOT NULL,
  timeframe     VARCHAR(5)  NOT NULL,
  bias          VARCHAR(10) NOT NULL,
  confidence    DECIMAL(5,4) NOT NULL,
  regime        VARCHAR(20) NOT NULL,
  recommendation VARCHAR(10) NOT NULL,
  synthetic     TINYINT(1)  NOT NULL DEFAULT 0,
  source        VARCHAR(40) NOT NULL,
  completed_at  VARCHAR(32) NOT NULL,
  payload       LONGTEXT    NOT NULL,
  INDEX idx_analysis_completed (completed_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS journal_entries (
  id                VARCHAR(36) NOT NULL PRIMARY KEY,
  source            VARCHAR(10) NOT NULL,          -- backtest | manual | paper | live
  symbol            VARCHAR(20) NOT NULL,
  market            VARCHAR(12) NOT NULL,
  strategy          VARCHAR(60) NULL,
  strategy_version  VARCHAR(20) NULL,
  direction         VARCHAR(5)  NOT NULL,
  entry_time        VARCHAR(32) NOT NULL,
  entry_price       DECIMAL(20,8) NOT NULL,
  exit_time         VARCHAR(32) NULL,
  exit_price        DECIMAL(20,8) NULL,
  position_size     DECIMAL(20,8) NOT NULL,
  stop_loss         DECIMAL(20,8) NULL,
  take_profit       DECIMAL(20,8) NULL,
  fees              DECIMAL(18,6) NOT NULL DEFAULT 0,
  slippage          DECIMAL(18,6) NOT NULL DEFAULT 0,
  pnl               DECIMAL(18,6) NULL,
  pnl_pct           DECIMAL(12,6) NULL,
  r_multiple        DECIMAL(12,6) NULL,
  reason            TEXT NULL,
  ai_confidence     DECIMAL(5,4) NULL,
  confidence_source VARCHAR(16) NULL,
  agent_consensus   VARCHAR(120) NULL,
  risk_score        DECIMAL(8,6) NULL,
  execution_time    VARCHAR(32) NOT NULL,
  backtest_id       VARCHAR(36) NULL,
  paper_position_id INT NULL,
  INDEX idx_journal_symbol (symbol, execution_time),
  INDEX idx_journal_strategy (strategy, execution_time),
  INDEX idx_journal_confidence (ai_confidence)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS paper_accounts (
  id               INT AUTO_INCREMENT PRIMARY KEY,
  name             VARCHAR(60) NOT NULL,
  currency         VARCHAR(3)  NOT NULL DEFAULT 'USD',
  starting_balance DECIMAL(18,2) NOT NULL,
  balance          DECIMAL(18,2) NOT NULL,
  peak_equity      DECIMAL(18,2) NOT NULL,
  created_at       VARCHAR(32) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS paper_orders (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  account_id    INT NOT NULL,
  symbol        VARCHAR(20) NOT NULL,
  market_class  VARCHAR(12) NOT NULL,
  side          VARCHAR(4)  NOT NULL,
  type          VARCHAR(6)  NOT NULL,              -- MARKET | LIMIT
  units         DECIMAL(20,8) NOT NULL,
  price         DECIMAL(20,8) NULL,
  stop_loss     DECIMAL(20,8) NULL,
  take_profit   DECIMAL(20,8) NULL,
  status        VARCHAR(10) NOT NULL,              -- PENDING | FILLED | REJECTED | CANCELLED
  reject_reason TEXT NULL,
  risk_amount   DECIMAL(18,6) NULL,
  reason        TEXT NULL,
  ai_confidence DECIMAL(5,4) NULL,
  strategy      VARCHAR(60) NULL,
  created_at    VARCHAR(32) NOT NULL,
  filled_at     VARCHAR(32) NULL,
  fill_price    DECIMAL(20,8) NULL,
  INDEX idx_orders_account (account_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS paper_positions (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  account_id    INT NOT NULL,
  symbol        VARCHAR(20) NOT NULL,
  market_class  VARCHAR(12) NOT NULL,
  direction     VARCHAR(5)  NOT NULL,
  units         DECIMAL(20,8) NOT NULL,
  entry_price   DECIMAL(20,8) NOT NULL,
  stop_loss     DECIMAL(20,8) NOT NULL,
  take_profit   DECIMAL(20,8) NOT NULL,
  entry_fee     DECIMAL(18,6) NOT NULL DEFAULT 0,
  risk_amount   DECIMAL(18,6) NULL,
  strategy      VARCHAR(60) NULL,
  reason        TEXT NULL,
  ai_confidence DECIMAL(5,4) NULL,
  opened_at     VARCHAR(32) NOT NULL,
  status        VARCHAR(8)  NOT NULL DEFAULT 'OPEN',
  closed_at     VARCHAR(32) NULL,
  exit_price    DECIMAL(20,8) NULL,
  realized_pnl  DECIMAL(18,6) NULL,
  exit_reason   VARCHAR(16) NULL,
  INDEX idx_positions_account (account_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS paper_trades (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  account_id  INT NOT NULL,
  order_id    INT NULL,
  position_id INT NOT NULL,
  leg         VARCHAR(5) NOT NULL,                 -- ENTRY | EXIT
  symbol      VARCHAR(20) NOT NULL,
  price       DECIMAL(20,8) NOT NULL,
  units       DECIMAL(20,8) NOT NULL,
  fee         DECIMAL(18,6) NOT NULL DEFAULT 0,
  time        VARCHAR(32) NOT NULL,
  synthetic   TINYINT(1) NOT NULL DEFAULT 0,
  INDEX idx_paper_trades_account (account_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS paper_deployments (
  id                INT AUTO_INCREMENT PRIMARY KEY,
  account_id        INT NOT NULL,
  strategy_id       VARCHAR(60) NOT NULL,
  strategy_version  VARCHAR(20) NOT NULL,
  symbol            VARCHAR(20) NOT NULL,
  market_class      VARCHAR(12) NOT NULL,
  timeframe         VARCHAR(5)  NOT NULL,
  active            TINYINT(1) NOT NULL DEFAULT 1,
  deployed_at       VARCHAR(32) NOT NULL,
  last_evaluated_at VARCHAR(32) NULL,
  last_signal       VARCHAR(8) NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS audit_logs (
  id      INT AUTO_INCREMENT PRIMARY KEY,
  type    VARCHAR(32) NOT NULL,
  at      VARCHAR(32) NOT NULL,
  actor   VARCHAR(8)  NOT NULL DEFAULT 'system',
  summary VARCHAR(500) NOT NULL,
  detail  LONGTEXT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Phase 5 execution governance: every broker intent is a durable, auditable
-- proposal; every routed order leaves an execution record linked to it.
CREATE TABLE IF NOT EXISTS trade_proposals (
  id           VARCHAR(40) PRIMARY KEY,
  created_at   VARCHAR(32) NOT NULL,
  actor        VARCHAR(80) NOT NULL DEFAULT 'user',
  broker       VARCHAR(40) NOT NULL,
  symbol       VARCHAR(32) NOT NULL,
  market_class VARCHAR(20) NOT NULL,
  side         VARCHAR(4)  NOT NULL,
  order_type   VARCHAR(10) NOT NULL,
  volume       DECIMAL(18,6) NOT NULL,
  price        DECIMAL(18,8) NULL,
  stop_loss    DECIMAL(18,8) NOT NULL,
  take_profit  DECIMAL(18,8) NULL,
  strategy_id  VARCHAR(60) NULL,
  reason       VARCHAR(500) NULL,
  status       VARCHAR(24) NOT NULL,
  intent       LONGTEXT NOT NULL,
  checks       LONGTEXT NOT NULL,
  risk_decision LONGTEXT NULL,
  decision_by  VARCHAR(80) NULL,
  decided_at   VARCHAR(32) NULL,
  updated_at   VARCHAR(32) NOT NULL,
  KEY idx_proposals_status (status, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS trade_executions (
  id              VARCHAR(40) PRIMARY KEY,
  proposal_id     VARCHAR(40) NOT NULL,
  broker          VARCHAR(40) NOT NULL,
  broker_order_id VARCHAR(64) NULL,
  automated       TINYINT(1) NOT NULL DEFAULT 0,
  submitted_at    VARCHAR(32) NOT NULL,
  status          VARCHAR(24) NOT NULL,
  result          LONGTEXT NOT NULL,
  KEY idx_executions_proposal (proposal_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Sessions (CI3 'database' session driver; used by the offline dev runtime
-- where per-request instances cannot share file sessions reliably).
CREATE TABLE IF NOT EXISTS ci_sessions (
  id         VARCHAR(128) NOT NULL PRIMARY KEY,
  ip_address VARCHAR(45) NOT NULL,
  timestamp  INT NOT NULL DEFAULT 0,
  data       MEDIUMTEXT NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Operator notifications (spec §16/§18): risk alerts, approval requests,
-- execution outcomes. user_id NULL = broadcast to every operator.
CREATE TABLE IF NOT EXISTS notifications (
  id          VARCHAR(36) PRIMARY KEY,
  user_id     INT NULL,
  type        VARCHAR(40) NOT NULL,
  severity    VARCHAR(10) NOT NULL DEFAULT 'info',
  title       VARCHAR(200) NOT NULL,
  detail      LONGTEXT NOT NULL,
  dedupe_key  VARCHAR(120) NULL,
  read_at     VARCHAR(32) NULL,
  created_at  VARCHAR(32) NOT NULL,
  KEY idx_notifications_unread (user_id, read_at, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


-- Lead Discovery module (organization-scoped permanent PostgreSQL-compatible design).
CREATE TABLE IF NOT EXISTS leads (id VARCHAR(36) PRIMARY KEY, organization_id VARCHAR(80) NOT NULL, source VARCHAR(40) NOT NULL, source_id VARCHAR(255) NOT NULL, name VARCHAR(255) NOT NULL, category VARCHAR(255), address TEXT, city VARCHAR(120), region VARCHAR(120), country VARCHAR(120), phone VARCHAR(80), website TEXT, latitude DECIMAL(10,7), longitude DECIMAL(10,7), status VARCHAR(20) NOT NULL DEFAULT 'new', owner_id INT NULL, metadata LONGTEXT NOT NULL, created_at VARCHAR(32) NOT NULL, updated_at VARCHAR(32) NOT NULL, UNIQUE KEY uq_lead_source (organization_id,source,source_id), KEY idx_leads_org_status(organization_id,status), KEY idx_leads_owner(organization_id,owner_id), KEY idx_leads_created(organization_id,created_at)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS lead_notes (id VARCHAR(36) PRIMARY KEY, lead_id VARCHAR(36) NOT NULL, organization_id VARCHAR(80) NOT NULL, author_id INT NOT NULL, body TEXT NOT NULL, created_at VARCHAR(32) NOT NULL, KEY idx_notes_lead(organization_id,lead_id)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS lead_activities (id VARCHAR(36) PRIMARY KEY, lead_id VARCHAR(36) NULL, organization_id VARCHAR(80) NOT NULL, actor_id INT NULL, type VARCHAR(50) NOT NULL, detail LONGTEXT NOT NULL, created_at VARCHAR(32) NOT NULL, KEY idx_activity_lead(organization_id,lead_id,created_at)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS collections (id VARCHAR(36) PRIMARY KEY, organization_id VARCHAR(80) NOT NULL, name VARCHAR(150) NOT NULL, created_at VARCHAR(32) NOT NULL, updated_at VARCHAR(32) NOT NULL, UNIQUE KEY uq_collection(organization_id,name)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS collection_leads (collection_id VARCHAR(36) NOT NULL, lead_id VARCHAR(36) NOT NULL, PRIMARY KEY(collection_id,lead_id)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS search_history (id VARCHAR(36) PRIMARY KEY, organization_id VARCHAR(80) NOT NULL, user_id INT NOT NULL, query TEXT NOT NULL, provider VARCHAR(40) NOT NULL, filters LONGTEXT NOT NULL, results_returned INT NOT NULL, new_leads_created INT NOT NULL, duplicates_detected INT NOT NULL, errors TEXT NULL, duration_ms INT NOT NULL, created_at VARCHAR(32) NOT NULL, KEY idx_history_org(organization_id,created_at)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS duplicate_candidates (id VARCHAR(36) PRIMARY KEY, organization_id VARCHAR(80) NOT NULL, lead_a_id VARCHAR(36) NOT NULL, lead_b_id VARCHAR(36) NOT NULL, rule_name VARCHAR(80) NOT NULL, confidence DECIMAL(4,3) NOT NULL, status VARCHAR(20) NOT NULL DEFAULT 'open', created_at VARCHAR(32) NOT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS duplicate_resolutions (id VARCHAR(36) PRIMARY KEY, candidate_id VARCHAR(36) NOT NULL, organization_id VARCHAR(80) NOT NULL, resolver_id INT NOT NULL, action VARCHAR(30) NOT NULL, created_at VARCHAR(32) NOT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS export_history (id VARCHAR(36) PRIMARY KEY, organization_id VARCHAR(80) NOT NULL, user_id INT NOT NULL, format VARCHAR(10) NOT NULL, filters LONGTEXT NOT NULL, lead_count INT NOT NULL, created_at VARCHAR(32) NOT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS lead_organizations (id VARCHAR(80) PRIMARY KEY, name VARCHAR(160) NOT NULL, created_at VARCHAR(32) NOT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS lead_organization_members (organization_id VARCHAR(80) NOT NULL, user_id INT NOT NULL, role VARCHAR(20) NOT NULL DEFAULT 'member', created_at VARCHAR(32) NOT NULL, PRIMARY KEY(organization_id,user_id), KEY idx_lead_org_members_user(user_id)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- =====================================================================
-- application/database/sports_identity.mysql.sql (canonical production schema)
-- =====================================================================
-- Install alongside canonical schema.mysql.sql. Kept separate temporarily because
-- existing deployments need an explicit reviewed migration.
CREATE TABLE IF NOT EXISTS users (
  id INT AUTO_INCREMENT PRIMARY KEY,
  email VARCHAR(190) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  display_name VARCHAR(120) NOT NULL,
  active TINYINT(1) NOT NULL DEFAULT 1,
  created_at VARCHAR(32) NOT NULL,
  updated_at VARCHAR(32) NOT NULL,
  last_login_at VARCHAR(32) NULL,
  INDEX idx_users_active (active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS roles (
  id INT AUTO_INCREMENT PRIMARY KEY, code VARCHAR(64) NOT NULL UNIQUE, name VARCHAR(120) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS permissions (
  id INT AUTO_INCREMENT PRIMARY KEY, code VARCHAR(96) NOT NULL UNIQUE, name VARCHAR(160) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS user_roles (user_id INT NOT NULL, role_id INT NOT NULL, PRIMARY KEY(user_id, role_id), INDEX idx_ur_role(role_id)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS role_permissions (role_id INT NOT NULL, permission_id INT NOT NULL, PRIMARY KEY(role_id, permission_id), INDEX idx_rp_permission(permission_id)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS auth_events (
  id BIGINT AUTO_INCREMENT PRIMARY KEY, user_id INT NOT NULL, type VARCHAR(64) NOT NULL, detail LONGTEXT NULL, at VARCHAR(32) NOT NULL, INDEX idx_auth_events_user(user_id, at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- =====================================================================
-- application/database/sports.mysql.sql (canonical production schema)
-- =====================================================================
-- Sports Intelligence persistence: provider-neutral, source-attributed records.
CREATE TABLE IF NOT EXISTS sports_data_sources (
 id INT AUTO_INCREMENT PRIMARY KEY, provider_code VARCHAR(64) NOT NULL UNIQUE, display_name VARCHAR(120) NOT NULL,
 enabled TINYINT(1) NOT NULL DEFAULT 0, created_at VARCHAR(32) NOT NULL, updated_at VARCHAR(32) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS sports_provider_health (
 id BIGINT AUTO_INCREMENT PRIMARY KEY, provider_id INT NOT NULL, status VARCHAR(32) NOT NULL, response_ms INT NULL,
 error_rate DECIMAL(8,5) NULL, rate_limit_remaining INT NULL, last_success_at VARCHAR(32) NULL, last_failure_at VARCHAR(32) NULL,
 last_fixture_sync_at VARCHAR(32) NULL, last_odds_sync_at VARCHAR(32) NULL, last_result_sync_at VARCHAR(32) NULL,
 data_freshness_seconds INT NULL, records_received INT NOT NULL DEFAULT 0, invalid_records INT NOT NULL DEFAULT 0,
 missing_fields LONGTEXT NULL, observed_at VARCHAR(32) NOT NULL, INDEX idx_provider_health(provider_id, observed_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS sports_matches (
 id BIGINT AUTO_INCREMENT PRIMARY KEY, provider_id INT NOT NULL, external_id VARCHAR(128) NOT NULL, sport VARCHAR(32) NOT NULL,
 competition VARCHAR(160) NOT NULL, home_team VARCHAR(160) NOT NULL, away_team VARCHAR(160) NOT NULL, kickoff_at VARCHAR(32) NOT NULL,
 status VARCHAR(32) NOT NULL, source_timestamp VARCHAR(32) NOT NULL, payload LONGTEXT NOT NULL, created_at VARCHAR(32) NOT NULL, updated_at VARCHAR(32) NOT NULL,
 UNIQUE KEY uq_sports_match_provider_external(provider_id, external_id), INDEX idx_sports_matches_kickoff(kickoff_at), INDEX idx_sports_matches_status(status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS sports_odds (
 id BIGINT AUTO_INCREMENT PRIMARY KEY, match_id BIGINT NOT NULL, provider_id INT NOT NULL, market VARCHAR(96) NOT NULL,
 selection VARCHAR(160) NOT NULL, decimal_odds DECIMAL(12,6) NOT NULL, observed_at VARCHAR(32) NOT NULL, payload LONGTEXT NOT NULL,
 INDEX idx_sports_odds_match_market(match_id, market, observed_at), INDEX idx_sports_odds_provider(provider_id, observed_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS sports_data_quality_assessments (
 id BIGINT AUTO_INCREMENT PRIMARY KEY, match_id BIGINT NOT NULL, score INT NOT NULL, band VARCHAR(16) NOT NULL,
 freshness_score INT NOT NULL, provider_reliability_score INT NOT NULL, eligible_prediction TINYINT(1) NOT NULL, eligible_ticket TINYINT(1) NOT NULL,
 missing_fields LONGTEXT NOT NULL, checks_payload LONGTEXT NOT NULL, assessed_at VARCHAR(32) NOT NULL, INDEX idx_sports_quality_match(match_id, assessed_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS sports_sync_runs (
 id VARCHAR(36) PRIMARY KEY, provider_id INT NULL, job_type VARCHAR(48) NOT NULL, status VARCHAR(24) NOT NULL,
 started_at VARCHAR(32) NOT NULL, ended_at VARCHAR(32) NULL, records_processed INT NOT NULL DEFAULT 0, records_created INT NOT NULL DEFAULT 0,
 records_updated INT NOT NULL DEFAULT 0, errors LONGTEXT NULL, execution_key VARCHAR(128) NOT NULL UNIQUE, INDEX idx_sports_sync_runs_job(job_type, started_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- =====================================================================
-- application/database/sports_decisions.mysql.sql (canonical production schema)
-- =====================================================================
-- Versioned, reproducible sports decision and ticket records.
CREATE TABLE IF NOT EXISTS sports_model_versions (id INT AUTO_INCREMENT PRIMARY KEY, model_name VARCHAR(120) NOT NULL, model_version VARCHAR(64) NOT NULL, feature_version VARCHAR(64) NOT NULL, calibration_version VARCHAR(64) NULL, status VARCHAR(24) NOT NULL, created_at VARCHAR(32) NOT NULL, UNIQUE KEY uq_sports_model_version(model_name, model_version)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS sports_predictions (id VARCHAR(36) PRIMARY KEY, match_id BIGINT NOT NULL, model_version_id INT NOT NULL, market VARCHAR(96) NOT NULL, selection VARCHAR(160) NOT NULL, raw_probability DECIMAL(10,8) NULL, calibrated_probability DECIMAL(10,8) NULL, implied_probability DECIMAL(10,8) NULL, expected_value DECIMAL(12,8) NULL, confidence DECIMAL(10,8) NULL, risk VARCHAR(16) NOT NULL, correlation VARCHAR(16) NOT NULL, data_quality_score INT NOT NULL, decision VARCHAR(48) NOT NULL, rejection_reasons LONGTEXT NULL, factors LONGTEXT NOT NULL, input_version VARCHAR(64) NOT NULL, odds DECIMAL(14,6) NULL, odds_timestamp VARCHAR(32) NULL, created_at VARCHAR(32) NOT NULL, INDEX idx_sports_predictions_match(match_id, created_at), INDEX idx_sports_predictions_model(model_version_id, created_at)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS sports_tickets (id VARCHAR(36) PRIMARY KEY, created_at VARCHAR(32) NOT NULL, model_version_id INT NULL, configuration_version VARCHAR(64) NOT NULL, total_odds DECIMAL(14,6) NULL, selection_count INT NOT NULL, combined_probability DECIMAL(10,8) NULL, confidence DECIMAL(10,8) NULL, risk VARCHAR(16) NOT NULL, correlation VARCHAR(16) NOT NULL, data_quality_score INT NULL, status VARCHAR(32) NOT NULL, approval_status VARCHAR(32) NOT NULL, settlement_status VARCHAR(32) NOT NULL, reason TEXT NULL, stake DECIMAL(12,2) NULL, pnl DECIMAL(14,4) NULL, INDEX idx_sports_tickets_status(status, created_at)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS sports_ticket_selections (id BIGINT AUTO_INCREMENT PRIMARY KEY, ticket_id VARCHAR(36) NOT NULL, prediction_id VARCHAR(36) NOT NULL, match_id BIGINT NOT NULL, market VARCHAR(96) NOT NULL, selection VARCHAR(160) NOT NULL, odds DECIMAL(14,6) NOT NULL, odds_timestamp VARCHAR(32) NOT NULL, model_probability DECIMAL(10,8) NULL, calibrated_probability DECIMAL(10,8) NULL, expected_value DECIMAL(12,8) NULL, risk VARCHAR(16) NOT NULL, result VARCHAR(24) NULL, status VARCHAR(32) NOT NULL, INDEX idx_sports_ticket_selections_ticket(ticket_id), INDEX idx_sports_ticket_selections_prediction(prediction_id)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- =====================================================================
-- application/database/sports_results.mysql.sql (canonical production schema)
-- =====================================================================
CREATE TABLE IF NOT EXISTS sports_results (id BIGINT AUTO_INCREMENT PRIMARY KEY, match_id BIGINT NOT NULL, provider_id INT NOT NULL, home_score INT NULL, away_score INT NULL, status VARCHAR(24) NOT NULL, verified TINYINT(1) NOT NULL DEFAULT 0, source_timestamp VARCHAR(32) NOT NULL, verified_at VARCHAR(32) NULL, payload LONGTEXT NOT NULL, UNIQUE KEY uq_sports_result_provider_match(provider_id, match_id), INDEX idx_sports_results_match(match_id, verified)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- =====================================================================
-- application/database/sports_intelligence.mysql.sql (canonical production schema)
-- =====================================================================
-- WINDELS Sports Intelligence — Phase 3 migrations (MySQL/MariaDB).
-- New tables only; indexes are inline (MySQL lacks CREATE INDEX IF NOT EXISTS).
-- Indexes on pre-existing tables are added by the installer with a
-- duplicate-key guard. Existing sports_* tables are extended via guarded

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

-- =====================================================================
-- application/database/langlearn.mysql.sql (canonical production schema)
-- =====================================================================
-- AI Language Learning module (Phase 1). Canonical MySQL schema; the
-- sqlite dev mirror lives in langlearn.sqlite.sql. No fake progress: every
-- row is produced by real user activity (answers, attempts, sessions).

CREATE TABLE IF NOT EXISTS languages (
  code           VARCHAR(8) PRIMARY KEY,          -- ISO 639-1/3 code
  name           VARCHAR(60) NOT NULL,
  native_name    VARCHAR(120) NOT NULL,
  iso_code       VARCHAR(8) NOT NULL,
  writing_system VARCHAR(40) NOT NULL,            -- latin | cyrillic | devanagari | arabic | han | kana | hangul | ...
  direction      VARCHAR(3) NOT NULL DEFAULT 'ltr',
  features       LONGTEXT NOT NULL,               -- JSON: assessment, listening, speaking, writing …
  active         TINYINT(1) NOT NULL DEFAULT 1,
  updated_at     VARCHAR(32) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS user_language_profiles (
  id                   INT AUTO_INCREMENT PRIMARY KEY,
  user_id              INT NOT NULL,
  language_code        VARCHAR(8) NOT NULL,
  level                VARCHAR(10) NOT NULL DEFAULT 'Beginner',   -- Beginner|A1..C2 (set only by assessment)
  goal                 VARCHAR(300) NULL,
  explanation_language VARCHAR(8) NOT NULL DEFAULT 'en',
  status               VARCHAR(16) NOT NULL DEFAULT 'ACTIVE',
  daily_minutes        INT NOT NULL DEFAULT 20,
  created_at           VARCHAR(32) NOT NULL,
  updated_at           VARCHAR(32) NOT NULL,
  UNIQUE KEY uq_profile_user_language (user_id, language_code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS language_assessments (
  id           VARCHAR(36) PRIMARY KEY,
  profile_id   INT NOT NULL,
  user_id      INT NOT NULL,
  language_code VARCHAR(8) NOT NULL,
  status       VARCHAR(12) NOT NULL DEFAULT 'IN_PROGRESS',        -- IN_PROGRESS|COMPLETED
  state        LONGTEXT NOT NULL,                 -- adaptive engine state (queue, position, per-skill stats)
  result       LONGTEXT NULL,                     -- final verdict: per-skill levels, overall, strengths, weaknesses
  started_at   VARCHAR(32) NOT NULL,
  completed_at VARCHAR(32) NULL,
  KEY idx_assessments_profile (profile_id, started_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS learning_paths (
  id            VARCHAR(36) PRIMARY KEY,
  profile_id    INT NOT NULL,
  language_code VARCHAR(8) NOT NULL,
  from_level    VARCHAR(10) NOT NULL,
  target_level  VARCHAR(10) NOT NULL,
  status        VARCHAR(12) NOT NULL DEFAULT 'ACTIVE',
  created_at    VARCHAR(32) NOT NULL,
  KEY idx_paths_profile (profile_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS learning_modules (
  id               VARCHAR(36) PRIMARY KEY,
  path_id          VARCHAR(36) NOT NULL,
  profile_id       INT NOT NULL,
  language_code    VARCHAR(8) NOT NULL,
  sequence         INT NOT NULL,
  code             VARCHAR(60) NOT NULL,
  title            VARCHAR(160) NOT NULL,
  focus_skill      VARCHAR(12) NOT NULL,          -- vocabulary|grammar|reading
  level            VARCHAR(10) NOT NULL,
  status           VARCHAR(12) NOT NULL DEFAULT 'LOCKED',  -- LOCKED|AVAILABLE|IN_PROGRESS|COMPLETED
  attempts_count   INT NOT NULL DEFAULT 0,
  completed_at     VARCHAR(32) NULL,
  KEY idx_modules_path (path_id, sequence),
  KEY idx_modules_profile (profile_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS lesson_attempts (
  id             VARCHAR(36) PRIMARY KEY,
  profile_id     INT NOT NULL,
  user_id        INT NOT NULL,
  language_code  VARCHAR(8) NOT NULL,
  module_id      VARCHAR(36) NULL,
  kind           VARCHAR(16) NOT NULL,            -- assessment|checkpoint|lesson (Phase 2)
  score_pct      DECIMAL(5,2) NULL,
  passed         TINYINT(1) NULL,
  detail         LONGTEXT NOT NULL,               -- items, answers, explanations (audit-grade)
  created_at     VARCHAR(32) NOT NULL,
  KEY idx_attempts_profile (profile_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS study_sessions (
  id             VARCHAR(36) PRIMARY KEY,
  profile_id     INT NOT NULL,
  user_id        INT NOT NULL,
  language_code  VARCHAR(8) NOT NULL,
  activity       VARCHAR(24) NOT NULL,            -- assessment|checkpoint|review (Phase 3)…
  day            VARCHAR(10) NOT NULL,            -- UTC date, for streak math
  created_at     VARCHAR(32) NOT NULL,
  KEY idx_sessions_profile_day (profile_id, day)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS language_progress (
  id                 INT AUTO_INCREMENT PRIMARY KEY,
  profile_id         INT NOT NULL,
  user_id            INT NOT NULL,
  language_code      VARCHAR(8) NOT NULL,
  skill              VARCHAR(12) NOT NULL,        -- vocabulary|grammar|reading|listening|writing|speaking|overall
  level              VARCHAR(10) NULL,            -- from real assessment data only
  value_pct          DECIMAL(5,2) NULL,           -- derived from real events only, never invented
  source             VARCHAR(24) NOT NULL,        -- assessment|path_completion|activity
  updated_at         VARCHAR(32) NOT NULL,
  UNIQUE KEY uq_progress (profile_id, skill, source),
  KEY idx_progress_user (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Phase 2 (AI Teacher): conversation drill sessions and writing practice.
-- Conversation turns store the authored scenario state + deterministic
-- evaluation; writing attempts ALWAYS keep the user's original text next to
-- the structured feedback (never overwritten).
CREATE TABLE IF NOT EXISTS conversation_sessions (
  id             VARCHAR(36) PRIMARY KEY,
  profile_id     INT NOT NULL,
  user_id        INT NOT NULL,
  language_code  VARCHAR(8) NOT NULL,
  scenario       VARCHAR(40) NOT NULL,
  mode           VARCHAR(20) NOT NULL DEFAULT 'casual',       -- beginner|intermediate|advanced|travel|restaurant|shopping|...
  correction     VARCHAR(24) NOT NULL DEFAULT 'important',     -- immediate|after|important|conversation_only
  status         VARCHAR(12) NOT NULL DEFAULT 'ACTIVE',        -- ACTIVE|COMPLETED|ABANDONED
  state          LONGTEXT NOT NULL,                            -- scenario script state: turn index, history, evaluation
  turn_count     INT NOT NULL DEFAULT 0,
  started_at     VARCHAR(32) NOT NULL,
  completed_at   VARCHAR(32) NULL,
  KEY idx_conv_profile (profile_id, started_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS writing_attempts (
  id             VARCHAR(36) PRIMARY KEY,
  profile_id     INT NOT NULL,
  user_id        INT NOT NULL,
  language_code  VARCHAR(8) NOT NULL,
  task_code      VARCHAR(40) NOT NULL,
  original_text  MEDIUMTEXT NOT NULL,                          -- the user's own writing, never modified
  feedback       LONGTEXT NOT NULL,                            -- structured deterministic feedback
  score_pct      DECIMAL(5,2) NULL,
  created_at     VARCHAR(32) NOT NULL,
  KEY idx_writing_profile (profile_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Phase 3 (vocabulary): language word bank + per-user spaced-repetition state.
CREATE TABLE IF NOT EXISTS vocabulary (
  id               INT AUTO_INCREMENT PRIMARY KEY,
  language_code    VARCHAR(8) NOT NULL,
  word             VARCHAR(120) NOT NULL,
  translation      VARCHAR(160) NOT NULL,
  pronunciation    VARCHAR(160) NULL,           -- romanization where confidently known
  example_sentence VARCHAR(300) NULL,           -- only sentences that contain the word
  category         VARCHAR(24) NOT NULL,
  level            VARCHAR(4) NOT NULL,
  active           TINYINT(1) NOT NULL DEFAULT 1,
  UNIQUE KEY uq_vocabulary_word (language_code, word)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS user_vocabulary (
  id               INT AUTO_INCREMENT PRIMARY KEY,
  profile_id       INT NOT NULL,
  user_id          INT NOT NULL,
  vocabulary_id    INT NOT NULL,
  stage            INT NOT NULL DEFAULT 0,      -- SRS stage 0..5 (learned at >= 4)
  familiarity      DECIMAL(4,3) NOT NULL DEFAULT 0.000,  -- stage / 5
  next_review_at   VARCHAR(32) NOT NULL,        -- ISO timestamp; due when <= now
  review_count     INT NOT NULL DEFAULT 0,
  lapse_count      INT NOT NULL DEFAULT 0,
  last_result      VARCHAR(8) NULL,             -- remembered | forgot
  last_reviewed_at VARCHAR(32) NULL,
  added_at         VARCHAR(32) NOT NULL,
  UNIQUE KEY uq_user_vocabulary (profile_id, vocabulary_id),
  KEY idx_user_vocabulary_due (profile_id, next_review_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Phase 4 (listening/speaking): attempts are REAL records — listening graded
-- against bank answers; speaking graded against the actual transcript the
-- speech provider returned. Pronunciation/fluency scores are NEVER stored:
-- they require a pronunciation-assessment provider (not configured).
CREATE TABLE IF NOT EXISTS listening_attempts (
  id              VARCHAR(36) PRIMARY KEY,
  profile_id      INT NOT NULL,
  user_id         INT NOT NULL,
  language_code   VARCHAR(8) NOT NULL,
  exercise_item_id VARCHAR(20) NOT NULL,        -- bank reading item id
  mode            VARCHAR(14) NOT NULL,          -- comprehension|transcription
  score_pct       DECIMAL(5,2) NULL,
  passed          TINYINT(1) NULL,
  detail          LONGTEXT NOT NULL,             -- question/transcript given vs expected, similarity
  created_at      VARCHAR(32) NOT NULL,
  KEY idx_listening_profile (profile_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS speaking_attempts (
  id              VARCHAR(36) PRIMARY KEY,
  profile_id      INT NOT NULL,
  user_id         INT NOT NULL,
  language_code   VARCHAR(8) NOT NULL,
  prompt_text     VARCHAR(400) NOT NULL,
  transcript      TEXT NULL,                     -- exactly what the speech provider returned
  word_accuracy_pct DECIMAL(5,2) NULL,           -- real: expected words present in transcript
  exact_match     TINYINT(1) NOT NULL DEFAULT 0,
  provider        VARCHAR(24) NOT NULL DEFAULT 'none',  -- browser_webspeech|none|…
  detail          LONGTEXT NOT NULL,
  created_at      VARCHAR(32) NOT NULL,
  KEY idx_speaking_profile (profile_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Phase 5 (adaptive learning): daily plans + AI recommendations. Every item
-- is derived from stored activity; evidence is cited; nothing is invented.
CREATE TABLE IF NOT EXISTS daily_learning_plans (
  id            VARCHAR(36) PRIMARY KEY,
  profile_id    INT NOT NULL,
  user_id       INT NOT NULL,
  language_code VARCHAR(8) NOT NULL,
  day           VARCHAR(10) NOT NULL,            -- UTC date
  plan          LONGTEXT NOT NULL,               -- blocks with evidence + completion
  est_minutes   INT NOT NULL DEFAULT 0,
  created_at    VARCHAR(32) NOT NULL,
  UNIQUE KEY uq_daily_plan (profile_id, day)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS ai_learning_recommendations (
  id            VARCHAR(36) PRIMARY KEY,
  profile_id    INT NOT NULL,
  user_id       INT NOT NULL,
  language_code VARCHAR(8) NOT NULL,
  kind          VARCHAR(24) NOT NULL,            -- weakness|retention|module|engagement
  message       VARCHAR(400) NOT NULL,
  evidence      LONGTEXT NOT NULL,
  status        VARCHAR(12) NOT NULL DEFAULT 'ACTIVE',
  created_at    VARCHAR(32) NOT NULL,
  KEY idx_reco_profile (profile_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- =====================================================================
-- application/database/lottery.mysql.sql (canonical production schema)
-- =====================================================================
-- WINDELS Lottery Intelligence persistence: provider-neutral, source-attributed records.
CREATE TABLE IF NOT EXISTS lotteries (
 id INT AUTO_INCREMENT PRIMARY KEY, code VARCHAR(32) NOT NULL UNIQUE, name VARCHAR(120) NOT NULL,
 enabled TINYINT(1) NOT NULL DEFAULT 1, rules_version VARCHAR(16) NOT NULL,
 created_at VARCHAR(32) NOT NULL, updated_at VARCHAR(32) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS lottery_rules (
 id INT AUTO_INCREMENT PRIMARY KEY, lottery_code VARCHAR(32) NOT NULL, version VARCHAR(16) NOT NULL,
 main_count INT NOT NULL, main_min INT NOT NULL, main_max INT NOT NULL,
 star_count INT NOT NULL, star_min INT NOT NULL, star_max INT NOT NULL,
 schedule VARCHAR(255) NOT NULL, active TINYINT(1) NOT NULL DEFAULT 1,
 created_at VARCHAR(32) NOT NULL, UNIQUE KEY uq_lottery_rules (lottery_code, version)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS lottery_data_sources (
 id INT AUTO_INCREMENT PRIMARY KEY, provider_code VARCHAR(64) NOT NULL UNIQUE, display_name VARCHAR(120) NOT NULL,
 enabled TINYINT(1) NOT NULL DEFAULT 0, synthetic TINYINT(1) NOT NULL DEFAULT 0,
 created_at VARCHAR(32) NOT NULL, updated_at VARCHAR(32) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS lottery_provider_health (
 id BIGINT AUTO_INCREMENT PRIMARY KEY, provider_id INT NOT NULL, status VARCHAR(32) NOT NULL,
 response_ms INT NULL, records_received INT NOT NULL DEFAULT 0, invalid_records INT NOT NULL DEFAULT 0,
 error_rate DECIMAL(8,5) NULL, last_success_at VARCHAR(32) NULL, last_failure_at VARCHAR(32) NULL,
 last_draw_retrieved VARCHAR(32) NULL, data_freshness_seconds INT NULL, synthetic TINYINT(1) NOT NULL DEFAULT 0,
 observed_at VARCHAR(32) NOT NULL, KEY idx_lottery_provider_health (provider_id, observed_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS lottery_draws (
 id BIGINT AUTO_INCREMENT PRIMARY KEY, lottery_code VARCHAR(32) NOT NULL, provider_id INT NULL,
 external_id VARCHAR(64) NOT NULL, draw_date DATE NOT NULL, jackpot VARCHAR(32) NULL,
 rollover TINYINT(1) NOT NULL DEFAULT 0, source VARCHAR(120) NOT NULL, source_timestamp VARCHAR(40) NOT NULL,
 retrieved_at VARCHAR(32) NOT NULL, verification_status VARCHAR(32) NOT NULL, payload MEDIUMTEXT NOT NULL,
 created_at VARCHAR(32) NOT NULL, updated_at VARCHAR(32) NOT NULL,
 UNIQUE KEY uq_lottery_draws (lottery_code, external_id), KEY idx_lottery_draws_date (lottery_code, draw_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS lottery_draw_numbers (
 id BIGINT AUTO_INCREMENT PRIMARY KEY, draw_id BIGINT NOT NULL, kind VARCHAR(8) NOT NULL,
 position INT NOT NULL, number INT NOT NULL, KEY idx_lottery_draw_numbers_draw (draw_id, kind, position)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS lottery_sync_runs (
 id VARCHAR(64) PRIMARY KEY, provider_id INT NULL, job_type VARCHAR(40) NOT NULL, status VARCHAR(32) NOT NULL,
 started_at VARCHAR(32) NOT NULL, ended_at VARCHAR(32) NULL,
 records_processed INT NOT NULL DEFAULT 0, records_created INT NOT NULL DEFAULT 0, records_updated INT NOT NULL DEFAULT 0,
 errors TEXT NULL, payload MEDIUMTEXT NULL, execution_key VARCHAR(128) NOT NULL UNIQUE, KEY idx_lottery_sync_runs_job (job_type, started_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS lottery_combinations (
 id BIGINT AUTO_INCREMENT PRIMARY KEY, lottery_code VARCHAR(32) NOT NULL, `mode` VARCHAR(32) NOT NULL,
 model_version VARCHAR(64) NOT NULL, seed VARCHAR(32) NULL, line_count INT NOT NULL DEFAULT 0,
 `lines` MEDIUMTEXT NOT NULL, `constraints` MEDIUMTEXT NOT NULL, score_summary MEDIUMTEXT NOT NULL,
 created_by INT NULL, created_at VARCHAR(32) NOT NULL, KEY idx_lottery_combinations_code (lottery_code, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS lottery_ai_decisions (
 id BIGINT AUTO_INCREMENT PRIMARY KEY, lottery_code VARCHAR(32) NOT NULL, combination_id BIGINT NULL,
 model_version VARCHAR(64) NOT NULL, mode VARCHAR(32) NULL, decision MEDIUMTEXT NOT NULL,
 created_at VARCHAR(32) NOT NULL, KEY idx_lottery_ai_decisions_comb (combination_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS lottery_tickets (
 id BIGINT AUTO_INCREMENT PRIMARY KEY, user_id INT NOT NULL, lottery_code VARCHAR(32) NOT NULL,
 name VARCHAR(120) NOT NULL, draw_date DATE NULL, generation_method VARCHAR(32) NOT NULL,
 model_version VARCHAR(64) NOT NULL, configuration MEDIUMTEXT NOT NULL,
 status VARCHAR(16) NOT NULL DEFAULT 'OPEN', result MEDIUMTEXT NULL,
 created_at VARCHAR(32) NOT NULL, updated_at VARCHAR(32) NOT NULL,
 KEY idx_lottery_tickets_user (user_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS lottery_ticket_lines (
 id BIGINT AUTO_INCREMENT PRIMARY KEY, ticket_id BIGINT NOT NULL, position INT NOT NULL,
 mains TEXT NOT NULL, stars TEXT NOT NULL, created_at VARCHAR(32) NOT NULL,
 KEY idx_lottery_ticket_lines_ticket (ticket_id, position)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS lottery_backtests (
 id BIGINT AUTO_INCREMENT PRIMARY KEY, lottery_code VARCHAR(32) NOT NULL, strategy VARCHAR(40) NOT NULL,
 model_version VARCHAR(64) NOT NULL, lines_per_draw INT NOT NULL DEFAULT 1, draws_tested INT NOT NULL DEFAULT 0,
 period_from DATE NULL, period_to DATE NULL, dataset_version VARCHAR(128) NULL,
 report MEDIUMTEXT NOT NULL, created_at VARCHAR(32) NOT NULL,
 KEY idx_lottery_backtests_strategy (strategy, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS lottery_model_versions (
 id BIGINT AUTO_INCREMENT PRIMARY KEY, model_name VARCHAR(64) NOT NULL, model_version VARCHAR(16) NOT NULL,
 config MEDIUMTEXT NOT NULL, dataset_version VARCHAR(128) NULL, status VARCHAR(16) NOT NULL DEFAULT 'ACTIVE',
 created_at VARCHAR(32) NOT NULL, UNIQUE KEY uq_lottery_model_versions (model_name, model_version)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Additional indexes used by the scheduled sports pipeline.
CREATE INDEX idx_sports_matches_provider_kickoff ON sports_matches (provider_id, kickoff_at);
CREATE INDEX idx_sports_predictions_market ON sports_predictions (market, created_at);
CREATE INDEX idx_sports_selections_market ON sports_ticket_selections (market, selection);
CREATE INDEX idx_sports_selections_match ON sports_ticket_selections (match_id);
CREATE INDEX idx_sports_predictions_created ON sports_predictions (created_at);
CREATE INDEX idx_sports_health_provider ON sports_provider_health (provider_id, observed_at);

-- =====================================================================
-- Complete foreign-key graph (added after all tables exist)
-- =====================================================================
ALTER TABLE journal_entries ADD CONSTRAINT fk_journal_backtest FOREIGN KEY (backtest_id) REFERENCES backtests (id);
ALTER TABLE journal_entries ADD CONSTRAINT fk_journal_paper_position FOREIGN KEY (paper_position_id) REFERENCES paper_positions (id);
ALTER TABLE paper_orders ADD CONSTRAINT fk_paper_orders_account FOREIGN KEY (account_id) REFERENCES paper_accounts (id);
ALTER TABLE paper_positions ADD CONSTRAINT fk_paper_positions_account FOREIGN KEY (account_id) REFERENCES paper_accounts (id);
ALTER TABLE paper_trades ADD CONSTRAINT fk_paper_trades_account FOREIGN KEY (account_id) REFERENCES paper_accounts (id);
ALTER TABLE paper_trades ADD CONSTRAINT fk_paper_trades_order FOREIGN KEY (order_id) REFERENCES paper_orders (id);
ALTER TABLE paper_trades ADD CONSTRAINT fk_paper_trades_position FOREIGN KEY (position_id) REFERENCES paper_positions (id);
ALTER TABLE paper_deployments ADD CONSTRAINT fk_paper_deployments_account FOREIGN KEY (account_id) REFERENCES paper_accounts (id);
ALTER TABLE paper_deployments ADD CONSTRAINT fk_paper_deployments_strategy FOREIGN KEY (strategy_id, strategy_version) REFERENCES strategies (strategy_id, version);
ALTER TABLE trade_executions ADD CONSTRAINT fk_trade_executions_proposal FOREIGN KEY (proposal_id) REFERENCES trade_proposals (id);
ALTER TABLE notifications ADD CONSTRAINT fk_notifications_user FOREIGN KEY (user_id) REFERENCES users (id);
ALTER TABLE user_roles ADD CONSTRAINT fk_user_roles_user FOREIGN KEY (user_id) REFERENCES users (id);
ALTER TABLE user_roles ADD CONSTRAINT fk_user_roles_role FOREIGN KEY (role_id) REFERENCES roles (id);
ALTER TABLE role_permissions ADD CONSTRAINT fk_role_permissions_role FOREIGN KEY (role_id) REFERENCES roles (id);
ALTER TABLE role_permissions ADD CONSTRAINT fk_role_permissions_permission FOREIGN KEY (permission_id) REFERENCES permissions (id);
ALTER TABLE auth_events ADD CONSTRAINT fk_auth_events_user FOREIGN KEY (user_id) REFERENCES users (id);
ALTER TABLE leads ADD CONSTRAINT fk_leads_org FOREIGN KEY (organization_id) REFERENCES lead_organizations (id);
ALTER TABLE leads ADD CONSTRAINT fk_leads_owner FOREIGN KEY (owner_id) REFERENCES users (id);
ALTER TABLE lead_notes ADD CONSTRAINT fk_lead_notes_lead FOREIGN KEY (lead_id) REFERENCES leads (id);
ALTER TABLE lead_notes ADD CONSTRAINT fk_lead_notes_org FOREIGN KEY (organization_id) REFERENCES lead_organizations (id);
ALTER TABLE lead_notes ADD CONSTRAINT fk_lead_notes_author FOREIGN KEY (author_id) REFERENCES users (id);
ALTER TABLE lead_activities ADD CONSTRAINT fk_lead_activities_lead FOREIGN KEY (lead_id) REFERENCES leads (id);
ALTER TABLE lead_activities ADD CONSTRAINT fk_lead_activities_org FOREIGN KEY (organization_id) REFERENCES lead_organizations (id);
ALTER TABLE lead_activities ADD CONSTRAINT fk_lead_activities_actor FOREIGN KEY (actor_id) REFERENCES users (id);
ALTER TABLE collections ADD CONSTRAINT fk_collections_org FOREIGN KEY (organization_id) REFERENCES lead_organizations (id);
ALTER TABLE collection_leads ADD CONSTRAINT fk_collection_leads_collection FOREIGN KEY (collection_id) REFERENCES collections (id);
ALTER TABLE collection_leads ADD CONSTRAINT fk_collection_leads_lead FOREIGN KEY (lead_id) REFERENCES leads (id);
ALTER TABLE search_history ADD CONSTRAINT fk_search_history_org FOREIGN KEY (organization_id) REFERENCES lead_organizations (id);
ALTER TABLE search_history ADD CONSTRAINT fk_search_history_user FOREIGN KEY (user_id) REFERENCES users (id);
ALTER TABLE duplicate_candidates ADD CONSTRAINT fk_duplicate_candidates_org FOREIGN KEY (organization_id) REFERENCES lead_organizations (id);
ALTER TABLE duplicate_candidates ADD CONSTRAINT fk_duplicate_candidates_a FOREIGN KEY (lead_a_id) REFERENCES leads (id);
ALTER TABLE duplicate_candidates ADD CONSTRAINT fk_duplicate_candidates_b FOREIGN KEY (lead_b_id) REFERENCES leads (id);
ALTER TABLE duplicate_resolutions ADD CONSTRAINT fk_duplicate_resolutions_candidate FOREIGN KEY (candidate_id) REFERENCES duplicate_candidates (id);
ALTER TABLE duplicate_resolutions ADD CONSTRAINT fk_duplicate_resolutions_org FOREIGN KEY (organization_id) REFERENCES lead_organizations (id);
ALTER TABLE duplicate_resolutions ADD CONSTRAINT fk_duplicate_resolutions_user FOREIGN KEY (resolver_id) REFERENCES users (id);
ALTER TABLE export_history ADD CONSTRAINT fk_export_history_org FOREIGN KEY (organization_id) REFERENCES lead_organizations (id);
ALTER TABLE export_history ADD CONSTRAINT fk_export_history_user FOREIGN KEY (user_id) REFERENCES users (id);
ALTER TABLE lead_organization_members ADD CONSTRAINT fk_lead_members_org FOREIGN KEY (organization_id) REFERENCES lead_organizations (id);
ALTER TABLE lead_organization_members ADD CONSTRAINT fk_lead_members_user FOREIGN KEY (user_id) REFERENCES users (id);
ALTER TABLE sports_provider_health ADD CONSTRAINT fk_sports_health_provider FOREIGN KEY (provider_id) REFERENCES sports_data_sources (id);
ALTER TABLE sports_matches ADD CONSTRAINT fk_sports_matches_provider FOREIGN KEY (provider_id) REFERENCES sports_data_sources (id);
ALTER TABLE sports_odds ADD CONSTRAINT fk_sports_odds_match FOREIGN KEY (match_id) REFERENCES sports_matches (id);
ALTER TABLE sports_odds ADD CONSTRAINT fk_sports_odds_provider FOREIGN KEY (provider_id) REFERENCES sports_data_sources (id);
ALTER TABLE sports_data_quality_assessments ADD CONSTRAINT fk_sports_quality_match FOREIGN KEY (match_id) REFERENCES sports_matches (id);
ALTER TABLE sports_sync_runs ADD CONSTRAINT fk_sports_sync_provider FOREIGN KEY (provider_id) REFERENCES sports_data_sources (id);
ALTER TABLE sports_calibrations ADD CONSTRAINT fk_sports_calibration_model FOREIGN KEY (model_version_id) REFERENCES sports_model_versions (id);
ALTER TABLE sports_predictions ADD CONSTRAINT fk_sports_predictions_match FOREIGN KEY (match_id) REFERENCES sports_matches (id);
ALTER TABLE sports_predictions ADD CONSTRAINT fk_sports_predictions_model FOREIGN KEY (model_version_id) REFERENCES sports_model_versions (id);
ALTER TABLE sports_tickets ADD CONSTRAINT fk_sports_tickets_model FOREIGN KEY (model_version_id) REFERENCES sports_model_versions (id);
ALTER TABLE sports_ticket_selections ADD CONSTRAINT fk_sports_selection_ticket FOREIGN KEY (ticket_id) REFERENCES sports_tickets (id);
ALTER TABLE sports_ticket_selections ADD CONSTRAINT fk_sports_selection_prediction FOREIGN KEY (prediction_id) REFERENCES sports_predictions (id);
ALTER TABLE sports_ticket_selections ADD CONSTRAINT fk_sports_selection_match FOREIGN KEY (match_id) REFERENCES sports_matches (id);
ALTER TABLE sports_results ADD CONSTRAINT fk_sports_results_match FOREIGN KEY (match_id) REFERENCES sports_matches (id);
ALTER TABLE sports_results ADD CONSTRAINT fk_sports_results_provider FOREIGN KEY (provider_id) REFERENCES sports_data_sources (id);
ALTER TABLE sports_model_metrics ADD CONSTRAINT fk_sports_metrics_model FOREIGN KEY (model_version_id) REFERENCES sports_model_versions (id);
ALTER TABLE language_assessments ADD CONSTRAINT fk_language_assessments_profile FOREIGN KEY (profile_id) REFERENCES user_language_profiles (id);
ALTER TABLE language_assessments ADD CONSTRAINT fk_language_assessments_user FOREIGN KEY (user_id) REFERENCES users (id);
ALTER TABLE language_assessments ADD CONSTRAINT fk_language_assessments_language FOREIGN KEY (language_code) REFERENCES languages (code);
ALTER TABLE user_language_profiles ADD CONSTRAINT fk_profiles_user FOREIGN KEY (user_id) REFERENCES users (id);
ALTER TABLE user_language_profiles ADD CONSTRAINT fk_profiles_language FOREIGN KEY (language_code) REFERENCES languages (code);
ALTER TABLE learning_paths ADD CONSTRAINT fk_learning_paths_profile FOREIGN KEY (profile_id) REFERENCES user_language_profiles (id);
ALTER TABLE learning_paths ADD CONSTRAINT fk_learning_paths_language FOREIGN KEY (language_code) REFERENCES languages (code);
ALTER TABLE learning_modules ADD CONSTRAINT fk_learning_modules_path FOREIGN KEY (path_id) REFERENCES learning_paths (id);
ALTER TABLE learning_modules ADD CONSTRAINT fk_learning_modules_profile FOREIGN KEY (profile_id) REFERENCES user_language_profiles (id);
ALTER TABLE learning_modules ADD CONSTRAINT fk_learning_modules_language FOREIGN KEY (language_code) REFERENCES languages (code);
ALTER TABLE lesson_attempts ADD CONSTRAINT fk_lesson_attempts_profile FOREIGN KEY (profile_id) REFERENCES user_language_profiles (id);
ALTER TABLE lesson_attempts ADD CONSTRAINT fk_lesson_attempts_user FOREIGN KEY (user_id) REFERENCES users (id);
ALTER TABLE lesson_attempts ADD CONSTRAINT fk_lesson_attempts_language FOREIGN KEY (language_code) REFERENCES languages (code);
ALTER TABLE study_sessions ADD CONSTRAINT fk_study_sessions_profile FOREIGN KEY (profile_id) REFERENCES user_language_profiles (id);
ALTER TABLE study_sessions ADD CONSTRAINT fk_study_sessions_user FOREIGN KEY (user_id) REFERENCES users (id);
ALTER TABLE study_sessions ADD CONSTRAINT fk_study_sessions_language FOREIGN KEY (language_code) REFERENCES languages (code);
ALTER TABLE language_progress ADD CONSTRAINT fk_language_progress_profile FOREIGN KEY (profile_id) REFERENCES user_language_profiles (id);
ALTER TABLE language_progress ADD CONSTRAINT fk_language_progress_user FOREIGN KEY (user_id) REFERENCES users (id);
ALTER TABLE language_progress ADD CONSTRAINT fk_language_progress_language FOREIGN KEY (language_code) REFERENCES languages (code);
ALTER TABLE conversation_sessions ADD CONSTRAINT fk_conversation_profile FOREIGN KEY (profile_id) REFERENCES user_language_profiles (id);
ALTER TABLE conversation_sessions ADD CONSTRAINT fk_conversation_user FOREIGN KEY (user_id) REFERENCES users (id);
ALTER TABLE conversation_sessions ADD CONSTRAINT fk_conversation_language FOREIGN KEY (language_code) REFERENCES languages (code);
ALTER TABLE writing_attempts ADD CONSTRAINT fk_writing_profile FOREIGN KEY (profile_id) REFERENCES user_language_profiles (id);
ALTER TABLE writing_attempts ADD CONSTRAINT fk_writing_user FOREIGN KEY (user_id) REFERENCES users (id);
ALTER TABLE writing_attempts ADD CONSTRAINT fk_writing_language FOREIGN KEY (language_code) REFERENCES languages (code);
ALTER TABLE vocabulary ADD CONSTRAINT fk_vocabulary_language FOREIGN KEY (language_code) REFERENCES languages (code);
ALTER TABLE user_vocabulary ADD CONSTRAINT fk_user_vocabulary_profile FOREIGN KEY (profile_id) REFERENCES user_language_profiles (id);
ALTER TABLE user_vocabulary ADD CONSTRAINT fk_user_vocabulary_user FOREIGN KEY (user_id) REFERENCES users (id);
ALTER TABLE user_vocabulary ADD CONSTRAINT fk_user_vocabulary_word FOREIGN KEY (vocabulary_id) REFERENCES vocabulary (id);
ALTER TABLE listening_attempts ADD CONSTRAINT fk_listening_profile FOREIGN KEY (profile_id) REFERENCES user_language_profiles (id);
ALTER TABLE listening_attempts ADD CONSTRAINT fk_listening_user FOREIGN KEY (user_id) REFERENCES users (id);
ALTER TABLE listening_attempts ADD CONSTRAINT fk_listening_language FOREIGN KEY (language_code) REFERENCES languages (code);
ALTER TABLE speaking_attempts ADD CONSTRAINT fk_speaking_profile FOREIGN KEY (profile_id) REFERENCES user_language_profiles (id);
ALTER TABLE speaking_attempts ADD CONSTRAINT fk_speaking_user FOREIGN KEY (user_id) REFERENCES users (id);
ALTER TABLE speaking_attempts ADD CONSTRAINT fk_speaking_language FOREIGN KEY (language_code) REFERENCES languages (code);
ALTER TABLE daily_learning_plans ADD CONSTRAINT fk_daily_plans_profile FOREIGN KEY (profile_id) REFERENCES user_language_profiles (id);
ALTER TABLE daily_learning_plans ADD CONSTRAINT fk_daily_plans_user FOREIGN KEY (user_id) REFERENCES users (id);
ALTER TABLE daily_learning_plans ADD CONSTRAINT fk_daily_plans_language FOREIGN KEY (language_code) REFERENCES languages (code);
ALTER TABLE ai_learning_recommendations ADD CONSTRAINT fk_learning_recommendations_profile FOREIGN KEY (profile_id) REFERENCES user_language_profiles (id);
ALTER TABLE ai_learning_recommendations ADD CONSTRAINT fk_learning_recommendations_user FOREIGN KEY (user_id) REFERENCES users (id);
ALTER TABLE ai_learning_recommendations ADD CONSTRAINT fk_learning_recommendations_language FOREIGN KEY (language_code) REFERENCES languages (code);
ALTER TABLE sports_daily_tickets ADD CONSTRAINT fk_sports_daily_ticket FOREIGN KEY (ticket_id) REFERENCES sports_tickets (id);
ALTER TABLE sports_daily_tickets ADD CONSTRAINT fk_sports_daily_config FOREIGN KEY (configuration_version) REFERENCES sports_configurations (version);
ALTER TABLE sports_daily_tickets ADD CONSTRAINT fk_sports_daily_run FOREIGN KEY (run_id) REFERENCES sports_job_runs (id);
ALTER TABLE lottery_rules ADD CONSTRAINT fk_lottery_rules_lottery FOREIGN KEY (lottery_code) REFERENCES lotteries (code);
ALTER TABLE lottery_provider_health ADD CONSTRAINT fk_lottery_health_provider FOREIGN KEY (provider_id) REFERENCES lottery_data_sources (id);
ALTER TABLE lottery_draws ADD CONSTRAINT fk_lottery_draws_lottery FOREIGN KEY (lottery_code) REFERENCES lotteries (code);
ALTER TABLE lottery_draws ADD CONSTRAINT fk_lottery_draws_provider FOREIGN KEY (provider_id) REFERENCES lottery_data_sources (id);
ALTER TABLE lottery_draw_numbers ADD CONSTRAINT fk_lottery_draw_numbers_draw FOREIGN KEY (draw_id) REFERENCES lottery_draws (id);
ALTER TABLE lottery_sync_runs ADD CONSTRAINT fk_lottery_sync_provider FOREIGN KEY (provider_id) REFERENCES lottery_data_sources (id);
ALTER TABLE lottery_combinations ADD CONSTRAINT fk_lottery_combinations_lottery FOREIGN KEY (lottery_code) REFERENCES lotteries (code);
ALTER TABLE lottery_ai_decisions ADD CONSTRAINT fk_lottery_ai_lottery FOREIGN KEY (lottery_code) REFERENCES lotteries (code);
ALTER TABLE lottery_ai_decisions ADD CONSTRAINT fk_lottery_ai_combination FOREIGN KEY (combination_id) REFERENCES lottery_combinations (id);
ALTER TABLE lottery_tickets ADD CONSTRAINT fk_lottery_tickets_user FOREIGN KEY (user_id) REFERENCES users (id);
ALTER TABLE lottery_tickets ADD CONSTRAINT fk_lottery_tickets_lottery FOREIGN KEY (lottery_code) REFERENCES lotteries (code);
ALTER TABLE lottery_ticket_lines ADD CONSTRAINT fk_lottery_ticket_lines_ticket FOREIGN KEY (ticket_id) REFERENCES lottery_tickets (id);
ALTER TABLE lottery_backtests ADD CONSTRAINT fk_lottery_backtests_lottery FOREIGN KEY (lottery_code) REFERENCES lotteries (code);

-- =====================================================================
-- Default application state and reference data
-- =====================================================================
INSERT INTO platform_state (k,v) VALUES ('state', '{"tradingMode":"ANALYSIS_ONLY","killSwitch":{"active":true,"activatedAt":null,"reason":"Default state at boot — orders blocked until explicitly released"},"allowSyntheticPaperData":false}') ON DUPLICATE KEY UPDATE v=VALUES(v);
INSERT INTO strategies (strategy_id,version,name,description,market_classes,timeframes,params,source,lifecycle,created_at,updated_at,lifecycle_history) VALUES ('trend-following','1.0.0','Trend Following (EMA cross + ADX)','Long when EMA20 crosses above EMA50 with ADX >= threshold; exit on opposite cross. Stops at ATR multiple, targets at R multiple.','["forex","crypto","stock","etf","commodity","futures","indices"]','["5m","15m","1h","4h","1d"]','{"fast":20,"slow":50,"adxMin":25,"stopAtr":2,"targetR":3}','builtin','DRAFT','2026-08-24T00:00:00Z','2026-08-24T00:00:00Z','[{"from":null,"to":"DRAFT","at":"2026-08-24T00:00:00Z","reason":"registered"}]') ON DUPLICATE KEY UPDATE strategy_id=strategy_id;
INSERT INTO strategies (strategy_id,version,name,description,market_classes,timeframes,params,source,lifecycle,created_at,updated_at,lifecycle_history) VALUES ('mean-reversion','1.0.0','Mean Reversion (Bollinger + RSI)','Buys lower-band pierces with oversold RSI in a non-trending regime; exits at the mean or stop.','["forex","crypto","stock","etf","indices"]','["15m","1h","4h","1d"]','{"period":20,"std":2,"rsiMin":30,"rsiMax":70,"stopAtr":1.5,"targetR":2}','builtin','DRAFT','2026-08-24T00:00:00Z','2026-08-24T00:00:00Z','[{"from":null,"to":"DRAFT","at":"2026-08-24T00:00:00Z","reason":"registered"}]') ON DUPLICATE KEY UPDATE strategy_id=strategy_id;
INSERT INTO strategies (strategy_id,version,name,description,market_classes,timeframes,params,source,lifecycle,created_at,updated_at,lifecycle_history) VALUES ('breakout','1.0.0','Breakout (range + volume confirmation)','Trades close-confirmed range breaks only when volume confirms the move.','["forex","crypto","stock","etf","futures","indices"]','["15m","1h","4h","1d"]','{"lookback":20,"volumeMultiplier":1.2,"stopAtr":2,"targetR":3}','builtin','DRAFT','2026-08-24T00:00:00Z','2026-08-24T00:00:00Z','[{"from":null,"to":"DRAFT","at":"2026-08-24T00:00:00Z","reason":"registered"}]') ON DUPLICATE KEY UPDATE strategy_id=strategy_id;
INSERT INTO strategies (strategy_id,version,name,description,market_classes,timeframes,params,source,lifecycle,created_at,updated_at,lifecycle_history) VALUES ('momentum','1.0.0','Momentum (ROC + MACD)','Trades strong rate-of-change with a confirming MACD histogram and exits on momentum flip.','["forex","crypto","stock","etf","futures","indices"]','["15m","1h","4h","1d"]','{"rocPeriod":12,"minRoc":0.005,"stopAtr":2,"targetR":2}','builtin','DRAFT','2026-08-24T00:00:00Z','2026-08-24T00:00:00Z','[{"from":null,"to":"DRAFT","at":"2026-08-24T00:00:00Z","reason":"registered"}]') ON DUPLICATE KEY UPDATE strategy_id=strategy_id;
INSERT INTO roles (id,code,name) VALUES (1,'super_admin','Super administrator'),(2,'sports_admin','Sports administrator'),(3,'sports_viewer','Sports viewer'),(4,'trading_operator','Trading operator (control + execution)'),(5,'trading_viewer','Trading viewer (read-only)'),(6,'lottery_admin','Lottery administrator'),(7,'lottery_viewer','Lottery viewer') ON DUPLICATE KEY UPDATE name=VALUES(name);
INSERT INTO permissions (id,code,name) VALUES (1,'system.super_admin','Full platform administration'),(2,'sports.view','View sports intelligence'),(3,'sports.manage','Manage sports providers and configuration'),(4,'sports.approve','Approve sports tickets'),(5,'sports.settle','Override sports settlements'),(6,'trading.view','View trading status, proposals and executions'),(7,'trading.control','Kill switch, trading mode, risk and automation limits'),(8,'trading.execute','Propose, approve and route trades through the Execution Supervisor'),(9,'lottery.view','View lottery intelligence (draws, statistics, tickets, performance)'),(10,'lottery.manage','Manage lottery providers, data sync and configuration') ON DUPLICATE KEY UPDATE name=VALUES(name);
INSERT INTO role_permissions (role_id,permission_id) VALUES (1,1),(1,2),(1,3),(1,4),(1,5),(1,6),(1,7),(1,8),(1,9),(1,10),(2,2),(2,3),(2,4),(2,5),(3,2),(4,6),(4,7),(4,8),(5,6),(6,9),(6,10),(7,9) ON DUPLICATE KEY UPDATE role_id=VALUES(role_id);
INSERT INTO users (id,email,password_hash,display_name,active,created_at,updated_at,last_login_at) VALUES (1,'admin@example.com','$2y$10$HAHKZ9rxRYLC3Zd2rJiykex19ZmZybcyXgzfHBJRcMB55VmU8Ti4O','Platform Administrator',1,'2026-08-24T00:00:00Z','2026-08-24T00:00:00Z',NULL) ON DUPLICATE KEY UPDATE email=VALUES(email);
INSERT INTO user_roles (user_id,role_id) VALUES (1,1) ON DUPLICATE KEY UPDATE user_id=VALUES(user_id);
INSERT INTO lead_organizations (id,name,created_at) VALUES ('org-1','Administrator workspace','2026-08-24T00:00:00Z') ON DUPLICATE KEY UPDATE name=VALUES(name);
INSERT INTO lead_organization_members (organization_id,user_id,role,created_at) VALUES ('org-1',1,'owner','2026-08-24T00:00:00Z') ON DUPLICATE KEY UPDATE role=VALUES(role);
INSERT INTO sports_data_sources (provider_code,display_name,enabled,created_at,updated_at) VALUES ('manual','Manual / approved source',0,'2026-08-24T00:00:00Z','2026-08-24T00:00:00Z') ON DUPLICATE KEY UPDATE display_name=VALUES(display_name);
INSERT INTO sports_configurations (version,module_enabled,ticket_engine_enabled,platform_mode,engine_mode,target_odds_min,target_odds_max,max_selections,risk_level,min_confidence,min_expected_value,max_correlation,min_data_quality,min_liquidity,allowed_markets,allowed_leagues,max_exposure,stake_amount,void_policy,require_calibration,updated_by,reason,created_at) VALUES (0,1,1,'SANDBOX','USER_APPROVAL_REQUIRED',5.0,8.0,5,'CONSERVATIVE',75,0.02,'MEDIUM',80,NULL,'[]','[]',100,10,'RESTITUTE_ODDS',1,'system','built-in defaults','2026-08-24 00:00:00') ON DUPLICATE KEY UPDATE version=VALUES(version);
INSERT INTO lotteries (code,name,enabled,rules_version,created_at,updated_at) VALUES ('EUROMILLIONS','EuroMillions',1,'1.0','2026-08-24T00:00:00Z','2026-08-24T00:00:00Z') ON DUPLICATE KEY UPDATE name=VALUES(name),rules_version=VALUES(rules_version);
INSERT INTO lottery_rules (lottery_code,version,main_count,main_min,main_max,star_count,star_min,star_max,schedule,active,created_at) VALUES ('EUROMILLIONS','1.0',5,1,50,2,1,12,'{"days":[2,5],"time":"21:00","timezone":"UTC"}',1,'2026-08-24T00:00:00Z') ON DUPLICATE KEY UPDATE active=VALUES(active);
INSERT INTO lottery_data_sources (provider_code,display_name,enabled,synthetic,created_at,updated_at) VALUES ('official-euromillions','Authorized EuroMillions feed',0,0,'2026-08-24T00:00:00Z','2026-08-24T00:00:00Z'),('unconfigured','No lottery data provider configured',0,0,'2026-08-24T00:00:00Z','2026-08-24T00:00:00Z') ON DUPLICATE KEY UPDATE display_name=VALUES(display_name);
INSERT INTO lottery_model_versions (model_name,model_version,config,dataset_version,status,created_at) VALUES ('WINDELS Lottery Model','1.0','{"scoreWeights":{"sum":0.3,"oddEven":0.2,"lowHigh":0.2,"spread":0.15,"consecutives":0.15},"generatorModes":["RANDOM","BALANCED","HISTORICAL","DIVERSIFIED","ANTI-POPULAR"],"backtestStrategies":["RANDOM_BASELINE","BALANCED_PROFILE","HISTORICAL_FREQ","ANTI_POPULAR"]}','n=0;last=none','ACTIVE','2026-08-24T00:00:00Z') ON DUPLICATE KEY UPDATE config=VALUES(config),status='ACTIVE';
INSERT INTO languages (code,name,native_name,iso_code,writing_system,direction,features,active,updated_at) VALUES
('nl','Dutch','Nederlands','nl','latin','ltr','{"registry":true,"adaptive_assessment":true,"assessment_ceiling":"B1","assessment_bank":12,"lessons":false,"conversation":false,"writing_correction":false,"vocabulary_srs":false,"listening":false,"speaking":false}','1','2026-08-24T00:00:00Z'),
('es','Spanish','Español','es','latin','ltr','{"registry":true,"adaptive_assessment":true,"assessment_ceiling":"B1","assessment_bank":12,"lessons":false,"conversation":false,"writing_correction":false,"vocabulary_srs":false,"listening":false,"speaking":false}','1','2026-08-24T00:00:00Z'),
('it','Italian','Italiano','it','latin','ltr','{"registry":true,"adaptive_assessment":true,"assessment_ceiling":"B1","assessment_bank":12,"lessons":false,"conversation":false,"writing_correction":false,"vocabulary_srs":false,"listening":false,"speaking":false}','1','2026-08-24T00:00:00Z'),
('fr','French','Français','fr','latin','ltr','{"registry":true,"adaptive_assessment":true,"assessment_ceiling":"B1","assessment_bank":12,"lessons":false,"conversation":false,"writing_correction":false,"vocabulary_srs":false,"listening":false,"speaking":false}','1','2026-08-24T00:00:00Z'),
('de','German','Deutsch','de','latin','ltr','{"registry":true,"adaptive_assessment":true,"assessment_ceiling":"B1","assessment_bank":12,"lessons":false,"conversation":false,"writing_correction":false,"vocabulary_srs":false,"listening":false,"speaking":false}','1','2026-08-24T00:00:00Z'),
('en','English','English','en','latin','ltr','{"registry":true,"adaptive_assessment":true,"assessment_ceiling":"A2","assessment_bank":10,"lessons":false,"conversation":false,"writing_correction":false,"vocabulary_srs":false,"listening":false,"speaking":false}','1','2026-08-24T00:00:00Z'),
('pt','Portuguese','Português','pt','latin','ltr','{"registry":true,"adaptive_assessment":true,"assessment_ceiling":"B1","assessment_bank":12,"lessons":false,"conversation":false,"writing_correction":false,"vocabulary_srs":false,"listening":false,"speaking":false}','1','2026-08-24T00:00:00Z'),
('ar','Arabic','العربية','ar','arabic','rtl','{"registry":true,"adaptive_assessment":true,"assessment_ceiling":"A1","assessment_bank":5,"lessons":false,"conversation":false,"writing_correction":false,"vocabulary_srs":false,"listening":false,"speaking":false}','1','2026-08-24T00:00:00Z'),
('zh','Chinese (Mandarin)','中文','zh','han','ltr','{"registry":true,"adaptive_assessment":true,"assessment_ceiling":"A1","assessment_bank":5,"lessons":false,"conversation":false,"writing_correction":false,"vocabulary_srs":false,"listening":false,"speaking":false}','1','2026-08-24T00:00:00Z'),
('ja','Japanese','日本語','ja','kana','ltr','{"registry":true,"adaptive_assessment":true,"assessment_ceiling":"A1","assessment_bank":5,"lessons":false,"conversation":false,"writing_correction":false,"vocabulary_srs":false,"listening":false,"speaking":false}','1','2026-08-24T00:00:00Z'),
('ko','Korean','한국어','ko','hangul','ltr','{"registry":true,"adaptive_assessment":true,"assessment_ceiling":"A1","assessment_bank":5,"lessons":false,"conversation":false,"writing_correction":false,"vocabulary_srs":false,"listening":false,"speaking":false}','1','2026-08-24T00:00:00Z'),
('ru','Russian','Русский','ru','cyrillic','ltr','{"registry":true,"adaptive_assessment":true,"assessment_ceiling":"A1","assessment_bank":5,"lessons":false,"conversation":false,"writing_correction":false,"vocabulary_srs":false,"listening":false,"speaking":false}','1','2026-08-24T00:00:00Z'),
('hi','Hindi','हिन्दी','hi','devanagari','ltr','{"registry":true,"adaptive_assessment":true,"assessment_ceiling":"A1","assessment_bank":5,"lessons":false,"conversation":false,"writing_correction":false,"vocabulary_srs":false,"listening":false,"speaking":false}','1','2026-08-24T00:00:00Z'),
('tr','Turkish','Türkçe','tr','latin','ltr','{"registry":true,"adaptive_assessment":true,"assessment_ceiling":"A1","assessment_bank":5,"lessons":false,"conversation":false,"writing_correction":false,"vocabulary_srs":false,"listening":false,"speaking":false}','1','2026-08-24T00:00:00Z'),
('sw','Swahili','Kiswahili','sw','latin','ltr','{"registry":true,"adaptive_assessment":true,"assessment_ceiling":"A1","assessment_bank":5,"lessons":false,"conversation":false,"writing_correction":false,"vocabulary_srs":false,"listening":false,"speaking":false}','1','2026-08-24T00:00:00Z'),
('yo','Yoruba','Yorùbá','yo','latin','ltr','{"registry":true,"adaptive_assessment":true,"assessment_ceiling":"A1","assessment_bank":5,"lessons":false,"conversation":false,"writing_correction":false,"vocabulary_srs":false,"listening":false,"speaking":false}','1','2026-08-24T00:00:00Z'),
('ig','Igbo','Igbo','ig','latin','ltr','{"registry":true,"adaptive_assessment":true,"assessment_ceiling":"A1","assessment_bank":5,"lessons":false,"conversation":false,"writing_correction":false,"vocabulary_srs":false,"listening":false,"speaking":false}','1','2026-08-24T00:00:00Z'),
('ha','Hausa','Hausa','ha','latin','ltr','{"registry":true,"adaptive_assessment":true,"assessment_ceiling":"A1","assessment_bank":5,"lessons":false,"conversation":false,"writing_correction":false,"vocabulary_srs":false,"listening":false,"speaking":false}','1','2026-08-24T00:00:00Z'),
('af','Afrikaans','Afrikaans','af','latin','ltr','{"registry":true,"adaptive_assessment":true,"assessment_ceiling":"A1","assessment_bank":5,"lessons":false,"conversation":false,"writing_correction":false,"vocabulary_srs":false,"listening":false,"speaking":false}','1','2026-08-24T00:00:00Z'),
('zu','Zulu','isiZulu','zu','latin','ltr','{"registry":true,"adaptive_assessment":true,"assessment_ceiling":"A1","assessment_bank":5,"lessons":false,"conversation":false,"writing_correction":false,"vocabulary_srs":false,"listening":false,"speaking":false}','1','2026-08-24T00:00:00Z') ON DUPLICATE KEY UPDATE name=VALUES(name),native_name=VALUES(native_name),features=VALUES(features),active=VALUES(active),updated_at=VALUES(updated_at);
INSERT IGNORE INTO vocabulary (language_code,word,translation,pronunciation,example_sentence,category,level,active) VALUES
('nl','hallo','hello',NULL,'Hallo, ik heet Anna.','greetings','A1','1'),
('nl','goedemorgen','good morning',NULL,NULL,'greetings','A1','1'),
('nl','dank je wel','thank you',NULL,NULL,'courtesy','A1','1'),
('nl','tot ziens','goodbye',NULL,NULL,'courtesy','A1','1'),
('nl','ik','I',NULL,NULL,'people','A1','1'),
('nl','vijf','five',NULL,NULL,'numbers','A1','1'),
('nl','een','one',NULL,NULL,'numbers','A1','1'),
('nl','het huis','the house',NULL,NULL,'places','A1','1'),
('nl','de stad','the city',NULL,NULL,'places','A2','1'),
('nl','de afspraak','the appointment',NULL,NULL,'everyday','A2','1'),
('es','hola','hello',NULL,NULL,'greetings','A1','1'),
('es','buenos días','good morning',NULL,NULL,'greetings','A1','1'),
('es','gracias','thank you',NULL,NULL,'courtesy','A1','1'),
('es','adiós','goodbye',NULL,NULL,'courtesy','A1','1'),
('es','yo','I',NULL,NULL,'people','A1','1'),
('es','seis','six',NULL,NULL,'numbers','A1','1'),
('es','siete','seven',NULL,NULL,'numbers','A1','1'),
('es','ocho','eight',NULL,NULL,'numbers','A1','1'),
('es','el pueblo','the town / village',NULL,NULL,'places','A2','1'),
('es','la cita','the appointment',NULL,NULL,'everyday','A2','1'),
('it','buongiorno','good morning / hello',NULL,NULL,'greetings','A1','1'),
('it','grazie','thank you',NULL,NULL,'courtesy','A1','1'),
('it','arrivederci','goodbye',NULL,NULL,'courtesy','A1','1'),
('it','io','I',NULL,NULL,'people','A1','1'),
('it','sì','yes',NULL,NULL,'basics','A1','1'),
('it','no','no',NULL,NULL,'basics','A1','1'),
('it','tre','three',NULL,NULL,'numbers','A1','1'),
('it','cinque','five',NULL,NULL,'numbers','A1','1'),
('it','la città','the city',NULL,NULL,'places','A2','1'),
('it','l''appuntamento','the appointment',NULL,NULL,'everyday','A2','1'),
('fr','bonjour','hello / good day',NULL,NULL,'greetings','A1','1'),
('fr','merci','thank you',NULL,NULL,'courtesy','A1','1'),
('fr','au revoir','goodbye',NULL,NULL,'courtesy','A1','1'),
('fr','oui','yes',NULL,NULL,'basics','A1','1'),
('fr','non','no',NULL,NULL,'basics','A1','1'),
('fr','nous','we',NULL,NULL,'people','A1','1'),
('fr','quatre','four',NULL,NULL,'numbers','A1','1'),
('fr','deux','two',NULL,NULL,'numbers','A1','1'),
('fr','la ville','the city',NULL,NULL,'places','A2','1'),
('fr','un rendez-vous','an appointment',NULL,NULL,'everyday','A2','1'),
('de','hallo','hello',NULL,NULL,'greetings','A1','1'),
('de','guten Morgen','good morning',NULL,NULL,'greetings','A1','1'),
('de','danke','thank you',NULL,NULL,'courtesy','A1','1'),
('de','tschüss','bye',NULL,NULL,'courtesy','A1','1'),
('de','ich','I',NULL,NULL,'people','A1','1'),
('de','ja','yes',NULL,NULL,'basics','A1','1'),
('de','nein','no',NULL,NULL,'basics','A1','1'),
('de','drei','three',NULL,NULL,'numbers','A1','1'),
('de','die Stadt','the city',NULL,NULL,'places','A2','1'),
('de','der Termin','the appointment',NULL,NULL,'everyday','A2','1'),
('en','hello','hello',NULL,NULL,'greetings','A1','1'),
('en','thank you','thank you',NULL,NULL,'courtesy','A1','1'),
('en','goodbye','goodbye',NULL,NULL,'courtesy','A1','1'),
('en','I','I',NULL,NULL,'people','A1','1'),
('en','yes','yes',NULL,NULL,'basics','A1','1'),
('en','no','no',NULL,NULL,'basics','A1','1'),
('en','three','three',NULL,NULL,'numbers','A1','1'),
('en','seven','seven',NULL,NULL,'numbers','A1','1'),
('en','the city','the city',NULL,NULL,'places','A1','1'),
('en','an appointment','an appointment',NULL,NULL,'everyday','A2','1'),
('pt','bom dia','good morning',NULL,NULL,'greetings','A1','1'),
('pt','obrigado','thank you (m. speaker)',NULL,NULL,'courtesy','A1','1'),
('pt','adeus','goodbye',NULL,NULL,'courtesy','A1','1'),
('pt','eu','I',NULL,NULL,'people','A1','1'),
('pt','sim','yes',NULL,NULL,'basics','A1','1'),
('pt','não','no',NULL,NULL,'basics','A1','1'),
('pt','dois','two',NULL,NULL,'numbers','A1','1'),
('pt','seis','six',NULL,NULL,'numbers','A1','1'),
('pt','a cidade','the city',NULL,NULL,'places','A2','1'),
('pt','o compromisso','the appointment',NULL,NULL,'everyday','A2','1'),
('ar','مرحبا','hello','marhaban',NULL,'greetings','A1','1'),
('ar','شكرا','thank you','shukran',NULL,'courtesy','A1','1'),
('ar','مع السلامة','goodbye','ma''a as-salama',NULL,'courtesy','A1','1'),
('ar','اسمي','my name','ismī','اسمي أحمد','people','A1','1'),
('ar','واحد','one','wāḥid',NULL,'numbers','A1','1'),
('ar','اثنان','two','ithnān',NULL,'numbers','A1','1'),
('ar','ثلاثة','three','thalātha',NULL,'numbers','A1','1'),
('ar','بيت','house','bayt',NULL,'places','A1','1'),
('ar','ماء','water','mā''',NULL,'food-drink','A1','1'),
('ar','يوم','day','yawm',NULL,'time','A1','1'),
('zh','你好','hello','nǐ hǎo',NULL,'greetings','A1','1'),
('zh','谢谢','thank you','xièxie',NULL,'courtesy','A1','1'),
('zh','再见','goodbye','zàijiàn',NULL,'courtesy','A1','1'),
('zh','请','please','qǐng',NULL,'courtesy','A1','1'),
('zh','一','one','yī',NULL,'numbers','A1','1'),
('zh','二','two','èr',NULL,'numbers','A1','1'),
('zh','三','three','sān',NULL,'numbers','A1','1'),
('zh','家','home / family','jiā',NULL,'places','A1','1'),
('zh','水','water','shuǐ',NULL,'food-drink','A1','1'),
('zh','天','day / sky','tiān',NULL,'time','A1','1'),
('ja','こんにちは','hello (daytime)','konnichiwa',NULL,'greetings','A1','1'),
('ja','ありがとう','thank you','arigatō',NULL,'courtesy','A1','1'),
('ja','さようなら','goodbye','sayōnara',NULL,'courtesy','A1','1'),
('ja','はい','yes','hai',NULL,'basics','A1','1'),
('ja','いいえ','no','iie',NULL,'basics','A1','1'),
('ja','一','one','ichi',NULL,'numbers','A1','1'),
('ja','二','two','ni',NULL,'numbers','A1','1'),
('ja','三','three','san',NULL,'numbers','A1','1'),
('ja','家','house / home','ie',NULL,'places','A1','1'),
('ja','水','water','mizu',NULL,'food-drink','A1','1'),
('ko','안녕하세요','hello','annyeonghaseyo',NULL,'greetings','A1','1'),
('ko','감사합니다','thank you','gamsahamnida',NULL,'courtesy','A1','1'),
('ko','네','yes','ne',NULL,'basics','A1','1'),
('ko','아니요','no','aniyo',NULL,'basics','A1','1'),
('ko','하나','one','hana',NULL,'numbers','A1','1'),
('ko','둘','two','dul',NULL,'numbers','A1','1'),
('ko','셋','three','set',NULL,'numbers','A1','1'),
('ko','집','house / home','jip',NULL,'places','A1','1'),
('ko','물','water','mul',NULL,'food-drink','A1','1'),
('ko','날','day','nal',NULL,'time','A1','1'),
('ru','привет','hi','privet',NULL,'greetings','A1','1'),
('ru','спасибо','thank you','spasibo',NULL,'courtesy','A1','1'),
('ru','до свидания','goodbye','do svidaniya',NULL,'courtesy','A1','1'),
('ru','пожалуйста','please / you are welcome','pozhaluysta',NULL,'courtesy','A1','1'),
('ru','один','one','odin',NULL,'numbers','A1','1'),
('ru','два','two','dva',NULL,'numbers','A1','1'),
('ru','три','three','tri',NULL,'numbers','A1','1'),
('ru','дом','house / home','dom',NULL,'places','A1','1'),
('ru','вода','water','voda',NULL,'food-drink','A1','1'),
('ru','день','day','den''',NULL,'time','A1','1'),
('hi','नमस्ते','hello / greetings','namaste',NULL,'greetings','A1','1'),
('hi','धन्यवाद','thank you','dhanyavaad',NULL,'courtesy','A1','1'),
('hi','अलविदा','goodbye','alvida',NULL,'courtesy','A1','1'),
('hi','नाम','name','naam','मेरा नाम राम है','people','A1','1'),
('hi','एक','one','ek',NULL,'numbers','A1','1'),
('hi','दो','two','do',NULL,'numbers','A1','1'),
('hi','तीन','three','teen',NULL,'numbers','A1','1'),
('hi','घर','house / home','ghar',NULL,'places','A1','1'),
('hi','पानी','water','paani',NULL,'food-drink','A1','1'),
('hi','दिन','day','din',NULL,'time','A1','1'),
('tr','merhaba','hello',NULL,NULL,'greetings','A1','1'),
('tr','teşekkürler','thanks',NULL,NULL,'courtesy','A1','1'),
('tr','hoşça kal','goodbye',NULL,NULL,'courtesy','A1','1'),
('tr','lütfen','please',NULL,NULL,'courtesy','A1','1'),
('tr','bir','one',NULL,NULL,'numbers','A1','1'),
('tr','iki','two',NULL,NULL,'numbers','A1','1'),
('tr','üç','three',NULL,NULL,'numbers','A1','1'),
('tr','ev','house / home',NULL,NULL,'places','A1','1'),
('tr','su','water',NULL,NULL,'food-drink','A1','1'),
('tr','gün','day',NULL,NULL,'time','A1','1'),
('sw','habari','hello (greeting)',NULL,NULL,'greetings','A1','1'),
('sw','asante','thank you',NULL,NULL,'courtesy','A1','1'),
('sw','kwaheri','goodbye',NULL,NULL,'courtesy','A1','1'),
('sw','karibu','welcome',NULL,NULL,'courtesy','A1','1'),
('sw','moja','one',NULL,NULL,'numbers','A1','1'),
('sw','mbili','two',NULL,NULL,'numbers','A1','1'),
('sw','tatu','three',NULL,NULL,'numbers','A1','1'),
('sw','jina','name',NULL,'Jina langu ni Amina.','people','A1','1'),
('sw','nyumba','house',NULL,NULL,'places','A1','1'),
('sw','maji','water',NULL,NULL,'food-drink','A1','1'),
('yo','báwo ni?','how are you?',NULL,NULL,'greetings','A1','1'),
('yo','ẹ ṣe','thank you',NULL,NULL,'courtesy','A1','1'),
('yo','ọ dàbọ̀','goodbye',NULL,NULL,'courtesy','A1','1'),
('yo','ọ̀kan','one',NULL,NULL,'numbers','A1','1'),
('yo','èjì','two',NULL,NULL,'numbers','A1','1'),
('yo','ẹ̀ta','three',NULL,NULL,'numbers','A1','1'),
('yo','ilé','house / home',NULL,NULL,'places','A1','1'),
('yo','omí','water',NULL,NULL,'food-drink','A1','1'),
('yo','owó','money',NULL,NULL,'everyday','A1','1'),
('yo','ọjọ́','day',NULL,NULL,'time','A1','1'),
('ig','ndewo','hello',NULL,NULL,'greetings','A1','1'),
('ig','daalụ','thank you',NULL,NULL,'courtesy','A1','1'),
('ig','ka ọ dị','goodbye (for now)',NULL,NULL,'courtesy','A1','1'),
('ig','otu','one',NULL,NULL,'numbers','A1','1'),
('ig','abụọ','two',NULL,NULL,'numbers','A1','1'),
('ig','atọ','three',NULL,NULL,'numbers','A1','1'),
('ig','ụlọ','house',NULL,NULL,'places','A1','1'),
('ig','mmiri','water',NULL,NULL,'food-drink','A1','1'),
('ig','ego','money',NULL,NULL,'everyday','A1','1'),
('ig','ụbọchị','day',NULL,NULL,'time','A1','1'),
('ha','sannu','hello',NULL,NULL,'greetings','A1','1'),
('ha','na gode','thank you',NULL,NULL,'courtesy','A1','1'),
('ha','sai anjima','see you tomorrow (bye)',NULL,NULL,'courtesy','A1','1'),
('ha','daya','one',NULL,NULL,'numbers','A1','1'),
('ha','biyu','two',NULL,NULL,'numbers','A1','1'),
('ha','uku','three',NULL,NULL,'numbers','A1','1'),
('ha','gida','house / home',NULL,NULL,'places','A1','1'),
('ha','ruwa','water',NULL,NULL,'food-drink','A1','1'),
('ha','kudi','money',NULL,NULL,'everyday','A1','1'),
('ha','rana','day / sun',NULL,NULL,'time','A1','1'),
('af','goeie dag','good day / hello',NULL,NULL,'greetings','A1','1'),
('af','dankie','thank you',NULL,NULL,'courtesy','A1','1'),
('af','totsiens','goodbye',NULL,NULL,'courtesy','A1','1'),
('af','asseblief','please',NULL,NULL,'courtesy','A1','1'),
('af','een','one',NULL,NULL,'numbers','A1','1'),
('af','twee','two',NULL,NULL,'numbers','A1','1'),
('af','drie','three',NULL,NULL,'numbers','A1','1'),
('af','huis','house',NULL,NULL,'places','A1','1'),
('af','water','water',NULL,NULL,'food-drink','A1','1'),
('af','stad','city',NULL,'My naam is Pieter.','places','A1','1'),
('zu','sawubona','hello (one person)',NULL,NULL,'greetings','A1','1'),
('zu','ngiyabonga','I thank you',NULL,NULL,'courtesy','A1','1'),
('zu','sala kahle','goodbye (to one staying)',NULL,NULL,'courtesy','A1','1'),
('zu','kunye','one',NULL,NULL,'numbers','A1','1'),
('zu','kubili','two',NULL,NULL,'numbers','A1','1'),
('zu','kuthathu','three',NULL,NULL,'numbers','A1','1'),
('zu','indlu','house',NULL,NULL,'places','A1','1'),
('zu','amanzi','water',NULL,NULL,'food-drink','A1','1'),
('zu','imali','money',NULL,NULL,'everyday','A1','1'),
('zu','usuku','day',NULL,NULL,'time','A1','1');

-- Re-enable referential integrity after schema and seeds are complete.
SET FOREIGN_KEY_CHECKS=1;
