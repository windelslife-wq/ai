-- Sports Intelligence data foundation (row 14 of docs/migration/UNFINISHED_MODULES.md, slice 2).
--
-- Row 14 is the largest row in the backlog: the legacy module is 3 056 lines of
-- library code behind a 65-method `SportsRepository` interface spanning 18
-- tables. It is being landed in five slices, and this migration is the second —
-- the tables that make the first slice (Phase 15: the normalized contracts, the
-- quality gates and the provider boundary) able to store what it reads:
--
--   providers  -> fixtures -> odds -> results -> quality -> sync evidence
--
-- These seven tables were drafted in Phase 15 and deliberately **removed from that
-- change**, because tables nothing reads or writes are dead schema: they cost a
-- host a migration, four pinned counts in the test suite, and buy nothing until the
-- repository that fills them exists. They land here, in the same change as that
-- repository, so the schema and its only writer arrive together.
--
-- Deliberately absent, and owed by slices 3–5: `sports_model_versions`,
-- `sports_predictions`, `sports_tickets`, `sports_ticket_selections`,
-- `sports_configurations`, `sports_calibrations`, `sports_job_runs`,
-- `sports_backtests`, `sports_model_metrics`, `sports_daily_tickets`,
-- `sports_performance_snapshots`. No prediction, no ticket and no settlement can be
-- produced from this schema, which is the point: the honesty of the slice is
-- visible in what it cannot express.
--
-- Provenance is the organising principle. Every row carries the provider that
-- produced it, and a fixture, an odds observation, a result and a quality
-- assessment are four separate rows rather than one wide record — because they
-- arrive at different times, from different calls, and at different rates. An odds
-- row is an *observation at an instant*, never a current price, which is why
-- `sports_odds` has no unique key on (match, market, selection) and why
-- `latestSportsOdds`/`findSportsOddsBefore` are queries rather than columns. Point-in-time
-- backtesting (slice 5) depends on that: `oddsBefore(match, ts)` must be able to
-- answer "what did we know then", and a table that overwrote in place could not.
--
-- Timestamps are VARCHAR(32) canonical UTC (`...Z`), matching migrations 007
-- through 010 and divergence AV-2 in PHASE10_AUDIT_BROWSER.md: fixed-width
-- canonical instants compare correctly as strings, so `kickoff_at >= ?` — which
-- `listMatches` really does issue as a string comparison — needs no timezone
-- conversion and cannot be reordered by a host `time_zone` setting. Divergence
-- SP-1 records why the *columns* are canonical `...Z` while a normalized payload
-- keeps legacy's `gmdate('c')` `+00:00` shape: the pure classes are the subject of
-- the PHP differential harness and must stay byte-identical to it.
--
-- Additive only. Nothing here alters an existing table, and no column names a
-- stake, a wager, a payout or a bookmaker account: this schema stores observed
-- sporting data and the evidence of how it was obtained. It cannot authorise or
-- record a bet, and it introduces no foreign key to any trading, order or broker
-- table. Provider and match ids are plain integers rather than foreign keys for the
-- same reason migration 010 gives for avoiding `GET_LOCK()`: the file adapter must
-- implement the identical contract, and it has no referential engine.

