-- Analysis runs (Phase 5: market analysis, agents, consensus).
--
-- Mirrors the legacy `analysis_runs` table column for column, because the summary
-- rows it produces are an API payload (`GET /api/v1/analysis/history`) and a
-- migration that renamed or retyped them would change that payload.
--
-- Two deliberate choices:
--  * `completed_at` stays VARCHAR(32) holding the same ISO-8601 UTC string that is
--    inside `payload.completedAt`. History is ordered by it, and ISO-8601 UTC
--    strings sort chronologically as text — but only while every writer uses one
--    format, so this column must never be fed a legacy `+00:00` offset string and a
--    Node `Z` string in the same table. The Node platform writes only its own.
--  * `payload` holds the whole run (agents, debate transcript, scenarios, setup,
--    risk decision, provenance, validation). It is the audit copy of what the
--    caller was shown, so a run can be re-read years later without re-deriving it
--    from market data that no longer exists.
--
-- Additive only: nothing here alters an existing table.
CREATE TABLE IF NOT EXISTS wf_analysis_runs (
  id CHAR(36) NOT NULL PRIMARY KEY,
  symbol VARCHAR(24) NOT NULL,
  timeframe VARCHAR(5) NOT NULL,
  bias VARCHAR(10) NOT NULL,
  confidence DECIMAL(5,4) NOT NULL,
  regime VARCHAR(20) NOT NULL,
  recommendation VARCHAR(10) NOT NULL,
  -- Provenance promoted to a column so a query can find every run that was built
  -- on labelled synthetic data without opening the payload.
  synthetic TINYINT(1) NOT NULL DEFAULT 0,
  source VARCHAR(40) NOT NULL,
  completed_at VARCHAR(32) NOT NULL,
  payload LONGTEXT NOT NULL,
  KEY ix_wf_analysis_runs_completed (completed_at),
  KEY ix_wf_analysis_runs_symbol (symbol, completed_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
