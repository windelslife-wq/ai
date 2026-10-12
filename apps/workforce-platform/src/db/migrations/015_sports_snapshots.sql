-- Sports Intelligence: performance snapshots (row 19 of
-- docs/migration/UNFINISHED_MODULES.md — the sports cron).
--
-- One table: the one that migration 014 deliberately left out. Its only writer is
-- the `performance` job of the sports cron (legacy `SportsCronService::jobPerformance`),
-- and a table whose only writer is an unported job is dead schema — so 014 refused it.
-- This migration arrives together with that job (src/modules/sports/cron.js), which is
-- what makes the table live.
--
--   performance_snapshots -> one row per (as_of hour, window) measured report
--
-- Legacy's shape, one for one (application/database/sports_intelligence.mysql.sql):
-- (as_of, window) is the uniqueness — re-running the same hour REPLACES the snapshot
-- for that window rather than appending a second copy — and `payload` is the whole
-- performance report as one JSON document. The read is newest-first per window,
-- bounded (legacy caps at 366), payloads decoded.
--
-- Deliberately absent: legacy's `wf_job_runs` table. The cron's per-window
-- "already ran" marker is a `wf_job_locks` row whose expiry IS the window (migration
-- 010) — the same arbiter the operations cron uses — and the run's outcomes live in
-- the audit trail. A second table that repeats what locks and audit rows already
-- record would be schema for its own sake.
--
-- Nothing here executes anything or reaches a paper, execution, order or broker
-- table. A snapshot is a measured report over stored, attested records, labelled
-- DEMO/SANDBOX by the report itself when the host runs in SANDBOX mode.
--
-- Timestamps are VARCHAR(32) canonical UTC (`...Z`), `as_of` truncated to the hour —
-- the same shape the report's own dates use. JSON is LONGTEXT.

CREATE TABLE IF NOT EXISTS wf_sports_performance_snapshots (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  -- The hour the snapshot measures, truncated to the hour on both sides. Half of the
  -- snapshot's identity (the other half is `window`).
  as_of VARCHAR(32) NOT NULL,
  -- '7', '30', '90' or 'ALL' — legacy's four windows, spelled as legacy spells them.
  window VARCHAR(8) NOT NULL,
  -- The whole performance report, one JSON document.
  payload LONGTEXT NOT NULL,
  UNIQUE KEY uq_wf_sports_perf_snapshot (as_of, window),
  KEY ix_wf_sports_perf_window (window, as_of)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