CREATE TABLE IF NOT EXISTS wf_sports_data_sources (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  -- The provider's own `id()` string — `sandbox-sim`, or whatever
  -- WINDELS_SPORTS_HTTP_ID names. This is the provenance key every other table in
  -- this migration points at, and it is unique so a repeated `ensureProvider` is an
  -- upsert rather than a second identity for the same vendor.
  provider_code VARCHAR(64) NOT NULL,
  display_name VARCHAR(120) NOT NULL,
  -- Disabled by default. A provider row exists as soon as a sync names it, which is
  -- not the same as an operator having approved it: `enabled` is the distinction,
  -- and it is the reason a stale or removed vendor stops being consulted without
  -- its history being deleted.
  enabled TINYINT(1) NOT NULL DEFAULT 0,
  created_at VARCHAR(32) NOT NULL,
  updated_at VARCHAR(32) NOT NULL,
  UNIQUE KEY uq_wf_sports_data_sources_code (provider_code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS wf_sports_provider_health (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  provider_id INT UNSIGNED NOT NULL,
  -- ONLINE | DEGRADED | OFFLINE | RATE_LIMITED | AUTHENTICATION_ERROR |
  -- DATA_ERROR | UNKNOWN. This is what the provider *reported about itself* on one
  -- call; the status an operator sees is derived from these rows plus the sync
  -- history by ProviderHealthMonitor, which never invents one.
  status VARCHAR(32) NOT NULL,
  response_ms INT NULL,
  error_rate DECIMAL(8,5) NULL,
  rate_limit_remaining INT NULL,
  last_success_at VARCHAR(32) NULL,
  last_failure_at VARCHAR(32) NULL,
  last_fixture_sync_at VARCHAR(32) NULL,
  last_odds_sync_at VARCHAR(32) NULL,
  last_result_sync_at VARCHAR(32) NULL,
  data_freshness_seconds INT NULL,
  records_received INT NOT NULL DEFAULT 0,
  invalid_records INT NOT NULL DEFAULT 0,
  -- JSON array of the field names that were missing. Kept because "the provider is
  -- degraded" is not actionable and "it stopped sending kickoff" is.
  missing_fields LONGTEXT NULL,
  observed_at VARCHAR(32) NOT NULL,
  -- Append-only: health is a series of observations, not a current value. The
  -- monitor reads the newest N and derives from them, so an outage is visible as a
  -- gap rather than as an overwritten row.
  KEY ix_wf_sports_provider_health (provider_id, observed_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS wf_sports_matches (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  provider_id INT UNSIGNED NOT NULL,
  -- The provider's own identifier. Scoped by provider rather than globally unique,
  -- because two vendors numbering the same fixture differently is the normal case
  -- and inventing a cross-provider identity would be a guess. This is also the
  -- column that finding F-34 is about: legacy derives sandbox ids from a CRC-32
  -- variant that is not the one its own `crc32()` uses, so a port that conflated
  -- them would write an entirely different fixture universe into this table.
  external_id VARCHAR(128) NOT NULL,
  sport VARCHAR(32) NOT NULL,
  competition VARCHAR(160) NOT NULL,
  home_team VARCHAR(160) NOT NULL,
  away_team VARCHAR(160) NOT NULL,
  kickoff_at VARCHAR(32) NOT NULL,
  -- SCHEDULED | LIVE | FINISHED | POSTPONED | CANCELLED | SUSPENDED — the six the
  -- fixture normalizer accepts, and the only six that can reach this column.
  status VARCHAR(32) NOT NULL,
  source_timestamp VARCHAR(32) NOT NULL,
  -- The normalized record as the provider produced it, including `simulated` and
  -- `fieldsPresent`. Stored whole so a later slice can re-derive anything this
  -- migration chose not to give a column, and so a disputed row can be compared
  -- against what was actually received rather than against a recollection.
  payload LONGTEXT NOT NULL,
  created_at VARCHAR(32) NOT NULL,
  updated_at VARCHAR(32) NOT NULL,
  -- One row per provider per external fixture: a re-sync updates in place. The sync
  -- service reads back `created_at`/`updated_at` to report created versus updated,
  -- which is only meaningful because this key makes the write idempotent. Divergence
  -- SP-13: legacy's insert path forgot to return `created_at`, so its counter
  -- reported every new fixture as an update; this port returns the row as stored.
  UNIQUE KEY uq_wf_sports_match_provider_external (provider_id, external_id),
  KEY ix_wf_sports_matches_kickoff (kickoff_at),
  KEY ix_wf_sports_matches_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS wf_sports_odds (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  match_id BIGINT UNSIGNED NOT NULL,
  provider_id INT UNSIGNED NOT NULL,
  market VARCHAR(96) NOT NULL,
  selection VARCHAR(160) NOT NULL,
  -- DECIMAL(12,6) and never below 1.0: the normalizer refuses anything that is not
  -- numeric, not finite, or not strictly greater than 1.0, so a stored "evens" of
  -- 1.00 or a zero is a bug rather than a row.
  decimal_odds DECIMAL(12,6) NOT NULL,
  observed_at VARCHAR(32) NOT NULL,
  payload LONGTEXT NOT NULL,
  -- No unique key on (match, market, selection) on purpose. Each row is an
  -- observation at an instant; overwriting would destroy the point-in-time history
  -- `oddsBefore` exists to answer.
  KEY ix_wf_sports_odds_match_market (match_id, market, observed_at),
  KEY ix_wf_sports_odds_provider (provider_id, observed_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS wf_sports_results (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  match_id BIGINT UNSIGNED NOT NULL,
  provider_id INT UNSIGNED NOT NULL,
  -- Nullable: a fixture can be confirmed FINISHED, VOID, POSTPONED, CANCELLED or
  -- SUSPENDED with no score, and writing 0-0 for that would fabricate a result.
  -- NULL means "no score was reported", which is a different fact from "no goals
  -- were scored". The result normalizer only accepts scores for FINISHED.
  home_score INT NULL,
  away_score INT NULL,
  status VARCHAR(24) NOT NULL,
  -- Human-verified. A result arriving from a provider is *reported*; it becomes
  -- *verified* only through the explicit verify step, and every downstream consumer
  -- that matters (settlement, calibration training data) reads this flag rather than
  -- trusting ingestion. Re-ingesting a result clears it — see divergence SP-14: a
  -- provider that changes a score invalidates the attestation made about the old
  -- one, so the safe direction is to require a human to look again.
  verified TINYINT(1) NOT NULL DEFAULT 0,
  source_timestamp VARCHAR(32) NOT NULL,
  verified_at VARCHAR(32) NULL,
  payload LONGTEXT NOT NULL,
  -- One stored result per provider per match, so re-ingesting the same outcome
  -- corrects rather than duplicates it.
  UNIQUE KEY uq_wf_sports_result_provider_match (provider_id, match_id),
  KEY ix_wf_sports_results_match (match_id, verified)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS wf_sports_data_quality_assessments (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  match_id BIGINT UNSIGNED NOT NULL,
  score INT NOT NULL,
  -- EXCELLENT >= 90, GOOD >= 75, LIMITED >= 60, else REJECT.
  band VARCHAR(16) NOT NULL,
  freshness_score INT NOT NULL,
  provider_reliability_score INT NOT NULL,
  -- The two gates that decide what may be done with a fixture, stored rather than
  -- recomputed so a later decision can be audited against the assessment that was
  -- actually in force when it was made. Ticket eligibility is strictly harder to
  -- earn than prediction eligibility, because predicting is reversible and staking
  -- is not.
  eligible_prediction TINYINT(1) NOT NULL,
  eligible_ticket TINYINT(1) NOT NULL,
  missing_fields LONGTEXT NOT NULL,
  -- Every weighted check and its verdict, all nine of them totalling 108 points.
  -- Kept because a score with no breakdown is an assertion, not evidence.
  checks_payload LONGTEXT NOT NULL,
  assessed_at VARCHAR(32) NOT NULL,
  -- Append-only for the same reason as odds: quality is assessed per sync, and "was
  -- this fixture eligible when we acted on it" must stay answerable.
  KEY ix_wf_sports_quality_match (match_id, assessed_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS wf_sports_sync_runs (
  -- A caller-supplied UUID rather than an auto-increment id, because the row has to
  -- exist *before* the work starts so that a crash mid-sync still leaves evidence of
  -- the attempt.
  id VARCHAR(36) PRIMARY KEY,
  provider_id INT UNSIGNED NULL,
  -- FIXTURES | ODDS | RESULTS.
  job_type VARCHAR(48) NOT NULL,
  -- RUNNING while in flight, then COMPLETED | FAILED | DUPLICATE_SKIPPED. A row left
  -- in RUNNING is the evidence that a worker died mid-sync.
  status VARCHAR(24) NOT NULL,
  started_at VARCHAR(32) NOT NULL,
  ended_at VARCHAR(32) NULL,
  records_processed INT NOT NULL DEFAULT 0,
  records_created INT NOT NULL DEFAULT 0,
  records_updated INT NOT NULL DEFAULT 0,
  -- JSON array of per-record refusal messages, each truncated to 200 characters. A
  -- run that processed 40 records and stored 38 must be able to say what the other
  -- two were and why; counting them without naming them hides the reason.
  errors LONGTEXT NULL,
  -- The idempotency key. UNIQUE, so a cron job that fires twice for the same window,
  -- or a retry after a timeout, cannot ingest the same data twice. This is the same
  -- arbiter `wf_job_locks` uses in migration 010 — the constraint is the guarantee,
  -- not a check followed by an act. Divergence SP-12: legacy checked for the key and
  -- then inserted without catching the duplicate-key error, so two concurrent runs
  -- of the same window would have one throw instead of reporting DUPLICATE_SKIPPED;
  -- this port lets the constraint arbitrate and translates the collision.
  execution_key VARCHAR(128) NOT NULL,
  UNIQUE KEY uq_wf_sports_sync_runs_execution_key (execution_key),
  KEY ix_wf_sports_sync_runs_job (job_type, started_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
