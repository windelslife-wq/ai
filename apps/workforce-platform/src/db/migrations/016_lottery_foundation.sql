-- Lottery Intelligence data foundation (row 15 of docs/migration/UNFINISHED_MODULES.md, slice 1).
--
-- Legacy's lottery module spans twelve library classes (3,039 lines), thirteen
-- tables and two controllers. As with row 14, it is being landed in slices, and
-- this migration is the first: the seven tables the foundation half reads and
-- writes —
--
--   lotteries -> rules -> providers -> health -> draws -> numbers -> sync evidence
--
-- Deliberately absent, owed by slice 2: `wf_lottery_combinations`,
-- `wf_lottery_ai_decisions`, `wf_lottery_tickets`, `wf_lottery_ticket_lines`,
-- `wf_lottery_model_versions`, `wf_lottery_backtests`. No combination, no ticket
-- and no backtest can be produced from this schema, which is the point: the
-- honesty of the slice is visible in what it cannot express. (Legacy names the
-- game table `lotteries`; every other table is `lottery_*`. The `wf_` prefix is
-- this platform's convention — the same one that turned legacy's `sports_*` into
-- `wf_sports_*` — and `wf_lotteries` keeps the game table out of every
-- "tables starting with wf_lottery_" shortcut an operator might write.)
--
-- Source attribution is the organising principle, exactly as legacy's schema says
-- in its own header comment: every draw carries the provider that produced it, a
-- source string, a source timestamp and a retrieval timestamp; validation is a
-- status on the row (`verification_status`), never an absence of errors. A draw
-- rejected by the validator is never inserted at all — legacy audits the refusal
-- and drops it — so the table only ever holds data that passed every gate.
--
-- Timestamps are VARCHAR(32) canonical UTC (`...Z`), matching migrations 007
-- through 015 and divergence AV-2 / SP-1: fixed-width canonical instants compare
-- correctly as strings, so `draw_date >= ?` and `started_at < ?` — which the
-- repository really does issue as string comparisons — need no timezone
-- conversion and cannot be reordered by a host `time_zone` setting. Divergence
-- LT-1 records why the *columns* are canonical `...Z` while payloads keep legacy's
-- `gmdate('c')` `+00:00` shape: the pure classes are the subject of the PHP
-- differential harness and must stay byte-identical to it.
--
-- Additive only. Nothing here alters an existing table, and no column names a
-- stake, a wager, a payout or a paid entry: this schema stores published draw
-- results and the evidence of how they were obtained. Lottery tickets arrive in
-- slice 2, and they are records of number lines, never purchases — a lottery
-- ticket on this platform cannot be bought, placed or settled for money.
-- Provider and draw ids are plain integers rather than foreign keys for the same
-- reason migration 010 gives for avoiding `GET_LOCK()`: the file adapter must
-- implement the identical contract, and it has no referential engine.

CREATE TABLE IF NOT EXISTS wf_lotteries (
  id INT AUTO_INCREMENT PRIMARY KEY,
  code VARCHAR(32) NOT NULL UNIQUE,
  name VARCHAR(120) NOT NULL,
  enabled TINYINT(1) NOT NULL DEFAULT 1,
  rules_version VARCHAR(16) NOT NULL,
  created_at VARCHAR(32) NOT NULL,
  updated_at VARCHAR(32) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS wf_lottery_rules (
  id INT AUTO_INCREMENT PRIMARY KEY,
  lottery_code VARCHAR(32) NOT NULL,
  version VARCHAR(16) NOT NULL,
  main_count INT NOT NULL,
  main_min INT NOT NULL,
  main_max INT NOT NULL,
  star_count INT NOT NULL,
  star_min INT NOT NULL,
  star_max INT NOT NULL,
  schedule TEXT NOT NULL,
  active TINYINT(1) NOT NULL DEFAULT 1,
  created_at VARCHAR(32) NOT NULL,
  UNIQUE KEY uq_lottery_rules (lottery_code, version)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS wf_lottery_data_sources (
  id INT AUTO_INCREMENT PRIMARY KEY,
  provider_code VARCHAR(64) NOT NULL UNIQUE,
  display_name VARCHAR(120) NOT NULL,
  enabled TINYINT(1) NOT NULL DEFAULT 0,
  synthetic TINYINT(1) NOT NULL DEFAULT 0,
  created_at VARCHAR(32) NOT NULL,
  updated_at VARCHAR(32) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS wf_lottery_provider_health (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  provider_id INT NOT NULL,
  status VARCHAR(32) NOT NULL,
  response_ms INT NULL,
  records_received INT NOT NULL DEFAULT 0,
  invalid_records INT NOT NULL DEFAULT 0,
  error_rate DECIMAL(8,5) NULL,
  last_success_at VARCHAR(32) NULL,
  last_failure_at VARCHAR(32) NULL,
  last_draw_retrieved VARCHAR(32) NULL,
  data_freshness_seconds INT NULL,
  synthetic TINYINT(1) NOT NULL DEFAULT 0,
  observed_at VARCHAR(32) NOT NULL,
  KEY idx_lottery_provider_health (provider_id, observed_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS wf_lottery_draws (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  lottery_code VARCHAR(32) NOT NULL,
  provider_id INT NULL,
  external_id VARCHAR(64) NOT NULL,
  draw_date DATE NOT NULL,
  jackpot VARCHAR(32) NULL,
  rollover TINYINT(1) NOT NULL DEFAULT 0,
  source VARCHAR(120) NOT NULL,
  source_timestamp VARCHAR(40) NOT NULL,
  retrieved_at VARCHAR(32) NOT NULL,
  verification_status VARCHAR(32) NOT NULL,
  payload MEDIUMTEXT NOT NULL,
  created_at VARCHAR(32) NOT NULL,
  updated_at VARCHAR(32) NOT NULL,
  UNIQUE KEY uq_lottery_draws (lottery_code, external_id),
  KEY idx_lottery_draws_date (lottery_code, draw_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS wf_lottery_draw_numbers (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  draw_id BIGINT NOT NULL,
  kind VARCHAR(8) NOT NULL,
  position INT NOT NULL,
  number INT NOT NULL,
  KEY idx_lottery_draw_numbers_draw (draw_id, kind, position)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS wf_lottery_sync_runs (
  id VARCHAR(64) PRIMARY KEY,
  provider_id INT NULL,
  job_type VARCHAR(40) NOT NULL,
  status VARCHAR(32) NOT NULL,
  started_at VARCHAR(32) NOT NULL,
  ended_at VARCHAR(32) NULL,
  records_processed INT NOT NULL DEFAULT 0,
  records_created INT NOT NULL DEFAULT 0,
  records_updated INT NOT NULL DEFAULT 0,
  errors TEXT NULL,
  payload MEDIUMTEXT NULL,
  execution_key VARCHAR(128) NOT NULL UNIQUE,
  KEY idx_lottery_sync_runs_job (job_type, started_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
