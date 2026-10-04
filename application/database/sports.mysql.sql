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
