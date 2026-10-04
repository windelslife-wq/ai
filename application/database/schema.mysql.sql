-- AEGIS — canonical MySQL / MariaDB schema (Phase 3 scope)
-- Install: php tools/install.php  (with AEGIS_DB_* env vars set)
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
