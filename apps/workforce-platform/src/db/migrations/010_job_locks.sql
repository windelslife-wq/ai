-- Scheduled-job coordination locks (row 19 of docs/migration/UNFINISHED_MODULES.md).
--
-- Row 19 names this as a prerequisite rather than an optional extra: the
-- retention CLI shipped in Phase 5 is safe to overlap because its deletes are
-- idempotent and batched, but "the pattern will not hold for a job that writes,
-- so add the lock before the next one". The scheduled operations job introduced
-- with this migration writes — it expires stale execution proposals — so the
-- lock lands in the same change as the job, not after it.
--
-- Why a table and not MySQL `GET_LOCK()`:
--
--  1. `GET_LOCK()` is per-connection and dies with it, so a job killed mid-run
--     leaves no evidence it ever held anything. A row survives, and its
--     `acquired_at`/`holder` say who was running and when — which is the first
--     thing an operator asks after a cron log goes quiet.
--  2. It is not portable to the file adapter, which must implement the same
--     contract so a route or job cannot depend on adapter-specific behaviour.
--  3. It is observable: `SELECT * FROM wf_job_locks` is a support answer.
--
-- Expiry is what makes this safe on shared hosting. A cron job can be killed by
-- the host (CPU limit, deploy, reboot) without running its `finally`, so a lock
-- that only its holder could release would wedge the job forever. Every lock
-- therefore carries `expires_at` and an expired lock may be taken over by the
-- next run. The TTL must exceed the job's worst-case duration or two runs can
-- overlap legitimately; the CLI states its TTL in its output so a mismatch is
-- visible in the cron log rather than silent.
--
-- Timestamps are VARCHAR(32) canonical UTC (`...Z`), matching migrations 007,
-- 008 and 009. Fixed-width canonical instants compare correctly as strings, so
-- `expires_at <= ?` needs no timezone conversion and cannot be reordered by a
-- host `time_zone` setting -- the same reasoning as divergence AV-2 in
-- docs/migration/PHASE10_AUDIT_BROWSER.md.
--
-- Additive only: nothing here alters an existing table, and no broker, order or
-- live-execution column is introduced. A lock coordinates work; it never
-- authorises any of it.

CREATE TABLE IF NOT EXISTS wf_job_locks (
  -- One row per named job, so the primary key IS the mutual-exclusion guarantee:
  -- two concurrent acquirers both attempt an INSERT and the loser gets a
  -- duplicate-key error, which is the arbiter rather than a check-then-act race.
  job_name VARCHAR(64) NOT NULL PRIMARY KEY,
  -- Who holds it, as free text the operator can read in a cron log: the CLI writes
  -- `cron#<pid>` unless `--holder` names the worker. Scoped so a release can only
  -- ever delete its OWN lock -- a process whose lock expired and was taken over must
  -- not delete the new holder's row on its way out.
  holder VARCHAR(120) NOT NULL,
  acquired_at VARCHAR(32) NOT NULL,
  expires_at VARCHAR(32) NOT NULL,
  -- The only read that is not by primary key: finding wedged or long-expired
  -- locks when an operator asks why a job has not run.
  KEY ix_wf_job_locks_expiry (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
