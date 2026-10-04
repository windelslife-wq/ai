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
