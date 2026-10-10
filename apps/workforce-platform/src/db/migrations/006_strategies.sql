-- Strategy Lab (Phase 6): strategy records, backtest evidence, trade journal.
--
-- Mirrors the legacy `strategies`, `backtests` and `journal_entries` tables from
-- application/database/schema.mysql.sql, because those rows are the evidence a
-- lifecycle gate reads and an API payload returns. A migration that renamed or
-- retyped them would change both.
--
-- Timestamps stay VARCHAR(32) holding ISO-8601 UTC strings, as `wf_analysis_runs`
-- already does. Three reasons, and they compound:
--  * legacy rows are VARCHAR ISO strings, so a data import needs no conversion;
--  * `latestBacktest` and the journal listing order by them, and ISO-8601 UTC
--    strings sort chronologically as text — but only while every writer uses one
--    format, so these columns must never be fed a legacy `+00:00` offset string
--    and a Node `Z` string in the same table. The Node platform writes only its
--    own (see divergence DV-2 in docs/migration/PHASE6_STRATEGIES.md);
--  * `entry_time`/`exit_time` come from candle timestamps, which the market-data
--    layer already normalises to milliseconds and this layer renders as ISO UTC.
--
-- Additive only: nothing here alters an existing table.

-- One row per (strategy, version). The version is part of the primary key rather
-- than a column on a surrogate row, so a backtest can cite the exact code it ran:
-- the gates compare evidence against a version, never against a strategy id.
CREATE TABLE IF NOT EXISTS wf_strategies (
  strategy_id VARCHAR(60) NOT NULL,
  version VARCHAR(20) NOT NULL,
  name VARCHAR(120) NOT NULL,
  description TEXT NULL,
  -- JSON arrays/objects, encoded by the repository. Kept as text rather than
  -- MySQL JSON so the column survives a mysqldump round trip on shared hosting,
  -- where JSON support varies by MariaDB version.
  market_classes LONGTEXT NOT NULL,
  timeframes LONGTEXT NOT NULL,
  params LONGTEXT NOT NULL,
  -- builtin | manual | ai. `ai` rows are refused the paper and live stages until a
  -- human signs off; that rule lives in the registry, not here, but the column is
  -- what makes it enforceable from data alone.
  source VARCHAR(10) NOT NULL DEFAULT 'builtin',
  -- DRAFT | BACKTESTED | VALIDATED | RISK_REVIEWED | PAPER_TRADING | APPROVED | RETIRED
  lifecycle VARCHAR(20) NOT NULL DEFAULT 'DRAFT',
  created_at VARCHAR(32) NOT NULL,
  updated_at VARCHAR(32) NOT NULL,
  -- Append-only audit trail of stage changes: [{from, to, at, reason}].
  lifecycle_history LONGTEXT NOT NULL,
  PRIMARY KEY (strategy_id, version),
  KEY ix_wf_strategies_lifecycle (lifecycle, updated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- One row per completed backtest. `payload` holds the whole result (request,
-- metrics, trades, equity curve, warnings, data provenance), so a gate decision
-- taken today can be re-read years later without re-running against market data
-- that no longer exists.
CREATE TABLE IF NOT EXISTS wf_backtests (
  id CHAR(36) NOT NULL PRIMARY KEY,
  created_at VARCHAR(32) NOT NULL,
  -- Denormalised out of the payload on purpose: the BACKTESTED and VALIDATED gates
  -- count and rank a strategy's runs, and doing that without opening every LONGTEXT
  -- payload is the difference between one indexed query and a table scan.
  strategy_id VARCHAR(60) NOT NULL,
  strategy_version VARCHAR(20) NOT NULL,
  symbol VARCHAR(24) NOT NULL,
  timeframe VARCHAR(5) NOT NULL,
  -- Promoted to a column so "every run built on synthetic data" is answerable in
  -- SQL. A synthetic run is not evidence for live trading, and that must be
  -- visible without parsing the payload.
  synthetic TINYINT(1) NOT NULL DEFAULT 0,
  payload LONGTEXT NOT NULL,
  KEY ix_wf_backtests_strategy (strategy_id, strategy_version, created_at),
  KEY ix_wf_backtests_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Trade journal. Written by backtests (`source='backtest'`) and read by the
-- approval gate, which counts `source='paper'` trades for the strategy being
-- promoted. Paper and live writers arrive with their own rows, so the table is
-- created complete here rather than altered twice later.
CREATE TABLE IF NOT EXISTS wf_journal_entries (
  id CHAR(36) NOT NULL PRIMARY KEY,
  -- backtest | manual | paper | live
  source VARCHAR(10) NOT NULL,
  symbol VARCHAR(24) NOT NULL,
  market VARCHAR(12) NOT NULL,
  strategy VARCHAR(60) NULL,
  strategy_version VARCHAR(20) NULL,
  direction VARCHAR(5) NOT NULL,
  entry_time VARCHAR(32) NOT NULL,
  entry_price DECIMAL(20,8) NOT NULL,
  exit_time VARCHAR(32) NULL,
  exit_price DECIMAL(20,8) NULL,
  position_size DECIMAL(20,8) NOT NULL,
  stop_loss DECIMAL(20,8) NULL,
  take_profit DECIMAL(20,8) NULL,
  fees DECIMAL(18,6) NOT NULL DEFAULT 0,
  slippage DECIMAL(18,6) NOT NULL DEFAULT 0,
  pnl DECIMAL(18,6) NULL,
  pnl_pct DECIMAL(12,6) NULL,
  r_multiple DECIMAL(12,6) NULL,
  reason TEXT NULL,
  ai_confidence DECIMAL(5,4) NULL,
  confidence_source VARCHAR(16) NULL,
  agent_consensus VARCHAR(120) NULL,
  risk_score DECIMAL(8,6) NULL,
  execution_time VARCHAR(32) NOT NULL,
  -- Links a backtest's trades to the run that produced them. Deliberately NOT a
  -- foreign key: a legacy import writes journal rows and backtest rows in separate
  -- passes, and an FK would make the import order load-bearing. Integrity is
  -- checked by tools/verify-data.mjs instead, which can report an orphan rather
  -- than refuse the row.
  backtest_id CHAR(36) NULL,
  -- Reserved for the paper-trading module (row 10 of UNFINISHED_MODULES.md). Nothing
  -- in this migration writes it, but legacy rows carry values and dropping the
  -- column would lose them on import.
  paper_position_id INT NULL,
  KEY ix_wf_journal_symbol (symbol, execution_time),
  KEY ix_wf_journal_strategy (strategy, source, execution_time),
  KEY ix_wf_journal_backtest (backtest_id),
  KEY ix_wf_journal_confidence (ai_confidence)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
