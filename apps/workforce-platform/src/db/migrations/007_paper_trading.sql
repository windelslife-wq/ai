-- Paper trading, persisted trading governance and portfolio risk (Phase 7).
--
-- The Node edition keeps paper accounts private to their creating user. The
-- legacy tables were global; this is an intentional isolation boundary for the
-- multi-user target. All fills remain simulation-only and have no broker FK or
-- broker order path.
--
-- This migration is additive. Strategy variants keep their original `source`
-- (`ai` remains `ai`); a separate signed record captures an operator's explicit
-- risk review rather than laundering an AI version into a manual one.

ALTER TABLE wf_strategies
  ADD COLUMN human_signoff LONGTEXT NULL AFTER lifecycle_history;

ALTER TABLE wf_journal_entries
  ADD COLUMN synthetic TINYINT(1) NOT NULL DEFAULT 0 AFTER source;

-- The journal was created in Phase 6 with an INT placeholder. Paper position
-- identifiers are BIGINT UNSIGNED, so the foreign identifier must not truncate
-- once the account ledger grows past the signed-INT range.
ALTER TABLE wf_journal_entries
  MODIFY COLUMN paper_position_id BIGINT UNSIGNED NULL AFTER backtest_id;

CREATE TABLE IF NOT EXISTS wf_trading_state (
  state_key VARCHAR(24) NOT NULL PRIMARY KEY,
  state_json LONGTEXT NOT NULL,
  updated_by_user_id BIGINT UNSIGNED NULL,
  updated_at VARCHAR(32) NOT NULL,
  CONSTRAINT fk_wf_trading_state_updated_by
    FOREIGN KEY (updated_by_user_id) REFERENCES wf_users(id)
    ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Safe boot state: no paper routing until a human explicitly sets PAPER_TRADING
-- and releases the switch through the authenticated, permission-gated API.
INSERT IGNORE INTO wf_trading_state (state_key, state_json, updated_by_user_id, updated_at)
VALUES (
  'global',
  '{"tradingMode":"ANALYSIS_ONLY","killSwitch":{"active":true,"activatedAt":null,"reason":"Default state at boot — orders blocked until explicitly released"},"allowSyntheticPaperData":false,"riskLimits":{"riskPerTradePct":0.01,"maxRiskPerTradePct":0.02,"minRiskReward":1.5,"requireStopLoss":true,"maxPositionNotionalUsd":50000,"maxLeverage":5,"maxOpenPositions":10,"maxDailyLossPct":0.03,"maxWeeklyLossPct":0.06,"maxDrawdownPct":0.1,"maxSymbolExposurePct":0.05,"maxPortfolioExposurePct":0.15,"maxCorrelatedPositions":3,"minDataQuality":0.5,"blockSyntheticData":true,"blockStaleData":true}}',
  NULL,
  '2026-10-11T00:00:00.000Z'
);

CREATE TABLE IF NOT EXISTS wf_paper_accounts (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  owner_user_id BIGINT UNSIGNED NOT NULL,
  name VARCHAR(60) NOT NULL,
  currency CHAR(3) NOT NULL DEFAULT 'USD',
  starting_balance DECIMAL(18,2) NOT NULL,
  balance DECIMAL(18,2) NOT NULL,
  peak_equity DECIMAL(18,2) NOT NULL,
  revision BIGINT UNSIGNED NOT NULL DEFAULT 0,
  created_at VARCHAR(32) NOT NULL,
  KEY ix_wf_paper_accounts_owner (owner_user_id, id),
  CONSTRAINT fk_wf_paper_accounts_owner
    FOREIGN KEY (owner_user_id) REFERENCES wf_users(id)
    ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS wf_paper_orders (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  account_id BIGINT UNSIGNED NOT NULL,
  symbol VARCHAR(24) NOT NULL,
  market_class VARCHAR(12) NOT NULL,
  side VARCHAR(4) NOT NULL,
  type VARCHAR(6) NOT NULL,
  units DECIMAL(20,8) NOT NULL DEFAULT 0,
  price DECIMAL(20,8) NULL,
  stop_loss DECIMAL(20,8) NULL,
  take_profit DECIMAL(20,8) NULL,
  status VARCHAR(10) NOT NULL,
  reject_reason TEXT NULL,
  risk_amount DECIMAL(18,6) NULL,
  reason VARCHAR(500) NULL,
  ai_confidence DECIMAL(5,4) NULL,
  strategy VARCHAR(60) NULL,
  strategy_version VARCHAR(20) NULL,
  synthetic TINYINT(1) NOT NULL DEFAULT 0,
  created_at VARCHAR(32) NOT NULL,
  filled_at VARCHAR(32) NULL,
  fill_price DECIMAL(20,8) NULL,
  KEY ix_wf_paper_orders_account_status (account_id, status, id),
  KEY ix_wf_paper_orders_account_symbol (account_id, symbol, status),
  CONSTRAINT fk_wf_paper_orders_account
    FOREIGN KEY (account_id) REFERENCES wf_paper_accounts(id)
    ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS wf_paper_positions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  account_id BIGINT UNSIGNED NOT NULL,
  symbol VARCHAR(24) NOT NULL,
  market_class VARCHAR(12) NOT NULL,
  direction VARCHAR(5) NOT NULL,
  units DECIMAL(20,8) NOT NULL,
  entry_price DECIMAL(20,8) NOT NULL,
  stop_loss DECIMAL(20,8) NOT NULL,
  take_profit DECIMAL(20,8) NOT NULL,
  entry_fee DECIMAL(18,6) NOT NULL DEFAULT 0,
  risk_amount DECIMAL(18,6) NULL,
  strategy VARCHAR(60) NULL,
  strategy_version VARCHAR(20) NULL,
  reason VARCHAR(500) NULL,
  ai_confidence DECIMAL(5,4) NULL,
  synthetic TINYINT(1) NOT NULL DEFAULT 0,
  opened_at VARCHAR(32) NOT NULL,
  status VARCHAR(8) NOT NULL DEFAULT 'OPEN',
  closed_at VARCHAR(32) NULL,
  exit_price DECIMAL(20,8) NULL,
  realized_pnl DECIMAL(18,6) NULL,
  exit_reason VARCHAR(24) NULL,
  KEY ix_wf_paper_positions_account_status (account_id, status, id),
  KEY ix_wf_paper_positions_account_symbol (account_id, symbol, status),
  CONSTRAINT fk_wf_paper_positions_account
    FOREIGN KEY (account_id) REFERENCES wf_paper_accounts(id)
    ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS wf_paper_trades (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  account_id BIGINT UNSIGNED NOT NULL,
  order_id BIGINT UNSIGNED NULL,
  position_id BIGINT UNSIGNED NOT NULL,
  leg VARCHAR(5) NOT NULL,
  symbol VARCHAR(24) NOT NULL,
  price DECIMAL(20,8) NOT NULL,
  units DECIMAL(20,8) NOT NULL,
  fee DECIMAL(18,6) NOT NULL DEFAULT 0,
  time VARCHAR(32) NOT NULL,
  synthetic TINYINT(1) NOT NULL DEFAULT 0,
  KEY ix_wf_paper_trades_account_time (account_id, time, id),
  KEY ix_wf_paper_trades_position (position_id, leg),
  CONSTRAINT fk_wf_paper_trades_account
    FOREIGN KEY (account_id) REFERENCES wf_paper_accounts(id)
    ON DELETE RESTRICT,
  CONSTRAINT fk_wf_paper_trades_order
    FOREIGN KEY (order_id) REFERENCES wf_paper_orders(id)
    ON DELETE SET NULL,
  CONSTRAINT fk_wf_paper_trades_position
    FOREIGN KEY (position_id) REFERENCES wf_paper_positions(id)
    ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS wf_paper_deployments (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  account_id BIGINT UNSIGNED NOT NULL,
  strategy_id VARCHAR(60) NOT NULL,
  strategy_version VARCHAR(20) NOT NULL,
  symbol VARCHAR(24) NOT NULL,
  market_class VARCHAR(12) NOT NULL,
  timeframe VARCHAR(5) NOT NULL,
  active TINYINT(1) NOT NULL DEFAULT 1,
  deployed_at VARCHAR(32) NOT NULL,
  last_evaluated_at VARCHAR(32) NULL,
  last_signal VARCHAR(8) NULL,
  KEY ix_wf_paper_deployments_account (account_id, active, id),
  KEY ix_wf_paper_deployments_strategy (strategy_id, strategy_version),
  CONSTRAINT fk_wf_paper_deployments_account
    FOREIGN KEY (account_id) REFERENCES wf_paper_accounts(id)
    ON DELETE RESTRICT,
  CONSTRAINT fk_wf_paper_deployments_strategy
    FOREIGN KEY (strategy_id, strategy_version) REFERENCES wf_strategies(strategy_id, version)
    ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
